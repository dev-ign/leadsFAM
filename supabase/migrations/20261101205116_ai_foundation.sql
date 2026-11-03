-- Phase 05: bounded AI assistance; no model or worker send capability.
set lock_timeout='3s';
create role leadsfam_ai nologin nosuperuser nobypassrls noinherit;
grant leadsfam_ai to postgres with set true;
grant usage on schema public,private to leadsfam_ai;
grant execute on function private.crm_context(uuid,text),private.crm_keys(jsonb,text[],text[]),private.crm_fingerprint(jsonb),private.audit(uuid,text),private.automation_admin_generation(uuid,uuid) to leadsfam_ai;
create table private.ai_settings (
 organization_id uuid primary key references public.organizations(id), enabled boolean not null default false,
 provider text not null default 'simulation' check(provider in ('simulation','openai')),
 daily_limit integer not null default 50 check(daily_limit between 1 and 500),
 concurrent_limit integer not null default 1 check(concurrent_limit between 1 and 3),
 business jsonb not null default '{"name":"","description":"","services":[],"serviceAreas":[],"tone":"warm","questions":[],"guidelines":"","restrictions":"","escalation":""}' check(octet_length(business::text)<=7000),
 version integer not null default 1 check(version>0), last_claimed_at timestamptz
);
create table private.ai_runs (
 id uuid primary key, organization_id uuid not null references public.organizations(id), lead_id uuid not null,
 actor_id uuid not null, authority_generation integer not null, workflow_run_id uuid,
 task text not null check(task in ('analysis','draft')), channel text not null check(channel in ('email','sms')),
 kind text not null check(kind in ('acknowledgment','follow_up','service_response','information_request','handoff')),
 trigger text not null check(trigger in ('manual','workflow')), provider text not null check(provider in ('simulation','openai')),
 state text not null default 'queued' check(state in ('queued','claimed','retryable','succeeded','failed','attention')),
 attempts integer not null default 0 check(attempts between 0 and 3), generation integer not null default 0,
 lease_token uuid, lease_expires_at timestamptz, run_at timestamptz not null default clock_timestamp(),
 code text, model text check(char_length(model)<=120), prompt_version text not null default 'lead-assist-v1' check(prompt_version='lead-assist-v1'), analysis_version integer not null default 1 check(analysis_version=1),
 input_fingerprint text, result jsonb check(octet_length(result::text)<=16000), message_id uuid,
 input_tokens integer check(input_tokens between 0 and 1000000), output_tokens integer check(output_tokens between 0 and 1000000),
 estimated_cost_microusd numeric check(estimated_cost_microusd>=0), pricing_version text check(char_length(pricing_version)<=80), duration_ms integer check(duration_ms between 0 and 60000),
 created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 unique(organization_id,id),
 check((state='claimed' and lease_token is not null and lease_expires_at is not null) or (state<>'claimed' and lease_token is null and lease_expires_at is null)),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id),
 foreign key(organization_id,actor_id) references public.organization_memberships(organization_id,user_id),
 foreign key(organization_id,workflow_run_id) references private.automation_runs(organization_id,id),
 foreign key(organization_id,message_id) references private.communication_messages(organization_id,id)
);
create index ai_lead_history on private.ai_runs(organization_id,lead_id,created_at desc,id desc);
create index ai_org_history on private.ai_runs(organization_id,created_at desc,id desc);
create index ai_due on private.ai_runs(run_at,created_at,id) where state in ('queued','claimed','retryable');
create index ai_expired on private.ai_runs(lease_expires_at) where state='claimed';
create index ai_org_active on private.ai_runs(organization_id,state) where state in ('queued','claimed','retryable');
create index ai_daily on private.ai_runs(organization_id,created_at);
create unique index ai_workflow_identity on private.ai_runs(organization_id,workflow_run_id) where workflow_run_id is not null;
-- Safe execution metadata only; no prompts, excerpts, destinations or model bodies.
create table private.ai_attempts (
 organization_id uuid not null, run_id uuid not null, generation integer not null,
 state text not null, code text, model text, input_tokens integer, output_tokens integer,
 estimated_cost_microusd numeric, pricing_version text, duration_ms integer,
 started_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 primary key(organization_id,run_id,generation),
 foreign key(organization_id,run_id) references private.ai_runs(organization_id,id)
);
-- Authoritative admission counters share the settings row lock; runs are the usage ledger.
do $$ declare relation text; begin
 foreach relation in array array['ai_settings','ai_runs','ai_attempts'] loop
  execute format('alter table private.%I enable row level security',relation);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress',relation);
  execute format('grant select,insert,update on private.%I to leadsfam_ai',relation);
  -- Queue-wide coordination belongs only to the NOLOGIN owner. Every human RPC checks scope first.
  execute format('create policy ai_execution on private.%I to leadsfam_ai using(true) with check(true)',relation);
 end loop;
 foreach relation in array array['contacts','leads','contact_emails','contact_phones'] loop
  execute format('grant select on public.%I to leadsfam_ai',relation);
  execute format('create policy ai_execution on public.%I to leadsfam_ai using(organization_id=nullif((select current_setting(''leadsfam.ai_org'',true)),'''')::uuid)',relation);
 end loop;
 foreach relation in array array['automation_runs','automation_versions','automation_workflows','domain_events','source_integrations'] loop
  execute format('grant select on private.%I to leadsfam_ai',relation);
  execute format('create policy ai_execution on private.%I to leadsfam_ai using(organization_id=nullif((select current_setting(''leadsfam.ai_org'',true)),'''')::uuid)',relation);
 end loop;
end $$;

create function private.ai_member_generation(p_org uuid,p_actor uuid) returns integer language plpgsql volatile security definer set search_path='' as $$
declare generation integer;
begin
 perform set_config('lock_timeout','3s',true);
 perform 1 from public.organizations where id=p_org for share;
 select crm_assignment_generation into generation from public.organization_memberships where organization_id=p_org and user_id=p_actor and revoked_at is null;
 return generation;
end $$;
grant create on schema private to leadsfam_policy;
alter function private.ai_member_generation(uuid,uuid) owner to leadsfam_policy;
revoke create on schema private from leadsfam_policy;
revoke all on function private.ai_member_generation(uuid,uuid) from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress;
grant execute on function private.ai_member_generation(uuid,uuid) to leadsfam_ai;

create function private.ai_authorized(p_run private.ai_runs) returns boolean language plpgsql volatile security invoker set search_path='' as $$
declare revision private.automation_versions; integration private.source_integrations; event private.domain_events;
begin
 if private.ai_member_generation(p_run.organization_id,p_run.actor_id) is distinct from p_run.authority_generation then return false; end if;
 if p_run.trigger='workflow' then
  select v.* into revision from private.automation_runs r join private.automation_versions v on v.organization_id=r.organization_id and v.workflow_id=r.workflow_id and v.version=r.workflow_version join private.automation_workflows w on w.organization_id=r.organization_id and w.id=r.workflow_id where r.organization_id=p_run.organization_id and r.id=p_run.workflow_run_id and w.status='active';
  if not found or private.automation_admin_generation(p_run.organization_id,revision.published_by) is distinct from revision.authority_generation then return false; end if;
  select e.* into event from private.domain_events e join private.automation_runs r on r.organization_id=e.organization_id and r.event_id=e.id where r.organization_id=p_run.organization_id and r.id=p_run.workflow_run_id;
  if event.integration_id is not null then
   select * into integration from private.source_integrations where organization_id=p_run.organization_id and id=event.integration_id;
   if not found or integration.status<>'active' or integration.expires_at<=clock_timestamp() or private.automation_admin_generation(p_run.organization_id,integration.authorized_by) is distinct from integration.authority_generation then return false; end if;
  end if;
 end if;
 return true;
end $$;
create function private.ai_source(p_org uuid,p_lead uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('lead',jsonb_build_object('title',l.title,'description',left(l.description,2000)),'contactName',left(c.display_name,80),'business',s.business) from public.leads l join public.contacts c on c.organization_id=l.organization_id and c.id=l.contact_id join private.ai_settings s on s.organization_id=l.organization_id where l.organization_id=p_org and l.id=p_lead and l.archived_at is null and c.archived_at is null
$$;
create function private.ai_json(p_run private.ai_runs) returns jsonb language sql immutable security invoker set search_path='' as $$
 select to_jsonb(p_run)-array['organization_id','actor_id','authority_generation','workflow_run_id','generation','lease_token','lease_expires_at','run_at','input_fingerprint']
$$;

create function private.ai_enqueue(p_org uuid,p_id uuid,p_lead uuid,p_actor uuid,p_data jsonb,p_workflow uuid default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare settings private.ai_settings; prior private.ai_runs; member_generation integer; budget_start timestamptz:=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC');
begin
 perform set_config('leadsfam.ai_org',p_org::text,true);
 member_generation:=private.ai_member_generation(p_org,p_actor);
 if member_generation is null then raise exception using errcode='42501',message='forbidden'; end if;
 perform private.crm_keys(p_data,array['leadId','task','channel','kind'],array['leadId','task','channel','kind']);
 if (p_data->>'leadId')::uuid is distinct from p_lead or p_id is null or p_data->>'task' not in ('analysis','draft') or p_data->>'channel' not in ('email','sms') or p_data->>'kind' not in ('acknowledgment','follow_up','service_response','information_request','handoff') then raise exception using errcode='22023',message='invalid_fields'; end if;
 insert into private.ai_settings(organization_id) values(p_org) on conflict do nothing;
 select * into settings from private.ai_settings where organization_id=p_org for update;
 select * into prior from private.ai_runs where organization_id=p_org and id=p_id;
 if found then
  if prior.lead_id<>p_lead or prior.task<>p_data->>'task' or prior.channel<>p_data->>'channel' or prior.kind<>p_data->>'kind' or prior.actor_id<>p_actor or prior.workflow_run_id is distinct from p_workflow then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
  return private.ai_json(prior);
 end if;
 if not settings.enabled then
  if p_workflow is not null then raise exception using errcode='42501',message='forbidden'; end if;
  raise exception using errcode='P0001',message='ai_disabled';
 end if;
 if private.ai_source(p_org,p_lead) is null then raise exception using errcode='42501',message='not_found'; end if;
 if (select count(*) from private.ai_runs where organization_id=p_org and created_at>=budget_start)>=settings.daily_limit or (select count(*) from private.ai_runs where organization_id=p_org and state in ('queued','claimed','retryable'))>=20 then raise exception using errcode='P0001',message='ai_limit_reached'; end if;
 insert into private.ai_runs(id,organization_id,lead_id,actor_id,authority_generation,workflow_run_id,task,channel,kind,trigger,provider) values(p_id,p_org,p_lead,p_actor,member_generation,p_workflow,p_data->>'task',p_data->>'channel',p_data->>'kind',case when p_workflow is null then 'manual' else 'workflow' end,settings.provider) returning * into prior;
 perform private.audit(p_org,'ai.requested:'||p_id::text);
 return private.ai_json(prior);
end $$;

create function private.ai_manage(p_org uuid,p_action text,p_id uuid,p_version integer,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; settings private.ai_settings; run private.ai_runs; message jsonb; field text; v_business jsonb;
begin
 actor:=private.crm_context(p_org,case when p_action='settings' then 'manage' else 'write' end);
 perform set_config('leadsfam.ai_org',p_org::text,true);
 if p_action='request' then return private.ai_enqueue(p_org,p_id,(p_data->>'leadId')::uuid,actor,p_data); end if;
 if p_action='settings' then
  perform private.crm_keys(p_data,array['enabled','provider','dailyLimit','concurrentLimit','business'],array['enabled','provider','dailyLimit','concurrentLimit','business']);
  v_business:=p_data->'business';
  perform private.crm_keys(v_business,array['name','description','services','serviceAreas','tone','questions','guidelines','restrictions','escalation'],array['name','description','services','serviceAreas','tone','questions','guidelines','restrictions','escalation']);
  if jsonb_typeof(p_data->'enabled')<>'boolean' or p_data->>'provider' not in ('simulation','openai') or jsonb_typeof(v_business)<>'object' or v_business->>'tone' not in ('warm','concise','formal') then raise exception using errcode='22023',message='invalid_fields'; end if;
  foreach field in array array['name','description','guidelines','restrictions','escalation'] loop
   if jsonb_typeof(v_business->field)<>'string' or char_length(v_business->>field)>(case when field='name' then 80 when field='escalation' then 300 else 600 end) then raise exception using errcode='22023',message='invalid_fields'; end if;
  end loop;
  foreach field in array array['services','serviceAreas','questions'] loop
   if jsonb_typeof(v_business->field)<>'array' or jsonb_array_length(v_business->field)>(case when field='questions' then 8 else 10 end) or exists(select 1 from jsonb_array_elements(v_business->field) v where jsonb_typeof(v)<>'string' or char_length(btrim(v#>>'{}')) not between 1 and 160) then raise exception using errcode='22023',message='invalid_fields'; end if;
  end loop;
  insert into private.ai_settings(organization_id) values(p_org) on conflict do nothing;
  select * into settings from private.ai_settings where organization_id=p_org for update;
  if p_version is distinct from settings.version then raise exception using errcode='P0001',message='version_conflict'; end if;
  update private.ai_settings set enabled=(p_data->>'enabled')::boolean,provider=p_data->>'provider',daily_limit=(p_data->>'dailyLimit')::integer,concurrent_limit=(p_data->>'concurrentLimit')::integer,business=v_business,version=version+1 where organization_id=p_org;
  perform private.audit(p_org,'ai.settings_changed');
  return jsonb_build_object('ok',true);
 elsif p_action='save_draft' then
  perform private.crm_keys(p_data,array['recipient','subject','body'],array['recipient','subject','body']);
  select * into run from private.ai_runs where organization_id=p_org and id=p_id for update;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
  if run.message_id is not null then return private.communication_read(p_org,'message',run.message_id,'{}'); end if;
  if run.state<>'succeeded' or run.task<>'draft' then raise exception using errcode='P0001',message='invalid_transition'; end if;
  if not ((run.channel='email' and exists(select 1 from public.contact_emails e join public.leads l on l.organization_id=e.organization_id and l.contact_id=e.contact_id where l.organization_id=p_org and l.id=run.lead_id and e.normalized=lower(btrim(p_data->>'recipient')))) or (run.channel='sms' and exists(select 1 from public.contact_phones e join public.leads l on l.organization_id=e.organization_id and l.contact_id=e.contact_id where l.organization_id=p_org and l.id=run.lead_id and e.normalized=btrim(p_data->>'recipient')))) then raise exception using errcode='22023',message='invalid_fields'; end if;
  message:=private.communication_manage(p_org,'draft',run.id,null,jsonb_build_object('id',run.id,'contactId',(select contact_id from public.leads where organization_id=p_org and id=run.lead_id),'leadId',run.lead_id,'channel',run.channel,'purpose','transactional','recipient',p_data->>'recipient','subject',p_data->>'subject','body',p_data->>'body'));
  update private.ai_runs set message_id=run.id where organization_id=p_org and id=run.id;
  perform private.audit(p_org,'ai.draft_saved:'||run.id::text);
  return message;
 end if;
 raise exception using errcode='22023',message='invalid_fields';
end $$;

create function private.ai_read(p_org uuid,p_kind text,p_id uuid,p_query jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare s private.ai_settings; items jsonb;
begin
 perform private.crm_context(p_org,'read');
 perform set_config('leadsfam.ai_org',p_org::text,true);
 if p_kind='settings' then
  perform private.crm_keys(p_query,'{}');
  select * into s from private.ai_settings where organization_id=p_org;
  if not found then s.enabled:=false; s.provider:='simulation'; s.daily_limit:=50; s.concurrent_limit:=1; s.version:=1; s.business:='{"name":"","description":"","services":[],"serviceAreas":[],"tone":"warm","questions":[],"guidelines":"","restrictions":"","escalation":""}'; end if;
  return jsonb_build_object('enabled',s.enabled,'provider',s.provider,'dailyLimit',s.daily_limit,'concurrentLimit',s.concurrent_limit,'business',s.business,'version',s.version);
 elsif p_kind='history' then
  perform private.crm_keys(p_query,array['cursor']);
  if p_id is not null and not exists(select 1 from public.leads where organization_id=p_org and id=p_id) then raise exception using errcode='42501',message='not_found'; end if;
  select coalesce(jsonb_agg(private.ai_json(r) order by r.created_at desc,r.id desc),'[]') into items from (select * from private.ai_runs where organization_id=p_org and (p_id is null or lead_id=p_id) and (p_query->>'cursor' is null or (created_at,id)<(((p_query->>'cursor')::jsonb->>0)::timestamptz,((p_query->>'cursor')::jsonb->>1)::uuid)) order by created_at desc,id desc limit 20) r;
  return jsonb_build_object('items',items,'next',case when jsonb_array_length(items)=20 then jsonb_build_array(items->19->>'created_at',items->19->>'id')::text end);
 end if;
 raise exception using errcode='22023',message='invalid_fields';
end $$;

create function private.ai_claim() returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare run private.ai_runs;
begin
 update private.ai_attempts a set state=case when r.provider='openai' then 'attention' else 'lease_expired' end,code='LEASE_EXPIRED',finished_at=clock_timestamp() from private.ai_runs r where r.organization_id=a.organization_id and r.id=a.run_id and r.generation=a.generation and r.state='claimed' and r.lease_expires_at<=clock_timestamp() and a.finished_at is null and r.id in (select id from private.ai_runs where state='claimed' and lease_expires_at<=clock_timestamp() order by lease_expires_at for update skip locked limit 100);
 -- Expired real inference is uncertain, never silently submitted again. Simulation is safely retryable.
 update private.ai_runs set state=case when provider='openai' then 'attention' when attempts>=3 then 'failed' else 'retryable' end,code=case when provider='openai' then 'INFERENCE_UNCERTAIN' else 'LEASE_EXPIRED' end,lease_token=null,lease_expires_at=null,generation=generation+1,finished_at=case when provider='openai' or attempts>=3 then clock_timestamp() end where id in (select id from private.ai_runs where state='claimed' and lease_expires_at<=clock_timestamp() order by lease_expires_at for update skip locked limit 100);
 select r.* into run from private.ai_runs r join private.ai_settings s on s.organization_id=r.organization_id where r.state in ('queued','retryable') and r.run_at<=clock_timestamp() and r.attempts<3 and (select count(*) from private.ai_runs a where a.organization_id=r.organization_id and a.state='claimed')<s.concurrent_limit order by s.last_claimed_at nulls first,r.created_at,r.id for update of r,s skip locked limit 1;
 if not found then return null; end if;
 -- Recheck with a fresh command snapshot after acquiring the tenant settings lock.
 if (select count(*) from private.ai_runs where organization_id=run.organization_id and state='claimed') >= (select concurrent_limit from private.ai_settings where organization_id=run.organization_id) then return null; end if;
 update private.ai_settings set last_claimed_at=clock_timestamp() where organization_id=run.organization_id;
 update private.ai_runs set state='claimed',attempts=attempts+1,generation=generation+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '45 seconds',code=null where id=run.id returning * into run;
 insert into private.ai_attempts(organization_id,run_id,generation,state) values(run.organization_id,run.id,run.generation,'claimed');
 return jsonb_build_object('id',run.id,'token',run.lease_token,'generation',run.generation);
end $$;
create function private.ai_prepare(p_id uuid,p_token uuid,p_generation integer,p_model text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare run private.ai_runs; source jsonb;
begin
 select * into run from private.ai_runs where id=p_id;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 perform private.ai_member_generation(run.organization_id,null);
 perform set_config('leadsfam.ai_org',run.organization_id::text,true);
 perform 1 from private.ai_settings where organization_id=run.organization_id for update;
 select * into run from private.ai_runs where id=p_id for update;
 if p_token is null or p_generation is null or run.state<>'claimed' or run.lease_token is distinct from p_token or run.generation<>p_generation or run.lease_expires_at<=clock_timestamp() then raise exception using errcode='P0001',message='lease_lost'; end if;
 if not private.ai_authorized(run) or not (select enabled and provider=run.provider from private.ai_settings where organization_id=run.organization_id) then
  update private.ai_runs set state='failed',code='AUTHORITY_REVOKED',finished_at=clock_timestamp(),lease_token=null,lease_expires_at=null where id=run.id;
  update private.ai_attempts set state='failed',code='AUTHORITY_REVOKED',finished_at=clock_timestamp() where organization_id=run.organization_id and run_id=run.id and generation=run.generation;
  return null;
 end if;
 source:=private.ai_source(run.organization_id,run.lead_id);
 if source is null then
  update private.ai_runs set state='failed',code='LEAD_UNAVAILABLE',finished_at=clock_timestamp(),lease_token=null,lease_expires_at=null where id=run.id;
  update private.ai_attempts set state='failed',code='LEAD_UNAVAILABLE',finished_at=clock_timestamp() where organization_id=run.organization_id and run_id=run.id and generation=run.generation;
  return null;
 end if;
 if p_model is null or char_length(p_model) not between 1 and 120 then raise exception using errcode='22023',message='invalid_fields'; end if;
 update private.ai_runs set model=case when provider='simulation' then 'simulation-v1' else p_model end,input_fingerprint=private.crm_fingerprint(source) where id=run.id;
 update private.ai_attempts set model=case when run.provider='simulation' then 'simulation-v1' else p_model end where organization_id=run.organization_id and run_id=run.id and generation=run.generation;
 return jsonb_build_object('source',source,'task',run.task,'channel',run.channel,'kind',run.kind,'provider',run.provider);
end $$;
create function private.ai_finish(p_id uuid,p_token uuid,p_generation integer,p_data jsonb) returns void language plpgsql volatile security definer set search_path='' as $$
declare run private.ai_runs; source jsonb; failure text; target text;
begin
 perform private.crm_keys(p_data,array['result','code','retryable','durationMs','inputTokens','outputTokens','estimatedCostMicrousd','pricingVersion'],array['result','code','retryable','durationMs','inputTokens','outputTokens','estimatedCostMicrousd','pricingVersion']);
 select * into run from private.ai_runs where id=p_id;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 perform private.ai_member_generation(run.organization_id,null);
 perform set_config('leadsfam.ai_org',run.organization_id::text,true);
 perform 1 from private.ai_settings where organization_id=run.organization_id for update;
 select * into run from private.ai_runs where id=p_id for update;
 if p_token is null or p_generation is null or run.state<>'claimed' or run.lease_token is distinct from p_token or run.generation<>p_generation or run.lease_expires_at<=clock_timestamp() then raise exception using errcode='P0001',message='lease_lost'; end if;
 failure:=p_data->>'code';
 if failure is not null and failure not in ('PROVIDER_UNAVAILABLE','RATE_LIMITED','TIMEOUT_UNCERTAIN','INFERENCE_UNCERTAIN','INVALID_OUTPUT','INPUT_LIMIT','CANCELLED_UNCERTAIN') then raise exception using errcode='22023',message='invalid_fields'; end if;
 source:=private.ai_source(run.organization_id,run.lead_id);
 if not private.ai_authorized(run) or not (select enabled and provider=run.provider from private.ai_settings where organization_id=run.organization_id) then failure:='AUTHORITY_REVOKED';
 elsif source is null or private.crm_fingerprint(source) is distinct from run.input_fingerprint then failure:='STALE_INPUT'; end if;
 target:=case when failure is null then 'succeeded' when failure in ('TIMEOUT_UNCERTAIN','INFERENCE_UNCERTAIN','CANCELLED_UNCERTAIN') then 'attention' when failure='RATE_LIMITED' and p_data->'retryable'='true'::jsonb and run.attempts<3 then 'retryable' else 'failed' end;
 if target='succeeded' then
  perform private.crm_keys(p_data->'result',array['analysis','proposal','reasoning'],array['analysis','proposal','reasoning']);
  if jsonb_typeof(p_data->'result'->'analysis')<>'object' or jsonb_typeof(p_data->'result'->'reasoning')<>'string' then raise exception using errcode='22023',message='invalid_fields'; end if;
 end if;
 update private.ai_attempts set state=target,code=failure,input_tokens=(p_data->>'inputTokens')::integer,output_tokens=(p_data->>'outputTokens')::integer,estimated_cost_microusd=(p_data->>'estimatedCostMicrousd')::numeric,pricing_version=p_data->>'pricingVersion',duration_ms=(p_data->>'durationMs')::integer,finished_at=clock_timestamp() where organization_id=run.organization_id and run_id=run.id and generation=run.generation;
 update private.ai_runs set state=target,code=failure,result=case when target='succeeded' then p_data->'result' else null end,input_tokens=(p_data->>'inputTokens')::integer,output_tokens=(p_data->>'outputTokens')::integer,estimated_cost_microusd=(p_data->>'estimatedCostMicrousd')::numeric,pricing_version=p_data->>'pricingVersion',duration_ms=(p_data->>'durationMs')::integer,run_at=clock_timestamp()+make_interval(secs=>least(60,5*run.attempts)),finished_at=case when target<>'retryable' then clock_timestamp() end,lease_token=null,lease_expires_at=null where id=run.id;
end $$;

-- Only authenticated human paths can save a Phase 04 draft, with their current JWT.
grant execute on function private.communication_manage(uuid,text,uuid,integer,jsonb),private.communication_read(uuid,text,uuid,jsonb) to leadsfam_ai;
grant create on schema private to leadsfam_ai;
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('ai_authorized','ai_source','ai_json','ai_enqueue','ai_manage','ai_read','ai_claim','ai_prepare','ai_finish') loop
  execute format('alter function %s owner to leadsfam_ai',fn.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress',fn.signature);
 end loop;
end $$;
revoke create on schema private from leadsfam_ai;
grant execute on function private.ai_claim(),private.ai_prepare(uuid,uuid,integer,text),private.ai_finish(uuid,uuid,integer,jsonb) to leadsfam_worker;
grant execute on function private.ai_enqueue(uuid,uuid,uuid,uuid,jsonb,uuid) to leadsfam_automation;
create function public.ai_manage(p_org uuid,p_action text,p_id uuid default null,p_version integer default null,p_data jsonb default '{}') returns jsonb language sql volatile security invoker set search_path='' set statement_timeout='4s' as $$ select private.ai_manage(p_org,p_action,p_id,p_version,p_data) $$;
create function public.ai_read(p_org uuid,p_kind text,p_id uuid default null,p_query jsonb default '{}') returns jsonb language sql volatile security invoker set search_path='' set statement_timeout='4s' as $$ select private.ai_read(p_org,p_kind,p_id,p_query) $$;
revoke all on function public.ai_manage(uuid,text,uuid,integer,jsonb),public.ai_read(uuid,text,uuid,jsonb) from public,anon,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress;
grant execute on function public.ai_manage(uuid,text,uuid,integer,jsonb),public.ai_read(uuid,text,uuid,jsonb),private.ai_manage(uuid,text,uuid,integer,jsonb),private.ai_read(uuid,text,uuid,jsonb) to authenticated;

-- Extend the existing workflow; preserve grants, leases, current authority checks and fencing.
alter table private.automation_tool_executions drop constraint automation_tool_executions_tool_check;
alter table private.automation_tool_executions add check(tool in ('activities.create','ai.analyze'));
create or replace function private.automation_validate(p_definition jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare item jsonb;
begin
 perform private.crm_keys(p_definition,array['schemaVersion','trigger','conditions','steps'],array['schemaVersion','trigger','conditions','steps']);
 if p_definition->'schemaVersion'<>'1'::jsonb or p_definition->>'trigger'<>'lead.created' or jsonb_typeof(p_definition->'conditions')<>'array' or jsonb_typeof(p_definition->'steps')<>'array' or jsonb_array_length(p_definition->'conditions')>3 or jsonb_array_length(p_definition->'steps') not between 1 and 3 or octet_length(p_definition::text)>4096 then raise exception using errcode='22023',message='invalid_fields'; end if;
 for item in select value from jsonb_array_elements(p_definition->'conditions') loop
  perform private.crm_keys(item,array['field','equals'],array['field','equals']);
  if item->>'field'='sourceId' then perform (item->>'equals')::uuid;
  elsif item->>'field'='status' then
   if item->>'equals' not in ('new','in_progress','qualified','closed') then raise exception using errcode='22023',message='invalid_fields'; end if;
  else raise exception using errcode='22023',message='invalid_fields'; end if;
  if jsonb_typeof(item->'equals')<>'string' then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 if (select count(distinct value->>'id')<>count(*) from jsonb_array_elements(p_definition->'steps')) then raise exception using errcode='22023',message='invalid_fields'; end if;
 for item in select value from jsonb_array_elements(p_definition->'steps') loop
  perform private.crm_keys(item,array['id','tool','version','arguments'],array['id','tool','version','arguments']);
  perform private.crm_keys(item->'arguments',array['message'],array['message']);
  if jsonb_typeof(item->'id')<>'string' or jsonb_typeof(item->'tool')<>'string' or item->>'id' !~ '^[a-zA-Z0-9_-]{1,40}$' or item->>'tool' not in ('activities.create','ai.analyze') or item->'version'<>'1'::jsonb or jsonb_typeof(item->'arguments'->'message')<>'string' or char_length(btrim(item->'arguments'->>'message')) not between 1 and 300 then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
end $$;
create or replace function private.automation_execute(p_job uuid,p_token uuid,p_generation integer) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job private.automation_jobs; event private.domain_events; run private.automation_runs; workflow private.automation_workflows; revision private.automation_versions; integration private.source_integrations; lead public.leads; item jsonb; source uuid; matched boolean:=true; activity uuid; step_count integer:=0; outcome text:='succeeded'; failure_code text; state_code text;
begin
 select * into job from private.automation_jobs where id=p_job;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 -- Same order as revocation: organization lock before job/resource locks.
 perform private.automation_admin_generation(job.organization_id,null);
 select * into job from private.automation_jobs where id=p_job for update;
 if p_token is null or p_generation is null or job.state<>'claimed' or job.lease_token is distinct from p_token or job.generation<>p_generation or job.lease_expires_at<=clock_timestamp() then raise exception using errcode='P0001',message='lease_lost'; end if;
 perform set_config('leadsfam.automation_org',job.organization_id::text,true);
 select * into event from private.domain_events where organization_id=job.organization_id and id=job.event_id;
 begin
  if event.integration_id is not null then
   select * into integration from private.source_integrations where organization_id=job.organization_id and id=event.integration_id for share;
   if not found or integration.status<>'active' or integration.expires_at<=clock_timestamp() or private.automation_admin_generation(integration.organization_id,integration.authorized_by) is distinct from integration.authority_generation then raise exception using errcode='42501',message='authority_revoked'; end if;
  end if;
  if job.type='dispatch' then
   for item in select value from jsonb_array_elements(event.bindings) loop
    insert into private.automation_runs(organization_id,workflow_id,workflow_version,event_id) values(job.organization_id,(item->>'workflowId')::uuid,(item->>'version')::integer,event.id) on conflict do nothing returning * into run;
    if found then
     insert into private.automation_jobs(organization_id,type,event_id,run_id) values(job.organization_id,'workflow',event.id,run.id);
    end if;
   end loop;
   update private.domain_events set completed_at=clock_timestamp() where id=event.id;
  else
   select * into run from private.automation_runs where organization_id=job.organization_id and id=job.run_id for update;
   select * into workflow from private.automation_workflows where organization_id=job.organization_id and id=run.workflow_id for share;
   select * into revision from private.automation_versions where organization_id=job.organization_id and workflow_id=run.workflow_id and version=run.workflow_version;
   if workflow.status<>'active' then raise exception using errcode='42501',message='workflow_paused'; end if;
   if private.automation_admin_generation(job.organization_id,revision.published_by) is distinct from revision.authority_generation then raise exception using errcode='42501',message='authority_revoked'; end if;
   perform private.automation_validate(revision.definition);
   select * into lead from public.leads where organization_id=job.organization_id and id=event.subject_id for share;
   if not found or lead.archived_at is not null then raise exception using errcode='22023',message='resource_unavailable'; end if;
   select source_id into source from public.lead_attributions where organization_id=job.organization_id and lead_id=lead.id;
   for item in select value from jsonb_array_elements(revision.definition->'conditions') loop
    if (item->>'field'='sourceId' and source is distinct from (item->>'equals')::uuid) or (item->>'field'='status' and lead.status<>item->>'equals') then matched:=false; end if;
   end loop;
   if matched then
    for item in select value from jsonb_array_elements(revision.definition->'steps') loop
     if not exists(select 1 from private.automation_tool_executions where organization_id=job.organization_id and run_id=run.id and step_id=item->>'id') then
      if item->>'tool'='ai.analyze' then
       perform private.ai_enqueue(job.organization_id,run.id,event.subject_id,revision.published_by,jsonb_build_object('leadId',event.subject_id,'task','analysis','channel','email','kind','follow_up'),run.id);
      end if;
      -- Internal action through the existing append-only CRM activity model.
      insert into public.crm_activities(organization_id,lead_id,actor_id,event,details,request_id) values(job.organization_id,lead.id,revision.published_by,'automation.activity',jsonb_build_object('message',case when item->>'tool'='ai.analyze' then 'AI analysis requested. Review AI assistance on this lead; no message is sent.' else item->'arguments'->>'message' end,'runId',run.id,'workflowId',workflow.id),event.correlation_id::text) returning id into activity;
      insert into private.automation_tool_executions(organization_id,run_id,step_id,tool,fingerprint,activity_id) values(job.organization_id,run.id,item->>'id',item->>'tool',private.crm_fingerprint(item),activity);
     end if;
     step_count:=step_count+1;
    end loop;
   else outcome:='skipped'; failure_code:='CONDITION_NOT_MATCHED'; end if;
   update private.automation_runs set state=outcome,code=failure_code,started_at=coalesce(started_at,clock_timestamp()),finished_at=clock_timestamp() where id=run.id;
  end if;
 exception when query_canceled or others then
  get stacked diagnostics state_code=returned_sqlstate;
  -- Never persist SQL text/details or untrusted exception messages.
  failure_code:=case when state_code='42501' then 'AUTHORITY_REVOKED' when state_code in ('22023','22P02','23514','23503','23502') then 'INVALID_WORK' when state_code='57014' then 'DEADLINE_EXCEEDED' when state_code in ('55P03','40P01','40001','53300','08006') then 'TRANSIENT_FAILURE' else 'INTERNAL_FAILURE' end;
  if job.lease_expires_at<=clock_timestamp() then raise exception using errcode='P0001',message='lease_lost'; end if;
  if failure_code in ('TRANSIENT_FAILURE','INTERNAL_FAILURE','DEADLINE_EXCEEDED') and job.attempts<job.max_attempts then
   update private.automation_jobs set state='retryable',run_at=clock_timestamp()+make_interval(secs=>least(300,2^job.attempts)::integer+floor(random()*3)::integer),code=failure_code,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where id=job.id;
   return jsonb_build_object('state','retryable','code',failure_code);
  end if;
  update private.automation_jobs set state='failed_terminal',code=failure_code,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where id=job.id;
  if job.run_id is not null then update private.automation_runs set state='failed',code=failure_code,finished_at=clock_timestamp() where id=job.run_id; end if;
  return jsonb_build_object('state','failed_terminal','code',failure_code);
 end;
 -- Fence again after resource locks/steps. Raising rolls back every effect.
 if job.lease_expires_at<=clock_timestamp() then raise exception using errcode='P0001',message='lease_lost'; end if;
 update private.automation_jobs set state='completed',lease_token=null,lease_expires_at=null,code=null,updated_at=clock_timestamp() where id=job.id;
 return jsonb_build_object('state','completed','completedSteps',step_count);
end $$;
notify pgrst,'reload schema';

-- Phase 08 contract decision: docs/architecture/phase-08.md. Additive, mock-only.
set lock_timeout = '3s';

alter table private.conversations add column context_version bigint not null default 1 check (context_version > 0);
create index orchestration_inbound on private.communication_messages
 (organization_id, conversation_id, created_at desc, id desc)
 where direction = 'inbound' and state = 'delivered' and created_by_integration is not null;
grant select on private.conversations to leadsfam_ai;
create policy orchestration_context on private.conversations to leadsfam_ai
 using (organization_id = nullif((select current_setting('leadsfam.ai_org',true)),'')::uuid);
grant update(id) on public.contacts, public.leads to leadsfam_ai;

-- Reuse the communication coordinator lock, including late manually linked receipts.
create function private.orchestration_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if new.state = 'delivered' and (tg_op = 'INSERT' or old.state is distinct from new.state) then
  perform set_config('leadsfam.communication_org',new.organization_id::text,true);
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text||':communications',0));
  update private.conversations set context_version=context_version+1
   where organization_id=new.organization_id and id=new.conversation_id;
 end if;
 return new;
end $$;
create trigger orchestration_revision before insert or update of state on private.communication_messages
 for each row execute function private.orchestration_revision();

create table private.conversation_recommendations (
 id uuid primary key, organization_id uuid not null, conversation_id uuid not null,
 contact_id uuid not null, lead_id uuid not null, trigger_message_id uuid not null,
 ai_run_id uuid not null, source_version text not null check (source_version ~ '^[a-f0-9]{64}$'),
 ai_input_hash text not null check (ai_input_hash ~ '^[a-f0-9]{64}$'),
 knowledge_version integer not null check (knowledge_version > 0), contract_version integer not null default 1 check (contract_version=1),
 kind text check (kind in ('ASK_FOR_INFORMATION','PREPARE_FOLLOW_UP','HUMAN_ATTENTION','NO_ACTION')),
 state text not null default 'evaluating' check (state in ('evaluating','pending_review','accepted','dismissed','deferred','stale','failed')),
 version integer not null default 1 check (version > 0), message_id uuid,
 created_by uuid not null, created_at timestamptz not null default clock_timestamp(),
 reviewed_by uuid, reviewed_at timestamptz, decision text check (decision in ('accept','dismiss','defer','prepare')),
 decision_from_version integer,
 unique(organization_id,id), unique(organization_id,ai_run_id),
 foreign key(organization_id,conversation_id) references private.conversations(organization_id,id),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id),
 foreign key(organization_id,trigger_message_id) references private.communication_messages(organization_id,id),
 foreign key(organization_id,message_id) references private.communication_messages(organization_id,id),
 foreign key(organization_id,ai_run_id) references private.ai_runs(organization_id,id),
 foreign key(organization_id,created_by) references public.organization_memberships(organization_id,user_id),
 foreign key(organization_id,reviewed_by) references public.organization_memberships(organization_id,user_id),
 check (message_id is null or (state='accepted' and kind in ('ASK_FOR_INFORMATION','PREPARE_FOLLOW_UP')))
);
create unique index orchestration_source_identity on private.conversation_recommendations(organization_id,conversation_id,source_version)
 where state not in ('failed','stale');
create index orchestration_history on private.conversation_recommendations(organization_id,conversation_id,created_at desc,id desc);
alter table private.conversation_recommendations enable row level security;
revoke all on private.conversation_recommendations from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress;
grant select,insert,update on private.conversation_recommendations to leadsfam_ai;
create policy orchestration_scope on private.conversation_recommendations to leadsfam_ai
 using (organization_id=nullif((select current_setting('leadsfam.ai_org',true)),'')::uuid)
 with check (organization_id=nullif((select current_setting('leadsfam.ai_org',true)),'')::uuid);

create function private.orchestration_source(p_org uuid,p_conversation uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare c private.conversations; m private.communication_messages; source jsonb; reason text;
begin
 select * into c from private.conversations where organization_id=p_org and id=p_conversation;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 source:=private.ai_source(p_org,c.lead_id);
 select * into m from private.communication_messages where organization_id=p_org and conversation_id=c.id
  and direction='inbound' and state='delivered' and created_by_integration is not null
  and contact_id=c.contact_id and lead_id=c.lead_id order by created_at desc,id desc limit 1;
 if source is null or c.lead_id is null then reason:='LEAD_UNAVAILABLE';
 elsif m.id is null then reason:='NO_ATTRIBUTED_REPLY';
 elsif not exists(select 1 from jsonb_array_elements(source->'conversation') item where item->>'id'=m.id::text) then reason:='RECENT_CONTEXT_REQUIRED';
 end if;
 return jsonb_build_object('source',source,'contactId',c.contact_id,'leadId',c.lead_id,'channel',c.channel,
  'triggerMessageId',m.id,'sourceVersion',case when source is not null then private.crm_fingerprint(jsonb_build_object('source',source,'revision',c.context_version)) end,'reason',reason);
end $$;

-- Classification is server controlled. Generic humanReview is common to all proposals;
-- explicit escalation, conflict, unsupported/urgent/cancellation cases always win.
create function private.orchestration_kind(p_analysis jsonb,p_cancel boolean default false) returns text
language sql immutable security invoker set search_path='' as $$
 select case
  when p_cancel or p_analysis->>'conflictingInformation'='true'
   or p_analysis->>'serviceFit'='unsupported' or p_analysis->>'areaFit'='unsupported'
   or p_analysis->>'urgencyLevel'='urgent' or p_analysis->>'intentCategory'='complaint'
   or p_analysis->>'nextAction' in ('human_review','not_match')
   or p_analysis->>'status' in ('requires_manual_review','not_a_match') then 'HUMAN_ATTENTION'
  when p_analysis->>'intentCategory' not in ('service_inquiry','pricing','scheduling')
   or p_analysis->>'serviceFit' is distinct from 'supported' then 'HUMAN_ATTENTION'
  when jsonb_typeof(p_analysis->'missing')='array' and jsonb_array_length(p_analysis->'missing')>0
   or exists(select 1 from jsonb_array_elements(coalesce(p_analysis->'requiredAnswers','[]')) x where x->'evidence'='null'::jsonb) then 'ASK_FOR_INFORMATION'
  when p_analysis->>'humanReview'='true' then 'HUMAN_ATTENTION'
  when p_analysis->>'status' in ('potentially_qualified','qualified_for_review') and p_analysis->>'nextAction'='acknowledge' then 'PREPARE_FOLLOW_UP'
  else 'NO_ACTION' end
$$;

-- Runs retain all existing leases/retry rules. No extra execution or new queue.
create function private.orchestration_completed() returns trigger
language plpgsql security definer set search_path='' as $$
declare r private.conversation_recommendations; cancel boolean;
begin
 if new.state not in ('succeeded','failed','attention') or old.state=new.state then return new; end if;
 perform set_config('leadsfam.ai_org',new.organization_id::text,true);
 select * into r from private.conversation_recommendations where organization_id=new.organization_id and ai_run_id=new.id for update;
 if not found or r.state<>'evaluating' then return new; end if;
 select body ~* '\m(cancel|unsubscribe|stop)\M' into cancel from private.communication_messages where organization_id=r.organization_id and id=r.trigger_message_id;
 update private.conversation_recommendations set
  state=case when new.state<>'succeeded' then 'failed'
   when new.input_fingerprint is distinct from r.ai_input_hash then 'stale' else 'pending_review' end,
  kind=case when new.state='succeeded' then private.orchestration_kind(new.result->'analysis',coalesce(cancel,false)) end,
  version=version+1 where organization_id=r.organization_id and id=r.id;
 perform private.audit(r.organization_id,'orchestration.evaluated:'||r.id::text);
 return new;
end $$;
create trigger orchestration_completed after update of state on private.ai_runs for each row execute function private.orchestration_completed();

create function private.orchestration_json(p_row private.conversation_recommendations,p_current text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select (to_jsonb(p_row)-array['organization_id','ai_input_hash','decision_from_version']) || jsonb_build_object(
  'stale',p_row.source_version is distinct from p_current,
  'state',case when p_row.source_version is distinct from p_current and p_row.state in ('evaluating','pending_review','deferred') then 'stale' else p_row.state end,
  'evaluation',(select private.ai_json(a) from private.ai_runs a where a.organization_id=p_row.organization_id and a.id=p_row.ai_run_id))
$$;

create function private.orchestration_read(p_org uuid,p_id uuid,p_query jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare ctx jsonb; items jsonb; cursor_time timestamptz; cursor_id uuid;
begin
 perform private.crm_keys(p_query,array['cursor']);
 if p_query->>'cursor' is not null then
  if octet_length(p_query->>'cursor')>200 then raise exception using errcode='22023',message='invalid_fields'; end if;
  cursor_time:=((p_query->>'cursor')::jsonb->>0)::timestamptz; cursor_id:=((p_query->>'cursor')::jsonb->>1)::uuid;
  if cursor_time is null or cursor_id is null then raise exception using errcode='22023',message='invalid_fields'; end if;
 end if;
 ctx:=private.orchestration_source(p_org,p_id);
 select coalesce(jsonb_agg(private.orchestration_json(r,ctx->>'sourceVersion') order by r.created_at desc,r.id desc),'[]') into items
 from (select * from private.conversation_recommendations where organization_id=p_org and conversation_id=p_id
  and (cursor_time is null or (created_at,id)<(cursor_time,cursor_id)) order by created_at desc,id desc limit 21) r;
 return jsonb_build_object('eligible',ctx->>'reason' is null,'reason',ctx->>'reason','sourceVersion',ctx->>'sourceVersion',
  'items',items-20,'next',case when jsonb_array_length(items)>20 then jsonb_build_array(items->19->>'created_at',items->19->>'id')::text end);
end $$;

create function private.orchestration_manage(p_org uuid,p_action text,p_id uuid,p_version integer,p_data jsonb,p_actor uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r private.conversation_recommendations; ctx jsonb; source jsonb; run_id uuid; choice text; recipient text; proposal jsonb; eligibility jsonb;
begin
 -- Consistent lock order: current membership/organization, communications, AI settings,
 -- recommendation. No lock is held while inference executes outside PostgreSQL.
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':communications',0));
 perform 1 from private.ai_settings where organization_id=p_org for update;
 if p_action='conversation_evaluate' then
  perform private.crm_keys(p_data,array['conversationId','sourceVersion'],array['conversationId','sourceVersion']);
  if p_id is null or p_data->>'sourceVersion' !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='invalid_fields'; end if;
  ctx:=private.orchestration_source(p_org,(p_data->>'conversationId')::uuid);
 else
  perform private.crm_keys(p_data,array['decision'],array['decision']);
  select * into r from private.conversation_recommendations where organization_id=p_org and id=p_id for update;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
  ctx:=private.orchestration_source(p_org,r.conversation_id);
 end if;
 perform 1 from public.contacts where organization_id=p_org and id=(ctx->>'contactId')::uuid and archived_at is null for share;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 perform 1 from public.leads where organization_id=p_org and id=(ctx->>'leadId')::uuid and contact_id=(ctx->>'contactId')::uuid and archived_at is null for share;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 -- Refresh after waiting for CRM edit locks.
 ctx:=private.orchestration_source(p_org,case when p_action='conversation_evaluate' then (p_data->>'conversationId')::uuid else r.conversation_id end);
 source:=ctx->'source';
 if p_action='conversation_evaluate' then
  select * into r from private.conversation_recommendations where organization_id=p_org and id=p_id;
  if found then
   if r.conversation_id is distinct from (p_data->>'conversationId')::uuid or r.source_version is distinct from p_data->>'sourceVersion' then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
   return private.orchestration_json(r,ctx->>'sourceVersion');
  end if;
  if ctx->>'reason' is not null then raise exception using errcode='P0001',message='conversation_ineligible'; end if;
  if p_data->>'sourceVersion' is distinct from ctx->>'sourceVersion' then raise exception using errcode='P0001',message='stale_recommendation'; end if;
  if not exists(select 1 from private.ai_settings where organization_id=p_org and enabled and provider='simulation') then raise exception using errcode='P0001',message='orchestration_simulation_required'; end if;
  select * into r from private.conversation_recommendations where organization_id=p_org and conversation_id=(p_data->>'conversationId')::uuid and source_version=ctx->>'sourceVersion' and state not in ('failed','stale');
  if found then return private.orchestration_json(r,ctx->>'sourceVersion'); end if;
  update private.conversation_recommendations set state='stale',version=version+1 where organization_id=p_org and conversation_id=(p_data->>'conversationId')::uuid and state in ('evaluating','pending_review','deferred') and source_version is distinct from ctx->>'sourceVersion';
  run_id:=gen_random_uuid();
  perform private.ai_enqueue(p_org,run_id,(ctx->>'leadId')::uuid,p_actor,jsonb_build_object('leadId',ctx->>'leadId','task','draft','channel',ctx->>'channel','kind','follow_up'));
  insert into private.conversation_recommendations(id,organization_id,conversation_id,contact_id,lead_id,trigger_message_id,ai_run_id,source_version,ai_input_hash,knowledge_version,created_by)
   values(p_id,p_org,(p_data->>'conversationId')::uuid,(ctx->>'contactId')::uuid,(ctx->>'leadId')::uuid,(ctx->>'triggerMessageId')::uuid,run_id,ctx->>'sourceVersion',private.crm_fingerprint(source),(source->>'knowledgeVersion')::integer,p_actor) returning * into r;
  perform private.audit(p_org,'orchestration.requested:'||r.id::text);
  return private.orchestration_json(r,ctx->>'sourceVersion');
 end if;
 choice:=p_data->>'decision';
 if choice not in ('accept','dismiss','defer','prepare') or choice is null or p_version is null then raise exception using errcode='22023',message='invalid_fields'; end if;
 if r.decision_from_version=p_version and r.reviewed_by=p_actor and r.decision=choice then return private.orchestration_json(r,ctx->>'sourceVersion'); end if;
 if r.version<>p_version then raise exception using errcode='P0001',message='version_conflict'; end if;
 if r.source_version is distinct from ctx->>'sourceVersion' or ctx->>'reason' is not null or r.state='stale' then raise exception using errcode='P0001',message='stale_recommendation'; end if;
 if r.state not in ('pending_review','deferred') and not (r.state='accepted' and choice='prepare' and r.message_id is null) then raise exception using errcode='P0001',message='invalid_transition'; end if;
 if choice='prepare' then
  if r.kind not in ('ASK_FOR_INFORMATION','PREPARE_FOLLOW_UP') then raise exception using errcode='42501',message='forbidden'; end if;
  select result->'proposal' into proposal from private.ai_runs where organization_id=p_org and id=r.ai_run_id and state='succeeded' and provider='simulation';
  if proposal is null or proposal='null'::jsonb then raise exception using errcode='P0001',message='invalid_transition'; end if;
  select sender into recipient from private.communication_messages where organization_id=p_org and id=r.trigger_message_id;
  eligibility:=private.communication_read(p_org,'eligibility',r.contact_id,jsonb_build_object('channel',ctx->>'channel','recipient',recipient,'purpose','transactional'));
  if eligibility->>'code' is not null then raise exception using errcode='P0001',message='recipient_ineligible'; end if;
  perform private.communication_manage(p_org,'draft',r.ai_run_id,null,jsonb_build_object('id',r.ai_run_id,'contactId',r.contact_id,'leadId',r.lead_id,'channel',ctx->>'channel','purpose','transactional','recipient',recipient,'subject',proposal->>'subject','body',proposal->>'body'));
  update private.ai_runs set message_id=r.ai_run_id where organization_id=p_org and id=r.ai_run_id;
 end if;
 update private.conversation_recommendations set state=case choice when 'dismiss' then 'dismissed' when 'defer' then 'deferred' else 'accepted' end,
  version=version+1, reviewed_by=p_actor,reviewed_at=clock_timestamp(),decision=choice,decision_from_version=p_version,
  message_id=case when choice='prepare' then ai_run_id else message_id end where organization_id=p_org and id=r.id returning * into r;
 perform private.audit(p_org,'orchestration.'||choice||':'||r.id::text||':'||p_version::text);
 return private.orchestration_json(r,ctx->>'sourceVersion');
end $$;

create or replace function private.ai_manage(p_org uuid,p_action text,p_id uuid,p_version integer,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; settings private.ai_settings; run private.ai_runs; message jsonb; field text; v_business jsonb;
begin
 actor:=private.crm_context(p_org,case when p_action='settings' then 'manage' else 'write' end);
 perform set_config('leadsfam.ai_org',p_org::text,true);
 if p_action in ('conversation_evaluate','conversation_review') then return private.orchestration_manage(p_org,p_action,p_id,p_version,p_data,actor); end if;
 if p_action='request' then return private.ai_enqueue(p_org,p_id,(p_data->>'leadId')::uuid,actor,p_data); end if;
 if p_action='settings' then
  perform private.crm_keys(p_data,array['enabled','provider','dailyLimit','concurrentLimit','business'],array['enabled','provider','dailyLimit','concurrentLimit','business']);
  v_business:=p_data->'business';
  perform private.crm_keys(v_business,array['name','description','services','serviceAreas','tone','questions','guidelines','restrictions','escalation','knowledge'],array['name','description','services','serviceAreas','tone','questions','guidelines','restrictions','escalation']);
  if jsonb_typeof(p_data->'enabled')<>'boolean' or p_data->>'provider' not in ('simulation','openai') or jsonb_typeof(v_business)<>'object' or v_business->>'tone' not in ('warm','concise','formal') then raise exception using errcode='22023',message='invalid_fields'; end if;
  foreach field in array array['name','description','guidelines','restrictions','escalation'] loop
   if jsonb_typeof(v_business->field)<>'string' or char_length(v_business->>field)>(case when field='name' then 80 when field='escalation' then 300 else 600 end) then raise exception using errcode='22023',message='invalid_fields'; end if;
  end loop;
  foreach field in array array['services','serviceAreas','questions'] loop
   if jsonb_typeof(v_business->field)<>'array' or jsonb_array_length(v_business->field)>(case when field='questions' then 8 else 10 end) or exists(select 1 from jsonb_array_elements(v_business->field) v where jsonb_typeof(v)<>'string' or char_length(btrim(v#>>'{}')) not between 1 and 160) then raise exception using errcode='22023',message='invalid_fields'; end if;
  end loop;
  perform private.ai_validate_knowledge(v_business);
  insert into private.ai_settings(organization_id) values(p_org) on conflict do nothing;
  select * into settings from private.ai_settings where organization_id=p_org for update;
  if p_version is distinct from settings.version then raise exception using errcode='P0001',message='version_conflict'; end if;
  update private.ai_settings set enabled=(p_data->>'enabled')::boolean,provider=p_data->>'provider',daily_limit=(p_data->>'dailyLimit')::integer,concurrent_limit=(p_data->>'concurrentLimit')::integer,business=v_business,version=version+1 where organization_id=p_org;
  perform private.audit(p_org,'ai.settings_changed');
  return jsonb_build_object('ok',true);
 elsif p_action='save_draft' then
  if exists(select 1 from private.conversation_recommendations where organization_id=p_org and ai_run_id=p_id) then raise exception using errcode='42501',message='forbidden'; end if;
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

create or replace function private.ai_read(p_org uuid,p_kind text,p_id uuid,p_query jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare s private.ai_settings; items jsonb;
begin
 perform private.crm_context(p_org,'read');
 perform set_config('leadsfam.ai_org',p_org::text,true);
 if p_kind='conversation' then return private.orchestration_read(p_org,p_id,p_query); end if;
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

grant create on schema private to leadsfam_ai,leadsfam_communications;
alter function private.orchestration_revision() owner to leadsfam_communications;
alter function private.orchestration_source(uuid,uuid) owner to leadsfam_ai;
alter function private.orchestration_kind(jsonb,boolean) owner to leadsfam_ai;
alter function private.orchestration_completed() owner to leadsfam_ai;
alter function private.orchestration_json(private.conversation_recommendations,text) owner to leadsfam_ai;
alter function private.orchestration_read(uuid,uuid,jsonb) owner to leadsfam_ai;
alter function private.orchestration_manage(uuid,text,uuid,integer,jsonb,uuid) owner to leadsfam_ai;
revoke create on schema private from leadsfam_ai,leadsfam_communications;
do $$ declare fn regprocedure; begin
 for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private' and p.proname like 'orchestration_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress',fn);
 end loop;
end $$;
notify pgrst,'reload schema';

-- Existing lead/Agents history sends orchestration proposals back through review.
create or replace function private.ai_json(p_run private.ai_runs) returns jsonb language sql stable security invoker set search_path='' as $$
 select (to_jsonb(p_run)-array['organization_id','actor_id','authority_generation','workflow_run_id','generation','lease_token','lease_expires_at','run_at','input_fingerprint'])
  || jsonb_build_object('recommendation_conversation_id',(select conversation_id from private.conversation_recommendations where organization_id=p_run.organization_id and ai_run_id=p_run.id))
$$;

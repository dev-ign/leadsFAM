-- Phase 06: extend the existing AI pipeline. Historical results are preserved.
set lock_timeout='3s';
alter table private.ai_settings drop constraint ai_settings_business_check;
alter table private.ai_settings add constraint ai_settings_business_check check(octet_length(business::text)<=16000);
alter table private.ai_runs drop constraint ai_runs_prompt_version_check;
alter table private.ai_runs add constraint ai_runs_prompt_version_check check(prompt_version in ('lead-assist-v1','lead-assist-v2'));
alter table private.ai_runs alter column prompt_version set default 'lead-assist-v2';
alter table private.ai_runs drop constraint ai_runs_analysis_version_check;
alter table private.ai_runs add constraint ai_runs_analysis_version_check check(analysis_version in (1,2));
alter table private.ai_runs alter column analysis_version set default 2;
-- Index matches tenant + contact + lead, latest delivered conversation context.
create index ai_conversation_context on private.communication_messages(organization_id,contact_id,lead_id,created_at desc,id desc) where state='delivered';
grant select on private.communication_messages to leadsfam_ai;
create policy ai_context on private.communication_messages to leadsfam_ai
 using(organization_id=nullif((select current_setting('leadsfam.ai_org',true)),'')::uuid);

create function private.ai_validate_knowledge(p_business jsonb) returns void language plpgsql immutable security invoker set search_path='' as $$
declare k jsonb:=p_business->'knowledge'; field text; item jsonb;
begin
 if k is null then return; end if;
 perform private.crm_keys(k,array['serviceDescriptions','faqs','pricing','scheduling','hours','requiredInformation','unsupportedRequests'],array['serviceDescriptions','faqs','pricing','scheduling','hours','requiredInformation','unsupportedRequests']);
 foreach field in array array['pricing','scheduling','hours'] loop
  if jsonb_typeof(k->field) is distinct from 'string' or char_length(k->>field)>(case when field='hours' then 300 else 600 end) then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 foreach field in array array['requiredInformation','unsupportedRequests','serviceDescriptions','faqs'] loop
  if jsonb_typeof(k->field) is distinct from 'array' then raise exception using errcode='22023',message='invalid_fields'; end if;
  if jsonb_array_length(k->field)>(case when field='serviceDescriptions' then 10 else 8 end) then raise exception using errcode='22023',message='invalid_fields'; end if;
  for item in select value from jsonb_array_elements(k->field) loop
   if field in ('requiredInformation','unsupportedRequests') then
    if jsonb_typeof(item) is distinct from 'string' or char_length(btrim(item#>>'{}')) not between 1 and 160 then raise exception using errcode='22023',message='invalid_fields'; end if;
   else
    perform private.crm_keys(item,case when field='faqs' then array['question','answer'] else array['service','description'] end,case when field='faqs' then array['question','answer'] else array['service','description'] end);
    if field='faqs' then
     if jsonb_typeof(item->'question') is distinct from 'string' or char_length(btrim(item->>'question')) not between 1 and 160 or jsonb_typeof(item->'answer') is distinct from 'string' or char_length(btrim(item->>'answer')) not between 1 and 400 then raise exception using errcode='22023',message='invalid_fields'; end if;
    else
     if jsonb_typeof(item->'service') is distinct from 'string' or not (p_business->'services' @> jsonb_build_array(item->>'service')) or jsonb_typeof(item->'description') is distinct from 'string' or char_length(btrim(item->>'description')) not between 1 and 400 then raise exception using errcode='22023',message='invalid_fields'; end if;
    end if;
   end if;
  end loop;
 end loop;
end $$;
grant create on schema private to leadsfam_ai;
alter function private.ai_validate_knowledge(jsonb) owner to leadsfam_ai;
revoke create on schema private from leadsfam_ai;
revoke all on function private.ai_validate_knowledge(jsonb) from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress;

create or replace function private.ai_source(p_org uuid,p_lead uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'lead',jsonb_build_object('title',l.title,'description',left(l.description,2000)),
  'contactName',left(c.display_name,80),'business',s.business,
  'knowledgeVersion',s.version,'inquiryAt',l.created_at,
  'conversation',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'direction',m.direction,'body',left(m.body,600),'at',m.created_at) order by m.created_at,m.id)
   from (select id,direction,body,created_at from private.communication_messages
    where organization_id=p_org and contact_id=l.contact_id and lead_id=l.id and state='delivered'
    order by created_at desc,id desc limit 6) m),'[]'::jsonb))
 from public.leads l join public.contacts c on c.organization_id=l.organization_id and c.id=l.contact_id
 join private.ai_settings s on s.organization_id=l.organization_id
 where l.organization_id=p_org and l.id=p_lead and l.archived_at is null and c.archived_at is null
$$;
create or replace function private.ai_manage(p_org uuid,p_action text,p_id uuid,p_version integer,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; settings private.ai_settings; run private.ai_runs; message jsonb; field text; v_business jsonb;
begin
 actor:=private.crm_context(p_org,case when p_action='settings' then 'manage' else 'write' end);
 perform set_config('leadsfam.ai_org',p_org::text,true);
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
create or replace function private.ai_prepare(p_id uuid,p_token uuid,p_generation integer,p_model text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
 update private.ai_runs set prompt_version='lead-assist-v2',analysis_version=2,model=case when provider='simulation' then 'simulation-v2' else p_model end,input_fingerprint=private.crm_fingerprint(source) where id=run.id;
 update private.ai_attempts set model=case when run.provider='simulation' then 'simulation-v2' else p_model end where organization_id=run.organization_id and run_id=run.id and generation=run.generation;
 return jsonb_build_object('source',source,'task',run.task,'channel',run.channel,'kind',run.kind,'provider',run.provider);
end $$;
create or replace function private.ai_finish(p_id uuid,p_token uuid,p_generation integer,p_data jsonb) returns void language plpgsql volatile security definer set search_path='' as $$
declare run private.ai_runs; source jsonb; failure text; target text;
begin
 perform private.crm_keys(p_data,array['result','code','retryable','durationMs','inputTokens','outputTokens','estimatedCostMicrousd','pricingVersion','providerModel'],array['result','code','retryable','durationMs','inputTokens','outputTokens','estimatedCostMicrousd','pricingVersion']);
 select * into run from private.ai_runs where id=p_id;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 perform private.ai_member_generation(run.organization_id,null);
 perform set_config('leadsfam.ai_org',run.organization_id::text,true);
 perform 1 from private.ai_settings where organization_id=run.organization_id for update;
 select * into run from private.ai_runs where id=p_id for update;
 if p_token is null or p_generation is null or run.state<>'claimed' or run.lease_token is distinct from p_token or run.generation<>p_generation or run.lease_expires_at<=clock_timestamp() then raise exception using errcode='P0001',message='lease_lost'; end if;
 failure:=p_data->>'code';
 if failure is not null and failure not in ('PROVIDER_UNAVAILABLE','RATE_LIMITED','TIMEOUT_UNCERTAIN','INFERENCE_UNCERTAIN','INVALID_OUTPUT','INPUT_LIMIT','CANCELLED_UNCERTAIN') then raise exception using errcode='22023',message='invalid_fields'; end if;
 if p_data->>'providerModel' is not null and (p_data->>'providerModel' !~ '^[a-zA-Z0-9._:-]{1,120}$' or run.provider<>'openai') then raise exception using errcode='22023',message='invalid_fields'; end if;
 source:=private.ai_source(run.organization_id,run.lead_id);
 if not private.ai_authorized(run) or not (select enabled and provider=run.provider from private.ai_settings where organization_id=run.organization_id) then failure:='AUTHORITY_REVOKED';
 elsif source is null or private.crm_fingerprint(source) is distinct from run.input_fingerprint then failure:='STALE_INPUT'; end if;
 target:=case when failure is null then 'succeeded' when failure in ('TIMEOUT_UNCERTAIN','INFERENCE_UNCERTAIN','CANCELLED_UNCERTAIN') then 'attention' when failure='RATE_LIMITED' and p_data->'retryable'='true'::jsonb and run.attempts<3 then 'retryable' else 'failed' end;
 if target='succeeded' then
  perform private.crm_keys(p_data->'result',array['analysis','proposal','reasoning','grounding'],array['analysis','proposal','reasoning']);
  if jsonb_typeof(p_data->'result'->'analysis')<>'object' or jsonb_typeof(p_data->'result'->'reasoning')<>'string' then raise exception using errcode='22023',message='invalid_fields'; end if;
 end if;
 update private.ai_attempts set model=coalesce(p_data->>'providerModel',model),state=target,code=failure,input_tokens=(p_data->>'inputTokens')::integer,output_tokens=(p_data->>'outputTokens')::integer,estimated_cost_microusd=(p_data->>'estimatedCostMicrousd')::numeric,pricing_version=p_data->>'pricingVersion',duration_ms=(p_data->>'durationMs')::integer,finished_at=clock_timestamp() where organization_id=run.organization_id and run_id=run.id and generation=run.generation;
 update private.ai_runs set model=coalesce(p_data->>'providerModel',model),state=target,code=failure,result=case when target='succeeded' then p_data->'result' else null end,input_tokens=(p_data->>'inputTokens')::integer,output_tokens=(p_data->>'outputTokens')::integer,estimated_cost_microusd=(p_data->>'estimatedCostMicrousd')::numeric,pricing_version=p_data->>'pricingVersion',duration_ms=(p_data->>'durationMs')::integer,run_at=clock_timestamp()+make_interval(secs=>least(60,5*run.attempts)),finished_at=case when target<>'retryable' then clock_timestamp() end,lease_token=null,lease_expires_at=null where id=run.id;
end $$;
notify pgrst,'reload schema';

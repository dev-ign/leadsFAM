-- Phase 07 contract/security assessment: docs/architecture/phase-07.md.
-- Additive upgrade; no historical migration or preserved data is rewritten.
set lock_timeout='3s';
alter table private.source_integrations add column capability text not null default 'lead_intake' check(capability in ('lead_intake','mock_inbound')),
 add column credential_generation integer not null default 1 check(credential_generation>0);
create function private.integration_capability_immutable() returns trigger language plpgsql security invoker set search_path='' as $$ begin
 if new.capability is distinct from old.capability then raise exception using errcode='23514',message='immutable_identity'; end if;
 return new;
end $$;
create trigger integration_capability_immutable before update on private.source_integrations for each row execute function private.integration_capability_immutable();

alter table private.communication_messages alter column created_by drop not null,
 add column created_by_integration uuid,
 add foreign key(organization_id,created_by_integration) references private.source_integrations(organization_id,id),
 add constraint communication_creator_principal check(num_nonnulls(created_by,created_by_integration)=1),
 add constraint communication_connector_origin check(created_by_integration is null or (direction='inbound' and state='delivered' and authorized_by is null and authority_generation is null and reserved_at is null and approved_at is null and provider_message_id is null));
-- Keep the existing outbound validation, allowing an inbound email without a subject.
alter table private.communication_messages drop constraint communication_messages_check;
alter table private.communication_messages add constraint communication_messages_check check(
 (channel='email' and (subject<>'' or direction='inbound') and recipient ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') or
 (channel='sms' and subject='' and char_length(body)<=1600 and recipient ~ '^\+[1-9][0-9]{6,14}$'));

create table private.inbound_receipts (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,integration_id uuid not null,
 external_event_id text not null check(external_event_id ~ '^[A-Za-z0-9:_-]{1,160}$'),fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 channel text not null check(channel in ('email','sms')),sender text not null check(char_length(sender) between 3 and 254),
 recipient text not null,subject text not null check(char_length(subject)<=200),body text not null check(char_length(btrim(body)) between 1 and 4000 and octet_length(body)<=16000),
 reply_to uuid,occurred_at timestamptz,received_at timestamptz not null default clock_timestamp(),
 state text not null default 'needs_review' check(state in ('needs_review','linked')),
 reason text check(reason in ('unknown_customer','multiple_contacts','multiple_conversations','no_matching_lead','reply_unverified')),
 contact_id uuid,lead_id uuid,message_id uuid,resolved_by uuid,resolved_at timestamptz,
 unique(organization_id,id),unique(organization_id,integration_id,external_event_id),unique(organization_id,message_id),
 foreign key(organization_id,integration_id) references private.source_integrations(organization_id,id),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id),
 foreign key(organization_id,message_id) references private.communication_messages(organization_id,id),
 foreign key(organization_id,resolved_by) references public.organization_memberships(organization_id,user_id),
 check((state='needs_review' and reason is not null and num_nonnulls(contact_id,lead_id,message_id,resolved_by,resolved_at)=0) or (state='linked' and reason is null and contact_id is not null and message_id is not null and resolved_at is not null)),
 check((channel='email' and recipient='mock@example.test' and sender ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') or (channel='sms' and recipient='+15005550006' and subject='' and char_length(body)<=1600 and sender ~ '^\+[1-9][0-9]{6,14}$'))
);
create index inbound_review_history on private.inbound_receipts(organization_id,state,received_at desc,id desc);
alter table private.inbound_receipts enable row level security;
revoke all on private.inbound_receipts from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress;
grant select,insert,update on private.inbound_receipts to leadsfam_communications;
create policy inbound_execution on private.inbound_receipts to leadsfam_communications using(organization_id=nullif((select current_setting('leadsfam.communication_org',true)),'')::uuid) with check(organization_id=nullif((select current_setting('leadsfam.communication_org',true)),'')::uuid);
grant select(id,organization_id,name) on private.source_integrations to leadsfam_communications;
create policy inbound_integration_names on private.source_integrations for select to leadsfam_communications using(organization_id=nullif((select current_setting('leadsfam.communication_org',true)),'')::uuid);
-- Row locks serialize contact/lead edits and creation with attribution.
grant update(id) on public.contacts,public.leads to leadsfam_communications;

create function private.inbound_receipt_immutable() returns trigger language plpgsql security invoker set search_path='' as $$ begin
 if (to_jsonb(new)-array['state','reason','contact_id','lead_id','message_id','resolved_by','resolved_at']) is distinct from (to_jsonb(old)-array['state','reason','contact_id','lead_id','message_id','resolved_by','resolved_at']) or old.state<>'needs_review' or new.state<>'linked' then raise exception using errcode='23514',message='immutable_identity'; end if;
 return new;
end $$;
create trigger inbound_receipt_immutable before update on private.inbound_receipts for each row execute function private.inbound_receipt_immutable();
create function private.inbound_message_immutable() returns trigger language plpgsql security invoker set search_path='' as $$ begin
 if new.created_by_integration is distinct from old.created_by_integration or (old.created_by_integration is not null and new is distinct from old) then raise exception using errcode='23514',message='immutable_identity'; end if;
 return new;
end $$;
create trigger inbound_message_immutable before update on private.communication_messages for each row execute function private.inbound_message_immutable();
create function private.communication_outbound_job() returns trigger language plpgsql security invoker set search_path='' as $$ begin
 if not exists(select 1 from private.communication_messages where organization_id=new.organization_id and id=new.message_id and direction='outbound') then raise exception using errcode='23514',message='inbound_not_sendable'; end if;
 return new;
end $$;
create trigger communication_outbound_job before insert or update of message_id,organization_id on private.communication_jobs for each row execute function private.communication_outbound_job();

create function private.inbound_context(p_hash text,p_admit boolean) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare i private.source_integrations;
begin
 perform set_config('lock_timeout','3s',true);
 select * into i from private.source_integrations where credential_hash=p_hash and capability='mock_inbound';
 if not found then raise exception using errcode='42501',message='credentials_rejected'; end if;
 if private.automation_admin_generation(i.organization_id,i.authorized_by) is distinct from i.authority_generation then raise exception using errcode='42501',message='credentials_rejected'; end if;
 select * into i from private.source_integrations where id=i.id and credential_hash=p_hash for update;
 if not found or i.capability<>'mock_inbound' or i.status<>'active' or i.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='credentials_rejected'; end if;
 if p_admit then
  if i.quota_start<clock_timestamp()-interval '1 minute' then i.quota_start:=clock_timestamp();i.quota_count:=0;end if;
  if i.quota_count>=60 then raise exception using errcode='P0001',message='rate_limited'; end if;
  update private.source_integrations set quota_start=i.quota_start,quota_count=i.quota_count+1 where id=i.id;
 end if;
 return jsonb_build_object('id',i.id,'organizationId',i.organization_id);
end $$;
create function private.inbound_authorize(p_hash text) returns void language plpgsql volatile security definer set search_path='' as $$ begin
 perform private.inbound_context(p_hash,false);
end $$;

create function private.inbound_link(p_org uuid,p_id uuid,p_contact uuid,p_lead uuid,p_actor uuid) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare r private.inbound_receipts;c uuid;m private.communication_messages;
begin
 select * into r from private.inbound_receipts where organization_id=p_org and id=p_id for update;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 if r.state='linked' then
  if r.contact_id is distinct from p_contact or r.lead_id is distinct from p_lead then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
  select * into m from private.communication_messages where organization_id=p_org and id=r.message_id;
  return private.communication_json(m);
 end if;
 perform 1 from public.contacts where organization_id=p_org and id=p_contact and archived_at is null for share;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 if p_lead is not null then
  perform 1 from public.leads where organization_id=p_org and id=p_lead and contact_id=p_contact and archived_at is null for share;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
 end if;
 insert into private.conversations(organization_id,contact_id,lead_id,channel) values(p_org,p_contact,p_lead,r.channel) on conflict(organization_id,contact_id,lead_id,channel) do update set updated_at=clock_timestamp() returning id into c;
 insert into private.communication_messages(id,organization_id,conversation_id,contact_id,lead_id,direction,channel,purpose,sender,recipient,subject,body,state,created_by,created_by_integration,created_at,updated_at)
 values(gen_random_uuid(),p_org,c,p_contact,p_lead,'inbound',r.channel,'transactional',r.sender,r.recipient,r.subject,r.body,'delivered',null,r.integration_id,r.received_at,r.received_at) returning * into m;
 update private.inbound_receipts set state='linked',reason=null,contact_id=p_contact,lead_id=p_lead,message_id=m.id,resolved_by=p_actor,resolved_at=clock_timestamp() where organization_id=p_org and id=p_id;
 perform private.communication_record(p_org,m.id,'inbound_received');
 perform private.audit(p_org,'inbound.linked:'||p_id::text);
 return private.communication_json(m);
end $$;

create function private.inbound_ingest(p_hash text,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare ctx jsonb;org uuid;integration uuid;fingerprint text;r private.inbound_receipts;contact uuid;lead uuid;m private.communication_messages;counted integer;reason text;reply uuid;
begin
 ctx:=private.inbound_context(p_hash,true);org:=(ctx->>'organizationId')::uuid;integration:=(ctx->>'id')::uuid;
 perform set_config('leadsfam.communication_org',org::text,true);
 perform private.crm_keys(p_data,array['eventId','channel','sender','subject','body','replyTo','occurredAt'],array['eventId','channel','sender','subject','body','replyTo','occurredAt']);
 if octet_length(p_data::text)>16384 or jsonb_typeof(p_data->'eventId')<>'string' or p_data->>'eventId' !~ '^[A-Za-z0-9:_-]{1,160}$' or p_data->>'channel' not in ('email','sms') or exists(select 1 from jsonb_each(p_data) where key in ('eventId','channel','sender','subject','body') and jsonb_typeof(value)<>'string') or char_length(p_data->>'sender') not between 3 and 254 or char_length(p_data->>'subject')>200 or char_length(btrim(p_data->>'body')) not between 1 and 4000 then raise exception using errcode='22023',message='invalid_fields'; end if;
 if p_data->>'sender' is distinct from (case when p_data->>'channel'='email' then lower(btrim(p_data->>'sender')) else btrim(p_data->>'sender') end) or position(E'\r' in p_data->>'body')>0 then raise exception using errcode='22023',message='invalid_fields'; end if;
 if p_data->>'channel'='email' and p_data->>'sender' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or p_data->>'channel'='sms' and (p_data->>'sender' !~ '^\+[1-9][0-9]{6,14}$' or p_data->>'subject'<>'' or char_length(p_data->>'body')>1600) then raise exception using errcode='22023',message='invalid_fields'; end if;
 reply:=(p_data->>'replyTo')::uuid;fingerprint:=private.crm_fingerprint(p_data);
 select * into r from private.inbound_receipts where organization_id=org and integration_id=integration and external_event_id=p_data->>'eventId';
 if found then
  if r.fingerprint<>fingerprint then
   perform private.audit(org,'inbound.conflict:'||r.id::text);
   return jsonb_build_object('state','rejected','code','idempotency_conflict');
  end if;
  return jsonb_build_object('receiptId',r.id,'state',r.state,'messageId',r.message_id,'replayed',true);
 end if;
 if reply is not null then
  select * into m from private.communication_messages where organization_id=org and id=reply and direction='outbound' and channel=p_data->>'channel' and recipient=p_data->>'sender' and state in ('submitted','delivered');
  if found and exists(select 1 from private.conversations where organization_id=org and id=m.conversation_id and contact_id=m.contact_id and lead_id is not distinct from m.lead_id and channel=m.channel) and exists(select 1 from public.contacts c where c.organization_id=org and c.id=m.contact_id and c.archived_at is null and ((m.channel='email' and exists(select 1 from public.contact_emails where organization_id=org and contact_id=c.id and normalized=p_data->>'sender')) or (m.channel='sms' and exists(select 1 from public.contact_phones where organization_id=org and contact_id=c.id and normalized=p_data->>'sender')))) and (m.lead_id is null or exists(select 1 from public.leads where organization_id=org and id=m.lead_id and contact_id=m.contact_id and archived_at is null)) then contact:=m.contact_id;lead:=m.lead_id;
  else reason:='reply_unverified';end if;
 else
  select count(*),min(c.id::text)::uuid into counted,contact from public.contacts c where c.organization_id=org and c.archived_at is null and ((p_data->>'channel'='email' and exists(select 1 from public.contact_emails where organization_id=org and contact_id=c.id and normalized=p_data->>'sender')) or (p_data->>'channel'='sms' and exists(select 1 from public.contact_phones where organization_id=org and contact_id=c.id and normalized=p_data->>'sender')));
  if counted=0 then reason:='unknown_customer';elsif counted>1 then reason:='multiple_contacts';else
   perform 1 from public.contacts where organization_id=org and id=contact and archived_at is null for share;
   if not found then reason:='unknown_customer';else
    select count(*),min(id::text)::uuid into counted,lead from public.leads where organization_id=org and contact_id=contact and archived_at is null;
    if counted=0 then reason:='no_matching_lead';elsif counted>1 or exists(select 1 from private.conversations where organization_id=org and contact_id=contact and channel=p_data->>'channel' and lead_id is distinct from lead) then reason:='multiple_conversations';end if;
   end if;
  end if;
 end if;
 insert into private.inbound_receipts(organization_id,integration_id,external_event_id,fingerprint,channel,sender,recipient,subject,body,reply_to,occurred_at,reason)
 values(org,integration,p_data->>'eventId',fingerprint,p_data->>'channel',p_data->>'sender',case when p_data->>'channel'='email' then 'mock@example.test' else '+15005550006' end,p_data->>'subject',p_data->>'body',reply,(p_data->>'occurredAt')::timestamptz,coalesce(reason,'unknown_customer')) returning * into r;
 perform private.audit(org,'inbound.received:'||r.id::text);
 if reason is null then perform private.inbound_link(org,r.id,contact,lead,null);end if;
 select * into r from private.inbound_receipts where organization_id=org and id=r.id;
 return jsonb_build_object('receiptId',r.id,'state',r.state,'messageId',r.message_id,'replayed',false);
end $$;

create function private.inbound_resolve(p_org uuid,p_id uuid,p_data jsonb,p_actor uuid) returns jsonb language plpgsql volatile security invoker set search_path='' as $$ begin
 perform private.crm_keys(p_data,array['contactId','leadId'],array['contactId','leadId']);
 if p_data->>'contactId' is null or p_data->>'leadId' is null then raise exception using errcode='22023',message='invalid_fields';end if;
 return private.inbound_link(p_org,p_id,(p_data->>'contactId')::uuid,(p_data->>'leadId')::uuid,p_actor);
end $$;
create function private.inbound_read(p_org uuid,p_query jsonb) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare rows jsonb;cursor_time timestamptz;cursor_id uuid;
begin
 perform private.crm_keys(p_query,array['cursor']);
 if p_query->>'cursor' is not null then
  if octet_length(p_query->>'cursor')>200 then raise exception using errcode='22023',message='invalid_fields';end if;
  cursor_time:=((p_query->>'cursor')::jsonb->>0)::timestamptz;cursor_id:=((p_query->>'cursor')::jsonb->>1)::uuid;
  if cursor_time is null or cursor_id is null then raise exception using errcode='22023',message='invalid_fields';end if;
 end if;
 select coalesce(jsonb_agg(to_jsonb(t) order by t.received_at desc,t.id desc),'[]') into rows from (
  select r.id,r.channel,r.sender,r.recipient,r.subject,r.body,r.reason,r.received_at,r.occurred_at,i.name integration_name from private.inbound_receipts r join private.source_integrations i on i.organization_id=r.organization_id and i.id=r.integration_id where r.organization_id=p_org and r.state='needs_review' and (cursor_time is null or (r.received_at,r.id)<(cursor_time,cursor_id)) order by r.received_at desc,r.id desc limit 26
 ) t;
 return jsonb_build_object('items',rows-25,'next',case when jsonb_array_length(rows)>25 then jsonb_build_array(rows->24->>'received_at',rows->24->>'id')::text end);
end $$;

create or replace function private.communication_json(p_message private.communication_messages) returns jsonb language sql stable security invoker set search_path='' as $$
 select (to_jsonb(p_message)-array['organization_id','created_by','authorized_by','authority_generation','reserved_at','approved_at']) || jsonb_build_object('integration_name',(select name from private.source_integrations where organization_id=p_message.organization_id and id=p_message.created_by_integration))
$$;
create or replace function private.automation_manage(p_org uuid,p_kind text,p_action text,p_id uuid,p_version integer,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; authorizer_generation integer; integration private.source_integrations; workflow private.automation_workflows; definition jsonb; result jsonb;
begin
 actor:=private.crm_context(p_org,'manage');
 authorizer_generation:=private.automation_admin_generation(p_org,actor);
 perform set_config('leadsfam.automation_org',p_org::text,true);
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':automation-management',0));
 if p_kind='job' and p_action='retry' then
  perform private.crm_keys(p_data,'{}');
  perform 1 from private.automation_jobs where organization_id=p_org and id=p_id and state='failed_terminal' and generation=p_version for update;
  if not found then raise exception using errcode='P0001',message='version_conflict'; end if;
  update private.automation_jobs set state='retryable',attempts=0,generation=generation+1,run_at=clock_timestamp(),code=null,updated_at=clock_timestamp() where organization_id=p_org and id=p_id;
  update private.automation_runs set state='queued',code=null,started_at=null,finished_at=null where organization_id=p_org and id=(select run_id from private.automation_jobs where organization_id=p_org and id=p_id);
  perform private.audit(p_org,'automation.retry_requested:'||p_id::text);
  return jsonb_build_object('id',p_id,'state','retryable');
 elsif p_kind='integration' then
  if p_action='create' then
   perform private.crm_keys(p_data,array['name','sourceId','credentialHash','capability'],array['name','credentialHash']);
   if (select count(*) from private.source_integrations where organization_id=p_org)>=25 then raise exception using errcode='22023',message='resource_limit'; end if;
   if p_data->>'credentialHash' !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='invalid_fields'; end if;
   if p_data->>'sourceId' is not null and not exists(select 1 from public.lead_sources where organization_id=p_org and id=(p_data->>'sourceId')::uuid and archived_at is null) then raise exception using errcode='42501',message='not_found'; end if;
   if coalesce(p_data->>'capability','lead_intake') not in ('lead_intake','mock_inbound') or (p_data->>'capability'='mock_inbound' and p_data->>'sourceId' is not null) then raise exception using errcode='22023',message='invalid_fields'; end if;
   insert into private.source_integrations(id,capability,organization_id,name,status,source_id,credential_hash,expires_at,created_by,authorized_by,authority_generation) values(coalesce(p_id,gen_random_uuid()),coalesce(p_data->>'capability','lead_intake'),p_org,p_data->>'name','active',(p_data->>'sourceId')::uuid,p_data->>'credentialHash',clock_timestamp()+interval '90 days',actor,actor,authorizer_generation) returning * into integration;
  else
   select * into integration from private.source_integrations where organization_id=p_org and id=p_id for update;
   if not found then raise exception using errcode='42501',message='not_found'; end if;
   if p_version is null or p_version<>integration.version then raise exception using errcode='P0001',message='version_conflict'; end if;
   if integration.status='revoked' then raise exception using errcode='22023',message='invalid_transition'; end if;
   if p_action='rotate' then
    perform private.crm_keys(p_data,array['credentialHash'],array['credentialHash']);
    update private.source_integrations set credential_hash=p_data->>'credentialHash',credential_generation=integration.version+1,expires_at=clock_timestamp()+interval '90 days',authorized_by=actor,authority_generation=authorizer_generation,version=version+1,updated_at=clock_timestamp() where id=p_id returning * into integration;
   elsif p_action in ('active','paused','revoked') then
    perform private.crm_keys(p_data,'{}');
    update private.source_integrations set status=p_action,version=version+1,updated_at=clock_timestamp(),authorized_by=actor,authority_generation=authorizer_generation where id=p_id returning * into integration;
   else raise exception using errcode='22023',message='invalid_fields'; end if;
  end if;
  return to_jsonb(integration)-array['credential_hash','quota_start','quota_count','authority_generation'];
 elsif p_kind='workflow' then
  if p_action='save' then
   perform private.crm_keys(p_data,array['name','definition'],array['name','definition']);
   definition:=p_data->'definition'; perform private.automation_validate(definition);
   if exists(select 1 from jsonb_array_elements(definition->'conditions') c where c->>'field'='sourceId' and not exists(select 1 from public.lead_sources s where s.organization_id=p_org and s.id=(c->>'equals')::uuid and s.archived_at is null)) then raise exception using errcode='42501',message='not_found'; end if;
   if p_id is null then
    if (select count(*) from private.automation_workflows where organization_id=p_org)>=25 then raise exception using errcode='22023',message='resource_limit'; end if;
    insert into private.automation_workflows(organization_id,name,status,created_by) values(p_org,p_data->>'name','draft',actor) returning * into workflow;
   else
    select * into workflow from private.automation_workflows where organization_id=p_org and id=p_id for update;
    if not found then raise exception using errcode='42501',message='not_found'; end if;
    if p_version is null or p_version<>workflow.version then raise exception using errcode='P0001',message='version_conflict'; end if;
    update private.automation_workflows set name=p_data->>'name',version=version+1,updated_at=clock_timestamp() where id=p_id returning * into workflow;
   end if;
   insert into private.automation_versions(organization_id,workflow_id,version,definition,published_by,authority_generation) values(p_org,workflow.id,workflow.version,definition,actor,authorizer_generation);
  elsif p_action in ('publish','pause') then
   perform private.crm_keys(p_data,'{}');
   select * into workflow from private.automation_workflows where organization_id=p_org and id=p_id for update;
   if not found then raise exception using errcode='42501',message='not_found'; end if;
   if p_version is null or p_version<>workflow.version then raise exception using errcode='P0001',message='version_conflict'; end if;
   if p_action='publish' then
    select v.definition into definition from private.automation_versions v where organization_id=p_org and workflow_id=p_id and version=workflow.version;
    perform private.automation_validate(definition);
    -- A publication creates a fresh immutable delegated authority snapshot.
    update private.automation_workflows set version=version+1,published_version=version+1,status='active',updated_at=clock_timestamp() where id=p_id returning * into workflow;
    insert into private.automation_versions(organization_id,workflow_id,version,definition,published_by,authority_generation) values(p_org,workflow.id,workflow.version,definition,actor,authorizer_generation);
   else
    select v.definition into definition from private.automation_versions v where organization_id=p_org and workflow_id=p_id and version=workflow.version;
    update private.automation_workflows set version=version+1,status='paused',updated_at=clock_timestamp() where id=p_id returning * into workflow;
    insert into private.automation_versions(organization_id,workflow_id,version,definition,published_by,authority_generation) values(p_org,workflow.id,workflow.version,definition,actor,authorizer_generation);
   end if;
  else raise exception using errcode='22023',message='invalid_fields'; end if;
  return to_jsonb(workflow)||jsonb_build_object('definition',(select v.definition from private.automation_versions v where organization_id=p_org and workflow_id=workflow.id and version=workflow.version));
 end if;
 raise exception using errcode='22023',message='invalid_fields';
end $$;
create or replace function private.ingest_lead(p_hash text,p_data jsonb,p_correlation uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare integration private.source_integrations; receipt private.ingestion_receipts; fingerprint text; data jsonb; contact uuid; lead uuid; item jsonb; receipt_id uuid:=gen_random_uuid(); failure_code text; sql_code text; prior_fingerprint text;
begin
 perform set_config('lock_timeout','3s',true);
 select * into integration from private.source_integrations where credential_hash=p_hash and capability='lead_intake';
 if not found then raise exception using errcode='42501',message='credentials_rejected'; end if;
 if private.automation_admin_generation(integration.organization_id,integration.authorized_by) is distinct from integration.authority_generation then raise exception using errcode='42501',message='credentials_rejected'; end if;
 select * into integration from private.source_integrations where id=integration.id and credential_hash=p_hash for update;
 if not found or integration.capability<>'lead_intake' or integration.status<>'active' or integration.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='credentials_rejected'; end if;
 perform set_config('leadsfam.automation_org',integration.organization_id::text,true);
 perform private.crm_keys(p_data,array['schemaVersion','externalEventId','contact','lead','metadata'],array['schemaVersion','externalEventId','contact','lead','metadata']);
 if p_data->'schemaVersion'<>'1'::jsonb or jsonb_typeof(p_data->'externalEventId')<>'string' or char_length(p_data->>'externalEventId') not between 1 and 160 or octet_length(p_data::text)>16384 then raise exception using errcode='22023',message='invalid_fields'; end if;
 perform private.crm_keys(p_data->'metadata',array['formId','eventKind']);
 if exists(select 1 from jsonb_each(p_data->'metadata') where jsonb_typeof(value)<>'string' or char_length(value#>>'{}')>80) then raise exception using errcode='22023',message='invalid_fields'; end if;
 perform private.crm_keys(p_data->'lead',array['title','description','priority'],array['title','description','priority']);
 if exists(select 1 from jsonb_each(p_data->'lead') where jsonb_typeof(value)<>'string') then raise exception using errcode='22023',message='invalid_fields'; end if;
 fingerprint:=private.crm_fingerprint(p_data);
 if integration.quota_start<clock_timestamp()-interval '1 minute' then integration.quota_count:=0; integration.quota_start:=clock_timestamp(); end if;
 if integration.quota_count>=60 then raise exception using errcode='P0001',message='rate_limited'; end if;
 update private.source_integrations set quota_count=integration.quota_count+1,quota_start=integration.quota_start where id=integration.id;
 select a.fingerprint into prior_fingerprint from private.ingestion_attempts a where organization_id=integration.organization_id and integration_id=integration.id and external_event_id=p_data->>'externalEventId' order by created_at,id limit 1;
 if prior_fingerprint is not null and prior_fingerprint<>fingerprint then
  insert into private.ingestion_attempts(organization_id,integration_id,external_event_id,correlation_id,fingerprint,state,code) values(integration.organization_id,integration.id,p_data->>'externalEventId',p_correlation,fingerprint,'rejected','idempotency_conflict');
  return jsonb_build_object('state','rejected','code','idempotency_conflict');
 end if;
 begin
 select * into receipt from private.ingestion_receipts where organization_id=integration.organization_id and integration_id=integration.id and external_event_id=p_data->>'externalEventId';
 if found then
  if receipt.fingerprint<>fingerprint then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
  insert into private.ingestion_attempts(organization_id,integration_id,external_event_id,receipt_id,correlation_id,fingerprint,state) values(integration.organization_id,integration.id,p_data->>'externalEventId',receipt.id,p_correlation,fingerprint,'replayed');
  return jsonb_build_object('receiptId',receipt.id,'leadId',receipt.lead_id,'contactId',receipt.contact_id,'correlationId',receipt.correlation_id,'state','succeeded','replayed',true);
 end if;
 if integration.source_id is not null then
  perform 1 from public.lead_sources where organization_id=integration.organization_id and id=integration.source_id and archived_at is null for share;
  if not found then raise exception using errcode='22023',message='source_unavailable'; end if;
 end if;
 item:=p_data->'contact';
 if item->>'mode'='existing' then
  perform private.crm_keys(item,array['mode','id'],array['mode','id']);
  select id into contact from public.contacts where organization_id=integration.organization_id and id=(item->>'id')::uuid and archived_at is null for update;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
 elsif item->>'mode'='create' then
  perform private.crm_keys(item,array['mode','data'],array['mode','data']);
  data:=item->'data'; perform private.crm_validate_contact(data);
  -- Serialize cross-integration duplicate review, avoiding simultaneous weak
  -- matches bypassing the existing explicit review rule.
  perform pg_advisory_xact_lock(hashtextextended(integration.organization_id::text||':integration-contact-review',0));
  if jsonb_array_length(private.crm_matches(integration.organization_id,data))>0 and coalesce(data->>'duplicateResolution','')<>'create_distinct' then raise exception using errcode='P0001',message='duplicate_review_required'; end if;
  insert into public.contacts(organization_id,kind,display_name,first_name,last_name,company_name,created_by_integration) values(integration.organization_id,data->>'kind',btrim(data->>'displayName'),coalesce(data->>'firstName',''),coalesce(data->>'lastName',''),coalesce(data->>'companyName',''),integration.id) returning id into contact;
  insert into public.contact_emails(organization_id,contact_id,position,value,normalized) select integration.organization_id,contact,n::smallint,e->>'value',e->>'normalized' from jsonb_array_elements(data->'emails') with ordinality a(e,n);
  insert into public.contact_phones(organization_id,contact_id,position,value,normalized,region) select integration.organization_id,contact,n::smallint,e->>'value',e->>'normalized',e->>'region' from jsonb_array_elements(data->'phones') with ordinality a(e,n);
  -- Flush canonical deferred channel constraints while the bounded execution
  -- owner still holds authority; the ingress LOGIN has no table privileges.
  set constraints public.crm_email_positions,public.crm_phone_positions immediate;
  set constraints public.crm_email_positions,public.crm_phone_positions deferred;
  insert into public.crm_activities(organization_id,contact_id,integration_id,event) values(integration.organization_id,contact,integration.id,'contact.created');
 else raise exception using errcode='22023',message='invalid_fields'; end if;
 insert into public.leads(organization_id,contact_id,title,description,priority,created_by_integration) values(integration.organization_id,contact,btrim(p_data->'lead'->>'title'),p_data->'lead'->>'description',p_data->'lead'->>'priority',integration.id) returning id into lead;
 perform set_config('leadsfam.ingestion_correlation',p_correlation::text,true);
 perform set_config('leadsfam.ingestion_receipt',receipt_id::text,true);
 insert into public.lead_attributions(organization_id,lead_id,source_id,channel,provider,external_reference) values(integration.organization_id,lead,integration.source_id,'first_party','first_party',p_data->>'externalEventId');
 insert into public.crm_activities(organization_id,lead_id,integration_id,event,details,request_id) values(integration.organization_id,lead,integration.id,'lead.created',jsonb_build_object('channel','first_party','sourceId',integration.source_id),p_correlation::text);
 insert into private.ingestion_receipts(id,organization_id,integration_id,external_event_id,fingerprint,contact_id,lead_id,correlation_id) values(receipt_id,integration.organization_id,integration.id,p_data->>'externalEventId',fingerprint,contact,lead,p_correlation);
 insert into private.ingestion_attempts(organization_id,integration_id,external_event_id,receipt_id,correlation_id,fingerprint,state) values(integration.organization_id,integration.id,p_data->>'externalEventId',receipt_id,p_correlation,fingerprint,'succeeded');
 return jsonb_build_object('receiptId',receipt_id,'leadId',lead,'contactId',contact,'correlationId',p_correlation,'state','succeeded','replayed',false);
 exception when others then
  get stacked diagnostics failure_code=message_text,sql_code=returned_sqlstate;
  failure_code:=case when failure_code in ('idempotency_conflict','duplicate_review_required','not_found','source_unavailable','invalid_fields') then failure_code when sql_code in ('22023','22P02','23514','23503','23502') then 'invalid_fields' else 'ingestion_unavailable' end;
  insert into private.ingestion_attempts(organization_id,integration_id,external_event_id,correlation_id,fingerprint,state,code) values(integration.organization_id,integration.id,p_data->>'externalEventId',p_correlation,fingerprint,'rejected',failure_code);
  return jsonb_build_object('state','rejected','code',failure_code);
 end;
end $$;
create or replace function private.communication_manage(p_org uuid,p_action text,p_id uuid,p_version integer,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; m private.communication_messages; c uuid; v_generation integer; dest text; v_channel text; fingerprint jsonb;
begin
 actor:=private.crm_context(p_org,case when p_action in ('draft','resolve_inbound') then 'write' else 'manage' end);
 perform set_config('leadsfam.communication_org',p_org::text,true);
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':communications',0));
 insert into private.communication_settings(organization_id) values(p_org) on conflict do nothing;
 if p_action='settings' then
  perform private.crm_keys(p_data,array['paused','dailyLimit','recipientDailyLimit','channelDailyLimit','concurrentLimit','requestsPerMinute','maxAttempts'],array['paused','dailyLimit','recipientDailyLimit','channelDailyLimit','concurrentLimit','requestsPerMinute','maxAttempts']);
  update private.communication_settings set paused=(p_data->>'paused')::boolean,daily_limit=(p_data->>'dailyLimit')::integer,recipient_daily_limit=(p_data->>'recipientDailyLimit')::integer,channel_daily_limit=(p_data->>'channelDailyLimit')::integer,concurrent_limit=(p_data->>'concurrentLimit')::integer,requests_per_minute=(p_data->>'requestsPerMinute')::integer,max_attempts=(p_data->>'maxAttempts')::integer where organization_id=p_org;
  perform private.audit(p_org,'communications.settings_changed');
  return jsonb_build_object('ok',true);
 elsif p_action='permission' then
  perform private.crm_keys(p_data,array['contactId','channel','purpose','recipient','status','source','collectedAt','jurisdiction','policyVersion','evidence'],array['contactId','channel','purpose','recipient','status','source','collectedAt','jurisdiction','policyVersion','evidence']);
  v_channel:=p_data->>'channel'; dest:=case when v_channel='email' then lower(btrim(p_data->>'recipient')) else btrim(p_data->>'recipient') end;
  if (p_data->>'collectedAt')::timestamptz>clock_timestamp() or p_data->>'jurisdiction'='ZZ' then raise exception using errcode='22023',message='invalid_fields'; end if;
  if not exists(select 1 from public.contacts where organization_id=p_org and id=(p_data->>'contactId')::uuid and archived_at is null) then raise exception using errcode='42501',message='not_found'; end if;
  if not ((v_channel='email' and exists(select 1 from public.contact_emails where organization_id=p_org and contact_id=(p_data->>'contactId')::uuid and normalized=dest)) or (v_channel='sms' and exists(select 1 from public.contact_phones where organization_id=p_org and contact_id=(p_data->>'contactId')::uuid and normalized=dest))) then raise exception using errcode='22023',message='invalid_fields'; end if;
  insert into private.communication_permissions(organization_id,contact_id,channel,purpose,recipient,status,source,collected_at,revoked_at,jurisdiction,policy_version,evidence,actor_id) values(p_org,(p_data->>'contactId')::uuid,v_channel,p_data->>'purpose',dest,p_data->>'status',p_data->>'source',(p_data->>'collectedAt')::timestamptz,case when p_data->>'status'='revoked' then clock_timestamp() end,p_data->>'jurisdiction',p_data->>'policyVersion',p_data->>'evidence',actor);
  if p_data->>'status'='revoked' then
   insert into private.communication_suppressions values(p_org,v_channel,dest,'opt_out',clock_timestamp()) on conflict do nothing;
  end if;
  perform private.audit(p_org,'communications.permission_recorded');
  return jsonb_build_object('ok',true);
 elsif p_action='suppression' then
  perform private.crm_keys(p_data,array['channel','recipient','suppressed'],array['channel','recipient','suppressed']);
  v_channel:=p_data->>'channel'; dest:=case when v_channel='email' then lower(btrim(p_data->>'recipient')) else btrim(p_data->>'recipient') end;
  if v_channel not in ('email','sms') or dest is null or (p_data->>'suppressed')::boolean is null then raise exception using errcode='22023',message='invalid_fields'; end if;
  if (p_data->>'suppressed')::boolean then
   insert into private.communication_suppressions values(p_org,v_channel,dest,'administrative',clock_timestamp()) on conflict do nothing;
  else
   -- Provider opt-outs/bounces require separate reviewed repermission, not an admin toggle.
   delete from private.communication_suppressions where organization_id=p_org and communication_suppressions.channel=v_channel and recipient=dest and reason='administrative';
   if exists(select 1 from private.communication_suppressions where organization_id=p_org and communication_suppressions.channel=v_channel and recipient=dest) then raise exception using errcode='P0001',message='suppression_review_required'; end if;
  end if;
  perform private.audit(p_org,'communications.suppression_changed');
  return jsonb_build_object('ok',true);
 elsif p_action='resolve_inbound' then
  return private.inbound_resolve(p_org,p_id,p_data,actor);
 elsif p_action='draft' then
  perform private.crm_keys(p_data,array['id','contactId','leadId','channel','purpose','recipient','subject','body'],array['id','contactId','leadId','channel','purpose','recipient','subject','body']);
  if p_id is null or p_id is distinct from (p_data->>'id')::uuid then raise exception using errcode='22023',message='invalid_fields'; end if;
  if not exists(select 1 from public.contacts where organization_id=p_org and id=(p_data->>'contactId')::uuid and archived_at is null) or (p_data->>'leadId' is not null and not exists(select 1 from public.leads where organization_id=p_org and id=(p_data->>'leadId')::uuid and contact_id=(p_data->>'contactId')::uuid and archived_at is null)) then raise exception using errcode='42501',message='not_found'; end if;
  select * into m from private.communication_messages where organization_id=p_org and id=p_id for update;
  dest:=case when p_data->>'channel'='email' then lower(btrim(p_data->>'recipient')) else btrim(p_data->>'recipient') end;
  p_data:=p_data||jsonb_build_object('recipient',dest,'subject',btrim(p_data->>'subject'),'body',btrim(p_data->>'body'));
  if found then
   if m.direction<>'outbound' then raise exception using errcode='42501',message='forbidden'; end if;
   if m.created_by<>actor then raise exception using errcode='42501',message='forbidden'; end if;
   fingerprint:=jsonb_build_object('id',m.id,'contactId',m.contact_id,'leadId',m.lead_id,'channel',m.channel,'purpose',m.purpose,'recipient',m.recipient,'subject',m.subject,'body',m.body);
   if fingerprint=p_data then return private.communication_json(m); end if;
   if m.state<>'draft' then raise exception using errcode='P0001',message='invalid_transition'; end if;
   if p_version is null or p_version<>m.version then raise exception using errcode='P0001',message='version_conflict'; end if;
   if m.contact_id<>(p_data->>'contactId')::uuid or m.lead_id is distinct from (p_data->>'leadId')::uuid or m.channel<>p_data->>'channel' then raise exception using errcode='22023',message='invalid_fields'; end if;
   update private.communication_messages set recipient=dest,purpose=p_data->>'purpose',subject=btrim(p_data->>'subject'),body=btrim(p_data->>'body'),version=version+1,updated_at=clock_timestamp() where organization_id=p_org and id=p_id returning * into m;
   perform private.communication_record(p_org,m.id,'draft_updated');
  else
   if p_version is not null then raise exception using errcode='P0001',message='version_conflict'; end if;
   if (select count(*) from private.communication_messages where organization_id=p_org and state in ('draft','queued','submitting','attention'))>=1000 then raise exception using errcode='22023',message='resource_limit'; end if;
   insert into private.conversations(organization_id,contact_id,lead_id,channel) values(p_org,(p_data->>'contactId')::uuid,(p_data->>'leadId')::uuid,p_data->>'channel') on conflict(organization_id,contact_id,lead_id,channel) do update set updated_at=clock_timestamp() returning id into c;
   insert into private.communication_messages(id,organization_id,conversation_id,contact_id,lead_id,channel,purpose,sender,recipient,subject,body,created_by) values(p_id,p_org,c,(p_data->>'contactId')::uuid,(p_data->>'leadId')::uuid,p_data->>'channel',p_data->>'purpose',case when p_data->>'channel'='email' then 'FreshNest <mock@example.test>' else '+15005550006' end,dest,btrim(p_data->>'subject'),btrim(p_data->>'body'),actor) returning * into m;
   perform private.communication_record(p_org,m.id,'draft_created');
  end if;
  return private.communication_json(m);
 elsif p_action in ('send','reconcile') then
  perform private.crm_keys(p_data,'{}');
  select * into m from private.communication_messages where organization_id=p_org and id=p_id for update;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
  if m.direction<>'outbound' then raise exception using errcode='42501',message='forbidden'; end if;
  if p_version is null then raise exception using errcode='22023',message='invalid_fields'; end if;
  if p_action='send' and m.state<>'draft' then
   -- Same exact approved version is an idempotent replay, never another job.
   if p_version=m.version-1 and m.authorized_by=actor then return private.communication_json(m); end if;
   raise exception using errcode='P0001',message='invalid_transition';
  end if;
  if m.version<>p_version then raise exception using errcode='P0001',message='version_conflict'; end if;
  if p_action='reconcile' then
   if m.state<>'attention' then raise exception using errcode='P0001',message='invalid_transition'; end if;
   update private.communication_jobs set state='pending',run_at=clock_timestamp(),attempts=0,generation=generation+1,lease_token=null,lease_expires_at=null where organization_id=p_org and message_id=m.id;
   perform private.communication_record(p_org,m.id,'reconciliation_requested');
   perform private.audit(p_org,'communications.reconciliation_requested:'||m.id::text);
   return private.communication_json(m);
  end if;
  if (select paused from private.communication_settings where organization_id=p_org) then raise exception using errcode='P0001',message='sending_paused'; end if;
  dest:=private.communication_eligible(p_org,m.contact_id,m.channel,m.recipient,m.purpose);
  if dest is not null then raise exception using errcode='P0001',message='recipient_ineligible'; end if;
  v_generation:=private.automation_admin_generation(p_org,actor);
  update private.communication_messages set state='queued',version=version+1,authorized_by=actor,authority_generation=v_generation,approved_at=clock_timestamp(),updated_at=clock_timestamp() where organization_id=p_org and id=m.id returning * into m;
  insert into private.communication_jobs(organization_id,message_id) values(p_org,m.id);
  perform private.communication_record(p_org,m.id,'send_requested');
  perform private.communication_record(p_org,m.id,'authorization_granted');
  perform private.communication_record(p_org,m.id,'queued');
  perform private.audit(p_org,'communications.send_authorized:'||m.id::text);
  return private.communication_json(m);
 end if;
 raise exception using errcode='22023',message='invalid_fields';
end $$;
create or replace function private.communication_read(p_org uuid,p_kind text,p_id uuid,p_query jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; rows jsonb; cursor_time timestamptz; cursor_id uuid; setting private.communication_settings; ids uuid[];
begin
 perform private.crm_context(p_org,'read');
 perform set_config('leadsfam.communication_org',p_org::text,true);
 if p_kind='inbound' then
  return private.inbound_read(p_org,p_query);
 elsif p_kind='settings' then
  perform private.crm_keys(p_query,'{}');
  select * into setting from private.communication_settings where organization_id=p_org;
  return jsonb_build_object('mode','mock','liveEnabled',false,'senderEmail','FreshNest <mock@example.test>','senderSms','+15005550006','paused',coalesce(setting.paused,true),'dailyLimit',coalesce(setting.daily_limit,100),'recipientDailyLimit',coalesce(setting.recipient_daily_limit,5),'channelDailyLimit',coalesce(setting.channel_daily_limit,100),'concurrentLimit',coalesce(setting.concurrent_limit,2),'requestsPerMinute',coalesce(setting.requests_per_minute,30),'maxAttempts',coalesce(setting.max_attempts,3),'attentionCount',(select count(*) from private.communication_jobs where organization_id=p_org and state='attention'),'queuedCount',(select count(*) from private.communication_jobs where organization_id=p_org and state in ('pending','claimed')));
 elsif p_kind='message' then
  perform private.crm_keys(p_query,'{}');
  select private.communication_json(m) into result from private.communication_messages m where organization_id=p_org and id=p_id;
  if result is null then raise exception using errcode='42501',message='not_found'; end if;
  return result;
 elsif p_kind='eligibility' then
  perform private.crm_keys(p_query,array['channel','recipient','purpose'],array['channel','recipient','purpose']);
  if not exists(select 1 from public.contacts where organization_id=p_org and id=p_id) then raise exception using errcode='42501',message='not_found'; end if;
  return jsonb_build_object('code',private.communication_eligible(p_org,p_id,p_query->>'channel',p_query->>'recipient',p_query->>'purpose'),'suppressed',exists(select 1 from private.communication_suppressions where organization_id=p_org and channel=p_query->>'channel' and recipient=p_query->>'recipient'),'permissions',coalesce((select jsonb_agg(to_jsonb(p)-array['id','organization_id','contact_id','actor_id','created_at']) from (select distinct on(channel,recipient,purpose) * from private.communication_permissions where organization_id=p_org and contact_id=p_id order by channel,recipient,purpose,created_at desc,id desc limit 12) p),'[]'));
 elsif p_kind='events' then
  perform private.crm_keys(p_query,array['cursor']);
  if not exists(select 1 from private.communication_messages where organization_id=p_org and id=p_id) then raise exception using errcode='42501',message='not_found'; end if;
  if p_query->>'cursor' is not null then
   if octet_length(p_query->>'cursor')>200 then raise exception using errcode='22023',message='invalid_fields'; end if;
   cursor_time:=((p_query->>'cursor')::jsonb->>0)::timestamptz; cursor_id:=((p_query->>'cursor')::jsonb->>1)::uuid;
   if cursor_time is null or cursor_id is null then raise exception using errcode='22023',message='invalid_fields'; end if;
  end if;
  select coalesce(jsonb_agg(to_jsonb(t)-array['organization_id','provider_event_id'] order by t.created_at,t.id),'[]') into rows from (select * from private.communication_events where organization_id=p_org and message_id=p_id and (cursor_time is null or (created_at,id)>(cursor_time,cursor_id)) order by created_at,id limit 101) t;
  return jsonb_build_object('items',rows-100,'next',case when jsonb_array_length(rows)>100 then jsonb_build_array(rows->99->>'created_at',rows->99->>'id')::text end);
 elsif p_kind in ('conversations','history') then
  perform private.crm_keys(p_query,array['cursor','contactId','leadId']);
  if p_query->>'cursor' is not null then
   if octet_length(p_query->>'cursor')>200 then raise exception using errcode='22023',message='invalid_fields'; end if;
   cursor_time:=((p_query->>'cursor')::jsonb->>0)::timestamptz;
   cursor_id:=((p_query->>'cursor')::jsonb->>1)::uuid;
   if cursor_time is null or cursor_id is null then raise exception using errcode='22023',message='invalid_fields'; end if;
  end if;
  if p_kind='conversations' then
   select coalesce(jsonb_agg(to_jsonb(t) order by t.updated_at desc,t.id desc),'[]') into rows from (
    select c.id,c.contact_id,c.lead_id,c.channel,c.state,c.updated_at,contact.display_name contact_name,lead.title lead_title from private.conversations c
    join public.contacts contact on contact.organization_id=c.organization_id and contact.id=c.contact_id
    left join public.leads lead on lead.organization_id=c.organization_id and lead.id=c.lead_id
    where c.organization_id=p_org and (p_query->>'contactId' is null or c.contact_id=(p_query->>'contactId')::uuid) and (p_query->>'leadId' is null or c.lead_id=(p_query->>'leadId')::uuid) and (cursor_time is null or (c.updated_at,c.id)<(cursor_time,cursor_id)) order by c.updated_at desc,c.id desc limit 51
   ) t;
   result:=jsonb_build_object('items',rows-50,'next',case when jsonb_array_length(rows)>50 then jsonb_build_array(rows->49->>'updated_at',rows->49->>'id')::text end);
  else
   if not exists(select 1 from private.conversations where organization_id=p_org and id=p_id) then raise exception using errcode='42501',message='not_found'; end if;
   select coalesce(jsonb_agg(private.communication_json(t) order by t.created_at,t.id),'[]') into rows from (select * from private.communication_messages where organization_id=p_org and conversation_id=p_id and (cursor_time is null or (created_at,id)>(cursor_time,cursor_id)) order by created_at,id limit 51) t;
   select array_agg((v->>'id')::uuid) into ids from jsonb_array_elements(rows-50) v;
   result:=jsonb_build_object('messages',rows-50,'next',case when jsonb_array_length(rows)>50 then jsonb_build_array(rows->49->>'created_at',rows->49->>'id')::text end,'events',coalesce((select jsonb_agg(to_jsonb(e)-array['organization_id','provider_event_id'] order by e.created_at,e.id) from (select * from private.communication_events where organization_id=p_org and message_id=any(ids) order by created_at,id limit 500) e),'[]'));
  end if;
  return result;
 end if;
 raise exception using errcode='22023',message='invalid_fields';
end $$;
create or replace function private.communication_prepare(p_job uuid,p_token uuid,p_generation integer) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job private.communication_jobs; m private.communication_messages; setting private.communication_settings; failure_code text; minute timestamptz:=date_trunc('minute',clock_timestamp()); day timestamptz:=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'; v_dimension text; budget integer; allowed integer; operation text;
begin
 select * into job from private.communication_jobs where id=p_job;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 perform private.automation_admin_generation(job.organization_id,null);
 perform set_config('leadsfam.communication_org',job.organization_id::text,true);
 perform pg_advisory_xact_lock(hashtextextended(job.organization_id::text||':communications',0));
 select * into job from private.communication_jobs where id=p_job for update;
 if p_token is null or job.state<>'claimed' or job.lease_token is distinct from p_token or p_generation is distinct from job.generation or job.lease_expires_at<=clock_timestamp() then raise exception using errcode='P0001',message='lease_lost'; end if;
 select * into m from private.communication_messages where organization_id=job.organization_id and id=job.message_id for update;
 if m.direction<>'outbound' then
  update private.communication_jobs set state='done',lease_token=null,lease_expires_at=null where id=job.id;
  perform private.communication_record(job.organization_id,m.id,'blocked','INBOUND_NOT_SENDABLE');
  return null;
 end if;
 select * into setting from private.communication_settings where organization_id=job.organization_id;
 if m.state in ('delivered','failed','bounced','suppressed') then
  update private.communication_jobs set state='done',lease_token=null,lease_expires_at=null where id=job.id;
  return null;
 end if;
 operation:=case when m.state in ('submitted','submitting','attention') then 'reconcile' else 'send' end;
 if operation='send' then
  if private.automation_admin_generation(m.organization_id,m.authorized_by) is distinct from m.authority_generation then failure_code:='AUTHORITY_REVOKED';
  else failure_code:=private.communication_eligible(m.organization_id,m.contact_id,m.channel,m.recipient,m.purpose); end if;
  if failure_code is not null then
   update private.communication_messages set state='suppressed',code=failure_code,updated_at=clock_timestamp() where organization_id=m.organization_id and id=m.id;
   update private.communication_jobs set state='done',lease_token=null,lease_expires_at=null where id=job.id;
   perform private.communication_record(m.organization_id,m.id,'suppressed',failure_code);
   return null;
  end if;
  if coalesce(setting.paused,true) then
   update private.communication_jobs set state='pending',run_at=clock_timestamp()+interval '5 seconds',lease_token=null,lease_expires_at=null where id=job.id;
   return null;
  end if;
  if (select count(*) from private.communication_messages where organization_id=m.organization_id and state='submitting')>=setting.concurrent_limit then
   update private.communication_jobs set state='pending',run_at=clock_timestamp()+interval '2 seconds',lease_token=null,lease_expires_at=null where id=job.id;
   return null;
  end if;
 end if;
 if job.attempts>=coalesce(setting.max_attempts,3) then
  update private.communication_messages set state=case when operation='reconcile' then 'attention' else 'failed' end,code='ATTEMPTS_EXHAUSTED',updated_at=clock_timestamp() where organization_id=m.organization_id and id=m.id;
  update private.communication_jobs set state=case when operation='reconcile' then 'attention' else 'done' end,lease_token=null,lease_expires_at=null where id=job.id;
  perform private.communication_record(m.organization_id,m.id,'attempts_exhausted','ATTEMPTS_EXHAUSTED');
  return null;
 end if;
 -- Fixed-window request reservations are authoritative across worker processes.
 insert into private.communication_budgets values(m.organization_id,minute,'requests',0) on conflict do nothing;
 select used into budget from private.communication_budgets where organization_id=m.organization_id and bucket=minute and communication_budgets.dimension='requests';
 if budget>=setting.requests_per_minute then
  update private.communication_jobs set state='pending',run_at=minute+interval '1 minute',lease_token=null,lease_expires_at=null where id=job.id;
  return null;
 end if;
 perform 1 from private.communication_provider_budget where provider='mock' for update;
 update private.communication_provider_budget set bucket=minute,used=0 where provider='mock' and bucket<>minute;
 if (select used from private.communication_provider_budget where provider='mock')>=60 then
  update private.communication_jobs set state='pending',run_at=minute+interval '1 minute',lease_token=null,lease_expires_at=null where id=job.id;
  return null;
 end if;
 if operation='send' and m.reserved_at is null then
  foreach v_dimension in array array['organization','channel:'||m.channel,'recipient:'||private.crm_fingerprint(to_jsonb(m.recipient))] loop
   allowed:=case when v_dimension='organization' then setting.daily_limit when v_dimension like 'channel:%' then setting.channel_daily_limit else setting.recipient_daily_limit end;
   insert into private.communication_budgets values(m.organization_id,day,v_dimension,0) on conflict do nothing;
   select used into budget from private.communication_budgets where organization_id=m.organization_id and bucket=day and communication_budgets.dimension=v_dimension;
   if budget>=allowed then failure_code:='DAILY_LIMIT'; exit; end if;
  end loop;
  if failure_code is not null then
   update private.communication_messages set state='suppressed',code=failure_code,updated_at=clock_timestamp() where organization_id=m.organization_id and id=m.id;
   update private.communication_jobs set state='done',lease_token=null,lease_expires_at=null where id=job.id;
   perform private.communication_record(m.organization_id,m.id,'suppressed',failure_code);
   return null;
  end if;
  update private.communication_budgets set used=used+1 where organization_id=m.organization_id and bucket=day and communication_budgets.dimension=any(array['organization','channel:'||m.channel,'recipient:'||private.crm_fingerprint(to_jsonb(m.recipient))]);
 end if;
 update private.communication_provider_budget set used=used+1 where provider='mock';
 update private.communication_budgets set used=used+1 where organization_id=m.organization_id and bucket=minute and communication_budgets.dimension='requests';
 update private.communication_jobs set attempts=attempts+1 where id=job.id;
 if operation='send' then
  update private.communication_messages set state='submitting',reserved_at=coalesce(reserved_at,clock_timestamp()),provider_message_id='mock:'||id::text,code=null,updated_at=clock_timestamp() where organization_id=m.organization_id and id=m.id returning * into m;
  perform private.communication_record(m.organization_id,m.id,'submission_started');
 elsif m.state='submitting' then
  update private.communication_messages set state='attention',code='SUBMISSION_UNKNOWN',updated_at=clock_timestamp() where organization_id=m.organization_id and id=m.id;
  perform private.communication_record(m.organization_id,m.id,'submission_unknown','SUBMISSION_UNKNOWN');
 end if;
 return jsonb_build_object('id',m.id,'channel',m.channel,'sender',m.sender,'recipient',m.recipient,'subject',m.subject,'body',m.body,'providerReference',m.provider_message_id,'operation',operation);
end $$;

grant create on schema private to leadsfam_automation,leadsfam_communications;
alter function private.integration_capability_immutable() owner to leadsfam_automation;
alter function private.inbound_context(text,boolean) owner to leadsfam_automation;
alter function private.inbound_authorize(text) owner to leadsfam_automation;
alter function private.inbound_ingest(text,jsonb) owner to leadsfam_communications;
alter function private.inbound_link(uuid,uuid,uuid,uuid,uuid) owner to leadsfam_communications;
alter function private.inbound_resolve(uuid,uuid,jsonb,uuid) owner to leadsfam_communications;
alter function private.inbound_read(uuid,jsonb) owner to leadsfam_communications;
alter function private.inbound_receipt_immutable() owner to leadsfam_communications;
alter function private.inbound_message_immutable() owner to leadsfam_communications;
alter function private.communication_outbound_job() owner to leadsfam_communications;
revoke create on schema private from leadsfam_automation,leadsfam_communications;
do $$ declare fn regprocedure;begin
 for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('integration_capability_immutable','inbound_context','inbound_authorize','inbound_ingest','inbound_link','inbound_resolve','inbound_read','inbound_receipt_immutable','inbound_message_immutable','communication_outbound_job') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_ingress,leadsfam_worker',fn);
 end loop;
end $$;
grant execute on function private.inbound_context(text,boolean) to leadsfam_communications;
grant execute on function private.inbound_authorize(text),private.inbound_ingest(text,jsonb) to leadsfam_ingress;
notify pgrst,'reload schema';

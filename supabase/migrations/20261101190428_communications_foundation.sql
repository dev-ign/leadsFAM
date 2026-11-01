-- Reviewed boundary: docs/architecture/phase-04.md. Additive; no CRM rewrite.
set lock_timeout='3s';
create role leadsfam_communications nologin nosuperuser nobypassrls noinherit;
grant leadsfam_communications to postgres with set true;
grant usage on schema public,private to leadsfam_communications;
grant execute on function private.crm_context(uuid,text),private.crm_keys(jsonb,text[],text[]),private.crm_fingerprint(jsonb),private.audit(uuid,text),private.automation_admin_generation(uuid,uuid) to leadsfam_communications;

create table private.communication_settings (
 organization_id uuid primary key references public.organizations(id), paused boolean not null default true,
 daily_limit integer not null default 100 check(daily_limit between 1 and 10000),
 recipient_daily_limit integer not null default 5 check(recipient_daily_limit between 1 and 100),
 channel_daily_limit integer not null default 100 check(channel_daily_limit between 1 and 10000),
 concurrent_limit integer not null default 2 check(concurrent_limit between 1 and 10),
 requests_per_minute integer not null default 30 check(requests_per_minute between 1 and 60),
 max_attempts integer not null default 3 check(max_attempts between 1 and 5)
);
create table private.conversations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 contact_id uuid not null, lead_id uuid, channel text not null check(channel in ('email','sms')),
 state text not null default 'draft', updated_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), unique nulls not distinct(organization_id,contact_id,lead_id,channel),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id)
);
create index conversation_history on private.conversations(organization_id,updated_at desc,id desc);
create index conversation_contact on private.conversations(organization_id,contact_id,updated_at desc,id desc);
create table private.communication_messages (
 id uuid primary key, organization_id uuid not null references public.organizations(id), conversation_id uuid not null,
 contact_id uuid not null, lead_id uuid, direction text not null default 'outbound' check(direction in ('outbound','inbound')),
 channel text not null check(channel in ('email','sms')), purpose text not null check(purpose in ('transactional','marketing')),
 sender text not null, recipient text not null check(char_length(recipient) between 3 and 254),
 subject text not null check(char_length(subject)<=200), body text not null check(char_length(btrim(body)) between 1 and 4000),
 state text not null default 'draft' check(state in ('draft','queued','submitting','submitted','delivered','failed','bounced','suppressed','attention')),
 version integer not null default 1 check(version>0), code text, provider text not null default 'mock' check(provider='mock'),
 provider_message_id text unique, created_by uuid not null, authorized_by uuid, authority_generation integer,
 reserved_at timestamptz, approved_at timestamptz, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), foreign key(organization_id,conversation_id) references private.conversations(organization_id,id),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id),
 foreign key(organization_id,created_by) references public.organization_memberships(organization_id,user_id),
 foreign key(organization_id,authorized_by) references public.organization_memberships(organization_id,user_id),
 check((channel='email' and subject<>'' and recipient ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') or (channel='sms' and subject='' and char_length(body)<=1600 and recipient ~ '^\+[1-9][0-9]{6,14}$'))
);
create index communication_message_history on private.communication_messages(organization_id,conversation_id,created_at,id);
create index communication_message_contact on private.communication_messages(organization_id,contact_id,created_at,id);
create table private.communication_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, message_id uuid not null,
 event text not null, code text, provider_event_id text unique, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,message_id) references private.communication_messages(organization_id,id)
);
create index communication_event_history on private.communication_events(organization_id,message_id,created_at,id);
create table private.communication_permissions (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, contact_id uuid not null,
 channel text not null check(channel in ('email','sms')), purpose text not null check(purpose in ('transactional','marketing')),
 recipient text not null check(char_length(recipient) between 3 and 254), status text not null check(status in ('granted','revoked')),
 source text not null check(char_length(btrim(source)) between 1 and 160), collected_at timestamptz not null,
 revoked_at timestamptz, jurisdiction text not null check(jurisdiction ~ '^[A-Z]{2}$'),
 policy_version text not null check(char_length(btrim(policy_version)) between 1 and 80), evidence text not null check(char_length(btrim(evidence)) between 1 and 200),
 actor_id uuid not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,actor_id) references public.organization_memberships(organization_id,user_id)
);
create index communication_permission_lookup on private.communication_permissions(organization_id,contact_id,channel,recipient,purpose,created_at desc,id desc);
create table private.communication_suppressions (
 organization_id uuid not null references public.organizations(id), channel text not null check(channel in ('email','sms')),
 recipient text not null check(char_length(recipient) between 3 and 254), reason text not null check(reason in ('administrative','opt_out','bounced','invalid')),
 created_at timestamptz not null default clock_timestamp(), primary key(organization_id,channel,recipient)
);
-- This is the transactional delivery outbox, using the Phase 03 lease protocol.
create table private.communication_jobs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, message_id uuid not null,
 state text not null default 'pending' check(state in ('pending','claimed','done','attention')),
 attempts integer not null default 0, generation integer not null default 0,
 lease_token uuid, lease_expires_at timestamptz, run_at timestamptz not null default clock_timestamp(),
 created_at timestamptz not null default clock_timestamp(), unique(organization_id,message_id),
 foreign key(organization_id,message_id) references private.communication_messages(organization_id,id)
);
create unique index communication_job_message on private.communication_jobs(message_id);
create index communication_due on private.communication_jobs(run_at,created_at,id) where state in ('pending','claimed');
create index communication_job_tenant on private.communication_jobs(organization_id,state);
create table private.communication_budgets (
 organization_id uuid not null references public.organizations(id), bucket timestamptz not null, dimension text not null,
 used integer not null default 0 check(used>=0), primary key(organization_id,bucket,dimension)
);
create table private.communication_provider_budget (
 provider text primary key check(provider='mock'), bucket timestamptz not null, used integer not null
);
insert into private.communication_provider_budget values('mock',date_trunc('minute',clock_timestamp()),0);

do $$ declare relation text; begin
 foreach relation in array array['communication_settings','conversations','communication_messages','communication_events','communication_permissions','communication_suppressions','communication_jobs','communication_budgets','communication_provider_budget'] loop
  execute format('alter table private.%I enable row level security',relation);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress',relation);
  execute format('grant select,insert,update on private.%I to leadsfam_communications',relation);
  if relation in ('communication_jobs','communication_provider_budget') then
   execute format('create policy communication_execution on private.%I to leadsfam_communications using(true) with check(true)',relation);
  else
   execute format('create policy communication_execution on private.%I to leadsfam_communications using(organization_id=nullif((select current_setting(''leadsfam.communication_org'',true)),'''')::uuid) with check(organization_id=nullif((select current_setting(''leadsfam.communication_org'',true)),'''')::uuid)',relation);
  end if;
 end loop;
 foreach relation in array array['contacts','contact_emails','contact_phones','leads'] loop
  execute format('grant select on public.%I to leadsfam_communications',relation);
  execute format('create policy communication_execution on public.%I to leadsfam_communications using(organization_id=nullif((select current_setting(''leadsfam.communication_org'',true)),'''')::uuid)',relation);
 end loop;
end $$;
revoke update on private.communication_events,private.communication_permissions from leadsfam_communications;
grant delete on private.communication_suppressions to leadsfam_communications;

create function private.communication_record(p_org uuid,p_message uuid,p_event text,p_code text default null,p_provider_event text default null) returns void language plpgsql volatile security invoker set search_path='' as $$
begin
 insert into private.communication_events(organization_id,message_id,event,code,provider_event_id) values(p_org,p_message,p_event,p_code,p_provider_event);
 update private.conversations c set updated_at=clock_timestamp(),state=m.state from private.communication_messages m where m.organization_id=p_org and m.id=p_message and c.organization_id=p_org and c.id=m.conversation_id;
end $$;
create function private.communication_json(p_message private.communication_messages) returns jsonb language sql immutable security invoker set search_path='' as $$
 select to_jsonb(p_message)-array['organization_id','created_by','authorized_by','authority_generation','reserved_at','approved_at']
$$;

create function private.communication_eligible(p_org uuid,p_contact uuid,p_channel text,p_recipient text,p_purpose text) returns text language plpgsql volatile security invoker set search_path='' as $$
declare permission private.communication_permissions;
begin
 if not exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and archived_at is null) then return 'CONTACT_UNAVAILABLE'; end if;
 if p_channel='email' then
  if not exists(select 1 from public.contact_emails where organization_id=p_org and contact_id=p_contact and normalized=p_recipient) then return 'RECIPIENT_CHANGED'; end if;
 elsif p_channel='sms' then
  if not exists(select 1 from public.contact_phones where organization_id=p_org and contact_id=p_contact and normalized=p_recipient) then return 'RECIPIENT_CHANGED'; end if;
 else return 'INVALID_CHANNEL'; end if;
 if exists(select 1 from private.communication_suppressions where organization_id=p_org and channel=p_channel and recipient=p_recipient) then return 'DESTINATION_SUPPRESSED'; end if;
 select * into permission from private.communication_permissions where organization_id=p_org and contact_id=p_contact and channel=p_channel and recipient=p_recipient and purpose=p_purpose order by created_at desc,id desc limit 1;
 if not found or permission.status<>'granted' or permission.revoked_at is not null then return 'CONSENT_REQUIRED'; end if;
 -- Policy v1 permits only explicit, evidenced synthetic/mock consent. No live legal inference.
 if permission.jurisdiction not in ('US','CA','GB','AU','NZ','IE','DE','FR') then return 'JURISDICTION_REVIEW_REQUIRED'; end if;
 return null;
end $$;

create function private.communication_manage(p_org uuid,p_action text,p_id uuid,p_version integer,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; m private.communication_messages; c uuid; v_generation integer; dest text; v_channel text; fingerprint jsonb;
begin
 actor:=private.crm_context(p_org,case when p_action='draft' then 'write' else 'manage' end);
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
 elsif p_action='draft' then
  perform private.crm_keys(p_data,array['id','contactId','leadId','channel','purpose','recipient','subject','body'],array['id','contactId','leadId','channel','purpose','recipient','subject','body']);
  if p_id is null or p_id is distinct from (p_data->>'id')::uuid then raise exception using errcode='22023',message='invalid_fields'; end if;
  if not exists(select 1 from public.contacts where organization_id=p_org and id=(p_data->>'contactId')::uuid and archived_at is null) or (p_data->>'leadId' is not null and not exists(select 1 from public.leads where organization_id=p_org and id=(p_data->>'leadId')::uuid and contact_id=(p_data->>'contactId')::uuid and archived_at is null)) then raise exception using errcode='42501',message='not_found'; end if;
  select * into m from private.communication_messages where organization_id=p_org and id=p_id for update;
  dest:=case when p_data->>'channel'='email' then lower(btrim(p_data->>'recipient')) else btrim(p_data->>'recipient') end;
  p_data:=p_data||jsonb_build_object('recipient',dest,'subject',btrim(p_data->>'subject'),'body',btrim(p_data->>'body'));
  if found then
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

create function private.communication_read(p_org uuid,p_kind text,p_id uuid,p_query jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; rows jsonb; cursor_time timestamptz; cursor_id uuid; setting private.communication_settings; ids uuid[];
begin
 perform private.crm_context(p_org,'read');
 perform set_config('leadsfam.communication_org',p_org::text,true);
 if p_kind='settings' then
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

create function private.communication_claim() returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job private.communication_jobs;
begin
 select * into job from private.communication_jobs where run_at<=clock_timestamp() and (state='pending' or (state='claimed' and lease_expires_at<=clock_timestamp())) order by run_at,created_at,id limit 1 for update skip locked;
 if not found then return null; end if;
 update private.communication_jobs set state='claimed',generation=generation+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '30 seconds' where id=job.id returning * into job;
 return jsonb_build_object('id',job.id,'token',job.lease_token,'generation',job.generation);
end $$;

create function private.communication_prepare(p_job uuid,p_token uuid,p_generation integer) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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

create function private.communication_finish(p_job uuid,p_token uuid,p_generation integer,p_result jsonb) returns void language plpgsql volatile security definer set search_path='' as $$
declare job private.communication_jobs; m private.communication_messages; outcome text; next_state text; failure text;
begin
 perform private.crm_keys(p_result,array['state','reference'],array['state','reference']);
 outcome:=p_result->>'state';
 if outcome is null or outcome not in ('accepted','delivered','failed','bounced','retryable','unknown') then raise exception using errcode='22023',message='invalid_fields'; end if;
 select * into job from private.communication_jobs where id=p_job for update;
 if not found or p_token is null or job.state<>'claimed' or job.lease_token is distinct from p_token or p_generation is distinct from job.generation or job.lease_expires_at<=clock_timestamp() then raise exception using errcode='P0001',message='lease_lost'; end if;
 perform set_config('leadsfam.communication_org',job.organization_id::text,true);
 select * into m from private.communication_messages where organization_id=job.organization_id and id=job.message_id for update;
 if p_result->>'reference' is null or p_result->>'reference' !~ '^mock:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' or p_result->>'reference' is distinct from m.provider_message_id then raise exception using errcode='22023',message='invalid_fields'; end if;
 if m.state in ('delivered','failed','bounced','suppressed') then
  update private.communication_jobs set state='done',lease_token=null,lease_expires_at=null where id=job.id;
  return;
 end if;
 if m.state not in ('submitting','submitted','attention') or (outcome='accepted' and m.state<>'submitting') then raise exception using errcode='22023',message='invalid_transition'; end if;
 next_state:=case outcome when 'accepted' then 'submitted' when 'unknown' then 'attention' when 'retryable' then 'queued' else outcome end;
 if outcome='retryable' and m.state<>'submitting' then next_state:='attention'; end if;
 failure:=case when next_state='attention' then 'SUBMISSION_UNKNOWN' when outcome='retryable' then 'PROVIDER_RETRYABLE' when outcome='failed' then 'PROVIDER_REJECTED' when outcome='bounced' then 'DESTINATION_BOUNCED' end;
 update private.communication_messages set state=next_state,code=failure,updated_at=clock_timestamp() where organization_id=m.organization_id and id=m.id;
 update private.communication_jobs set state=case when next_state='attention' then 'attention' when outcome in ('accepted','retryable') then 'pending' else 'done' end,run_at=clock_timestamp()+case when outcome='retryable' then make_interval(secs=>least(300,power(2,least(job.attempts,8))::integer)+floor(random()*3)::integer) else interval '2 seconds' end,lease_token=null,lease_expires_at=null where id=job.id;
 perform private.communication_record(m.organization_id,m.id,case when outcome='accepted' then 'provider_accepted' when outcome='retryable' then 'retry_scheduled' else next_state end,failure);
 if next_state='bounced' then
  insert into private.communication_suppressions values(m.organization_id,m.channel,m.recipient,'bounced',clock_timestamp()) on conflict do nothing;
 end if;
end $$;

create function private.communication_provider_event(p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job private.communication_jobs; m private.communication_messages; event_type text; event_identity text; event_minute timestamptz:=date_trunc('minute',clock_timestamp());
begin
 perform private.crm_keys(p_data,array['eventId','reference','channel','type'],array['eventId','reference','channel','type']);
 event_type:=p_data->>'type'; event_identity:=p_data->>'eventId';
 if event_type is null or event_type not in ('delivered','failed','bounced','opt_out','start') or event_identity is null or event_identity !~ '^[A-Za-z0-9:_-]{1,160}$' or p_data->>'reference' !~ '^mock:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then raise exception using errcode='22023',message='invalid_fields'; end if;
 -- Resolve ownership from the durable outbox, never a payload organization ID.
 select * into job from private.communication_jobs where message_id=substring(p_data->>'reference' from 6)::uuid;
 if not found then return jsonb_build_object('ok',true); end if;
 perform private.automation_admin_generation(job.organization_id,null);
 perform set_config('leadsfam.communication_org',job.organization_id::text,true);
 perform pg_advisory_xact_lock(hashtextextended(job.organization_id::text||':communications',0));
 select * into job from private.communication_jobs where communication_jobs.id=job.id for update;
 select * into m from private.communication_messages where organization_id=job.organization_id and id=job.message_id for update;
 if m.provider_message_id is distinct from p_data->>'reference' or m.channel is distinct from p_data->>'channel' then return jsonb_build_object('ok',true); end if;
 if exists(select 1 from private.communication_events where organization_id=m.organization_id and provider_event_id=event_identity) then return jsonb_build_object('ok',true); end if;
 -- Durable webhook admission cap; duplicate identities return before consuming it.
 insert into private.communication_budgets values(m.organization_id,event_minute,'webhooks',0) on conflict do nothing;
 if (select used from private.communication_budgets where organization_id=m.organization_id and bucket=event_minute and dimension='webhooks')>=120 then raise exception using errcode='P0001',message='rate_limited'; end if;
 update private.communication_budgets set used=used+1 where organization_id=m.organization_id and bucket=event_minute and dimension='webhooks';
 if event_type in ('opt_out','bounced') then
  insert into private.communication_suppressions values(m.organization_id,m.channel,m.recipient,event_type,clock_timestamp()) on conflict do nothing;
 end if;
 if event_type in ('delivered','failed','bounced') and m.state in ('submitting','submitted','attention') then
  update private.communication_messages set state=event_type,code=case when event_type='failed' then 'PROVIDER_REJECTED' when event_type='bounced' then 'DESTINATION_BOUNCED' end,updated_at=clock_timestamp() where organization_id=m.organization_id and id=m.id;
  update private.communication_jobs set state='done',generation=generation+1,lease_token=null,lease_expires_at=null where id=job.id;
 end if;
 perform private.communication_record(m.organization_id,m.id,'provider_'||event_type,null,event_identity);
 return jsonb_build_object('ok',true);
end $$;

-- Explicit ownership and closed ACLs, matching the Phase 03 privilege boundary.
grant create on schema private to leadsfam_communications;
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('communication_record','communication_json','communication_eligible','communication_manage','communication_read','communication_claim','communication_prepare','communication_finish','communication_provider_event') loop
  execute format('alter function %s owner to leadsfam_communications',fn.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress',fn.signature);
 end loop;
end $$;
revoke create on schema private from leadsfam_communications;
grant execute on function private.communication_claim(),private.communication_prepare(uuid,uuid,integer),private.communication_finish(uuid,uuid,integer,jsonb) to leadsfam_worker;
grant execute on function private.communication_provider_event(jsonb) to leadsfam_ingress;
create function public.communication_manage(p_org uuid,p_action text,p_id uuid default null,p_version integer default null,p_data jsonb default '{}') returns jsonb language sql volatile security invoker set search_path='' set statement_timeout='4s' as $$ select private.communication_manage(p_org,p_action,p_id,p_version,p_data) $$;
create function public.communication_read(p_org uuid,p_kind text,p_id uuid default null,p_query jsonb default '{}') returns jsonb language sql volatile security invoker set search_path='' set statement_timeout='4s' as $$ select private.communication_read(p_org,p_kind,p_id,p_query) $$;
revoke all on function public.communication_manage(uuid,text,uuid,integer,jsonb),public.communication_read(uuid,text,uuid,jsonb) from public,anon,service_role,leadsfam_runtime,leadsfam_worker,leadsfam_ingress;
grant execute on function public.communication_manage(uuid,text,uuid,integer,jsonb),public.communication_read(uuid,text,uuid,jsonb),private.communication_manage(uuid,text,uuid,integer,jsonb),private.communication_read(uuid,text,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';

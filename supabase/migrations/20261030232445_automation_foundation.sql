-- Phase 03 privilege review: docs/architecture/phase-03.md. Additive only.
set lock_timeout='3s';
create role leadsfam_automation nologin nosuperuser nobypassrls noinherit;
create role leadsfam_ingress login nosuperuser nobypassrls noinherit;
create role leadsfam_worker login nosuperuser nobypassrls noinherit;
grant leadsfam_automation to postgres with set true;
grant usage on schema private,public to leadsfam_automation;
grant usage on schema private to leadsfam_ingress,leadsfam_worker;

create table private.source_integrations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 type text not null default 'first_party' check(type='first_party'), name text not null check(char_length(btrim(name)) between 1 and 80),
 status text not null check(status in ('active','paused','revoked')), source_id uuid,
 credential_hash text not null check(credential_hash ~ '^[a-f0-9]{64}$'), expires_at timestamptz not null,
 created_by uuid not null, authorized_by uuid not null, authority_generation integer not null check(authority_generation>0),
 version integer not null default 1, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 quota_start timestamptz not null default clock_timestamp(), quota_count integer not null default 0,
 unique(organization_id,id), unique(credential_hash),
 foreign key(organization_id,source_id) references public.lead_sources(organization_id,id),
 foreign key(organization_id,created_by) references public.organization_memberships(organization_id,user_id),
 foreign key(organization_id,authorized_by) references public.organization_memberships(organization_id,user_id)
);
-- A distinct integration principal, never a synthetic human member.
alter table public.contacts alter column created_by drop not null;
alter table public.contacts add column created_by_integration uuid,
 add foreign key(organization_id,created_by_integration) references private.source_integrations(organization_id,id),
 add constraint contact_creator_principal check(num_nonnulls(created_by,created_by_integration)=1);
alter table public.leads alter column created_by drop not null;
alter table public.leads add column created_by_integration uuid,
 add foreign key(organization_id,created_by_integration) references private.source_integrations(organization_id,id),
 add constraint lead_creator_principal check(num_nonnulls(created_by,created_by_integration)=1);
alter table public.crm_activities alter column actor_id drop not null;
alter table public.crm_activities add column integration_id uuid,
 add foreign key(organization_id,integration_id) references private.source_integrations(organization_id,id),
 add constraint activity_actor_principal check(num_nonnulls(actor_id,integration_id)=1);
alter table public.crm_activities drop constraint crm_activities_event_check;
alter table public.crm_activities add constraint crm_activities_event_check check(event in ('contact.created','contact.updated','contact.archived','contact.restored','lead.created','lead.updated','lead.transitioned','lead.assigned','lead.archived','lead.restored','automation.activity'));
alter table public.lead_attributions drop constraint lead_attributions_channel_check;
alter table public.lead_attributions add constraint lead_attributions_channel_check check(channel in ('manual','csv','first_party'));

create table private.ingestion_receipts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, integration_id uuid not null,
 external_event_id text not null check(char_length(external_event_id) between 1 and 160),
 schema_version integer not null default 1 check(schema_version=1), fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 contact_id uuid not null, lead_id uuid not null, correlation_id uuid not null,
 created_at timestamptz not null default clock_timestamp(), unique(organization_id,id), unique(organization_id,integration_id,external_event_id),
 foreign key(organization_id,integration_id) references private.source_integrations(organization_id,id),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id)
);
create index ingestion_history on private.ingestion_receipts(organization_id,created_at desc,id desc);
create table private.ingestion_attempts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, integration_id uuid not null,
 external_event_id text not null check(char_length(external_event_id) between 1 and 160),
 receipt_id uuid, correlation_id uuid not null, fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 state text not null check(state in ('succeeded','replayed','rejected')), code text,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,integration_id) references private.source_integrations(organization_id,id),
 foreign key(organization_id,receipt_id) references private.ingestion_receipts(organization_id,id)
);
create index ingestion_attempt_identity on private.ingestion_attempts(organization_id,integration_id,external_event_id,created_at,id);
create index ingestion_attempt_history on private.ingestion_attempts(organization_id,created_at desc,id desc);
create table private.automation_workflows (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 name text not null check(char_length(btrim(name)) between 1 and 80), status text not null check(status in ('draft','active','paused')),
 version integer not null default 1 check(version>0), published_version integer,
 created_by uuid not null, updated_at timestamptz not null default clock_timestamp(), created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), foreign key(organization_id,created_by) references public.organization_memberships(organization_id,user_id)
);
create table private.automation_versions (
 organization_id uuid not null, workflow_id uuid not null, version integer not null,
 definition jsonb not null check(jsonb_typeof(definition)='object' and octet_length(definition::text)<=4096),
 published_by uuid not null, authority_generation integer not null, created_at timestamptz not null default clock_timestamp(),
 primary key(organization_id,workflow_id,version),
 foreign key(organization_id,workflow_id) references private.automation_workflows(organization_id,id),
 foreign key(organization_id,published_by) references public.organization_memberships(organization_id,user_id)
);
alter table private.automation_workflows add foreign key(organization_id,id,published_version) references private.automation_versions(organization_id,workflow_id,version) deferrable initially deferred;
create table private.domain_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, type text not null check(type='lead.created'), schema_version integer not null default 1 check(schema_version=1),
 subject_id uuid not null, actor_id uuid, integration_id uuid, correlation_id uuid not null, causation_id uuid,
 bindings jsonb not null check(jsonb_typeof(bindings)='array' and jsonb_array_length(bindings)<=25),
 occurred_at timestamptz not null default clock_timestamp(), completed_at timestamptz,
 unique(organization_id,id), unique(organization_id,type,subject_id),
 check(num_nonnulls(actor_id,integration_id)=1),
 foreign key(organization_id,subject_id) references public.leads(organization_id,id),
 foreign key(organization_id,integration_id) references private.source_integrations(organization_id,id),
 foreign key(organization_id,actor_id) references public.organization_memberships(organization_id,user_id)
);
create table private.automation_runs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, workflow_id uuid not null, workflow_version integer not null,
 event_id uuid not null, state text not null default 'queued' check(state in ('queued','succeeded','skipped','failed')),
 code text, started_at timestamptz, finished_at timestamptz, created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), unique(organization_id,workflow_id,event_id),
 foreign key(organization_id,workflow_id,workflow_version) references private.automation_versions(organization_id,workflow_id,version),
 foreign key(organization_id,event_id) references private.domain_events(organization_id,id)
);
create index automation_run_history on private.automation_runs(organization_id,created_at desc,id desc);
create table private.automation_jobs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, type text not null check(type in ('dispatch','workflow')), schema_version integer not null default 1 check(schema_version=1),
 event_id uuid not null, run_id uuid, state text not null default 'pending' check(state in ('pending','claimed','retryable','completed','failed_terminal')),
 run_at timestamptz not null default clock_timestamp(), attempts integer not null default 0 check(attempts between 0 and 5), max_attempts integer not null default 5 check(max_attempts between 1 and 5),
 lease_token uuid, generation integer not null default 0, lease_expires_at timestamptz, code text,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), unique(organization_id,type,event_id,run_id),
 check((type='dispatch' and run_id is null) or (type='workflow' and run_id is not null)),
 check((state='claimed' and lease_token is not null and lease_expires_at is not null) or (state<>'claimed' and lease_token is null and lease_expires_at is null)),
 foreign key(organization_id,event_id) references private.domain_events(organization_id,id),
 foreign key(organization_id,run_id) references private.automation_runs(organization_id,id)
);
create unique index automation_dispatch_identity on private.automation_jobs(organization_id,event_id) where type='dispatch';
create index automation_tenant_queue on private.automation_jobs(organization_id,state,created_at);
create index automation_due on private.automation_jobs(run_at,created_at,id) where state in ('pending','retryable','claimed');
create table private.automation_tool_executions (
 organization_id uuid not null, run_id uuid not null, step_id text not null,
 tool text not null check(tool='activities.create'), version integer not null default 1 check(version=1),
 fingerprint text not null, activity_id uuid not null, created_at timestamptz not null default clock_timestamp(),
 primary key(organization_id,run_id,step_id),
 foreign key(organization_id,run_id) references private.automation_runs(organization_id,id),
 foreign key(organization_id,activity_id) references public.crm_activities(organization_id,id)
);

-- Private tables are unavailable through the Data API. Only bounded entry
-- functions own queue-wide coordination; no LOGIN role has any table grant.
do $$ declare relation text; begin
 foreach relation in array array['source_integrations','ingestion_receipts','ingestion_attempts','automation_workflows','automation_versions','domain_events','automation_runs','automation_jobs','automation_tool_executions'] loop
  execute format('alter table private.%I enable row level security',relation);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_ingress,leadsfam_worker',relation);
  execute format('grant select,insert,update on private.%I to leadsfam_automation',relation);
  if relation in ('source_integrations','automation_jobs') then
   execute format('create policy automation_execution on private.%I to leadsfam_automation using(true) with check(true)',relation);
  else
   execute format('create policy automation_execution on private.%I to leadsfam_automation using(organization_id::text=(select current_setting(''leadsfam.automation_org'',true))) with check(organization_id::text=(select current_setting(''leadsfam.automation_org'',true)))',relation);
  end if;
 end loop;
 foreach relation in array array['contacts','contact_emails','contact_phones','leads','lead_attributions','crm_activities','lead_sources'] loop
  execute format('grant select on public.%I to leadsfam_automation',relation);
  execute format('create policy automation_execution on public.%I to leadsfam_automation using(organization_id::text=(select current_setting(''leadsfam.automation_org'',true))) with check(organization_id::text=(select current_setting(''leadsfam.automation_org'',true)))',relation);
 end loop;
end $$;
-- Row locking requires UPDATE on one column; identity triggers prevent changes.
grant update(id) on public.contacts,public.leads,public.lead_sources to leadsfam_automation;
grant insert on public.contacts,public.contact_emails,public.contact_phones,public.leads,public.lead_attributions,public.crm_activities to leadsfam_automation;
grant execute on function private.audit(uuid,text),private.crm_context(uuid,text),private.crm_keys(jsonb,text[],text[]),private.crm_fingerprint(jsonb),private.crm_validate_contact(jsonb),private.crm_matches(uuid,jsonb,uuid),private.crm_contact_json(uuid,uuid) to leadsfam_automation;

-- Narrow durable-delegation bridge: no JWT impersonation, Auth/session access,
-- or new privilege on the existing CRM role.
create function private.automation_admin_generation(p_org uuid,p_user uuid) returns integer language plpgsql volatile security definer set search_path='' as $$
declare generation integer;
begin
 perform set_config('lock_timeout','3s',true);
 perform 1 from public.organizations where id=p_org for share;
 select crm_assignment_generation into generation from public.organization_memberships where organization_id=p_org and user_id=p_user and revoked_at is null and role in ('owner','admin');
 return generation;
end $$;
grant create on schema private to leadsfam_policy;
alter function private.automation_admin_generation(uuid,uuid) owner to leadsfam_policy;
revoke create on schema private from leadsfam_policy;
revoke all on function private.automation_admin_generation(uuid,uuid) from public,anon,authenticated,service_role,leadsfam_runtime;
grant execute on function private.automation_admin_generation(uuid,uuid) to leadsfam_automation;

create function private.automation_validate(p_definition jsonb) returns void language plpgsql security invoker set search_path='' as $$
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
  if jsonb_typeof(item->'id')<>'string' or jsonb_typeof(item->'tool')<>'string' or item->>'id' !~ '^[a-zA-Z0-9_-]{1,40}$' or item->>'tool'<>'activities.create' or item->'version'<>'1'::jsonb or jsonb_typeof(item->'arguments'->'message')<>'string' or char_length(btrim(item->'arguments'->>'message')) not between 1 and 300 then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
end $$;

create function private.automation_manage(p_org uuid,p_kind text,p_action text,p_id uuid,p_version integer,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
   perform private.crm_keys(p_data,array['name','sourceId','credentialHash'],array['name','credentialHash']);
   if (select count(*) from private.source_integrations where organization_id=p_org)>=25 then raise exception using errcode='22023',message='resource_limit'; end if;
   if p_data->>'credentialHash' !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='invalid_fields'; end if;
   if p_data->>'sourceId' is not null and not exists(select 1 from public.lead_sources where organization_id=p_org and id=(p_data->>'sourceId')::uuid and archived_at is null) then raise exception using errcode='42501',message='not_found'; end if;
   insert into private.source_integrations(organization_id,name,status,source_id,credential_hash,expires_at,created_by,authorized_by,authority_generation) values(p_org,p_data->>'name','active',(p_data->>'sourceId')::uuid,p_data->>'credentialHash',clock_timestamp()+interval '90 days',actor,actor,authorizer_generation) returning * into integration;
  else
   select * into integration from private.source_integrations where organization_id=p_org and id=p_id for update;
   if not found then raise exception using errcode='42501',message='not_found'; end if;
   if p_version is null or p_version<>integration.version then raise exception using errcode='P0001',message='version_conflict'; end if;
   if integration.status='revoked' then raise exception using errcode='22023',message='invalid_transition'; end if;
   if p_action='rotate' then
    perform private.crm_keys(p_data,array['credentialHash'],array['credentialHash']);
    update private.source_integrations set credential_hash=p_data->>'credentialHash',expires_at=clock_timestamp()+interval '90 days',authorized_by=actor,authority_generation=authorizer_generation,version=version+1,updated_at=clock_timestamp() where id=p_id returning * into integration;
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

create function private.automation_overview(p_org uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.crm_context(p_org,'manage');
 perform set_config('leadsfam.automation_org',p_org::text,true);
 select jsonb_build_object(
  'integrations',coalesce((select jsonb_agg(to_jsonb(i)-array['credential_hash','quota_start','quota_count','authority_generation'] order by i.created_at desc) from private.source_integrations i where organization_id=p_org),'[]'),
  'workflows',coalesce((select jsonb_agg(to_jsonb(w)||jsonb_build_object('definition',v.definition) order by w.created_at desc) from private.automation_workflows w join private.automation_versions v on v.organization_id=w.organization_id and v.workflow_id=w.id and v.version=w.version where w.organization_id=p_org),'[]'),
  'receipts',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id desc) from (select id,integration_id,external_event_id,contact_id,lead_id,correlation_id,created_at from private.ingestion_receipts where organization_id=p_org order by created_at desc,id desc limit 25) r),'[]'),
  'jobs',coalesce((select jsonb_agg(to_jsonb(j) order by j.created_at desc,j.id desc) from (select j.id,j.type,j.state,j.generation,j.attempts,j.code,j.run_at,j.created_at,e.correlation_id from private.automation_jobs j join private.domain_events e on e.organization_id=j.organization_id and e.id=j.event_id where j.organization_id=p_org and j.state<>'completed' order by j.created_at desc,j.id desc limit 25) j),'[]'),
  'attempts',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc) from (select id,integration_id,external_event_id,receipt_id,correlation_id,state,code,created_at from private.ingestion_attempts where organization_id=p_org order by created_at desc,id desc limit 25) a),'[]'),
  'runs',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id desc) from (select r.id,r.workflow_id,r.workflow_version,r.event_id,r.state,r.code,r.started_at,r.finished_at,r.created_at,j.id job_id,j.state job_state,j.attempts,j.run_at,e.subject_id lead_id,e.correlation_id,(select count(*) from private.automation_tool_executions t where t.organization_id=r.organization_id and t.run_id=r.id)::integer completed_steps from private.automation_runs r join private.domain_events e on e.organization_id=r.organization_id and e.id=r.event_id join private.automation_jobs j on j.organization_id=r.organization_id and j.run_id=r.id where r.organization_id=p_org order by r.created_at desc,r.id desc limit 25) r),'[]'),
  'queue',jsonb_build_object('pending',(select count(*) from private.automation_jobs where organization_id=p_org and state in ('pending','retryable','claimed')),'failed',(select count(*) from private.automation_jobs where organization_id=p_org and state='failed_terminal'),'oldestPendingAt',(select min(created_at) from private.automation_jobs where organization_id=p_org and state in ('pending','retryable','claimed')))
 ) into result;
 return result;
end $$;

-- Minimal outbox envelope. Snapshot supported published revisions at occurrence,
-- before asynchronous dispatch, including manual/CSV intake. No contact content.
create function private.automation_lead_event() returns trigger language plpgsql security definer set search_path='' as $$
declare target public.leads; event_id uuid; bindings jsonb; correlation uuid;
begin
 perform set_config('leadsfam.automation_org',new.organization_id::text,true);
 select * into target from public.leads where organization_id=new.organization_id and id=new.lead_id;
 select coalesce(jsonb_agg(jsonb_build_object('workflowId',id,'version',published_version)),'[]') into bindings from private.automation_workflows where organization_id=new.organization_id and status='active';
 correlation:=coalesce(nullif(current_setting('leadsfam.ingestion_correlation',true),'')::uuid,gen_random_uuid());
 insert into private.domain_events(organization_id,type,subject_id,actor_id,integration_id,correlation_id,causation_id,bindings)
 values(new.organization_id,'lead.created',new.lead_id,target.created_by,target.created_by_integration,correlation,nullif(current_setting('leadsfam.ingestion_receipt',true),'')::uuid,bindings) returning id into event_id;
 if jsonb_array_length(bindings)>0 then
  insert into private.automation_jobs(organization_id,type,event_id) values(new.organization_id,'dispatch',event_id);
 else update private.domain_events set completed_at=clock_timestamp() where id=event_id; end if;
 return new;
end $$;
create trigger automation_lead_event after insert on public.lead_attributions for each row execute function private.automation_lead_event();

create function private.ingest_lead(p_hash text,p_data jsonb,p_correlation uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare integration private.source_integrations; receipt private.ingestion_receipts; fingerprint text; data jsonb; contact uuid; lead uuid; item jsonb; receipt_id uuid:=gen_random_uuid(); failure_code text; sql_code text; prior_fingerprint text;
begin
 perform set_config('lock_timeout','3s',true);
 select * into integration from private.source_integrations where credential_hash=p_hash;
 if not found then raise exception using errcode='42501',message='credentials_rejected'; end if;
 if private.automation_admin_generation(integration.organization_id,integration.authorized_by) is distinct from integration.authority_generation then raise exception using errcode='42501',message='credentials_rejected'; end if;
 select * into integration from private.source_integrations where id=integration.id and credential_hash=p_hash for update;
 if not found or integration.status<>'active' or integration.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='credentials_rejected'; end if;
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

create function private.automation_claim() returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job private.automation_jobs;
begin
 -- A crashed final attempt is terminal, never left permanently claimed.
 for job in select * from private.automation_jobs where state='claimed' and lease_expires_at<=clock_timestamp() and attempts>=max_attempts order by run_at,id limit 10 for update skip locked loop
  perform set_config('leadsfam.automation_org',job.organization_id::text,true);
  update private.automation_jobs set state='failed_terminal',code='ATTEMPTS_EXHAUSTED',lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where id=job.id;
  if job.run_id is not null then update private.automation_runs set state='failed',code='ATTEMPTS_EXHAUSTED',finished_at=clock_timestamp() where id=job.run_id; end if;
 end loop;
 select * into job from private.automation_jobs where run_at<=clock_timestamp() and attempts<max_attempts and (state in ('pending','retryable') or (state='claimed' and lease_expires_at<=clock_timestamp())) order by run_at,created_at,id limit 1 for update skip locked;
 if not found then return null; end if;
 update private.automation_jobs set state='claimed',attempts=attempts+1,generation=generation+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() where id=job.id returning * into job;
 return jsonb_build_object('id',job.id,'type',job.type,'schemaVersion',job.schema_version,'token',job.lease_token,'generation',job.generation,'leaseExpiresAt',job.lease_expires_at);
end $$;

create function private.automation_execute(p_job uuid,p_token uuid,p_generation integer) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
      -- Internal action through the existing append-only CRM activity model.
      insert into public.crm_activities(organization_id,lead_id,actor_id,event,details,request_id) values(job.organization_id,lead.id,revision.published_by,'automation.activity',jsonb_build_object('message',item->'arguments'->>'message','runId',run.id,'workflowId',workflow.id),event.correlation_id::text) returning id into activity;
      insert into private.automation_tool_executions(organization_id,run_id,step_id,tool,fingerprint,activity_id) values(job.organization_id,run.id,item->>'id','activities.create',private.crm_fingerprint(item),activity);
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

-- Preserve creator identity even when human edits an integration-created record.
create function private.automation_creator_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.created_by_integration is distinct from old.created_by_integration then raise exception using errcode='23514',message='immutable_identity'; end if;
 return new;
end $$;
create trigger automation_creator_immutable before update on public.contacts for each row execute function private.automation_creator_immutable();
create trigger automation_creator_immutable before update on public.leads for each row execute function private.automation_creator_immutable();
-- Immutable ledgers have no UPDATE privilege, independently of entry functions.
revoke update on private.ingestion_receipts,private.ingestion_attempts,private.automation_versions,private.automation_tool_executions from leadsfam_automation;

grant create on schema private to leadsfam_automation;
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('automation_validate','automation_manage','automation_overview','automation_lead_event','ingest_lead','automation_claim','automation_execute','automation_creator_immutable') loop
  execute format('alter function %s owner to leadsfam_automation',fn.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,leadsfam_runtime,leadsfam_ingress,leadsfam_worker',fn.signature);
 end loop;
end $$;
revoke create on schema private from leadsfam_automation;
grant execute on function private.ingest_lead(text,jsonb,uuid) to leadsfam_ingress;
grant execute on function private.automation_claim(),private.automation_execute(uuid,uuid,integer) to leadsfam_worker;
create function public.automation_manage(p_org uuid,p_kind text,p_action text,p_id uuid default null,p_version integer default null,p_data jsonb default '{}') returns jsonb language sql volatile security invoker set search_path='' as $$ select private.automation_manage(p_org,p_kind,p_action,p_id,p_version,p_data) $$;
create function public.automation_overview(p_org uuid) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.automation_overview(p_org) $$;
revoke all on function public.automation_manage(uuid,text,text,uuid,integer,jsonb),public.automation_overview(uuid) from public,anon,service_role,leadsfam_runtime,leadsfam_ingress,leadsfam_worker;
grant execute on function public.automation_manage(uuid,text,text,uuid,integer,jsonb),public.automation_overview(uuid),private.automation_manage(uuid,text,text,uuid,integer,jsonb),private.automation_overview(uuid) to authenticated;
notify pgrst,'reload schema';

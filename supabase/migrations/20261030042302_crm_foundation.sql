-- ADR 0010 was reviewed before applying this additive migration.
create role leadsfam_crm nologin nosuperuser nobypassrls noinherit;
grant leadsfam_crm to postgres with set true;
grant usage on schema public, private to leadsfam_crm;

alter table public.organization_memberships add column crm_assignment_generation integer not null default 1 check(crm_assignment_generation>0);
create function private.crm_membership_generation() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if (old.revoked_at is null) is distinct from (new.revoked_at is null) then
  new.crm_assignment_generation:=old.crm_assignment_generation+1;
 else new.crm_assignment_generation:=old.crm_assignment_generation;
 end if;
 return new;
end $$;
revoke all on function private.crm_membership_generation() from public,anon,authenticated,service_role,leadsfam_runtime;
create trigger crm_membership_generation before update on public.organization_memberships for each row execute function private.crm_membership_generation();

create table public.contacts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 kind text not null check(kind in ('person','company')),
 display_name text not null check(char_length(btrim(display_name)) between 1 and 160),
 first_name text not null default '' check(char_length(first_name)<=80),
 last_name text not null default '' check(char_length(last_name)<=80),
 company_name text not null default '' check(char_length(company_name)<=160),
 version integer not null default 1 check(version>0), archived_at timestamptz,
 created_by uuid not null, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id),
 foreign key(organization_id,created_by) references public.organization_memberships(organization_id,user_id),
 check(kind<>'company' or char_length(btrim(company_name))>0)
);
create table public.contact_emails (
 organization_id uuid not null, contact_id uuid not null, position smallint not null check(position between 1 and 3),
 value text not null check(char_length(value) between 3 and 254),
 normalized text not null check(char_length(normalized) between 3 and 254 and normalized=lower(btrim(value)) and normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 primary key(organization_id,contact_id,position), unique(organization_id,contact_id,normalized),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id)
);
create index contact_emails_match_idx on public.contact_emails(organization_id,normalized,contact_id);
create table public.contact_phones (
 organization_id uuid not null, contact_id uuid not null, position smallint not null check(position between 1 and 3),
 value text not null check(char_length(btrim(value)) between 1 and 40),
 normalized text check(normalized ~ '^\+[1-9][0-9]{6,14}$'),
 primary key(organization_id,contact_id,position), unique(organization_id,contact_id,normalized),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id)
);
create index contact_phones_match_idx on public.contact_phones(organization_id,normalized,contact_id) where normalized is not null;
create table public.lead_sources (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 name text not null check(char_length(btrim(name)) between 1 and 80),
 version integer not null default 1 check(version>0), archived_at timestamptz,
 created_by uuid not null, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), foreign key(organization_id,created_by) references public.organization_memberships(organization_id,user_id)
);
create unique index lead_sources_name_idx on public.lead_sources(organization_id,lower(btrim(name)));
create table public.leads (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), contact_id uuid not null,
 title text not null check(char_length(btrim(title)) between 1 and 160), description text not null default '' check(char_length(description)<=4000),
 priority text not null default 'normal' check(priority in ('low','normal','high')),
 status text not null default 'new' check(status in ('new','in_progress','qualified','closed')),
 outcome text check(outcome in ('won','lost','unqualified')), closed_at timestamptz,
 last_assigned_user_id uuid, assigned_membership_generation integer,
 version integer not null default 1 check(version>0), archived_at timestamptz,
 created_by uuid not null, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 last_activity_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,created_by) references public.organization_memberships(organization_id,user_id),
 foreign key(organization_id,last_assigned_user_id) references public.organization_memberships(organization_id,user_id),
 check((status='closed' and outcome is not null and closed_at is not null) or (status<>'closed' and outcome is null and closed_at is null)),
 check((last_assigned_user_id is null and assigned_membership_generation is null) or (last_assigned_user_id is not null and assigned_membership_generation>0))
);
create index leads_created_idx on public.leads(organization_id,created_at desc,id desc);
create index leads_activity_idx on public.leads(organization_id,last_activity_at desc,id desc);
create index leads_status_idx on public.leads(organization_id,status,created_at desc,id desc) where archived_at is null;
create index leads_contact_idx on public.leads(organization_id,contact_id,created_at,id);
create index leads_assignment_idx on public.leads(organization_id,last_assigned_user_id,assigned_membership_generation);
create index contacts_created_idx on public.contacts(organization_id,created_at desc,id desc);
create table public.lead_attributions (
 organization_id uuid not null, lead_id uuid not null, source_id uuid,
 channel text not null check(channel in ('manual','csv')),
 provider text check(char_length(provider)<=80), external_reference text check(char_length(external_reference)<=160),
 campaign text check(char_length(campaign)<=160), utm_source text check(char_length(utm_source)<=160), utm_medium text check(char_length(utm_medium)<=160),
 landing_url text check(char_length(landing_url)<=2048 and landing_url ~ '^https?://[^/?#[:space:]]+(/[^?#[:space:]]*)?$'),
 claimed_acquired_at timestamptz, accepted_at timestamptz not null default clock_timestamp(),
 primary key(organization_id,lead_id),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id),
 foreign key(organization_id,source_id) references public.lead_sources(organization_id,id)
);
create index lead_attributions_source_idx on public.lead_attributions(organization_id,source_id,lead_id);
create table public.crm_activities (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 lead_id uuid, contact_id uuid, actor_id uuid not null,
 event text not null check(event in ('contact.created','contact.updated','contact.archived','contact.restored','lead.created','lead.updated','lead.transitioned','lead.assigned','lead.archived','lead.restored')),
 details jsonb not null default '{}' check(jsonb_typeof(details)='object' and octet_length(details::text)<=1024),
 request_id text check(char_length(request_id)<=80), created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), check(num_nonnulls(lead_id,contact_id)=1),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,actor_id) references public.organization_memberships(organization_id,user_id)
);
create index crm_activity_lead_idx on public.crm_activities(organization_id,lead_id,created_at desc,id desc) where lead_id is not null;
create index crm_activity_contact_idx on public.crm_activities(organization_id,contact_id,created_at desc,id desc) where contact_id is not null;

-- Durable metadata contains fingerprints/IDs/safe codes, never raw input rows.
create table private.crm_request_receipts (
 organization_id uuid not null references public.organizations(id), operation text not null check(operation in ('contact_create','lead_intake')),
 namespace text not null check(namespace in ('manual','csv')), request_key uuid not null,
 fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'), contact_id uuid not null, lead_id uuid,
 created_at timestamptz not null default clock_timestamp(),
 primary key(organization_id,operation,namespace,request_key),
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id)
);
create table private.lead_import_jobs (
 organization_id uuid not null references public.organizations(id), id uuid not null,
 created_by uuid not null, created_at timestamptz not null default clock_timestamp(),
 primary key(organization_id,id),
 foreign key(organization_id,created_by) references public.organization_memberships(organization_id,user_id)
);
create table private.lead_import_attempts (
 organization_id uuid not null, job_id uuid not null, id uuid not null,
 fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='array' and jsonb_array_length(result)<=100),
 created_by uuid not null, created_at timestamptz not null default clock_timestamp(),
 primary key(organization_id,job_id,id),
 foreign key(organization_id,job_id) references private.lead_import_jobs(organization_id,id),
 foreign key(organization_id,created_by) references public.organization_memberships(organization_id,user_id)
);
create table private.lead_import_rows (
 organization_id uuid not null, job_id uuid not null, delivery_id uuid not null, row_number integer not null check(row_number between 1 and 100),
 fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'), contact_id uuid not null, lead_id uuid not null,
 attempt_id uuid not null, created_at timestamptz not null default clock_timestamp(),
 primary key(organization_id,job_id,delivery_id),
 foreign key(organization_id,job_id) references private.lead_import_jobs(organization_id,id),
 foreign key(organization_id,job_id,attempt_id) references private.lead_import_attempts(organization_id,job_id,id) deferrable initially deferred,
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id),
 foreign key(organization_id,lead_id) references public.leads(organization_id,id)
);

create function private.crm_context(p_org uuid,p_permission text) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare caller_role text;
begin
 perform set_config('lock_timeout','3s',true);
 if p_permission not in ('read','write','manage','import') or p_permission is null then raise exception using errcode='42501',message='forbidden'; end if;
 caller_role:=private.authorize_org(p_org,'read',false);
 if p_permission in ('manage','import') and caller_role not in ('owner','admin') then raise exception using errcode='42501',message='forbidden'; end if;
 perform set_config('leadsfam.organization_id',p_org::text,true);
 return auth.uid();
end $$;
grant create on schema private to leadsfam_policy;
alter function private.crm_context(uuid,text) owner to leadsfam_policy;
revoke all on function private.crm_context(uuid,text) from public,anon,authenticated,service_role,leadsfam_runtime;
grant execute on function private.crm_context(uuid,text),private.member_role(uuid) to leadsfam_crm;

do $$ declare relation text; begin
 foreach relation in array array['contacts','contact_emails','contact_phones','lead_sources','leads','lead_attributions','crm_activities'] loop
  execute format('alter table public.%I enable row level security',relation);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role,leadsfam_runtime',relation);
  execute format('grant select on public.%I to authenticated,leadsfam_crm',relation);
  execute format('create policy crm_member_read on public.%I for select to authenticated using(private.member_role(organization_id) is not null)',relation);
  execute format('create policy crm_execution on public.%I to leadsfam_crm using(organization_id::text=current_setting(''leadsfam.organization_id'',true) and private.member_role(organization_id) is not null) with check(organization_id::text=current_setting(''leadsfam.organization_id'',true) and private.member_role(organization_id) is not null)',relation);
 end loop;
 foreach relation in array array['crm_request_receipts','lead_import_jobs','lead_import_attempts','lead_import_rows'] loop
  execute format('alter table private.%I enable row level security',relation);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,leadsfam_runtime',relation);
  execute format('grant select,insert on private.%I to leadsfam_crm',relation);
  execute format('create policy crm_execution on private.%I to leadsfam_crm using(organization_id::text=current_setting(''leadsfam.organization_id'',true) and private.member_role(organization_id) %s) with check(organization_id::text=current_setting(''leadsfam.organization_id'',true) and private.member_role(organization_id) %s)',relation,case when relation='crm_request_receipts' then 'is not null' else 'in (''owner'',''admin'')' end,case when relation='crm_request_receipts' then 'is not null' else 'in (''owner'',''admin'')' end);
 end loop;
end $$;
grant insert,update on public.contacts,public.leads,public.lead_sources to leadsfam_crm;
grant insert,delete on public.contact_emails,public.contact_phones to leadsfam_crm;
grant insert on public.lead_attributions,public.crm_activities to leadsfam_crm;

create function private.crm_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' or tg_table_name in ('lead_attributions','crm_activities','crm_request_receipts','lead_import_jobs','lead_import_attempts','lead_import_rows') then raise exception using errcode='23514',message='immutable_record'; end if;
 if new.organization_id is distinct from old.organization_id or new.id is distinct from old.id or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then raise exception using errcode='23514',message='immutable_identity'; end if;
 if new.version<>old.version+1 then raise exception using errcode='23514',message='version_required'; end if;
 new.updated_at:=clock_timestamp();
 if tg_table_name='leads' then
  if new.contact_id<>old.contact_id then raise exception using errcode='23514',message='immutable_contact'; end if;
  if old.status='closed' and new.status not in ('closed','in_progress') then raise exception using errcode='23514',message='invalid_transition'; end if;
  if old.status<>'new' and new.status='new' then raise exception using errcode='23514',message='invalid_transition'; end if;
  new.last_activity_at:=new.updated_at;
 end if;
 return new;
end $$;
revoke all on function private.crm_immutable() from public,anon,authenticated,service_role,leadsfam_runtime;
do $$ declare relation text; begin
 foreach relation in array array['contacts','leads','lead_sources','lead_attributions','crm_activities'] loop
  execute format('create trigger crm_immutable before update or delete on public.%I for each row execute function private.crm_immutable()',relation);
 end loop;
 foreach relation in array array['crm_request_receipts','lead_import_jobs','lead_import_attempts','lead_import_rows'] loop
  execute format('create trigger crm_immutable before update or delete on private.%I for each row execute function private.crm_immutable()',relation);
 end loop;
end $$;

create function private.crm_channel_positions() returns trigger language plpgsql security invoker set search_path='' as $$
declare org uuid; contact uuid; invalid boolean;
begin
 if tg_op='DELETE' then org:=old.organization_id; contact:=old.contact_id; else org:=new.organization_id; contact:=new.contact_id; end if;
 if tg_table_name='contact_emails' then select count(*)<>coalesce(max(position),0) into invalid from public.contact_emails where organization_id=org and contact_id=contact;
 else select count(*)<>coalesce(max(position),0) into invalid from public.contact_phones where organization_id=org and contact_id=contact; end if;
 if invalid then raise exception using errcode='23514',message='invalid_channel_positions'; end if;
 return null;
end $$;
revoke all on function private.crm_channel_positions() from public,anon,authenticated,service_role,leadsfam_runtime;
create constraint trigger crm_email_positions after insert or update or delete on public.contact_emails deferrable initially deferred for each row execute function private.crm_channel_positions();
create constraint trigger crm_phone_positions after insert or update or delete on public.contact_phones deferrable initially deferred for each row execute function private.crm_channel_positions();

-- Bounded eligibility lookup: no membership-table privilege is delegated to CRM.
create function private.crm_member_generation(p_org uuid,p_user uuid) returns integer language sql volatile security definer set search_path='' as $$
 select crm_assignment_generation from public.organization_memberships where organization_id=p_org and user_id=p_user and revoked_at is null and private.member_role(p_org) is not null
$$;
alter function private.crm_member_generation(uuid,uuid) owner to leadsfam_policy;
revoke all on function private.crm_member_generation(uuid,uuid) from public,anon,authenticated,service_role,leadsfam_runtime;
grant execute on function private.crm_member_generation(uuid,uuid) to leadsfam_crm;
revoke create on schema private from leadsfam_policy;

create function private.crm_keys(p_data jsonb,p_allowed text[],p_required text[] default '{}') returns void language plpgsql security invoker set search_path='' as $$
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or exists(select 1 from jsonb_object_keys(p_data) k where k<>all(p_allowed)) or not p_data ?& p_required then raise exception using errcode='22023',message='invalid_fields'; end if;
end $$;
create function private.crm_contact_json(p_org uuid,p_id uuid) returns jsonb language sql volatile security invoker set search_path='' as $$
 select to_jsonb(c)||jsonb_build_object(
 'emails',coalesce((select jsonb_agg(jsonb_build_object('value',e.value,'normalized',e.normalized) order by e.position) from public.contact_emails e where e.organization_id=c.organization_id and e.contact_id=c.id),'[]'::jsonb),
 'phones',coalesce((select jsonb_agg(jsonb_build_object('value',p.value,'normalized',p.normalized) order by p.position) from public.contact_phones p where p.organization_id=c.organization_id and p.contact_id=c.id),'[]'::jsonb))
 from public.contacts c where c.organization_id=p_org and c.id=p_id
$$;
create function private.crm_lead_json(p_org uuid,p_id uuid) returns jsonb language sql volatile security invoker set search_path='' as $$
 select to_jsonb(l)||jsonb_build_object('contact',private.crm_contact_json(l.organization_id,l.contact_id),'current_assignee_id',case when private.crm_member_generation(l.organization_id,l.last_assigned_user_id)=l.assigned_membership_generation then l.last_assigned_user_id else null end,'attribution',(select to_jsonb(a) from public.lead_attributions a where a.organization_id=l.organization_id and a.lead_id=l.id))
 from public.leads l where l.organization_id=p_org and l.id=p_id
$$;
create function private.crm_event(p_org uuid,p_actor uuid,p_lead uuid,p_contact uuid,p_event text,p_details jsonb default '{}') returns void language sql security invoker set search_path='' as $$
 insert into public.crm_activities(organization_id,actor_id,lead_id,contact_id,event,details,request_id) values(p_org,p_actor,p_lead,p_contact,p_event,p_details,left(nullif(current_setting('request.headers',true),'')::jsonb->>'x-request-id',80))
$$;
create function private.crm_get(p_org uuid,p_kind text,p_id uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.crm_context(p_org,'read');
 if p_kind='contact' then result:=private.crm_contact_json(p_org,p_id);
 elsif p_kind='lead' then result:=private.crm_lead_json(p_org,p_id);
 else raise exception using errcode='22023',message='invalid_kind'; end if;
 if result is null then raise exception using errcode='42501',message='not_found'; end if;
 return result;
end $$;

-- Only implementations may append activities or format records. No arbitrary
-- activity endpoint or caller-supplied actor/timestamp is exposed.
grant create on schema private to leadsfam_crm;
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('crm_keys','crm_contact_json','crm_lead_json','crm_event','crm_get') loop
  execute format('alter function %s owner to leadsfam_crm',fn.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,leadsfam_runtime',fn.signature);
 end loop;
end $$;
revoke create on schema private from leadsfam_crm;
create function public.crm_get(p_org uuid,p_kind text,p_id uuid) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_get(p_org,p_kind,p_id) $$;
revoke all on function public.crm_get(uuid,text,uuid) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.crm_get(uuid,text,uuid),private.crm_get(uuid,text,uuid) to authenticated;

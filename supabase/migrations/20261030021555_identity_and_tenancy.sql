-- No passwords, provider keys or customer records belong in migrations.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='leadsfam_policy') then create role leadsfam_policy nologin nosuperuser nobypassrls; end if;
 if not exists(select 1 from pg_roles where rolname='leadsfam_runtime') then create role leadsfam_runtime login nosuperuser nobypassrls; end if;
end $$;
do $$ begin
 if exists(select 1 from pg_roles where rolname in ('leadsfam_policy','leadsfam_runtime') and (rolsuper or rolbypassrls or (rolname='leadsfam_policy' and rolcanlogin))) then
  raise exception 'Unsafe pre-existing LeadsFam database role';
 end if;
end $$;
-- The migration administrator may assign function ownership; no application role receives this membership.
grant leadsfam_policy to postgres with set true;
create schema private;
revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to leadsfam_policy, leadsfam_runtime, authenticated;
-- Supabase grants auth-schema usage through authenticated; the migration role
-- cannot delegate the schema owner's grant option. This grant is one-way:
-- authenticated/browser roles never become members of leadsfam_policy.
grant authenticated to leadsfam_policy;
grant usage on schema public to leadsfam_policy;

create table private.app_sessions (
  id_hash text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid references auth.users(id) on delete cascade,
  provider_session_id uuid references auth.sessions(id) on delete cascade,
  purpose text not null check (purpose in ('anonymous', 'recovery', 'application')),
  token_envelope jsonb,
  csrf_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (purpose = 'anonymous' or (user_id is not null and provider_session_id is not null and token_envelope is not null))
);
create index app_sessions_provider_idx on private.app_sessions(provider_session_id, user_id);
create index app_sessions_expiry_idx on private.app_sessions(expires_at);
create table private.settings (singleton boolean primary key default true check(singleton), self_service_org_creation boolean not null default false);
insert into private.settings values(true, false);
create table private.security_events (
  id uuid primary key default gen_random_uuid(), actor_id uuid, organization_id uuid,
  event text not null, request_id text, created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check(char_length(display_name) <= 100),
  created_at timestamptz not null default now()
);
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check(char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);
create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  role text not null check(role in ('owner','admin','member')),
  joined_at timestamptz not null default now(), revoked_at timestamptz,
  primary key(organization_id,user_id)
);
create index memberships_user_idx on public.organization_memberships(user_id, organization_id) where revoked_at is null;
create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  email text not null check(char_length(email) between 3 and 254), role text not null check(role in ('admin','member')),
  token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid not null, created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '72 hours', accepted_at timestamptz, revoked_at timestamptz,
  foreign key(organization_id, invited_by) references public.organization_memberships(organization_id,user_id)
);
create unique index invitations_pending_idx on public.organization_invitations(organization_id, lower(email)) where accepted_at is null and revoked_at is null;
create table public.organization_notes (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  author_id uuid not null, title text not null check(char_length(btrim(title)) between 1 and 120),
  body text not null default '' check(char_length(body) <= 4000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(organization_id,id),
  foreign key(organization_id,author_id) references public.organization_memberships(organization_id,user_id)
);
create index notes_organization_idx on public.organization_notes(organization_id, created_at);

-- Runtime can persist sessions, but cannot query or mutate tenant data with this login.
grant select, insert, update, delete on private.app_sessions to leadsfam_runtime;
grant insert on private.security_events to leadsfam_runtime;
grant select on private.app_sessions, private.settings to leadsfam_policy;
grant select, insert, update, delete on public.profiles, public.organizations, public.organization_memberships, public.organization_invitations, public.organization_notes to leadsfam_policy;
grant insert on private.security_events to leadsfam_policy;
-- Auth-table access is confined to the separately approved private lookup below.

alter table private.app_sessions enable row level security;
alter table private.settings enable row level security;
alter table private.security_events enable row level security;
create policy session_store on private.app_sessions to leadsfam_runtime using(true) with check(true);
create policy session_policy_read on private.app_sessions for select to leadsfam_policy using(true);
create policy settings_policy_read on private.settings for select to leadsfam_policy using(true);
create policy events_policy_write on private.security_events for insert to leadsfam_policy, leadsfam_runtime with check(true);

-- This exception role is NOLOGIN and not granted to runtime/browser roles. Only
-- the bounded definer functions below execute with it; it has no BYPASSRLS.
do $$ declare relation text; begin
  foreach relation in array array['profiles','organizations','organization_memberships','organization_invitations','organization_notes'] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role',relation);
    execute format('create policy function_owner on public.%I to leadsfam_policy using(true) with check(true)',relation);
  end loop;
end $$;

create function private.active_application_session() returns boolean
language sql volatile security definer set search_path='' as $$
  select auth.uid() is not null and exists (
    select 1 from private.app_sessions s where s.user_id=auth.uid()
      and s.provider_session_id=nullif(auth.jwt()->>'session_id','')::uuid
      and s.purpose='application' and s.revoked_at is null
      and s.expires_at>clock_timestamp() and s.idle_expires_at>clock_timestamp()
  )
$$;
create function private.member_role(org uuid) returns text
language sql volatile security definer set search_path='' as $$
 select m.role from public.organization_memberships m
 where private.active_application_session() and m.organization_id=org and m.user_id=auth.uid() and m.revoked_at is null
$$;
create function private.profile_visible(target uuid) returns boolean
language sql volatile security definer set search_path='' as $$
 select private.active_application_session() and (target=auth.uid() or exists(
   select 1 from public.organization_memberships mine join public.organization_memberships theirs using(organization_id)
   where mine.user_id=auth.uid() and theirs.user_id=target and mine.revoked_at is null and theirs.revoked_at is null))
$$;
grant select on public.profiles, public.organizations, public.organization_memberships, public.organization_notes to authenticated;
grant select(id,organization_id,email,role,invited_by,created_at,expires_at,accepted_at,revoked_at) on public.organization_invitations to authenticated;
create policy profile_read on public.profiles for select to authenticated using(private.profile_visible(id));
create policy organization_read on public.organizations for select to authenticated using(private.member_role(id) is not null);
create policy membership_read on public.organization_memberships for select to authenticated using(private.member_role(organization_id) is not null);
create policy invitation_read on public.organization_invitations for select to authenticated using(private.member_role(organization_id) in ('owner','admin'));
create policy note_read on public.organization_notes for select to authenticated using(private.member_role(organization_id) is not null);

create function private.bootstrap_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,display_name) values(new.id,left(coalesce(new.raw_user_meta_data->>'display_name',''),100));
 return new;
end $$;
create trigger create_profile after insert on auth.users for each row execute function private.bootstrap_profile();

create function private.immutable_identity() returns trigger language plpgsql set search_path='' as $$
begin
 if new.organization_id is distinct from old.organization_id then raise exception using errcode='23514',message='immutable_organization'; end if;
 if tg_table_name='organization_memberships' then
  if new.user_id is distinct from old.user_id then raise exception using errcode='23514',message='immutable_member'; end if;
 end if;
 if tg_table_name='organization_notes' then
  if new.author_id is distinct from old.author_id then raise exception using errcode='23514',message='immutable_author'; end if;
 end if;
 return new;
end $$;
create trigger membership_identity before update on public.organization_memberships for each row execute function private.immutable_identity();
create trigger note_identity before update on public.organization_notes for each row execute function private.immutable_identity();
create trigger invitation_identity before update on public.organization_invitations for each row execute function private.immutable_identity();

create function private.owner_invariant() returns trigger language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 if tg_table_name='organizations' then org:=new.id; else org:=old.organization_id; end if;
 perform 1 from public.organizations where id=org for update;
 if exists(select 1 from public.organizations where id=org) and not exists(select 1 from public.organization_memberships where organization_id=org and role='owner' and revoked_at is null) then
   raise exception using errcode='23514',message='last_owner';
 end if;
 return null;
end $$;
create constraint trigger organization_owner after insert on public.organizations deferrable initially deferred for each row execute function private.owner_invariant();
create constraint trigger membership_owner after update or delete on public.organization_memberships deferrable initially deferred for each row execute function private.owner_invariant();

create function private.authorize_org(org uuid, permission text, exclusive_lock boolean default false) returns text
language plpgsql volatile security definer set search_path='' as $$
declare actor_role text;
begin
 if not private.active_application_session() then raise exception using errcode='42501',message='unauthenticated'; end if;
 if exclusive_lock then perform 1 from public.organizations where id=org for update;
 else perform 1 from public.organizations where id=org for share; end if;
 actor_role:=private.member_role(org);
 if actor_role is null then raise exception using errcode='42501',message='not_found'; end if;
 if permission not in ('read','write_note') and not (actor_role='owner' or (actor_role='admin' and permission in ('settings','invite_member','remove_member','moderate_note'))) then
  raise exception using errcode='42501',message='forbidden';
 end if;
 return actor_role;
end $$;
create function private.audit(org uuid, event_name text) returns void language sql security definer set search_path='' as $$
 insert into private.security_events(actor_id,organization_id,event,request_id) values(auth.uid(),org,event_name,left(nullif(current_setting('request.headers',true),'')::jsonb->>'x-request-id',80))
$$;

create function private.create_organization(p_name text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org public.organizations;
begin
 if not private.active_application_session() then raise exception using errcode='42501',message='unauthenticated'; end if;
 if not exists(select 1 from private.settings where self_service_org_creation) then raise exception using errcode='42501',message='onboarding_disabled'; end if;
 if private.current_verified_email() is null then raise exception using errcode='42501',message='email_unverified'; end if;
 insert into public.organizations(name) values(btrim(p_name)) returning * into org;
 insert into public.organization_memberships(organization_id,user_id,role) values(org.id,auth.uid(),'owner');
 perform private.audit(org.id,'organization.created');
 return jsonb_build_object('id',org.id,'name',org.name,'role','owner');
end $$;
create function private.get_organization(p_org uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name text; result jsonb;
begin
 role_name:=private.authorize_org(p_org,'read');
 select jsonb_build_object('id',id,'name',name,'role',role_name) into result from public.organizations where id=p_org;
 return result;
end $$;
create function private.update_organization(p_org uuid,p_name text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.authorize_org(p_org,'settings',true);
 update public.organizations set name=btrim(p_name) where id=p_org;
 perform private.audit(p_org,'organization.updated');
 return private.get_organization(p_org);
end $$;
create function private.list_members(p_org uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.authorize_org(p_org,'read');
 select coalesce(jsonb_agg(jsonb_build_object('userId',m.user_id,'displayName',p.display_name,'role',m.role,'revoked',m.revoked_at is not null) order by m.joined_at),'[]') into result
 from public.organization_memberships m join public.profiles p on p.id=m.user_id where m.organization_id=p_org;
 return result;
end $$;
create function private.change_member(p_org uuid,p_user uuid,p_role text default null,p_remove boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_role text; target_role text;
begin
 actor_role:=private.authorize_org(p_org,'read',true);
 select role into target_role from public.organization_memberships where organization_id=p_org and user_id=p_user and revoked_at is null;
 if target_role is null then raise exception using errcode='42501',message='not_found'; end if;
 if target_role='owner' then raise exception using errcode='23514',message='last_owner'; end if;
 if p_remove then
   if not (p_user=auth.uid() or actor_role='owner' or (actor_role='admin' and target_role='member')) then raise exception using errcode='42501',message='forbidden'; end if;
   update public.organization_memberships set revoked_at=clock_timestamp() where organization_id=p_org and user_id=p_user;
 else
   if actor_role<>'owner' or p_role not in ('admin','member') or p_role is null then raise exception using errcode='42501',message='forbidden'; end if;
   update public.organization_memberships set role=p_role where organization_id=p_org and user_id=p_user;
 end if;
 perform private.audit(p_org,case when p_remove then 'membership.revoked' else 'membership.role_changed' end);
 return jsonb_build_object('ok',true);
end $$;
create function private.list_invitations(p_org uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.authorize_org(p_org,'invite_member');
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'email',email,'role',role,'expiresAt',expires_at,'accepted',accepted_at is not null,'revoked',revoked_at is not null) order by created_at desc),'[]') into result from public.organization_invitations where organization_id=p_org;
 return result;
end $$;
create function private.create_invitation(p_org uuid,p_email text,p_role text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare invitation_id uuid;
begin
 perform private.authorize_org(p_org,case when p_role='admin' then 'invite_admin' else 'invite_member' end,true);
 if p_role not in ('admin','member') then raise exception using errcode='42501',message='forbidden'; end if;
 update public.organization_invitations set revoked_at=clock_timestamp() where organization_id=p_org and lower(email)=lower(btrim(p_email)) and accepted_at is null and revoked_at is null;
 insert into public.organization_invitations(organization_id,email,role,token_hash,invited_by) values(p_org,lower(btrim(p_email)),p_role,p_hash,auth.uid()) returning id into invitation_id;
 perform private.audit(p_org,'invitation.created');
 return jsonb_build_object('id',invitation_id);
end $$;
create function private.revoke_invitation(p_org uuid,p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.authorize_org(p_org,'invite_member',true);
 if exists(select 1 from public.organization_invitations where id=p_id and organization_id=p_org and role='admin') then perform private.authorize_org(p_org,'invite_admin',true); end if;
 update public.organization_invitations set revoked_at=clock_timestamp() where id=p_id and organization_id=p_org and accepted_at is null;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 perform private.audit(p_org,'invitation.revoked');
 return jsonb_build_object('ok',true);
end $$;
create function private.accept_invitation(p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare inv public.organization_invitations; current_email text; issuer_role text;
begin
 if not private.active_application_session() then raise exception using errcode='42501',message='unauthenticated'; end if;
 select * into inv from public.organization_invitations where token_hash=p_hash;
 if not found then raise exception using errcode='42501',message='invitation_invalid'; end if;
 perform 1 from public.organizations where id=inv.organization_id for update;
 select * into inv from public.organization_invitations where token_hash=p_hash for update;
 current_email:=private.current_verified_email();
 if inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at<=clock_timestamp() or current_email is null or current_email<>lower(inv.email) then raise exception using errcode='42501',message='invitation_invalid'; end if;
 select role into issuer_role from public.organization_memberships where organization_id=inv.organization_id and user_id=inv.invited_by and revoked_at is null;
 if issuer_role is null or (inv.role='admin' and issuer_role<>'owner') or issuer_role='member' then raise exception using errcode='42501',message='invitation_invalid'; end if;
 -- Existing active members are not silently promoted/demoted by invitation replay.
 if exists(select 1 from public.organization_memberships where organization_id=inv.organization_id and user_id=auth.uid() and revoked_at is null) then raise exception using errcode='42501',message='already_member'; end if;
 insert into public.organization_memberships(organization_id,user_id,role) values(inv.organization_id,auth.uid(),inv.role)
 on conflict(organization_id,user_id) do update set role=excluded.role,revoked_at=null,joined_at=clock_timestamp();
 update public.organization_invitations set accepted_at=clock_timestamp() where id=inv.id;
 perform private.audit(inv.organization_id,'invitation.accepted');
 return private.get_organization(inv.organization_id);
end $$;
create function private.list_notes(p_org uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.authorize_org(p_org,'read');
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'organizationId',organization_id,'authorId',author_id,'title',title,'body',body,'updatedAt',updated_at) order by created_at desc),'[]') into result from public.organization_notes where organization_id=p_org;
 return result;
end $$;
create function private.write_note(p_org uuid,p_title text,p_body text,p_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare target public.organization_notes;
begin
 perform private.authorize_org(p_org,'write_note',true);
 if p_id is null then
  insert into public.organization_notes(organization_id,author_id,title,body) values(p_org,auth.uid(),btrim(p_title),p_body) returning * into target;
 else
  select * into target from public.organization_notes where id=p_id and organization_id=p_org;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
  if target.author_id<>auth.uid() then perform private.authorize_org(p_org,'moderate_note',true); end if;
  update public.organization_notes set title=btrim(p_title),body=p_body,updated_at=clock_timestamp() where id=p_id and organization_id=p_org returning * into target;
 end if;
 return jsonb_build_object('id',target.id,'organizationId',target.organization_id,'authorId',target.author_id,'title',target.title,'body',target.body,'updatedAt',target.updated_at);
end $$;
create function private.delete_note(p_org uuid,p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare author uuid;
begin
 perform private.authorize_org(p_org,'write_note',true);
 select author_id into author from public.organization_notes where id=p_id and organization_id=p_org;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 if author<>auth.uid() then perform private.authorize_org(p_org,'moderate_note',true); end if;
 delete from public.organization_notes where id=p_id and organization_id=p_org;
 return jsonb_build_object('ok',true);
end $$;

-- Give definer functions the dedicated, non-login exception role; revoke default
-- PUBLIC execution. Public entry points below remain SECURITY INVOKER.
grant create on schema private to leadsfam_policy;
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' loop
  execute format('alter function %s owner to leadsfam_policy',fn.signature);
  execute format('revoke all on function %s from public, anon, authenticated, service_role, leadsfam_runtime',fn.signature);
 end loop;
end $$;

grant execute on function private.active_application_session(),private.member_role(uuid),private.profile_visible(uuid) to authenticated;

create function private.list_organizations() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not private.active_application_session() then raise exception using errcode='42501',message='unauthenticated'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'role',m.role) order by o.created_at),'[]') into result
 from public.organizations o join public.organization_memberships m on m.organization_id=o.id where m.user_id=auth.uid() and m.revoked_at is null;
 return result;
end $$;
alter function private.list_organizations() owner to leadsfam_policy;
revoke all on function private.list_organizations() from public,anon,authenticated,service_role,leadsfam_runtime;

create function public.list_organizations() returns jsonb language sql volatile security invoker set search_path='' as $$ select private.list_organizations() $$;
revoke all on function public.list_organizations() from public,anon,service_role,leadsfam_runtime;
grant execute on function public.list_organizations() to authenticated;
grant execute on function private.list_organizations() to authenticated;

create function public.create_organization(p_name text) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.create_organization(p_name) $$;
revoke all on function public.create_organization(text) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.create_organization(text) to authenticated;
grant execute on function private.create_organization(text) to authenticated;

create function public.get_organization(p_org uuid) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.get_organization(p_org) $$;
revoke all on function public.get_organization(uuid) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.get_organization(uuid) to authenticated;
grant execute on function private.get_organization(uuid) to authenticated;

create function public.update_organization(p_org uuid,p_name text) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.update_organization(p_org,p_name) $$;
revoke all on function public.update_organization(uuid,text) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.update_organization(uuid,text) to authenticated;
grant execute on function private.update_organization(uuid,text) to authenticated;

create function public.list_members(p_org uuid) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.list_members(p_org) $$;
revoke all on function public.list_members(uuid) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.list_members(uuid) to authenticated;
grant execute on function private.list_members(uuid) to authenticated;

create function public.change_member(p_org uuid,p_user uuid,p_role text default null,p_remove boolean default false) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.change_member(p_org,p_user,p_role,p_remove) $$;
revoke all on function public.change_member(uuid,uuid,text,boolean) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.change_member(uuid,uuid,text,boolean) to authenticated;
grant execute on function private.change_member(uuid,uuid,text,boolean) to authenticated;

create function public.list_invitations(p_org uuid) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.list_invitations(p_org) $$;
revoke all on function public.list_invitations(uuid) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.list_invitations(uuid) to authenticated;
grant execute on function private.list_invitations(uuid) to authenticated;

create function public.create_invitation(p_org uuid,p_email text,p_role text,p_hash text) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.create_invitation(p_org,p_email,p_role,p_hash) $$;
revoke all on function public.create_invitation(uuid,text,text,text) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.create_invitation(uuid,text,text,text) to authenticated;
grant execute on function private.create_invitation(uuid,text,text,text) to authenticated;

create function public.revoke_invitation(p_org uuid,p_id uuid) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.revoke_invitation(p_org,p_id) $$;
revoke all on function public.revoke_invitation(uuid,uuid) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.revoke_invitation(uuid,uuid) to authenticated;
grant execute on function private.revoke_invitation(uuid,uuid) to authenticated;

create function public.accept_invitation(p_hash text) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.accept_invitation(p_hash) $$;
revoke all on function public.accept_invitation(text) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function private.accept_invitation(text) to authenticated;

create function public.list_notes(p_org uuid) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.list_notes(p_org) $$;
revoke all on function public.list_notes(uuid) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.list_notes(uuid) to authenticated;
grant execute on function private.list_notes(uuid) to authenticated;

create function public.write_note(p_org uuid,p_title text,p_body text,p_id uuid default null) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.write_note(p_org,p_title,p_body,p_id) $$;
revoke all on function public.write_note(uuid,text,text,uuid) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.write_note(uuid,text,text,uuid) to authenticated;
grant execute on function private.write_note(uuid,text,text,uuid) to authenticated;

create function public.delete_note(p_org uuid,p_id uuid) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.delete_note(p_org,p_id) $$;
revoke all on function public.delete_note(uuid,uuid) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.delete_note(uuid,uuid) to authenticated;
grant execute on function private.delete_note(uuid,uuid) to authenticated;

-- Ownership assignment is complete; the exception role cannot create new functions.
revoke create on schema private from leadsfam_policy;

-- ADR 0008: explicitly approved exception. Do not include this helper in the
-- non-login owner loop. Only its narrow caller can execute it.
create function private.current_verified_email() returns text
language sql volatile security definer set search_path='' as $$
 select pg_catalog.lower(u.email::text) from auth.users u
 where u.id=auth.uid() and u.email_confirmed_at is not null
 and private.active_application_session()
$$;
alter function private.current_verified_email() owner to postgres;
revoke all on function private.current_verified_email() from public,anon,authenticated,service_role,leadsfam_runtime;
grant execute on function private.current_verified_email() to leadsfam_policy;

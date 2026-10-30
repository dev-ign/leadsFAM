-- Fail-closed coordination between provider password changes and local enrollment.
-- No API access to auth.users or tenant data is added.
create table private.auth_guards (
 user_id uuid primary key references auth.users(id) on delete cascade,
 blocked boolean not null default false,
 changed_at timestamptz not null default clock_timestamp()
);
alter table private.auth_guards enable row level security;
grant select, insert, update on private.auth_guards to leadsfam_runtime;
create policy runtime_auth_guard on private.auth_guards to leadsfam_runtime using(true) with check(true);

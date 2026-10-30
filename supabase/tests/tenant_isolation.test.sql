begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at,aud,role,raw_user_meta_data) values
 ('00000000-0000-4000-8000-000000000001','owner-a@example.test',now(),'authenticated','authenticated','{"display_name":"Owner A"}'),
 ('00000000-0000-4000-8000-000000000002','owner-b@example.test',now(),'authenticated','authenticated','{"display_name":"Owner B"}'),
 ('00000000-0000-4000-8000-000000000003','member@example.test',now(),'authenticated','authenticated','{"display_name":"Member"}'),
 ('00000000-0000-4000-8000-000000000004','admin@example.test',now(),'authenticated','authenticated','{"display_name":"Admin"}'),
 ('00000000-0000-4000-8000-000000000005','shared@example.test',now(),'authenticated','authenticated','{"display_name":"Shared member"}');
insert into auth.sessions(id,user_id,created_at,updated_at,aal)
 select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,now(),now(),'aal1'
 from generate_series(1,5) n;
insert into auth.sessions(id,user_id,created_at,updated_at,aal) values
 ('10000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001',now(),now(),'aal1'),
 ('10000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001',now(),now(),'aal1');
insert into private.app_sessions(id_hash,user_id,provider_session_id,purpose,token_envelope,csrf_hash,idle_expires_at,expires_at)
 select lpad(n::text,64,'0'),('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'application','{}','fixture',now()+interval '30 minutes',now()+interval '12 hours' from generate_series(1,5) n;
insert into private.app_sessions(id_hash,user_id,provider_session_id,purpose,token_envelope,csrf_hash,idle_expires_at,expires_at)
 values(repeat('6',64),'00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000006','recovery','{}','fixture',now()+interval '10 minutes',now()+interval '10 minutes');
insert into public.organizations(id,name) values('20000000-0000-4000-8000-000000000001','Synthetic A'),('20000000-0000-4000-8000-000000000002','Synthetic B');
insert into public.organization_memberships(organization_id,user_id,role) values
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','owner'),
 ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','owner'),
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','member'),
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','admin'),
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000005','member'),
 ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000005','member');
insert into public.organization_notes(id,organization_id,author_id,title) values
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Private A'),
 ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','Private B');

set local role anon;
select throws_ok('select * from public.organizations','42501',null,'Anonymous role cannot read organizations');
select throws_ok($$select public.create_organization('No access')$$,'42501',null,'Anonymous role cannot invoke onboarding');
reset role;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000003","session_id":"10000000-0000-4000-8000-000000000003","role":"authenticated","user_metadata":{"role":"owner"}}',true);
set local role authenticated;
select is((select count(*) from public.organizations),1::bigint,'Member sees only own organization');
select is((select count(*) from public.organization_notes),1::bigint,'Member cannot read another tenant note');
select is((select count(*) from public.organization_memberships where organization_id='20000000-0000-4000-8000-000000000002'),0::bigint,'Membership roster is tenant scoped');
select is((select count(*) from public.profiles where id='00000000-0000-4000-8000-000000000002'),0::bigint,'Foreign profile is private');
select throws_ok($$select public.get_organization('20000000-0000-4000-8000-000000000002')$$,'42501','not_found','Foreign organization does not disclose existence');
select throws_ok($$select public.change_member('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','owner')$$,'42501','forbidden','Member cannot promote self; user_metadata grants no authority');
select throws_ok($$update public.organization_memberships set role='owner' where user_id=auth.uid()$$,'42501',null,'Direct membership writes cannot bypass RPC authorization');
select throws_ok($$select public.change_member('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','member')$$,'42501','not_found','Cannot change foreign membership');
select throws_ok($$delete from public.organizations where id='20000000-0000-4000-8000-000000000001'$$,'42501',null,'Organization deletion is not granted');
select throws_ok('select * from private.app_sessions','42501',null,'Browser role cannot read session ciphertext');
select throws_ok($$update private.app_sessions set purpose='application'$$,'42501',null,'Browser role cannot enroll a privileged session');
select throws_ok($$select public.update_organization('20000000-0000-4000-8000-000000000001','Escalated')$$,'42501','forbidden','Member cannot change organization settings');
select lives_ok($$select public.write_note('20000000-0000-4000-8000-000000000001','Own note','Synthetic body')$$,'Member can create own note');
select throws_ok($$select public.write_note('20000000-0000-4000-8000-000000000001','Changed','body','30000000-0000-4000-8000-000000000001')$$,'42501','forbidden','Member cannot edit another author note');
select throws_ok($$select public.write_note('20000000-0000-4000-8000-000000000002','Foreign','body')$$,'42501','not_found','Cross-tenant note creation denied');
select throws_ok($$update public.organization_notes set organization_id='20000000-0000-4000-8000-000000000002'$$,'42501',null,'Direct tenant reassignment denied');
reset role;
select throws_ok($$insert into public.organization_notes(organization_id,author_id,title) values('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Foreign author')$$,'23503',null,'Composite FK rejects a globally valid foreign-tenant author');
select throws_ok($$update public.organization_notes set organization_id='20000000-0000-4000-8000-000000000002' where id='30000000-0000-4000-8000-000000000001'$$,'23514','immutable_organization','Database trigger prevents tenant reassignment even outside API');

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","session_id":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is((public.create_organization('Atomic organization')->>'role'),'owner','Creation establishes owner');
select is((select count(*) from public.organization_memberships m join public.organizations o on o.id=m.organization_id where o.name='Atomic organization' and m.role='owner' and m.revoked_at is null),1::bigint,'New organization has exactly one active owner');
select throws_ok($$select public.change_member('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',null,true)$$,'23514','last_owner','Cannot remove final owner');
select throws_ok($$select public.change_member('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','member')$$,'23514','last_owner','Cannot demote final owner');
select lives_ok($$select public.create_invitation('20000000-0000-4000-8000-000000000001','owner-b@example.test','member',repeat('a',64))$$,'Owner can invite a member');
select lives_ok($$select public.change_member('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',null,true)$$,'Owner can revoke a member');
reset role;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000003","session_id":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.organizations),0::bigint,'Revoked membership loses access with the same active session');
select throws_ok($$select public.list_notes('20000000-0000-4000-8000-000000000001')$$,'42501','not_found','Revoked member cannot use note RPC');
reset role;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000005","session_id":"10000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.organizations),2::bigint,'A user can belong to multiple organizations');
select throws_ok($$select public.accept_invitation(repeat('a',64))$$,'42501','invitation_invalid','Wrong verified email cannot accept invitation');
reset role;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000002","session_id":"10000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select lives_ok($$select public.accept_invitation(repeat('a',64))$$,'Matching verified identity accepts invitation');
select throws_ok($$select public.accept_invitation(repeat('a',64))$$,'42501','invitation_invalid','Consumed invitation cannot be replayed');
reset role;

-- Invitation lifetime, current issuer authority and existing-member rules.
insert into public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) values
 ('20000000-0000-4000-8000-000000000001','owner-b@example.test','member',repeat('b',64),'00000000-0000-4000-8000-000000000001',now()-interval '1 second');
set local role authenticated;
select throws_ok($$select public.accept_invitation(repeat('b',64))$$,'42501','invitation_invalid','Expired invitation cannot be accepted');
reset role;
update public.organization_invitations set revoked_at=now() where token_hash=repeat('b',64);
insert into public.organization_invitations(organization_id,email,role,token_hash,invited_by) values
 ('20000000-0000-4000-8000-000000000001','owner-b@example.test','admin',repeat('c',64),'00000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000001','member@example.test','member',repeat('d',64),'00000000-0000-4000-8000-000000000004');
set local role authenticated;
select throws_ok($$select public.accept_invitation(repeat('c',64))$$,'42501','already_member','Existing member is not silently promoted by an invitation');
reset role;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000004","session_id":"10000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
set local role authenticated;
select throws_ok($$select public.create_invitation('20000000-0000-4000-8000-000000000001','another@example.test','admin',repeat('e',64))$$,'42501','forbidden','Admin cannot issue an admin invitation');
reset role;
update public.organization_memberships set role='member' where organization_id='20000000-0000-4000-8000-000000000001' and user_id='00000000-0000-4000-8000-000000000004';
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000003","session_id":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
select throws_ok($$select public.accept_invitation(repeat('d',64))$$,'42501','invitation_invalid','Demoted issuer cannot authorize a pending invitation');
reset role;
update private.settings set self_service_org_creation=false;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","session_id":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select throws_ok($$select public.create_organization('Closed onboarding bypass')$$,'42501','onboarding_disabled','Direct RPC cannot bypass the database onboarding flag');
reset role;
update private.settings set self_service_org_creation=true;

-- ADR 0008: direct execution remains denied, and identity is not an argument.
set local role authenticated;
select throws_ok('select private.current_verified_email()','42501',null,'Authenticated browser cannot call privileged email helper');
reset role;
select ok(not has_function_privilege('leadsfam_runtime','private.current_verified_email()','EXECUTE'),'Session-store role cannot execute email helper');
select ok(not has_function_privilege('service_role','private.current_verified_email()','EXECUTE'),'Service role has no helper execution grant');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","session_id":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"stale@example.test","user_metadata":{"email":"forged@example.test"}}',true);
set local role leadsfam_policy;
select is(private.current_verified_email(),'owner-a@example.test','Helper uses current Auth identity, not supplied email claims');
reset role;
update auth.users set email='changed@example.test',email_confirmed_at=null where id='00000000-0000-4000-8000-000000000001';
set local role leadsfam_policy;
select is(private.current_verified_email(),null::text,'Unverified changed email cannot retain verified authority');
reset role;
update auth.users set email_confirmed_at=now() where id='00000000-0000-4000-8000-000000000001';
set local role leadsfam_policy;
select is(private.current_verified_email(),'changed@example.test','Helper observes verified email changes despite stale JWT email');
reset role;

-- Recovery credentials carry the same user identity but no application purpose.
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","session_id":"10000000-0000-4000-8000-000000000006","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.organizations),0::bigint,'Recovery session cannot read owner organizations');
select is((select count(*) from public.organization_notes),0::bigint,'Recovery session cannot read tenant notes directly');
select throws_ok($$select public.list_organizations()$$,'42501','unauthenticated','Recovery JWT cannot bypass the API through RPC');
select throws_ok($$select public.create_organization('Recovery bypass')$$,'42501','unauthenticated','Recovery session cannot create an organization');
reset role;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","session_id":"10000000-0000-4000-8000-000000000007","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.organizations),0::bigint,'Unenrolled provider session has no organization authority');
reset role;
update private.app_sessions set idle_expires_at=now()-interval '1 minute' where provider_session_id='10000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","session_id":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.organizations),0::bigint,'Expired application enrollment is denied independently of JWT identity');
reset role;
select ok(not has_table_privilege('leadsfam_runtime','public.organization_notes','SELECT'),'Session runtime role has no tenant read grant');
select ok(not has_function_privilege('leadsfam_runtime','public.create_organization(text)','EXECUTE'),'Session runtime role cannot invoke privileged tenant RPC');
select ok(not pg_has_role('authenticated','leadsfam_policy','MEMBER'),'Browser role cannot assume function owner');
select ok(not (select rolbypassrls or rolsuper from pg_roles where rolname='leadsfam_policy'),'Definer owner is not superuser or BYPASSRLS');
select ok(not (select rolbypassrls or rolsuper from pg_roles where rolname='leadsfam_runtime'),'Runtime is not superuser or BYPASSRLS');
select ok(not has_schema_privilege('leadsfam_policy','private','CREATE'),'Function owner cannot create arbitrary new functions');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_organization','change_member','accept_invitation') and p.prosecdef),0::bigint,'Public mutation wrappers use invoker security');
select is((select pg_get_userbyid(proowner)::text from pg_proc where oid='private.current_verified_email()'::regprocedure),'postgres','Only the approved helper retains migration-administrator ownership');
select is((select pronargs::int from pg_proc where oid='private.current_verified_email()'::regprocedure),0,'Verified-email helper accepts no identity arguments');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='private.current_verified_email()'::regprocedure),'Verified-email helper fixes an empty search path');
select ok(not has_function_privilege('anon','private.current_verified_email()','EXECUTE'),'Anonymous role has no email helper execution grant');
select ok(not has_table_privilege('authenticated','private.auth_guards','SELECT'),'Browser cannot read recovery coordination records');
select * from finish();
rollback;

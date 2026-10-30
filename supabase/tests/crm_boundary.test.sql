begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();
-- Test-only access to the assertion library, rolled back with this transaction.
grant usage on schema extensions to leadsfam_crm;
insert into auth.users(id,email,email_confirmed_at,aud,role)
 select ('01000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'crm-'||n||'@example.test',now(),'authenticated','authenticated' from generate_series(1,3) n;
insert into auth.sessions(id,user_id,created_at,updated_at,aal)
 select ('11000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('01000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,now(),now(),'aal1' from generate_series(1,3) n;
insert into private.app_sessions(id_hash,user_id,provider_session_id,purpose,token_envelope,csrf_hash,idle_expires_at,expires_at)
 select md5(n::text)||md5(n::text),('01000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('11000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,case when n=3 then 'recovery' else 'application' end,'{}','fixture',now()+interval '10 minutes',now()+interval '10 minutes' from generate_series(1,3) n;
insert into public.organizations(id,name) values('21000000-0000-4000-8000-000000000001','CRM A'),('21000000-0000-4000-8000-000000000002','CRM B');
insert into public.organization_memberships(organization_id,user_id,role) values
 ('21000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-000000000001','owner'),
 ('21000000-0000-4000-8000-000000000002','01000000-0000-4000-8000-000000000002','owner'),
 ('21000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-000000000002','member'),
 ('21000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-000000000003','member');
insert into public.contacts(id,organization_id,kind,display_name,created_by) values
 ('31000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','person','Synthetic A','01000000-0000-4000-8000-000000000001'),
 ('31000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000002','person','Synthetic B','01000000-0000-4000-8000-000000000002');
insert into public.leads(id,organization_id,contact_id,title,created_by,last_assigned_user_id,assigned_membership_generation) values
 ('41000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','Synthetic lead','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-000000000002',1);
insert into public.lead_attributions(organization_id,lead_id,channel,campaign) values('21000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','manual','Original campaign');
insert into public.crm_activities(organization_id,lead_id,actor_id,event,details) values('21000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-000000000001','lead.created','{"channel":"manual"}');

select ok((select not rolcanlogin and not rolsuper and not rolbypassrls and not rolinherit from pg_roles where rolname='leadsfam_crm'),'CRM is non-login, non-super, non-bypass and non-inheriting');
select ok(not exists(select 1 from pg_auth_members where member='leadsfam_crm'::regrole),'CRM has no inherited or assumable roles');
select ok(not pg_has_role('authenticated','leadsfam_crm','MEMBER'),'Browser cannot assume CRM role');
select ok(not pg_has_role('leadsfam_runtime','leadsfam_crm','MEMBER'),'Session runtime cannot assume CRM role');
select ok(not has_schema_privilege('leadsfam_crm','private','CREATE'),'CRM cannot create private functions');
select ok(not has_schema_privilege('leadsfam_crm','auth','USAGE'),'CRM has no Auth schema usage');
select ok(not has_table_privilege('leadsfam_crm','auth.users','SELECT'),'CRM cannot select Auth users');
select ok(not has_table_privilege('leadsfam_crm','private.app_sessions','SELECT'),'CRM cannot select session ciphertext');
select ok(not has_table_privilege('leadsfam_crm','private.auth_guards','UPDATE'),'CRM cannot alter recovery fences');
select ok(not has_table_privilege('leadsfam_crm','public.organization_memberships','UPDATE'),'CRM cannot alter membership');
select ok(not has_function_privilege('leadsfam_crm','private.change_member(uuid,uuid,text,boolean)','EXECUTE'),'CRM cannot invoke Phase 01 member mutation');
select ok(not has_function_privilege('leadsfam_crm','private.current_verified_email()','EXECUTE'),'CRM cannot invoke privileged email helper');
select ok(not has_function_privilege('authenticated','private.crm_context(uuid,text)','EXECUTE'),'Browser cannot invoke authorization bridge');
select ok(not has_function_privilege('authenticated','private.crm_member_generation(uuid,uuid)','EXECUTE'),'Browser cannot invoke eligibility bridge');
select ok(not has_function_privilege('authenticated','private.crm_event(uuid,uuid,uuid,uuid,text,jsonb)','EXECUTE'),'Browser cannot forge activities');
select ok(not has_function_privilege('anon','public.crm_get(uuid,text,uuid)','EXECUTE'),'Anonymous role cannot invoke CRM');
select ok(not has_function_privilege('service_role','public.crm_get(uuid,text,uuid)','EXECUTE'),'Service role has no CRM function grant');
select ok(not has_function_privilege('leadsfam_runtime','public.crm_get(uuid,text,uuid)','EXECUTE'),'Runtime has no CRM function grant');
select ok(not exists(select 1 from pg_class where relnamespace in ('public'::regnamespace,'private'::regnamespace) and relowner='leadsfam_crm'::regrole),'CRM owns no tables');
select is((select count(*) from pg_class where relname in ('contacts','contact_emails','contact_phones','lead_sources','leads','lead_attributions','crm_activities','crm_request_receipts','lead_import_jobs','lead_import_attempts','lead_import_rows') and relrowsecurity),11::bigint,'All eleven CRM relations have RLS');
select ok((select proowner='leadsfam_policy'::regrole and prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='private.crm_context(uuid,text)'::regprocedure),'Authorization bridge has reviewed owner and empty search path');
select ok((select proowner='leadsfam_crm'::regrole and prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='private.crm_get(uuid,text,uuid)'::regprocedure),'CRM entry implementation has reviewed owner and empty search path');
select ok((select not prosecdef from pg_proc where oid='public.crm_get(uuid,text,uuid)'::regprocedure),'Public wrapper is invoker');
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'crm\_%' escape '\' and p.prosecdef),'Every public CRM wrapper remains invoker');
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'crm\_%' escape '\' and p.prosecdef and (p.proowner not in ('leadsfam_crm'::regrole,'leadsfam_policy'::regrole) or not p.proconfig @> array['search_path=""'])),'All CRM definer functions retain reviewed owners and empty search paths');
select ok(not has_function_privilege('authenticated','private.crm_intake(uuid,jsonb,uuid,text)','EXECUTE'),'Browser cannot forge the internal intake channel');
select ok(not has_function_privilege('authenticated','private.crm_batch_duplicate(jsonb,jsonb)','EXECUTE'),'Browser cannot execute internal batch helpers');

select set_config('request.jwt.claims','{"sub":"01000000-0000-4000-8000-000000000001","session_id":"11000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.contacts),1::bigint,'Direct read isolates tenant contacts');
select is((public.crm_get('21000000-0000-4000-8000-000000000001','contact','31000000-0000-4000-8000-000000000001')->>'display_name'),'Synthetic A','Authorized direct RPC returns current contact');
select throws_ok($$select public.crm_get('21000000-0000-4000-8000-000000000001','contact','31000000-0000-4000-8000-000000000002')$$,'42501','not_found','Foreign contact ID is indistinguishable from absent');
select throws_ok($$select public.crm_get('21000000-0000-4000-8000-000000000002','contact','31000000-0000-4000-8000-000000000002')$$,'42501','not_found','Foreign organization RPC denied');
select throws_ok($$update public.contacts set display_name='Forged'$$,'42501',null,'Direct contact writes denied');
select throws_ok($$delete from public.leads$$,'42501',null,'Lead deletion denied');
select throws_ok('select * from private.lead_import_jobs','42501',null,'Browser cannot read private import records');
select ok(not pg_has_role(current_user,'leadsfam_crm','SET'),'Browser has no SET ROLE membership (administrator-owned test connection is not the browser login)');
reset role;
set local role leadsfam_crm;
select throws_ok('select * from private.app_sessions','42501',null,'Execution role cannot read sessions even in SQL');
select throws_ok('select * from auth.users','42501',null,'Execution role cannot resolve Auth users');
select throws_ok($$select private.crm_context('21000000-0000-4000-8000-000000000001','owner')$$,'42501','forbidden','Unknown permission is denied even to owner');
select set_config('leadsfam.organization_id','21000000-0000-4000-8000-000000000002',true);
select is((select count(*) from public.contacts),0::bigint,'Forged scope cannot supply membership');
-- InitPlans must recheck live authority on each execution, including reuse of
-- the same prepared plan on a pooled connection. Scope is a bound, not a grant.
prepare scoped_contacts as select count(*) from public.contacts;
select set_config('leadsfam.organization_id','21000000-0000-4000-8000-000000000001',true);
select results_eq('execute scoped_contacts',array[1::bigint],'Execution role sees only its authorized UUID scope');
select throws_ok($$insert into public.contacts(organization_id,kind,display_name,created_by) values('21000000-0000-4000-8000-000000000002','person','Forged write','01000000-0000-4000-8000-000000000002')$$,'42501',null,'Execution WITH CHECK rejects a foreign tenant even with valid foreign references');
select set_config('leadsfam.organization_id','',true);
select results_eq('execute scoped_contacts',array[0::bigint],'Missing scope fails closed on the same prepared plan');
select set_config('leadsfam.organization_id','21000000-0000-4000-8000-000000000002',true);
select results_eq('execute scoped_contacts',array[0::bigint],'Changed scope cannot reuse prior statement authority');
select set_config('leadsfam.organization_id','21000000-0000-4000-8000-000000000001',true);
reset role;
update private.app_sessions set revoked_at=clock_timestamp() where user_id='01000000-0000-4000-8000-000000000001';
set local role leadsfam_crm;
select results_eq('execute scoped_contacts',array[0::bigint],'Session revocation invalidates the next execution of a prepared plan');
reset role;
update private.app_sessions set revoked_at=null where user_id='01000000-0000-4000-8000-000000000001';
set local role leadsfam_crm;
select results_eq('execute scoped_contacts',array[1::bigint],'Prepared plan evaluates live session state rather than caching a denial');
deallocate scoped_contacts;
reset role;

select throws_ok($$insert into public.leads(organization_id,contact_id,title,created_by) values('21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000002','Cross tenant','01000000-0000-4000-8000-000000000001')$$,'23503',null,'Composite contact FK rejects foreign tenant even for administrator');
select throws_ok($$update public.contacts set organization_id='21000000-0000-4000-8000-000000000002',version=2 where id='31000000-0000-4000-8000-000000000001'$$,'23514','immutable_identity','Tenant identity is immutable');
select throws_ok($$update public.contacts set display_name='Missing CAS version' where id='31000000-0000-4000-8000-000000000001'$$,'23514','version_required','Database requires aggregate version advance');
select throws_ok($$insert into public.leads(organization_id,contact_id,title,status,created_by) values('21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','Invalid closed','closed','01000000-0000-4000-8000-000000000001')$$,'23514',null,'Closed status requires outcome and timestamp');
select throws_ok($$insert into public.contact_emails values('21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',4,'test@example.test','test@example.test')$$,'23514',null,'Channels bounded at three by database');
select throws_ok($$insert into public.contact_emails values('21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',1,'test@example.test','forged@example.test')$$,'23514',null,'Email normalization cannot be caller forged');
select throws_ok($$update public.lead_attributions set campaign='Rewritten'$$,'23514','immutable_record','Attribution cannot be rewritten');
select throws_ok($$update public.crm_activities set details='{"display_name":"Later PII"}'$$,'23514','immutable_record','Historical activity cannot be rewritten');
update public.contacts set display_name='Current synthetic name',version=2 where id='31000000-0000-4000-8000-000000000001';
set local role authenticated;
select is(public.crm_get('21000000-0000-4000-8000-000000000001','lead','41000000-0000-4000-8000-000000000001')->'contact'->>'display_name','Current synthetic name','Lead resolves updated shared contact');
select is(public.crm_get('21000000-0000-4000-8000-000000000001','lead','41000000-0000-4000-8000-000000000001')->'attribution'->>'campaign','Original campaign','Contact edits leave attribution unchanged');
select is((select details from public.crm_activities where lead_id='41000000-0000-4000-8000-000000000001'),'{"channel":"manual"}'::jsonb,'Contact edits leave original activity accurate without contact PII');
reset role;

set local role authenticated;
select is(public.crm_get('21000000-0000-4000-8000-000000000001','lead','41000000-0000-4000-8000-000000000001')->>'current_assignee_id','01000000-0000-4000-8000-000000000002','Active generation is eligible');
reset role;
update public.organization_memberships set revoked_at=now() where organization_id='21000000-0000-4000-8000-000000000001' and user_id='01000000-0000-4000-8000-000000000002';
select is((select crm_assignment_generation from public.organization_memberships where organization_id='21000000-0000-4000-8000-000000000001' and user_id='01000000-0000-4000-8000-000000000002'),2,'Revocation advances generation');
set local role authenticated;
select ok((public.crm_get('21000000-0000-4000-8000-000000000001','lead','41000000-0000-4000-8000-000000000001')->>'current_assignee_id') is null,'Revocation immediately removes current assignment eligibility');
select is(public.crm_get('21000000-0000-4000-8000-000000000001','lead','41000000-0000-4000-8000-000000000001')->>'last_assigned_user_id','01000000-0000-4000-8000-000000000002','Historical assignment remains');
reset role;
update public.organization_memberships set revoked_at=null where organization_id='21000000-0000-4000-8000-000000000001' and user_id='01000000-0000-4000-8000-000000000002';
set local role authenticated;
select ok((public.crm_get('21000000-0000-4000-8000-000000000001','lead','41000000-0000-4000-8000-000000000001')->>'current_assignee_id') is null,'Rejoining never restores a stale assignment');
reset role;

select set_config('request.jwt.claims','{"sub":"01000000-0000-4000-8000-000000000003","session_id":"11000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.contacts),0::bigint,'Recovery credentials see no tenant CRM data');
select throws_ok($$select public.crm_get('21000000-0000-4000-8000-000000000001','contact','31000000-0000-4000-8000-000000000001')$$,'42501','unauthenticated','Recovery RPC cannot enter ordinary organization access');
select throws_ok($$select public.crm_intake_manual('21000000-0000-4000-8000-000000000001','{}','51000000-0000-4000-8000-000000000001')$$,'42501','unauthenticated','Recovery credentials cannot create leads');
select throws_ok($$select public.crm_import_execute('21000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','[]')$$,'42501','unauthenticated','Recovery credentials cannot execute an import');
select throws_ok($$select public.crm_preview_candidates('21000000-0000-4000-8000-000000000001','[]')$$,'42501','unauthenticated','Recovery credentials cannot use candidate matching');
reset role;
select * from finish();
rollback;

-- Keep row scope as UUID equality so the planner can use tenant statistics and
-- existing composite indexes. Authorization is live, once per SQL statement for
-- this one scoped organization; it is never cached across statements/requests.
-- crm_context still takes SHARE and rechecks after waiting; member mutations
-- still take UPDATE. The helper remains VOLATILE, including its session fence.
-- A caller-set scope alone is insufficient: member_role independently checks it.
-- Browser and private-ledger policies, all role attributes/grants and function
-- owners are unchanged. No index builds or table rewrites are needed.
do $$
declare relation text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach relation in array array['contacts','contact_emails','contact_phones','lead_sources','leads','lead_attributions','crm_activities'] loop
  execute format($policy$
   alter policy crm_execution on public.%I
   using (
    organization_id=nullif((select current_setting('leadsfam.organization_id',true)),'')::uuid
    and (select private.member_role(nullif((select current_setting('leadsfam.organization_id',true)),'')::uuid)) is not null
   )
   with check (
    organization_id=nullif((select current_setting('leadsfam.organization_id',true)),'')::uuid
    and (select private.member_role(nullif((select current_setting('leadsfam.organization_id',true)),'')::uuid)) is not null
   )
  $policy$,relation);
 end loop;
end $$;

-- PostgREST hoists this setting before starting its RPC statement, bounding
-- server work before the five-second transport deadline. Setting it only inside
-- PL/pgSQL would not rearm PostgreSQL's already-running statement timer.
-- Direct SQL consumers must also set their own statement deadline (the runtime
-- pool already does); synchronous writes retain their existing retry contract.
alter function public.crm_query(uuid,text,jsonb,jsonb) set statement_timeout='4s';
notify pgrst,'reload schema';

-- Evaluate only the request-constant scope once. Keep current membership and
-- application-session checks volatile; never cache an authorization decision.
do $$ declare relation text; begin
 foreach relation in array array['contacts','contact_emails','contact_phones','lead_sources','leads','lead_attributions','crm_activities'] loop
  execute format('alter policy crm_execution on public.%I using(organization_id::text=(select current_setting(''leadsfam.organization_id'',true)) and private.member_role(organization_id) is not null) with check(organization_id::text=(select current_setting(''leadsfam.organization_id'',true)) and private.member_role(organization_id) is not null)',relation);
 end loop;
 foreach relation in array array['crm_request_receipts','lead_import_jobs','lead_import_attempts','lead_import_rows'] loop
  execute format('alter policy crm_execution on private.%I using(organization_id::text=(select current_setting(''leadsfam.organization_id'',true)) and private.member_role(organization_id) %s) with check(organization_id::text=(select current_setting(''leadsfam.organization_id'',true)) and private.member_role(organization_id) %s)',relation,case when relation='crm_request_receipts' then 'is not null' else 'in (''owner'',''admin'')' end,case when relation='crm_request_receipts' then 'is not null' else 'in (''owner'',''admin'')' end);
 end loop;
end $$;

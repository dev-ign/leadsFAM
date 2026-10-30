-- Qualify result columns separately from the PL/pgSQL output variable.
create or replace function private.crm_import_status(p_org uuid,p_job uuid default null,p_attempt uuid default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; deliveries jsonb; attempts jsonb;
begin
 perform private.crm_context(p_org,'import');
 if p_job is null then
  select coalesce(jsonb_agg(to_jsonb(j) order by j.created_at desc,j.id desc),'[]') into result from (select id,created_at from private.lead_import_jobs where organization_id=p_org order by created_at desc,id desc limit 25) j;
  return jsonb_build_object('jobs',result);
 end if;
 perform 1 from private.lead_import_jobs where organization_id=p_org and id=p_job;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 if p_attempt is not null then
  select jsonb_build_object('jobId',p_job,'attemptId',a.id,'rows',a.result) into result from private.lead_import_attempts a where organization_id=p_org and job_id=p_job and id=p_attempt;
  if result is null then raise exception using errcode='42501',message='not_found'; end if;
  return result;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('deliveryId',delivery_id,'rowNumber',row_number,'status',case when lead_id is null then 'pending' else 'succeeded' end,'leadId',lead_id,'contactId',contact_id) order by row_number),'[]') into deliveries from private.lead_import_rows where organization_id=p_org and job_id=p_job;
 select coalesce(jsonb_agg(jsonb_build_object('attemptId',a.id,'rows',a.result,'createdAt',a.created_at) order by a.created_at desc,a.id desc),'[]') into attempts from (select s.id,s.result,s.created_at from private.lead_import_attempts s where s.organization_id=p_org and s.job_id=p_job order by s.created_at desc,s.id desc limit 10) a;
 return jsonb_build_object('jobId',p_job,'deliveries',deliveries,'attempts',attempts);
end $$;


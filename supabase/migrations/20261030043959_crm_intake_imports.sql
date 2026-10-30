-- The ADR 0011 executable reference contract passed before this execution path.
-- A delivery is claimed even when its first attempt fails. It can finalize once.
alter table private.lead_import_rows alter column fingerprint drop not null,alter column contact_id drop not null,alter column lead_id drop not null,alter column attempt_id drop not null;
alter table private.lead_import_rows add unique(organization_id,delivery_id),add unique(organization_id,job_id,row_number),add constraint crm_delivery_completion check(
 (fingerprint is null and contact_id is null and lead_id is null and attempt_id is null) or
 (fingerprint is not null and contact_id is not null and lead_id is not null and attempt_id is not null));
grant update(id) on private.lead_import_jobs to leadsfam_crm;
grant update(fingerprint,contact_id,lead_id,attempt_id) on private.lead_import_rows to leadsfam_crm;
create function private.crm_delivery_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception using errcode='23514',message='immutable_record'; end if;
 if old.lead_id is not null or new.organization_id<>old.organization_id or new.job_id<>old.job_id or new.delivery_id<>old.delivery_id or new.row_number<>old.row_number or new.created_at<>old.created_at or new.lead_id is null then raise exception using errcode='23514',message='immutable_delivery'; end if;
 return new;
end $$;
revoke all on function private.crm_delivery_immutable() from public,anon,authenticated,service_role,leadsfam_runtime;
drop trigger crm_immutable on private.lead_import_rows;
create trigger crm_delivery_immutable before update or delete on private.lead_import_rows for each row execute function private.crm_delivery_immutable();
alter table public.lead_attributions add constraint crm_landing_no_credentials check(landing_url is null or landing_url !~ '^https?://[^/]*@');
alter table public.lead_attributions add constraint crm_claimed_date_range check(claimed_acquired_at is null or claimed_acquired_at between '1900-01-01Z'::timestamptz and '2100-01-01Z'::timestamptz);

create function private.crm_intake(p_org uuid,p_data jsonb,p_key uuid,p_channel text) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare actor uuid; contact uuid; target public.leads; receipt private.crm_request_receipts; fingerprint text; source uuid; item jsonb;
begin
 actor:=private.crm_context(p_org,'write');
 if p_key is null or p_channel not in ('manual','csv') then raise exception using errcode='22023',message='invalid_fields'; end if;
 perform private.crm_keys(p_data,array['contact','lead','attribution'],array['contact','lead','attribution']);
 perform private.crm_keys(p_data->'lead',array['title','description','priority'],array['title','description','priority']);
 if exists(select 1 from jsonb_each(p_data->'lead') where jsonb_typeof(value)<>'string') then raise exception using errcode='22023',message='invalid_fields'; end if;
 perform private.crm_keys(p_data->'attribution',array['sourceId','provider','externalReference','campaign','utmSource','utmMedium','landingUrl','acquiredAt']);
 if exists(select 1 from jsonb_each(p_data->'attribution') where jsonb_typeof(value) not in ('string','null')) then raise exception using errcode='22023',message='invalid_fields'; end if;
 fingerprint:=private.crm_fingerprint(jsonb_build_object('channel',p_channel,'input',p_data));
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':intake:'||p_channel||':'||p_key::text,0));
 select * into receipt from private.crm_request_receipts where organization_id=p_org and operation='lead_intake' and namespace=p_channel and request_key=p_key;
 if found then
  if receipt.fingerprint<>fingerprint then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
  return private.crm_lead_json(p_org,receipt.lead_id);
 end if;
 item:=p_data->'contact';
 if item->>'mode'='existing' then
  perform private.crm_keys(item,array['mode','id'],array['mode','id']);
  select id into contact from public.contacts where organization_id=p_org and id=(item->>'id')::uuid and archived_at is null for update;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
 elsif item->>'mode'='create' then
  perform private.crm_keys(item,array['mode','data'],array['mode','data']);
  contact:=(private.crm_save_contact(p_org,'create',item->'data',null,null,p_key)->>'id')::uuid;
 else raise exception using errcode='22023',message='invalid_fields'; end if;
 source:=(p_data->'attribution'->>'sourceId')::uuid;
 if source is not null then
  perform 1 from public.lead_sources where organization_id=p_org and id=source and archived_at is null for share;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
 end if;
 insert into public.leads(organization_id,contact_id,title,description,priority,created_by)
 values(p_org,contact,btrim(p_data->'lead'->>'title'),p_data->'lead'->>'description',p_data->'lead'->>'priority',actor) returning * into target;
 item:=p_data->'attribution';
 insert into public.lead_attributions(organization_id,lead_id,source_id,channel,provider,external_reference,campaign,utm_source,utm_medium,landing_url,claimed_acquired_at)
 values(p_org,target.id,source,p_channel,item->>'provider',item->>'externalReference',item->>'campaign',item->>'utmSource',item->>'utmMedium',item->>'landingUrl',(item->>'acquiredAt')::timestamptz);
 perform private.crm_event(p_org,actor,target.id,null,'lead.created',jsonb_build_object('channel',p_channel,'sourceId',source));
 insert into private.crm_request_receipts(organization_id,operation,namespace,request_key,fingerprint,contact_id,lead_id) values(p_org,'lead_intake',p_channel,p_key,fingerprint,contact,target.id);
 return private.crm_lead_json(p_org,target.id);
end $$;
create function private.crm_intake_manual(p_org uuid,p_data jsonb,p_key uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin return private.crm_intake(p_org,p_data,p_key,'manual'); end $$;

create function private.crm_import_execute(p_org uuid,p_job uuid,p_attempt uuid,p_rows jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; fingerprint text; previous private.lead_import_attempts; delivery private.lead_import_rows; item jsonb; row_fingerprint text; lead jsonb; result jsonb:='[]'; row_result jsonb; code text; reason text;
begin
 actor:=private.crm_context(p_org,'import');
 if p_job is null or p_attempt is null or p_rows is null or jsonb_typeof(p_rows)<>'array' then raise exception using errcode='22023',message='invalid_manifest'; end if;
 if jsonb_array_length(p_rows) not between 1 and 100 or octet_length(p_rows::text)>524288 then raise exception using errcode='22023',message='invalid_manifest'; end if;
 fingerprint:=private.crm_fingerprint(p_rows);
 insert into private.lead_import_jobs(organization_id,id,created_by) values(p_org,p_job,actor) on conflict do nothing;
 perform 1 from private.lead_import_jobs where organization_id=p_org and id=p_job for update;
 select * into previous from private.lead_import_attempts where organization_id=p_org and job_id=p_job and id=p_attempt;
 if found then
  if previous.fingerprint<>fingerprint then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
  return jsonb_build_object('jobId',p_job,'attemptId',p_attempt,'rows',previous.result);
 end if;
 if (select count(distinct value->>'deliveryId')<>count(*) or count(distinct value->>'rowNumber')<>count(*) from jsonb_array_elements(p_rows)) then raise exception using errcode='22023',message='invalid_manifest'; end if;
 -- Globally ordered claims prevent two jobs claiming overlapping UUID sets in
 -- opposite order. Job/row identities are checked before executing any intake.
 for item in select value from jsonb_array_elements(p_rows) order by value->>'deliveryId' loop
  perform private.crm_keys(item,array['deliveryId','rowNumber','intake'],array['deliveryId','rowNumber','intake']);
  if jsonb_typeof(item->'deliveryId')<>'string' or jsonb_typeof(item->'rowNumber')<>'number' or (item->>'rowNumber') !~ '^[0-9]{1,3}$' or (item->>'rowNumber')::integer not between 1 and 100 then raise exception using errcode='22023',message='invalid_manifest'; end if;
  select * into delivery from private.lead_import_rows where organization_id=p_org and delivery_id=(item->>'deliveryId')::uuid;
  if found then
   if delivery.job_id<>p_job then raise exception using errcode='P0001',message='delivery_job_conflict'; end if;
   if delivery.row_number<>(item->>'rowNumber')::integer then raise exception using errcode='22023',message='invalid_manifest'; end if;
  else
   if exists(select 1 from private.lead_import_rows where organization_id=p_org and job_id=p_job and row_number=(item->>'rowNumber')::integer) then raise exception using errcode='22023',message='invalid_manifest'; end if;
   begin
    insert into private.lead_import_rows(organization_id,job_id,delivery_id,row_number) values(p_org,p_job,(item->>'deliveryId')::uuid,(item->>'rowNumber')::integer) on conflict(organization_id,delivery_id) do nothing;
   exception when unique_violation then raise exception using errcode='22023',message='invalid_manifest'; end;
   select * into delivery from private.lead_import_rows where organization_id=p_org and delivery_id=(item->>'deliveryId')::uuid;
   if delivery.job_id<>p_job then raise exception using errcode='P0001',message='delivery_job_conflict'; end if;
  end if;
 end loop;
 -- Prelock all existing contacts in UUID order before row execution. Two jobs
 -- with reversed row order must not lock the same contacts in opposite order.
 perform 1 from public.contacts where organization_id=p_org and id in (
  select case when value->'intake'->'contact'->>'mode'='existing' and value->'intake'->'contact'->>'id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then (value->'intake'->'contact'->>'id')::uuid else null end from jsonb_array_elements(p_rows)
 ) order by id for update;
 perform 1 from public.lead_sources where organization_id=p_org and id in (
  select case when value->'intake'->'attribution'->>'sourceId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then (value->'intake'->'attribution'->>'sourceId')::uuid else null end from jsonb_array_elements(p_rows)
 ) order by id for share;
 for item in select value from jsonb_array_elements(p_rows) loop
  select * into delivery from private.lead_import_rows where organization_id=p_org and job_id=p_job and delivery_id=(item->>'deliveryId')::uuid;
  row_fingerprint:=private.crm_fingerprint(item->'intake');
  row_result:=jsonb_build_object('deliveryId',delivery.delivery_id,'rowNumber',delivery.row_number);
  if delivery.lead_id is not null then
   if delivery.fingerprint=row_fingerprint then row_result:=row_result||jsonb_build_object('status','succeeded','contactId',delivery.contact_id,'leadId',delivery.lead_id);
   else row_result:=row_result||jsonb_build_object('status','failed','code','DELIVERY_ALREADY_SUCCEEDED'); end if;
  else
   begin
    lead:=private.crm_intake(p_org,item->'intake',delivery.delivery_id,'csv');
    update private.lead_import_rows set fingerprint=row_fingerprint,contact_id=(lead->>'contact_id')::uuid,lead_id=(lead->>'id')::uuid,attempt_id=p_attempt where organization_id=p_org and job_id=p_job and delivery_id=delivery.delivery_id;
    row_result:=row_result||jsonb_build_object('status','succeeded','contactId',lead->>'contact_id','leadId',lead->>'id');
   exception when sqlstate '22023' or sqlstate '22P02' or sqlstate '23502' or sqlstate '23503' or sqlstate '23505' or sqlstate '23514' or sqlstate 'P0001' or sqlstate '42501' then
    get stacked diagnostics code=returned_sqlstate,reason=message_text;
    if reason='unauthenticated' then raise; end if;
    row_result:=row_result||jsonb_build_object('status','failed','code',case when reason='duplicate_review_required' then 'DUPLICATE_REVIEW_REQUIRED' when reason='not_found' then 'NOT_FOUND' when reason='idempotency_conflict' then 'IDEMPOTENCY_CONFLICT' when reason='forbidden' then 'FORBIDDEN' else 'INVALID_FIELDS' end);
   end;
  end if;
  result:=result||jsonb_build_array(row_result);
 end loop;
 insert into private.lead_import_attempts(organization_id,job_id,id,fingerprint,result,created_by) values(p_org,p_job,p_attempt,fingerprint,result,actor);
 return jsonb_build_object('jobId',p_job,'attemptId',p_attempt,'rows',result);
end $$;

create function private.crm_import_status(p_org uuid,p_job uuid default null,p_attempt uuid default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
 select coalesce(jsonb_agg(jsonb_build_object('attemptId',a.id,'rows',a.result,'createdAt',a.created_at) order by a.created_at desc,a.id desc),'[]') into attempts from (select id,result,created_at from private.lead_import_attempts where organization_id=p_org and job_id=p_job order by created_at desc,id desc limit 10) a;
 return jsonb_build_object('jobId',p_job,'deliveries',deliveries,'attempts',attempts);
end $$;

grant create on schema private to leadsfam_crm;
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('crm_intake','crm_intake_manual','crm_import_execute','crm_import_status') loop
  execute format('alter function %s owner to leadsfam_crm',fn.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,leadsfam_runtime',fn.signature);
 end loop;
end $$;
revoke create on schema private from leadsfam_crm;
create function public.crm_intake_manual(p_org uuid,p_data jsonb,p_key uuid) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_intake_manual(p_org,p_data,p_key) $$;
create function public.crm_import_execute(p_org uuid,p_job uuid,p_attempt uuid,p_rows jsonb) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_import_execute(p_org,p_job,p_attempt,p_rows) $$;
create function public.crm_import_status(p_org uuid,p_job uuid default null,p_attempt uuid default null) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_import_status(p_org,p_job,p_attempt) $$;
revoke all on function public.crm_intake_manual(uuid,jsonb,uuid),public.crm_import_execute(uuid,uuid,uuid,jsonb),public.crm_import_status(uuid,uuid,uuid) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.crm_intake_manual(uuid,jsonb,uuid),public.crm_import_execute(uuid,uuid,uuid,jsonb),public.crm_import_status(uuid,uuid,uuid),private.crm_intake_manual(uuid,jsonb,uuid),private.crm_import_execute(uuid,uuid,uuid,jsonb),private.crm_import_status(uuid,uuid,uuid) to authenticated;

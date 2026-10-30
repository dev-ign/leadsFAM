create function private.crm_batch_duplicate(p_rows jsonb,p_item jsonb) returns boolean language sql immutable security invoker set search_path='' as $$
 select exists(select 1 from jsonb_array_elements(p_rows) r where r.value->>'deliveryId'<>p_item->>'deliveryId' and r.value->'intake'->'contact'->>'mode'='create' and (
  lower(btrim(r.value->'intake'->'contact'->'data'->>'displayName'))=lower(btrim(p_item->'intake'->'contact'->'data'->>'displayName')) or
  exists(select 1 from jsonb_array_elements(case when jsonb_typeof(r.value->'intake'->'contact'->'data'->'emails')='array' then r.value->'intake'->'contact'->'data'->'emails' else '[]' end) a join jsonb_array_elements(p_item->'intake'->'contact'->'data'->'emails') b on a.value->>'normalized'=b.value->>'normalized') or
  exists(select 1 from jsonb_array_elements(case when jsonb_typeof(r.value->'intake'->'contact'->'data'->'phones')='array' then r.value->'intake'->'contact'->'data'->'phones' else '[]' end) a join jsonb_array_elements(p_item->'intake'->'contact'->'data'->'phones') b on a.value->>'normalized'=b.value->>'normalized')
 ))
$$;
grant create on schema private to leadsfam_crm;
alter function private.crm_batch_duplicate(jsonb,jsonb) owner to leadsfam_crm;
revoke create on schema private from leadsfam_crm;
revoke all on function private.crm_batch_duplicate(jsonb,jsonb) from public,anon,authenticated,service_role,leadsfam_runtime;

-- Serialize the check/insert pair for conservative contact candidate review.
create or replace function private.crm_save_contact(p_org uuid,p_action text,p_data jsonb,p_id uuid default null,p_version integer default null,p_key uuid default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; target public.contacts; receipt private.crm_request_receipts; fingerprint text;
begin
 actor:=private.crm_context(p_org,case when p_action in ('archive','restore') then 'manage' else 'write' end);
 if p_action not in ('create','update','archive','restore') or p_action is null then raise exception using errcode='22023',message='invalid_action'; end if;
 if p_action='create' then
  if p_key is null or p_id is not null or p_version is not null then raise exception using errcode='22023',message='invalid_fields'; end if;
  perform private.crm_validate_contact(p_data);
  perform pg_advisory_xact_lock(hashtextextended(p_org::text||':contact-create',0));
  fingerprint:=private.crm_fingerprint(p_data);
  -- No existing contact/lead lock is held for this creation-only receipt lock.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text||':contact:'||p_key::text,0));
  select * into receipt from private.crm_request_receipts where organization_id=p_org and operation='contact_create' and namespace='manual' and request_key=p_key;
  if found then
   if receipt.fingerprint<>fingerprint then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
   return private.crm_contact_json(p_org,receipt.contact_id);
  end if;
  if jsonb_array_length(private.crm_matches(p_org,p_data))>0 and coalesce(p_data->>'duplicateResolution','')<>'create_distinct' then raise exception using errcode='P0001',message='duplicate_review_required'; end if;
  insert into public.contacts(organization_id,kind,display_name,first_name,last_name,company_name,created_by)
   values(p_org,p_data->>'kind',btrim(p_data->>'displayName'),coalesce(p_data->>'firstName',''),coalesce(p_data->>'lastName',''),coalesce(p_data->>'companyName',''),actor) returning * into target;
 elsif p_action='update' then
  perform private.crm_validate_contact(p_data);
  select * into target from public.contacts where organization_id=p_org and id=p_id for update;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
  if p_version is null or target.version<>p_version then raise exception using errcode='P0001',message='version_conflict'; end if;
  if target.archived_at is not null then raise exception using errcode='P0001',message='archived_record'; end if;
  update public.contacts set kind=p_data->>'kind',display_name=btrim(p_data->>'displayName'),first_name=coalesce(p_data->>'firstName',''),last_name=coalesce(p_data->>'lastName',''),company_name=coalesce(p_data->>'companyName',''),version=version+1 where organization_id=p_org and id=p_id returning * into target;
  delete from public.contact_emails where organization_id=p_org and contact_id=p_id;
  delete from public.contact_phones where organization_id=p_org and contact_id=p_id;
 else
  perform private.crm_keys(p_data,'{}');
  select * into target from public.contacts where organization_id=p_org and id=p_id for update;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
  if p_version is null or target.version<>p_version then raise exception using errcode='P0001',message='version_conflict'; end if;
  if (p_action='archive')=(target.archived_at is not null) then raise exception using errcode='P0001',message='invalid_transition'; end if;
  if p_action='archive' and exists(select 1 from public.leads where organization_id=p_org and contact_id=p_id and status<>'closed' and archived_at is null) then raise exception using errcode='P0001',message='contact_has_open_leads'; end if;
  update public.contacts set archived_at=case when p_action='archive' then clock_timestamp() else null end,version=version+1 where organization_id=p_org and id=p_id returning * into target;
 end if;
 if p_action in ('create','update') then
  insert into public.contact_emails(organization_id,contact_id,position,value,normalized) select p_org,target.id,n::smallint,item->>'value',item->>'normalized' from jsonb_array_elements(p_data->'emails') with ordinality a(item,n);
  insert into public.contact_phones(organization_id,contact_id,position,value,normalized) select p_org,target.id,n::smallint,item->>'value',item->>'normalized' from jsonb_array_elements(p_data->'phones') with ordinality a(item,n);
 end if;
 perform private.crm_event(p_org,actor,null,target.id,case p_action when 'create' then 'contact.created' when 'update' then 'contact.updated' when 'archive' then 'contact.archived' else 'contact.restored' end,
 case when p_action='update' then jsonb_build_object('fields',array['kind','displayName','firstName','lastName','companyName','emails','phones']) else '{}'::jsonb end);
 if p_action='create' then insert into private.crm_request_receipts(organization_id,operation,namespace,request_key,fingerprint,contact_id) values(p_org,'contact_create','manual',p_key,fingerprint,target.id); end if;
 return private.crm_contact_json(p_org,target.id);
end $$;


-- Review intra-batch matches before creating either ambiguous contact.
create or replace function private.crm_import_execute(p_org uuid,p_job uuid,p_attempt uuid,p_rows jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
    if item->'intake'->'contact'->>'mode'='create' then
     perform private.crm_validate_contact(item->'intake'->'contact'->'data');
     if coalesce(item->'intake'->'contact'->'data'->>'duplicateResolution','')<>'create_distinct' and private.crm_batch_duplicate(p_rows,item) then raise exception using errcode='P0001',message='duplicate_review_required'; end if;
    end if;
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


-- Keep useful SQLSTATEs, but never return/log a failing row containing PII.
-- PostgreSQL parameter logging must remain disabled in operational environments.
create function private.crm_source_bound() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text||':source-catalog',0));
 if (select count(*) from public.lead_sources where organization_id=new.organization_id)>=100 then raise exception using errcode='P0001',message='source_limit'; end if;
 return new;
end $$;
revoke all on function private.crm_source_bound() from public,anon,authenticated,service_role,leadsfam_runtime;
create trigger crm_source_bound before insert on public.lead_sources for each row execute function private.crm_source_bound();

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
  insert into public.contact_phones(organization_id,contact_id,position,value,normalized,region) select p_org,target.id,n::smallint,item->>'value',item->>'normalized',item->>'region' from jsonb_array_elements(p_data->'phones') with ordinality a(item,n);
 end if;
 perform private.crm_event(p_org,actor,null,target.id,case p_action when 'create' then 'contact.created' when 'update' then 'contact.updated' when 'archive' then 'contact.archived' else 'contact.restored' end,
 case when p_action='update' then jsonb_build_object('fields',array['kind','displayName','firstName','lastName','companyName','emails','phones']) else '{}'::jsonb end);
 if p_action='create' then insert into private.crm_request_receipts(organization_id,operation,namespace,request_key,fingerprint,contact_id) values(p_org,'contact_create','manual',p_key,fingerprint,target.id); end if;
 return private.crm_contact_json(p_org,target.id);
exception when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception using errcode=sqlstate,message=case when sqlstate='23505' then 'conflict' else 'invalid_fields' end;
end $$;

create or replace function private.crm_change_lead(p_org uuid,p_id uuid,p_version integer,p_action text,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; target public.leads; contact uuid; assignee uuid; generation integer; next_status text; reason text; details jsonb;
begin
 actor:=private.crm_context(p_org,case when p_action in ('archive','restore') or (p_action='transition' and p_data->>'status'='in_progress' and p_data ? 'reason') then 'manage' else 'write' end);
 if p_action is null or p_action not in ('update','transition','assign','archive','restore') then raise exception using errcode='22023',message='invalid_action'; end if;
 select contact_id into contact from public.leads where organization_id=p_org and id=p_id;
 if not found then raise exception using errcode='42501',message='not_found'; end if;
 perform 1 from public.contacts where organization_id=p_org and id=contact for update;
 select * into target from public.leads where organization_id=p_org and id=p_id for update;
 if p_version is null or target.version<>p_version then raise exception using errcode='P0001',message='version_conflict'; end if;
 if target.archived_at is not null and p_action<>'restore' then raise exception using errcode='P0001',message='archived_record'; end if;
 if p_action='update' then
  perform private.crm_keys(p_data,array['title','description','priority'],array['title','description','priority']);
  if target.status='closed' then raise exception using errcode='P0001',message='closed_record'; end if;
  if exists(select 1 from jsonb_each(p_data) where jsonb_typeof(value)<>'string') then raise exception using errcode='22023',message='invalid_fields'; end if;
  update public.leads set title=btrim(p_data->>'title'),description=p_data->>'description',priority=p_data->>'priority',version=version+1 where organization_id=p_org and id=p_id;
  details:=jsonb_build_object('fields',array['title','description','priority']);
 elsif p_action='transition' then
  perform private.crm_keys(p_data,array['status','outcome','reason'],array['status']);
  if exists(select 1 from jsonb_each(p_data) where jsonb_typeof(value)<>'string') then raise exception using errcode='22023',message='invalid_fields'; end if;
  next_status:=p_data->>'status'; reason:=p_data->>'reason';
  if next_status not in ('in_progress','qualified','closed') or next_status=target.status then raise exception using errcode='P0001',message='invalid_transition'; end if;
  if target.status='closed' then
   perform private.crm_context(p_org,'manage');
   if next_status<>'in_progress' or coalesce(char_length(btrim(reason)),0) not between 1 and 300 then raise exception using errcode='22023',message='reopen_reason_required'; end if;
  elsif reason is not null then raise exception using errcode='22023',message='invalid_fields'; end if;
  if next_status<>'closed' and p_data ? 'outcome' then raise exception using errcode='22023',message='invalid_fields'; end if;
  update public.leads set status=next_status,outcome=case when next_status='closed' then p_data->>'outcome' else null end,closed_at=case when next_status='closed' then clock_timestamp() else null end,version=version+1 where organization_id=p_org and id=p_id;
  -- Reason is acknowledged as present, not copied into an unrestricted PII bag.
  details:=jsonb_strip_nulls(jsonb_build_object('from',target.status,'to',next_status,'outcome',p_data->>'outcome','reasonProvided',reason is not null,'reason',reason));
 elsif p_action='assign' then
  perform private.crm_keys(p_data,array['userId'],array['userId']);
  if target.status='closed' then raise exception using errcode='P0001',message='closed_record'; end if;
  if jsonb_typeof(p_data->'userId') not in ('null','string') then raise exception using errcode='22023',message='invalid_fields'; end if;
  assignee:=(p_data->>'userId')::uuid;
  if private.member_role(p_org)='member' and ((assignee is not null and assignee<>actor) or (private.crm_member_generation(p_org,target.last_assigned_user_id)=target.assigned_membership_generation and target.last_assigned_user_id<>actor)) then raise exception using errcode='42501',message='forbidden'; end if;
  if assignee is not null then generation:=private.crm_member_generation(p_org,assignee); if generation is null then raise exception using errcode='42501',message='not_found'; end if; end if;
  update public.leads set last_assigned_user_id=assignee,assigned_membership_generation=generation,version=version+1 where organization_id=p_org and id=p_id;
  details:=jsonb_build_object('userId',assignee);
 else
  perform private.crm_keys(p_data,'{}');
  if (p_action='archive')=(target.archived_at is not null) then raise exception using errcode='P0001',message='invalid_transition'; end if;
  if p_action='restore' and exists(select 1 from public.contacts where organization_id=p_org and id=contact and archived_at is not null) then raise exception using errcode='P0001',message='archived_contact'; end if;
  update public.leads set archived_at=case when p_action='archive' then clock_timestamp() else null end,version=version+1 where organization_id=p_org and id=p_id;
  details:='{}';
 end if;
 perform private.crm_event(p_org,actor,p_id,null,case p_action when 'update' then 'lead.updated' when 'transition' then 'lead.transitioned' when 'assign' then 'lead.assigned' when 'archive' then 'lead.archived' else 'lead.restored' end,details);
 return private.crm_lead_json(p_org,p_id);
exception when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception using errcode=sqlstate,message=case when sqlstate='23505' then 'conflict' else 'invalid_fields' end;
end $$;

create or replace function private.crm_sources(p_org uuid,p_id uuid default null,p_version integer default null,p_data jsonb default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; target public.lead_sources; result jsonb;
begin
 actor:=private.crm_context(p_org,case when p_data is null then 'read' else 'manage' end);
 if p_data is null then
  select coalesce(jsonb_agg(to_jsonb(s) order by s.name,s.id),'[]') into result from public.lead_sources s where organization_id=p_org;
  return result;
 end if;
 perform private.crm_keys(p_data,array['name','archived'],array['name','archived']);
 if jsonb_typeof(p_data->'name')<>'string' or jsonb_typeof(p_data->'archived')<>'boolean' then raise exception using errcode='22023',message='invalid_fields'; end if;
 if p_id is null then
  if (p_data->>'archived')::boolean then raise exception using errcode='22023',message='invalid_fields'; end if;
  insert into public.lead_sources(organization_id,name,created_by) values(p_org,btrim(p_data->>'name'),actor) returning * into target;
 else
  select * into target from public.lead_sources where organization_id=p_org and id=p_id for update;
  if not found then raise exception using errcode='42501',message='not_found'; end if;
  if p_version is null or target.version<>p_version then raise exception using errcode='P0001',message='version_conflict'; end if;
  update public.lead_sources set name=btrim(p_data->>'name'),archived_at=case when (p_data->>'archived')::boolean then coalesce(archived_at,clock_timestamp()) else null end,version=version+1 where organization_id=p_org and id=p_id returning * into target;
 end if;
 return to_jsonb(target);
exception when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception using errcode=sqlstate,message=case when sqlstate='23505' then 'conflict' else 'invalid_fields' end;
end $$;

create or replace function private.crm_intake_manual(p_org uuid,p_data jsonb,p_key uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin return private.crm_intake(p_org,p_data,p_key,'manual'); exception when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception using errcode=sqlstate,message=case when sqlstate='23505' then 'conflict' else 'invalid_fields' end;
end $$;

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
exception when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception using errcode=sqlstate,message=case when sqlstate='23505' then 'conflict' else 'invalid_fields' end;
end $$;

create or replace function private.crm_query(p_org uuid,p_kind text,p_query jsonb,p_after jsonb default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; q text; pattern text; state text; wanted_priority text; source uuid; wanted_contact uuid; assignee text; assigned_user uuid; archive text; ordering text; start_date date; end_date date; page_size integer; next_time timestamptz; next_id uuid; after_time timestamptz; after_id uuid; r record; items jsonb:='[]'; more boolean:=false; field text;
begin
 actor:=private.crm_context(p_org,'read');
 if p_kind is null or p_kind not in ('contacts','leads') then raise exception using errcode='22023',message='invalid_kind'; end if;
 perform private.crm_keys(p_query,array['contactId','q','status','priority','sourceId','assignee','archived','from','to','sort','pageSize'],array['q','status','priority','sourceId','assignee','archived','from','to','sort','pageSize']);
 foreach field in array array['q','status','priority','assignee','archived','sort'] loop
  if jsonb_typeof(p_query->field)<>'string' then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 foreach field in array array['sourceId','from','to'] loop
  if jsonb_typeof(p_query->field) not in ('string','null') then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 if jsonb_typeof(p_query->'pageSize')<>'number' or (p_query->>'pageSize') !~ '^[0-9]{1,3}$' then raise exception using errcode='22023',message='invalid_fields'; end if;
 q:=btrim(p_query->>'q'); state:=p_query->>'status'; wanted_priority:=p_query->>'priority'; source:=(p_query->>'sourceId')::uuid; wanted_contact:=(p_query->>'contactId')::uuid; assignee:=p_query->>'assignee'; archive:=p_query->>'archived'; ordering:=p_query->>'sort'; page_size:=(p_query->>'pageSize')::integer;
 start_date:=(p_query->>'from')::date; end_date:=(p_query->>'to')::date;
 if char_length(q)>100 or page_size not between 1 and 100 or state not in ('all','new','in_progress','qualified','closed') or wanted_priority not in ('all','low','normal','high') or archive not in ('active','archived','all') or ordering not in ('created','activity') then raise exception using errcode='22023',message='invalid_fields'; end if;
 if (start_date is not null and (not isfinite(start_date) or start_date not between '1900-01-01'::date and '2100-01-01'::date)) or (end_date is not null and (not isfinite(end_date) or end_date not between '1900-01-01'::date and '2100-01-01'::date)) or start_date>end_date then raise exception using errcode='22023',message='invalid_fields'; end if;
 if assignee not in ('all','unassigned','mine') then assigned_user:=assignee::uuid; end if;
 if p_kind='contacts' and (state<>'all' or wanted_priority<>'all' or source is not null or assignee<>'all' or ordering<>'created' or wanted_contact is not null) then raise exception using errcode='22023',message='invalid_fields'; end if;
 perform private.crm_position(p_after);
 after_time:=(p_after->>'time')::timestamptz; after_id:=(p_after->>'id')::uuid;
 pattern:=replace(replace(replace(q,'!','!!'),'%','!%'),'_','!_')||'%';
 if char_length(q)>=3 then pattern:='%'||pattern; end if;
 if p_kind='contacts' then
  for r in select c.id,c.created_at ts from public.contacts c where c.organization_id=p_org
   and (archive='all' or (archive='active' and c.archived_at is null) or (archive='archived' and c.archived_at is not null))
   and (start_date is null or c.created_at>=(start_date::timestamp at time zone 'UTC')) and (end_date is null or c.created_at<((end_date+1)::timestamp at time zone 'UTC'))
   and (p_after is null or (c.created_at,c.id)<(after_time,after_id))
   and (q='' or c.display_name ilike pattern escape '!' or exists(select 1 from public.contact_emails e where e.organization_id=p_org and e.contact_id=c.id and e.normalized ilike pattern escape '!') or exists(select 1 from public.contact_phones p where p.organization_id=p_org and p.contact_id=c.id and (p.normalized ilike pattern escape '!' or p.value ilike pattern escape '!')))
   order by c.created_at desc,c.id desc limit page_size+1 loop
   if jsonb_array_length(items)=page_size then more:=true; exit; end if;
   items:=items||jsonb_build_array(private.crm_contact_json(p_org,r.id)); next_time:=r.ts; next_id:=r.id;
  end loop;
 else
  for r in select l.id,case when ordering='activity' then l.last_activity_at else l.created_at end ts from public.leads l where l.organization_id=p_org and (wanted_contact is null or l.contact_id=wanted_contact)
   and (archive='all' or (archive='active' and l.archived_at is null) or (archive='archived' and l.archived_at is not null))
   and (state='all' or l.status=state) and (wanted_priority='all' or l.priority=wanted_priority)
   and (source is null or exists(select 1 from public.lead_attributions a where a.organization_id=p_org and a.lead_id=l.id and a.source_id=source))
   and (assignee='all' or (assignee='unassigned' and (l.last_assigned_user_id is null or private.crm_member_generation(p_org,l.last_assigned_user_id) is distinct from l.assigned_membership_generation)) or (assignee='mine' and l.last_assigned_user_id=actor and private.crm_member_generation(p_org,actor)=l.assigned_membership_generation) or (assignee not in ('all','unassigned','mine') and l.last_assigned_user_id=assigned_user and private.crm_member_generation(p_org,l.last_assigned_user_id)=l.assigned_membership_generation))
   and (start_date is null or l.created_at>=(start_date::timestamp at time zone 'UTC')) and (end_date is null or l.created_at<((end_date+1)::timestamp at time zone 'UTC'))
   and (p_after is null or (case when ordering='activity' then l.last_activity_at else l.created_at end,l.id)<(after_time,after_id))
   and (q='' or l.title ilike pattern escape '!' or exists(select 1 from public.contacts c where c.organization_id=p_org and c.id=l.contact_id and (c.display_name ilike pattern escape '!' or exists(select 1 from public.contact_emails e where e.organization_id=p_org and e.contact_id=c.id and e.normalized ilike pattern escape '!') or exists(select 1 from public.contact_phones p where p.organization_id=p_org and p.contact_id=c.id and (p.normalized ilike pattern escape '!' or p.value ilike pattern escape '!')))))
   order by ts desc,l.id desc limit page_size+1 loop
   if jsonb_array_length(items)=page_size then more:=true; exit; end if;
   items:=items||jsonb_build_array(private.crm_lead_json(p_org,r.id)); next_time:=r.ts; next_id:=r.id;
  end loop;
 end if;
 return jsonb_build_object('items',items,'next',case when more then jsonb_build_object('time',next_time,'id',next_id) else null end);
exception when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception using errcode=sqlstate,message=case when sqlstate='23505' then 'conflict' else 'invalid_fields' end;
end $$;

create or replace function private.crm_activity(p_org uuid,p_kind text,p_id uuid,p_size integer default 25,p_after jsonb default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare contact uuid; r record; items jsonb:='[]'; more boolean:=false; next_time timestamptz; next_id uuid;
begin
 perform private.crm_context(p_org,'read');
 if p_size is null or p_size not between 1 and 100 then raise exception using errcode='22023',message='invalid_fields'; end if;
 perform private.crm_position(p_after);
 if p_kind='lead' then select contact_id into contact from public.leads where organization_id=p_org and id=p_id;
 elsif p_kind='contact' then select id into contact from public.contacts where organization_id=p_org and id=p_id;
 else raise exception using errcode='22023',message='invalid_kind'; end if;
 if contact is null then raise exception using errcode='42501',message='not_found'; end if;
 for r in select a.*,case when a.lead_id is null then 'contact' else 'lead' end subject from public.crm_activities a where a.organization_id=p_org
  and (a.contact_id=contact or (p_kind='lead' and a.lead_id=p_id) or (p_kind='contact' and exists(select 1 from public.leads l where l.organization_id=p_org and l.id=a.lead_id and l.contact_id=contact)))
  and (p_after is null or (a.created_at,a.id)<((p_after->>'time')::timestamptz,(p_after->>'id')::uuid))
  order by a.created_at desc,a.id desc limit p_size+1 loop
  if jsonb_array_length(items)=p_size then more:=true; exit; end if;
  items:=items||jsonb_build_array(to_jsonb(r)); next_time:=r.created_at; next_id:=r.id;
 end loop;
 return jsonb_build_object('items',items,'next',case when more then jsonb_build_object('time',next_time,'id',next_id) else null end);
exception when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception using errcode=sqlstate,message=case when sqlstate='23505' then 'conflict' else 'invalid_fields' end;
end $$;

create or replace function private.crm_validate_contact(p_data jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare item jsonb; field text;
begin
 if p_data is null or octet_length(p_data::text)>8192 then raise exception using errcode='22023',message='invalid_fields'; end if;
 perform private.crm_keys(p_data,array['kind','displayName','firstName','lastName','companyName','emails','phones','duplicateResolution'],array['kind','displayName','emails','phones']);
 foreach field in array array['kind','displayName','firstName','lastName','companyName','duplicateResolution'] loop
  if p_data ? field and jsonb_typeof(p_data->field)<>'string' then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 if p_data ? 'duplicateResolution' and p_data->>'duplicateResolution'<>'create_distinct' then raise exception using errcode='22023',message='invalid_resolution'; end if;
 if jsonb_typeof(p_data->'emails')<>'array' or jsonb_typeof(p_data->'phones')<>'array' or jsonb_array_length(p_data->'emails')>3 or jsonb_array_length(p_data->'phones')>3 then raise exception using errcode='22023',message='invalid_channels'; end if;
 if p_data->>'kind' not in ('person','company') or char_length(btrim(p_data->>'displayName')) not between 1 and 160 or char_length(coalesce(p_data->>'firstName',''))>80 or char_length(coalesce(p_data->>'lastName',''))>80 or char_length(coalesce(p_data->>'companyName',''))>160 or (p_data->>'kind'='company' and char_length(btrim(coalesce(p_data->>'companyName','')))=0) then raise exception using errcode='22023',message='invalid_fields'; end if;
 for item in select value from jsonb_array_elements(p_data->'emails') loop
  perform private.crm_keys(item,array['value','normalized'],array['value','normalized']);
  if char_length(item->>'value') not between 3 and 254 or item->>'normalized'<>lower(btrim(item->>'value')) or (item->>'normalized') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception using errcode='22023',message='invalid_channels'; end if;
  if jsonb_typeof(item->'value')<>'string' or jsonb_typeof(item->'normalized')<>'string' then raise exception using errcode='22023',message='invalid_channels'; end if;
 end loop;
 for item in select value from jsonb_array_elements(p_data->'phones') loop
  perform private.crm_keys(item,array['value','normalized','region'],array['value','normalized']);
  if item ? 'region' and jsonb_typeof(item->'region') not in ('string','null') then raise exception using errcode='22023',message='invalid_channels'; end if;
  if char_length(btrim(item->>'value')) not between 1 and 40 or (item->>'normalized' is not null and (item->>'normalized') !~ '^\+[1-9][0-9]{6,14}$') or (item->>'region' is not null and (item->>'region') !~ '^[A-Z]{2}$') then raise exception using errcode='22023',message='invalid_channels'; end if;
  if jsonb_typeof(item->'value')<>'string' or jsonb_typeof(item->'normalized') not in ('string','null') then raise exception using errcode='22023',message='invalid_channels'; end if;
 end loop;
end $$;

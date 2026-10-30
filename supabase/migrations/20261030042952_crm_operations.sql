-- Bounded business operations. All actors and tenant scopes come from ADR 0010.
create function private.crm_fingerprint(p_data jsonb) returns text language sql immutable security invoker set search_path='' as $$ select encode(sha256(convert_to(jsonb_build_object('schema',1,'data',p_data)::text,'UTF8')),'hex') $$;
create function private.crm_matches(p_org uuid,p_data jsonb,p_exclude uuid default null) returns jsonb language sql volatile security invoker set search_path='' as $$
 select coalesce(jsonb_agg(private.crm_contact_json(p_org,id)),'[]'::jsonb) from (
 select c.id from public.contacts c where c.organization_id=p_org and (p_exclude is null or c.id<>p_exclude) and (
 lower(btrim(c.display_name))=lower(btrim(p_data->>'displayName')) or
 exists(select 1 from public.contact_emails e where e.organization_id=p_org and e.contact_id=c.id and e.normalized in (select value->>'normalized' from jsonb_array_elements(p_data->'emails'))) or
 exists(select 1 from public.contact_phones p where p.organization_id=p_org and p.contact_id=c.id and p.normalized in (select value->>'normalized' from jsonb_array_elements(p_data->'phones'))))
 order by c.created_at,c.id limit 10) candidates
$$;
create function private.crm_validate_contact(p_data jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare item jsonb; field text;
begin
 perform private.crm_keys(p_data,array['kind','displayName','firstName','lastName','companyName','emails','phones','duplicateResolution'],array['kind','displayName','emails','phones']);
 foreach field in array array['kind','displayName','firstName','lastName','companyName','duplicateResolution'] loop
  if p_data ? field and jsonb_typeof(p_data->field)<>'string' then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 if p_data ? 'duplicateResolution' and p_data->>'duplicateResolution'<>'create_distinct' then raise exception using errcode='22023',message='invalid_resolution'; end if;
 if jsonb_typeof(p_data->'emails')<>'array' or jsonb_typeof(p_data->'phones')<>'array' or jsonb_array_length(p_data->'emails')>3 or jsonb_array_length(p_data->'phones')>3 then raise exception using errcode='22023',message='invalid_channels'; end if;
 for item in select value from jsonb_array_elements(p_data->'emails') loop
  perform private.crm_keys(item,array['value','normalized'],array['value','normalized']);
  if jsonb_typeof(item->'value')<>'string' or jsonb_typeof(item->'normalized')<>'string' then raise exception using errcode='22023',message='invalid_channels'; end if;
 end loop;
 for item in select value from jsonb_array_elements(p_data->'phones') loop
  perform private.crm_keys(item,array['value','normalized'],array['value','normalized']);
  if jsonb_typeof(item->'value')<>'string' or jsonb_typeof(item->'normalized') not in ('string','null') then raise exception using errcode='22023',message='invalid_channels'; end if;
 end loop;
end $$;
create function private.crm_save_contact(p_org uuid,p_action text,p_data jsonb,p_id uuid default null,p_version integer default null,p_key uuid default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; target public.contacts; receipt private.crm_request_receipts; fingerprint text;
begin
 actor:=private.crm_context(p_org,case when p_action in ('archive','restore') then 'manage' else 'write' end);
 if p_action not in ('create','update','archive','restore') or p_action is null then raise exception using errcode='22023',message='invalid_action'; end if;
 if p_action='create' then
  if p_key is null or p_id is not null or p_version is not null then raise exception using errcode='22023',message='invalid_fields'; end if;
  perform private.crm_validate_contact(p_data);
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

create function private.crm_change_lead(p_org uuid,p_id uuid,p_version integer,p_action text,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
  details:=jsonb_strip_nulls(jsonb_build_object('from',target.status,'to',next_status,'outcome',p_data->>'outcome','reasonProvided',reason is not null));
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
end $$;

create function private.crm_sources(p_org uuid,p_id uuid default null,p_version integer default null,p_data jsonb default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
end $$;

create function private.crm_candidates(p_org uuid,p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 perform private.crm_context(p_org,'read');
 perform private.crm_validate_contact(p_data);
 return private.crm_matches(p_org,p_data);
end $$;

grant create on schema private to leadsfam_crm;
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('crm_fingerprint','crm_matches','crm_validate_contact','crm_save_contact','crm_change_lead','crm_sources','crm_candidates') loop
  execute format('alter function %s owner to leadsfam_crm',fn.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,leadsfam_runtime',fn.signature);
 end loop;
end $$;
revoke create on schema private from leadsfam_crm;
create function public.crm_save_contact(p_org uuid,p_action text,p_data jsonb,p_id uuid default null,p_version integer default null,p_key uuid default null) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_save_contact(p_org,p_action,p_data,p_id,p_version,p_key) $$;
create function public.crm_change_lead(p_org uuid,p_id uuid,p_version integer,p_action text,p_data jsonb) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_change_lead(p_org,p_id,p_version,p_action,p_data) $$;
create function public.crm_sources(p_org uuid,p_id uuid default null,p_version integer default null,p_data jsonb default null) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_sources(p_org,p_id,p_version,p_data) $$;
create function public.crm_candidates(p_org uuid,p_data jsonb) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_candidates(p_org,p_data) $$;
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature,p.proname,p.proargtypes from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('crm_save_contact','crm_change_lead','crm_sources','crm_candidates') loop
  execute format('revoke all on function %s from public,anon,service_role,leadsfam_runtime',fn.signature);
  execute format('grant execute on function %s to authenticated',fn.signature);
 end loop;
end $$;
grant execute on function private.crm_save_contact(uuid,text,jsonb,uuid,integer,uuid),private.crm_change_lead(uuid,uuid,integer,text,jsonb),private.crm_sources(uuid,uuid,integer,jsonb),private.crm_candidates(uuid,jsonb) to authenticated;

-- Retain the explicit region hint so unrelated edits preserve phone matching.
alter table public.contact_phones add column region text check(region is null or region ~ '^[A-Z]{2}$');
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
end $$;



create or replace function private.crm_validate_contact(p_data jsonb) returns void language plpgsql security invoker set search_path='' as $$
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
  perform private.crm_keys(item,array['value','normalized','region'],array['value','normalized']);
  if item ? 'region' and jsonb_typeof(item->'region') not in ('string','null') then raise exception using errcode='22023',message='invalid_channels'; end if;
  if jsonb_typeof(item->'value')<>'string' or jsonb_typeof(item->'normalized') not in ('string','null') then raise exception using errcode='22023',message='invalid_channels'; end if;
 end loop;
end $$;

create or replace function private.crm_contact_json(p_org uuid,p_id uuid) returns jsonb language sql volatile security invoker set search_path='' as $$
 select to_jsonb(c)||jsonb_build_object(
 'emails',coalesce((select jsonb_agg(jsonb_build_object('value',e.value,'normalized',e.normalized) order by e.position) from public.contact_emails e where e.organization_id=c.organization_id and e.contact_id=c.id),'[]'::jsonb),
 'phones',coalesce((select jsonb_agg(jsonb_build_object('value',p.value,'normalized',p.normalized,'region',p.region) order by p.position) from public.contact_phones p where p.organization_id=c.organization_id and p.contact_id=c.id),'[]'::jsonb),
 'first_touch',(select jsonb_build_object('leadId',a.lead_id,'channel',a.channel,'sourceId',a.source_id,'campaign',a.campaign,'acceptedAt',a.accepted_at) from public.lead_attributions a join public.leads l on l.organization_id=a.organization_id and l.id=a.lead_id where l.organization_id=c.organization_id and l.contact_id=c.id order by a.accepted_at,a.lead_id limit 1))
 from public.contacts c where c.organization_id=p_org and c.id=p_id
$$;


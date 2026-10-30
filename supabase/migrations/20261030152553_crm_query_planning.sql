-- Parameter-specific plans retain all current RLS/session checks and owners.
-- No SQL identifiers or literal values are interpolated from user input.
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
  if coalesce(p_data->>'duplicateResolution','')<>'create_distinct' then
   if jsonb_array_length(private.crm_matches(p_org,p_data))>0 then raise exception using errcode='P0001',message='duplicate_review_required'; end if;
  end if;
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
  for r in execute $query$select c.id,c.created_at ts from public.contacts c where c.organization_id=$1
   and ($2='all' or ($2='active' and c.archived_at is null) or ($2='archived' and c.archived_at is not null))
   and ($3 is null or c.created_at>=($3::timestamp at time zone 'UTC')) and ($4 is null or c.created_at<(($4+1)::timestamp at time zone 'UTC'))
   and ($5 is null or (c.created_at,c.id)<($6,$7))
   and ($9='' or c.display_name ilike $8 escape '!' or exists(select 1 from public.contact_emails e where e.organization_id=$1 and e.contact_id=c.id and e.normalized ilike $8 escape '!') or exists(select 1 from public.contact_phones p where p.organization_id=$1 and p.contact_id=c.id and (p.normalized ilike $8 escape '!' or p.value ilike $8 escape '!')))
   order by c.created_at desc,c.id desc limit $10+1$query$ using p_org,archive,start_date,end_date,p_after,after_time,after_id,pattern,q,page_size,state,wanted_priority,source,assignee,actor,assigned_user,ordering,wanted_contact loop
   if jsonb_array_length(items)=page_size then more:=true; exit; end if;
   items:=items||jsonb_build_array(private.crm_contact_json(p_org,r.id)); next_time:=r.ts; next_id:=r.id;
  end loop;
 else
  for r in execute $query$select l.id,case when $17='activity' then l.last_activity_at else l.created_at end ts from public.leads l where l.organization_id=$1 and ($18 is null or l.contact_id=$18)
   and ($2='all' or ($2='active' and l.archived_at is null) or ($2='archived' and l.archived_at is not null))
   and ($11='all' or l.status=$11) and ($12='all' or l.priority=$12)
   and ($13 is null or exists(select 1 from public.lead_attributions a where a.organization_id=$1 and a.lead_id=l.id and a.source_id=$13))
   and ($14='all' or ($14='unassigned' and (l.last_assigned_user_id is null or private.crm_member_generation($1,l.last_assigned_user_id) is distinct from l.assigned_membership_generation)) or ($14='mine' and l.last_assigned_user_id=$15 and private.crm_member_generation($1,$15)=l.assigned_membership_generation) or ($14 not in ('all','unassigned','mine') and l.last_assigned_user_id=$16 and private.crm_member_generation($1,l.last_assigned_user_id)=l.assigned_membership_generation))
   and ($3 is null or l.created_at>=($3::timestamp at time zone 'UTC')) and ($4 is null or l.created_at<(($4+1)::timestamp at time zone 'UTC'))
   and ($5 is null or (case when $17='activity' then l.last_activity_at else l.created_at end,l.id)<($6,$7))
   and ($9='' or l.title ilike $8 escape '!' or exists(select 1 from public.contacts c where c.organization_id=$1 and c.id=l.contact_id and (c.display_name ilike $8 escape '!' or exists(select 1 from public.contact_emails e where e.organization_id=$1 and e.contact_id=c.id and e.normalized ilike $8 escape '!') or exists(select 1 from public.contact_phones p where p.organization_id=$1 and p.contact_id=c.id and (p.normalized ilike $8 escape '!' or p.value ilike $8 escape '!')))))
   order by ts desc,l.id desc limit $10+1$query$ using p_org,archive,start_date,end_date,p_after,after_time,after_id,pattern,q,page_size,state,wanted_priority,source,assignee,actor,assigned_user,ordering,wanted_contact loop
   if jsonb_array_length(items)=page_size then more:=true; exit; end if;
   items:=items||jsonb_build_array(private.crm_lead_json(p_org,r.id)); next_time:=r.ts; next_id:=r.id;
  end loop;
 end if;
 return jsonb_build_object('items',items,'next',case when more then jsonb_build_object('time',next_time,'id',next_id) else null end);
exception when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception using errcode=sqlstate,message=case when sqlstate='23505' then 'conflict' else 'invalid_fields' end;
end $$;

-- Indexable prefix search; all role grants, session checks and RLS stay intact.
alter table public.contacts add column search_name text generated always as (lower(btrim(display_name))) stored;
alter table public.leads add column search_title text generated always as (lower(btrim(title))) stored;
create index contacts_prefix_idx on public.contacts using spgist(search_name);
create index leads_prefix_idx on public.leads using spgist(search_title);
create index contact_emails_prefix_idx on public.contact_emails using spgist(normalized);
create index contact_phones_prefix_idx on public.contact_phones using spgist(normalized) where normalized is not null;
create or replace function private.crm_contact_json(p_org uuid,p_id uuid) returns jsonb language sql volatile security invoker set search_path='' as $$
 select (to_jsonb(c)-'search_name')||jsonb_build_object(
 'emails',coalesce((select jsonb_agg(jsonb_build_object('value',e.value,'normalized',e.normalized) order by e.position) from public.contact_emails e where e.organization_id=c.organization_id and e.contact_id=c.id),'[]'::jsonb),
 'phones',coalesce((select jsonb_agg(jsonb_build_object('value',p.value,'normalized',p.normalized,'region',p.region) order by p.position) from public.contact_phones p where p.organization_id=c.organization_id and p.contact_id=c.id),'[]'::jsonb),
 'first_touch',(select jsonb_build_object('leadId',a.lead_id,'channel',a.channel,'sourceId',a.source_id,'campaign',a.campaign,'acceptedAt',a.accepted_at) from public.lead_attributions a join public.leads l on l.organization_id=a.organization_id and l.id=a.lead_id where l.organization_id=c.organization_id and l.contact_id=c.id order by a.accepted_at,a.lead_id limit 1))
 from public.contacts c where c.organization_id=p_org and c.id=p_id
$$;


create or replace function private.crm_lead_json(p_org uuid,p_id uuid) returns jsonb language sql volatile security invoker set search_path='' as $$
 select (to_jsonb(l)-'search_title')||jsonb_build_object('contact',private.crm_contact_json(l.organization_id,l.contact_id),'current_assignee_id',case when private.crm_member_generation(l.organization_id,l.last_assigned_user_id)=l.assigned_membership_generation then l.last_assigned_user_id else null end,'attribution',(select to_jsonb(a) from public.lead_attributions a where a.organization_id=l.organization_id and a.lead_id=l.id))
 from public.leads l where l.organization_id=p_org and l.id=p_id
$$;
create or replace function private.crm_query(p_org uuid,p_kind text,p_query jsonb,p_after jsonb default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; q text; pattern text; state text; wanted_priority text; source uuid; wanted_contact uuid; assignee text; assigned_user uuid; archive text; ordering text; start_date date; end_date date; page_size integer; next_time timestamptz; next_id uuid; after_time timestamptz; after_id uuid; r record; items jsonb:='[]'; more boolean:=false; field text; search_mode text; prefix text;
begin
 actor:=private.crm_context(p_org,'read');
 if p_kind is null or p_kind not in ('contacts','leads') then raise exception using errcode='22023',message='invalid_kind'; end if;
 perform private.crm_keys(p_query,array['searchMode','contactId','q','status','priority','sourceId','assignee','archived','from','to','sort','pageSize'],array['q','status','priority','sourceId','assignee','archived','from','to','sort','pageSize']);
 foreach field in array array['q','status','priority','assignee','archived','sort'] loop
  if jsonb_typeof(p_query->field)<>'string' then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 foreach field in array array['sourceId','from','to'] loop
  if jsonb_typeof(p_query->field) not in ('string','null') then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 if jsonb_typeof(p_query->'pageSize')<>'number' or (p_query->>'pageSize') !~ '^[0-9]{1,3}$' then raise exception using errcode='22023',message='invalid_fields'; end if;
 q:=btrim(p_query->>'q'); search_mode:=coalesce(p_query->>'searchMode','prefix'); prefix:=lower(q);
 if search_mode not in ('prefix','contains') then raise exception using errcode='22023',message='invalid_fields'; end if; state:=p_query->>'status'; wanted_priority:=p_query->>'priority'; source:=(p_query->>'sourceId')::uuid; wanted_contact:=(p_query->>'contactId')::uuid; assignee:=p_query->>'assignee'; archive:=p_query->>'archived'; ordering:=p_query->>'sort'; page_size:=(p_query->>'pageSize')::integer;
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
  for r in execute $query$with contact_matches as materialized (
 select id from public.contacts where organization_id=$1 and $9<>'' and (($19='prefix' and starts_with(search_name,$20)) or ($19='contains' and display_name ilike $8 escape '!'))
 union
 select contact_id from public.contact_emails where organization_id=$1 and $9<>'' and (($19='prefix' and starts_with(normalized,$20)) or ($19='contains' and normalized ilike $8 escape '!'))
 union
 select contact_id from public.contact_phones where organization_id=$1 and $9<>'' and (($19='prefix' and starts_with(normalized,$20)) or ($19='contains' and (normalized ilike $8 escape '!' or value ilike $8 escape '!')))
 )
 select c.id,c.created_at ts from public.contacts c where c.organization_id=$1
   and ($2='all' or ($2='active' and c.archived_at is null) or ($2='archived' and c.archived_at is not null))
   and ($3 is null or c.created_at>=($3::timestamp at time zone 'UTC')) and ($4 is null or c.created_at<(($4+1)::timestamp at time zone 'UTC'))
   and ($5 is null or (c.created_at,c.id)<($6,$7))
   and ($9='' or c.id in (select id from contact_matches))
   order by c.created_at desc,c.id desc limit $10+1$query$ using p_org,archive,start_date,end_date,p_after,after_time,after_id,pattern,q,page_size,state,wanted_priority,source,assignee,actor,assigned_user,ordering,wanted_contact,search_mode,prefix loop
   if jsonb_array_length(items)=page_size then more:=true; exit; end if;
   items:=items||jsonb_build_array(private.crm_contact_json(p_org,r.id)); next_time:=r.ts; next_id:=r.id;
  end loop;
 else
  for r in execute $query$with contact_matches as materialized (
 select id from public.contacts where organization_id=$1 and $9<>'' and (($19='prefix' and starts_with(search_name,$20)) or ($19='contains' and display_name ilike $8 escape '!'))
 union
 select contact_id from public.contact_emails where organization_id=$1 and $9<>'' and (($19='prefix' and starts_with(normalized,$20)) or ($19='contains' and normalized ilike $8 escape '!'))
 union
 select contact_id from public.contact_phones where organization_id=$1 and $9<>'' and (($19='prefix' and starts_with(normalized,$20)) or ($19='contains' and (normalized ilike $8 escape '!' or value ilike $8 escape '!')))
 ), lead_matches as materialized (
 select id from public.leads where organization_id=$1 and $9<>'' and (($19='prefix' and starts_with(search_title,$20)) or ($19='contains' and title ilike $8 escape '!'))
 union
 select l.id from public.leads l join contact_matches c on c.id=l.contact_id where l.organization_id=$1
 )
 select l.id,case when $17='activity' then l.last_activity_at else l.created_at end ts from public.leads l where l.organization_id=$1 and ($18 is null or l.contact_id=$18)
   and ($2='all' or ($2='active' and l.archived_at is null) or ($2='archived' and l.archived_at is not null))
   and ($11='all' or l.status=$11) and ($12='all' or l.priority=$12)
   and ($13 is null or exists(select 1 from public.lead_attributions a where a.organization_id=$1 and a.lead_id=l.id and a.source_id=$13))
   and ($14='all' or ($14='unassigned' and (l.last_assigned_user_id is null or private.crm_member_generation($1,l.last_assigned_user_id) is distinct from l.assigned_membership_generation)) or ($14='mine' and l.last_assigned_user_id=$15 and private.crm_member_generation($1,$15)=l.assigned_membership_generation) or ($14 not in ('all','unassigned','mine') and l.last_assigned_user_id=$16 and private.crm_member_generation($1,l.last_assigned_user_id)=l.assigned_membership_generation))
   and ($3 is null or l.created_at>=($3::timestamp at time zone 'UTC')) and ($4 is null or l.created_at<(($4+1)::timestamp at time zone 'UTC'))
   and ($5 is null or (case when $17='activity' then l.last_activity_at else l.created_at end,l.id)<($6,$7))
   and ($9='' or l.id in (select id from lead_matches))
   order by ts desc,l.id desc limit $10+1$query$ using p_org,archive,start_date,end_date,p_after,after_time,after_id,pattern,q,page_size,state,wanted_priority,source,assignee,actor,assigned_user,ordering,wanted_contact,search_mode,prefix loop
   if jsonb_array_length(items)=page_size then more:=true; exit; end if;
   items:=items||jsonb_build_array(private.crm_lead_json(p_org,r.id)); next_time:=r.ts; next_id:=r.id;
  end loop;
 end if;
 return jsonb_build_object('items',items,'next',case when more then jsonb_build_object('time',next_time,'id',next_id) else null end);
exception when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception using errcode=sqlstate,message=case when sqlstate='23505' then 'conflict' else 'invalid_fields' end;
end $$;

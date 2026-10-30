create function private.crm_position(p_after jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare stamp timestamptz; identifier uuid;
begin
 if p_after is null then return; end if;
 perform private.crm_keys(p_after,array['time','id'],array['time','id']);
 if jsonb_typeof(p_after->'time')<>'string' or jsonb_typeof(p_after->'id')<>'string' or char_length(p_after->>'time')>40 then raise exception using errcode='22023',message='invalid_cursor'; end if;
 stamp:=(p_after->>'time')::timestamptz; identifier:=(p_after->>'id')::uuid;
 if stamp is null or identifier is null or not isfinite(stamp) or stamp not between '1900-01-01Z'::timestamptz and '2100-01-01Z'::timestamptz then raise exception using errcode='22023',message='invalid_cursor'; end if;
end $$;

create function private.crm_query(p_org uuid,p_kind text,p_query jsonb,p_after jsonb default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; q text; pattern text; state text; wanted_priority text; source uuid; assignee text; assigned_user uuid; archive text; ordering text; start_date date; end_date date; page_size integer; next_time timestamptz; next_id uuid; after_time timestamptz; after_id uuid; r record; items jsonb:='[]'; more boolean:=false; field text;
begin
 actor:=private.crm_context(p_org,'read');
 if p_kind is null or p_kind not in ('contacts','leads') then raise exception using errcode='22023',message='invalid_kind'; end if;
 perform private.crm_keys(p_query,array['q','status','priority','sourceId','assignee','archived','from','to','sort','pageSize'],array['q','status','priority','sourceId','assignee','archived','from','to','sort','pageSize']);
 foreach field in array array['q','status','priority','assignee','archived','sort'] loop
  if jsonb_typeof(p_query->field)<>'string' then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 foreach field in array array['sourceId','from','to'] loop
  if jsonb_typeof(p_query->field) not in ('string','null') then raise exception using errcode='22023',message='invalid_fields'; end if;
 end loop;
 if jsonb_typeof(p_query->'pageSize')<>'number' or (p_query->>'pageSize') !~ '^[0-9]{1,3}$' then raise exception using errcode='22023',message='invalid_fields'; end if;
 q:=btrim(p_query->>'q'); state:=p_query->>'status'; wanted_priority:=p_query->>'priority'; source:=(p_query->>'sourceId')::uuid; assignee:=p_query->>'assignee'; archive:=p_query->>'archived'; ordering:=p_query->>'sort'; page_size:=(p_query->>'pageSize')::integer;
 start_date:=(p_query->>'from')::date; end_date:=(p_query->>'to')::date;
 if char_length(q)>100 or page_size not between 1 and 100 or state not in ('all','new','in_progress','qualified','closed') or wanted_priority not in ('all','low','normal','high') or archive not in ('active','archived','all') or ordering not in ('created','activity') then raise exception using errcode='22023',message='invalid_fields'; end if;
 if (start_date is not null and (not isfinite(start_date) or start_date not between '1900-01-01'::date and '2100-01-01'::date)) or (end_date is not null and (not isfinite(end_date) or end_date not between '1900-01-01'::date and '2100-01-01'::date)) or start_date>end_date then raise exception using errcode='22023',message='invalid_fields'; end if;
 if assignee not in ('all','unassigned','mine') then assigned_user:=assignee::uuid; end if;
 if p_kind='contacts' and (state<>'all' or wanted_priority<>'all' or source is not null or assignee<>'all' or ordering<>'created') then raise exception using errcode='22023',message='invalid_fields'; end if;
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
  for r in select l.id,case when ordering='activity' then l.last_activity_at else l.created_at end ts from public.leads l where l.organization_id=p_org
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
end $$;

create function private.crm_activity(p_org uuid,p_kind text,p_id uuid,p_size integer default 25,p_after jsonb default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
end $$;

create or replace function private.crm_contact_json(p_org uuid,p_id uuid) returns jsonb language sql volatile security invoker set search_path='' as $$
 select to_jsonb(c)||jsonb_build_object(
 'emails',coalesce((select jsonb_agg(jsonb_build_object('value',e.value,'normalized',e.normalized) order by e.position) from public.contact_emails e where e.organization_id=c.organization_id and e.contact_id=c.id),'[]'::jsonb),
 'phones',coalesce((select jsonb_agg(jsonb_build_object('value',p.value,'normalized',p.normalized) order by p.position) from public.contact_phones p where p.organization_id=c.organization_id and p.contact_id=c.id),'[]'::jsonb),
 'first_touch',(select jsonb_build_object('leadId',a.lead_id,'channel',a.channel,'sourceId',a.source_id,'campaign',a.campaign,'acceptedAt',a.accepted_at) from public.lead_attributions a join public.leads l on l.organization_id=a.organization_id and l.id=a.lead_id where l.organization_id=c.organization_id and l.contact_id=c.id order by a.accepted_at,a.lead_id limit 1))
 from public.contacts c where c.organization_id=p_org and c.id=p_id
$$;
grant create on schema private to leadsfam_crm;
alter function private.crm_position(jsonb) owner to leadsfam_crm;
alter function private.crm_query(uuid,text,jsonb,jsonb) owner to leadsfam_crm;
alter function private.crm_activity(uuid,text,uuid,integer,jsonb) owner to leadsfam_crm;
revoke create on schema private from leadsfam_crm;
revoke all on function private.crm_position(jsonb),private.crm_query(uuid,text,jsonb,jsonb),private.crm_activity(uuid,text,uuid,integer,jsonb) from public,anon,authenticated,service_role,leadsfam_runtime;
create function public.crm_query(p_org uuid,p_kind text,p_query jsonb,p_after jsonb default null) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_query(p_org,p_kind,p_query,p_after) $$;
create function public.crm_activity(p_org uuid,p_kind text,p_id uuid,p_size integer default 25,p_after jsonb default null) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_activity(p_org,p_kind,p_id,p_size,p_after) $$;
revoke all on function public.crm_query(uuid,text,jsonb,jsonb),public.crm_activity(uuid,text,uuid,integer,jsonb) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.crm_query(uuid,text,jsonb,jsonb),public.crm_activity(uuid,text,uuid,integer,jsonb),private.crm_query(uuid,text,jsonb,jsonb),private.crm_activity(uuid,text,uuid,integer,jsonb) to authenticated;

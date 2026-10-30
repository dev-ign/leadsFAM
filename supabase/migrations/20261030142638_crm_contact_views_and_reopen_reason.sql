-- Human-entered reopening rationale is intentional, bounded business content.
-- Contact PII is never copied into activity snapshots.
alter table public.crm_activities add column reason text check(char_length(reason)<=300);
alter table public.crm_activities add constraint crm_reopen_reason_subject check(reason is null or (event='lead.transitioned' and details->>'from'='closed' and details->>'to'='in_progress'));
create or replace function private.crm_event(p_org uuid,p_actor uuid,p_lead uuid,p_contact uuid,p_event text,p_details jsonb default '{}') returns void language sql security invoker set search_path='' as $$
 insert into public.crm_activities(organization_id,actor_id,lead_id,contact_id,event,details,request_id,reason) values(p_org,p_actor,p_lead,p_contact,p_event,p_details-'reason',left(nullif(current_setting('request.headers',true),'')::jsonb->>'x-request-id',80),nullif(p_details->>'reason',''))
$$;

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
end $$;



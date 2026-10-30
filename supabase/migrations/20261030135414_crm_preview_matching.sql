create index contacts_name_match_idx on public.contacts(organization_id,lower(btrim(display_name)),id);
create or replace function private.crm_matches(p_org uuid,p_data jsonb,p_exclude uuid default null) returns jsonb language sql volatile security invoker set search_path='' as $$
 select coalesce(jsonb_agg(private.crm_contact_json(p_org,id)),'[]'::jsonb) from (
 select c.id from public.contacts c join (
  select id from public.contacts where organization_id=p_org and lower(btrim(display_name))=lower(btrim(p_data->>'displayName'))
  union
  select contact_id from public.contact_emails where organization_id=p_org and normalized in (select value->>'normalized' from jsonb_array_elements(p_data->'emails'))
  union
  select contact_id from public.contact_phones where organization_id=p_org and normalized in (select value->>'normalized' from jsonb_array_elements(p_data->'phones'))
 ) candidates on candidates.id=c.id
 where c.organization_id=p_org and (p_exclude is null or c.id<>p_exclude)
 order by c.created_at,c.id limit 10) matched
$$;
create function private.crm_preview_candidates(p_org uuid,p_inputs jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare item jsonb; result jsonb:='[]';
begin
 perform private.crm_context(p_org,'import');
 if p_inputs is null or jsonb_typeof(p_inputs)<>'array' then raise exception using errcode='22023',message='invalid_fields'; end if;
 if jsonb_array_length(p_inputs)>100 or octet_length(p_inputs::text)>524288 then raise exception using errcode='22023',message='invalid_fields'; end if;
 for item in select value from jsonb_array_elements(p_inputs) loop
  if jsonb_typeof(item)='null' then result:=result||jsonb_build_array('[]'::jsonb);
  else
   perform private.crm_validate_contact(item);
   result:=result||jsonb_build_array(private.crm_matches(p_org,item));
  end if;
 end loop;
 return result;
end $$;
grant create on schema private to leadsfam_crm;
alter function private.crm_preview_candidates(uuid,jsonb) owner to leadsfam_crm;
revoke create on schema private from leadsfam_crm;
revoke all on function private.crm_preview_candidates(uuid,jsonb) from public,anon,authenticated,service_role,leadsfam_runtime;
create function public.crm_preview_candidates(p_org uuid,p_inputs jsonb) returns jsonb language sql volatile security invoker set search_path='' as $$ select private.crm_preview_candidates(p_org,p_inputs) $$;
revoke all on function public.crm_preview_candidates(uuid,jsonb) from public,anon,service_role,leadsfam_runtime;
grant execute on function public.crm_preview_candidates(uuid,jsonb),private.crm_preview_candidates(uuid,jsonb) to authenticated;

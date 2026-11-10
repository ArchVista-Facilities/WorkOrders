-- =============================================================================
-- AVBH Work Orders — 003 RPC: every write path, with workflow + permission rules
-- Called from the browser as supabase.rpc('<name>', {...}). All are SECURITY
-- DEFINER with pinned search_path and explicit permission checks.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Session bootstrap
-- ---------------------------------------------------------------------------
create or replace function public.me()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then raise exception 'Profile not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'profile', to_jsonb(p),
    'private', (select to_jsonb(pp) from public.profile_private pp where pp.user_id = p.id),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) order by r.name)
                       from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p.id), '[]'::jsonb),
    'permissions', case
        when p.status <> 'active' then '[]'::jsonb
        when p.is_superuser then (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from public.permissions)
        else coalesce((select jsonb_agg(distinct rp.permission_key) from public.user_roles ur
                       join public.role_permissions rp on rp.role_id = ur.role_id where ur.user_id = p.id), '[]'::jsonb) end,
    'supervisor', (select jsonb_build_object('id', s.id, 'name', s.first_name || ' ' || s.last_name)
                   from public.profiles s where s.id = p.supervisor_id)
  );
end $$;

-- Client-originated audit events (exports only — everything else is audited server-side).
create or replace function public.log_client_event(p_action text, p_details jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_active();
  if p_action not in ('workorder.export', 'report.export', 'audit.export', 'error.export') then
    raise exception 'Unsupported event.' using errcode = '22023';
  end if;
  perform public.write_audit(p_action, split_part(p_action, '.', 1), null, p_details);
end $$;

-- ---------------------------------------------------------------------------
-- Work order internals
-- ---------------------------------------------------------------------------
create or replace function public.wo_next_number()
returns text language plpgsql security definer set search_path = '' as $$
declare
  y      int  := extract(year from (now() at time zone 'America/Chicago'))::int;
  prefix text := coalesce((select value #>> '{}' from public.app_settings where key = 'wo_prefix'), 'WO');
  n      int;
begin
  insert into public.wo_sequences (year, last_value) values (y, 1)
  on conflict (year) do update set last_value = public.wo_sequences.last_value + 1
  returning last_value into n;
  return prefix || '-' || y || '-' || lpad(n::text, 5, '0');
end $$;

create or replace function public.wo_log(p_wo bigint, p_action text, p_field text default null,
                                         p_old text default null, p_new text default null, p_note text default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.wo_history (work_order_id, user_id, action, field, old_value, new_value, note)
  values (p_wo, auth.uid(), p_action, p_field, p_old, p_new, p_note);
$$;

-- Ligature risk raises priority to at least Urgent.
create or replace function public.wo_effective_priority(p_key text, p_ligature boolean)
returns public.priorities language plpgsql stable security definer set search_path = '' as $$
declare pr public.priorities; urg public.priorities;
begin
  select * into pr from public.priorities where key = p_key and is_active;
  if not found then raise exception 'Choose a valid priority.' using errcode = '22023'; end if;
  if p_ligature then
    select * into urg from public.priorities where key = 'urgent';
    if found and pr.rank > urg.rank then return urg; end if;
  end if;
  return pr;
end $$;

create or replace function public.jbool(p jsonb, k text, dflt boolean default false)
returns boolean language sql immutable set search_path = '' as $$
  select case when p ? k and jsonb_typeof(p->k) = 'boolean' then (p->>k)::boolean
              when p ? k and p->>k in ('true','1','on') then true
              when p ? k and p->>k in ('false','0','') then false
              else dflt end;
$$;

create or replace function public.jnum(p jsonb, k text, label text, max_val numeric)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  if not p ? k or nullif(p->>k, '') is null then return null; end if;
  begin v := (p->>k)::numeric; exception when others then raise exception '% must be a number.', label using errcode = '22023'; end;
  if v < 0 or v > max_val then raise exception '% must be between 0 and %.', label, max_val using errcode = '22023'; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Work order commands
-- ---------------------------------------------------------------------------
create or replace function public.wo_create(p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_title    text    := public.clean_text(p->>'title', 'Title', 150, true);
  v_desc     text    := public.clean_text(p->>'description', 'Description', 5000, true);
  v_type     text    := coalesce(nullif(p->>'type', ''), 'corrective');
  v_lig      boolean := public.jbool(p, 'ligatureRisk');
  v_cat      bigint  := nullif(p->>'categoryId', '')::bigint;
  v_loc      public.locations;
  v_pr       public.priorities;
  v_assignee uuid;
  v_due      timestamptz;
  v_id       bigint;
begin
  perform public.require_perm('workorders.create');
  if v_type not in ('corrective','preventive','inspection','safety','project','request') then
    raise exception 'Type is not a valid option.' using errcode = '22023';
  end if;
  if v_cat is null or not exists (select 1 from public.categories where id = v_cat and is_active) then
    raise exception 'Choose a valid category.' using errcode = '22023';
  end if;
  select * into v_loc from public.locations where id = nullif(p->>'locationId', '')::bigint and is_active;
  if not found then raise exception 'Choose a valid location.' using errcode = '22023'; end if;

  v_pr  := public.wo_effective_priority(p->>'priority', v_lig);
  v_due := now() + make_interval(hours => v_pr.sla_hours);

  -- Only dispatchers may pre-assign or override the due date.
  if public.has_perm('workorders.assign') then
    v_assignee := nullif(p->>'assigneeId', '')::uuid;
    if v_assignee is not null and not exists (select 1 from public.profiles where id = v_assignee and status = 'active') then
      raise exception 'Assignee must be an active user.' using errcode = '22023';
    end if;
    if nullif(p->>'dueAt', '') is not null then v_due := (p->>'dueAt')::timestamptz; end if;
  end if;

  insert into public.work_orders (wo_number, title, description, type, category_id, location_id, location_detail, asset_tag,
         priority_key, status, ligature_risk, patient_area, area_out_of_service, escort_required,
         requester_id, contact_phone, assignee_id, due_at)
  values (public.wo_next_number(), v_title, v_desc, v_type, v_cat, v_loc.id,
          public.clean_text(p->>'locationDetail', 'Room / detail', 150),
          public.clean_text(p->>'assetTag', 'Asset tag', 60),
          v_pr.key, case when v_assignee is null then 'open' else 'assigned' end,
          v_lig, public.jbool(p, 'patientArea', v_loc.is_patient_area),
          public.jbool(p, 'areaOutOfService'), public.jbool(p, 'escortRequired'),
          auth.uid(), public.clean_text(p->>'contactPhone', 'Contact phone', 30), v_assignee, v_due)
  returning id into v_id;

  perform public.wo_log(v_id, 'created', null, null, null,
    case when v_pr.key is distinct from p->>'priority' then 'Priority escalated to ' || v_pr.label || ' (ligature risk)' end);
  if v_assignee is not null then perform public.wo_log(v_id, 'assigned', 'assignee_id', null, v_assignee::text); end if;
  perform public.write_audit('workorder.create', 'workorder', v_id::text, jsonb_build_object('priority', v_pr.key, 'ligature', v_lig));
  return v_id;
end $$;

create or replace function public.wo_update(p_id bigint, p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  w       public.work_orders;
  n       public.work_orders;
  v_full  boolean := public.has_perm('workorders.edit');
  v_loc   public.locations;
  v_pr    public.priorities;
  v_lig   boolean := public.jbool(p, 'ligatureRisk');
  changed text[] := '{}';
  f       text;
begin
  perform public.require_active();
  if not public.can_see_wo(p_id) then raise exception 'Work order not found.' using errcode = 'P0002'; end if;
  select * into w from public.work_orders where id = p_id for update;
  if not v_full and not (w.requester_id = auth.uid() and w.status = 'open') then
    raise exception 'You do not have permission to edit this work order.' using errcode = '42501';
  end if;

  select * into v_loc from public.locations where id = nullif(p->>'locationId', '')::bigint;
  if not found then raise exception 'Choose a valid location.' using errcode = '22023'; end if;
  if not exists (select 1 from public.categories where id = nullif(p->>'categoryId', '')::bigint) then
    raise exception 'Choose a valid category.' using errcode = '22023';
  end if;
  v_pr := public.wo_effective_priority(p->>'priority', v_lig);

  n := w;
  n.title               := public.clean_text(p->>'title', 'Title', 150, true);
  n.description         := public.clean_text(p->>'description', 'Description', 5000, true);
  n.type                := coalesce(nullif(p->>'type', ''), w.type);
  n.category_id         := (p->>'categoryId')::bigint;
  n.location_id         := v_loc.id;
  n.location_detail     := public.clean_text(p->>'locationDetail', 'Room / detail', 150);
  n.asset_tag           := public.clean_text(p->>'assetTag', 'Asset tag', 60);
  n.priority_key        := v_pr.key;
  n.ligature_risk       := v_lig;
  n.patient_area        := public.jbool(p, 'patientArea');
  n.area_out_of_service := public.jbool(p, 'areaOutOfService');
  n.escort_required     := public.jbool(p, 'escortRequired');
  n.contact_phone       := public.clean_text(p->>'contactPhone', 'Contact phone', 30);

  if v_full and p ? 'dueAt' then
    n.due_at := nullif(p->>'dueAt', '')::timestamptz;
  elsif n.priority_key <> w.priority_key then
    n.due_at := w.created_at + make_interval(hours => v_pr.sla_hours);   -- re-derive SLA
  end if;
  if v_full and p ? 'laborHours' then n.labor_hours := public.jnum(p, 'laborHours', 'Labor hours', 10000); end if;
  if v_full and p ? 'partsCost'  then n.parts_cost  := public.jnum(p, 'partsCost', 'Parts cost', 10000000); end if;

  foreach f in array array['title','description','type','category_id','location_id','location_detail','asset_tag',
                           'priority_key','ligature_risk','patient_area','area_out_of_service','escort_required',
                           'contact_phone','due_at','labor_hours','parts_cost'] loop
    if (to_jsonb(n) -> f) is distinct from (to_jsonb(w) -> f) then
      changed := changed || f;
      perform public.wo_log(p_id, 'updated', f,
        case when f = 'description' then '(previous text)' else to_jsonb(w) ->> f end,
        case when f = 'description' then '(updated)' else to_jsonb(n) ->> f end);
    end if;
  end loop;
  if cardinality(changed) = 0 then return p_id; end if;

  update public.work_orders set
    title = n.title, description = n.description, type = n.type, category_id = n.category_id,
    location_id = n.location_id, location_detail = n.location_detail, asset_tag = n.asset_tag,
    priority_key = n.priority_key, ligature_risk = n.ligature_risk, patient_area = n.patient_area,
    area_out_of_service = n.area_out_of_service, escort_required = n.escort_required,
    contact_phone = n.contact_phone, due_at = n.due_at, labor_hours = n.labor_hours, parts_cost = n.parts_cost,
    updated_at = now()
  where id = p_id;
  perform public.write_audit('workorder.update', 'workorder', p_id::text, jsonb_build_object('fields', changed));
  return p_id;
end $$;

create or replace function public.wo_assign(p_id bigint, p_assignee uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare w public.work_orders; v_status text;
begin
  perform public.require_perm('workorders.assign');
  if not public.can_see_wo(p_id) then raise exception 'Work order not found.' using errcode = 'P0002'; end if;
  select * into w from public.work_orders where id = p_id for update;
  if w.status not in ('open','assigned','in_progress','on_hold') then
    raise exception 'Only active work orders can be assigned.' using errcode = '22023';
  end if;
  if p_assignee is not null and not exists (select 1 from public.profiles where id = p_assignee and status = 'active') then
    raise exception 'Assignee must be an active user.' using errcode = '22023';
  end if;
  v_status := case when p_assignee is not null and w.status = 'open' then 'assigned'
                   when p_assignee is null and w.status = 'assigned' then 'open'
                   else w.status end;
  update public.work_orders set assignee_id = p_assignee, status = v_status, updated_at = now() where id = p_id;
  perform public.wo_log(p_id, case when p_assignee is null then 'unassigned' else 'assigned' end, 'assignee_id', w.assignee_id::text, p_assignee::text);
  if v_status <> w.status then perform public.wo_log(p_id, 'status', 'status', w.status, v_status); end if;
  perform public.write_audit('workorder.assign', 'workorder', p_id::text, jsonb_build_object('from', w.assignee_id, 'to', p_assignee));
  return p_id;
end $$;

-- Status workflow with tool-control enforcement.
create or replace function public.wo_set_status(p_id bigint, p_to text, p jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  transitions constant jsonb := '{
    "open":["assigned","in_progress","on_hold","cancelled"],
    "assigned":["in_progress","on_hold","open","cancelled"],
    "in_progress":["on_hold","completed","cancelled"],
    "on_hold":["in_progress","assigned","cancelled"],
    "completed":["closed","in_progress"],
    "closed":["in_progress"],
    "cancelled":["open"]}';
  w         public.work_orders;
  n         public.work_orders;
  v_note    text := public.clean_text(p->>'note', 'Note', 2000);
  v_asg     boolean;
  v_req     boolean;
  v_worker  boolean;
  v_returned boolean := false;
begin
  perform public.require_active();
  if not public.can_see_wo(p_id) then raise exception 'Work order not found.' using errcode = 'P0002'; end if;
  select * into w from public.work_orders where id = p_id for update;
  if not coalesce((transitions -> w.status) ? p_to, false) then
    raise exception 'Cannot move from % to %.', replace(w.status, '_', ' '), replace(coalesce(p_to, '?'), '_', ' ') using errcode = '22023';
  end if;

  v_asg    := w.assignee_id = auth.uid();
  v_req    := w.requester_id = auth.uid();
  v_worker := public.has_perm('workorders.work') and (coalesce(v_asg, false) or public.has_perm('workorders.edit'));

  if p_to = 'closed' or w.status in ('completed','closed') then
    if not public.has_perm('workorders.close') then
      raise exception 'Closing or reopening requires the Close / reopen permission.' using errcode = '42501';
    end if;
  elsif p_to = 'cancelled' then
    if not (public.has_perm('workorders.edit') or (v_req and w.status = 'open')) then
      raise exception 'You do not have permission to cancel this work order.' using errcode = '42501';
    end if;
    if v_note is null then raise exception 'Give a reason for cancelling.' using errcode = '22023'; end if;
  elsif p_to = 'open' and w.status = 'cancelled' then
    if not public.has_perm('workorders.edit') then raise exception 'You do not have permission to do that.' using errcode = '42501'; end if;
  elsif p_to in ('assigned','open') then
    if not (public.has_perm('workorders.assign') or v_worker) then raise exception 'You do not have permission to do that.' using errcode = '42501'; end if;
  elsif not v_worker then
    raise exception 'Only the assigned technician (or an editor) can update work progress.' using errcode = '42501';
  end if;
  if p_to = 'assigned' and w.assignee_id is null then raise exception 'Assign a technician first.' using errcode = '22023'; end if;
  if p_to = 'on_hold' and v_note is null then raise exception 'Give a reason for placing the work order on hold.' using errcode = '22023'; end if;

  n := w;
  n.status := p_to;
  if p_to = 'in_progress' and w.started_at is null then n.started_at := now(); end if;
  if p_to = 'in_progress' and w.status in ('completed','closed') then
    n.completed_at := null; n.closed_at := null; n.tools_accounted_by := null; n.tools_accounted_at := null;
  end if;
  if p_to = 'open' and w.status = 'cancelled' then n.cancelled_at := null; end if;
  if p_to = 'completed' then
    n.resolution   := public.clean_text(p->>'resolution', 'Resolution', 5000, true);
    n.completed_at := now();
    if nullif(p->>'laborHours', '') is not null then n.labor_hours := public.jnum(p, 'laborHours', 'Labor hours', 10000); end if;
    if nullif(p->>'partsCost', '')  is not null then n.parts_cost  := public.jnum(p, 'partsCost', 'Parts cost', 10000000); end if;
    -- Tool control: mandatory for patient-care areas and any ligature work.
    if w.patient_area or w.ligature_risk then
      if not public.jbool(p, 'toolsAccountedFor') then
        raise exception 'Tool control: confirm all tools, hardware, and debris were accounted for and removed from the patient-care area.' using errcode = '22023';
      end if;
      n.tools_accounted_by := auth.uid();
      n.tools_accounted_at := now();
    end if;
    if public.jbool(p, 'areaReturnedToService') and w.area_out_of_service then
      n.area_out_of_service := false; v_returned := true;
    end if;
  end if;
  if p_to = 'closed'    then n.closed_at    := now(); end if;
  if p_to = 'cancelled' then n.cancelled_at := now(); end if;

  update public.work_orders set
    status = n.status, started_at = n.started_at, completed_at = n.completed_at, closed_at = n.closed_at,
    cancelled_at = n.cancelled_at, resolution = n.resolution, labor_hours = n.labor_hours, parts_cost = n.parts_cost,
    tools_accounted_by = n.tools_accounted_by, tools_accounted_at = n.tools_accounted_at,
    area_out_of_service = n.area_out_of_service, updated_at = now()
  where id = p_id;

  perform public.wo_log(p_id, 'status', 'status', w.status, p_to, v_note);
  if n.tools_accounted_at is not null and w.tools_accounted_at is null then
    perform public.wo_log(p_id, 'tool_control', null, null, null, 'Tools/materials accounted for and removed from patient-care area');
  end if;
  if v_returned then perform public.wo_log(p_id, 'updated', 'area_out_of_service', 'true', 'false', 'Area returned to service'); end if;
  perform public.write_audit('workorder.status', 'workorder', p_id::text, jsonb_build_object('from', w.status, 'to', p_to));
  return p_id;
end $$;

create or replace function public.wo_comment(p_id bigint, p_body text, p_internal boolean default false)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_internal boolean;
begin
  perform public.require_active();
  if not public.can_see_wo(p_id) then raise exception 'Work order not found.' using errcode = 'P0002'; end if;
  v_internal := coalesce(p_internal, false) and (public.has_perm('workorders.work') or public.has_perm('workorders.view_all'));
  insert into public.wo_comments (work_order_id, user_id, body, is_internal)
  values (p_id, auth.uid(), public.clean_text(p_body, 'Comment', 4000, true), v_internal)
  returning id into v_id;
  update public.work_orders set updated_at = now() where id = p_id;
  perform public.write_audit('workorder.comment', 'workorder', p_id::text, jsonb_build_object('internal', v_internal));
  return v_id;
end $$;

-- Records a file the browser already uploaded to storage; size/type are read
-- from storage metadata, not trusted from the client.
create or replace function public.wo_add_attachment(p_id bigint, p_path text, p_name text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare o record; v_id bigint; v_name text := left(regexp_replace(coalesce(p_name, 'file'), '[^A-Za-z0-9._ ()-]', '_', 'g'), 150);
begin
  perform public.require_active();
  if not public.can_see_wo(p_id) then raise exception 'Work order not found.' using errcode = 'P0002'; end if;
  if split_part(p_path, '/', 1) <> p_id::text then raise exception 'Invalid attachment path.' using errcode = '22023'; end if;
  select name, metadata into o from storage.objects where bucket_id = 'attachments' and name = p_path;
  if not found then raise exception 'Upload not found.' using errcode = 'P0002'; end if;
  insert into public.wo_attachments (work_order_id, user_id, original_name, storage_path, mime_type, size_bytes)
  values (p_id, auth.uid(), v_name, p_path, coalesce(o.metadata->>'mimetype', 'application/octet-stream'),
          coalesce((o.metadata->>'size')::int, 0))
  returning id into v_id;
  perform public.wo_log(p_id, 'attachment', null, null, v_name);
  perform public.write_audit('workorder.attach', 'workorder', p_id::text, jsonb_build_object('file', v_name));
  return v_id;
end $$;

-- Removes the record; returns the storage path so the client deletes the object.
create or replace function public.wo_remove_attachment(p_att bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare a public.wo_attachments;
begin
  perform public.require_active();
  select * into a from public.wo_attachments where id = p_att;
  if not found or not public.can_see_wo(a.work_order_id) then raise exception 'Attachment not found.' using errcode = 'P0002'; end if;
  if a.user_id <> auth.uid() and not public.has_perm('workorders.edit') then
    raise exception 'You do not have permission to remove this file.' using errcode = '42501';
  end if;
  delete from public.wo_attachments where id = p_att;
  perform public.wo_log(a.work_order_id, 'attachment_removed', null, a.original_name, null);
  perform public.write_audit('workorder.attach_remove', 'workorder', a.work_order_id::text, jsonb_build_object('file', a.original_name));
  return a.storage_path;
end $$;

-- Soft delete (kept for audit).
create or replace function public.wo_delete(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_num text;
begin
  perform public.require_perm('workorders.delete');
  if not public.can_see_wo(p_id) then raise exception 'Work order not found.' using errcode = 'P0002'; end if;
  update public.work_orders set deleted_at = now(), updated_at = now() where id = p_id returning wo_number into v_num;
  perform public.wo_log(p_id, 'deleted');
  perform public.write_audit('workorder.delete', 'workorder', p_id::text, jsonb_build_object('number', v_num));
end $$;

-- Dashboard counters + lists scoped to the caller's visibility (invoker → RLS applies).
create or replace function public.wo_dashboard()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare uid uuid := auth.uid(); since30 timestamptz := now() - interval '30 days';
begin
  perform public.require_active();
  return jsonb_build_object(
    'counts', (select jsonb_build_object(
        'open',         count(*) filter (where is_active),
        'unassigned',   count(*) filter (where is_active and assignee_id is null),
        'overdue',      count(*) filter (where is_overdue),
        'emergency',    count(*) filter (where is_active and priority_key in ('emergency','urgent')),
        'ligature',     count(*) filter (where is_active and ligature_risk),
        'outOfService', count(*) filter (where is_active and area_out_of_service),
        'completed30',  count(*) filter (where status in ('completed','closed') and completed_at >= since30),
        'mine',         count(*) filter (where is_active and assignee_id = uid))
      from public.work_orders_v),
    'myQueue', coalesce((select jsonb_agg(to_jsonb(v) order by v.priority_rank, v.due_at) from (
        select * from public.work_orders_v where assignee_id = uid and is_active order by priority_rank, due_at limit 10) v), '[]'::jsonb),
    'myRequests', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc) from (
        select * from public.work_orders_v where requester_id = uid order by created_at desc limit 8) v), '[]'::jsonb),
    'critical', coalesce((select jsonb_agg(to_jsonb(v) order by v.priority_rank, v.due_at) from (
        select * from public.work_orders_v
        where is_active and (priority_key in ('emergency','urgent') or ligature_risk or is_overdue)
        order by priority_rank, due_at limit 10) v), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------------------
-- User administration
-- ---------------------------------------------------------------------------
create or replace function public.assert_can_administer(p_user uuid)
returns public.profiles language plpgsql stable security definer set search_path = '' as $$
declare t public.profiles;
begin
  perform public.require_perm('users.manage');
  select * into t from public.profiles where id = p_user;
  if not found then raise exception 'User not found.' using errcode = 'P0002'; end if;
  if t.is_superuser and not public.is_superuser() then
    raise exception 'Only a superuser can modify a superuser account.' using errcode = '42501';
  end if;
  return t;
end $$;

create or replace function public.admin_update_profile(p_user uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles := public.assert_can_administer(p_user); v_sup uuid := nullif(p->>'supervisorId', '')::uuid;
begin
  if v_sup = p_user then raise exception 'A user cannot supervise themselves.' using errcode = '22023'; end if;
  if nullif(p->>'avatarPath', '') is not null and split_part(p->>'avatarPath', '/', 1) <> p_user::text then
    raise exception 'Invalid avatar path.' using errcode = '22023';
  end if;
  update public.profiles set
    first_name     = public.clean_text(p->>'firstName', 'First name', 80, true),
    last_name      = public.clean_text(p->>'lastName', 'Last name', 80, true),
    preferred_name = public.clean_text(p->>'preferredName', 'Preferred name', 80),
    job_title      = public.clean_text(p->>'jobTitle', 'Job title', 120),
    department     = public.clean_text(p->>'department', 'Department', 120),
    phone          = public.clean_text(p->>'phone', 'Phone', 30),
    extension      = public.clean_text(p->>'extension', 'Extension', 10),
    mobile         = public.clean_text(p->>'mobile', 'Mobile', 30),
    shift          = nullif(p->>'shift', ''),
    certifications = public.clean_text(p->>'certifications', 'Certifications', 2000),
    skills         = public.clean_text(p->>'skills', 'Skills', 2000),
    bio            = public.clean_text(p->>'bio', 'About', 2000),
    employee_id    = public.clean_text(p->>'employeeId', 'Employee ID', 40),
    hire_date      = nullif(p->>'hireDate', '')::date,
    supervisor_id  = v_sup,
    avatar_path    = case when p ? 'avatarPath' then nullif(p->>'avatarPath', '') else avatar_path end
  where id = p_user;
  if p ? 'emergencyContactName' or p ? 'emergencyContactPhone' then
    update public.profile_private set
      emergency_contact_name  = public.clean_text(p->>'emergencyContactName', 'Emergency contact name', 120),
      emergency_contact_phone = public.clean_text(p->>'emergencyContactPhone', 'Emergency contact phone', 30)
    where user_id = p_user;
  end if;
  perform public.write_audit('user.admin_update', 'user', p_user::text, jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p) k)));
end $$;

create or replace function public.admin_set_user_status(p_user uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles := public.assert_can_administer(p_user);
begin
  if p_status not in ('active','disabled') then raise exception 'Status is not valid.' using errcode = '22023'; end if;
  if p_user = auth.uid() then raise exception 'You cannot change your own account status.' using errcode = '42501'; end if;
  if t.is_developer and p_status = 'disabled' then raise exception 'The developer account cannot be disabled.' using errcode = '42501'; end if;
  update public.profiles set status = p_status,
    approved_by = case when t.status = 'pending' and p_status = 'active' then auth.uid() else approved_by end,
    approved_at = case when t.status = 'pending' and p_status = 'active' then now() else approved_at end
  where id = p_user;
  perform public.write_audit(case when t.status = 'pending' then 'user.approve' when p_status = 'active' then 'user.enable' else 'user.disable' end,
                             'user', p_user::text);
end $$;

-- Reject a never-approved registration: removes the auth account entirely.
create or replace function public.admin_reject_user(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles := public.assert_can_administer(p_user);
begin
  if t.status <> 'pending' then raise exception 'Only pending registrations can be rejected. Disable active accounts instead.' using errcode = '22023'; end if;
  if t.is_developer then raise exception 'The developer account cannot be rejected.' using errcode = '42501'; end if;
  perform public.write_audit('user.reject', 'user', p_user::text, jsonb_build_object('email', t.email));
  delete from auth.users where id = p_user;
end $$;

-- Replace a user's roles; non-superusers can't grant permissions they lack.
create or replace function public.admin_set_user_roles(p_user uuid, p_role_ids bigint[])
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles := public.assert_can_administer(p_user); v_before jsonb; v_missing text;
begin
  if p_user = auth.uid() and not public.is_superuser() then
    raise exception 'You cannot change your own roles.' using errcode = '42501';
  end if;
  if not public.is_superuser() then
    select rp.permission_key into v_missing from public.role_permissions rp
    where rp.role_id = any(p_role_ids) and not public.has_perm(rp.permission_key) limit 1;
    if v_missing is not null then
      raise exception 'You cannot assign a role with permissions you do not hold (%).', v_missing using errcode = '42501';
    end if;
  end if;
  select jsonb_agg(r.name) into v_before from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p_user;
  delete from public.user_roles where user_id = p_user;
  insert into public.user_roles (user_id, role_id) select p_user, id from public.roles where id = any(p_role_ids);
  perform public.write_audit('user.roles_update', 'user', p_user::text, jsonb_build_object('before', v_before,
    'after', (select jsonb_agg(r.name) from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p_user)));
end $$;

create or replace function public.admin_set_superuser(p_user uuid, p_flag boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles;
begin
  if not public.is_superuser() then raise exception 'Superuser access required.' using errcode = '42501'; end if;
  select * into t from public.profiles where id = p_user;
  if not found then raise exception 'User not found.' using errcode = 'P0002'; end if;
  if t.is_developer and not p_flag then raise exception 'The developer account cannot be demoted.' using errcode = '42501'; end if;
  if p_user = auth.uid() and not p_flag then raise exception 'You cannot remove your own superuser access.' using errcode = '42501'; end if;
  if t.status <> 'active' and p_flag then raise exception 'Only active accounts can be made superuser.' using errcode = '22023'; end if;
  update public.profiles set is_superuser = p_flag where id = p_user;
  perform public.write_audit(case when p_flag then 'user.superuser_grant' else 'user.superuser_revoke' end, 'user', p_user::text);
end $$;

create or replace function public.user_stats(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_active();
  if p_user <> auth.uid() and not (public.has_perm('users.view') or public.has_perm('users.manage')) then
    raise exception 'You do not have permission to do that.' using errcode = '42501';
  end if;
  return (select jsonb_build_object(
      'open_assigned', count(*) filter (where assignee_id = p_user and status in ('open','assigned','in_progress','on_hold')),
      'completed',     count(*) filter (where assignee_id = p_user and status in ('completed','closed')),
      'requested',     count(*) filter (where requester_id = p_user))
    from public.work_orders where deleted_at is null);
end $$;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create or replace function public.role_save(p_id bigint, p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := public.clean_text(p->>'name', 'Role name', 60, true);
  v_desc  text := public.clean_text(p->>'description', 'Description', 300);
  v_perms text[] := coalesce((select array_agg(distinct x) from jsonb_array_elements_text(coalesce(p->'permissions', '[]'::jsonb)) x), '{}');
  v_def   boolean := public.jbool(p, 'isDefault');
  v_bad   text;
  v_role  public.roles;
  v_id    bigint;
  v_before text[];
begin
  perform public.require_perm('roles.manage');
  select x into v_bad from unnest(v_perms) x where not exists (select 1 from public.permissions where key = x) limit 1;
  if v_bad is not null then raise exception 'Unknown permission: %', v_bad using errcode = '22023'; end if;
  if not public.is_superuser() then
    select x into v_bad from unnest(v_perms) x where not public.has_perm(x) limit 1;
    if v_bad is not null then raise exception 'You cannot grant a permission you do not hold (%).', v_bad using errcode = '42501'; end if;
  end if;
  if exists (select 1 from public.roles where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A role with that name already exists.' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.roles (name, description) values (v_name, v_desc) returning id into v_id;
  else
    select * into v_role from public.roles where id = p_id;
    if not found then raise exception 'Role not found.' using errcode = 'P0002'; end if;
    if v_role.is_system and not public.is_superuser() then raise exception 'Only a superuser can edit system roles.' using errcode = '42501'; end if;
    select array_agg(permission_key) into v_before from public.role_permissions where role_id = p_id;
    update public.roles set name = v_name, description = v_desc where id = p_id;
    delete from public.role_permissions where role_id = p_id;
    v_id := p_id;
  end if;
  insert into public.role_permissions (role_id, permission_key) select v_id, unnest(v_perms);
  if v_def then
    update public.roles set is_default = (id = v_id) where true;  -- explicit WHERE for pg_safeupdate
  else
    update public.roles set is_default = false where id = v_id;
  end if;
  perform public.write_audit(case when p_id is null then 'role.create' else 'role.update' end, 'role', v_id::text,
    jsonb_build_object('name', v_name, 'added', (select jsonb_agg(x) from unnest(v_perms) x where not x = any(coalesce(v_before, '{}'))),
                       'removed', (select jsonb_agg(x) from unnest(coalesce(v_before, '{}')) x where not x = any(v_perms))));
  return v_id;
end $$;

create or replace function public.role_delete(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.roles;
begin
  perform public.require_perm('roles.manage');
  select * into r from public.roles where id = p_id;
  if not found then raise exception 'Role not found.' using errcode = 'P0002'; end if;
  if r.is_system then raise exception 'System roles cannot be deleted.' using errcode = '42501'; end if;
  perform public.write_audit('role.delete', 'role', p_id::text, jsonb_build_object('name', r.name,
    'affectedUsers', (select count(*) from public.user_roles where role_id = p_id)));
  delete from public.roles where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create or replace function public.settings_save(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  f        jsonb := coalesce(p->'facility', '{}'::jsonb);
  v_prefix text  := upper(public.clean_text(p->>'woPrefix', 'Work order prefix', 6, true));
  v_fac    jsonb;
  v_domains jsonb;
begin
  perform public.require_perm('settings.manage');
  if v_prefix !~ '^[A-Z]{1,6}$' then raise exception 'Work order prefix must be 1–6 letters.' using errcode = '22023'; end if;
  v_fac := jsonb_build_object(
    'name',   public.clean_text(f->>'name', 'Facility name', 150, true),
    'street', public.clean_text(f->>'street', 'Street', 150, true),
    'city',   public.clean_text(f->>'city', 'City', 80, true),
    'state',  upper(public.clean_text(f->>'state', 'State', 2, true)),
    'zip',    public.clean_text(f->>'zip', 'ZIP', 10, true));
  insert into public.app_settings (key, value, updated_at, updated_by) values
    ('facility', v_fac, now(), auth.uid()),
    ('wo_prefix', to_jsonb(v_prefix), now(), auth.uid()),
    ('auto_approve_domain_users', to_jsonb(public.jbool(p, 'autoApproveDomainUsers')), now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  -- Allowed registration domains: superuser only.
  if p ? 'allowedDomains' then
    if not public.is_superuser() then raise exception 'Only a superuser can change allowed email domains.' using errcode = '42501'; end if;
    select coalesce(jsonb_agg(distinct lower(btrim(d))), '[]'::jsonb) into v_domains
    from jsonb_array_elements_text(p->'allowedDomains') d where btrim(d) <> '';
    if exists (select 1 from jsonb_array_elements_text(v_domains) d where d !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$') then
      raise exception 'Domains must look like example.com.' using errcode = '22023';
    end if;
    if jsonb_array_length(v_domains) = 0 then raise exception 'At least one domain is required.' using errcode = '22023'; end if;
    update public.app_settings set value = v_domains, updated_at = now(), updated_by = auth.uid() where key = 'allowed_domains';
  end if;
  perform public.write_audit('settings.update', 'settings', 'app', p);
end $$;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
create or replace function public.report_summary(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  f timestamptz := coalesce(p_from, (now() - interval '90 days')::date)::timestamptz;
  t timestamptz := (coalesce(p_to, now()::date) + 1)::timestamptz;
  trend_from date := date_trunc('month', now() - interval '11 months')::date;
  v jsonb;
begin
  perform public.require_perm('reports.view');
  with base as (select * from public.work_orders where deleted_at is null and created_at >= f and created_at < t)
  select jsonb_build_object(
    'window', jsonb_build_object('from', f, 'to', t),
    'totals', (select jsonb_build_object(
        'created',   count(*),
        'completed', count(*) filter (where status in ('completed','closed')),
        'open',      count(*) filter (where status in ('open','assigned','in_progress','on_hold')),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'overdue',   count(*) filter (where status in ('open','assigned','in_progress','on_hold') and due_at < now()),
        'ligature',  count(*) filter (where ligature_risk),
        'sla_pct',   round(100.0 * count(*) filter (where completed_at is not null and due_at is not null and completed_at <= due_at)
                       / nullif(count(*) filter (where completed_at is not null and due_at is not null), 0), 1),
        'avg_hours', round((avg(extract(epoch from completed_at - created_at)) filter (where completed_at is not null) / 3600)::numeric, 1),
        'avg_response_hours', round((avg(extract(epoch from started_at - created_at)) filter (where started_at is not null) / 3600)::numeric, 1),
        'labor_hours', coalesce(sum(labor_hours), 0),
        'parts_cost',  coalesce(sum(parts_cost), 0)) from base),
    'byStatus', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
        select status as label, count(*) as total,
               count(*) filter (where status in ('open','assigned','in_progress','on_hold')) as open,
               count(*) filter (where status in ('completed','closed')) as completed
        from base group by status) x),
    'byPriority', (select coalesce(jsonb_agg(x order by x.rank), '[]') from (
        select p.label, p.rank, count(*) as total,
               count(*) filter (where b.status in ('open','assigned','in_progress','on_hold')) as open,
               count(*) filter (where b.status in ('completed','closed')) as completed
        from base b join public.priorities p on p.key = b.priority_key group by p.label, p.rank) x),
    'byCategory', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
        select coalesce(c.name, '(none)') as label, count(*) as total,
               count(*) filter (where b.status in ('open','assigned','in_progress','on_hold')) as open,
               count(*) filter (where b.status in ('completed','closed')) as completed
        from base b left join public.categories c on c.id = b.category_id group by c.name) x),
    'byLocation', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
        select coalesce(l.building || ' — ' || l.name, '(none)') as label, count(*) as total,
               count(*) filter (where b.status in ('open','assigned','in_progress','on_hold')) as open,
               count(*) filter (where b.status in ('completed','closed')) as completed
        from base b left join public.locations l on l.id = b.location_id
        group by l.building, l.name order by count(*) desc limit 15) x),
    'byType', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
        select type as label, count(*) as total,
               count(*) filter (where status in ('open','assigned','in_progress','on_hold')) as open,
               count(*) filter (where status in ('completed','closed')) as completed
        from base group by type) x),
    'byAssignee', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
        select coalesce(u.first_name || ' ' || u.last_name, 'Unassigned') as label, count(*) as total,
               count(*) filter (where b.status in ('open','assigned','in_progress','on_hold')) as open,
               count(*) filter (where b.status in ('completed','closed')) as completed,
               round((avg(extract(epoch from b.completed_at - b.created_at)) filter (where b.completed_at is not null) / 3600)::numeric, 1) as avg_hours,
               round(coalesce(sum(b.labor_hours), 0), 1) as labor_hours
        from base b left join public.profiles u on u.id = b.assignee_id
        group by b.assignee_id, u.first_name, u.last_name) x),
    'trend', (select jsonb_agg(jsonb_build_object(
        'month', to_char(m, 'YYYY-MM'),
        'created',   (select count(*) from public.work_orders where deleted_at is null and date_trunc('month', created_at) = m),
        'completed', (select count(*) from public.work_orders where deleted_at is null and date_trunc('month', completed_at) = m)) order by m)
      from generate_series(trend_from, date_trunc('month', now())::date, interval '1 month') m)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Error logging
-- ---------------------------------------------------------------------------
-- Intake for browser errors (anon allowed — errors happen on the sign-in page)
-- and user problem reports (signed-in only). De-duplicated by fingerprint;
-- resolved errors that recur are re-opened.
create or replace function public.log_error(p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_source text := coalesce(p->>'source', 'client');
  v_msg    text := left(coalesce(nullif(btrim(p->>'message'), ''), 'Unknown error'), 2000);
  v_stack  text := left(p->>'stack', 8000);
  v_fp     text;
  v_row    public.error_logs;
  v_email  text := (select email from public.profiles where id = auth.uid());
  v_id     bigint;
begin
  if v_source not in ('client', 'user_report') then raise exception 'Invalid source.' using errcode = '22023'; end if;
  if v_source = 'user_report' then perform public.require_active(); end if;
  -- Flood guard for anonymous traffic.
  if auth.uid() is null and (select count(*) from public.error_logs where user_id is null and last_seen_at > now() - interval '1 hour') > 300 then
    return null;
  end if;

  v_fp := md5(v_source || '|' || regexp_replace(v_msg, '\d+', '#', 'g') || '|' ||
              regexp_replace(coalesce(split_part(v_stack, E'\n', 1), ''), ':\d+:\d+', '', 'g'));

  if v_source <> 'user_report' then
    select * into v_row from public.error_logs where fingerprint = v_fp order by id desc limit 1;
    if found then
      update public.error_logs set
        occurrences = occurrences + 1, last_seen_at = now(),
        stack = coalesce(v_stack, stack), route = coalesce(left(p->>'route', 300), route),
        user_id = coalesce(auth.uid(), user_id), user_email = coalesce(v_email, user_email),
        status = case when status = 'resolved' then 'open' else status end,
        resolution_notes = case when status = 'resolved'
                                then coalesce(resolution_notes, '') || E'\n[auto] Regressed ' || now()::text else resolution_notes end
      where id = v_row.id;
      return v_row.id;
    end if;
  end if;

  insert into public.error_logs (fingerprint, level, source, message, stack, route, status_code, user_id, user_email, request_id, user_agent, context)
  values (v_fp, case when v_source = 'user_report' then 'warn' else 'error' end, v_source, v_msg, v_stack,
          left(p->>'route', 300), nullif(p->>'statusCode', '')::int, auth.uid(), v_email,
          left(p->>'requestId', 100), left(p->>'userAgent', 300), p->'context')
  returning id into v_id;
  if v_source = 'user_report' then perform public.write_audit('error.user_report', 'error', v_id::text); end if;
  return v_id;
end $$;

create or replace function public.error_triage(p_id bigint, p_status text, p_notes text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_perm('errors.manage');
  if p_status not in ('open','acknowledged','resolved','ignored') then raise exception 'Status is not valid.' using errcode = '22023'; end if;
  update public.error_logs set status = p_status,
    resolution_notes = coalesce(nullif(btrim(p_notes), ''), resolution_notes),
    resolved_by = case when p_status = 'resolved' then auth.uid() end,
    resolved_at = case when p_status = 'resolved' then now() end
  where id = p_id;
  if not found then raise exception 'Error not found.' using errcode = 'P0002'; end if;
  perform public.write_audit('error.status', 'error', p_id::text, jsonb_build_object('status', p_status));
end $$;

create or replace function public.error_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare since timestamptz := now() - interval '30 days';
begin
  perform public.require_perm('errors.view');
  return jsonb_build_object(
    'unresolved',      (select count(*) from public.error_logs where status in ('open','acknowledged')),
    'openUserReports', (select count(*) from public.error_logs where source = 'user_report' and status in ('open','acknowledged')),
    'last24h',         (select coalesce(sum(occurrences), 0) from public.error_logs where last_seen_at >= now() - interval '24 hours'),
    'bySource',        (select coalesce(jsonb_agg(x), '[]') from (select source as label, count(*) as groups, sum(occurrences) as total
                        from public.error_logs where last_seen_at >= since group by source) x));
end $$;

create or replace function public.error_purge(p_days int default 180)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform public.require_perm('errors.manage');
  delete from public.error_logs where status in ('resolved','ignored') and last_seen_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  perform public.write_audit('error.purge', 'error', null, jsonb_build_object('days', p_days, 'deleted', n));
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- API surface: internal helpers hidden; commands exposed to signed-in users.
-- ---------------------------------------------------------------------------
revoke execute on function public.wo_next_number() from public, anon, authenticated;
revoke execute on function public.wo_log(bigint, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.wo_effective_priority(text, boolean) from public, anon, authenticated;
revoke execute on function public.assert_can_administer(uuid) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'me()', 'log_client_event(text, jsonb)', 'wo_create(jsonb)', 'wo_update(bigint, jsonb)', 'wo_assign(bigint, uuid)',
    'wo_set_status(bigint, text, jsonb)', 'wo_comment(bigint, text, boolean)', 'wo_add_attachment(bigint, text, text)',
    'wo_remove_attachment(bigint)', 'wo_delete(bigint)', 'wo_dashboard()', 'admin_update_profile(uuid, jsonb)',
    'admin_set_user_status(uuid, text)', 'admin_reject_user(uuid)', 'admin_set_user_roles(uuid, bigint[])',
    'admin_set_superuser(uuid, boolean)', 'user_stats(uuid)', 'role_save(bigint, jsonb)', 'role_delete(bigint)',
    'settings_save(jsonb)', 'report_summary(date, date)', 'error_triage(bigint, text, text)', 'error_stats()',
    'error_purge(int)']
  loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
grant execute on function public.log_error(jsonb) to anon, authenticated;

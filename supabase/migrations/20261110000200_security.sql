-- =============================================================================
-- AVBH Work Orders — 002 security: helpers, auth triggers, RLS, read view
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER so policies can call them without
-- recursive RLS). All pin search_path to prevent hijacking.
-- ---------------------------------------------------------------------------

-- Signed in AND approved AND not disabled.
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active');
$$;

create or replace function public.is_superuser()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active' and is_superuser);
$$;

-- Effective permission check: union of the user's role permissions; superuser bypasses.
create or replace function public.has_perm(p text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.status = 'active'
      and (pr.is_superuser or exists (
        select 1 from public.user_roles ur
        join public.role_permissions rp on rp.role_id = ur.role_id
        where ur.user_id = pr.id and rp.permission_key = p))
  );
$$;

-- Row-level visibility of a work order: view_all, or requester, or assignee.
create or replace function public.can_see_wo(wo bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_active_user() and exists (
    select 1 from public.work_orders w
    where w.id = wo and w.deleted_at is null
      and (public.has_perm('workorders.view_all') or w.requester_id = auth.uid() or w.assignee_id = auth.uid()));
$$;

-- Storage helper: object names are "<work_order_id>/<random>.<ext>".
create or replace function public.can_see_wo_path(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v text := split_part(object_name, '/', 1);
begin
  if v !~ '^[0-9]{1,18}$' then return false; end if;
  return public.can_see_wo(v::bigint);
end $$;

-- Raise unless the caller holds a permission (used inside RPCs).
create or replace function public.require_perm(p text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '28000'; end if;
  if not public.has_perm(p) then raise exception 'You do not have permission to do that.' using errcode = '42501'; end if;
end $$;

create or replace function public.require_active()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '28000'; end if;
  if not public.is_active_user() then raise exception 'Your account is not active.' using errcode = '42501'; end if;
end $$;

-- Append-only audit writer (internal).
create or replace function public.write_audit(p_action text, p_entity_type text default null, p_entity_id text default null, p_details jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (user_id, user_email, action, entity_type, entity_id, details)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()), p_action, p_entity_type, p_entity_id, p_details);
end $$;

-- Text validator used by RPCs: trims, enforces required/max length, returns null for blank.
create or replace function public.clean_text(v text, label text, max_len int, required boolean default false)
returns text language plpgsql immutable set search_path = '' as $$
declare s text := nullif(btrim(coalesce(v, '')), '');
begin
  if s is null and required then raise exception '% is required.', label using errcode = '22023'; end if;
  if s is not null and char_length(s) > max_len then raise exception '% must be % characters or fewer.', label, max_len using errcode = '22023'; end if;
  return s;
end $$;

-- Email eligibility: exact allowed domain, or the developer address.
create or replace function public.email_allowed(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select lower(p_email) = lower((select value #>> '{}' from public.app_settings where key = 'developer_email'))
      or coalesce((select value from public.app_settings where key = 'allowed_domains'), '[]'::jsonb) ? lower(split_part(p_email, '@', 2));
$$;

-- ---------------------------------------------------------------------------
-- Auth triggers: domain lock, profile creation, developer elevation
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_email   text    := lower(new.email);
  v_is_dev  boolean := v_email = lower((select value #>> '{}' from public.app_settings where key = 'developer_email'));
  v_auto    boolean := coalesce((select (value #>> '{}')::boolean from public.app_settings where key = 'auto_approve_domain_users'), false);
  v_meta    jsonb   := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_confirm boolean := new.email_confirmed_at is not null;
  v_status  text;
begin
  -- Rejecting here aborts the sign-up: no account is created for other domains.
  if not public.email_allowed(v_email) then
    raise exception 'Registration is limited to Arch Vista email addresses.' using errcode = '42501';
  end if;

  -- The developer becomes superuser only once they prove control of the mailbox.
  v_status := case when v_is_dev and v_confirm then 'active'
                   when not v_is_dev and v_auto then 'active'
                   else 'pending' end;

  insert into public.profiles (id, email, first_name, last_name, job_title, department, phone, status,
                               is_developer, is_superuser, approved_at)
  values (new.id, v_email,
          left(coalesce(btrim(v_meta->>'firstName'), ''), 80),
          left(coalesce(btrim(v_meta->>'lastName'), ''), 80),
          nullif(left(btrim(v_meta->>'jobTitle'), 120), ''),
          nullif(left(btrim(v_meta->>'department'), 120), ''),
          nullif(left(btrim(v_meta->>'phone'), 30), ''),
          v_status, v_is_dev, v_is_dev and v_confirm,
          case when v_status = 'active' then now() end);
  insert into public.profile_private (user_id) values (new.id);

  insert into public.user_roles (user_id, role_id)
  select new.id, id from public.roles
  where (v_is_dev and name = 'Administrator') or (not v_is_dev and is_default);

  insert into public.audit_log (user_id, user_email, action, entity_type, entity_id, details)
  values (new.id, v_email, 'user.register', 'user', new.id::text, jsonb_build_object('status', v_status));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Email confirmation + email change handling.
create or replace function public.handle_user_updated()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email is distinct from old.email then
    if not public.email_allowed(new.email) then
      raise exception 'Email must be an Arch Vista address.' using errcode = '42501';
    end if;
    update public.profiles set email = lower(new.email), updated_at = now() where id = new.id;
  end if;

  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    update public.profiles
       set is_superuser = true, status = 'active', approved_at = coalesce(approved_at, now()), updated_at = now()
     where id = new.id and is_developer;
  end if;

  if new.last_sign_in_at is distinct from old.last_sign_in_at then
    update public.profiles set last_login_at = new.last_sign_in_at where id = new.id;
    insert into public.audit_log (user_id, user_email, action, entity_type, entity_id)
    values (new.id, lower(new.email), 'auth.login', 'user', new.id::text);
  end if;
  return new;
end $$;

create trigger on_auth_user_updated
  after update on auth.users
  for each row execute function public.handle_user_updated();

-- Keep updated_at honest.
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger private_touch  before update on public.profile_private for each row execute function public.touch_updated_at();
create trigger roles_touch    before update on public.roles for each row execute function public.touch_updated_at();

-- Generic audit for lookups edited directly through RLS.
create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  perform public.write_audit(
    lower(tg_table_name) || '.' || lower(tg_op), tg_table_name,
    coalesce(r->>'id', r->>'key'),
    case when tg_op = 'UPDATE' then jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new)) else r end);
  return coalesce(new, old);
end $$;

create trigger locations_audit  after insert or update or delete on public.locations  for each row execute function public.audit_row_change();
create trigger categories_audit after insert or update or delete on public.categories for each row execute function public.audit_row_change();
create trigger priorities_audit after insert or update or delete on public.priorities for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------------
-- Table privileges: RLS decides rows; column grants narrow self-service edits.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke insert, update, delete on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant select on public.app_settings to anon;

-- Users may edit only these columns of their own profile.
grant update (first_name, last_name, preferred_name, job_title, department, phone, extension, mobile,
              shift, certifications, skills, bio, avatar_path) on public.profiles to authenticated;
grant insert, update (emergency_contact_name, emergency_contact_phone) on public.profile_private to authenticated;
grant insert, update on public.locations, public.categories to authenticated;
grant update (label, sla_hours, color, description, is_active) on public.priorities to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- Settings: public read (sign-in page shows facility); writes via RPC only.
create policy settings_read on public.app_settings for select to anon, authenticated using (true);

-- RBAC catalogue: readable by active users; writes via RPC only.
create policy perms_read  on public.permissions      for select to authenticated using (public.is_active_user());
create policy roles_read  on public.roles            for select to authenticated using (public.is_active_user());
create policy rp_read     on public.role_permissions for select to authenticated using (public.is_active_user());
create policy ur_read     on public.user_roles       for select to authenticated using (public.is_active_user() or user_id = auth.uid());

-- Profiles: everyone active sees the staff directory (names/titles needed on work
-- orders); you always see yourself. Self-edit limited by column grants above.
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active_user());
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Personal data: only the person and user administrators.
create policy private_read on public.profile_private for select to authenticated
  using (user_id = auth.uid() or public.has_perm('users.manage'));
create policy private_insert on public.profile_private for insert to authenticated
  with check (user_id = auth.uid());
create policy private_update on public.profile_private for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Lookups: read by active users; edit with settings.manage (audited by trigger).
create policy loc_read   on public.locations  for select to authenticated using (public.is_active_user());
create policy loc_insert on public.locations  for insert to authenticated with check (public.has_perm('settings.manage'));
create policy loc_update on public.locations  for update to authenticated using (public.has_perm('settings.manage')) with check (public.has_perm('settings.manage'));
create policy cat_read   on public.categories for select to authenticated using (public.is_active_user());
create policy cat_insert on public.categories for insert to authenticated with check (public.has_perm('settings.manage'));
create policy cat_update on public.categories for update to authenticated using (public.has_perm('settings.manage')) with check (public.has_perm('settings.manage'));
create policy pri_read   on public.priorities for select to authenticated using (public.is_active_user());
create policy pri_update on public.priorities for update to authenticated using (public.has_perm('settings.manage')) with check (public.has_perm('settings.manage'));

-- Work orders and children: row visibility only; all writes go through RPCs.
create policy wo_read on public.work_orders for select to authenticated
  using (deleted_at is null and public.is_active_user()
         and (public.has_perm('workorders.view_all') or requester_id = auth.uid() or assignee_id = auth.uid()));
create policy woc_read on public.wo_comments for select to authenticated
  using (public.can_see_wo(work_order_id)
         and (not is_internal or public.has_perm('workorders.work') or public.has_perm('workorders.view_all')));
create policy woh_read on public.wo_history     for select to authenticated using (public.can_see_wo(work_order_id));
create policy woa_read on public.wo_attachments for select to authenticated using (public.can_see_wo(work_order_id));

-- Logs.
create policy audit_read  on public.audit_log  for select to authenticated using (public.has_perm('audit.view'));
create policy errors_read on public.error_logs for select to authenticated using (public.has_perm('errors.view'));

-- ---------------------------------------------------------------------------
-- Read model for lists (security_invoker → RLS of the caller applies)
-- ---------------------------------------------------------------------------
create view public.work_orders_v with (security_invoker = true) as
select w.*,
       p.label  as priority_label, p.color as priority_color, p.rank as priority_rank,
       c.name   as category_name,
       l.building as location_building, l.unit as location_unit, l.name as location_name,
       nullif(btrim(ru.first_name || ' ' || ru.last_name), '') as requester_name, ru.email as requester_email,
       nullif(btrim(coalesce(au.preferred_name, au.first_name) || ' ' || au.last_name), '') as assignee_name,
       au.avatar_path as assignee_avatar,
       nullif(btrim(tu.first_name || ' ' || tu.last_name), '') as tools_accounted_name,
       (w.due_at is not null and w.due_at < now() and w.status in ('open','assigned','in_progress','on_hold')) as is_overdue,
       (w.status in ('open','assigned','in_progress','on_hold')) as is_active
from public.work_orders w
join public.priorities p on p.key = w.priority_key
left join public.categories c on c.id = w.category_id
left join public.locations  l on l.id = w.location_id
left join public.profiles  ru on ru.id = w.requester_id
left join public.profiles  au on au.id = w.assignee_id
left join public.profiles  tu on tu.id = w.tools_accounted_by;

grant select on public.work_orders_v to authenticated;

-- Internal helpers are not callable from the API.
revoke execute on function public.write_audit(text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_user_updated() from public, anon, authenticated;
revoke execute on function public.audit_row_change() from public, anon, authenticated;
revoke execute on function public.email_allowed(text) from public, anon, authenticated;

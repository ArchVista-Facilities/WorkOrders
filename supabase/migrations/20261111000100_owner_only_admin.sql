-- =============================================================================
-- AVBH Work Orders — 005 owner-only administration
--
-- Everything that changes how the site works (settings, locations/categories/
-- priorities, roles & permissions, user administration, error logs, audit log,
-- deleting work orders) is reserved for the developer account. Roles can only
-- grant day-to-day access (submitting, viewing, working and closing work orders,
-- reports, the staff directory).
-- =============================================================================

-- 1. Flag owner-only permissions --------------------------------------------
alter table public.permissions add column if not exists superuser_only boolean not null default false;

update public.permissions set superuser_only = (key in (
  'settings.manage', 'roles.manage', 'users.manage',
  'errors.view', 'errors.manage', 'audit.view', 'workorders.delete'));

-- 2. Roles can never carry them ---------------------------------------------
delete from public.role_permissions rp
using public.permissions p
where p.key = rp.permission_key and p.superuser_only;

update public.roles
   set description = 'Full work-order operations and reports. Site settings and administration are owner-only.'
 where name = 'Administrator' and is_system;

-- 3. Permission check: owner-only permissions are honored for superusers only.
create or replace function public.has_perm(p text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.status = 'active'
      and (pr.is_superuser or (
        not exists (select 1 from public.permissions x where x.key = p and x.superuser_only)
        and exists (
          select 1 from public.user_roles ur
          join public.role_permissions rp on rp.role_id = ur.role_id
          where ur.user_id = pr.id and rp.permission_key = p)))
  );
$$;

-- 4. Superuser is the developer account only --------------------------------
update public.profiles set is_superuser = false where is_superuser and not is_developer;

alter table public.profiles drop constraint if exists profiles_superuser_is_developer;
alter table public.profiles add constraint profiles_superuser_is_developer check (not is_superuser or is_developer);

create or replace function public.admin_set_superuser(p_user uuid, p_flag boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Superuser access belongs to the owner account and cannot be granted or revoked.' using errcode = '42501';
end $$;

-- 5. Role editor rejects owner-only permissions ------------------------------
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
  select x into v_bad from unnest(v_perms) x join public.permissions pm on pm.key = x where pm.superuser_only limit 1;
  if v_bad is not null then raise exception 'That permission is owner-only and cannot be given to a role (%).', v_bad using errcode = '42501'; end if;
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

-- Belt and braces: no row path can attach an owner-only permission to a role.
create or replace function public.role_permissions_block_owner_only()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.permissions where key = new.permission_key and superuser_only) then
    raise exception 'That permission is owner-only and cannot be given to a role (%).', new.permission_key using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists role_permissions_owner_only on public.role_permissions;
create trigger role_permissions_owner_only before insert or update on public.role_permissions
  for each row execute function public.role_permissions_block_owner_only();

revoke execute on function public.role_permissions_block_owner_only() from public, anon, authenticated;

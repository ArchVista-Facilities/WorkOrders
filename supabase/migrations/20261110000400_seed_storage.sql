-- =============================================================================
-- AVBH Work Orders — 004 seed data + storage buckets
-- =============================================================================

-- Settings ------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('facility', '{"name":"Arch Vista Behavioral Health","street":"5500 South Broadway Street","city":"St. Louis","state":"MO","zip":"63111"}'),
  ('allowed_domains', '["archvistabh.com"]'),
  -- Placeholder: on a fresh project, set the real developer address afterwards with
  --   update public.app_settings set value = to_jsonb('<address>'::text) where key = 'developer_email';
  ('developer_email', '"developer@example.invalid"'),
  ('auto_approve_domain_users', 'false'),
  ('wo_prefix', '"WO"')
on conflict (key) do nothing;

-- Permission catalogue (add rows here when you add a module) ----------------
insert into public.permissions (key, module, label, description) values
  ('workorders.create',   'workorders', 'Submit work orders',        'Create new work order requests'),
  ('workorders.view_all', 'workorders', 'View all work orders',      'See every work order, not just own/assigned'),
  ('workorders.edit',     'workorders', 'Edit work orders',          'Edit any field on any visible work order'),
  ('workorders.assign',   'workorders', 'Assign work orders',        'Assign and reassign technicians'),
  ('workorders.work',     'workorders', 'Perform work',              'Be assigned; start, hold, and complete work orders'),
  ('workorders.close',    'workorders', 'Close / reopen',            'Close completed work orders and reopen closed ones'),
  ('workorders.delete',   'workorders', 'Delete work orders',        'Remove work orders (soft delete, audited)'),
  ('users.view',          'users',      'View staff directory',      'See the Users list and profiles'),
  ('users.manage',        'users',      'Manage users',              'Approve, disable, edit profiles, assign roles, send password resets'),
  ('roles.manage',        'roles',      'Manage roles & permissions','Create and edit roles and what each role can do'),
  ('settings.manage',     'settings',   'Manage settings',           'Edit facility info, locations, categories, priorities and registration policy'),
  ('reports.view',        'reports',    'View reports',              'KPIs, workload, SLA compliance, exports'),
  ('errors.view',         'errors',     'View error logs',           'See application errors and problem reports'),
  ('errors.manage',       'errors',     'Manage error logs',         'Acknowledge, resolve, ignore and purge error logs'),
  ('audit.view',          'audit',      'View audit log',            'See who did what and when across the system')
on conflict (key) do update set module = excluded.module, label = excluded.label, description = excluded.description;

-- Default roles -------------------------------------------------------------
insert into public.roles (name, description, is_system, is_default) values
  ('Administrator',          'Full operational control except superuser-only actions.', true, false),
  ('Maintenance Supervisor', 'Dispatches, assigns, closes, and reports on all work.', true, false),
  ('Maintenance Technician', 'Receives assignments and performs work.', true, false),
  ('Staff Requester',        'Any staff member: submits and tracks their own requests. Default for new accounts.', true, true),
  ('Leadership / Viewer',    'Read-only visibility into all work and reports (e.g. CEO, DON, Safety Officer).', true, false)
on conflict (name) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r join public.permissions p on
  (r.name = 'Administrator') or
  (r.name = 'Maintenance Supervisor' and p.key in ('workorders.create','workorders.view_all','workorders.edit','workorders.assign',
                                                    'workorders.work','workorders.close','reports.view','users.view')) or
  (r.name = 'Maintenance Technician' and p.key in ('workorders.create','workorders.view_all','workorders.work','users.view')) or
  (r.name = 'Staff Requester'        and p.key in ('workorders.create')) or
  (r.name = 'Leadership / Viewer'    and p.key in ('workorders.view_all','reports.view','users.view'))
on conflict do nothing;

-- Priorities / response targets ---------------------------------------------
insert into public.priorities (key, label, rank, sla_hours, color, description) values
  ('emergency', 'Emergency',      1,   1, '#b42318', 'Immediate threat to life safety, patient/staff safety, security, or an active ligature hazard in an occupied area.'),
  ('urgent',    'Urgent',         2,   4, '#c4320a', 'Affects patient care, security, or environment-of-care compliance; must be addressed this shift.'),
  ('high',      'High',           3,  24, '#b54708', 'Significant impact on operations or comfort; complete within 24 hours.'),
  ('routine',   'Routine',        4, 120, '#175cd3', 'Standard repair; complete within 5 days.'),
  ('scheduled', 'Scheduled / PM', 5, 720, '#475467', 'Planned, preventive, or project work.')
on conflict (key) do nothing;

-- Categories ----------------------------------------------------------------
insert into public.categories (name, description, sort_order) values
  ('Ligature / Patient Safety',   'Ligature-resistant fixtures, anti-tamper hardware, environmental risk items', 0),
  ('Doors, Locks & Security',     'Door hardware, access control, sally ports, keys, cameras', 10),
  ('Life Safety / Fire',          'Fire alarm, sprinklers, extinguishers, egress, emergency lighting', 20),
  ('Plumbing',                    'Fixtures, leaks, drains, water heaters', 30),
  ('Electrical',                  'Power, lighting, outlets, panels, generator', 40),
  ('HVAC',                        'Heating, cooling, ventilation, air quality', 50),
  ('Furniture & Fixtures',        'Patient furniture, casework, mounted fixtures', 60),
  ('Painting & Drywall',          'Wall repair, patching, painting', 70),
  ('Flooring & Ceilings',         'Flooring, ceiling tiles, trip hazards', 80),
  ('Kitchen / Dietary Equipment', 'Food service equipment and refrigeration', 90),
  ('IT / Low Voltage',            'Network drops, phones, nurse call, TV/cable', 100),
  ('Grounds & Exterior',          'Parking, lighting, sidewalks, snow/ice, fencing, courtyards', 110),
  ('Pest Control',                'Pest sightings and treatment', 120),
  ('Housekeeping Support',        'Spills, biohazard cleanup coordination, moves', 130),
  ('Preventive Maintenance',      'Scheduled PM tasks and inspections', 140),
  ('Other',                       'Anything not covered above', 150)
on conflict (name) do nothing;

-- Starter locations (rename to the real floor plan in Settings) -------------
insert into public.locations (building, unit, name, is_patient_area, sort_order)
select * from (values
  ('Main Building', 'Admissions',     'Lobby / Admissions',          false,  0),
  ('Main Building', 'Administration', 'Administrative Offices',      false, 10),
  ('Main Building', 'Patient Unit 1', 'Patient Unit 1 (rename)',     true,  20),
  ('Main Building', 'Patient Unit 2', 'Patient Unit 2 (rename)',     true,  30),
  ('Main Building', 'Dietary',        'Kitchen / Dining',            true,  40),
  ('Main Building', 'Mechanical',     'Mechanical / Boiler Room',    false, 50),
  ('Exterior',      null,             'Grounds / Parking',           false, 60)
) v(building, unit, name, is_patient_area, sort_order)
where not exists (select 1 from public.locations);

-- Storage -------------------------------------------------------------------
-- Private buckets; the browser fetches short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars',     'avatars',     false,  2097152, array['image/png','image/jpeg','image/webp','image/gif']),
  ('attachments', 'attachments', false, 10485760, array['image/png','image/jpeg','image/webp','image/gif','application/pdf'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

-- Avatars: "<user_id>/<file>". Staff photos visible to active staff;
-- writable by the owner or a user administrator.
create policy avatars_read on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (public.is_active_user() or (storage.foldername(name))[1] = auth.uid()::text));
create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_perm('users.manage')));
create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_perm('users.manage')));
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_perm('users.manage')));

-- Attachments: "<work_order_id>/<file>". Same visibility as the work order.
create policy attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.can_see_wo_path(name));
create policy attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.can_see_wo_path(name));
create policy attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and public.can_see_wo_path(name)
         and (owner_id = auth.uid()::text or public.has_perm('workorders.edit')));

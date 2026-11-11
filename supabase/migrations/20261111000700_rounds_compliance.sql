-- =============================================================================
-- AVBH Work Orders — 007 rounds (fillable inspection forms) + compliance tracker
--
-- Structure only. Form content (checklist questions) and tracker tasks/entries
-- are facility data: they are loaded directly into the database and are never
-- committed to this public repository.
--
-- Both modules are owner-only (superuser_only permissions, see 005).
-- Also: every new work order is routed to the owner, the facility's single
-- technician.
-- =============================================================================

-- Permissions --------------------------------------------------------------
insert into public.permissions (key, module, label, description, superuser_only) values
  ('rounds.manage',     'rounds',     'Rounds & inspection forms', 'Fill out, review and manage EOC / infection-control rounds and other inspection forms', true),
  ('compliance.manage', 'compliance', 'Compliance tracker',        'Log and manage recurring compliance tasks (EOC dashboard)', true)
on conflict (key) do update set module = excluded.module, label = excluded.label,
  description = excluded.description, superuser_only = excluded.superuser_only;

-- Shared updated_at toucher (exists from 002 as touch_updated_at) -------------

-- ---------------------------------------------------------------------------
-- Rounds / forms
-- ---------------------------------------------------------------------------
-- definition shape:
-- { "header":   [ {key,label,type:'date'|'time'|'text'|'location'|'choice', options?, required?} ],
--   "sections": [ {key,title, items:[ {key,label,type:'ynna'|'rating'|'choice'|'text'|'signoff',
--                                       bad?:'yes'|'no', sub?:[label], options?, min?, max?,
--                                       minLabel?, maxLabel?, rows?} ] } ] }
create table public.form_templates (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 1 and 150),
  description text check (char_length(description) <= 1000),
  definition  jsonb not null check (jsonb_typeof(definition) = 'object'),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.form_submissions (
  id            bigint generated always as identity primary key,
  template_id   bigint not null references public.form_templates(id),
  template_name text not null check (char_length(template_name) <= 150),
  definition    jsonb not null,                 -- snapshot, so later template edits never change old rounds
  status        text not null default 'draft' check (status in ('draft', 'submitted')),
  header        jsonb not null default '{}'::jsonb check (jsonb_typeof(header) = 'object'),
  answers       jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  round_date    date,
  location_id   bigint references public.locations(id),
  findings      int not null default 0,         -- count of non-compliant answers (kept by the client on save)
  created_by    uuid not null default auth.uid() references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  check (pg_column_size(answers) < 512000)
);
create index form_submissions_date_idx on public.form_submissions (round_date desc, id desc);

create table public.form_photos (
  id            bigint generated always as identity primary key,
  submission_id bigint not null references public.form_submissions(id) on delete cascade,
  item_key      text check (char_length(item_key) <= 80),
  storage_path  text not null unique check (char_length(storage_path) <= 300),
  original_name text check (char_length(original_name) <= 255),
  mime_type     text,
  size_bytes    int,
  created_by    uuid not null default auth.uid() references public.profiles(id),
  created_at    timestamptz not null default now()
);
create index form_photos_sub_idx on public.form_photos (submission_id);

-- ---------------------------------------------------------------------------
-- Compliance tracker
-- ---------------------------------------------------------------------------
create table public.compliance_tasks (
  id                       bigint generated always as identity primary key,
  name                     text not null check (char_length(name) between 1 and 200),
  cadence                  text not null check (cadence in ('monthly', 'quarterly', 'semiannual', 'annual', 'misc')),
  counts_toward_compliance boolean not null default true,  -- included in the weighted YTD calculation
  due_month                smallint check (due_month between 1 and 12), -- annual "DUE" marker
  interval_label           text check (char_length(interval_label) <= 60),  -- misc items, e.g. "Every 36 months"
  next_due                 date,                            -- misc items
  notes                    text check (char_length(notes) <= 1000),
  sort_order               int not null default 0,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table public.compliance_entries (
  id         bigint generated always as identity primary key,
  task_id    bigint not null references public.compliance_tasks(id) on delete cascade,
  done_on    date not null,
  note       text check (char_length(note) <= 500),
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
create index compliance_entries_task_idx on public.compliance_entries (task_id, done_on);

-- ---------------------------------------------------------------------------
-- Triggers: updated_at, audit
-- ---------------------------------------------------------------------------
create trigger form_templates_touch    before update on public.form_templates    for each row execute function public.touch_updated_at();
create trigger form_submissions_touch  before update on public.form_submissions  for each row execute function public.touch_updated_at();
create trigger compliance_tasks_touch  before update on public.compliance_tasks  for each row execute function public.touch_updated_at();

create trigger form_templates_audit     after insert or update or delete on public.form_templates     for each row execute function public.audit_row_change();
create trigger compliance_tasks_audit   after insert or update or delete on public.compliance_tasks   for each row execute function public.audit_row_change();
create trigger compliance_entries_audit after insert or update or delete on public.compliance_entries for each row execute function public.audit_row_change();

-- Submissions autosave often; audit only creation, submit/reopen and deletion.
create or replace function public.form_submission_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_audit('round.create', 'form_submission', new.id::text, jsonb_build_object('form', new.template_name));
  elsif tg_op = 'DELETE' then
    perform public.write_audit('round.delete', 'form_submission', old.id::text, jsonb_build_object('form', old.template_name, 'date', old.round_date));
  elsif new.status is distinct from old.status then
    perform public.write_audit(case when new.status = 'submitted' then 'round.submit' else 'round.reopen' end,
      'form_submission', new.id::text, jsonb_build_object('form', new.template_name, 'findings', new.findings));
  end if;
  return coalesce(new, old);
end $$;
create trigger form_submissions_audit after insert or update or delete on public.form_submissions
  for each row execute function public.form_submission_audit();
revoke execute on function public.form_submission_audit() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Privileges + RLS: owner-only through has_perm()
-- ---------------------------------------------------------------------------
revoke all on public.form_templates, public.form_submissions, public.form_photos,
              public.compliance_tasks, public.compliance_entries from anon, authenticated;
grant select, insert, update, delete on public.form_templates, public.form_submissions, public.form_photos,
              public.compliance_tasks, public.compliance_entries to authenticated;

alter table public.form_templates     enable row level security;
alter table public.form_submissions   enable row level security;
alter table public.form_photos        enable row level security;
alter table public.compliance_tasks   enable row level security;
alter table public.compliance_entries enable row level security;

create policy ft_all on public.form_templates     for all to authenticated using (public.has_perm('rounds.manage'))     with check (public.has_perm('rounds.manage'));
create policy fs_all on public.form_submissions   for all to authenticated using (public.has_perm('rounds.manage'))     with check (public.has_perm('rounds.manage'));
create policy fp_all on public.form_photos        for all to authenticated using (public.has_perm('rounds.manage'))     with check (public.has_perm('rounds.manage'));
create policy ct_all on public.compliance_tasks   for all to authenticated using (public.has_perm('compliance.manage')) with check (public.has_perm('compliance.manage'));
create policy ce_all on public.compliance_entries for all to authenticated using (public.has_perm('compliance.manage')) with check (public.has_perm('compliance.manage'));

-- Photo storage: private bucket, "<submission_id>/<file>"
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('form-photos', 'form-photos', false, 10485760, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

create policy form_photos_read   on storage.objects for select to authenticated using (bucket_id = 'form-photos' and public.has_perm('rounds.manage'));
create policy form_photos_insert on storage.objects for insert to authenticated with check (bucket_id = 'form-photos' and public.has_perm('rounds.manage'));
create policy form_photos_delete on storage.objects for delete to authenticated using (bucket_id = 'form-photos' and public.has_perm('rounds.manage'));

-- ---------------------------------------------------------------------------
-- Single technician: new work orders go straight to the owner account.
-- ---------------------------------------------------------------------------
create or replace function public.wo_default_assignee()
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.profiles where is_developer and is_superuser and status = 'active' order by created_at limit 1;
$$;
revoke execute on function public.wo_default_assignee() from public, anon, authenticated;

create or replace function public.wo_auto_assign()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is null then
    new.assignee_id := public.wo_default_assignee();
    if new.assignee_id is not null and new.status = 'open' then new.status := 'assigned'; end if;
  end if;
  return new;
end $$;
revoke execute on function public.wo_auto_assign() from public, anon, authenticated;

drop trigger if exists work_orders_auto_assign on public.work_orders;
create trigger work_orders_auto_assign before insert on public.work_orders
  for each row execute function public.wo_auto_assign();

-- Allow the compliance CSV export to be audited like the other exports.
create or replace function public.log_client_event(p_action text, p_details jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_active();
  if p_action not in ('workorder.export', 'report.export', 'audit.export', 'error.export', 'compliance.export') then
    raise exception 'Unsupported event.' using errcode = '22023';
  end if;
  perform public.write_audit(p_action, split_part(p_action, '.', 1), null, p_details);
end $$;

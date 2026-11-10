-- =============================================================================
-- AVBH Work Orders — 001 schema
-- Arch Vista Behavioral Health · 5500 South Broadway Street · St. Louis, MO 63111
--
-- All tables live in `public` with Row Level Security enabled. Clients (the
-- GitHub Pages web app) talk to PostgREST with the publishable key; every rule
-- that matters is enforced here, never in the browser.
--
-- HIPAA: this database is designed NOT to hold PHI. Work orders reference rooms
-- and units only. The UI warns users at every free-text entry point.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Settings (facility identity, registration policy, numbering)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- ---------------------------------------------------------------------------
-- Identity & RBAC
-- ---------------------------------------------------------------------------
create table public.permissions (
  key         text primary key,
  module      text not null,
  label       text not null,
  description text
);

create table public.roles (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  description text,
  is_system   boolean not null default false,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.role_permissions (
  role_id        bigint not null references public.roles(id) on delete cascade,
  permission_key text   not null references public.permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

-- One row per auth user, created by trigger on auth.users.
create table public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text not null unique,
  first_name     text not null default '' check (char_length(first_name) <= 80),
  last_name      text not null default '' check (char_length(last_name) <= 80),
  preferred_name text check (char_length(preferred_name) <= 80),
  job_title      text check (char_length(job_title) <= 120),
  department     text check (char_length(department) <= 120),
  employee_id    text check (char_length(employee_id) <= 40),
  hire_date      date,
  phone          text check (char_length(phone) <= 30),
  extension      text check (char_length(extension) <= 10),
  mobile         text check (char_length(mobile) <= 30),
  shift          text check (shift in ('Day','Evening','Night','Rotating','On-Call','Weekend')),
  supervisor_id  uuid references public.profiles(id) on delete set null,
  certifications text check (char_length(certifications) <= 2000),
  skills         text check (char_length(skills) <= 2000),
  bio            text check (char_length(bio) <= 2000),
  -- Avatar objects must live in the owner's own storage folder.
  avatar_path    text check (avatar_path is null or avatar_path like (id::text || '/%')),
  status         text not null default 'pending' check (status in ('pending','active','disabled')),
  is_superuser   boolean not null default false,
  is_developer   boolean not null default false,
  approved_by    uuid references public.profiles(id) on delete set null,
  approved_at    timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint no_self_supervisor check (supervisor_id is null or supervisor_id <> id)
);
create index profiles_status_idx on public.profiles(status);

-- Personal data separated so row-level rules can hide it from coworkers.
create table public.profile_private (
  user_id                 uuid primary key references public.profiles(id) on delete cascade,
  emergency_contact_name  text check (char_length(emergency_contact_name) <= 120),
  emergency_contact_phone text check (char_length(emergency_contact_phone) <= 30),
  updated_at              timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid   not null references public.profiles(id) on delete cascade,
  role_id bigint not null references public.roles(id) on delete cascade,
  primary key (user_id, role_id)
);

-- ---------------------------------------------------------------------------
-- Audit & error logs
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  user_email  text,
  action      text not null,
  entity_type text,
  entity_id   text,
  details     jsonb
);
create index audit_at_idx on public.audit_log(at desc);
create index audit_entity_idx on public.audit_log(entity_type, entity_id);
create index audit_user_idx on public.audit_log(user_id);

create table public.error_logs (
  id               bigint generated always as identity primary key,
  fingerprint      text not null,
  level            text not null default 'error' check (level in ('error','warn','info','fatal')),
  source           text not null check (source in ('client','user_report','database')),
  message          text not null,
  stack            text,
  route            text,
  status_code      int,
  user_id          uuid,
  user_email       text,
  request_id       text,
  user_agent       text,
  context          jsonb,
  occurrences      int not null default 1,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  status           text not null default 'open' check (status in ('open','acknowledged','resolved','ignored')),
  resolution_notes text,
  resolved_by      uuid references public.profiles(id) on delete set null,
  resolved_at      timestamptz
);
create index error_fp_idx on public.error_logs(fingerprint);
create index error_last_idx on public.error_logs(last_seen_at desc);
create index error_status_idx on public.error_logs(status);

-- ---------------------------------------------------------------------------
-- Lookups
-- ---------------------------------------------------------------------------
create table public.locations (
  id              bigint generated always as identity primary key,
  building        text not null check (char_length(building) between 1 and 100),
  unit            text check (char_length(unit) <= 100),
  name            text not null check (char_length(name) between 1 and 150),
  is_patient_area boolean not null default false,
  is_active       boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);

create table public.categories (
  id          bigint generated always as identity primary key,
  name        text not null unique check (char_length(name) between 1 and 100),
  description text check (char_length(description) <= 300),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create table public.priorities (
  key         text primary key,
  label       text not null check (char_length(label) between 1 and 40),
  rank        int not null,                    -- 1 = most urgent
  sla_hours   int not null check (sla_hours between 1 and 8760),
  color       text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  description text check (char_length(description) <= 300),
  is_active   boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Work orders
-- ---------------------------------------------------------------------------
create table public.work_orders (
  id                  bigint generated always as identity primary key,
  wo_number           text not null unique,
  title               text not null check (char_length(title) between 1 and 150),
  description         text not null check (char_length(description) between 1 and 5000),
  type                text not null default 'corrective'
                        check (type in ('corrective','preventive','inspection','safety','project','request')),
  category_id         bigint references public.categories(id),
  location_id         bigint references public.locations(id),
  location_detail     text check (char_length(location_detail) <= 150),
  asset_tag           text check (char_length(asset_tag) <= 60),
  priority_key        text not null references public.priorities(key),
  status              text not null default 'open'
                        check (status in ('open','assigned','in_progress','on_hold','completed','closed','cancelled')),
  ligature_risk       boolean not null default false,
  patient_area        boolean not null default false,
  area_out_of_service boolean not null default false,
  escort_required     boolean not null default false,
  requester_id        uuid not null references public.profiles(id),
  contact_phone       text check (char_length(contact_phone) <= 30),
  assignee_id         uuid references public.profiles(id),
  due_at              timestamptz,
  started_at          timestamptz,
  completed_at        timestamptz,
  closed_at           timestamptz,
  cancelled_at        timestamptz,
  labor_hours         numeric(8,2) check (labor_hours >= 0),
  parts_cost          numeric(12,2) check (parts_cost >= 0),
  resolution          text check (char_length(resolution) <= 5000),
  tools_accounted_by  uuid references public.profiles(id),
  tools_accounted_at  timestamptz,
  custom_fields       jsonb not null default '{}'::jsonb,   -- extension point
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index wo_status_idx    on public.work_orders(status) where deleted_at is null;
create index wo_assignee_idx  on public.work_orders(assignee_id, status);
create index wo_requester_idx on public.work_orders(requester_id);
create index wo_priority_idx  on public.work_orders(priority_key);
create index wo_created_idx   on public.work_orders(created_at desc);
create index wo_due_idx       on public.work_orders(due_at);
create index wo_location_idx  on public.work_orders(location_id);
create index wo_category_idx  on public.work_orders(category_id);

create table public.wo_sequences (
  year       int primary key,
  last_value int not null
);

create table public.wo_comments (
  id            bigint generated always as identity primary key,
  work_order_id bigint not null references public.work_orders(id) on delete cascade,
  user_id       uuid not null references public.profiles(id),
  body          text not null check (char_length(body) between 1 and 4000),
  is_internal   boolean not null default false,
  created_at    timestamptz not null default now()
);
create index woc_wo_idx on public.wo_comments(work_order_id);

create table public.wo_history (
  id            bigint generated always as identity primary key,
  work_order_id bigint not null references public.work_orders(id) on delete cascade,
  user_id       uuid references public.profiles(id),
  action        text not null,
  field         text,
  old_value     text,
  new_value     text,
  note          text,
  created_at    timestamptz not null default now()
);
create index woh_wo_idx on public.wo_history(work_order_id);

create table public.wo_attachments (
  id            bigint generated always as identity primary key,
  work_order_id bigint not null references public.work_orders(id) on delete cascade,
  user_id       uuid not null references public.profiles(id),
  original_name text not null check (char_length(original_name) <= 150),
  storage_path  text not null unique,
  mime_type     text not null,
  size_bytes    int not null,
  created_at    timestamptz not null default now()
);
create index woa_wo_idx on public.wo_attachments(work_order_id);

-- Everything starts locked; policies in the next migration open what's needed.
alter table public.app_settings     enable row level security;
alter table public.permissions      enable row level security;
alter table public.roles            enable row level security;
alter table public.role_permissions enable row level security;
alter table public.profiles         enable row level security;
alter table public.profile_private  enable row level security;
alter table public.user_roles       enable row level security;
alter table public.audit_log        enable row level security;
alter table public.error_logs       enable row level security;
alter table public.locations        enable row level security;
alter table public.categories       enable row level security;
alter table public.priorities       enable row level security;
alter table public.work_orders      enable row level security;
alter table public.wo_sequences     enable row level security;
alter table public.wo_comments      enable row level security;
alter table public.wo_history       enable row level security;
alter table public.wo_attachments   enable row level security;

# AVBH Work Order Management

Facility work-order suite for **Arch Vista Behavioral Health**
5500 South Broadway Street · St. Louis, MO 63111

**Live:** https://archvista-facilities.github.io/WorkOrders/

Request → dispatch → work → complete → close, built for a behavioral-health environment: ligature-risk escalation, tool-control attestation on patient units, out-of-service tracking, role-based access, error logging, an audit trail, and reporting.

## Architecture

| Layer | Where | Notes |
|---|---|---|
| Web app | GitHub Pages (`site/`) | Static HTML/CSS/vanilla JS, no build step. Deployed by `.github/workflows/pages.yml` on every push to `main`. |
| Auth | Supabase Auth | Email + password, email verification, password-reset links. |
| Data & rules | Supabase Postgres (`supabase/migrations/`) | Row Level Security on every table; every write goes through a permission-checked SQL function. |
| Files | Supabase Storage | Private `avatars` and `attachments` buckets; short-lived signed URLs. |

The browser holds only the **publishable** key, which identifies the project and grants nothing by itself. All authorization lives in the database, so nothing a user does in the browser can bypass it. CI fails the deploy if a secret key ever appears in `site/`.

## Account policy

- **Who can register:** exact `@archvistabh.com` addresses only, with no subdomains. A database trigger rejects every other address before the account is created.
- **Developer account:** `paulmmoore3416@gmail.com` is the single exception. It becomes superuser automatically once its email is confirmed, and it can't be disabled or demoted.
- **New staff accounts:** each person confirms their email, then stays **pending** until an administrator approves them under *Users*. Pending and disabled users can't read any data.
- **Roles:** assigned per user. Permissions are edited per role under *Roles & Permissions*. A non-superuser can never grant a permission they don't hold.
- **Default roles:** Administrator · Maintenance Supervisor · Maintenance Technician · Staff Requester (default for new accounts) · Leadership / Viewer.

## Behavioral-health controls

- **Ligature / self-harm risk:** priority is raised to at least *Urgent*, a safety banner appears on the work order, and it gets its own dashboard counter.
- **Tool control:** a job in a patient-care area, or any ligature job, can't be completed until the technician attests that all tools and debris were removed. Their name and the time are recorded.
- **Area flags:** out-of-service and escort-required flags, with a return-to-service step at completion.
- **PHI warnings:** shown on every free-text field. Work orders are facility records and must not contain patient identifiers.

## Error logging & reporting

- **What's captured:** browser errors, failed API calls, and user *Report problem* submissions are logged to `error_logs`.
- **Grouping:** repeat errors are grouped by fingerprint with a count, and a resolved error that recurs is reopened automatically.
- **Triage:** done under *Error Logs* by people with the `errors.manage` permission.
- **Reports:** KPIs, on-time completion %, response and completion times, technician workload, a 12-month trend, and CSV exports.
- **Audit log:** an append-only record of sign-ins, changes, exports, and admin actions.

## Extending

1. **Database.** Add a new migration file in `supabase/migrations/` with any tables, RLS policies, and RPC functions. Insert its permissions into `public.permissions` so they appear in the role editor automatically.
2. **API adapter.** Add routes in `site/js/api.js` with `route('GET', '/thing/:id', handler)`.
3. **Page.** Create `site/js/pages/thing.js` and add one line to `site/js/pages/index.js`, plus a menu entry in `NAV` in `api.js`.

Ideas for next modules: preventive-maintenance schedules, environment-of-care / ligature rounds checklists, parts inventory, asset registry, email or Teams notifications.

## One-time Supabase settings (dashboard)

Set these under **Authentication** in the Supabase dashboard for project `ifthmeicriftzfbjmurk`:

1. **URL Configuration:** set Site URL to `https://archvista-facilities.github.io/WorkOrders/` and add the same URL to Redirect URLs.
2. **Providers → Email:** keep *Confirm email* **on**.
3. **Password requirements:** minimum length 12, with lowercase, uppercase, digits and symbols required.
4. **SMTP:** the built-in sender is limited to a few emails per hour. Before rolling out to staff, configure a real SMTP sender such as Microsoft 365 or Resend.

## Compliance notes

- **No PHI:** the system is designed not to store PHI. If policy ever requires PHI here, first get a BAA from Supabase (paid plan) and complete a risk assessment.
- **Automatic logoff:** happens after 30 minutes idle in the browser. Server-enforced session timeouts require a Supabase Pro plan.
- **Data location:** the database is in AWS us-east-2. Supabase encrypts data at rest and uses TLS in transit.

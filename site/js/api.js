/**
 * Data access layer: Supabase adapter.
 *
 * Pages call `api(path, { method, body, form })` exactly as they did against
 * the original Node server. This module maps each route to Supabase queries
 * (read paths, filtered by Row Level Security) or RPC functions (every write,
 * with permission and workflow checks inside Postgres). Keeping this contract
 * means pages stay backend-agnostic: the same UI could point at a self-hosted
 * server again by swapping this file.
 *
 * To add a feature: add routes with `route(METHOD, '/path/:param', handler)`.
 */
import { SUPABASE_URL, SUPABASE_KEY, APP } from './config.js';

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    flowType: 'pkce', // email links return ?code=… (not #tokens) so the hash router is unaffected
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'avbh-auth',
  },
});

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = code; // shown to users as a reference in error toasts
  }
}

/** Timestamp of the last successful call (idle keepalive uses it). */
export let lastApiAt = Date.now();
/** Ring buffer of recent failures, attached to "Report a problem". */
export const recentErrors = [];

/** Map PostgREST / Postgres / Auth errors to HTTP-like statuses with readable text. */
function toApiError(e, httpStatus) {
  if (e instanceof ApiError) return e;
  const code = String((e && e.code) || '');
  let status = httpStatus && httpStatus >= 400 ? httpStatus : 500;
  if (code === '42501') status = 403;
  else if (code === 'P0002' || code === 'PGRST116') status = 404;
  else if (['28000', 'PGRST301', 'PGRST302', 'PGRST303'].includes(code) || /JWT|not authenticated/i.test(e && e.message)) status = 401;
  else if (code.startsWith('22') || code.startsWith('23')) status = 400;
  let message = (e && e.message) || 'Request failed.';
  if (code === '23505') message = 'That value is already in use.';
  else if (code === '23514') message = 'One of the values is not allowed (check lengths and formats).';
  else if (/Failed to fetch|NetworkError/i.test(message)) {
    message = 'Unable to reach the server. Check your network connection.';
    status = 0;
  }
  return new ApiError(message, status, code || undefined);
}

/** Unwrap a supabase-js result or throw. */
function ok(res) {
  if (res.error) throw toApiError(res.error, res.status);
  return res.data;
}

/** Build a query string, skipping empty values. */
export function qs(params) {
  const p = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  });
  const s = p.toString();
  return s ? `?${s}` : '';
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });
}

/**
 * @param {string} path   e.g. "/workorders?status=active"
 * @param {{method?:string, body?:any, form?:FormData}} [opts]
 */
export async function api(path, { method = 'GET', body, form } = {}) {
  const [p, rawQuery] = path.split('?');
  const query = Object.fromEntries(new URLSearchParams(rawQuery || ''));
  const r = routes.find((x) => x.method === method && x.re.test(p));
  if (!r) throw new ApiError(`Not implemented: ${method} ${p}`, 404);
  const params = p.match(r.re).groups || {};
  try {
    const out = await r.handler({ params, query, body: body || {}, form });
    lastApiAt = Date.now();
    return out;
  } catch (e) {
    const err = toApiError(e);
    if (err.status === 401 && !p.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('avbh:unauthorized'));
    recentErrors.push({ at: new Date().toISOString(), path: `${method} ${p}`, status: err.status, message: err.message, code: err.code });
    if (recentErrors.length > 10) recentErrors.shift();
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Shared constants & shapers                                          */
/* ------------------------------------------------------------------ */

const ACTIVE = ['open', 'assigned', 'in_progress', 'on_hold'];
export const STATUSES = [
  { key: 'open', label: 'Open', active: true },
  { key: 'assigned', label: 'Assigned', active: true },
  { key: 'in_progress', label: 'In Progress', active: true },
  { key: 'on_hold', label: 'On Hold', active: true },
  { key: 'completed', label: 'Completed', active: false },
  { key: 'closed', label: 'Closed', active: false },
  { key: 'cancelled', label: 'Cancelled', active: false },
];
const TYPES = [
  { key: 'corrective', label: 'Corrective / Repair' },
  { key: 'preventive', label: 'Preventive Maintenance' },
  { key: 'inspection', label: 'Inspection / Rounds' },
  { key: 'safety', label: 'Environment of Care / Safety' },
  { key: 'project', label: 'Project / Improvement' },
  { key: 'request', label: 'Service Request' },
];
/** Mirrors wo_set_status() in the database (the database is authoritative). */
const TRANSITIONS = {
  open: ['assigned', 'in_progress', 'on_hold', 'cancelled'],
  assigned: ['in_progress', 'on_hold', 'open', 'cancelled'],
  in_progress: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['in_progress', 'assigned', 'cancelled'],
  completed: ['closed', 'in_progress'],
  closed: ['in_progress'],
  cancelled: ['open'],
};
const SHIFTS = ['Day', 'Evening', 'Night', 'Rotating', 'On-Call', 'Weekend'];

/** Menu definition; entries are filtered by permission. Add a line per new page. */
const NAV = [
  { path: '/dashboard', label: 'Dashboard', icon: 'home', order: 0 },
  { path: '/workorders/new', label: 'New Request', icon: 'plus', permission: 'workorders.create', order: 5 },
  { path: '/workorders', label: 'Work Orders', icon: 'clipboard', order: 10 },
  { path: '/rounds', label: 'Rounds & Inspections', icon: 'checklist', permission: 'rounds.manage', order: 12 },
  { path: '/compliance', label: 'Compliance Tracker', icon: 'calendar', permission: 'compliance.manage', order: 14 },
  { path: '/reports', label: 'Reports', icon: 'chart', permission: 'reports.view', order: 20 },
  { path: '/profile', label: 'My Profile', icon: 'user', order: 80 },
  { path: '/users', label: 'Users', icon: 'users', permission: ['users.view', 'users.manage'], section: 'admin', order: 70 },
  { path: '/roles', label: 'Roles & Permissions', icon: 'shield', permission: 'roles.manage', section: 'admin', order: 75 },
  { path: '/errors', label: 'Error Logs', icon: 'alert', permission: 'errors.view', section: 'admin', order: 85 },
  { path: '/audit', label: 'Audit Log', icon: 'list', permission: 'audit.view', section: 'admin', order: 88 },
  { path: '/settings', label: 'Settings', icon: 'settings', permission: 'settings.manage', section: 'admin', order: 90 },
];

/** Current user context, refreshed by GET /meta. */
const me = { id: null, isSuperuser: false, perms: new Set() };
const can = (k) => me.isSuperuser || me.perms.has(k);

const fullName = (first, last, preferred) => `${preferred || first || ''} ${last || ''}`.trim();

/** profiles row (+ optional private row) → UI user shape. */
function publicUser(p, priv) {
  if (!p) return null;
  return {
    id: p.id,
    email: p.email,
    firstName: p.first_name,
    lastName: p.last_name,
    preferredName: p.preferred_name,
    displayName: fullName(p.first_name, p.last_name, p.preferred_name) || p.email,
    jobTitle: p.job_title,
    department: p.department,
    employeeId: p.employee_id,
    hireDate: p.hire_date,
    phone: p.phone,
    extension: p.extension,
    mobile: p.mobile,
    shift: p.shift,
    supervisorId: p.supervisor_id,
    certifications: p.certifications,
    skills: p.skills,
    bio: p.bio,
    emergencyContactName: priv ? priv.emergency_contact_name : null,
    emergencyContactPhone: priv ? priv.emergency_contact_phone : null,
    hasAvatar: Boolean(p.avatar_path),
    avatarPath: p.avatar_path,
    status: p.status,
    isSuperuser: Boolean(p.is_superuser),
    isDeveloper: Boolean(p.is_developer),
    lastLoginAt: p.last_login_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** work_orders_v row → UI work order shape. */
function shapeWO(w) {
  return {
    id: w.id,
    number: w.wo_number,
    title: w.title,
    description: w.description,
    type: w.type,
    status: w.status,
    priority: { key: w.priority_key, label: w.priority_label, color: w.priority_color, rank: w.priority_rank },
    category: w.category_id ? { id: w.category_id, name: w.category_name } : null,
    location: w.location_id ? { id: w.location_id, building: w.location_building, unit: w.location_unit, name: w.location_name } : null,
    locationDetail: w.location_detail,
    assetTag: w.asset_tag,
    flags: {
      ligatureRisk: Boolean(w.ligature_risk),
      patientArea: Boolean(w.patient_area),
      areaOutOfService: Boolean(w.area_out_of_service),
      escortRequired: Boolean(w.escort_required),
    },
    requester: { id: w.requester_id, name: w.requester_name, email: w.requester_email },
    contactPhone: w.contact_phone,
    assignee: w.assignee_id ? { id: w.assignee_id, name: w.assignee_name, hasAvatar: Boolean(w.assignee_avatar), avatarPath: w.assignee_avatar } : null,
    dueAt: w.due_at,
    overdue: Boolean(w.is_overdue),
    startedAt: w.started_at,
    completedAt: w.completed_at,
    closedAt: w.closed_at,
    cancelledAt: w.cancelled_at,
    laborHours: w.labor_hours === null ? null : Number(w.labor_hours),
    partsCost: w.parts_cost === null ? null : Number(w.parts_cost),
    resolution: w.resolution,
    toolsAccounted: w.tools_accounted_at ? { by: w.tools_accounted_name, at: w.tools_accounted_at } : null,
    customFields: w.custom_fields || {},
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

/** Strip characters that would break a PostgREST or() filter. */
const searchTerm = (s) => String(s || '').replace(/[,()*%\\]/g, ' ').trim().slice(0, 100);

/* ------------------------------------------------------------------ */
/* CSV (client-side exports)                                           */
/* ------------------------------------------------------------------ */

/** RFC-4180 CSV with spreadsheet formula-injection neutralization (CWE-1236). */
function toCsv(columns, rows) {
  const cell = (val) => {
    if (val === null || val === undefined) return '';
    let s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}
const csvFile = (name, content) => ({ __file: true, name, type: 'text/csv;charset=utf-8', content });
const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

const SIGNATURES = [
  ['image/png', 'png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/jpeg', 'jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', 'gif', (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ['image/webp', 'webp', (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45],
  ['application/pdf', 'pdf', (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46],
];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Verify real file type from magic bytes (the bucket also enforces MIME + size). */
async function sniff(file, allowed, maxBytes) {
  if (!file) throw new ApiError('No file was uploaded.', 400);
  if (file.size > maxBytes) throw new ApiError(`File is too large (max ${Math.round(maxBytes / 1048576)} MB).`, 413);
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const hit = SIGNATURES.find(([, , test]) => test(head));
  if (!hit || !allowed.includes(hit[0])) {
    throw new ApiError(`Unsupported file type. Allowed: ${allowed.map((m) => m.split('/')[1].toUpperCase()).join(', ')}.`, 415);
  }
  return { mime: hit[0], ext: hit[1] };
}
const randomName = (ext) => `${crypto.randomUUID().replace(/-/g, '')}.${ext}`;

/** Signed-URL cache for private avatars (used by ui.js hydrateAvatars). */
const urlCache = new Map();
export async function signedAvatarUrls(paths) {
  const now = Date.now();
  const need = [...new Set(paths)].filter((p) => !(urlCache.has(p) && urlCache.get(p).exp > now));
  if (need.length) {
    const res = await sb.storage.from('avatars').createSignedUrls(need, 3600);
    (res.data || []).forEach((x) => x.signedUrl && urlCache.set(x.path, { url: x.signedUrl, exp: now + 50 * 60_000 }));
  }
  return Object.fromEntries(paths.map((p) => [p, urlCache.has(p) ? urlCache.get(p).url : null]));
}

/** Upload an avatar for userId; returns the new storage path. */
async function uploadAvatar(userId, file) {
  const kind = await sniff(file, IMAGE_TYPES, 2 * 1024 * 1024);
  const path = `${userId}/${randomName(kind.ext)}`;
  ok(await sb.storage.from('avatars').upload(path, file, { contentType: kind.mime, upsert: false, cacheControl: '86400' }));
  return path;
}

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */

/* ---------- Session / meta ---------- */

async function loadMe() {
  const data = ok(await sb.rpc('me'));
  me.id = data.profile.id;
  me.isSuperuser = Boolean(data.profile.is_superuser) && data.profile.status === 'active';
  me.perms = new Set(data.permissions || []);
  return data;
}

route('GET', '/meta', async () => {
  const [data, settings] = await Promise.all([loadMe(), sb.from('app_settings').select('key,value')]);
  const s = Object.fromEntries((ok(settings) || []).map((r) => [r.key, r.value]));
  const nav = NAV.filter((n) => !n.permission || [].concat(n.permission).some(can))
    .sort((a, b) => a.order - b.order)
    .map(({ path, label, icon, section }) => ({ path, label, icon, section: section || 'main' }));
  return {
    app: { name: APP.name, version: APP.version },
    facility: s.facility,
    user: publicUser(data.profile, data.private),
    roles: data.roles,
    permissions: [...me.perms],
    nav,
    sessionIdleMinutes: APP.sessionIdleMinutes,
  };
});

route('GET', '/auth/config', async () => {
  const s = Object.fromEntries((ok(await sb.from('app_settings').select('key,value')) || []).map((r) => [r.key, r.value]));
  return { facility: s.facility, allowedDomains: s.allowed_domains || [], minPasswordLength: APP.minPasswordLength };
});

route('GET', '/auth/me', async () => {
  const { data } = await sb.auth.getSession(); // refreshes the token if needed
  if (!data.session) throw new ApiError('Please sign in.', 401);
  return { ok: true };
});

route('POST', '/auth/logout', async () => {
  await sb.auth.signOut();
  return { ok: true };
});

/** Change password: re-verify the current one, then update. */
route('POST', '/auth/change-password', async ({ body }) => {
  const { data } = await sb.auth.getUser();
  if (!data.user) throw new ApiError('Please sign in.', 401);
  assertStrongPassword(body.newPassword, data.user.email);
  const check = await sb.auth.signInWithPassword({ email: data.user.email, password: String(body.currentPassword || '') });
  if (check.error) throw new ApiError('Current password is incorrect.', 400);
  if (body.currentPassword === body.newPassword) throw new ApiError('New password must be different.', 400);
  const res = await sb.auth.updateUser({ password: body.newPassword });
  if (res.error) throw toApiError(res.error, 400);
  return { ok: true };
});

/** Shared password policy (UI side; also configure Supabase Auth password requirements). */
export function assertStrongPassword(pw, email) {
  if (typeof pw !== 'string' || pw.length < APP.minPasswordLength) throw new ApiError(`Password must be at least ${APP.minPasswordLength} characters.`, 400);
  if (pw.length > 72) throw new ApiError('Password must be 72 characters or fewer.', 400);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) throw new ApiError('Password must include at least 3 of: lowercase, uppercase, number, symbol.', 400);
  if (email && pw.toLowerCase().includes(String(email).split('@')[0].toLowerCase())) throw new ApiError('Password must not contain your email name.', 400);
}

/* ---------- Settings & lookups ---------- */

route('GET', '/settings/lookups', async ({ query }) => {
  const all = query.all === '1';
  const filt = (q) => (all ? q : q.eq('is_active', true));
  const [locations, categories, priorities] = await Promise.all([
    filt(sb.from('locations').select('*')).order('sort_order').order('building').order('name'),
    filt(sb.from('categories').select('*')).order('sort_order').order('name'),
    filt(sb.from('priorities').select('*')).order('rank'),
  ]);
  return {
    locations: ok(locations).map((l) => ({ ...l, is_patient_area: l.is_patient_area ? 1 : 0, is_active: l.is_active ? 1 : 0 })),
    categories: ok(categories).map((c) => ({ ...c, is_active: c.is_active ? 1 : 0 })),
    priorities: ok(priorities),
  };
});

route('GET', '/settings/app', async () => {
  const s = Object.fromEntries((ok(await sb.from('app_settings').select('key,value')) || []).map((r) => [r.key, r.value]));
  return { facility: s.facility, autoApproveDomainUsers: s.auto_approve_domain_users === true, woPrefix: s.wo_prefix, allowedDomains: s.allowed_domains || [] };
});

route('PUT', '/settings/app', async ({ body }) => {
  ok(await sb.rpc('settings_save', { p: body }));
  return { ok: true };
});

const locationRow = (b) => ({
  building: (b.building || '').trim(),
  unit: (b.unit || '').trim() || null,
  name: (b.name || '').trim(),
  is_patient_area: Boolean(b.isPatientArea),
  is_active: b.isActive === undefined ? true : Boolean(b.isActive),
  sort_order: Number(b.sortOrder) || 0,
});
route('POST', '/settings/locations', async ({ body }) => ({ id: ok(await sb.from('locations').insert(locationRow(body)).select('id').single()).id }));
route('PUT', '/settings/locations/:id', async ({ params, body }) => {
  ok(await sb.from('locations').update(locationRow(body)).eq('id', params.id).select('id').single());
  return { ok: true };
});

const categoryRow = (b) => ({
  name: (b.name || '').trim(),
  description: (b.description || '').trim() || null,
  is_active: b.isActive === undefined ? true : Boolean(b.isActive),
  sort_order: Number(b.sortOrder) || 0,
});
route('POST', '/settings/categories', async ({ body }) => ({ id: ok(await sb.from('categories').insert(categoryRow(body)).select('id').single()).id }));
route('PUT', '/settings/categories/:id', async ({ params, body }) => {
  ok(await sb.from('categories').update(categoryRow(body)).eq('id', params.id).select('id').single());
  return { ok: true };
});

route('PUT', '/settings/priorities/:key', async ({ params, body }) => {
  ok(
    await sb
      .from('priorities')
      .update({ label: (body.label || '').trim(), sla_hours: Number(body.slaHours), color: body.color, description: (body.description || '').trim() || null })
      .eq('key', params.key)
      .select('key')
      .single()
  );
  return { ok: true };
});

/* ---------- Work orders ---------- */

route('GET', '/workorders/meta', async () => ({ statuses: STATUSES, types: TYPES, transitions: TRANSITIONS }));

route('GET', '/workorders/dashboard', async () => {
  const d = ok(await sb.rpc('wo_dashboard'));
  return { counts: d.counts, myQueue: d.myQueue.map(shapeWO), myRequests: d.myRequests.map(shapeWO), critical: d.critical.map(shapeWO) };
});

/** Apply list/export filters to a work_orders_v query. */
function woFilters(q, f) {
  if (f.status === 'active') q = q.in('status', ACTIVE);
  else if (f.status === 'inactive') q = q.in('status', ['completed', 'closed', 'cancelled']);
  else if (f.status && f.status !== 'all') {
    const list = String(f.status).split(',').filter((s) => STATUSES.some((x) => x.key === s));
    if (list.length) q = q.in('status', list);
  }
  if (f.priority) q = q.eq('priority_key', f.priority);
  if (f.type) q = q.eq('type', f.type);
  if (f.categoryId) q = q.eq('category_id', f.categoryId);
  if (f.locationId) q = q.eq('location_id', f.locationId);
  if (f.assignee === 'me') q = q.eq('assignee_id', me.id);
  else if (f.assignee === 'unassigned') q = q.is('assignee_id', null);
  else if (f.assignee) q = q.eq('assignee_id', f.assignee);
  if (f.requester === 'me') q = q.eq('requester_id', me.id);
  else if (f.requester) q = q.eq('requester_id', f.requester);
  if (f.overdue === '1') q = q.eq('is_overdue', true);
  if (f.flag === 'ligature') q = q.eq('ligature_risk', true);
  if (f.flag === 'patient') q = q.eq('patient_area', true);
  if (f.flag === 'oos') q = q.eq('area_out_of_service', true);
  if (f.from) q = q.gte('created_at', new Date(f.from).toISOString());
  if (f.to) q = q.lt('created_at', new Date(new Date(f.to).getTime() + 86400000).toISOString());
  const term = searchTerm(f.q);
  if (term) q = q.or(['wo_number', 'title', 'description', 'asset_tag', 'location_detail'].map((c) => `${c}.ilike.*${term}*`).join(','));
  return q;
}

function woSort(q, sort) {
  switch (sort) {
    case 'newest': return q.order('created_at', { ascending: false });
    case 'oldest': return q.order('created_at', { ascending: true });
    case 'due': return q.order('due_at', { ascending: true, nullsFirst: false });
    case 'updated': return q.order('updated_at', { ascending: false });
    default: return q.order('priority_rank', { ascending: true }).order('due_at', { ascending: true, nullsFirst: false });
  }
}

route('GET', '/workorders', async ({ query }) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25));
  let q = woFilters(sb.from('work_orders_v').select('*', { count: 'exact' }), query);
  q = woSort(q, query.sort).range((page - 1) * pageSize, page * pageSize - 1);
  const res = await q;
  return { items: ok(res).map(shapeWO), total: res.count || 0, page, pageSize };
});

route('GET', '/workorders/export.csv', async ({ query }) => {
  const rows = ok(await woFilters(sb.from('work_orders_v').select('*'), query).order('created_at', { ascending: false }).limit(10000));
  const yn = (b) => (b ? 'Yes' : 'No');
  const cols = [
    { label: 'Number', key: 'wo_number' }, { label: 'Title', key: 'title' }, { label: 'Type', key: 'type' },
    { label: 'Status', key: 'status' }, { label: 'Priority', key: 'priority_label' }, { label: 'Category', key: 'category_name' },
    { label: 'Building', key: 'location_building' }, { label: 'Unit', key: 'location_unit' }, { label: 'Location', key: 'location_name' },
    { label: 'Room / Detail', key: 'location_detail' }, { label: 'Asset Tag', key: 'asset_tag' },
    { label: 'Ligature Risk', value: (x) => yn(x.ligature_risk) }, { label: 'Patient Area', value: (x) => yn(x.patient_area) },
    { label: 'Out of Service', value: (x) => yn(x.area_out_of_service) }, { label: 'Requester', key: 'requester_name' },
    { label: 'Assignee', key: 'assignee_name' }, { label: 'Created', key: 'created_at' }, { label: 'Due', key: 'due_at' },
    { label: 'Started', key: 'started_at' }, { label: 'Completed', key: 'completed_at' }, { label: 'Closed', key: 'closed_at' },
    { label: 'Labor Hours', key: 'labor_hours' }, { label: 'Parts Cost', key: 'parts_cost' }, { label: 'Resolution', key: 'resolution' },
    { label: 'Tools Accounted By', key: 'tools_accounted_name' }, { label: 'Tools Accounted At', key: 'tools_accounted_at' },
  ];
  await sb.rpc('log_client_event', { p_action: 'workorder.export', p_details: { rows: rows.length, filters: query } });
  return csvFile(`work-orders-${today()}.csv`, toCsv(cols, rows));
});

async function loadWO(id) {
  const w = ok(await sb.from('work_orders_v').select('*').eq('id', id).maybeSingle());
  if (!w) throw new ApiError('Work order not found.', 404);
  return w;
}

route('POST', '/workorders', async ({ body }) => {
  const id = ok(await sb.rpc('wo_create', { p: body }));
  return shapeWO(await loadWO(id));
});

route('GET', '/workorders/:id', async ({ params }) => {
  const w = await loadWO(params.id);
  const [comments, history, files] = await Promise.all([
    sb.from('wo_comments').select('id, body, is_internal, created_at, user:profiles(id, first_name, last_name, preferred_name, avatar_path)')
      .eq('work_order_id', w.id).order('created_at'),
    sb.from('wo_history').select('id, action, field, old_value, new_value, note, created_at, user:profiles(first_name, last_name)')
      .eq('work_order_id', w.id).order('created_at').order('id'),
    sb.from('wo_attachments').select('id, original_name, storage_path, mime_type, size_bytes, created_at, user:profiles(first_name, last_name)')
      .eq('work_order_id', w.id).order('created_at'),
  ]);
  const atts = ok(files);
  let urls = {};
  if (atts.length) {
    const signed = await sb.storage.from('attachments').createSignedUrls(atts.map((a) => a.storage_path), 3600);
    urls = Object.fromEntries((signed.data || []).map((s) => [s.path, s.signedUrl]));
  }
  const isRequester = w.requester_id === me.id;
  const isAssignee = w.assignee_id === me.id;
  return {
    workOrder: shapeWO(w),
    comments: ok(comments).map((c) => ({
      id: c.id, body: c.body, internal: c.is_internal, createdAt: c.created_at,
      user: c.user ? { id: c.user.id, name: fullName(c.user.first_name, c.user.last_name, c.user.preferred_name), hasAvatar: Boolean(c.user.avatar_path), avatarPath: c.user.avatar_path } : { name: 'Unknown' },
    })),
    history: ok(history).map((h) => ({
      id: h.id, action: h.action, field: h.field, oldValue: h.old_value, newValue: h.new_value, note: h.note, at: h.created_at,
      user: h.user ? `${h.user.first_name} ${h.user.last_name}`.trim() : null,
    })),
    attachments: atts.map((a) => ({
      id: a.id, name: a.original_name, mime: a.mime_type, size: a.size_bytes, at: a.created_at,
      user: a.user ? `${a.user.first_name} ${a.user.last_name}`.trim() : '', url: urls[a.storage_path] || null,
    })),
    abilities: {
      edit: can('workorders.edit') || (isRequester && w.status === 'open'),
      assign: can('workorders.assign'),
      work: can('workorders.work') && (isAssignee || can('workorders.edit')),
      close: can('workorders.close'),
      delete: can('workorders.delete'),
      internalNotes: can('workorders.work') || can('workorders.view_all'),
      cancel: can('workorders.edit') || (isRequester && w.status === 'open'),
    },
    transitions: TRANSITIONS[w.status] || [],
  };
});

route('PUT', '/workorders/:id', async ({ params, body }) => {
  const p = { ...body };
  if (p.dueAt === undefined) delete p.dueAt;
  ok(await sb.rpc('wo_update', { p_id: Number(params.id), p }));
  return shapeWO(await loadWO(params.id));
});

route('POST', '/workorders/:id/assign', async ({ params, body }) => {
  ok(await sb.rpc('wo_assign', { p_id: Number(params.id), p_assignee: body.assigneeId || null }));
  return shapeWO(await loadWO(params.id));
});

route('POST', '/workorders/:id/status', async ({ params, body }) => {
  const { status, ...rest } = body;
  ok(await sb.rpc('wo_set_status', { p_id: Number(params.id), p_to: status, p: rest }));
  return shapeWO(await loadWO(params.id));
});

route('POST', '/workorders/:id/comments', async ({ params, body }) => {
  ok(await sb.rpc('wo_comment', { p_id: Number(params.id), p_body: body.body, p_internal: Boolean(body.internal) }));
  return { ok: true };
});

route('POST', '/workorders/:id/attachments', async ({ params, form }) => {
  const file = form && form.get('file');
  const kind = await sniff(file, [...IMAGE_TYPES, 'application/pdf'], 10 * 1024 * 1024);
  const path = `${Number(params.id)}/${randomName(kind.ext)}`;
  ok(await sb.storage.from('attachments').upload(path, file, { contentType: kind.mime, upsert: false }));
  try {
    const id = ok(await sb.rpc('wo_add_attachment', { p_id: Number(params.id), p_path: path, p_name: file.name }));
    return { id };
  } catch (e) {
    await sb.storage.from('attachments').remove([path]); // don't leave orphans
    throw e;
  }
});

route('DELETE', '/workorders/:id/attachments/:attId', async ({ params }) => {
  const path = ok(await sb.rpc('wo_remove_attachment', { p_att: Number(params.attId) }));
  if (path) await sb.storage.from('attachments').remove([path]);
  return { ok: true };
});

route('DELETE', '/workorders/:id', async ({ params }) => {
  ok(await sb.rpc('wo_delete', { p_id: Number(params.id) }));
  return { ok: true };
});

/* ---------- Users ---------- */

route('GET', '/users/meta', async () => ({ shifts: SHIFTS }));

route('GET', '/users/me', async () => {
  const d = await loadMe();
  return { user: publicUser(d.profile, d.private), roles: d.roles, supervisor: d.supervisor };
});

/** Self-service profile edit (column-level grants limit which fields can change). */
route('PUT', '/users/me', async ({ body }) => {
  const t = (v, max) => {
    const s = String(v ?? '').trim();
    if (s.length > max) throw new ApiError(`A field is longer than ${max} characters.`, 400);
    return s || null;
  };
  if (!t(body.firstName, 80) || !t(body.lastName, 80)) throw new ApiError('First and last name are required.', 400);
  ok(
    await sb.from('profiles').update({
      first_name: t(body.firstName, 80), last_name: t(body.lastName, 80), preferred_name: t(body.preferredName, 80),
      job_title: t(body.jobTitle, 120), department: t(body.department, 120), phone: t(body.phone, 30),
      extension: t(body.extension, 10), mobile: t(body.mobile, 30), shift: body.shift || null,
      certifications: t(body.certifications, 2000), skills: t(body.skills, 2000), bio: t(body.bio, 2000),
    }).eq('id', me.id).select('id').single()
  );
  if ('emergencyContactName' in body || 'emergencyContactPhone' in body) {
    ok(await sb.from('profile_private').update({
      emergency_contact_name: t(body.emergencyContactName, 120), emergency_contact_phone: t(body.emergencyContactPhone, 30),
    }).eq('user_id', me.id).select('user_id').single());
  }
  const d = await loadMe();
  return { user: publicUser(d.profile, d.private) };
});

route('POST', '/users/me/avatar', async ({ form }) => {
  const old = (await loadMe()).profile.avatar_path;
  const path = await uploadAvatar(me.id, form && form.get('file'));
  ok(await sb.from('profiles').update({ avatar_path: path }).eq('id', me.id).select('id').single());
  if (old) await sb.storage.from('avatars').remove([old]);
  const d = await loadMe();
  return { user: publicUser(d.profile, d.private) };
});

route('DELETE', '/users/me/avatar', async () => {
  const old = (await loadMe()).profile.avatar_path;
  ok(await sb.from('profiles').update({ avatar_path: null }).eq('id', me.id).select('id').single());
  if (old) await sb.storage.from('avatars').remove([old]);
  const d = await loadMe();
  return { user: publicUser(d.profile, d.private) };
});

/** Technicians (holders of workorders.work) for assignment pickers; ?all=1 → everyone active. */
route('GET', '/users/assignable', async ({ query }) => {
  const rp = ok(await sb.from('role_permissions').select('role_id').eq('permission_key', 'workorders.work'));
  const roleIds = rp.map((r) => r.role_id);
  const ur = roleIds.length ? ok(await sb.from('user_roles').select('user_id').in('role_id', roleIds)) : [];
  const workers = new Set(ur.map((x) => x.user_id));
  const people = ok(await sb.from('profiles').select('id, first_name, last_name, preferred_name, job_title, avatar_path, is_superuser')
    .eq('status', 'active').order('last_name').order('first_name'));
  return people
    .filter((p) => query.all === '1' || workers.has(p.id) || p.is_superuser)
    .map((p) => ({ id: p.id, name: fullName(p.first_name, p.last_name, p.preferred_name), jobTitle: p.job_title, hasAvatar: Boolean(p.avatar_path), avatarPath: p.avatar_path }));
});

route('GET', '/users', async ({ query }) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = 50;
  let q = sb.from('profiles').select('*, user_roles(roles(name))', { count: 'exact' });
  if (query.status) q = q.eq('status', query.status);
  if (query.roleId) {
    const ids = ok(await sb.from('user_roles').select('user_id').eq('role_id', query.roleId)).map((x) => x.user_id);
    q = q.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  }
  const term = searchTerm(query.q);
  if (term) q = q.or(['first_name', 'last_name', 'email', 'job_title', 'department'].map((c) => `${c}.ilike.*${term}*`).join(','));
  const [res, pending] = await Promise.all([
    q.order('last_name').order('first_name').range((page - 1) * pageSize, page * pageSize - 1),
    sb.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);
  const items = ok(res).map((u) => ({ ...publicUser(u), roleNames: (u.user_roles || []).map((x) => x.roles && x.roles.name).filter(Boolean).sort().join(', ') }));
  return { items, total: res.count || 0, page, pageSize, pending: pending.count || 0 };
});

route('GET', '/users/:id', async ({ params }) => {
  const u = ok(await sb.from('profiles').select('*').eq('id', params.id).maybeSingle());
  if (!u) throw new ApiError('User not found.', 404);
  const [priv, ur, stats, sup] = await Promise.all([
    sb.from('profile_private').select('*').eq('user_id', u.id).maybeSingle(), // RLS returns nothing unless self/admin
    sb.from('user_roles').select('role_id, roles(id, name)').eq('user_id', u.id),
    sb.rpc('user_stats', { p_user: u.id }),
    u.supervisor_id ? sb.from('profiles').select('id, first_name, last_name').eq('id', u.supervisor_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const roles = ok(ur).map((x) => x.roles).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  let permissions = ['*'];
  if (!u.is_superuser) {
    const rp = roles.length ? ok(await sb.from('role_permissions').select('permission_key').in('role_id', roles.map((r) => r.id))) : [];
    permissions = [...new Set(rp.map((x) => x.permission_key))];
  }
  return {
    user: publicUser(u, priv.data),
    roles,
    permissions,
    supervisor: sup.data ? { id: sup.data.id, name: `${sup.data.first_name} ${sup.data.last_name}` } : null,
    approvedAt: u.approved_at,
    stats: ok(stats),
  };
});

route('PUT', '/users/:id', async ({ params, body }) => {
  ok(await sb.rpc('admin_update_profile', { p_user: params.id, p: body }));
  return { ok: true };
});

/** Admin photo upload: store under the target user's folder, then record it. */
route('POST', '/users/:id/avatar', async ({ params, form }) => {
  const u = ok(await sb.from('profiles').select('*').eq('id', params.id).single());
  const priv = (await sb.from('profile_private').select('*').eq('user_id', u.id).maybeSingle()).data;
  const path = await uploadAvatar(u.id, form && form.get('file'));
  ok(await sb.rpc('admin_update_profile', {
    p_user: u.id,
    p: {
      firstName: u.first_name, lastName: u.last_name, preferredName: u.preferred_name, jobTitle: u.job_title, department: u.department,
      phone: u.phone, extension: u.extension, mobile: u.mobile, shift: u.shift, certifications: u.certifications, skills: u.skills,
      bio: u.bio, employeeId: u.employee_id, hireDate: u.hire_date, supervisorId: u.supervisor_id, avatarPath: path,
      ...(priv ? { emergencyContactName: priv.emergency_contact_name, emergencyContactPhone: priv.emergency_contact_phone } : {}),
    },
  }));
  if (u.avatar_path) await sb.storage.from('avatars').remove([u.avatar_path]);
  return { user: publicUser({ ...u, avatar_path: path }) };
});

route('POST', '/users/:id/status', async ({ params, body }) => {
  ok(await sb.rpc('admin_set_user_status', { p_user: params.id, p_status: body.status }));
  return { ok: true };
});

route('DELETE', '/users/:id', async ({ params }) => {
  ok(await sb.rpc('admin_reject_user', { p_user: params.id }));
  return { ok: true };
});

route('PUT', '/users/:id/roles', async ({ params, body }) => {
  ok(await sb.rpc('admin_set_user_roles', { p_user: params.id, p_role_ids: (body.roleIds || []).map(Number) }));
  return { ok: true };
});

route('POST', '/users/:id/superuser', async ({ params, body }) => {
  ok(await sb.rpc('admin_set_superuser', { p_user: params.id, p_flag: Boolean(body.isSuperuser) }));
  return { ok: true };
});

/** Password resets are self-service via an emailed link (no admin-visible passwords). */
route('POST', '/users/:id/reset-password', async ({ params }) => {
  const u = ok(await sb.from('profiles').select('email').eq('id', params.id).single());
  const res = await sb.auth.resetPasswordForEmail(u.email, { redirectTo: siteUrl() });
  if (res.error) throw toApiError(res.error, 400);
  return { sentTo: u.email };
});

export const siteUrl = () => `${location.origin}${location.pathname}`;

/* ---------- Roles ---------- */

async function rolesList() {
  const rows = ok(await sb.from('roles').select('*, role_permissions(permission_key), user_roles(count)').order('is_system', { ascending: false }).order('name'));
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, is_system: r.is_system ? 1 : 0, is_default: r.is_default ? 1 : 0,
    permissions: (r.role_permissions || []).map((p) => p.permission_key),
    userCount: (r.user_roles && r.user_roles[0] && r.user_roles[0].count) || 0,
  }));
}

route('GET', '/roles', rolesList);
route('GET', '/roles/permissions', async () => {
  const rows = ok(await sb.from('permissions').select('*').order('module').order('key'));
  const grouped = {};
  rows.forEach((p) => (grouped[p.module] = grouped[p.module] || []).push(p));
  return grouped;
});
route('POST', '/roles', async ({ body }) => {
  const id = ok(await sb.rpc('role_save', { p_id: null, p: body }));
  return (await rolesList()).find((r) => r.id === id);
});
route('PUT', '/roles/:id', async ({ params, body }) => {
  const id = ok(await sb.rpc('role_save', { p_id: Number(params.id), p: body }));
  return (await rolesList()).find((r) => r.id === id);
});
route('DELETE', '/roles/:id', async ({ params }) => {
  ok(await sb.rpc('role_delete', { p_id: Number(params.id) }));
  return { ok: true };
});

/* ---------- Reports ---------- */

route('GET', '/reports/summary', async ({ query }) => ok(await sb.rpc('report_summary', { p_from: query.from || null, p_to: query.to || null })));

route('GET', '/reports/summary.csv', async ({ query }) => {
  const s = ok(await sb.rpc('report_summary', { p_from: query.from || null, p_to: query.to || null }));
  const rows = [];
  const add = (section, list) => (list || []).forEach((x) => rows.push({ section, ...x }));
  add('Status', s.byStatus); add('Priority', s.byPriority); add('Category', s.byCategory);
  add('Location', s.byLocation); add('Type', s.byType); add('Technician', s.byAssignee);
  await sb.rpc('log_client_event', { p_action: 'report.export', p_details: { from: query.from, to: query.to } });
  return csvFile(`wo-summary-${query.from || ''}_to_${query.to || today()}.csv`, toCsv([
    { label: 'Section', key: 'section' }, { label: 'Group', key: 'label' }, { label: 'Total', key: 'total' },
    { label: 'Open', key: 'open' }, { label: 'Completed', key: 'completed' },
    { label: 'Avg Hours to Complete', key: 'avg_hours' }, { label: 'Labor Hours', key: 'labor_hours' },
  ], rows));
});

/* ---------- Rounds & inspection forms (owner-only; RLS enforces) ---------- */

/**
 * Phone photos are often 4–12 MB. Re-encode large images to a ≤1600px JPEG
 * before upload so rounds stay fast on cellular. Small images pass through.
 */
async function shrinkImage(file) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

const shapeRound = (s) => ({
  id: s.id,
  templateId: s.template_id,
  name: s.template_name,
  status: s.status,
  date: s.round_date,
  header: s.header || {},
  answers: s.answers || {},
  definition: s.definition,
  findings: s.findings,
  location: s.location ? { id: s.location_id, name: s.location.name, unit: s.location.unit } : null,
  photoCount: s.form_photos && s.form_photos[0] ? s.form_photos[0].count : undefined,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
  submittedAt: s.submitted_at,
});

route('GET', '/rounds/templates', async () =>
  ok(await sb.from('form_templates').select('id, name, description').eq('is_active', true).order('sort_order').order('name')));

route('GET', '/rounds', async ({ query }) => {
  let q = sb.from('form_submissions')
    .select('id, template_id, template_name, status, round_date, header, findings, location_id, created_at, updated_at, submitted_at, location:locations(name, unit), form_photos(count)');
  if (query.status) q = q.eq('status', query.status);
  if (query.templateId) q = q.eq('template_id', query.templateId);
  const rows = ok(await q.order('round_date', { ascending: false, nullsFirst: false }).order('id', { ascending: false }).limit(300));
  return rows.map(shapeRound);
});

route('POST', '/rounds', async ({ body }) => {
  const t = ok(await sb.from('form_templates').select('*').eq('id', body.templateId).single());
  const meRow = (await loadMe()).profile;
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
  const header = { date: local.slice(0, 10), time: local.slice(11, 16) };
  (t.definition.header || []).forEach((h) => {
    if (h.default === 'me') header[h.key] = fullName(meRow.first_name, meRow.last_name, meRow.preferred_name);
  });
  const row = ok(await sb.from('form_submissions').insert({
    template_id: t.id, template_name: t.name, definition: t.definition, header, round_date: header.date,
  }).select('id').single());
  return { id: row.id };
});

route('GET', '/rounds/:id', async ({ params }) => {
  const s = ok(await sb.from('form_submissions').select('*, location:locations(name, unit)').eq('id', params.id).maybeSingle());
  if (!s) throw new ApiError('Round not found.', 404);
  const photos = ok(await sb.from('form_photos').select('id, item_key, storage_path, original_name, created_at').eq('submission_id', s.id).order('created_at'));
  let urls = {};
  if (photos.length) {
    const signed = await sb.storage.from('form-photos').createSignedUrls(photos.map((p) => p.storage_path), 3600);
    urls = Object.fromEntries((signed.data || []).map((x) => [x.path, x.signedUrl]));
  }
  return {
    round: shapeRound(s),
    photos: photos.map((p) => ({ id: p.id, itemKey: p.item_key, name: p.original_name, url: urls[p.storage_path] || null, at: p.created_at })),
  };
});

route('PUT', '/rounds/:id', async ({ params, body }) => {
  const patch = {
    header: body.header || {},
    answers: body.answers || {},
    findings: Math.max(0, Number(body.findings) || 0),
    round_date: body.header && /^\d{4}-\d{2}-\d{2}$/.test(body.header.date || '') ? body.header.date : null,
    location_id: body.locationId ? Number(body.locationId) : null,
  };
  const row = ok(await sb.from('form_submissions').update(patch).eq('id', params.id).eq('status', 'draft').select('updated_at').maybeSingle());
  if (!row) throw new ApiError('This round is submitted. Reopen it to make changes.', 409);
  return { updatedAt: row.updated_at };
});

route('POST', '/rounds/:id/status', async ({ params, body }) => {
  const status = body.status === 'submitted' ? 'submitted' : 'draft';
  ok(await sb.from('form_submissions').update({ status, submitted_at: status === 'submitted' ? new Date().toISOString() : null })
    .eq('id', params.id).select('id').single());
  return { ok: true };
});

route('DELETE', '/rounds/:id', async ({ params }) => {
  const photos = ok(await sb.from('form_photos').select('storage_path').eq('submission_id', params.id));
  if (photos.length) await sb.storage.from('form-photos').remove(photos.map((p) => p.storage_path));
  ok(await sb.from('form_submissions').delete().eq('id', params.id));
  return { ok: true };
});

route('POST', '/rounds/:id/photos', async ({ params, form }) => {
  const file = await shrinkImage(form && form.get('file'));
  const kind = await sniff(file, IMAGE_TYPES, 10 * 1024 * 1024);
  const path = `${Number(params.id)}/${randomName(kind.ext)}`;
  ok(await sb.storage.from('form-photos').upload(path, file, { contentType: kind.mime, upsert: false }));
  try {
    const row = ok(await sb.from('form_photos').insert({
      submission_id: Number(params.id), item_key: String(form.get('itemKey') || '').slice(0, 80) || null,
      storage_path: path, original_name: String(file.name || 'photo').slice(0, 255), mime_type: kind.mime, size_bytes: file.size,
    }).select('id').single());
    return { id: row.id };
  } catch (e) {
    await sb.storage.from('form-photos').remove([path]);
    throw e;
  }
});

route('DELETE', '/rounds/:id/photos/:photoId', async ({ params }) => {
  const p = ok(await sb.from('form_photos').select('storage_path').eq('id', params.photoId).single());
  ok(await sb.from('form_photos').delete().eq('id', params.photoId));
  await sb.storage.from('form-photos').remove([p.storage_path]);
  return { ok: true };
});

/* ---------- Compliance tracker (owner-only; RLS enforces) ---------- */

route('GET', '/compliance', async () => {
  const [tasks, entries] = await Promise.all([
    sb.from('compliance_tasks').select('*').order('sort_order').order('name'),
    sb.from('compliance_entries').select('id, task_id, done_on, note, created_at').order('done_on').limit(10000),
  ]);
  return { tasks: ok(tasks), entries: ok(entries) };
});

route('POST', '/compliance/entries', async ({ body }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.doneOn || '')) throw new ApiError('Choose a valid date.', 400);
  const note = String(body.note || '').trim().slice(0, 500) || null;
  return ok(await sb.from('compliance_entries').insert({ task_id: Number(body.taskId), done_on: body.doneOn, note }).select('*').single());
});

route('DELETE', '/compliance/entries/:id', async ({ params }) => {
  ok(await sb.from('compliance_entries').delete().eq('id', params.id));
  return { ok: true };
});

const taskRow = (b) => {
  const name = String(b.name || '').trim();
  if (!name) throw new ApiError('Task name is required.', 400);
  return {
    name: name.slice(0, 200),
    cadence: b.cadence,
    counts_toward_compliance: b.cadence !== 'misc' && Boolean(b.countsTowardCompliance),
    due_month: b.cadence === 'annual' && Number(b.dueMonth) ? Number(b.dueMonth) : null,
    interval_label: String(b.intervalLabel || '').trim().slice(0, 60) || null,
    next_due: /^\d{4}-\d{2}-\d{2}$/.test(b.nextDue || '') ? b.nextDue : null,
    notes: String(b.notes || '').trim().slice(0, 1000) || null,
    sort_order: Number(b.sortOrder) || 0,
    is_active: b.isActive === undefined ? true : Boolean(b.isActive),
  };
};
route('POST', '/compliance/tasks', async ({ body }) => ok(await sb.from('compliance_tasks').insert(taskRow(body)).select('*').single()));
route('PUT', '/compliance/tasks/:id', async ({ params, body }) =>
  ok(await sb.from('compliance_tasks').update(taskRow(body)).eq('id', params.id).select('*').single()));

route('POST', '/compliance/export', async ({ body }) => {
  await sb.rpc('log_client_event', { p_action: 'compliance.export', p_details: { year: body.year } });
  return csvFile(`eoc-compliance-${body.year}.csv`, toCsv(body.columns, body.rows));
});

/* ---------- Error logs ---------- */

route('POST', '/errors/client', async ({ body }) => {
  await sb.rpc('log_error', {
    p: { source: 'client', message: body.message, stack: body.stack, route: body.url, userAgent: navigator.userAgent,
         context: { kind: body.kind, line: body.line, col: body.col, file: body.file, appVersion: APP.version } },
  });
  return { ok: true };
});

route('POST', '/errors/report', async ({ body }) => {
  const description = String(body.description || '').trim();
  if (description.length < 5) throw new ApiError('Please describe the problem.', 400);
  const id = ok(await sb.rpc('log_error', {
    p: { source: 'user_report', message: `User report: ${description.slice(0, 160)}`, route: body.page, userAgent: navigator.userAgent,
         context: { description: description.slice(0, 4000), page: body.page, recentErrors: (body.recentErrors || []).slice(0, 5), appVersion: APP.version } },
  }));
  return { id, message: 'Thanks — your report was logged.' };
});

route('GET', '/errors/stats', async () => ok(await sb.rpc('error_stats')));

function errFilters(q, f) {
  if (f.status === 'unresolved') q = q.in('status', ['open', 'acknowledged']);
  else if (f.status && f.status !== 'all') q = q.eq('status', f.status);
  if (f.source) q = q.eq('source', f.source);
  const term = searchTerm(f.q);
  if (term) q = q.or(['message', 'route', 'user_email', 'request_id'].map((c) => `${c}.ilike.*${term}*`).join(','));
  return q;
}
const shapeErr = (e) => ({
  id: e.id, level: e.level, source: e.source, message: e.message, stack: e.stack, route: e.route, method: null,
  statusCode: e.status_code, userId: e.user_id, userEmail: e.user_email, requestId: e.request_id, userAgent: e.user_agent,
  context: e.context, occurrences: e.occurrences, firstSeenAt: e.first_seen_at, lastSeenAt: e.last_seen_at, status: e.status,
  resolutionNotes: e.resolution_notes, resolvedBy: e.resolver ? `${e.resolver.first_name} ${e.resolver.last_name}` : null, resolvedAt: e.resolved_at,
});

route('GET', '/errors', async ({ query }) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = 50;
  const res = await errFilters(sb.from('error_logs').select('*, resolver:profiles(first_name, last_name)', { count: 'exact' }), query)
    .order('last_seen_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  return { items: ok(res).map(shapeErr), total: res.count || 0, page, pageSize };
});

route('GET', '/errors/export.csv', async ({ query }) => {
  const rows = ok(await errFilters(sb.from('error_logs').select('*'), query).order('last_seen_at', { ascending: false }).limit(10000));
  await sb.rpc('log_client_event', { p_action: 'error.export', p_details: { rows: rows.length } });
  return csvFile(`error-logs-${today()}.csv`, toCsv(
    ['id', 'status', 'level', 'source', 'message', 'route', 'status_code', 'occurrences', 'first_seen_at', 'last_seen_at', 'user_email'].map((k) => ({ label: k, key: k })),
    rows));
});

route('GET', '/errors/:id', async ({ params }) => {
  const e = ok(await sb.from('error_logs').select('*, resolver:profiles(first_name, last_name)').eq('id', params.id).maybeSingle());
  if (!e) throw new ApiError('Error not found.', 404);
  return shapeErr(e);
});

route('PUT', '/errors/:id', async ({ params, body }) => {
  ok(await sb.rpc('error_triage', { p_id: Number(params.id), p_status: body.status, p_notes: body.notes || null }));
  return { ok: true };
});

route('POST', '/errors/purge', async ({ body }) => ({ deleted: ok(await sb.rpc('error_purge', { p_days: Number(body.days) || 180 })) }));

/* ---------- Audit ---------- */

function auditFilters(q, f) {
  if (f.action) q = q.like('action', `${f.action}%`);
  if (f.userId) q = q.eq('user_id', f.userId);
  if (f.entityType) q = q.eq('entity_type', f.entityType);
  if (f.entityId) q = q.eq('entity_id', String(f.entityId));
  const term = searchTerm(f.q);
  if (term) q = q.or(`user_email.ilike.*${term}*,action.ilike.*${term}*,entity_id.ilike.*${term}*`);
  if (f.from) q = q.gte('at', new Date(f.from).toISOString());
  if (f.to) q = q.lt('at', new Date(new Date(f.to).getTime() + 86400000).toISOString());
  return q;
}

route('GET', '/audit', async ({ query }) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(200, parseInt(query.pageSize, 10) || 50);
  const res = await auditFilters(sb.from('audit_log').select('*', { count: 'exact' }), query)
    .order('id', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  return { items: ok(res).map((a) => ({ ...a, details: a.details ? JSON.stringify(a.details) : '' })), total: res.count || 0, page, pageSize };
});

route('GET', '/audit/export.csv', async ({ query }) => {
  const rows = ok(await auditFilters(sb.from('audit_log').select('*'), query).order('id', { ascending: false }).limit(50000));
  await sb.rpc('log_client_event', { p_action: 'audit.export', p_details: { rows: rows.length } });
  return csvFile(`audit-log-${today()}.csv`, toCsv(['id', 'at', 'user_email', 'action', 'entity_type', 'entity_id', 'details'].map((k) => ({ label: k, key: k })), rows));
});

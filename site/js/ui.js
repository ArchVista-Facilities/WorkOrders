/**
 * UI toolkit: safe HTML templating, icons, badges, avatars, formatting,
 * modals, toasts, and form helpers. No framework, no build step.
 *
 * SECURITY: always build markup with the `html` tagged template — it escapes
 * every interpolated value unless explicitly wrapped in raw(). Never assign
 * user data to innerHTML any other way.
 */
import { api, signedAvatarUrls } from './api.js';

/* ------------------------------------------------------------------ */
/* Templating                                                          */
/* ------------------------------------------------------------------ */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
/** Mark a string as trusted markup (only for markup we generated). */
export const raw = (s) => new Raw(String(s ?? ''));

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

/** Tagged template that escapes interpolations. Returns a Raw (composable). */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return raw(out);
}

/** Set element content from an html`` result and apply CSP-safe dynamic styles. */
export function mount(el, content) {
  el.innerHTML = String(content);
  applyStyles(el);
  hydrateAvatars(el);
  return el;
}

/** Transparent 1×1 placeholder shown until a private avatar's signed URL resolves. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/**
 * Profile photos live in a private bucket; resolve short-lived signed URLs for
 * every <img data-avatar> in one batched request (cached ~50 min).
 */
export function hydrateAvatars(root) {
  const imgs = [...root.querySelectorAll('img[data-avatar]')];
  if (!imgs.length) return;
  signedAvatarUrls(imgs.map((i) => i.dataset.avatar))
    .then((map) => imgs.forEach((i) => map[i.dataset.avatar] && (i.src = map[i.dataset.avatar])))
    .catch(() => {});
}

/**
 * CSP forbids inline style attributes, so dynamic colors/widths are expressed
 * as data-* attributes and applied via the CSSOM here.
 */
export function applyStyles(root) {
  root.querySelectorAll('[data-bg]').forEach((n) => (n.style.background = n.dataset.bg));
  root.querySelectorAll('[data-fg]').forEach((n) => (n.style.color = n.dataset.fg));
  root.querySelectorAll('[data-w]').forEach((n) => (n.style.width = n.dataset.w));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated event listener: on(root, 'click', '[data-act]', (e, el) => …) */
export function on(root, type, selector, handler) {
  const fn = (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  };
  root.addEventListener(type, fn);
  return () => root.removeEventListener(type, fn);
}

/* ------------------------------------------------------------------ */
/* Icons (inline SVG, stroke-based)                                    */
/* ------------------------------------------------------------------ */

const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M4 22V4M4 4h12l-2 4 2 4H4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  clip: '<path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2M5 7l3 2M19 19l-3-2M5 19l3-2M20 13h-4M4 13h4M10 4l1 2M14 4l-1 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  pin: '<path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || PATHS.info}</svg>`);

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const TZ = 'America/Chicago';
const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const df = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });

export const fmtDateTime = (iso) => (iso ? dtf.format(new Date(iso)) : '—');
export const fmtDate = (iso) => (iso ? df.format(new Date(iso)) : '—');

/** "in 3 h", "2 d ago" */
export function relTime(iso) {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const units = [
    ['d', 86400000],
    ['h', 3600000],
    ['m', 60000],
  ];
  for (const [u, ms] of units) {
    if (abs >= ms || u === 'm') {
      const n = Math.max(1, Math.round(abs / ms));
      return diff >= 0 ? `in ${n}${u}` : `${n}${u} ago`;
    }
  }
  return '';
}

/** ISO → value for <input type="datetime-local"> in local time. */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const money = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
export const num = (n, d = 0) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
export const fileSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);
export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/* ------------------------------------------------------------------ */
/* Badges & avatars                                                    */
/* ------------------------------------------------------------------ */

const STATUS_LABELS = { open: 'Open', assigned: 'Assigned', in_progress: 'In Progress', on_hold: 'On Hold', completed: 'Completed', closed: 'Closed', cancelled: 'Cancelled' };
export const statusBadge = (s) => html`<span class="badge st-${s}">${STATUS_LABELS[s] || titleCase(s)}</span>`;
export const priorityBadge = (p) => (p ? html`<span class="badge prio" data-bg="${p.color}">${p.label}</span>` : '');

export function flagChips(f, { compact = false } = {}) {
  if (!f) return '';
  const chips = [];
  if (f.ligatureRisk) chips.push(html`<span class="badge flag">${icon('alert', 'icon-sm')}${compact ? 'Ligature' : 'Ligature risk'}</span>`);
  if (f.areaOutOfService) chips.push(html`<span class="badge flag-warn">${icon('lock', 'icon-sm')}${compact ? 'OOS' : 'Area out of service'}</span>`);
  if (f.escortRequired) chips.push(html`<span class="badge flag-info">${icon('users', 'icon-sm')}Escort</span>`);
  if (f.patientArea && !compact) chips.push(html`<span class="badge flag-info">${icon('pin', 'icon-sm')}Patient area</span>`);
  return html`${chips}`;
}

/** Avatar image or deterministic-color initials. */
export function avatar(u, size = 32) {
  if (!u) return html`<span class="avatar av-${size} avc-6">?</span>`;
  const name = u.displayName || u.name || `${u.firstName || ''} ${u.lastName || ''}`;
  if (u.hasAvatar && u.avatarPath) {
    return html`<img class="avatar av-${size}" alt="" data-avatar="${u.avatarPath}" src="${BLANK}" />`;
  }
  const initials = name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
  return html`<span class="avatar av-${size} avc-${(Number(u.id) || 0) % 8}" aria-hidden="true">${initials}</span>`;
}

export const person = (u, sub) =>
  u ? html`<span class="person">${avatar(u, 32)}<span class="meta"><strong>${u.name || u.displayName}</strong>${sub ? html`<span class="small muted">${sub}</span>` : ''}</span></span>` : html`<span class="muted">Unassigned</span>`;

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

export function toast(message, kind = 'info', ms = 4000) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Show an API error with its reference id. */
export function toastError(err) {
  const ref = err && err.requestId ? ` (ref ${String(err.requestId).slice(0, 8)})` : '';
  toast(`${(err && err.message) || 'Something went wrong.'}${ref}`, 'error', 7000);
}

export const loading = () => html`<div class="loading"><div class="spinner"></div>Loading…</div>`;
export const emptyState = (msg, ic = 'clipboard') => html`<div class="empty">${icon(ic)}<div>${msg}</div></div>`;

/**
 * Modal dialog.
 * @param {{title:string, body:any, wide?:boolean, actions?:{label:string, kind?:string, id?:string, onClick?:(ctx)=>any, close?:boolean}[]}} o
 * @returns {{el:HTMLElement, close:()=>void, body:HTMLElement}}
 */
export function modal({ title, body, wide = false, actions = [{ label: 'Close', close: true }], onClose }) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  mount(
    back,
    html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-head"><h2>${title}</h2><button class="btn btn-ghost btn-icon" data-x aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${actions.map((a, i) => html`<button class="btn ${a.kind ? `btn-${a.kind}` : ''}" data-i="${i}" ${a.id ? raw(`id="${esc(a.id)}"`) : ''}>${a.label}</button>`)}</div>
    </div>`
  );
  const prevFocus = document.activeElement;
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => e.target === back && close());
  $('[data-x]', back).addEventListener('click', close);
  const ctx = { el: back, close, body: $('.modal-body', back) };
  $$('.modal-foot button', back).forEach((b) =>
    b.addEventListener('click', async () => {
      const a = actions[Number(b.dataset.i)];
      if (a.close) return close();
      if (!a.onClick) return;
      b.disabled = true;
      try {
        await a.onClick(ctx);
      } finally {
        b.disabled = false;
      }
    })
  );
  document.body.appendChild(back);
  const first = $('input:not([type=hidden]),select,textarea', back) || $('.modal-foot .btn-primary, .modal-foot .btn-danger', back);
  if (first) setTimeout(() => first.focus(), 30);
  return ctx;
}

/** Promise<boolean> confirmation dialog. */
export function confirmDialog(message, { title = 'Please confirm', okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: html`<p>${message}</p>`,
      onClose: () => !done && resolve(false),
      actions: [
        { label: 'Cancel', close: true },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: ({ close }) => ((done = true), close(), resolve(true)) },
      ],
    });
  });
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

/** Serialize a form: checkboxes → booleans, everything else → trimmed strings. */
export function formValues(form) {
  const out = {};
  $$('input, select, textarea', form).forEach((el) => {
    if (!el.name || el.type === 'file') return;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value.trim();
  });
  return out;
}

/** Disable a submit button while an async action runs. */
export async function busy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Working…';
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

/** <option> list helper. */
export const options = (list, selected, { valueKey = 'value', labelKey = 'label', blank } = {}) =>
  html`${blank !== undefined ? html`<option value="">${blank}</option>` : ''}${list.map(
    (o) => html`<option value="${o[valueKey]}" ${String(o[valueKey]) === String(selected ?? '') ? raw('selected') : ''}>${o[labelKey]}</option>`
  )}`;

export const checked = (b) => (b ? raw('checked') : '');
export const disabled = (b) => (b ? raw('disabled') : '');

/** Simple pager markup + wiring. */
export function pager({ page, pageSize, total }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return html`<div class="pager">
    <span>${from}–${to} of ${total}</span>
    <span class="actions">
      <button class="btn btn-sm" data-page="${page - 1}" ${disabled(page <= 1)}>Previous</button>
      <span>Page ${page} / ${pages}</span>
      <button class="btn btn-sm" data-page="${page + 1}" ${disabled(page >= pages)}>Next</button>
    </span>
  </div>`;
}

/** Generate an export (CSV etc.) through the API adapter and save it locally. */
export async function download(path) {
  try {
    const f = await api(path);
    const url = URL.createObjectURL(new Blob([f.content], { type: f.type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    toastError(e);
  }
}

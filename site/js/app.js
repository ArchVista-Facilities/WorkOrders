/**
 * Application bootstrap: session check, app shell, hash router, idle timeout,
 * and the global "Report a problem" flow.
 */
import { api, sb, recentErrors, lastApiAt } from './api.js';
import { html, mount, icon, avatar, $, on, toast, toastError, modal, formValues, loading } from './ui.js';
import { routes } from './pages/index.js';

/** Global app state shared with pages. */
export const app = {
  meta: null, // { app, facility, user, permissions, nav, sessionIdleMinutes }
  can(perm) {
    return Boolean(this.meta && (this.meta.user.isSuperuser || this.meta.permissions.includes(perm)));
  },
  canAny(...perms) {
    return perms.some((p) => this.can(p));
  },
  navigate(path) {
    if (location.hash === `#${path}`) router();
    else location.hash = path;
  },
  async refreshMeta() {
    this.meta = await api('/meta');
    window.__AVBH_VERSION__ = this.meta.app.version;
    renderChrome();
  },
  setTitle(t) {
    const el = $('#page-title');
    if (el) el.textContent = t;
    document.title = `${t} · ${this.meta ? this.meta.facility.name : 'Work Orders'}`;
  },
};

const root = document.getElementById('root');
let cleanup = null;
let closeMenusBound = false;

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/** Set when the user arrives from a password-reset email link. */
let recovering = false;

async function boot() {
  // getSession() waits for supabase-js to finish exchanging any ?code= from an email link.
  const { data } = await sb.auth.getSession();
  if (location.search) history.replaceState(null, '', location.pathname + location.hash); // drop ?code=
  if (recovering) return showAuth('recover');
  if (!data.session) return showAuth();
  try {
    await app.refreshMeta();
  } catch (e) {
    if (e.status === 401) return showAuth();
    mount(root, html`<div class="loading">${icon('alert')}<p>Unable to load the application: ${e.message}</p><button class="btn" id="retry">Retry</button></div>`);
    $('#retry').addEventListener('click', boot);
    return;
  }
  // Signed in but not yet approved (or disabled): show the status screen, no data access.
  if (app.meta.user.status !== 'active') return showAuth(app.meta.user.status);
  renderShell();
  router();
  startIdleWatch();
}

async function showAuth(mode = 'login') {
  stopIdleWatch();
  app.meta = null;
  const mod = await import('./pages/auth.js');
  mod.default.render({
    el: root,
    mode,
    onSignedIn: () => {
      recovering = false;
      boot();
    },
  });
}

window.addEventListener('avbh:unauthorized', () => {
  if (!app.meta) return; // not signed in yet (boot probe) — the sign-in screen handles it
  app.meta = null;
  toast('Your session ended. Please sign in again.');
  showAuth();
});
sb.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    recovering = true;
    showAuth('recover');
  }
});
window.addEventListener('hashchange', () => app.meta && router());

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function renderShell() {
  mount(
    root,
    html`<div class="shell">
      <aside class="sidebar" id="sidebar" aria-label="Main navigation"></aside>
      <div class="main">
        <header class="topbar">
          <button class="btn btn-ghost btn-icon menu-btn" id="menu-btn" aria-label="Open menu">${icon('menu')}</button>
          <div class="title" id="page-title"></div>
          <div class="spacer"></div>
          <form class="quick-search" id="quick-search" role="search">
            ${icon('search', 'icon-sm')}
            <input type="search" name="q" placeholder="Search work orders…" aria-label="Search work orders" />
          </form>
          <button class="btn btn-ghost btn-sm" id="report-btn" title="Report a problem with this app">${icon('bug', 'icon-sm')}<span class="uname">Report problem</span></button>
          <div class="dropdown" id="user-menu"></div>
        </header>
        <main class="view" id="view" tabindex="-1"></main>
      </div>
    </div>`
  );
  renderChrome();

  $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('nav-open') && !e.target.closest('#sidebar') && !e.target.closest('#menu-btn')) {
      document.body.classList.remove('nav-open');
    }
  });
  $('#quick-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    app.navigate(`/workorders?status=all${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  });
  $('#report-btn').addEventListener('click', reportProblem);
}

/** Sidebar + user menu (re-rendered when meta changes, e.g. after avatar upload). */
function renderChrome() {
  const side = $('#sidebar');
  if (!side || !app.meta) return;
  const { nav, facility, user, app: info } = app.meta;
  const main = nav.filter((n) => n.section !== 'admin');
  const admin = nav.filter((n) => n.section === 'admin');
  const link = (n) => html`<a href="#${n.path}" data-path="${n.path}">${icon(n.icon)}<span>${n.label}</span></a>`;
  mount(
    side,
    html`<div class="brand">
        <div class="brand-mark">A<span>V</span></div>
        <div><div class="brand-name">Arch Vista</div><div class="brand-sub">Facility Work Orders</div></div>
      </div>
      <nav class="nav">
        ${main.map(link)}
        ${admin.length ? html`<div class="nav-section">Administration</div>${admin.map(link)}` : ''}
      </nav>
      <div class="side-foot">
        <strong>${facility.name}</strong><br />${facility.street}<br />${facility.city}, ${facility.state} ${facility.zip}
        <div class="faint">v${info.version}</div>
      </div>`
  );
  highlightNav();

  const menu = $('#user-menu');
  mount(
    menu,
    html`<button class="user-btn" id="user-btn" aria-haspopup="menu" aria-expanded="false">
        ${avatar({ ...user }, 32)}<span class="uname">${user.displayName}</span>
      </button>
      <div class="dropdown-menu hidden" role="menu">
        <div class="dropdown-head"><strong>${user.displayName}</strong><div class="small muted">${user.email}</div>
          ${user.isSuperuser ? html`<span class="badge flag-info">${icon('shield', 'icon-sm')}Superuser</span>` : ''}</div>
        <a href="#/profile" role="menuitem">${icon('user')}My profile</a>
        <a href="#/profile?tab=security" role="menuitem">${icon('key')}Change password</a>
        <div class="sep"></div>
        <button id="logout-btn" role="menuitem">${icon('logout')}Sign out</button>
      </div>`
  );
  const dd = $('.dropdown-menu', menu);
  $('#user-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    dd.classList.toggle('hidden');
    $('#user-btn').setAttribute('aria-expanded', String(!dd.classList.contains('hidden')));
  });
  if (!closeMenusBound) {
    document.addEventListener('click', () => document.querySelectorAll('.dropdown-menu').forEach((m) => m.classList.add('hidden')));
    closeMenusBound = true;
  }
  $('#logout-btn').addEventListener('click', logout);
}

function highlightNav() {
  const path = location.hash.slice(1).split('?')[0] || '/dashboard';
  // Longest matching nav path wins (so /workorders/new beats /workorders).
  let best = null;
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.remove('active');
    const p = a.dataset.path;
    if ((path === p || path.startsWith(`${p}/`)) && (!best || p.length > best.dataset.path.length)) best = a;
  });
  if (best && !(best.dataset.path === '/workorders' && path === '/workorders/new')) best.classList.add('active');
  else if (best) best.classList.add('active');
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  app.meta = null;
  location.hash = '';
  showAuth();
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function match(path) {
  for (const r of routes) {
    const names = [];
    const re = new RegExp(`^${r.path.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)'))}$`);
    const m = path.match(re);
    if (m) return { route: r, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

async function router() {
  const view = $('#view');
  if (!view) return;
  const [rawPath, rawQuery] = location.hash.slice(1).split('?');
  const path = rawPath || '/dashboard';
  if (!rawPath) return history.replaceState(null, '', '#/dashboard'), router();

  document.body.classList.remove('nav-open');
  highlightNav();
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }

  const found = match(path);
  if (!found) {
    app.setTitle('Not found');
    mount(view, html`<div class="empty">${icon('info')}<div>That page doesn't exist.</div><p><a href="#/dashboard">Go to dashboard</a></p></div>`);
    return;
  }
  const { route, params } = found;
  if (route.permission && !app.canAny(...[].concat(route.permission))) {
    app.setTitle('Access denied');
    mount(view, html`<div class="empty">${icon('lock')}<div>You don't have access to this page. Contact the administrator if you need it.</div></div>`);
    return;
  }
  // Each page renders into a fresh container so delegated listeners from the
  // previous page are garbage-collected with it.
  const host = document.createElement('div');
  view.replaceChildren(host);
  mount(host, loading());
  try {
    const mod = await route.load();
    const page = mod.default;
    app.setTitle(typeof page.title === 'function' ? page.title(params) : page.title);
    const query = Object.fromEntries(new URLSearchParams(rawQuery || ''));
    cleanup = (await page.render({ el: host, params, query, app })) || null;
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    if (e.status === 401) return;
    mount(host, html`<div class="empty">${icon('alert')}<div>${e.message || 'Failed to load this page.'}</div>${e.requestId ? html`<div class="small faint">Reference ${e.requestId}</div>` : ''}</div>`);
    if (!e.status || e.status >= 500) throw e; // let client-errors capture unexpected failures
  }
}

/* ------------------------------------------------------------------ */
/* Idle timeout (mirrors the server's automatic logoff)                */
/* ------------------------------------------------------------------ */

let idleTimer = null;
let keepAlive = null;
let lastActivity = Date.now();
const markActive = () => (lastActivity = Date.now());

function startIdleWatch() {
  stopIdleWatch();
  ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach((ev) => window.addEventListener(ev, markActive, { passive: true }));
  const limit = (app.meta.sessionIdleMinutes || 30) * 60_000;
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > limit) {
      stopIdleWatch();
      logout().then(() => toast('Signed out after inactivity to protect facility data.'));
    }
  }, 30_000);
  // While the user is actively working (e.g. typing a long description), keep the server session alive.
  keepAlive = setInterval(() => {
    if (Date.now() - lastActivity < 5 * 60_000 && Date.now() - lastApiAt > 4 * 60_000) api('/auth/me').catch(() => {});
  }, 60_000);
}
function stopIdleWatch() {
  clearInterval(idleTimer);
  clearInterval(keepAlive);
  ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach((ev) => window.removeEventListener(ev, markActive));
}

/* ------------------------------------------------------------------ */
/* Report a problem                                                    */
/* ------------------------------------------------------------------ */

function reportProblem() {
  modal({
    title: 'Report a problem',
    body: html`<form id="report-form">
      <p class="muted small">Tell us what went wrong. The page you're on and any recent errors are attached automatically. Do not include patient information.</p>
      <div class="field"><label class="req" for="rp-d">What happened?</label>
        <textarea id="rp-d" name="description" required maxlength="4000" placeholder="e.g. I clicked Save on my profile and nothing happened."></textarea></div>
    </form>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Send report',
        kind: 'primary',
        onClick: async ({ el, close }) => {
          const v = formValues($('#report-form', el));
          if (!v.description) return toast('Please describe the problem.', 'error');
          try {
            await api('/errors/report', { method: 'POST', body: { description: v.description, page: location.hash, recentErrors } });
            close();
            toast('Thanks — your report was sent to the administrator.', 'success');
          } catch (e) {
            toastError(e);
          }
        },
      },
    ],
  });
}

/* Delegated: links rendered as buttons with data-href. */
on(document, 'click', '[data-href]', (e, el) => {
  e.preventDefault();
  app.navigate(el.dataset.href);
});

boot();

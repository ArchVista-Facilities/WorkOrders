/**
 * Audit log viewer (read-only, append-only trail).
 */
import { api, qs } from '../api.js';
import { html, mount, icon, $, on, pager, download, fmtDateTime, emptyState } from '../ui.js';

export default {
  title: 'Audit Log',
  async render({ el, query }) {
    const f = { ...query };
    mount(
      el,
      html`<div class="page-head">
        <div><h1>Audit Log</h1><div class="sub">Every sign-in, change, export, and administrative action. Entries cannot be edited or deleted.</div></div>
        <div class="actions"><button class="btn" id="exp">${icon('download')}Export CSV</button></div>
      </div>
      <div class="card">
        <form class="filters" id="filters">
          <input type="search" name="q" placeholder="Search user, action, details…" value="${f.q || ''}" />
          <select name="action">
            <option value="">All actions</option>
            ${['auth', 'user', 'role', 'workorder', 'settings', 'location', 'category', 'priority', 'error', 'report', 'audit'].map(
              (a) => html`<option value="${a}." ${f.action === `${a}.` ? 'selected' : ''}>${a}.*</option>`
            )}
          </select>
          <input type="date" name="from" value="${f.from || ''}" aria-label="From" />
          <input type="date" name="to" value="${f.to || ''}" aria-label="To" />
          ${f.userId ? html`<span class="badge">User #${f.userId} <a href="#/audit">clear</a></span><input type="hidden" name="userId" value="${f.userId}" />` : ''}
        </form>
        <div id="results"></div>
      </div>`
    );
    const form = $('#filters', el);
    const params = () => Object.fromEntries([...new FormData(form).entries()].filter(([, v]) => v));

    const load = async (page = 1) => {
      const p = { ...params(), page };
      history.replaceState(null, '', `#/audit${qs({ ...params(), page: page > 1 ? page : '' })}`);
      const res = await api(`/audit${qs(p)}`);
      const box = $('#results', el);
      if (!res.items.length) return mount(box, emptyState('No audit entries match.', 'list'));
      mount(
        box,
        html`<div class="table-wrap"><table class="table responsive">
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
          <tbody>${res.items.map(
            (a) => html`<tr>
              <td data-label="When" class="nowrap small">${fmtDateTime(a.at)}</td>
              <td data-label="User" class="small">${a.user_email || '—'}</td>
              <td data-label="Action"><code>${a.action}</code></td>
              <td data-label="Target" class="small">${a.entity_type === 'workorder' && a.entity_id ? html`<a href="#/workorders/${a.entity_id}">workorder #${a.entity_id}</a>` : a.entity_type === 'user' && a.entity_id ? html`<a href="#/users/${a.entity_id}">user #${a.entity_id}</a>` : `${a.entity_type || ''}${a.entity_id ? ` #${a.entity_id}` : ''}`}</td>
              <td data-label="Details" class="small"><code>${a.details || ''}</code></td>
            </tr>`
          )}</tbody></table></div>${pager(res)}`
      );
    };

    let t;
    form.addEventListener('input', () => (clearTimeout(t), (t = setTimeout(() => load(1), 250))));
    form.addEventListener('submit', (e) => (e.preventDefault(), load(1)));
    on(el, 'click', '[data-page]', (e, b) => load(Number(b.dataset.page)));
    $('#exp', el).addEventListener('click', () => download(`/audit/export.csv${qs(params())}`));
    await load(Number(f.page) || 1);
  },
};

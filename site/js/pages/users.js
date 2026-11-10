/**
 * Users directory / administration: pending approvals first, search, filter by
 * role and status, inline approve/reject.
 */
import { api, qs } from '../api.js';
import { html, mount, icon, $, on, options, pager, toast, toastError, confirmDialog, statusBadge, avatar, relTime, emptyState } from '../ui.js';

export default {
  title: 'Users',
  async render({ el, query, app }) {
    const manage = app.can('users.manage');
    const roles = manage || app.can('roles.manage') ? await api('/roles') : [];
    const f = { status: '', q: '', roleId: '', ...query };

    mount(
      el,
      html`<div class="page-head">
        <div><h1>Users</h1><div class="sub">Staff accounts for ${app.meta.facility.name}. Only @archvistabh.com addresses can register.</div></div>
      </div>
      <div class="tabs" id="status-tabs">
        <button data-status="" class="${!f.status ? 'active' : ''}">All</button>
        <button data-status="pending" class="${f.status === 'pending' ? 'active' : ''}">Pending approval <span class="count hidden" id="pending-count"></span></button>
        <button data-status="active" class="${f.status === 'active' ? 'active' : ''}">Active</button>
        <button data-status="disabled" class="${f.status === 'disabled' ? 'active' : ''}">Disabled</button>
      </div>
      <div class="card">
        <form class="filters" id="filters">
          <input type="search" name="q" placeholder="Search name, email, title, department…" value="${f.q}" />
          ${roles.length ? html`<select name="roleId">${options(roles, f.roleId, { valueKey: 'id', labelKey: 'name', blank: 'Any role' })}</select>` : ''}
        </form>
        <div id="results"></div>
      </div>`
    );

    let status = f.status;
    const form = $('#filters', el);
    const load = async (page = 1) => {
      const params = { status, q: form.q.value.trim(), roleId: form.roleId ? form.roleId.value : '', page };
      history.replaceState(null, '', `#/users${qs({ ...params, page: page > 1 ? page : '' })}`);
      const res = await api(`/users${qs(params)}`);
      const pc = $('#pending-count', el);
      pc.textContent = res.pending;
      pc.classList.toggle('hidden', !res.pending);
      const box = $('#results', el);
      if (!res.items.length) return mount(box, emptyState('No users match.', 'users'));
      mount(
        box,
        html`<div class="table-wrap"><table class="table responsive">
          <thead><tr><th>Name</th><th>Title / department</th><th>Roles</th><th>Status</th><th>Last sign-in</th>${manage ? html`<th></th>` : ''}</tr></thead>
          <tbody>${res.items.map(
            (u) => html`<tr class="clickable" data-href="/users/${u.id}">
              <td class="title-cell"><span class="person">${avatar(u, 40)}<span class="meta"><strong>${u.displayName}</strong><span class="small muted">${u.email}</span></span></span></td>
              <td data-label="Title">${u.jobTitle || '—'}<div class="small muted">${u.department || ''}</div></td>
              <td data-label="Roles" class="small">${u.isSuperuser ? html`<span class="badge flag-info">Superuser</span> ` : ''}${u.roleNames || '—'}</td>
              <td data-label="Status">${statusBadge(u.status)}</td>
              <td data-label="Last sign-in" class="small muted nowrap">${u.lastLoginAt ? relTime(u.lastLoginAt) : 'Never'}</td>
              ${manage
                ? html`<td class="nowrap">${u.status === 'pending'
                    ? html`<button class="btn btn-sm btn-success" data-approve="${u.id}">${icon('check', 'icon-sm')}Approve</button>
                       <button class="btn btn-sm btn-ghost" data-reject="${u.id}" data-email="${u.email}">Reject</button>`
                    : ''}</td>`
                : ''}
            </tr>`
          )}</tbody></table></div>${pager(res)}`
      );
    };

    on(el, 'click', '[data-status]', (e, b) => {
      status = b.dataset.status;
      el.querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('active', x === b));
      load(1);
    });
    let t;
    form.addEventListener('input', () => (clearTimeout(t), (t = setTimeout(() => load(1), 250))));
    form.addEventListener('submit', (e) => (e.preventDefault(), load(1)));
    on(el, 'click', '[data-page]', (e, b) => load(Number(b.dataset.page)));
    on(el, 'click', '[data-approve]', async (e, b) => {
      e.stopPropagation();
      try {
        await api(`/users/${b.dataset.approve}/status`, { method: 'POST', body: { status: 'active' } });
        toast('Account approved. Assign roles on the user page if they need more than the default.', 'success', 6000);
        load();
      } catch (err) {
        toastError(err);
      }
    });
    on(el, 'click', '[data-reject]', async (e, b) => {
      e.stopPropagation();
      if (!(await confirmDialog(`Reject and delete the registration for ${b.dataset.email}?`, { danger: true, okLabel: 'Reject' }))) return;
      try {
        await api(`/users/${b.dataset.reject}`, { method: 'DELETE' });
        toast('Registration rejected.');
        load();
      } catch (err) {
        toastError(err);
      }
    });

    await load(Number(f.page) || 1);
  },
};

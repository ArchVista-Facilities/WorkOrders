/**
 * Admin view of a single user: profile editing, photo, role assignment,
 * account status, password reset, unlock, and superuser toggle.
 */
import { api } from '../api.js';
import { html, mount, icon, avatar, $, $$, toast, toastError, formValues, busy, confirmDialog, statusBadge, fmtDate, fmtDateTime, checked, disabled } from '../ui.js';
import { profileFields, avatarEditor, wireAvatar } from './_profile-shared.js';

export default {
  title: 'User',
  async render({ el, params, app }) {
    const manage = app.can('users.manage');
    const me = app.meta.user;

    const draw = async () => {
      const [d, roles, people] = await Promise.all([
        api(`/users/${params.id}`),
        manage ? api('/roles') : Promise.resolve([]),
        manage ? api('/users/assignable?all=1') : Promise.resolve([]),
      ]);
      const u = d.user;
      app.setTitle(u.displayName);
      const isSelf = u.id === me.id;
      const protectedTarget = u.isSuperuser && !me.isSuperuser;
      const canEdit = manage && !protectedTarget;
      const roleIds = new Set(d.roles.map((r) => r.id));

      mount(
        el,
        html`<div class="page-head"><div><a href="#/users" class="small">${icon('users', 'icon-sm')} All users</a></div></div>
        <div class="card"><div class="profile-hero">
          ${canEdit ? avatarEditor(u, 96) : avatar(u, 96)}
          <div>
            <h1>${u.displayName}</h1>
            <div class="muted">${u.jobTitle || '—'}${u.department ? ` · ${u.department}` : ''}</div>
            <div class="chips">${statusBadge(u.status)}${u.isSuperuser ? html`<span class="badge flag-info">${icon('shield', 'icon-sm')}Superuser</span>` : ''}${u.isDeveloper ? html`<span class="badge flag-warn">Developer account</span>` : ''}
</div>
            <div class="small faint">${u.email} · Joined ${fmtDate(u.createdAt)} · Last sign-in ${u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'never'}</div>
          </div>
          <div class="spacer"></div>
          ${canEdit && !isSelf
            ? html`<div class="actions">
                ${u.status === 'pending' ? html`<button class="btn btn-success" data-status="active">${icon('check')}Approve</button>` : ''}
                ${u.status === 'disabled' ? html`<button class="btn" data-status="active">${icon('refresh')}Enable</button>` : ''}
                ${u.status === 'active' && !u.isDeveloper ? html`<button class="btn" data-status="disabled">${icon('lock')}Disable</button>` : ''}
                <button class="btn" id="reset-pw">${icon('key')}Send password reset</button>
              </div>`
            : ''}
        </div></div><br />

        <div class="kpis">
          <div class="kpi"><div class="label">Open assigned</div><div class="value">${d.stats.open_assigned || 0}</div></div>
          <div class="kpi"><div class="label">Completed</div><div class="value">${d.stats.completed || 0}</div></div>
          <div class="kpi"><div class="label">Requests submitted</div><div class="value">${d.stats.requested || 0}</div></div>
        </div>

        <div class="split">
          <div>
            ${canEdit
              ? html`<form class="card" id="pf-form" novalidate>${profileFields(u, { admin: true, supervisors: people })}
                  <div class="form-section actions"><button class="btn btn-primary" type="submit">${icon('check')}Save profile</button></div></form>`
              : html`<div class="card"><div class="card-body"><dl class="dl">
                  <dt>Email</dt><dd>${u.email}</dd><dt>Phone</dt><dd>${u.phone || '—'}${u.extension ? ` x${u.extension}` : ''}</dd>
                  <dt>Mobile</dt><dd>${u.mobile || '—'}</dd><dt>Shift</dt><dd>${u.shift || '—'}</dd>
                  <dt>Supervisor</dt><dd>${d.supervisor ? d.supervisor.name : '—'}</dd>
                  <dt>Certifications</dt><dd class="desc">${u.certifications || '—'}</dd><dt>Skills</dt><dd class="desc">${u.skills || '—'}</dd>
                </dl></div></div>`}
          </div>
          <div class="stack">
            ${manage
              ? html`<div class="card"><div class="card-head"><h2>Roles</h2></div>
                  <form class="card-body" id="roles-form">
                    ${roles.map(
                      (r) => html`<label class="check"><input type="checkbox" name="role" value="${r.id}" ${checked(roleIds.has(r.id))} ${disabled(!canEdit || (isSelf && !me.isSuperuser))} />
                        <span><strong>${r.name}</strong><span class="help">${r.description || ''}</span></span></label>`
                    )}
                    ${canEdit && !(isSelf && !me.isSuperuser) ? html`<button class="btn btn-primary btn-sm" type="submit">Save roles</button>` : ''}
                  </form></div>`
              : ''}
            ${me.isSuperuser && !isSelf && u.status === 'active'
              ? html`<div class="card"><div class="card-head"><h2>Superuser</h2></div><div class="card-body">
                  <p class="small muted">Superusers bypass every permission check, including role management. Grant sparingly.</p>
                  ${u.isDeveloper
                    ? html`<p class="small">The developer account is always a superuser.</p>`
                    : html`<button class="btn ${u.isSuperuser ? 'btn-danger' : ''}" id="su-toggle">${u.isSuperuser ? 'Revoke superuser' : 'Make superuser'}</button>`}
                </div></div>`
              : ''}
            <div class="card"><div class="card-head"><h2>Effective permissions</h2></div><div class="card-body small">
              ${d.permissions[0] === '*' ? 'All permissions (superuser)' : d.permissions.length ? d.permissions.sort().join(', ') : 'None'}
            </div></div>
            ${app.can('audit.view') ? html`<a class="btn btn-block" href="#/audit?userId=${u.id}">${icon('list')}View this user's activity</a>` : ''}
          </div>
        </div>`
      );

      wireAvatar(el, `/users/${u.id}/avatar`, () => draw());

      const pf = $('#pf-form', el);
      if (pf) {
        pf.addEventListener('submit', async (e) => {
          e.preventDefault();
          await busy($('button[type=submit]', pf), async () => {
            try {
              await api(`/users/${u.id}`, { method: 'PUT', body: formValues(pf) });
              toast('Profile saved.', 'success');
              draw();
            } catch (err) {
              toastError(err);
            }
          });
        });
      }

      const rf = $('#roles-form', el);
      if (rf) {
        rf.addEventListener('submit', async (e) => {
          e.preventDefault();
          const ids = $$('input[name=role]:checked', rf).map((i) => Number(i.value));
          try {
            await api(`/users/${u.id}/roles`, { method: 'PUT', body: { roleIds: ids } });
            toast('Roles updated.', 'success');
            draw();
          } catch (err) {
            toastError(err);
          }
        });
      }

      $$('[data-status]', el).forEach((b) =>
        b.addEventListener('click', async () => {
          const to = b.dataset.status;
          if (to === 'disabled' && !(await confirmDialog(`Disable ${u.displayName}? They will be signed out immediately.`, { danger: true, okLabel: 'Disable' }))) return;
          try {
            await api(`/users/${u.id}/status`, { method: 'POST', body: { status: to } });
            toast(to === 'active' ? 'Account active.' : 'Account disabled.', 'success');
            draw();
          } catch (err) {
            toastError(err);
          }
        })
      );

      const rp = $('#reset-pw', el);
      if (rp) {
        rp.addEventListener('click', async () => {
          if (!(await confirmDialog(`Email ${u.displayName} a secure link to set a new password?`, { okLabel: 'Send reset email' }))) return;
          try {
            const res = await api(`/users/${u.id}/reset-password`, { method: 'POST' });
            toast(`Reset link sent to ${res.sentTo}.`, 'success', 6000);
          } catch (err) {
            toastError(err);
          }
        });
      }

      const su = $('#su-toggle', el);
      if (su) {
        su.addEventListener('click', async () => {
          const grant = !u.isSuperuser;
          if (!(await confirmDialog(grant ? `Make ${u.displayName} a superuser with unrestricted access?` : `Revoke superuser from ${u.displayName}?`, { danger: grant, okLabel: grant ? 'Grant superuser' : 'Revoke' }))) return;
          try {
            await api(`/users/${u.id}/superuser`, { method: 'POST', body: { isSuperuser: grant } });
            toast('Updated.', 'success');
            draw();
          } catch (err) {
            toastError(err);
          }
        });
      }
    };

    await draw();
  },
};

/**
 * Roles & Permissions editor. Permissions are grouped by module; new modules'
 * permissions appear here automatically.
 */
import { api } from '../api.js';
import { html, mount, icon, $, $$, on, toast, toastError, formValues, confirmDialog, checked, titleCase } from '../ui.js';

const MODULE_LABEL = { workorders: 'Work orders', users: 'Users', roles: 'Roles', settings: 'Settings', reports: 'Reports', errors: 'Error logs', audit: 'Audit' };

export default {
  title: 'Roles & Permissions',
  async render({ el, app }) {
    const catalogue = await api('/roles/permissions');
    let roles = await api('/roles');
    let selected = roles[0] ? roles[0].id : 'new';

    const draw = () => {
      const role = selected === 'new' ? { id: 'new', name: '', description: '', permissions: [], is_system: 0, is_default: 0, userCount: 0 } : roles.find((r) => r.id === selected);
      const has = new Set(role.permissions);
      mount(
        el,
        html`<div class="page-head"><div><h1>Roles & Permissions</h1><div class="sub">Define what each role can do, then assign roles on each user's page.</div></div>
          <div class="actions"><button class="btn btn-primary" data-select="new">${icon('plus')}New role</button></div></div>
        <div class="split">
          <form class="card" id="role-form" novalidate>
            <div class="form-section">
              <div class="form-grid">
                <div class="field"><label class="req" for="r-n">Role name</label><input id="r-n" name="name" type="text" maxlength="60" value="${role.name}" required /></div>
                <div class="field"><label for="r-d">Description</label><input id="r-d" name="description" type="text" maxlength="300" value="${role.description || ''}" /></div>
              </div>
              <label class="check"><input type="checkbox" name="isDefault" ${checked(role.is_default)} />
                <span><strong>Default role for new accounts</strong><span class="help">Automatically granted when someone registers.</span></span></label>
              ${role.is_system ? html`<div class="notice info">${icon('info')}<div>Built-in role. You can adjust its permissions; it cannot be deleted.</div></div>` : ''}
            </div>
            <div class="form-section">
              <h3>${icon('shield')}Permissions</h3>
              ${Object.entries(catalogue).map(
                ([mod, perms]) => html`<div class="perm-group"><h4>${MODULE_LABEL[mod] || titleCase(mod)}</h4>
                  ${perms.map(
                    (p) => p.superuser_only
                      ? html`<label class="check"><input type="checkbox" disabled />
                          <span><strong>${p.label}</strong> <span class="badge flag-info">${icon('shield', 'icon-sm')}Owner only</span><span class="help">${p.description || ''} <code>${p.key}</code>. Reserved for the owner account; can't be given to a role.</span></span></label>`
                      : html`<label class="check"><input type="checkbox" name="perm" value="${p.key}" ${checked(has.has(p.key))} />
                          <span><strong>${p.label}</strong><span class="help">${p.description || ''} <code>${p.key}</code></span></span></label>`
                  )}</div>`
              )}
            </div>
            <div class="form-section actions">
              <button class="btn btn-primary" type="submit">${icon('check')}${role.id === 'new' ? 'Create role' : 'Save role'}</button>
              ${role.id !== 'new' && !role.is_system ? html`<button class="btn btn-danger" type="button" id="del-role">${icon('trash')}Delete role</button>` : ''}
              ${role.id !== 'new' ? html`<span class="small muted">${role.userCount} user${role.userCount === 1 ? ' has' : 's have'} this role</span>` : ''}
            </div>
          </form>
          <div class="card"><div class="card-head"><h2>Roles</h2></div>
            <ul class="list-select">${roles.map(
              (r) => html`<li><button type="button" data-select="${r.id}" class="${r.id === selected ? 'active' : ''}"><span>${r.name}${r.is_default ? html` <span class="badge">default</span>` : ''}</span><span class="small muted">${r.userCount}</span></button></li>`
            )}${selected === 'new' ? html`<li><button class="active" type="button">New role…</button></li>` : ''}</ul></div>
        </div>`
      );

      $('#role-form', el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = formValues(e.target);
        const body = { name: v.name, description: v.description, isDefault: v.isDefault, permissions: $$('input[name=perm]:checked', e.target).map((i) => i.value) };
        try {
          const saved = role.id === 'new' ? await api('/roles', { method: 'POST', body }) : await api(`/roles/${role.id}`, { method: 'PUT', body });
          roles = await api('/roles');
          selected = saved.id;
          toast('Role saved. Changes apply to users immediately.', 'success');
          draw();
          await app.refreshMeta();
        } catch (err) {
          toastError(err);
        }
      });
      const del = $('#del-role', el);
      if (del) {
        del.addEventListener('click', async () => {
          if (!(await confirmDialog(`Delete the "${role.name}" role? ${role.userCount} user(s) will lose its permissions.`, { danger: true, okLabel: 'Delete role' }))) return;
          try {
            await api(`/roles/${role.id}`, { method: 'DELETE' });
            roles = await api('/roles');
            selected = roles[0] ? roles[0].id : 'new';
            draw();
          } catch (err) {
            toastError(err);
          }
        });
      }
    };

    on(el, 'click', '[data-select]', (e, b) => {
      selected = b.dataset.select === 'new' ? 'new' : Number(b.dataset.select);
      draw();
    });
    draw();
  },
};

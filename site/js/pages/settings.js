/**
 * Settings: facility identity & registration policy, locations, categories,
 * and priority response targets.
 */
import { api } from '../api.js';
import { html, mount, icon, $, on, modal, toast, toastError, formValues, checked } from '../ui.js';

export default {
  title: 'Settings',
  async render({ el, query, app }) {
    let tab = query.tab || 'facility';

    const draw = async () => {
      const [cfg, lk] = await Promise.all([api('/settings/app'), api('/settings/lookups?all=1')]);
      const f = cfg.facility;
      const tabs = [
        ['facility', 'Facility & access'],
        ['locations', 'Locations'],
        ['categories', 'Categories'],
        ['priorities', 'Priorities & targets'],
      ];
      mount(
        el,
        html`<div class="page-head"><div><h1>Settings</h1><div class="sub">Configuration for the work order system.</div></div></div>
        <div class="tabs">${tabs.map(([k, l]) => html`<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)}</div>
        <div id="tab-body"></div>`
      );
      const body = $('#tab-body', el);

      if (tab === 'facility') {
        mount(
          body,
          html`<form class="card" id="app-form" novalidate>
            <div class="form-section"><h3>${icon('home')}Facility</h3>
              <div class="form-grid">
                <div class="field full"><label class="req" for="s-n">Facility name</label><input id="s-n" name="name" type="text" value="${f.name}" /></div>
                <div class="field full"><label class="req" for="s-s">Street</label><input id="s-s" name="street" type="text" value="${f.street}" /></div>
                <div class="field"><label class="req" for="s-c">City</label><input id="s-c" name="city" type="text" value="${f.city}" /></div>
                <div class="form-grid">
                  <div class="field"><label class="req" for="s-st">State</label><input id="s-st" name="state" type="text" maxlength="2" value="${f.state}" /></div>
                  <div class="field"><label class="req" for="s-z">ZIP</label><input id="s-z" name="zip" type="text" maxlength="10" value="${f.zip}" /></div>
                </div>
              </div>
            </div>
            <div class="form-section"><h3>${icon('clipboard')}Work orders</h3>
              <div class="field"><label class="req" for="s-p">Number prefix</label><input id="s-p" name="woPrefix" type="text" maxlength="6" value="${cfg.woPrefix}" />
                <div class="help">Numbers look like ${cfg.woPrefix}-${new Date().getFullYear()}-00042. Applies to new work orders.</div></div>
            </div>
            <div class="form-section"><h3>${icon('lock')}Account access</h3>
              ${app.meta.user.isSuperuser
                ? html`<div class="field"><label for="s-dom">Allowed email domains</label><input id="s-dom" name="allowedDomains" type="text" value="${cfg.allowedDomains.join(', ')}" />
                    <div class="help">Comma-separated, exact match (no subdomains). Superuser only. The developer account is always allowed.</div></div>`
                : html`<p class="small">Registration is restricted to: <strong>${cfg.allowedDomains.map((d) => `@${d}`).join(', ')}</strong> (plus the developer account).</p>`}
              <label class="check"><input type="checkbox" name="autoApproveDomainUsers" ${checked(cfg.autoApproveDomainUsers)} />
                <span><strong>Auto-approve new registrations</strong><span class="help">Off (recommended): after confirming their email, new accounts wait for an administrator to approve them.</span></span></label>
            </div>
            <div class="form-section"><button class="btn btn-primary" type="submit">${icon('check')}Save settings</button></div>
          </form>`
        );
        $('#app-form', body).addEventListener('submit', async (e) => {
          e.preventDefault();
          const v = formValues(e.target);
          try {
            await api('/settings/app', {
              method: 'PUT',
              body: {
                facility: { name: v.name, street: v.street, city: v.city, state: v.state, zip: v.zip },
                woPrefix: v.woPrefix,
                autoApproveDomainUsers: v.autoApproveDomainUsers,
                ...(v.allowedDomains !== undefined ? { allowedDomains: v.allowedDomains.split(',').map((d) => d.trim()).filter(Boolean) } : {}),
              },
            });
            toast('Settings saved.', 'success');
            await app.refreshMeta();
          } catch (err) {
            toastError(err);
          }
        });
      }

      if (tab === 'locations') {
        mount(
          body,
          html`<div class="card"><div class="card-head"><h2>Locations</h2><button class="btn btn-primary btn-sm" data-edit-loc="new">${icon('plus', 'icon-sm')}Add location</button></div>
            <div class="table-wrap"><table class="table responsive"><thead><tr><th>Building</th><th>Unit</th><th>Location</th><th>Patient area</th><th>Status</th><th>Order</th><th></th></tr></thead>
            <tbody>${lk.locations.map(
              (l) => html`<tr><td data-label="Building">${l.building}</td><td data-label="Unit">${l.unit || '—'}</td><td data-label="Location"><strong>${l.name}</strong></td>
                <td data-label="Patient area">${l.is_patient_area ? html`<span class="badge flag-info">Yes</span>` : 'No'}</td>
                <td data-label="Status">${l.is_active ? html`<span class="badge st-active">Active</span>` : html`<span class="badge st-disabled">Inactive</span>`}</td>
                <td data-label="Order" class="small muted">${l.sort_order}</td>
                <td><button class="btn btn-sm" data-edit-loc="${l.id}">${icon('edit', 'icon-sm')}Edit</button></td></tr>`
            )}</tbody></table></div></div>`
        );
      }

      if (tab === 'categories') {
        mount(
          body,
          html`<div class="card"><div class="card-head"><h2>Categories</h2><button class="btn btn-primary btn-sm" data-edit-cat="new">${icon('plus', 'icon-sm')}Add category</button></div>
            <div class="table-wrap"><table class="table responsive"><thead><tr><th>Name</th><th>Description</th><th>Status</th><th>Order</th><th></th></tr></thead>
            <tbody>${lk.categories.map(
              (c) => html`<tr><td data-label="Name"><strong>${c.name}</strong></td><td data-label="Description" class="small">${c.description || ''}</td>
                <td data-label="Status">${c.is_active ? html`<span class="badge st-active">Active</span>` : html`<span class="badge st-disabled">Inactive</span>`}</td>
                <td data-label="Order" class="small muted">${c.sort_order}</td>
                <td><button class="btn btn-sm" data-edit-cat="${c.id}">${icon('edit', 'icon-sm')}Edit</button></td></tr>`
            )}</tbody></table></div></div>`
        );
      }

      if (tab === 'priorities') {
        mount(
          body,
          html`<div class="notice info">${icon('info')}<div>Response targets set each new work order's due date. Ligature-risk requests are always raised to at least <strong>Urgent</strong>.</div></div>
          <div class="grid grid-2">${lk.priorities.map(
            (p) => html`<form class="card" data-prio="${p.key}"><div class="form-section">
              <h3><span class="dot" data-bg="${p.color}"></span>${p.label} <span class="faint small">(${p.key})</span></h3>
              <div class="form-grid">
                <div class="field"><label>Label</label><input name="label" type="text" maxlength="40" value="${p.label}" /></div>
                <div class="field"><label>Target (hours)</label><input name="slaHours" type="number" min="1" max="8760" value="${p.sla_hours}" /></div>
                <div class="field"><label>Color</label><input name="color" type="color" value="${p.color}" /></div>
                <div class="field full"><label>Description</label><textarea name="description" maxlength="300">${p.description || ''}</textarea></div>
              </div>
              <button class="btn btn-primary btn-sm" type="submit">Save</button></div></form>`
          )}</div>`
        );
        body.querySelectorAll('[data-prio]').forEach((form) =>
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
              await api(`/settings/priorities/${form.dataset.prio}`, { method: 'PUT', body: formValues(form) });
              toast('Priority saved.', 'success');
              draw();
            } catch (err) {
              toastError(err);
            }
          })
        );
      }

      el._lookups = lk;
    };

    const editLocation = (id) => {
      const l = id === 'new' ? { building: 'Main Building', unit: '', name: '', is_patient_area: 0, is_active: 1, sort_order: 0 } : el._lookups.locations.find((x) => x.id === Number(id));
      modal({
        title: id === 'new' ? 'Add location' : 'Edit location',
        body: html`<form id="loc-form" class="form-grid">
          <div class="field"><label class="req">Building</label><input name="building" type="text" maxlength="100" value="${l.building}" /></div>
          <div class="field"><label>Unit / wing</label><input name="unit" type="text" maxlength="100" value="${l.unit || ''}" /></div>
          <div class="field full"><label class="req">Location name</label><input name="name" type="text" maxlength="150" value="${l.name}" placeholder="e.g. PTSD Unit — Patient Rooms 200–220" /></div>
          <div class="field"><label>Sort order</label><input name="sortOrder" type="number" min="0" value="${l.sort_order}" /></div>
          <div class="field full"><label class="check"><input type="checkbox" name="isPatientArea" ${checked(l.is_patient_area)} /><span><strong>Patient-care area</strong><span class="help">Triggers tool-control attestation on completion.</span></span></label>
            <label class="check"><input type="checkbox" name="isActive" ${checked(l.is_active)} /><span><strong>Active</strong><span class="help">Inactive locations are hidden from new requests but kept on history.</span></span></label></div>
        </form>`,
        actions: [
          { label: 'Cancel', close: true },
          {
            label: 'Save',
            kind: 'primary',
            onClick: async ({ el: m, close }) => {
              try {
                const v = formValues($('#loc-form', m));
                if (id === 'new') await api('/settings/locations', { method: 'POST', body: v });
                else await api(`/settings/locations/${id}`, { method: 'PUT', body: v });
                close();
                toast('Location saved.', 'success');
                draw();
              } catch (err) {
                toastError(err);
              }
            },
          },
        ],
      });
    };

    const editCategory = (id) => {
      const c = id === 'new' ? { name: '', description: '', is_active: 1, sort_order: 0 } : el._lookups.categories.find((x) => x.id === Number(id));
      modal({
        title: id === 'new' ? 'Add category' : 'Edit category',
        body: html`<form id="cat-form">
          <div class="field"><label class="req">Name</label><input name="name" type="text" maxlength="100" value="${c.name}" /></div>
          <div class="field"><label>Description</label><input name="description" type="text" maxlength="300" value="${c.description || ''}" /></div>
          <div class="field"><label>Sort order</label><input name="sortOrder" type="number" min="0" value="${c.sort_order}" /></div>
          <label class="check"><input type="checkbox" name="isActive" ${checked(c.is_active)} /><span><strong>Active</strong></span></label>
        </form>`,
        actions: [
          { label: 'Cancel', close: true },
          {
            label: 'Save',
            kind: 'primary',
            onClick: async ({ el: m, close }) => {
              try {
                const v = formValues($('#cat-form', m));
                if (id === 'new') await api('/settings/categories', { method: 'POST', body: v });
                else await api(`/settings/categories/${id}`, { method: 'PUT', body: v });
                close();
                toast('Category saved.', 'success');
                draw();
              } catch (err) {
                toastError(err);
              }
            },
          },
        ],
      });
    };

    on(el, 'click', '[data-tab]', (e, b) => {
      tab = b.dataset.tab;
      history.replaceState(null, '', `#/settings?tab=${tab}`);
      draw();
    });
    on(el, 'click', '[data-edit-loc]', (e, b) => editLocation(b.dataset.editLoc));
    on(el, 'click', '[data-edit-cat]', (e, b) => editCategory(b.dataset.editCat));
    await draw();
  },
};

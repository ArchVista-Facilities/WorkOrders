/**
 * Create / edit a work order.
 *
 * Behavioral-health UX:
 *  - PHI warning on the description field (work orders are not clinical records).
 *  - Selecting a patient-care location pre-checks "Patient-care area".
 *  - Ligature risk shows an escalation notice (server enforces ≥ Urgent).
 *  - Photo can be attached at submission time.
 */
import { api } from '../api.js';
import { html, mount, icon, $, raw, toast, toastError, formValues, busy, options, checked, toLocalInput } from '../ui.js';

export default {
  title: (p) => (p.id ? 'Edit Work Order' : 'New Request'),
  async render({ el, params, app }) {
    const editing = Boolean(params.id);
    const [lookups, meta, assignable, existing] = await Promise.all([
      api('/settings/lookups'),
      api('/workorders/meta'),
      app.can('workorders.assign') ? api('/users/assignable') : Promise.resolve([]),
      editing ? api(`/workorders/${params.id}`) : Promise.resolve(null),
    ]);
    if (editing && !existing.abilities.edit) {
      mount(el, html`<div class="empty">${icon('lock')}<div>You can't edit this work order.</div></div>`);
      return;
    }
    const w = existing ? existing.workOrder : null;
    const fullEdit = app.can('workorders.edit');
    const canAssign = app.can('workorders.assign');

    // Group locations by building for <optgroup>.
    const byBuilding = {};
    lookups.locations.forEach((l) => (byBuilding[l.building] = byBuilding[l.building] || []).push(l));
    const locSelect = html`<option value="">Select a location…</option>${Object.entries(byBuilding).map(
      ([b, list]) => html`<optgroup label="${b}">${list.map(
        (l) => html`<option value="${l.id}" data-patient="${l.is_patient_area}" ${w && w.location && w.location.id === l.id ? raw('selected') : ''}>${l.unit && l.unit !== l.name ? `${l.unit} — ` : ''}${l.name}${l.is_patient_area ? ' (patient area)' : ''}</option>`
      )}</optgroup>`
    )}`;

    const prio = w ? w.priority.key : 'routine';
    const slaText = (h) => (h < 24 ? `${h} hr target` : h < 168 ? `${Math.round(h / 24)} day target` : `${Math.round(h / 24)} days`);

    mount(
      el,
      html`<div class="page-head">
        <div><h1>${editing ? `Edit ${w.number}` : 'Submit a maintenance request'}</h1>
          <div class="sub">${editing ? w.title : 'Describe the problem and where it is. Maintenance will be notified on the board immediately.'}</div></div>
      </div>
      <form id="wo-form" class="card" novalidate>
        <div class="form-section">
          <h3>${icon('alert')}Is anyone in immediate danger?</h3>
          <p class="small muted">For fire, medical, behavioral, or security emergencies call your facility emergency code / 911 first. Then submit this request for the facility repair.</p>
        </div>

        <div class="form-section">
          <h3>${icon('clipboard')}What needs attention?</h3>
          <div class="field"><label class="req" for="f-title">Short title</label>
            <input id="f-title" name="title" type="text" maxlength="150" required placeholder="e.g. Toilet running in room 214" value="${w ? w.title : ''}" /></div>
          <div class="field"><label class="req" for="f-desc">Description</label>
            <textarea id="f-desc" name="description" maxlength="5000" required placeholder="What is wrong, when it started, and anything maintenance should know before arriving.">${w ? w.description : ''}</textarea>
            <div class="help">${icon('lock', 'icon-sm')} Do not include patient names, MRNs, or clinical details. Refer to rooms and units only.</div></div>
          <div class="form-grid">
            <div class="field"><label class="req" for="f-cat">Category</label>
              <select id="f-cat" name="categoryId" required>${options(lookups.categories, w && w.category ? w.category.id : '', { valueKey: 'id', labelKey: 'name', blank: 'Select a category…' })}</select></div>
            <div class="field"><label for="f-type">Type</label>
              <select id="f-type" name="type">${options(meta.types, w ? w.type : 'corrective', { valueKey: 'key', labelKey: 'label' })}</select></div>
          </div>
        </div>

        <div class="form-section">
          <h3>${icon('pin')}Where is it?</h3>
          <div class="form-grid">
            <div class="field"><label class="req" for="f-loc">Location</label><select id="f-loc" name="locationId" required>${locSelect}</select></div>
            <div class="field"><label for="f-room">Room / specific spot</label>
              <input id="f-room" name="locationDetail" type="text" maxlength="150" placeholder="e.g. Room 214, bathroom" value="${w ? w.locationDetail || '' : ''}" /></div>
            <div class="field"><label for="f-asset">Asset / equipment tag</label>
              <input id="f-asset" name="assetTag" type="text" maxlength="60" placeholder="Optional" value="${w ? w.assetTag || '' : ''}" /></div>
            <div class="field"><label for="f-phone">Best contact number</label>
              <input id="f-phone" name="contactPhone" type="tel" maxlength="30" placeholder="Unit phone or extension" value="${w ? w.contactPhone || '' : app.meta.user.extension || app.meta.user.phone || ''}" /></div>
          </div>
        </div>

        <div class="form-section">
          <h3>${icon('shield')}Safety</h3>
          <label class="check"><input type="checkbox" name="ligatureRisk" id="f-lig" ${checked(w && w.flags.ligatureRisk)} />
            <span><strong>Ligature or self-harm risk</strong><span class="help">A fixture, hardware, or damage that could be used for self-harm (loose hooks, exposed cords, broken anti-ligature hardware, damaged ceiling).</span></span></label>
          <div class="notice danger hidden" id="lig-note">${icon('alert')}<div><strong>This request will be escalated to at least Urgent.</strong> Notify the charge nurse so the area can be monitored or restricted until repaired.</div></div>
          <label class="check"><input type="checkbox" name="patientArea" id="f-pa" ${checked(w && w.flags.patientArea)} />
            <span><strong>Patient-care area</strong><span class="help">Technicians must account for all tools and debris before closing.</span></span></label>
          <label class="check"><input type="checkbox" name="areaOutOfService" ${checked(w && w.flags.areaOutOfService)} />
            <span><strong>Room / area has been taken out of service</strong><span class="help">The space is closed to patients until this is fixed.</span></span></label>
          <label class="check"><input type="checkbox" name="escortRequired" ${checked(w && w.flags.escortRequired)} />
            <span><strong>Staff escort required</strong><span class="help">Maintenance must be escorted on the unit.</span></span></label>
        </div>

        <div class="form-section">
          <h3>${icon('clock')}Priority</h3>
          <div class="choice-grid">${lookups.priorities.map(
            (p) => html`<label class="choice"><input type="radio" name="priority" value="${p.key}" ${checked(p.key === prio)} />
              <span class="t"><span class="dot" data-bg="${p.color}"></span>${p.label}</span>
              <span class="d">${slaText(p.sla_hours)} · ${p.description || ''}</span></label>`
          )}</div>
        </div>

        ${canAssign || fullEdit
          ? html`<div class="form-section">
              <h3>${icon('users')}Dispatch</h3>
              <div class="form-grid">
                ${canAssign && !editing
                  ? html`<div class="field"><label for="f-asg">Assign to</label><select id="f-asg" name="assigneeId">${options(assignable, '', { valueKey: 'id', labelKey: 'name', blank: 'Leave unassigned' })}</select></div>`
                  : ''}
                <div class="field"><label for="f-due">Due date / time</label>
                  <input id="f-due" name="dueAt" type="datetime-local" value="${w ? toLocalInput(w.dueAt) : ''}" />
                  <div class="help">Leave blank to use the priority's response target.</div></div>
                ${editing && fullEdit
                  ? html`<div class="field"><label for="f-lh">Labor hours</label><input id="f-lh" name="laborHours" type="number" step="0.25" min="0" value="${w.laborHours ?? ''}" /></div>
                    <div class="field"><label for="f-pc">Parts cost ($)</label><input id="f-pc" name="partsCost" type="number" step="0.01" min="0" value="${w.partsCost ?? ''}" /></div>`
                  : ''}
              </div>
            </div>`
          : ''}

        ${!editing
          ? html`<div class="form-section">
              <h3>${icon('camera')}Photo (optional)</h3>
              <input type="file" name="photo" id="f-photo" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" />
              <div class="help">A photo helps maintenance bring the right parts. Avoid capturing patients. Max 10 MB.</div>
            </div>`
          : ''}

        <div class="form-section actions">
          <button class="btn btn-primary btn-lg" type="submit">${icon('check')}${editing ? 'Save changes' : 'Submit request'}</button>
          <a class="btn btn-lg btn-ghost" href="#${editing ? `/workorders/${w.id}` : '/workorders'}">Cancel</a>
        </div>
      </form>`
    );

    const form = $('#wo-form', el);
    const lig = $('#f-lig', form);
    const ligNote = $('#lig-note', form);
    const syncLig = () => ligNote.classList.toggle('hidden', !lig.checked);
    lig.addEventListener('change', syncLig);
    syncLig();
    $('#f-loc', form).addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt && opt.dataset.patient === '1') $('#f-pa', form).checked = true;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(form);
      const missing = ['title', 'description', 'categoryId', 'locationId'].filter((k) => !v[k]);
      if (missing.length) {
        toast('Please complete the required fields.', 'error');
        $(`[name=${missing[0]}]`, form).focus();
        return;
      }
      const body = { ...v, dueAt: v.dueAt ? new Date(v.dueAt).toISOString() : editing ? null : undefined };
      if (editing && !fullEdit) delete body.dueAt;
      await busy($('button[type=submit]', form), async () => {
        try {
          const saved = editing
            ? await api(`/workorders/${w.id}`, { method: 'PUT', body })
            : await api('/workorders', { method: 'POST', body });
          const photo = $('#f-photo', form);
          if (photo && photo.files[0]) {
            const fd = new FormData();
            fd.append('file', photo.files[0]);
            await api(`/workorders/${saved.id}/attachments`, { method: 'POST', form: fd }).catch((err) => toastError(err));
          }
          toast(editing ? 'Changes saved.' : `Request ${saved.number} submitted.`, 'success');
          app.navigate(`/workorders/${saved.id}`);
        } catch (err) {
          toastError(err);
        }
      });
    });
  },
};


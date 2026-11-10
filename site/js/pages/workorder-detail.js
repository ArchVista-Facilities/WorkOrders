/**
 * Work order detail: status workflow actions, assignment, tool-control
 * completion, comments (with internal notes), photo/PDF attachments,
 * full change history, and a print layout for paper copies on secure units.
 */
import { api } from '../api.js';
import {
  html, mount, icon, $, on, modal, confirmDialog, toast, toastError, formValues, options, busy,
  statusBadge, priorityBadge, flagChips, person, avatar, fmtDateTime, relTime, money, num, fileSize, titleCase, emptyState,
} from '../ui.js';

/** Which transition buttons to show, with labels and required abilities. */
function actionButtons(d, from) {
  const a = d.abilities;
  const btns = [];
  const add = (to, label, ic, kind = '', when = true) => when && d.transitions.includes(to) && btns.push({ to, label, ic, kind });
  const reopening = ['completed', 'closed'].includes(from);
  add('in_progress', reopening ? 'Reopen' : from === 'on_hold' ? 'Resume work' : 'Start work', reopening ? 'refresh' : 'play', reopening ? '' : 'primary', reopening ? a.close : a.work);
  add('completed', 'Complete', 'check', 'success', a.work);
  add('on_hold', 'Put on hold', 'pause', '', a.work);
  add('closed', 'Close', 'lock', 'primary', a.close);
  add('open', 'Reopen', 'refresh', '', from === 'cancelled' && a.edit);
  add('cancelled', 'Cancel request', 'x', '', a.cancel);
  return btns;
}

const HISTORY_LABEL = {
  created: 'Created the request',
  assigned: 'Assigned',
  unassigned: 'Removed assignee',
  status: 'Changed status',
  updated: 'Updated',
  comment: 'Commented',
  attachment: 'Attached',
  attachment_removed: 'Removed attachment',
  tool_control: 'Tool control confirmed',
  deleted: 'Deleted',
};
const FIELD_LABEL = {
  priority_key: 'priority', category_id: 'category', location_id: 'location', location_detail: 'room/detail', asset_tag: 'asset tag',
  ligature_risk: 'ligature risk', patient_area: 'patient area', area_out_of_service: 'out of service', escort_required: 'escort required',
  contact_phone: 'contact phone', due_at: 'due date', labor_hours: 'labor hours', parts_cost: 'parts cost', assignee_id: 'assignee',
};

export default {
  title: 'Work Order',
  async render({ el, params, app }) {
    const load = async () => {
      const d = await api(`/workorders/${params.id}`);
      draw(d);
    };

    let current = null;

    const draw = (d) => {
      current = d;
      const w = d.workOrder;
      app.setTitle(w.number);
      const active = ['open', 'assigned', 'in_progress', 'on_hold'].includes(w.status);
      const safety = [];
      if (w.flags.ligatureRisk) safety.push('Ligature / self-harm risk reported — keep the area monitored or restricted until repaired.');
      if (w.flags.areaOutOfService) safety.push('This room/area is out of service.');
      if (w.flags.escortRequired) safety.push('Staff escort required on the unit.');
      if (w.flags.patientArea) safety.push('Patient-care area — account for all tools, hardware, and debris before leaving.');

      mount(
        el,
        html`<div class="print-only"><strong>${app.meta.facility.name}</strong> — ${app.meta.facility.street}, ${app.meta.facility.city}, ${app.meta.facility.state} ${app.meta.facility.zip}<hr /></div>
        <div class="wo-head">
          <div>
            <div class="num">${w.number} · ${titleCase(w.type)}</div>
            <h1>${w.title}</h1>
            <div class="chips">${statusBadge(w.status)}${priorityBadge(w.priority)}${flagChips(w.flags)}
              ${w.overdue ? html`<span class="badge flag">${icon('clock', 'icon-sm')}Overdue</span>` : ''}</div>
          </div>
          <div class="actions no-print">
            ${actionButtons(d, w.status).map((b) => html`<button class="btn ${b.kind ? `btn-${b.kind}` : ''}" data-to="${b.to}">${icon(b.ic)}${b.label}</button>`)}
            ${d.abilities.assign && active ? html`<button class="btn" id="assign">${icon('user')}${w.assignee ? 'Reassign' : 'Assign'}</button>` : ''}
            ${d.abilities.edit ? html`<a class="btn" href="#/workorders/${w.id}/edit">${icon('edit')}Edit</a>` : ''}
            <button class="btn btn-ghost btn-icon" id="print" title="Print">${icon('printer')}</button>
            ${d.abilities.delete ? html`<button class="btn btn-ghost btn-icon" id="del" title="Delete">${icon('trash')}</button>` : ''}
          </div>
        </div>

        ${safety.length && active ? html`<div class="safety-bar">${icon('alert')}<div><strong>Safety precautions</strong><ul>${safety.map((s) => html`<li>${s}</li>`)}</ul></div></div>` : ''}

        <div class="split">
          <div class="stack">
            <div class="card"><div class="card-head"><h2>Description</h2></div><div class="card-body"><div class="desc">${w.description}</div></div></div>

            ${w.resolution
              ? html`<div class="card"><div class="card-head"><h2>Resolution</h2>${w.completedAt ? html`<span class="small muted">${fmtDateTime(w.completedAt)}</span>` : ''}</div>
                  <div class="card-body"><div class="desc">${w.resolution}</div>
                  ${w.toolsAccounted ? html`<div class="notice success">${icon('shield')}<div>Tool control confirmed by <strong>${w.toolsAccounted.by}</strong> · ${fmtDateTime(w.toolsAccounted.at)}</div></div>` : ''}</div></div>`
              : ''}

            <div class="card">
              <div class="card-head"><h2>${icon('message')} Comments <span class="badge">${d.comments.length}</span></h2></div>
              <div>${d.comments.length
                ? d.comments.map(
                    (c) => html`<div class="comment ${c.internal ? 'internal' : ''}">${avatar(c.user, 32)}
                      <div class="body"><div class="who"><strong>${c.user.name}</strong> <span class="faint small">${fmtDateTime(c.createdAt)}</span>
                        ${c.internal ? html` <span class="badge flag-warn">Internal</span>` : ''}</div><div class="desc">${c.body}</div></div></div>`
                  )
                : emptyState('No comments yet.', 'message')}</div>
              <form class="comment-form" id="comment-form">
                <div class="field"><label class="sr-only" for="c-body">Add a comment</label>
                  <textarea id="c-body" name="body" maxlength="4000" placeholder="Add an update or question… (no patient information)"></textarea></div>
                <div class="actions">
                  <button class="btn btn-primary btn-sm" type="submit">Post comment</button>
                  ${d.abilities.internalNotes ? html`<label class="check small"><input type="checkbox" name="internal" />Internal note (maintenance staff only)</label>` : ''}
                </div>
              </form>
            </div>

            <div class="card">
              <div class="card-head"><h2>${icon('clip')} Photos & files <span class="badge">${d.attachments.length}</span></h2>
                <label class="btn btn-sm no-print">${icon('upload', 'icon-sm')}Add file<input type="file" id="att-input" class="sr-only" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" /></label></div>
              ${d.attachments.length
                ? html`<div class="attachments">${d.attachments.map(
                    (a) => html`<div class="att">
                      <a href="${a.url || '#'}" target="_blank" rel="noopener" title="${a.name}">
                        ${a.mime.startsWith('image/') && a.url ? html`<img src="${a.url}" alt="${a.name}" loading="lazy" />` : html`<div class="pdf">${a.mime === 'application/pdf' ? 'PDF' : 'FILE'}</div>`}</a>
                      <div class="cap">${a.name}<br /><span class="faint">${fileSize(a.size)} · ${a.user}</span></div>
                      <button class="btn btn-sm btn-icon del no-print" data-del-att="${a.id}" title="Remove">${icon('trash', 'icon-sm')}</button>
                    </div>`
                  )}</div>`
                : emptyState('No files attached.', 'camera')}
            </div>
          </div>

          <div class="stack">
            <div class="card"><div class="card-head"><h2>Details</h2></div><div class="card-body">
              <dl class="dl">
                <dt>Location</dt><dd>${w.location ? html`${w.location.building}${w.location.unit ? ` · ${w.location.unit}` : ''}<br /><strong>${w.location.name}</strong>` : '—'}${w.locationDetail ? html`<br />${w.locationDetail}` : ''}</dd>
                <dt>Category</dt><dd>${w.category ? w.category.name : '—'}</dd>
                <dt>Asset tag</dt><dd>${w.assetTag || '—'}</dd>
                <dt>Assigned to</dt><dd>${person(w.assignee)}</dd>
                <dt>Requested by</dt><dd>${w.requester.name}<br /><span class="small muted">${w.requester.email}</span></dd>
                <dt>Contact</dt><dd>${w.contactPhone || '—'}</dd>
                <dt>Submitted</dt><dd>${fmtDateTime(w.createdAt)}</dd>
                <dt>Due</dt><dd class="${w.overdue ? 'overdue' : ''}">${fmtDateTime(w.dueAt)}${active && w.dueAt ? html`<br /><span class="small">${relTime(w.dueAt)}</span>` : ''}</dd>
                <dt>Started</dt><dd>${fmtDateTime(w.startedAt)}</dd>
                <dt>Completed</dt><dd>${fmtDateTime(w.completedAt)}</dd>
                ${w.closedAt ? html`<dt>Closed</dt><dd>${fmtDateTime(w.closedAt)}</dd>` : ''}
                <dt>Labor</dt><dd>${w.laborHours !== null ? `${num(w.laborHours, 2)} hrs` : '—'}</dd>
                <dt>Parts</dt><dd>${money(w.partsCost)}</dd>
              </dl>
            </div></div>

            <div class="card"><div class="card-head"><h2>History</h2></div><div class="card-body">
              <ul class="timeline">${d.history.map(
                (h) => html`<li><div><strong>${h.user || 'System'}</strong> ${(HISTORY_LABEL[h.action] || titleCase(h.action)).toLowerCase()}
                  ${h.field && h.action !== 'assigned' ? html` <span class="muted">${FIELD_LABEL[h.field] || h.field}</span>` : ''}
                  ${h.action === 'status' ? html` ${statusBadge(h.oldValue)} → ${statusBadge(h.newValue)}` : ''}
                  ${h.action === 'attachment' ? html` <span class="muted">${h.newValue}</span>` : ''}</div>
                  ${h.note ? html`<div class="small">“${h.note}”</div>` : ''}
                  <div class="when">${fmtDateTime(h.at)}</div></li>`
              )}</ul>
            </div></div>
          </div>
        </div>`
      );
      wire(d);
    };

    const wire = (d) => {
      const w = d.workOrder;

      $('#print', el).addEventListener('click', () => window.print());

      const assignBtn = $('#assign', el);
      if (assignBtn) {
        assignBtn.addEventListener('click', async () => {
          const people = await api('/users/assignable');
          modal({
            title: `Assign ${w.number}`,
            body: html`<form id="as-form"><div class="field"><label for="as-u">Technician</label>
              <select id="as-u" name="assigneeId">${options(people, w.assignee ? w.assignee.id : '', { valueKey: 'id', labelKey: 'name', blank: '— Unassigned —' })}</select></div></form>`,
            actions: [
              { label: 'Cancel', close: true },
              {
                label: 'Save',
                kind: 'primary',
                onClick: async ({ el: m, close }) => {
                  try {
                    const v = formValues($('#as-form', m));
                    await api(`/workorders/${w.id}/assign`, { method: 'POST', body: { assigneeId: v.assigneeId || null } });
                    close();
                    toast('Assignment updated.', 'success');
                    load();
                  } catch (e) {
                    toastError(e);
                  }
                },
              },
            ],
          });
        });
      }

      const del = $('#del', el);
      if (del) {
        del.addEventListener('click', async () => {
          if (!(await confirmDialog(`Delete ${w.number}? It will be hidden from all lists (kept in the audit log).`, { danger: true, okLabel: 'Delete' }))) return;
          try {
            await api(`/workorders/${w.id}`, { method: 'DELETE' });
            toast('Work order deleted.', 'success');
            app.navigate('/workorders');
          } catch (err) {
            toastError(err);
          }
        });
      }

      $('#comment-form', el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = formValues(e.target);
        if (!v.body) return;
        await busy($('button[type=submit]', e.target), async () => {
          try {
            await api(`/workorders/${w.id}/comments`, { method: 'POST', body: v });
            load();
          } catch (err) {
            toastError(err);
          }
        });
      });

      $('#att-input', el).addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        try {
          await api(`/workorders/${w.id}/attachments`, { method: 'POST', form: fd });
          toast('File attached.', 'success');
          load();
        } catch (err) {
          toastError(err);
        }
      });

    };

    /** Status change; some transitions collect extra information first. */
    const transition = (w, to) => {
      const send = async (body, close) => {
        try {
          await api(`/workorders/${w.id}/status`, { method: 'POST', body: { status: to, ...body } });
          if (close) close();
          toast('Status updated.', 'success');
          load();
        } catch (e) {
          toastError(e);
        }
      };

      if (to === 'completed') {
        const toolControl = w.flags.patientArea || w.flags.ligatureRisk;
        return modal({
          title: `Complete ${w.number}`,
          body: html`<form id="cm-form">
            <div class="field"><label class="req" for="cm-r">What was done?</label><textarea id="cm-r" name="resolution" maxlength="5000" required placeholder="Work performed, parts replaced, follow-up needed…"></textarea></div>
            <div class="form-grid">
              <div class="field"><label for="cm-l">Labor hours</label><input id="cm-l" name="laborHours" type="number" step="0.25" min="0" value="${w.laborHours ?? ''}" /></div>
              <div class="field"><label for="cm-p">Parts cost ($)</label><input id="cm-p" name="partsCost" type="number" step="0.01" min="0" value="${w.partsCost ?? ''}" /></div>
            </div>
            ${toolControl
              ? html`<div class="notice warn">${icon('shield')}<div><strong>Tool control required.</strong> This work was in a patient-care area${w.flags.ligatureRisk ? ' and involved a ligature risk' : ''}.</div></div>
                <label class="check"><input type="checkbox" name="toolsAccountedFor" />
                  <span><strong>I confirm all tools, hardware, fasteners, and debris were accounted for and removed from the area.</strong></span></label>`
              : ''}
            ${w.flags.areaOutOfService
              ? html`<label class="check"><input type="checkbox" name="areaReturnedToService" checked />
                  <span><strong>Return the area to service</strong><span class="help">Clears the out-of-service flag. Notify the charge nurse.</span></span></label>`
              : ''}
          </form>`,
          actions: [
            { label: 'Cancel', close: true },
            {
              label: 'Mark complete',
              kind: 'success',
              onClick: async ({ el: m, close }) => {
                const v = formValues($('#cm-form', m));
                if (!v.resolution) return toast('Describe the work that was done.', 'error');
                if (toolControl && !v.toolsAccountedFor) return toast('Confirm tool control before completing.', 'error');
                await send(v, close);
              },
            },
          ],
        });
      }

      if (to === 'on_hold' || to === 'cancelled') {
        return modal({
          title: to === 'on_hold' ? 'Put on hold' : 'Cancel request',
          body: html`<form id="nt-form"><div class="field"><label class="req" for="nt">${to === 'on_hold' ? 'Reason (e.g. waiting on parts, unit unavailable)' : 'Reason for cancelling'}</label>
            <textarea id="nt" name="note" maxlength="2000" required></textarea></div></form>`,
          actions: [
            { label: 'Back', close: true },
            {
              label: to === 'on_hold' ? 'Put on hold' : 'Cancel request',
              kind: to === 'cancelled' ? 'danger' : 'primary',
              onClick: async ({ el: m, close }) => {
                const v = formValues($('#nt-form', m));
                if (!v.note) return toast('A reason is required.', 'error');
                await send(v, close);
              },
            },
          ],
        });
      }

      if (to === 'closed') {
        return confirmDialog(`Close ${w.number}? Closing confirms the work was verified.`, { okLabel: 'Close work order' }).then((ok) => ok && send({}));
      }
      return send({});
    };

    // Delegated handlers are registered once (the page container is fresh per navigation).
    on(el, 'click', '[data-to]', (e, b) => current && transition(current.workOrder, b.dataset.to));
    on(el, 'click', '[data-del-att]', async (e, b) => {
      if (!current) return;
      if (!(await confirmDialog('Remove this file?', { danger: true, okLabel: 'Remove' }))) return;
      try {
        await api(`/workorders/${current.workOrder.id}/attachments/${b.dataset.delAtt}`, { method: 'DELETE' });
        load();
      } catch (err) {
        toastError(err);
      }
    });

    await load();
  },
};

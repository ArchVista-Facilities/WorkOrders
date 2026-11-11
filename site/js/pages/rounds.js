/**
 * Rounds & Inspections: start a new round from a form template and browse
 * past rounds (drafts and submitted). Owner-only; the database enforces it.
 */
import { api } from '../api.js';
import { html, mount, icon, $, on, toastError, fmtDate, emptyState, busy } from '../ui.js';

const statusChip = (s) =>
  s === 'submitted' ? html`<span class="badge st-completed">Submitted</span>` : html`<span class="badge st-on_hold">Draft</span>`;

export default {
  title: 'Rounds & Inspections',
  async render({ el, query, app }) {
    const filter = query.status || '';
    const [templates, rounds] = await Promise.all([api('/rounds/templates'), api(`/rounds${filter ? `?status=${filter}` : ''}`)]);

    const month = new Date().toISOString().slice(0, 7);
    const all = filter ? await api('/rounds') : rounds;
    const thisMonth = all.filter((r) => (r.date || '').startsWith(month));
    const drafts = all.filter((r) => r.status === 'draft').length;
    const findings = thisMonth.reduce((s, r) => s + (r.findings || 0), 0);

    mount(
      el,
      html`<div class="page-head">
        <div><h1>Rounds & Inspections</h1><div class="sub">Fill out rounds on your phone or computer. Answers save as you go; add photos and notes to any item.</div></div>
        <div class="actions">${templates.map(
          (t, i) => html`<button class="btn ${i === 0 ? 'btn-primary btn-lg' : ''}" data-start="${t.id}">${icon('plus')}Start ${t.name}</button>`
        )}</div>
      </div>

      <div class="kpis">
        <div class="kpi"><div class="label">${icon('checklist', 'icon-sm')}Rounds this month</div><div class="value">${thisMonth.length}</div></div>
        <a class="kpi ${drafts ? 'warn' : ''}" href="#/rounds?status=draft"><div class="label">${icon('edit', 'icon-sm')}Drafts in progress</div><div class="value">${drafts}</div></a>
        <div class="kpi ${findings ? 'alert' : 'good'}"><div class="label">${icon('alert', 'icon-sm')}Findings this month</div><div class="value">${findings}</div></div>
      </div>

      <div class="card">
        <div class="filters">
          <select id="f-status" aria-label="Status">
            <option value="" ${filter === '' ? 'selected' : ''}>All rounds</option>
            <option value="draft" ${filter === 'draft' ? 'selected' : ''}>Drafts</option>
            <option value="submitted" ${filter === 'submitted' ? 'selected' : ''}>Submitted</option>
          </select>
        </div>
        ${rounds.length
          ? html`<div class="table-wrap"><table class="table responsive">
              <thead><tr><th>Date</th><th>Form</th><th>Unit</th><th>Shift</th><th>Conducted by</th><th>Findings</th><th>Photos</th><th>Status</th></tr></thead>
              <tbody>${rounds.map(
                (r) => html`<tr class="clickable" data-href="/rounds/${r.id}">
                  <td data-label="Date" class="nowrap">${fmtDate(r.date ? `${r.date}T12:00:00` : r.createdAt)}</td>
                  <td class="title-cell"><strong>${r.name}</strong></td>
                  <td data-label="Unit">${r.location ? r.location.name : '—'}</td>
                  <td data-label="Shift">${r.header.shift || '—'}</td>
                  <td data-label="Conducted by">${r.header.conductedBy || '—'}</td>
                  <td data-label="Findings">${r.findings ? html`<span class="badge flag">${r.findings}</span>` : html`<span class="muted">0</span>`}</td>
                  <td data-label="Photos">${r.photoCount || 0}</td>
                  <td data-label="Status">${statusChip(r.status)}</td>
                </tr>`
              )}</tbody></table></div>`
          : emptyState(templates.length ? 'No rounds yet. Start one with the button above.' : 'No forms are set up yet.', 'checklist')}
      </div>`
    );

    $('#f-status', el).addEventListener('change', (e) => app.navigate(`/rounds${e.target.value ? `?status=${e.target.value}` : ''}`));
    return on(el, 'click', '[data-start]', async (e, b) => {
      await busy(b, async () => {
        try {
          const { id } = await api('/rounds', { method: 'POST', body: { templateId: Number(b.dataset.start) } });
          app.navigate(`/rounds/${id}`);
        } catch (err) {
          toastError(err);
        }
      });
    });
  },
};

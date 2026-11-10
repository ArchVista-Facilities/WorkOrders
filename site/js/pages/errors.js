/**
 * Error logs: triage server/browser errors and user problem reports.
 */
import { api, qs } from '../api.js';
import { html, mount, icon, $, on, modal, options, pager, download, toast, toastError, formValues, confirmDialog, statusBadge, relTime, fmtDateTime, emptyState } from '../ui.js';

const SOURCES = [
  { value: 'server', label: 'Server' },
  { value: 'client', label: 'Browser' },
  { value: 'user_report', label: 'User report' },
  { value: 'process', label: 'Process' },
];
const STATUSES = [
  { value: 'unresolved', label: 'Unresolved' },
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'ignored', label: 'Ignored' },
];
const SRC_BADGE = { server: 'flag', client: 'flag-warn', user_report: 'flag-info', process: 'flag' };

export default {
  title: 'Error Logs',
  async render({ el, query, app }) {
    const manage = app.can('errors.manage');
    const f = { status: 'unresolved', ...query };

    const drawStats = async () => {
      const s = await api('/errors/stats');
      mount(
        $('#err-stats', el),
        html`<div class="kpis">
          <div class="kpi ${s.unresolved ? 'alert' : 'good'}"><div class="label">${icon('alert', 'icon-sm')}Unresolved</div><div class="value">${s.unresolved}</div></div>
          <div class="kpi ${s.openUserReports ? 'warn' : ''}"><div class="label">${icon('message', 'icon-sm')}Open user reports</div><div class="value">${s.openUserReports}</div></div>
          <div class="kpi"><div class="label">${icon('clock', 'icon-sm')}Events (24h)</div><div class="value">${s.last24h}</div></div>
          ${s.bySource.map((b) => html`<div class="kpi"><div class="label">${SOURCES.find((x) => x.value === b.label)?.label || b.label} (30d)</div><div class="value">${b.total}</div><div class="hint">${b.groups} distinct</div></div>`)}
        </div>`
      );
    };

    mount(
      el,
      html`<div class="page-head">
        <div><h1>Error Logs</h1><div class="sub">Application errors are grouped by fingerprint; resolved errors that recur are re-opened automatically.</div></div>
        <div class="actions">
          <button class="btn" id="exp">${icon('download')}Export CSV</button>
          ${manage ? html`<button class="btn" id="purge">${icon('trash')}Purge old</button>` : ''}
        </div>
      </div>
      <div id="err-stats"></div>
      <div class="card">
        <form class="filters" id="filters">
          <input type="search" name="q" placeholder="Search message, route, request id, user…" value="${f.q || ''}" />
          <select name="status">${options(STATUSES, f.status)}</select>
          <select name="source">${options(SOURCES, f.source, { blank: 'Any source' })}</select>
        </form>
        <div id="results"></div>
      </div>`
    );

    const form = $('#filters', el);
    const params = () => ({ q: form.q.value.trim(), status: form.status.value, source: form.source.value });
    const load = async (page = 1) => {
      history.replaceState(null, '', `#/errors${qs({ ...params(), status: form.status.value || 'all' })}`);
      const p = { ...params(), page };
      const res = await api(`/errors${qs(p)}`);
      const box = $('#results', el);
      if (!res.items.length) return mount(box, emptyState('No errors match. 🎉', 'check'));
      mount(
        box,
        html`<div class="table-wrap"><table class="table responsive">
          <thead><tr><th>Message</th><th>Source</th><th>Count</th><th>Last seen</th><th>Status</th></tr></thead>
          <tbody>${res.items.map(
            (e) => html`<tr class="clickable" data-err="${e.id}">
              <td class="title-cell"><strong>${e.message}</strong><span class="small">${e.method || ''} ${e.route || ''}${e.userEmail ? ` · ${e.userEmail}` : ''}</span></td>
              <td data-label="Source"><span class="badge ${SRC_BADGE[e.source] || ''}">${SOURCES.find((x) => x.value === e.source)?.label || e.source}</span></td>
              <td data-label="Count">${e.occurrences}</td>
              <td data-label="Last seen" class="small nowrap" title="${fmtDateTime(e.lastSeenAt)}">${relTime(e.lastSeenAt)}</td>
              <td data-label="Status">${statusBadge(e.status)}</td>
            </tr>`
          )}</tbody></table></div>${pager(res)}`
      );
    };

    const openDetail = async (id) => {
      const e = await api(`/errors/${id}`);
      const m = modal({
        title: `Error #${e.id}`,
        wide: true,
        body: html`<div class="chips">${statusBadge(e.status)}<span class="badge ${SRC_BADGE[e.source] || ''}">${e.source}</span><span class="badge">${e.level}</span>${e.statusCode ? html`<span class="badge">HTTP ${e.statusCode}</span>` : ''}</div><br />
          <p><strong>${e.message}</strong></p>
          <dl class="dl">
            <dt>Occurrences</dt><dd>${e.occurrences}</dd>
            <dt>First / last seen</dt><dd>${fmtDateTime(e.firstSeenAt)} → ${fmtDateTime(e.lastSeenAt)}</dd>
            <dt>Route</dt><dd>${e.method || ''} ${e.route || '—'}</dd>
            <dt>User</dt><dd>${e.userEmail || '—'}</dd>
            <dt>Request ID</dt><dd><code>${e.requestId || '—'}</code></dd>
            <dt>Browser</dt><dd class="small">${e.userAgent || '—'}</dd>
            ${e.resolvedAt ? html`<dt>Resolved</dt><dd>${fmtDateTime(e.resolvedAt)} by ${e.resolvedBy || '—'}</dd>` : ''}
          </dl>
          ${e.context ? html`<h3>Context</h3><pre>${JSON.stringify(e.context, null, 2)}</pre>` : ''}
          ${e.stack ? html`<h3>Stack trace</h3><pre>${e.stack}</pre>` : ''}
          ${e.resolutionNotes ? html`<h3>Notes</h3><pre>${e.resolutionNotes}</pre>` : ''}
          ${manage
            ? html`<form id="tri-form"><div class="form-grid">
                <div class="field"><label>Status</label><select name="status">${options(STATUSES.filter((s) => s.value && s.value !== 'unresolved'), e.status)}</select></div>
                <div class="field full"><label>Notes</label><textarea name="notes" maxlength="4000" placeholder="Root cause, fix, ticket link…"></textarea></div>
              </div></form>`
            : ''}`,
        actions: manage
          ? [
              { label: 'Close', close: true },
              {
                label: 'Save',
                kind: 'primary',
                onClick: async ({ el: mm, close }) => {
                  try {
                    await api(`/errors/${e.id}`, { method: 'PUT', body: formValues($('#tri-form', mm)) });
                    close();
                    toast('Updated.', 'success');
                    load();
                    drawStats();
                  } catch (err) {
                    toastError(err);
                  }
                },
              },
            ]
          : [{ label: 'Close', close: true }],
      });
      return m;
    };

    let t;
    form.addEventListener('input', () => (clearTimeout(t), (t = setTimeout(() => load(1), 250))));
    form.addEventListener('submit', (e) => (e.preventDefault(), load(1)));
    on(el, 'click', '[data-page]', (e, b) => load(Number(b.dataset.page)));
    on(el, 'click', '[data-err]', (e, r) => openDetail(r.dataset.err).catch(toastError));
    $('#exp', el).addEventListener('click', () => download(`/errors/export.csv${qs(params())}`));
    const purge = $('#purge', el);
    if (purge) {
      purge.addEventListener('click', async () => {
        if (!(await confirmDialog('Permanently delete resolved and ignored errors not seen in the last 180 days?', { danger: true, okLabel: 'Purge' }))) return;
        try {
          const r = await api('/errors/purge', { method: 'POST', body: { days: 180 } });
          toast(`Deleted ${r.deleted} entr${r.deleted === 1 ? 'y' : 'ies'}.`, 'success');
          load();
          drawStats();
        } catch (err) {
          toastError(err);
        }
      });
    }

    if (f.status === 'all') form.status.value = '';
    await Promise.all([drawStats(), load(Number(f.page) || 1)]);
  },
};

/**
 * Dashboard: KPIs scoped to the user's visibility, items needing attention,
 * the user's own queue, and their recent requests.
 */
import { api } from '../api.js';
import { html, mount, icon, statusBadge, priorityBadge, flagChips, person, relTime, fmtDateTime, emptyState } from '../ui.js';
import { summarize, openThisPeriod } from '../compliance-calc.js';

/** Compact work-order table used by several panels. */
export function woTable(items, { showAssignee = true } = {}) {
  if (!items.length) return emptyState('Nothing here right now.', 'check');
  return html`<div class="table-wrap"><table class="table responsive">
    <thead><tr><th>Number</th><th>Request</th><th>Priority</th><th>Status</th>${showAssignee ? html`<th>Assigned</th>` : ''}<th>Due</th></tr></thead>
    <tbody>${items.map(
      (w) => html`<tr class="clickable" data-href="/workorders/${w.id}">
        <td class="num" data-label="Number">${w.number}</td>
        <td class="title-cell"><strong>${w.title}</strong><span class="small">${w.location ? `${w.location.name}${w.locationDetail ? ` · ${w.locationDetail}` : ''}` : ''}</span>
          <div class="chips">${flagChips(w.flags, { compact: true })}</div></td>
        <td data-label="Priority">${priorityBadge(w.priority)}</td>
        <td data-label="Status">${statusBadge(w.status)}</td>
        ${showAssignee ? html`<td data-label="Assigned">${person(w.assignee)}</td>` : ''}
        <td data-label="Due" class="nowrap ${w.overdue ? 'overdue' : ''}" title="${fmtDateTime(w.dueAt)}">${['completed', 'closed', 'cancelled'].includes(w.status) ? '—' : relTime(w.dueAt)}</td>
      </tr>`
    )}</tbody></table></div>`;
}

export default {
  title: 'Dashboard',
  async render({ el, app }) {
    const owner = app.can('compliance.manage');
    const [d, comp, drafts] = await Promise.all([
      api('/workorders/dashboard'),
      owner ? api('/compliance').catch(() => null) : null,
      app.can('rounds.manage') ? api('/rounds?status=draft').catch(() => []) : [],
    ]);
    let ownerCard = '';
    if (comp) {
      const byTask = new Map();
      comp.entries.forEach((e) => (byTask.get(e.task_id) || byTask.set(e.task_id, []).get(e.task_id)).push(e));
      const active = comp.tasks.filter((t) => t.is_active && t.cadence !== 'misc');
      const sum = summarize(active, byTask, new Date().getFullYear());
      const due = active.filter((t) => openThisPeriod(t, byTask.get(t.id) || []));
      const tone = sum.overall >= 0.9 ? 'good' : sum.overall >= 0.7 ? 'warn' : 'alert';
      ownerCard = html`<div class="grid grid-2 owner-row">
        <div class="card"><div class="card-head"><h2>${icon('calendar')}Compliance</h2><a class="small" href="#/compliance">Open tracker</a></div>
          <div class="card-body"><div class="kpi ${tone}"><div class="label">Weighted YTD compliance</div><div class="value">${(sum.overall * 100).toFixed(1)}%</div>
            <div class="hint">${due.length} task${due.length === 1 ? '' : 's'} not yet done this period</div></div>
            ${due.length ? html`<ul class="due-list compact">${due.slice(0, 6).map((t) => html`<li><span>${t.name}</span></li>`)}${due.length > 6 ? html`<li><a href="#/compliance">+${due.length - 6} more</a></li>` : ''}</ul>` : ''}</div></div>
        <div class="card"><div class="card-head"><h2>${icon('checklist')}Rounds</h2><a class="small" href="#/rounds">All rounds</a></div>
          <div class="card-body">${drafts.length
            ? html`<p>${drafts.length} draft round${drafts.length === 1 ? '' : 's'} in progress.</p><ul class="due-list compact">${drafts.slice(0, 5).map((r) => html`<li><a href="#/rounds/${r.id}">${r.name}</a><span class="small muted">${r.date || ''}</span></li>`)}</ul>`
            : html`<p class="muted">No rounds in progress.</p>`}
            <a class="btn btn-primary" href="#/rounds">${icon('plus')}Start a round</a></div></div>
      </div><br />`;
    }
    const c = d.counts;
    const u = app.meta.user;
    const staffView = app.can('workorders.view_all');
    const worker = app.can('workorders.work');
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(new Date()));
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    const kpi = (label, value, href, cls = '', ic = 'clipboard') =>
      html`<a class="kpi ${value > 0 ? cls : ''}" href="#${href}"><div class="label">${icon(ic, 'icon-sm')}${label}</div><div class="value">${value}</div></a>`;

    mount(
      el,
      html`<div class="page-head">
        <div><h1>${greet}, ${u.preferredName || u.firstName}.</h1><div class="sub">${app.meta.facility.name} · ${new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago' }).format(new Date())}</div></div>
        <div class="actions">${app.can('workorders.create') ? html`<a class="btn btn-primary btn-lg" href="#/workorders/new">${icon('plus')}New request</a>` : ''}</div>
      </div>

      ${staffView
        ? html`<div class="kpis">
            ${kpi('Open work orders', c.open, '/workorders?status=active', '', 'clipboard')}
            ${kpi('Unassigned', c.unassigned, '/workorders?status=active&assignee=unassigned', 'warn', 'user')}
            ${kpi('Overdue', c.overdue, '/workorders?overdue=1', 'alert', 'clock')}
            ${kpi('Emergency / urgent', c.emergency, '/workorders?status=active&sort=priority', 'alert', 'alert')}
            ${kpi('Ligature risks open', c.ligature, '/workorders?status=active&flag=ligature', 'alert', 'shield')}
            ${kpi('Areas out of service', c.outOfService, '/workorders?status=active&flag=oos', 'warn', 'lock')}
            ${kpi('Completed (30 days)', c.completed30, '/workorders?status=inactive', 'good', 'check')}
          </div>`
        : ''}

      ${ownerCard}

      ${staffView && d.critical.length
        ? html`<div class="card" id="critical"><div class="card-head"><h2>Needs attention</h2><a class="small" href="#/workorders?status=active&sort=priority">View all</a></div>
            <div class="card-body tight">${woTable(d.critical)}</div></div><br />`
        : ''}

      <div class="stack">
        ${worker
          ? html`<div class="card"><div class="card-head"><h2>My assigned work <span class="badge">${c.mine}</span></h2><a class="small" href="#/workorders?assignee=me&status=active">Open queue</a></div>
              <div class="card-body tight">${woTable(d.myQueue, { showAssignee: false })}</div></div>`
          : ''}
        <div class="card"><div class="card-head"><h2>My recent requests</h2><a class="small" href="#/workorders?requester=me&status=all">All my requests</a></div>
          <div class="card-body tight">${d.myRequests.length ? woTable(d.myRequests) : emptyState(html`You haven't submitted any requests yet.${app.can('workorders.create') ? html` <a href="#/workorders/new">Submit one</a>.` : ''}`)}</div></div>
      </div>`
    );
  },
};

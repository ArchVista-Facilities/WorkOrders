/**
 * Work order list with filters (persisted in the URL so views are bookmarkable
 * and shareable), sorting, pagination, and CSV export.
 */
import { api, qs } from '../api.js';
import { html, mount, icon, $, on, options, pager, download, statusBadge, priorityBadge, flagChips, person, relTime, fmtDateTime, emptyState } from '../ui.js';

const STATUS_FILTERS = [
  { value: 'active', label: 'Active (all open states)' },
  { value: 'all', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'completed', label: 'Completed' },
  { value: 'closed', label: 'Closed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'inactive', label: 'Completed / closed / cancelled' },
];
const SORTS = [
  { value: 'priority', label: 'Sort: Priority' },
  { value: 'due', label: 'Sort: Due date' },
  { value: 'newest', label: 'Sort: Newest' },
  { value: 'oldest', label: 'Sort: Oldest' },
  { value: 'updated', label: 'Sort: Recently updated' },
];
const FLAGS = [
  { value: 'ligature', label: 'Ligature risk' },
  { value: 'patient', label: 'Patient area' },
  { value: 'oos', label: 'Out of service' },
];

export default {
  title: 'Work Orders',
  async render({ el, query, app }) {
    const [lookups, assignable] = await Promise.all([
      api('/settings/lookups'),
      app.can('workorders.assign') ? api('/users/assignable') : Promise.resolve([]),
    ]);
    const f = { status: 'active', sort: 'priority', page: '1', ...query };
    const seeAll = app.can('workorders.view_all');

    const locOpts = lookups.locations.map((l) => ({ value: l.id, label: `${l.building} — ${l.name}` }));
    const assigneeOpts = [{ value: 'me', label: 'Assigned to me' }, { value: 'unassigned', label: 'Unassigned' }, ...assignable.map((u) => ({ value: u.id, label: u.name }))];

    mount(
      el,
      html`<div class="page-head">
        <div><h1>Work Orders</h1><div class="sub">${seeAll ? 'All facility work orders' : 'Requests you submitted or are assigned to'}</div></div>
        <div class="actions">
          ${app.canAny('reports.view', 'workorders.view_all') ? html`<button class="btn" id="export">${icon('download')}Export CSV</button>` : ''}
          ${app.can('workorders.create') ? html`<a class="btn btn-primary" href="#/workorders/new">${icon('plus')}New request</a>` : ''}
        </div>
      </div>
      <div class="card">
        <form class="filters" id="filters">
          <input type="search" name="q" placeholder="Search number, title, room, asset…" value="${f.q || ''}" aria-label="Search" />
          <select name="status" aria-label="Status">${options(STATUS_FILTERS, f.status)}</select>
          <select name="priority" aria-label="Priority">${options(lookups.priorities, f.priority, { valueKey: 'key', labelKey: 'label', blank: 'Any priority' })}</select>
          <select name="categoryId" aria-label="Category">${options(lookups.categories, f.categoryId, { valueKey: 'id', labelKey: 'name', blank: 'Any category' })}</select>
          <select name="locationId" aria-label="Location">${options(locOpts, f.locationId, { blank: 'Any location' })}</select>
          ${seeAll || app.can('workorders.work') ? html`<select name="assignee" aria-label="Assignee">${options(app.can('workorders.assign') ? assigneeOpts : assigneeOpts.slice(0, 2), f.assignee, { blank: 'Anyone' })}</select>` : ''}
          <select name="flag" aria-label="Safety flag">${options(FLAGS, f.flag, { blank: 'Any flag' })}</select>
          <select name="sort" aria-label="Sort">${options(SORTS, f.sort)}</select>
          <label class="check small"><input type="checkbox" name="overdue" ${f.overdue === '1' ? 'checked' : ''} />Overdue only</label>
          <button class="btn btn-sm btn-ghost" type="button" id="reset">Reset</button>
        </form>
        <div id="results"></div>
      </div>`
    );

    const filtersForm = $('#filters', el);
    const current = () => {
      const fd = new FormData(filtersForm);
      const o = Object.fromEntries([...fd.entries()].filter(([, v]) => v !== ''));
      o.overdue = filtersForm.overdue.checked ? '1' : '';
      return o;
    };
    const apiParams = (o) => ({ ...o, status: o.status === 'all' ? '' : o.status });

    const load = async (page = 1) => {
      const o = { ...current(), page };
      history.replaceState(null, '', `#/workorders${qs(o)}`);
      const res = await api(`/workorders${qs(apiParams(o))}`);
      const box = $('#results', el);
      if (!res.items.length) return mount(box, emptyState('No work orders match these filters.'));
      mount(
        box,
        html`<div class="table-wrap"><table class="table responsive">
          <thead><tr><th>Number</th><th>Request</th><th>Priority</th><th>Status</th><th>Assigned</th><th>Due</th><th>Submitted</th></tr></thead>
          <tbody>${res.items.map(
            (w) => html`<tr class="clickable" data-href="/workorders/${w.id}">
              <td class="num" data-label="Number">${w.number}</td>
              <td class="title-cell"><strong>${w.title}</strong>
                <span class="small">${w.location ? `${w.location.building} · ${w.location.name}` : ''}${w.locationDetail ? ` · ${w.locationDetail}` : ''}${w.category ? ` · ${w.category.name}` : ''}</span>
                <div class="chips">${flagChips(w.flags, { compact: true })}</div></td>
              <td data-label="Priority">${priorityBadge(w.priority)}</td>
              <td data-label="Status">${statusBadge(w.status)}</td>
              <td data-label="Assigned">${person(w.assignee)}</td>
              <td data-label="Due" class="nowrap ${w.overdue ? 'overdue' : ''}" title="${fmtDateTime(w.dueAt)}">${['completed', 'closed', 'cancelled'].includes(w.status) ? '—' : relTime(w.dueAt)}</td>
              <td data-label="Submitted" class="nowrap small muted" title="${fmtDateTime(w.createdAt)}">${relTime(w.createdAt)}<br />${w.requester.name}</td>
            </tr>`
          )}</tbody></table></div>${pager(res)}`
      );
    };

    let t = null;
    filtersForm.addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => load(1), e.target.type === 'search' ? 300 : 0);
    });
    filtersForm.addEventListener('submit', (e) => (e.preventDefault(), load(1)));
    $('#reset', el).addEventListener('click', () => {
      filtersForm.reset();
      filtersForm.q.value = '';
      filtersForm.status.value = 'active';
      filtersForm.sort.value = 'priority';
      $$reset(filtersForm);
      load(1);
    });
    on(el, 'click', '[data-page]', (e, b) => load(Number(b.dataset.page)));
    const exp = $('#export', el);
    if (exp) exp.addEventListener('click', () => download(`/workorders/export.csv${qs(apiParams(current()))}`));

    await load(Number(f.page) || 1);
  },
};

/** Clear selects that the browser's reset() restored to server-rendered selections. */
function $$reset(form) {
  form.querySelectorAll('select').forEach((s) => {
    if (!['status', 'sort'].includes(s.name)) s.value = '';
  });
  form.overdue.checked = false;
}

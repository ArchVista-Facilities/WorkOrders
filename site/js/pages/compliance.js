/**
 * Compliance Tracker: the EOC Dashboard workbook as a live page.
 * Rows are recurring tasks; month cells hold the dates each task was done.
 * All percentages come from compliance-calc.js (a faithful port of the
 * workbook formulas).
 */
import { api } from '../api.js';
import { CADENCES, summarize, openThisPeriod, cadence } from '../compliance-calc.js';
import { html, mount, icon, $, on, modal, toast, toastError, confirmDialog, formValues, options, checked, fmtDate } from '../ui.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const tone = (x) => (x >= 0.9 ? 'good' : x >= 0.7 ? 'warn' : 'alert');
const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export default {
  title: 'Compliance Tracker',
  async render({ el, query, app }) {
    let data = await api('/compliance');
    const thisYear = new Date().getFullYear();
    const year = Number(query.year) || thisYear;

    const byTask = () => {
      const m = new Map();
      data.entries.forEach((e) => (m.get(e.task_id) || m.set(e.task_id, []).get(e.task_id)).push(e));
      return m;
    };

    const draw = () => {
      const entries = byTask();
      const tasks = data.tasks.filter((t) => t.is_active);
      const sum = summarize(tasks.filter((t) => t.cadence !== 'misc'), entries, year);
      const rowOf = new Map(sum.rows.map((r) => [r.task.id, r]));
      const years = [...new Set([thisYear, year, ...data.entries.map((e) => Number(e.done_on.slice(0, 4)))])].sort((a, b) => b - a);
      const dueNow = year === thisYear ? tasks.filter((t) => t.cadence !== 'misc' && openThisPeriod(t, entries.get(t.id) || [])) : [];

      const monthCell = (t, mi) => {
        const list = (entries.get(t.id) || []).filter((e) => e.done_on.startsWith(`${year}-${String(mi + 1).padStart(2, '0')}`));
        const isDue = t.cadence === 'annual' && t.due_month === mi + 1 && !(entries.get(t.id) || []).some((e) => e.done_on.startsWith(String(year)));
        return html`<td class="mcell ${list.length ? 'has' : ''}" data-cell="${t.id}:${mi + 1}" title="${MONTHS[mi]}: click to log or edit">
          ${list.map((e) => html`<span class="dchip" title="${e.note || ''}">${md(e.done_on)}</span>`)}${isDue ? html`<span class="badge flag-warn">DUE</span>` : ''}</td>`;
      };

      const groupCard = (g) => {
        const list = tasks.filter((t) => t.cadence === g.key);
        if (!list.length) return '';
        return html`<div class="card ctrack"><div class="card-head"><h2>${g.label}</h2>
          <span class="small">${g.completed} / ${g.due} due · <strong class="pct ${tone(g.compliance)}">${pct(g.compliance)}</strong></span></div>
          <div class="table-wrap"><table class="table ctable">
            <thead><tr><th class="tname">Compliance task</th>${MONTHS.map((m) => html`<th>${m}</th>`)}<th title="Annual required">Req.</th><th title="Year-to-date due">Due</th><th title="Year-to-date completed">Done</th><th>Compliance</th></tr></thead>
            <tbody>${list.map((t) => {
              const r = rowOf.get(t.id);
              return html`<tr>
                <td class="tname"><button type="button" class="linkish" data-task="${t.id}">${t.name}</button>${t.counts_toward_compliance ? '' : html` <span class="badge" title="Tracked, but not part of the weighted compliance %">not weighted</span>`}</td>
                ${MONTHS.map((_, mi) => monthCell(t, mi))}
                <td class="n">${r.required}</td><td class="n">${r.due}</td><td class="n">${r.completed}</td>
                <td class="n"><span class="pct ${r.due ? tone(r.compliance) : ''}">${r.due ? pct(r.compliance) : '—'}</span></td>
              </tr>`;
            })}</tbody></table></div></div>`;
      };

      const misc = tasks.filter((t) => t.cadence === 'misc');
      mount(
        el,
        html`<div class="page-head">
          <div><h1>Compliance Tracker</h1><div class="sub">EOC compliance for ${year}: ${sum.monthsElapsed} month${sum.monthsElapsed === 1 ? '' : 's'} counted toward year-to-date.</div></div>
          <div class="actions">
            <select id="year" aria-label="Year">${options(years.map((y) => ({ value: y, label: y })), year)}</select>
            <button class="btn" id="export">${icon('download')}Export CSV</button>
            <button class="btn btn-primary" id="add-task">${icon('plus')}Add task</button>
          </div>
        </div>

        <div class="kpis">
          <div class="kpi ${tone(sum.overall)}"><div class="label">${icon('shield', 'icon-sm')}Weighted YTD compliance</div><div class="value">${pct(sum.overall)}</div><div class="hint">Overall</div></div>
          ${sum.groups.map((g) => html`<div class="kpi ${g.due ? tone(g.compliance) : ''}"><div class="label">${g.label}</div><div class="value">${g.due ? pct(g.compliance) : '—'}</div><div class="hint">${g.completed} of ${g.due} due</div></div>`)}
        </div>

        ${dueNow.length
          ? html`<details class="card due-card" ${dueNow.length <= 6 ? 'open' : ''}><summary class="card-head"><h2>${icon('clock')}Not yet done this period</h2><span class="small muted">${dueNow.length} task${dueNow.length === 1 ? '' : 's'} · tap to ${dueNow.length <= 6 ? 'hide' : 'show'}</span></summary>
              <ul class="due-list">${dueNow.map(
                (t) => html`<li><span><strong>${t.name}</strong> <span class="small muted">${cadence(t.cadence).label}</span></span>
                  <button class="btn btn-sm btn-success" data-quick="${t.id}">${icon('check', 'icon-sm')}Done today</button></li>`
              )}</ul></details><br />`
          : ''}

        <div class="stack">
          ${sum.groups.map(groupCard)}
          ${misc.length
            ? html`<div class="card"><div class="card-head"><h2>Misc. inspections</h2><span class="small muted">Multi-year items; not part of the weighted %</span></div>
                <div class="table-wrap"><table class="table responsive">
                  <thead><tr><th>Task</th><th>Interval</th><th>Last completed</th><th>Next due</th><th></th></tr></thead>
                  <tbody>${misc.map((t) => {
                    const last = (entries.get(t.id) || []).slice(-1)[0];
                    const overdue = t.next_due && t.next_due < localToday();
                    return html`<tr>
                      <td class="title-cell"><button type="button" class="linkish" data-task="${t.id}">${t.name}</button></td>
                      <td data-label="Interval">${t.interval_label || '—'}</td>
                      <td data-label="Last completed">${last ? fmtDate(`${last.done_on}T12:00:00`) : '—'}</td>
                      <td data-label="Next due" class="${overdue ? 'overdue' : ''}">${t.next_due ? fmtDate(`${t.next_due}T12:00:00`) : '—'}</td>
                      <td><button class="btn btn-sm" data-cell="${t.id}:0">${icon('edit', 'icon-sm')}Log / view</button></td>
                    </tr>`;
                  })}</tbody></table></div></div>`
            : ''}
          ${data.tasks.some((t) => !t.is_active) ? html`<p class="small muted">${data.tasks.filter((t) => !t.is_active).length} inactive task(s) hidden. Open a task to reactivate it.</p>` : ''}
        </div>`
      );
      el._sum = sum;
    };

    const reload = async () => {
      data = await api('/compliance');
      draw();
    };

    /** Log/view dates for one task (month 0 = whole history, used for misc). */
    const cellDialog = (taskId, month) => {
      const t = data.tasks.find((x) => x.id === taskId);
      const prefix = month ? `${year}-${String(month).padStart(2, '0')}` : '';
      const list = data.entries.filter((e) => e.task_id === taskId && e.done_on.startsWith(prefix)).sort((a, b) => b.done_on.localeCompare(a.done_on));
      const today = localToday();
      const def = !month || today.startsWith(prefix) ? today : `${prefix}-01`;
      const m = modal({
        title: `${t.name}${month ? ` · ${MONTHS[month - 1]} ${year}` : ''}`,
        body: html`<form id="log-form" class="form-grid">
            <div class="field"><label class="req" for="l-date">Date completed</label><input id="l-date" name="doneOn" type="date" value="${def}" required /></div>
            <div class="field"><label for="l-note">Note</label><input id="l-note" name="note" type="text" maxlength="500" placeholder="Optional (vendor, result, initials…)" /></div>
          </form>
          <h3 class="mt">Logged ${month ? 'this month' : ''}</h3>
          ${list.length
            ? html`<ul class="entry-list">${list.map(
                (e) => html`<li><span><strong>${fmtDate(`${e.done_on}T12:00:00`)}</strong>${e.note ? html` <span class="small muted">· ${e.note}</span>` : ''}</span>
                  <button type="button" class="btn btn-sm btn-ghost" data-del-entry="${e.id}" aria-label="Remove">${icon('trash', 'icon-sm')}</button></li>`
              )}</ul>`
            : html`<p class="small muted">Nothing logged yet.</p>`}`,
        actions: [
          { label: 'Close', close: true },
          {
            label: 'Log completion', kind: 'primary',
            onClick: async ({ close, body }) => {
              const v = formValues($('#log-form', body));
              try {
                await api('/compliance/entries', { method: 'POST', body: { taskId, doneOn: v.doneOn, note: v.note } });
                toast('Logged.', 'success');
                close();
                await reload();
              } catch (err) {
                toastError(err);
              }
            },
          },
        ],
      });
      on(m.body, 'click', '[data-del-entry]', async (e, b) => {
        if (!(await confirmDialog('Remove this logged date?', { danger: true, okLabel: 'Remove' }))) return;
        try {
          await api(`/compliance/entries/${b.dataset.delEntry}`, { method: 'DELETE' });
          b.closest('li').remove();
          await reload();
        } catch (err) {
          toastError(err);
        }
      });
    };

    const taskDialog = (taskId) => {
      const t = taskId ? data.tasks.find((x) => x.id === taskId) : { name: '', cadence: 'monthly', counts_toward_compliance: true, is_active: true, sort_order: (Math.max(0, ...data.tasks.map((x) => x.sort_order)) + 10) };
      const m = modal({
        title: taskId ? 'Edit task' : 'Add task',
        body: html`<form id="task-form">
          <div class="field"><label class="req" for="t-name">Task</label><input id="t-name" name="name" type="text" maxlength="200" value="${t.name}" required /></div>
          <div class="form-grid">
            <div class="field"><label for="t-cad">Cadence</label><select id="t-cad" name="cadence">${options(CADENCES.map((c) => ({ value: c.key, label: c.label })), t.cadence)}</select></div>
            <div class="field annual-only"><label for="t-due">DUE month (annual)</label><select id="t-due" name="dueMonth">${options(MONTHS.map((x, i) => ({ value: i + 1, label: x })), t.due_month, { blank: 'None' })}</select>
              <div class="help">Becomes due after this month, as in the workbook.</div></div>
            <div class="field misc-only"><label for="t-int">Interval</label><input id="t-int" name="intervalLabel" type="text" maxlength="60" value="${t.interval_label || ''}" placeholder="e.g. Every 36 months" /></div>
            <div class="field misc-only"><label for="t-next">Next due</label><input id="t-next" name="nextDue" type="date" value="${t.next_due || ''}" /></div>
            <div class="field"><label for="t-sort">Order</label><input id="t-sort" name="sortOrder" type="number" value="${t.sort_order}" /></div>
          </div>
          <div class="field"><label for="t-notes">Notes</label><textarea id="t-notes" name="notes" maxlength="1000" rows="2">${t.notes || ''}</textarea></div>
          <label class="check not-misc"><input type="checkbox" name="countsTowardCompliance" ${checked(t.counts_toward_compliance)} /><span><strong>Counts toward weighted compliance</strong><span class="help">Off = tracked on the page but left out of the percentages (like the dryer vent row).</span></span></label>
          <label class="check"><input type="checkbox" name="isActive" ${checked(t.is_active)} /><span><strong>Active</strong><span class="help">Inactive tasks are hidden but keep their history.</span></span></label>
        </form>`,
        actions: [
          { label: 'Cancel', close: true },
          {
            label: 'Save', kind: 'primary',
            onClick: async ({ close, body }) => {
              const v = formValues($('#task-form', body));
              try {
                await api(taskId ? `/compliance/tasks/${taskId}` : '/compliance/tasks', { method: taskId ? 'PUT' : 'POST', body: v });
                toast('Task saved.', 'success');
                close();
                await reload();
              } catch (err) {
                toastError(err);
              }
            },
          },
        ],
      });
      const sync = () => {
        const c = $('#t-cad', m.body).value;
        m.body.querySelectorAll('.annual-only').forEach((n) => n.classList.toggle('hidden', c !== 'annual'));
        m.body.querySelectorAll('.misc-only').forEach((n) => n.classList.toggle('hidden', c !== 'misc'));
        m.body.querySelectorAll('.not-misc').forEach((n) => n.classList.toggle('hidden', c === 'misc'));
      };
      $('#t-cad', m.body).addEventListener('change', sync);
      sync();
    };

    const exportCsv = () => {
      const s = el._sum;
      const entries = byTask();
      const cols = [{ label: 'Compliance Task', key: 'task' }, { label: 'Cadence', key: 'cadence' }, ...MONTHS.map((m, i) => ({ label: m, key: `m${i}` })),
        { label: 'Annual Required', key: 'req' }, { label: 'YTD Due', key: 'due' }, { label: 'YTD Completed', key: 'done' }, { label: 'Compliance', key: 'pct' }];
      const rows = s.rows.map((r) => {
        const o = { task: r.task.name, cadence: cadence(r.task.cadence).label, req: r.required, due: r.due, done: r.completed, pct: r.due ? pct(r.compliance) : '' };
        MONTHS.forEach((_, i) => {
          o[`m${i}`] = (entries.get(r.task.id) || []).filter((e) => e.done_on.startsWith(`${year}-${String(i + 1).padStart(2, '0')}`)).map((e) => md(e.done_on)).join(', ');
        });
        return o;
      });
      rows.push({});
      s.groups.forEach((g) => rows.push({ task: `${g.label} total`, req: g.required, due: g.due, done: g.completed, pct: pct(g.compliance) }));
      rows.push({ task: 'WEIGHTED YTD COMPLIANCE (Overall)', pct: pct(s.overall) });
      api('/compliance/export', { method: 'POST', body: { year, columns: cols, rows } })
        .then((f) => {
          const url = URL.createObjectURL(new Blob([f.content], { type: f.type }));
          const a = document.createElement('a');
          a.href = url;
          a.download = f.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        })
        .catch(toastError);
    };

    draw();

    const offs = [
      on(el, 'click', '[data-cell]', (e, c) => {
        const [id, month] = c.dataset.cell.split(':').map(Number);
        cellDialog(id, month);
      }),
      on(el, 'click', '[data-task]', (e, b) => taskDialog(Number(b.dataset.task))),
      on(el, 'click', '#add-task', () => taskDialog(null)),
      on(el, 'click', '#export', exportCsv),
      on(el, 'change', '#year', (e, s) => app.navigate(`/compliance?year=${s.value}`)),
      on(el, 'click', '[data-quick]', async (e, b) => {
        b.disabled = true;
        try {
          await api('/compliance/entries', { method: 'POST', body: { taskId: Number(b.dataset.quick), doneOn: localToday() } });
          toast('Logged for today.', 'success');
          await reload();
        } catch (err) {
          b.disabled = false;
          toastError(err);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  },
};

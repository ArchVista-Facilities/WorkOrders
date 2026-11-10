/**
 * Reports: KPIs, 12-month trend, breakdowns, technician workload, exports.
 */
import { api, qs } from '../api.js';
import { html, mount, raw, icon, on, download, num, money, titleCase, emptyState } from '../ui.js';

const STATUS_LABEL = { open: 'Open', assigned: 'Assigned', in_progress: 'In Progress', on_hold: 'On Hold', completed: 'Completed', closed: 'Closed', cancelled: 'Cancelled' };

/** Horizontal bars: total with the completed share overlaid. */
function bars(list, labeler = (x) => x.label) {
  if (!list.length) return emptyState('No data in this period.', 'chart');
  const max = Math.max(...list.map((x) => x.total), 1);
  return html`<div class="bars">${list.map(
    (x) => html`<div class="bar-row"><span class="lbl" title="${labeler(x)}">${labeler(x)}</span>
      <span class="bar-track"><span class="bar-fill done" data-w="${((x.completed || 0) / max) * 100}%"></span><span class="bar-fill" data-w="${((x.total - (x.completed || 0)) / max) * 100}%"></span></span>
      <span class="val">${x.total}</span></div>`
  )}</div>`;
}

/** 12-month grouped column chart as inline SVG (no chart library). */
function trendChart(trend) {
  const W = 720;
  const H = 220;
  const pad = { l: 34, r: 8, t: 10, b: 28 };
  const max = Math.max(4, ...trend.flatMap((m) => [m.created, m.completed]));
  const step = (W - pad.l - pad.r) / trend.length;
  const bw = Math.max(4, step / 2 - 4);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max];
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Work orders created and completed per month">`;
  ticks.forEach((t) => (svg += `<line class="gl" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`));
  trend.forEach((m, i) => {
    const x = pad.l + i * step + step / 2;
    const label = new Date(`${m.month}-15`).toLocaleString('en-US', { month: 'short' });
    svg += `<rect class="c-created" x="${x - bw - 1}" y="${y(m.created)}" width="${bw}" height="${H - pad.b - y(m.created)}" rx="2"><title>${m.month}: ${m.created} created</title></rect>`;
    svg += `<rect class="c-completed" x="${x + 1}" y="${y(m.completed)}" width="${bw}" height="${H - pad.b - y(m.completed)}" rx="2"><title>${m.month}: ${m.completed} completed</title></rect>`;
    svg += `<text x="${x}" y="${H - 8}" text-anchor="middle">${label}</text>`;
  });
  return raw(`${svg}</svg>`);
}

export default {
  title: 'Reports',
  async render({ el, query }) {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    let range = { from: query.from || iso(new Date(today.getTime() - 90 * 86400000)), to: query.to || iso(today) };

    const draw = async () => {
      history.replaceState(null, '', `#/reports${qs(range)}`);
      const s = await api(`/reports/summary${qs(range)}`);
      const t = s.totals;
      mount(
        el,
        html`<div class="page-head">
          <div><h1>Reports</h1><div class="sub">Work orders submitted ${range.from} through ${range.to}</div></div>
          <form class="actions no-print" id="range">
            <select name="preset" aria-label="Preset range">
              <option value="">Custom range</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
              <option value="365">Last 12 months</option><option value="ytd">Year to date</option>
            </select>
            <input type="date" name="from" value="${range.from}" aria-label="From" />
            <input type="date" name="to" value="${range.to}" aria-label="To" />
            <button class="btn" type="submit">Apply</button>
            <button class="btn" type="button" id="exp-sum">${icon('download')}Summary CSV</button>
            <button class="btn" type="button" id="exp-wo">${icon('download')}Work orders CSV</button>
            <button class="btn btn-ghost btn-icon" type="button" id="print" title="Print">${icon('printer')}</button>
          </form>
        </div>

        <div class="kpis">
          <div class="kpi"><div class="label">Submitted</div><div class="value">${num(t.created)}</div></div>
          <div class="kpi good"><div class="label">Completed</div><div class="value">${num(t.completed)}</div></div>
          <div class="kpi"><div class="label">Still open</div><div class="value">${num(t.open)}</div></div>
          <div class="kpi ${t.overdue ? 'alert' : ''}"><div class="label">Overdue now</div><div class="value">${num(t.overdue)}</div></div>
          <div class="kpi ${t.sla_pct !== null && t.sla_pct < 80 ? 'warn' : 'good'}"><div class="label">On-time completion</div><div class="value">${t.sla_pct === null ? '—' : `${t.sla_pct}%`}</div><div class="hint">Completed by due date</div></div>
          <div class="kpi"><div class="label">Avg. time to start</div><div class="value">${t.avg_response_hours === null ? '—' : `${num(t.avg_response_hours, 1)}h`}</div></div>
          <div class="kpi"><div class="label">Avg. time to complete</div><div class="value">${t.avg_hours === null ? '—' : `${num(t.avg_hours, 1)}h`}</div></div>
          <div class="kpi"><div class="label">Ligature-risk reports</div><div class="value">${num(t.ligature)}</div></div>
          <div class="kpi"><div class="label">Labor hours</div><div class="value">${num(t.labor_hours, 1)}</div></div>
          <div class="kpi"><div class="label">Parts cost</div><div class="value">${money(t.parts_cost)}</div></div>
        </div>

        <div class="card"><div class="card-head"><h2>12-month trend</h2>
          <div class="legend"><span><i class="c-created"></i>Created</span><span><i class="c-completed"></i>Completed</span></div></div>
          <div class="card-body chart">${trendChart(s.trend)}</div></div><br />

        <div class="grid grid-2">
          <div class="card"><div class="card-head"><h2>By priority</h2><div class="legend"><span><i class="c-completed"></i>Completed</span><span><i class="c-created"></i>Not completed</span></div></div><div class="card-body">${bars(s.byPriority)}</div></div>
          <div class="card"><div class="card-head"><h2>By status</h2></div><div class="card-body">${bars(s.byStatus, (x) => STATUS_LABEL[x.label] || x.label)}</div></div>
          <div class="card"><div class="card-head"><h2>By category</h2></div><div class="card-body">${bars(s.byCategory)}</div></div>
          <div class="card"><div class="card-head"><h2>Top locations</h2></div><div class="card-body">${bars(s.byLocation)}</div></div>
          <div class="card"><div class="card-head"><h2>By type</h2></div><div class="card-body">${bars(s.byType, (x) => titleCase(x.label))}</div></div>
          <div class="card"><div class="card-head"><h2>Technician workload</h2></div><div class="card-body tight">
            ${s.byAssignee.length
              ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Technician</th><th>Total</th><th>Open</th><th>Done</th><th>Avg hrs</th><th>Labor</th></tr></thead>
                <tbody>${s.byAssignee.map((a) => html`<tr><td>${a.label}</td><td>${a.total}</td><td>${a.open}</td><td>${a.completed}</td><td>${a.avg_hours ?? '—'}</td><td>${a.labor_hours}</td></tr>`)}</tbody></table></div>`
              : emptyState('No data in this period.', 'users')}
          </div></div>
        </div>`
      );
    };

    on(el, 'change', 'select[name=preset]', (e, sel) => {
      const f = sel.form;
      const now = new Date();
      if (sel.value === 'ytd') f.from.value = `${now.getFullYear()}-01-01`;
      else if (sel.value) f.from.value = iso(new Date(now.getTime() - Number(sel.value) * 86400000));
      f.to.value = iso(now);
    });
    on(el, 'submit', '#range', (e, f) => {
      e.preventDefault();
      if (f.from.value && f.to.value && f.from.value <= f.to.value) {
        range = { from: f.from.value, to: f.to.value };
        draw();
      }
    });
    on(el, 'click', '#exp-sum', () => download(`/reports/summary.csv${qs(range)}`));
    on(el, 'click', '#exp-wo', () => download(`/workorders/export.csv${qs({ ...range })}`));
    on(el, 'click', '#print', () => window.print());
    await draw();
  },
};


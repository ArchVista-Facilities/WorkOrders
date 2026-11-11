/**
 * Compliance tracker math: a faithful port of the EOC Dashboard workbook
 * formulas. Keep these rules as they are; they are the facility's agreed
 * calculation.
 *
 *   monthsElapsed  = year < Y ? 0 : year > Y ? 12 : MONTH(EOMONTH(TODAY(), -1))
 *   Annual Required (P)  monthly 12 · quarterly 4 · semi-annual 2 · annual 1
 *   YTD Due (Q)          monthly   = monthsElapsed
 *                        quarterly = INT(monthsElapsed / 3)
 *                        semi      = INT(monthsElapsed / 6)
 *                        annual    = 1 if completed this year, else 1 if the DUE
 *                                    month has been reached, else 0
 *   YTD Completed (R)    = Q = 0 ? 0 : MIN(Q, months of the year with a completion)
 *                          (the workbook counts one dated cell per month column)
 *   Compliance (S)       = Q = 0 ? 0 : MIN(1, R / Q)
 *   Group compliance     = ΣR / ΣQ for the group
 *   Weight (X)           = Q / ΣQ over every task that counts toward compliance
 *   Weighted (Y)         = Q = 0 ? 0 : S × X
 *   Overall              = ΣY
 *
 * Pure functions, no DOM: safe to unit-test in Node.
 */

export const CADENCES = [
  { key: 'monthly', label: 'Monthly', required: 12, perMonths: 1 },
  { key: 'quarterly', label: 'Quarterly', required: 4, perMonths: 3 },
  { key: 'semiannual', label: 'Semi-Annual', required: 2, perMonths: 6 },
  { key: 'annual', label: 'Annual', required: 1, perMonths: 12 },
  { key: 'misc', label: 'Misc. Inspections', required: null, perMonths: null },
];
export const cadence = (key) => CADENCES.find((c) => c.key === key);

/** MONTH(EOMONTH(today, -1)) with the workbook's year guards. */
export function monthsElapsed(year, today = new Date()) {
  const y = today.getFullYear();
  if (y < year) return 0;
  if (y > year) return 12;
  const m = today.getMonth(); // 0-based current month = 1-based previous month
  return m === 0 ? 12 : m; // EOMONTH(Jan, -1) is December → MONTH = 12 (as in the workbook)
}

/** 1-based month numbers (in `year`) that have at least one completion. */
export function monthsWithCompletion(entries, year) {
  const set = new Set();
  for (const e of entries) {
    const [y, m] = String(e.done_on).split('-').map(Number);
    if (y === year) set.add(m);
  }
  return set;
}

/** Row values P, Q, R, S for one task. */
export function taskRow(task, entries, year, today = new Date()) {
  const c = cadence(task.cadence);
  const m = monthsElapsed(year, today);
  const done = monthsWithCompletion(entries, year);
  let due;
  switch (task.cadence) {
    case 'monthly': due = m; break;
    case 'quarterly': due = Math.floor(m / 3); break;
    case 'semiannual': due = Math.floor(m / 6); break;
    case 'annual': {
      const y = today.getFullYear();
      if (y < year) due = 0;
      else if (y > year) due = 1;
      else if (done.size > 0) due = 1;
      else due = task.due_month && task.due_month <= m ? 1 : 0;
      break;
    }
    default: due = null;
  }
  if (due === null) return { required: null, due: null, completed: done.size, compliance: null };
  const completed = due === 0 ? 0 : Math.min(due, done.size);
  const compliance = due === 0 ? 0 : Math.min(1, completed / due);
  return { required: c.required, due, completed, compliance };
}

/**
 * Whole-tracker summary.
 * @param {Array} tasks    compliance_tasks rows (active ones)
 * @param {Map<number,Array>} entriesByTask
 */
export function summarize(tasks, entriesByTask, year, today = new Date()) {
  const rows = tasks.map((t) => ({ task: t, ...taskRow(t, entriesByTask.get(t.id) || [], year, today) }));
  const weighted = rows.filter((r) => r.task.counts_toward_compliance && r.due !== null);
  const totalDue = weighted.reduce((s, r) => s + r.due, 0);
  for (const r of rows) {
    const counts = r.task.counts_toward_compliance && r.due !== null;
    r.weight = counts && totalDue ? r.due / totalDue : 0;
    r.weighted = counts && r.due ? r.compliance * r.weight : 0;
  }
  const groups = CADENCES.filter((c) => c.key !== 'misc').map((c) => {
    const g = rows.filter((r) => r.task.cadence === c.key && r.task.counts_toward_compliance);
    const sum = (k) => g.reduce((s, r) => s + (r[k] || 0), 0);
    const due = sum('due');
    return { ...c, required: sum('required'), due, completed: sum('completed'), compliance: due ? sum('completed') / due : 0 };
  });
  const overall = rows.reduce((s, r) => s + r.weighted, 0);
  return { year, monthsElapsed: monthsElapsed(year, today), rows, groups, overall };
}

/** Is this task still open for the current period (for "due now" lists)? */
export function openThisPeriod(task, entries, today = new Date()) {
  const c = cadence(task.cadence);
  if (!c || !c.perMonths) return false;
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const start = Math.floor((m - 1) / c.perMonths) * c.perMonths + 1; // first month of the current period
  return !entries.some((e) => {
    const [ey, em] = String(e.done_on).split('-').map(Number);
    return ey === y && em >= start && em <= m;
  });
}

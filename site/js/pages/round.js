/**
 * Fill out a round (inspection form) built from a template definition.
 *
 *  - Yes / No / N/A per item (and per sub-item), 1–5 ratings, choices,
 *    free-text notes, reviewer sign-off rows.
 *  - Per-item notes and photos (camera or library on phones).
 *  - Autosaves while a draft; submitted rounds are read-only until reopened.
 *  - Each item knows which answer is a finding (`bad`), so findings are
 *    counted and can be turned into a work order in one tap.
 */
import { api } from '../api.js';
import { html, mount, icon, $, on, raw, toast, toastError, confirmDialog, busy, checked, disabled, fmtDateTime } from '../ui.js';

const ANSWERS = [
  { v: 'yes', label: 'Yes' },
  { v: 'no', label: 'No' },
  { v: 'na', label: 'N/A' },
];
const stripLetter = (s) => String(s || '').replace(/^[A-Z]\.\s*/, '');
const sectionShort = (s) => String(s || '').replace(/^Section \d+:\s*/, '');

/** Every answerable Yes/No/N/A slot: items without sub-items, plus each sub-item. */
function slots(def) {
  const out = [];
  for (const sec of def.sections || []) {
    for (const it of sec.items || []) {
      if (it.type === 'ynna') {
        if (it.sub && it.sub.length) it.sub.forEach((label, i) => out.push({ key: `${it.key}.${i}`, item: it, sec, subLabel: label, label: `${stripLetter(it.label)} (${label})` }));
        else out.push({ key: it.key, item: it, sec, label: stripLetter(it.label) });
      } else if (it.type === 'rating') out.push({ key: it.key, item: it, sec, label: stripLetter(it.label), rating: true });
    }
  }
  return out;
}

export default {
  title: 'Round',
  async render({ el, params, app }) {
    const [data, lookups] = await Promise.all([api(`/rounds/${params.id}`), api('/settings/lookups')]);
    let round = data.round;
    let photos = data.photos;
    const def = round.definition || { header: [], sections: [] };
    const state = { header: { ...round.header }, answers: JSON.parse(JSON.stringify(round.answers || {})) };
    const allSlots = slots(def);
    const ans = (k) => state.answers[k] || {};

    /* ---------------- rendering ---------------- */

    const seg = (key, value, bad) => html`<div class="seg" role="radiogroup" aria-label="Answer">${ANSWERS.map(
      (a) => html`<label class="seg-opt seg-${a.v} ${a.v === bad ? 'is-bad' : ''}"><input type="radio" name="a-${key}" value="${a.v}" data-a="${key}" data-f="v" ${checked(value === a.v)} /><span>${a.label}</span></label>`
    )}</div>`;

    const photoStrip = (key) => {
      const list = photos.filter((p) => (p.itemKey || '_general') === key);
      return html`<div class="q-photos" data-photos-for="${key}">${list.map(
        (p) => html`<div class="thumb"><a href="${p.url || '#'}" target="_blank" rel="noopener"><img src="${p.url || ''}" alt="Photo" loading="lazy" /></a>
          ${round.status === 'draft' ? html`<button type="button" class="btn btn-sm btn-icon thumb-del no-print" data-del-photo="${p.id}" aria-label="Remove photo">${icon('x', 'icon-sm')}</button>` : ''}</div>`
      )}</div>`;
    };

    const tools = (key, { wo = true } = {}) => html`<div class="q-tools no-print">
      <button type="button" class="btn btn-ghost btn-sm edit-only" data-note="${key}">${icon('note', 'icon-sm')}Note</button>
      <label class="btn btn-ghost btn-sm edit-only">${icon('camera', 'icon-sm')}Photo<input type="file" accept="image/*" class="sr-only" data-photo="${key}" /></label>
      ${wo ? html`<a class="btn btn-ghost btn-sm wo-link hidden" href="#" data-wo="${key}">${icon('clipboard', 'icon-sm')}Create work order</a>` : ''}
    </div>`;

    const noteBox = (key) => {
      const n = ans(key).note || '';
      return html`<textarea class="q-note ${n ? '' : 'hidden'}" data-a="${key}" data-f="note" maxlength="2000" rows="2" placeholder="Details, location, corrective action taken…">${n}</textarea>`;
    };

    const itemView = (it) => {
      const a = ans(it.key);
      switch (it.type) {
        case 'ynna':
          return html`<div class="q" data-q="${it.key}" data-bad="${it.bad || 'no'}">
            <div class="q-main">
              <div class="q-text">${it.label}${it.help ? html`<div class="help">${it.help}</div>` : ''}
                ${it.other ? html`<input type="text" class="q-other" maxlength="200" placeholder="Describe the item…" data-a="${it.key}" data-f="other" value="${a.other || ''}" />` : ''}</div>
              ${it.sub && it.sub.length ? '' : seg(it.key, a.v, it.bad || 'no')}
            </div>
            ${it.sub && it.sub.length
              ? html`<div class="q-subs">${it.sub.map((label, i) => {
                  const k = `${it.key}.${i}`;
                  return html`<div class="q sub" data-q="${k}" data-bad="${it.bad || 'no'}"><div class="q-main"><div class="q-text">${i + 1}. ${label}</div>${seg(k, ans(k).v, it.bad || 'no')}</div></div>`;
                })}</div>`
              : ''}
            ${tools(it.key)}${noteBox(it.key)}${photoStrip(it.key)}
          </div>`;
        case 'rating':
          return html`<div class="q" data-q="${it.key}">
            <div class="q-text">${it.label}</div>
            <div class="rating" role="radiogroup" aria-label="${it.label}">
              <span class="small muted">${it.minLabel || ''}</span>
              ${Array.from({ length: (it.max || 5) - (it.min || 1) + 1 }, (_, i) => (it.min || 1) + i).map(
                (n) => html`<label class="seg-opt"><input type="radio" name="a-${it.key}" value="${n}" data-a="${it.key}" data-f="v" ${checked(String(a.v) === String(n))} /><span>${n}</span></label>`
              )}
              <span class="small muted">${it.maxLabel || ''}</span>
            </div>
            ${tools(it.key, { wo: false })}${noteBox(it.key)}${photoStrip(it.key)}
          </div>`;
        case 'choice':
          return html`<div class="q" data-q="${it.key}"><div class="q-main"><div class="q-text">${it.label}</div>
            <select data-a="${it.key}" data-f="v"><option value="">Choose…</option>${(it.options || []).map((o) => html`<option ${o === a.v ? raw('selected') : ''}>${o}</option>`)}</select></div>
            ${tools(it.key)}${noteBox(it.key)}${photoStrip(it.key)}</div>`;
        case 'text':
          return html`<div class="q" data-q="${it.key}"><textarea data-a="${it.key}" data-f="v" rows="4" maxlength="5000" placeholder="${it.label}…">${a.v || ''}</textarea>
            <div class="help">${icon('lock', 'icon-sm')} No patient names or clinical details.</div></div>`;
        case 'signoff': {
          const rows = (a.rows || []).concat(Array.from({ length: Math.max(0, (it.rows || 3) - (a.rows || []).length) }, () => ({})));
          return html`<div class="q" data-q="${it.key}">${rows.map(
            (r, i) => html`<div class="form-grid signoff">
              <div class="field"><label>Reviewer</label><input type="text" maxlength="120" data-sign="${it.key}" data-row="${i}" data-f="name" value="${r.name || ''}" /></div>
              <div class="field"><label>Date</label><input type="date" data-sign="${it.key}" data-row="${i}" data-f="date" value="${r.date || ''}" /></div>
            </div>`
          )}</div>`;
        }
        default:
          return '';
      }
    };

    const headerField = (h) => {
      const v = state.header[h.key] ?? '';
      const id = `h-${h.key}`;
      const req = h.required ? 'req' : '';
      switch (h.type) {
        case 'location':
          return html`<div class="field"><label class="${req}" for="${id}">${h.label}</label>
            <select id="${id}" data-h="${h.key}"><option value="">Select a unit / area…</option>${lookups.locations.map(
              (l) => html`<option value="${l.id}" ${String(l.id) === String(v) ? raw('selected') : ''}>${l.unit && l.unit !== l.name ? `${l.unit} — ` : ''}${l.name}</option>`
            )}</select></div>`;
        case 'choice':
          return html`<div class="field"><label class="${req}">${h.label}</label><div class="seg">${(h.options || []).map(
            (o) => html`<label class="seg-opt"><input type="radio" name="h-${h.key}" value="${o}" data-h="${h.key}" ${checked(String(v) === String(o))} /><span>${o}</span></label>`
          )}</div></div>`;
        default:
          return html`<div class="field ${h.type === 'text' ? 'full' : ''}"><label class="${req}" for="${id}">${h.label}</label>
            <input id="${id}" type="${['date', 'time'].includes(h.type) ? h.type : 'text'}" maxlength="150" data-h="${h.key}" value="${v}" /></div>`;
      }
    };

    const draw = () => {
      const ro = round.status === 'submitted';
      mount(
        el,
        html`<div class="page-head">
          <div><div class="small muted"><a href="#/rounds">${icon('checklist', 'icon-sm')} Rounds</a></div>
            <h1>${round.name}</h1>
            <div class="sub">${ro ? html`<span class="badge st-completed">Submitted</span> ${fmtDateTime(round.submittedAt)}` : html`<span class="badge st-on_hold">Draft</span> <span id="save-state" class="small muted">All changes saved</span>`}</div></div>
          <div class="actions no-print">
            <button class="btn" id="print">${icon('printer')}Print</button>
            ${ro
              ? html`<button class="btn" id="reopen">${icon('edit')}Reopen to edit</button>`
              : html`<button class="btn btn-ghost danger-text" id="delete">${icon('trash')}Delete</button><button class="btn btn-primary" id="submit">${icon('check')}Submit round</button>`}
          </div>
        </div>

        <div class="progress-bar card no-print"><div class="card-body">
          <div class="progress-row"><span id="progress-text"></span><span id="findings-text"></span></div>
          <div class="bar-track"><div class="bar-fill done" id="progress-fill"></div></div>
        </div></div>

        <div id="findings-panel"></div>

        <fieldset class="plain ${ro ? 'readonly' : ''}" ${disabled(ro)}>
          <div class="card"><div class="card-head"><h2>${icon('info')}Round details</h2></div>
            <div class="card-body"><div class="form-grid">${(def.header || []).map(headerField)}</div></div></div>

          ${(def.sections || []).map(
            (sec) => html`<div class="card round-section" data-section="${sec.key}">
              <div class="card-head"><h2>${sec.title}</h2>
                ${sec.items.some((i) => i.type === 'ynna' && !i.other) ? html`<button type="button" class="btn btn-sm edit-only no-print" data-allgood="${sec.key}">${icon('check', 'icon-sm')}Mark section compliant</button>` : ''}</div>
              <div class="card-body tight">${sec.items.map(itemView)}</div>
            </div>`
          )}

          <div class="card"><div class="card-head"><h2>${icon('camera')}General photos</h2>
            <label class="btn btn-sm edit-only no-print">${icon('upload', 'icon-sm')}Add photo<input type="file" accept="image/*" class="sr-only" data-photo="_general" /></label></div>
            <div class="card-body">${photos.some((p) => !p.itemKey) ? photoStrip('_general') : html`<div data-photos-for="_general" class="q-photos"></div><p class="small muted empty-photos">No general photos.</p>`}</div></div>
        </fieldset>`
      );
      allSlots.forEach((s) => refreshItem(s.key));
      refreshProgress();
    };

    /* ---------------- live state ---------------- */

    const findingsList = () =>
      allSlots.filter((s) => !s.rating && ans(s.key).v && ans(s.key).v === (s.item.bad || 'no'));

    function refreshItem(key) {
      const q = el.querySelector(`.q[data-q="${CSS.escape(key)}"]`);
      if (!q) return;
      const v = ans(key).v;
      const bad = q.dataset.bad;
      q.classList.toggle('ans-bad', Boolean(bad && v && v === bad));
      q.classList.toggle('ans-good', Boolean(bad && v && v !== bad && v !== 'na'));
      q.classList.toggle('ans-na', v === 'na');
      // The parent item owns the note/photo/WO tools; sub-items roll up to it.
      const parentKey = key.split('.')[0];
      const parent = el.querySelector(`.q[data-q="${CSS.escape(parentKey)}"]`);
      if (!parent) return;
      const anyBad = allSlots.some((s) => s.key.split('.')[0] === parentKey && !s.rating && ans(s.key).v && ans(s.key).v === (s.item.bad || 'no'));
      const wo = $(`[data-wo="${CSS.escape(parentKey)}"]`, parent);
      if (wo) wo.classList.toggle('hidden', !anyBad);
      const note = $(`textarea.q-note[data-a="${CSS.escape(parentKey)}"]`, parent);
      if (note && anyBad) note.classList.remove('hidden');
    }

    function refreshProgress() {
      const answered = allSlots.filter((s) => ans(s.key).v !== undefined && ans(s.key).v !== '').length;
      const f = findingsList();
      const pct = allSlots.length ? Math.round((answered / allSlots.length) * 100) : 0;
      const pt = $('#progress-text', el);
      if (!pt) return;
      pt.textContent = `${answered} of ${allSlots.length} items answered (${pct}%)`;
      $('#findings-text', el).innerHTML = String(f.length ? html`<span class="badge flag">${icon('alert', 'icon-sm')}${f.length} finding${f.length === 1 ? '' : 's'}</span>` : html`<span class="badge st-completed">No findings</span>`);
      $('#progress-fill', el).style.width = `${pct}%`;
      const panel = $('#findings-panel', el);
      mount(
        panel,
        f.length
          ? html`<div class="card findings"><div class="card-head"><h2>${icon('alert')}Findings</h2><span class="small muted">Answers that need follow-up</span></div>
              <ul class="findings-list">${f.map(
                (s) => html`<li><a href="#" data-jump="${s.key.split('.')[0]}"><strong>${sectionShort(s.sec.title)}</strong> · ${s.label}</a>
                  <a class="btn btn-sm no-print" href="#" data-wo="${s.key.split('.')[0]}">${icon('clipboard', 'icon-sm')}Create work order</a></li>`
              )}</ul></div>`
          : ''
      );
    }

    /* ---------------- saving ---------------- */

    let timer = null;
    let saving = Promise.resolve();
    let dirty = false;
    const setSaveState = (text, cls = 'muted') => {
      const s = $('#save-state', el);
      if (s) {
        s.textContent = text;
        s.className = `small ${cls}`;
      }
    };
    const save = () => {
      clearTimeout(timer);
      if (!dirty || round.status !== 'draft') return saving;
      dirty = false;
      setSaveState('Saving…');
      saving = saving
        .then(() => api(`/rounds/${round.id}`, {
          method: 'PUT',
          body: { header: state.header, answers: state.answers, findings: findingsList().length, locationId: state.header.unit || null },
        }))
        .then(() => setSaveState(`Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`))
        .catch((err) => {
          dirty = true;
          setSaveState('Not saved, will retry', 'overdue');
          toastError(err);
        });
      return saving;
    };
    const schedule = () => {
      dirty = true;
      setSaveState('Unsaved changes…');
      clearTimeout(timer);
      timer = setTimeout(save, 700);
    };

    /* ---------------- events ---------------- */

    const onInput = (e) => {
      const t = e.target;
      if (t.dataset.h) {
        if (t.type === 'radio' && !t.checked) return;
        state.header[t.dataset.h] = t.value;
        schedule();
      } else if (t.dataset.a) {
        if (t.type === 'radio' && !t.checked) return;
        const k = t.dataset.a;
        state.answers[k] = { ...ans(k), [t.dataset.f]: t.value };
        if (state.answers[k][t.dataset.f] === '') delete state.answers[k][t.dataset.f];
        refreshItem(k);
        refreshProgress();
        schedule();
      } else if (t.dataset.sign) {
        const k = t.dataset.sign;
        const rows = (ans(k).rows || []).slice();
        rows[Number(t.dataset.row)] = { ...(rows[Number(t.dataset.row)] || {}), [t.dataset.f]: t.value };
        state.answers[k] = { rows };
        schedule();
      }
    };
    el.addEventListener('input', onInput);
    el.addEventListener('change', onInput);

    // Tap a selected answer again to clear it.
    const onPointer = (e) => {
      const lab = e.target.closest('.seg-opt');
      if (lab) {
        const inp = $('input', lab);
        inp.dataset.was = inp.checked ? '1' : '';
      }
    };
    el.addEventListener('pointerdown', onPointer);
    const offs = [
      on(el, 'click', '.seg-opt input[data-a]', (e, inp) => {
        if (inp.dataset.was === '1') {
          inp.checked = false;
          inp.dataset.was = '';
          const k = inp.dataset.a;
          const next = { ...ans(k) };
          delete next.v;
          state.answers[k] = next;
          refreshItem(k);
          refreshProgress();
          schedule();
        }
      }),
      on(el, 'click', '[data-note]', (e, b) => {
        const box = $(`textarea.q-note[data-a="${CSS.escape(b.dataset.note)}"]`, el);
        box.classList.remove('hidden');
        box.focus();
      }),
      on(el, 'click', '[data-allgood]', (e, b) => {
        const sec = def.sections.find((s) => s.key === b.dataset.allgood);
        let n = 0;
        allSlots.filter((s) => s.sec === sec && !s.rating && !s.item.other && !ans(s.key).v).forEach((s) => {
          const good = (s.item.bad || 'no') === 'yes' ? 'no' : 'yes';
          state.answers[s.key] = { ...ans(s.key), v: good };
          const r = $(`input[name="a-${CSS.escape(s.key)}"][value="${good}"]`, el);
          if (r) r.checked = true;
          refreshItem(s.key);
          n++;
        });
        refreshProgress();
        if (n) schedule();
        toast(n ? `${n} unanswered item${n === 1 ? '' : 's'} marked compliant.` : 'Every item in this section is already answered.', 'info');
      }),
      on(el, 'click', '[data-jump]', (e, a) => {
        e.preventDefault();
        const q = el.querySelector(`.q[data-q="${CSS.escape(a.dataset.jump)}"]`);
        if (q) q.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }),
      on(el, 'click', '[data-wo]', async (e, a) => {
        e.preventDefault();
        await save();
        const key = a.dataset.wo;
        const s = allSlots.find((x) => x.key.split('.')[0] === key);
        if (!s) return;
        const it = s.item;
        const bad = allSlots.filter((x) => x.key.split('.')[0] === key && ans(x.key).v === (it.bad || 'no'));
        const note = ans(key).note;
        const other = ans(key).other;
        const title = `${sectionShort(s.sec.title)}: ${other || stripLetter(it.label)}`.slice(0, 150);
        const description = [
          `Found during ${round.name} on ${state.header.date || ''}${state.header.shift ? ` (shift ${state.header.shift})` : ''}${state.header.conductedBy ? ` by ${state.header.conductedBy}` : ''}.`,
          '',
          `Item: ${stripLetter(it.label)}${other ? ` (${other})` : ''}`,
          ...bad.map((x) => `Answer${x.subLabel ? ` · ${x.subLabel}` : ''}: ${ANSWERS.find((o) => o.v === ans(x.key).v).label}`),
          note ? `Notes: ${note}` : '',
          '',
          `Round #${round.id}`,
        ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n');
        const q = new URLSearchParams({ title, description: description.slice(0, 5000), type: 'safety' });
        if (state.header.unit) q.set('locationId', state.header.unit);
        app.navigate(`/workorders/new?${q}`);
      }),
      on(el, 'change', 'input[type=file][data-photo]', async (e, inp) => {
        const file = inp.files[0];
        if (!file) return;
        const key = inp.dataset.photo;
        const host = inp.closest('label');
        host.classList.add('uploading');
        try {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('itemKey', key === '_general' ? '' : key);
          await api(`/rounds/${round.id}/photos`, { method: 'POST', form: fd });
          photos = (await api(`/rounds/${round.id}`)).photos;
          const strip = el.querySelector(`[data-photos-for="${CSS.escape(key)}"]`);
          if (strip) strip.outerHTML = String(photoStrip(key));
          const empty = key === '_general' && $('.empty-photos', el);
          if (empty) empty.remove();
          toast('Photo added.', 'success');
        } catch (err) {
          toastError(err);
        } finally {
          host.classList.remove('uploading');
          inp.value = '';
        }
      }),
      on(el, 'click', '[data-del-photo]', async (e, b) => {
        if (!(await confirmDialog('Remove this photo?', { danger: true, okLabel: 'Remove' }))) return;
        try {
          await api(`/rounds/${round.id}/photos/${b.dataset.delPhoto}`, { method: 'DELETE' });
          photos = photos.filter((p) => String(p.id) !== b.dataset.delPhoto);
          b.closest('.thumb').remove();
        } catch (err) {
          toastError(err);
        }
      }),
      on(el, 'click', '#print', () => window.print()),
      on(el, 'click', '#submit', async (e, b) => {
        const missing = (def.header || []).filter((h) => h.required && !state.header[h.key]);
        if (missing.length) {
          toast(`Please fill in: ${missing.map((h) => h.label).join(', ')}.`, 'error');
          return;
        }
        const open = allSlots.filter((s) => !ans(s.key).v).length;
        if (open && !(await confirmDialog(`${open} item${open === 1 ? ' is' : 's are'} still unanswered. Submit anyway?`, { okLabel: 'Submit round' }))) return;
        await busy(b, async () => {
          try {
            dirty = true;
            await save();
            if (dirty) return; // save failed; error already shown
            await api(`/rounds/${round.id}/status`, { method: 'POST', body: { status: 'submitted' } });
            round = (await api(`/rounds/${round.id}`)).round;
            toast('Round submitted.', 'success');
            draw();
            window.scrollTo(0, 0);
          } catch (err) {
            toastError(err);
          }
        });
      }),
      on(el, 'click', '#reopen', async () => {
        try {
          await api(`/rounds/${round.id}/status`, { method: 'POST', body: { status: 'draft' } });
          round = (await api(`/rounds/${round.id}`)).round;
          draw();
        } catch (err) {
          toastError(err);
        }
      }),
      on(el, 'click', '#delete', async () => {
        if (!(await confirmDialog('Delete this round and its photos? This cannot be undone.', { danger: true, okLabel: 'Delete round' }))) return;
        try {
          clearTimeout(timer);
          dirty = false;
          await api(`/rounds/${round.id}`, { method: 'DELETE' });
          toast('Round deleted.', 'success');
          app.navigate('/rounds');
        } catch (err) {
          toastError(err);
        }
      }),
    ];

    const beforeUnload = (e) => {
      if (dirty) {
        save();
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);

    draw();

    return () => {
      save(); // flush pending edits when navigating away
      window.removeEventListener('beforeunload', beforeUnload);
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onInput);
      el.removeEventListener('pointerdown', onPointer);
      offs.forEach((off) => off());
    };
  },
};


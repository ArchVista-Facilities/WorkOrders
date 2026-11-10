/**
 * My Profile: photo, detailed profile, roles, and password change.
 */
import { api } from '../api.js';
import { html, mount, icon, $, toast, toastError, formValues, busy, confirmDialog, fmtDate, fmtDateTime } from '../ui.js';
import { profileFields, avatarEditor, wireAvatar } from './_profile-shared.js';

export default {
  title: 'My Profile',
  async render({ el, query, app }) {
    const draw = async (tab = query.tab || 'profile') => {
      const { user: u, roles, supervisor } = await api('/users/me');
      mount(
        el,
        html`<div class="card"><div class="profile-hero">
            ${avatarEditor(u, 128)}
            <div>
              <h1>${u.displayName}</h1>
              <div class="muted">${u.jobTitle || 'No title set'}${u.department ? ` · ${u.department}` : ''}</div>
              <div class="chips">${roles.map((r) => html`<span class="badge">${r.name}</span>`)}${u.isSuperuser ? html`<span class="badge flag-info">${icon('shield', 'icon-sm')}Superuser</span>` : ''}${u.isDeveloper ? html`<span class="badge flag-warn">Developer</span>` : ''}</div>
              <div class="small faint">${u.email} · Member since ${fmtDate(u.createdAt)}${supervisor ? ` · Reports to ${supervisor.name}` : ''}</div>
              ${u.hasAvatar ? html`<button class="btn btn-sm btn-ghost" id="rm-photo">${icon('trash', 'icon-sm')}Remove photo</button>` : ''}
            </div>
          </div></div><br />
        <div class="tabs" role="tablist">
          <button data-tab="profile" class="${tab === 'profile' ? 'active' : ''}">Profile</button>
          <button data-tab="security" class="${tab === 'security' ? 'active' : ''}">Password & security</button>
        </div>
        ${tab === 'profile'
          ? html`<form class="card" id="pf-form" novalidate>${profileFields(u)}
              <div class="form-section actions"><button class="btn btn-primary" type="submit">${icon('check')}Save profile</button></div></form>`
          : html`<div class="grid grid-2">
              <form class="card" id="pw-form" novalidate><div class="form-section"><h3>${icon('key')}Change password</h3>
                <div class="field"><label class="req" for="pw-c">Current password</label><input id="pw-c" name="currentPassword" type="password" autocomplete="current-password" /></div>
                <div class="field"><label class="req" for="pw-n">New password</label><input id="pw-n" name="newPassword" type="password" autocomplete="new-password" />
                  <div class="help">At least 12 characters with 3 of: lowercase, uppercase, number, symbol. You'll stay signed in on this device.</div></div>
                <div class="field"><label class="req" for="pw-n2">Confirm new password</label><input id="pw-n2" name="newPassword2" type="password" autocomplete="new-password" /></div>
                <button class="btn btn-primary" type="submit">Update password</button></div></form>
              <div class="card"><div class="form-section"><h3>${icon('shield')}Session</h3>
                <dl class="dl"><dt>Last sign-in</dt><dd>${fmtDateTime(u.lastLoginAt)}</dd><dt>Auto sign-out</dt><dd>After ${app.meta.sessionIdleMinutes} minutes of inactivity</dd></dl>
              </div></div>
            </div>`}`
      );

      el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => draw(b.dataset.tab)));
      wireAvatar(el, '/users/me/avatar', async () => {
        await app.refreshMeta();
        draw(tab);
      });
      const rm = $('#rm-photo', el);
      if (rm) {
        rm.addEventListener('click', async () => {
          if (!(await confirmDialog('Remove your profile photo?', { okLabel: 'Remove', danger: true }))) return;
          await api('/users/me/avatar', { method: 'DELETE' }).catch(toastError);
          await app.refreshMeta();
          draw(tab);
        });
      }

      const pf = $('#pf-form', el);
      if (pf) {
        pf.addEventListener('submit', async (e) => {
          e.preventDefault();
          await busy($('button[type=submit]', pf), async () => {
            try {
              await api('/users/me', { method: 'PUT', body: formValues(pf) });
              await app.refreshMeta();
              toast('Profile saved.', 'success');
              draw('profile');
            } catch (err) {
              toastError(err);
            }
          });
        });
      }
      const pw = $('#pw-form', el);
      if (pw) {
        pw.addEventListener('submit', async (e) => {
          e.preventDefault();
          const v = formValues(pw);
          if (v.newPassword !== v.newPassword2) return toast('Passwords do not match.', 'error');
          await busy($('button[type=submit]', pw), async () => {
            try {
              await api('/auth/change-password', { method: 'POST', body: v });
              toast('Password updated.', 'success');
              pw.reset();
            } catch (err) {
              toastError(err);
            }
          });
        });
      }
    };
    await draw();
  },
};

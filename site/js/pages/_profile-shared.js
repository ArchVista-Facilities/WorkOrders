/**
 * Shared profile form + photo uploader used by "My Profile" and the admin
 * user editor, so both stay in sync when fields are added.
 */
import { api } from '../api.js';
import { html, icon, avatar, options, $, toast, toastError } from '../ui.js';

const SHIFTS = ['Day', 'Evening', 'Night', 'Rotating', 'On-Call', 'Weekend'].map((s) => ({ value: s, label: s }));

/**
 * @param {object} u  publicUser shape
 * @param {{admin?:boolean, supervisors?:{id:number,name:string}[]}} opts
 */
export function profileFields(u, { admin = false, supervisors = [] } = {}) {
  const val = (x) => x ?? '';
  return html`
    <div class="form-section"><h3>${icon('user')}Personal</h3>
      <div class="form-grid">
        <div class="field"><label class="req" for="p-fn">First name</label><input id="p-fn" name="firstName" type="text" maxlength="80" required value="${val(u.firstName)}" /></div>
        <div class="field"><label class="req" for="p-ln">Last name</label><input id="p-ln" name="lastName" type="text" maxlength="80" required value="${val(u.lastName)}" /></div>
        <div class="field"><label for="p-pn">Preferred name</label><input id="p-pn" name="preferredName" type="text" maxlength="80" value="${val(u.preferredName)}" /></div>
        ${admin
          ? html`<div class="field"><label>Email</label><input type="email" value="${u.email}" readonly /><div class="help">Sign-in email; the user changes it from their own account.</div></div>`
          : html`<div class="field"><label>Email</label><input type="email" value="${u.email}" readonly /><div class="help">Contact the administrator to change your email.</div></div>`}
      </div>
    </div>
    <div class="form-section"><h3>${icon('clipboard')}Work</h3>
      <div class="form-grid">
        <div class="field"><label for="p-jt">Job title</label><input id="p-jt" name="jobTitle" type="text" maxlength="120" value="${val(u.jobTitle)}" /></div>
        <div class="field"><label for="p-dp">Department / unit</label><input id="p-dp" name="department" type="text" maxlength="120" value="${val(u.department)}" /></div>
        <div class="field"><label for="p-sh">Shift</label><select id="p-sh" name="shift">${options(SHIFTS, u.shift, { blank: '—' })}</select></div>
        ${admin
          ? html`<div class="field"><label for="p-eid">Employee ID</label><input id="p-eid" name="employeeId" type="text" maxlength="40" value="${val(u.employeeId)}" /></div>
              <div class="field"><label for="p-hd">Hire date</label><input id="p-hd" name="hireDate" type="date" value="${val(u.hireDate)}" /></div>
              <div class="field"><label for="p-sup">Supervisor</label><select id="p-sup" name="supervisorId">${options(supervisors.filter((s) => s.id !== u.id), u.supervisorId, { valueKey: 'id', labelKey: 'name', blank: '—' })}</select></div>`
          : html`<div class="field"><label>Employee ID</label><input type="text" value="${val(u.employeeId)}" readonly /></div>`}
      </div>
    </div>
    <div class="form-section"><h3>${icon('message')}Contact</h3>
      <div class="form-grid">
        <div class="field"><label for="p-ph">Work phone</label><input id="p-ph" name="phone" type="tel" maxlength="30" value="${val(u.phone)}" /></div>
        <div class="field"><label for="p-ext">Extension</label><input id="p-ext" name="extension" type="text" maxlength="10" value="${val(u.extension)}" /></div>
        <div class="field"><label for="p-mb">Mobile</label><input id="p-mb" name="mobile" type="tel" maxlength="30" value="${val(u.mobile)}" /></div>
      </div>
    </div>
    <div class="form-section"><h3>${icon('shield')}Qualifications</h3>
      <div class="field"><label for="p-cert">Certifications & licenses</label><textarea id="p-cert" name="certifications" maxlength="2000" placeholder="e.g. EPA Universal, Boiler Operator License, CPI / Handle With Care, NFPA 25…">${val(u.certifications)}</textarea></div>
      <div class="field"><label for="p-sk">Skills / trades</label><textarea id="p-sk" name="skills" maxlength="2000" placeholder="e.g. Plumbing, HVAC, low-voltage, carpentry">${val(u.skills)}</textarea></div>
      <div class="field"><label for="p-bio">About</label><textarea id="p-bio" name="bio" maxlength="2000">${val(u.bio)}</textarea></div>
    </div>
    <div class="form-section"><h3>${icon('alert')}Emergency contact</h3>
      <div class="form-grid">
        <div class="field"><label for="p-ecn">Name / relationship</label><input id="p-ecn" name="emergencyContactName" type="text" maxlength="120" value="${val(u.emergencyContactName)}" /></div>
        <div class="field"><label for="p-ecp">Phone</label><input id="p-ecp" name="emergencyContactPhone" type="tel" maxlength="30" value="${val(u.emergencyContactPhone)}" /></div>
      </div>
      <div class="help">Visible only to you and user administrators.</div>
    </div>`;
}

/** Avatar with camera button; calls onChange(updatedUser) after upload/remove. */
export function avatarEditor(u, size = 128) {
  return html`<div class="avatar-edit">${avatar(u, size)}
    <label class="cam" title="Upload photo">${icon('camera', 'icon-sm')}<input type="file" class="sr-only" data-avatar-input accept="image/png,image/jpeg,image/webp,image/gif" /></label></div>`;
}

/**
 * Wire avatar upload/remove.
 * @param {HTMLElement} root
 * @param {string} uploadPath   e.g. "/users/me/avatar" or "/users/12/avatar"
 * @param {(user)=>void} onChange
 */
export function wireAvatar(root, uploadPath, onChange) {
  const input = $('[data-avatar-input]', root);
  if (!input) return;
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('Photo must be 2 MB or smaller.', 'error');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api(uploadPath, { method: 'POST', form: fd });
      toast('Photo updated.', 'success');
      onChange(res.user);
    } catch (e) {
      toastError(e);
    }
  });
}

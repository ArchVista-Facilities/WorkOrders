/**
 * Sign in · Create account · Forgot password · Set new password (from email link)
 * · Awaiting approval · Disabled.
 *
 * Supabase Auth handles credentials and email verification. The database
 * trigger on auth.users enforces the @archvistabh.com domain rule (plus the
 * developer exception), so the checks here are for a friendly UX only.
 */
import { api, sb, siteUrl, assertStrongPassword } from '../api.js';
import { html, mount, icon, $, toast, formValues, busy } from '../ui.js';

/** Supabase Auth → readable messages. */
function authMessage(err) {
  const m = String((err && err.message) || err || '');
  if (/Invalid login credentials/i.test(m)) return 'Invalid email or password.';
  if (/Email not confirmed/i.test(m)) return 'Please confirm your email first — check your inbox for the verification link.';
  if (/Database error saving new user/i.test(m)) return 'Registration is limited to Arch Vista email addresses.';
  if (/already registered/i.test(m)) return 'An account with this email already exists. Sign in or reset your password.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a few minutes and try again.';
  return m || 'Something went wrong.';
}

export default {
  title: 'Sign in',
  async render({ el, mode = 'login', onSignedIn }) {
    let cfg = {
      facility: { name: 'Arch Vista Behavioral Health', street: '5500 South Broadway Street', city: 'St. Louis', state: 'MO', zip: '63111' },
      allowedDomains: ['archvistabh.com'],
      minPasswordLength: 12,
    };
    try {
      cfg = await api('/auth/config');
    } catch {
      /* fall back to defaults */
    }
    const f = cfg.facility;
    document.title = `Sign in · ${f.name}`;
    const domains = cfg.allowedDomains.map((d) => `@${d}`).join(', ');
    const pwHelp = `At least ${cfg.minPasswordLength} characters with 3 of: lowercase, uppercase, number, symbol.`;

    mount(
      el,
      html`<div class="auth-wrap">
        <section class="auth-side">
          <div class="brand"><div class="brand-mark">A<span>V</span></div><div><div class="brand-name">${f.name}</div><div class="addr">${f.street} · ${f.city}, ${f.state} ${f.zip}</div></div></div>
          <div>
            <h1>Facility work orders, handled with care.</h1>
            <p>Submit maintenance requests, track repairs, and keep every patient-care environment safe, secure, and ready.</p>
            <ul class="auth-points">
              <li>${icon('alert')}<span>Ligature and patient-safety issues are escalated automatically.</span></li>
              <li>${icon('shield')}<span>Tool-control attestation before any patient-area job is closed.</span></li>
              <li>${icon('clock')}<span>Priority-based response targets with live status for every request.</span></li>
            </ul>
          </div>
          <div class="addr">Authorized Arch Vista staff only. Activity is logged.</div>
        </section>
        <section class="auth-main"><div class="auth-card" id="auth-card"></div></section>
      </div>`
    );
    const card = $('#auth-card', el);
    const tabs = (active) =>
      html`<div class="tabs" role="tablist"><button type="button" class="${active === 'login' ? 'active' : ''}" data-go="login">Sign in</button><button type="button" class="${active === 'register' ? 'active' : ''}" data-go="register">Create account</button></div>`;
    const wireTabs = () => card.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => screens[b.dataset.go]()));
    const notice = (kind, ic, msg) => html`<div class="notice ${kind}">${icon(ic)}<div>${msg}</div></div>`;

    const screens = {
      login(msg) {
        mount(
          card,
          html`<h2>Welcome back</h2><p class="muted">Sign in with your Arch Vista email.</p>${tabs('login')}
          ${msg ? notice('success', 'check', msg) : ''}
          <form id="login-form" novalidate>
            <div class="field"><label for="li-email">Email</label><input id="li-email" name="email" type="email" autocomplete="username" required /></div>
            <div class="field"><label for="li-pw">Password</label><input id="li-pw" name="password" type="password" autocomplete="current-password" required /></div>
            <button class="btn btn-primary btn-block btn-lg" type="submit">Sign in</button>
            <p class="small"><a href="#" id="to-forgot">Forgot your password?</a></p>
          </form>`
        );
        wireTabs();
        $('#to-forgot', card).addEventListener('click', (e) => (e.preventDefault(), screens.forgot()));
        $('#login-form', card).addEventListener('submit', async (e) => {
          e.preventDefault();
          const v = formValues(e.target);
          await busy($('button[type=submit]', e.target), async () => {
            const { error } = await sb.auth.signInWithPassword({ email: v.email.toLowerCase(), password: v.password });
            if (error) return toast(authMessage(error), 'error', 6000);
            onSignedIn();
          });
        });
        $('#li-email', card).focus();
      },

      register() {
        mount(
          card,
          html`<h2>Create your account</h2><p class="muted">Available to ${domains} staff. You'll confirm your email, then an administrator approves your access.</p>${tabs('register')}
          <form id="reg-form" novalidate>
            <div class="form-grid">
              <div class="field"><label class="req" for="rg-fn">First name</label><input id="rg-fn" name="firstName" type="text" autocomplete="given-name" maxlength="80" /></div>
              <div class="field"><label class="req" for="rg-ln">Last name</label><input id="rg-ln" name="lastName" type="text" autocomplete="family-name" maxlength="80" /></div>
            </div>
            <div class="field"><label class="req" for="rg-em">Work email</label><input id="rg-em" name="email" type="email" autocomplete="email" placeholder="name@${cfg.allowedDomains[0] || 'archvistabh.com'}" /></div>
            <div class="form-grid">
              <div class="field"><label for="rg-jt">Job title</label><input id="rg-jt" name="jobTitle" type="text" maxlength="120" /></div>
              <div class="field"><label for="rg-dp">Department / unit</label><input id="rg-dp" name="department" type="text" maxlength="120" /></div>
            </div>
            <div class="field"><label for="rg-ph">Phone / extension</label><input id="rg-ph" name="phone" type="tel" maxlength="30" /></div>
            <div class="field"><label class="req" for="rg-pw">Password</label><input id="rg-pw" name="password" type="password" autocomplete="new-password" /><div class="help">${pwHelp}</div></div>
            <div class="field"><label class="req" for="rg-pw2">Confirm password</label><input id="rg-pw2" name="password2" type="password" autocomplete="new-password" /></div>
            <button class="btn btn-primary btn-block btn-lg" type="submit">Create account</button>
          </form>`
        );
        wireTabs();
        $('#reg-form', card).addEventListener('submit', async (e) => {
          e.preventDefault();
          const v = formValues(e.target);
          const email = v.email.toLowerCase();
          // Domain eligibility (including the private developer exception) is enforced by the
          // database trigger; a rejected address comes back as a friendly message via authMessage().
          if (!v.firstName || !v.lastName) return toast('First and last name are required.', 'error');
          if (v.password !== v.password2) return toast('Passwords do not match.', 'error');
          try {
            assertStrongPassword(v.password, email);
          } catch (err) {
            return toast(err.message, 'error');
          }
          await busy($('button[type=submit]', e.target), async () => {
            const { data, error } = await sb.auth.signUp({
              email,
              password: v.password,
              options: {
                emailRedirectTo: siteUrl(),
                data: { firstName: v.firstName, lastName: v.lastName, jobTitle: v.jobTitle, department: v.department, phone: v.phone },
              },
            });
            if (error) return toast(authMessage(error), 'error', 7000);
            if (data.session) return onSignedIn(); // email confirmation disabled in project settings
            mount(card, html`<h2>Check your email</h2>
              ${notice('info', 'message', html`We sent a confirmation link to <strong>${email}</strong>. Open it on this device to verify your address.`)}
              <p class="muted">After you confirm, an administrator will approve your account. You'll be able to sign in once approved.</p>
              <button class="btn btn-block" data-go="login">Back to sign in</button>`);
            wireTabs();
          });
        });
        $('#rg-fn', card).focus();
      },

      forgot() {
        mount(
          card,
          html`<h2>Reset your password</h2><p class="muted">We'll email you a secure link to choose a new password.</p>
          <form id="fp-form" novalidate>
            <div class="field"><label for="fp-email">Email</label><input id="fp-email" name="email" type="email" autocomplete="username" /></div>
            <button class="btn btn-primary btn-block btn-lg" type="submit">Send reset link</button>
            <button class="btn btn-ghost btn-block" type="button" data-go="login">Back to sign in</button>
          </form>`
        );
        wireTabs();
        $('#fp-form', card).addEventListener('submit', async (e) => {
          e.preventDefault();
          const v = formValues(e.target);
          await busy($('button[type=submit]', e.target), async () => {
            const { error } = await sb.auth.resetPasswordForEmail(v.email.toLowerCase(), { redirectTo: siteUrl() });
            if (error) return toast(authMessage(error), 'error');
            // Same message whether or not the account exists (no account enumeration).
            screens.login('If that email has an account, a reset link is on its way.');
          });
        });
        $('#fp-email', card).focus();
      },

      recover() {
        mount(
          card,
          html`<h2>Choose a new password</h2>
          <form id="rc-form" novalidate>
            <div class="field"><label class="req" for="rc-new">New password</label><input id="rc-new" name="newPassword" type="password" autocomplete="new-password" /><div class="help">${pwHelp}</div></div>
            <div class="field"><label class="req" for="rc-new2">Confirm new password</label><input id="rc-new2" name="newPassword2" type="password" autocomplete="new-password" /></div>
            <button class="btn btn-primary btn-block btn-lg" type="submit">Update password</button>
          </form>`
        );
        $('#rc-form', card).addEventListener('submit', async (e) => {
          e.preventDefault();
          const v = formValues(e.target);
          if (v.newPassword !== v.newPassword2) return toast('Passwords do not match.', 'error');
          const { data } = await sb.auth.getUser();
          try {
            assertStrongPassword(v.newPassword, data.user && data.user.email);
          } catch (err) {
            return toast(err.message, 'error');
          }
          await busy($('button[type=submit]', e.target), async () => {
            const { error } = await sb.auth.updateUser({ password: v.newPassword });
            if (error) return toast(authMessage(error), 'error');
            toast('Password updated.', 'success');
            onSignedIn();
          });
        });
        $('#rc-new', card).focus();
      },

      pending() {
        mount(card, html`<h2>Awaiting approval</h2>
          ${notice('warn', 'clock', 'Your email is confirmed. An administrator still needs to approve your account before you can use the system.')}
          <p class="muted">If this is taking longer than expected, contact the Director of Facility Operations.</p>
          <div class="actions"><button class="btn btn-primary" id="recheck">Check again</button><button class="btn btn-ghost" id="signout">Sign out</button></div>`);
        $('#recheck', card).addEventListener('click', onSignedIn);
        $('#signout', card).addEventListener('click', async () => (await sb.auth.signOut(), screens.login()));
      },

      disabled() {
        mount(card, html`<h2>Account disabled</h2>
          ${notice('danger', 'lock', 'Your account has been disabled. Contact the Director of Facility Operations if you believe this is a mistake.')}
          <button class="btn btn-block" id="signout">Sign out</button>`);
        $('#signout', card).addEventListener('click', async () => (await sb.auth.signOut(), screens.login()));
      },
    };

    (screens[mode] || screens.login)();
  },
};


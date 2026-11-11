-- Keep private settings out of the public API.
--
-- Before: every row of app_settings was readable by anyone holding the
-- publishable key (anon), including developer_email.
-- After:
--   * anon (the sign-in / register page) sees only facility + allowed_domains.
--   * signed-in users see everything except developer_email.
--   * developer_email is read only by SECURITY DEFINER functions
--     (email_allowed, handle_new_user), which bypass RLS as the table owner.

drop policy if exists settings_read on public.app_settings;

create policy settings_read_anon on public.app_settings
  for select to anon
  using (key in ('facility', 'allowed_domains'));

create policy settings_read_authenticated on public.app_settings
  for select to authenticated
  using (key <> 'developer_email');

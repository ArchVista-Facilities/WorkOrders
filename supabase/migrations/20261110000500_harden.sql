-- =============================================================================
-- AVBH Work Orders — 005 hardening: anonymous callers can reach only log_error()
-- (browser errors on the sign-in page). Authorization helpers are signed-in only.
-- =============================================================================
revoke execute on function public.has_perm(text) from public, anon;
revoke execute on function public.is_active_user() from public, anon;
revoke execute on function public.is_superuser() from public, anon;
revoke execute on function public.can_see_wo(bigint) from public, anon;
revoke execute on function public.can_see_wo_path(text) from public, anon;
revoke execute on function public.require_perm(text) from public, anon;
revoke execute on function public.require_active() from public, anon;
grant execute on function public.has_perm(text), public.is_active_user(), public.is_superuser(), public.can_see_wo(bigint),
  public.can_see_wo_path(text), public.require_perm(text), public.require_active() to authenticated;
comment on table public.wo_sequences is 'Internal counter for WO numbers; written only by wo_next_number(). No client access by design.';

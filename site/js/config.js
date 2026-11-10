/**
 * Deployment configuration.
 *
 * The publishable key is designed to be public: it only identifies the project.
 * Every permission is enforced in the database (Row Level Security + checked
 * RPC functions), so shipping this key in a static site is the intended model.
 * Never put a server-side secret key in this file (CI blocks it).
 */
export const SUPABASE_URL = 'https://ifthmeicriftzfbjmurk.supabase.co';
export const SUPABASE_KEY = 'sb_publishable__VFtz2mvZxXHXxkLEBTsXA_FcEcv4_e';

export const APP = Object.freeze({
  name: 'AVBH Work Order Management',
  version: '2.0.0',
  /** Client-side automatic logoff after this many idle minutes. */
  sessionIdleMinutes: 30,
  /** Password policy enforced in the UI (also set it in Supabase → Auth → Password requirements). */
  minPasswordLength: 12,
});

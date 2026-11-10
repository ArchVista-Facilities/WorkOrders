/**
 * Browser error capture → log_error() RPC (via the api adapter).
 * Deduplicates within a page load and caps volume so a render loop cannot
 * flood the server.
 */

import { api } from './api.js';

const sent = new Map();
const MAX_PER_MESSAGE = 3;
const MAX_TOTAL = 25;
let total = 0;

export function reportClientError(payload) {
  try {
    const key = String(payload.message).slice(0, 200);
    const n = sent.get(key) || 0;
    if (n >= MAX_PER_MESSAGE || total >= MAX_TOTAL) return;
    sent.set(key, n + 1);
    total += 1;
    api('/errors/client', { method: 'POST', body: { ...payload, url: location.pathname + location.hash } }).catch(() => {});
  } catch {
    /* never throw from the reporter */
  }
}

window.addEventListener('error', (e) => {
  // Resource load errors (img/script) have no message; report those too.
  if (e.error || e.message) {
    reportClientError({ kind: 'error', message: e.message || String(e.error), stack: e.error && e.error.stack, file: e.filename, line: e.lineno, col: e.colno });
  } else if (e.target && e.target.tagName && e.target.tagName !== 'IMG') {
    reportClientError({ kind: 'resource', message: `Failed to load ${e.target.tagName.toLowerCase()}: ${e.target.src || e.target.href}` });
  }
}, true);

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason || {};
  // API errors are already logged server-side when they matter (5xx); skip expected 4xx.
  if (r && typeof r.status === 'number' && r.status < 500) return;
  reportClientError({ kind: 'unhandledrejection', message: r.message || String(r), stack: r.stack });
});

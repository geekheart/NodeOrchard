const PREFIX = 'workbench.pending-notice-dismissals:v1:';
const LIMIT = 256;
const valid = key => typeof key === 'string' && key.length > 0 && key.length <= 256;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(Object.getOwnPropertyDescriptor(value, key)?.value)])) : value;

// A compact presentation identity, never an authorization or review token.
// Callers supply IDs and versions only; no message, command or artifact body.
export function pendingNoticeKey(kind, ...parts) {
  const serialized = JSON.stringify(canonical([kind, ...parts]));
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index++) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `pn1:${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}:${serialized.length}`;
}

export function requestNoticeKey(request) {
  return pendingNoticeKey('request', request.sessionId, request.params?.session_id, request.id, request.method, request.createdAt || request.openedAt);
}

// Browser-only display preferences. Hiding never acknowledges a request,
// ends a conversation issue, changes a run, or approves a human review.
export class PendingNoticeDismissals {
  constructor(scope, { storage = () => globalThis.localStorage } = {}) {
    this.key = PREFIX + scope; this.storage = storage; this.hidden = new Set(); this.snapshot = undefined;
    this.read();
  }
  read() {
    try {
      const raw = this.storage()?.getItem(this.key) ?? null;
      if (raw === this.snapshot) return;
      this.snapshot = raw;
      const rows = raw ? JSON.parse(raw) : [];
      this.hidden = new Set(Array.isArray(rows) ? rows.filter(valid).slice(-LIMIT) : []);
    } catch { /* Keep the in-memory preference when storage is unavailable. */ }
  }
  save() {
    const rows = [...this.hidden].slice(-LIMIT); this.hidden = new Set(rows);
    try {
      const raw = JSON.stringify(rows); this.storage().setItem(this.key, raw); this.snapshot = raw;
    } catch { /* Closing remains usable without browser storage. */ }
  }
  isHidden(key) { this.read(); return this.hidden.has(key); }
  hide(keys) { this.read(); for (const key of keys.filter(valid)) { this.hidden.delete(key); this.hidden.add(key); } this.save(); }
  restore(keys) { this.read(); for (const key of keys) this.hidden.delete(key); this.save(); }
}

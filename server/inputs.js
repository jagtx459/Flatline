/**
 * Sanitizers for values arriving from a request body or query string. Shared by
 * index.js (endpoints, groups, settings) and targetConfig.js (action targets and
 * relays), which is why they live here rather than in either of them.
 */

export function intInRange(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function cleanString(v, maxLen) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > maxLen ? '' : s;
}

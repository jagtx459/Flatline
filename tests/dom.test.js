import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtLatency, fmtUptime } from '../public/scripts/dom.js';

test('fmtLatency formats by magnitude', () => {
  assert.equal(fmtLatency(null), '—');
  assert.equal(fmtLatency(0.4), '<1 ms');
  assert.equal(fmtLatency(12.34), '12.3 ms'); // <100 ms keeps one decimal
  assert.equal(fmtLatency(50), '50 ms');
  assert.equal(fmtLatency(250.6), '251 ms');  // >=100 ms rounds to whole
});

test('fmtUptime trims precision by band', () => {
  assert.equal(fmtUptime(null), '—');
  assert.equal(fmtUptime(100), '100%');
  assert.equal(fmtUptime(99.9), '99.90%'); // >=99 keeps two decimals
  assert.equal(fmtUptime(95.44), '95.4%'); // <99 keeps one decimal
});

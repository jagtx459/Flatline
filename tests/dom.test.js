import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fmtLatency, fmtUptime } from '../public/scripts/dom.js';
import { hostInNetwork } from '../public/scripts/net.js';

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

// The relay reach warning on the Actions page. A magic packet sent to the wrong
// network fails silently — nothing ever answers one — so this predicate is the
// only point at which picking the wrong relay is visible.

test('hostInNetwork tells inside from outside', () => {
  assert.equal(hostInNetwork('10.1.20.7', '10.1.20.0/24'), true);
  assert.equal(hostInNetwork('10.1.21.7', '10.1.20.0/24'), false);
  assert.equal(hostInNetwork('10.1.20.0', '10.1.20.0/24'), true);   // the network address itself
  assert.equal(hostInNetwork('10.1.20.255', '10.1.20.0/24'), true); // and the broadcast
  assert.equal(hostInNetwork('192.168.1.130', '192.168.1.128/25'), true);
  assert.equal(hostInNetwork('192.168.1.127', '192.168.1.128/25'), false);
  assert.equal(hostInNetwork('10.9.9.9', '0.0.0.0/0'), true);       // /0 reaches everything
  assert.equal(hostInNetwork('10.1.20.7', '10.1.20.7/32'), true);   // /32 reaches one host
  assert.equal(hostInNetwork('10.1.20.8', '10.1.20.7/32'), false);
});

// A help popover holds paragraphs, so it must never sit inside a <p>. The HTML
// parser closes an open <p> the moment it meets another one, which silently
// empties the popover and spills its paragraphs into the surrounding row — the
// page still loads, nothing throws, and the "?" just opens a blank box. Caught
// here because there is no other automated check on this markup.

test('no help popover is nested inside a <p>', () => {
  const dir = path.join(import.meta.dirname, '..', 'public');
  const offenders = [];

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    // Comments are stripped first — several of them mention <p> by name.
    const html = fs.readFileSync(path.join(dir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    // Each <p …> up to its closing tag. The popovers are the only nested-<p>
    // risk in these files, so the naive span is enough to catch it.
    for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
      if (m[1].includes('class="help"')) {
        offenders.push(`${file}: ${m[0].slice(0, 60).replace(/\s+/g, ' ')}…`);
      }
    }
  }

  assert.deepEqual(offenders, [], 'use a <span> or <div> for a title that carries a help popover');
});

test('hostInNetwork says "cannot tell" rather than guessing', () => {
  // A hostname is not resolved here, so the page explains itself instead of
  // showing a warning it cannot stand behind.
  assert.equal(hostInNetwork('nas.lan', '10.1.20.0/24'), null);
  assert.equal(hostInNetwork('', '10.1.20.0/24'), null);
  assert.equal(hostInNetwork(null, '10.1.20.0/24'), null);
  assert.equal(hostInNetwork('10.1.20.7', ''), null);
  assert.equal(hostInNetwork('10.1.20.7', null), null);
  assert.equal(hostInNetwork('10.1.20.7', '10.1.20.0'), null);      // no prefix
  assert.equal(hostInNetwork('10.1.20.7', '10.1.20.0/33'), null);   // impossible prefix
  assert.equal(hostInNetwork('10.1.300.7', '10.1.20.0/24'), null);  // not an address
  assert.equal(hostInNetwork('fe80::1', '10.1.20.0/24'), null);     // IPv6 is not handled
});

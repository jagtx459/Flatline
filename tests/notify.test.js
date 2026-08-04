import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// notify.js -> db.js opens a SQLite file at import time; point it at a throwaway
// dir so the tests never touch the real data directory. Must be set before the
// dynamic import below (static imports would evaluate db.js too early).
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-test-'));
const { parseChannelConfig, checkChannelSecrets } = await import('../server/notify.js');

test('parseChannelConfig accepts a valid Apprise channel', () => {
  const cfg = parseChannelConfig('apprise',
    { server_url: 'http://apprise:8000', config_key: 'home', tags: 'admin' }, [], {});
  assert.equal(typeof cfg, 'object');
  assert.equal(cfg.server_url, 'http://apprise:8000');
  assert.equal(cfg.config_key, 'home');
  assert.equal(cfg.tags, 'admin');
});

test('parseChannelConfig rejects bad Apprise input', () => {
  assert.equal(parseChannelConfig('apprise', {}, [], {}),
    'Apprise API server URL is required');
  assert.equal(parseChannelConfig('apprise', { server_url: 'ftp://x' }, [], {}),
    'server_url must be http(s)');
  assert.match(parseChannelConfig('apprise',
    { server_url: 'http://x', config_key: 'bad key!' }, [], {}), /config key/);
});

test('checkChannelSecrets requires a key or inline URLs for Apprise', () => {
  assert.equal(checkChannelSecrets('apprise', { config_key: 'home' }, {}), null);
  assert.equal(checkChannelSecrets('apprise', {}, { urls: 'discord://a/b' }), null);
  assert.match(checkChannelSecrets('apprise', {}, {}), /config key or one or more Apprise URLs/);
});

test('existing channel validation still holds', () => {
  assert.equal(checkChannelSecrets('webhook', {}, {}), 'url is required');
  const ntfy = parseChannelConfig('ntfy', { topic: 'flatline-alerts' }, [], {});
  assert.equal(ntfy.server_url, 'https://ntfy.sh'); // default filled in
});

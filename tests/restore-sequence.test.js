import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { restoreStep } from '../server/connectors.js';
import { startMockSsh } from '../dev/mock-ssh.js';
import { startMockTargets } from '../dev/mock-targets.js';

// The restore sequence: the restore itself (step 1), the wait, then the optional
// post-restore action (step 3). Driven through the exported restoreStep()
// against a real SSH server (dev/mock-ssh.js) and a real HTTP one
// (dev/mock-targets.js), so the ordering being asserted is the ordering that
// actually happened on the wire.
//
// These all use an ssh target, since that is the kind with a probe to wait on;
// the methods it restores with vary, which is the point — each is chosen, not
// implied by the target's kind.
//
// The wake half is tests/wake-on-lan.test.js. Here the MAC is left off unless a
// test is about the order, so nothing broadcasts on the developer's LAN.

const HOST_PASSWORD = 'host-pw';
const RESTORE_TOKEN = 'restore-tok';

let ssh;
let mock;
let base;
/** A port nothing is listening on — connections are refused immediately, which
 *  is what a host that is still off looks like. */
let deadPort;

before(async () => {
  // Echoing the command back makes the sequence's message say which step
  // produced it — a successful step reports only its output.
  ssh = await startMockSsh({
    username: 'root', password: HOST_PASSWORD,
    respond: (command) => ({ code: 0, output: `ran: ${command}` })
  });
  mock = await startMockTargets(0);
  base = `http://127.0.0.1:${mock.address().port}`;

  deadPort = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
});

after(() => {
  ssh.close();
  mock.close();
});

const secrets = { password: HOST_PASSWORD, restore_token: RESTORE_TOKEN, restore_password: 'restore-pw' };

/** A target pointing at the live mock SSH server, with a restore turned on. */
const up = (over = {}) => ({
  host: '127.0.0.1', port: ssh.address().port, username: 'root',
  auth_method: 'password', restore_enabled: 1, restore_wait_seconds: 1, ...over
});

/** The same target, pointing where nothing is listening. */
const down = (over = {}) => up({ port: deadPort, ...over });

describe('what counts as a restore at all', () => {
  test('a target with the restore switched off has nothing to do', async () => {
    const result = await restoreStep('ssh', up({ restore_enabled: 0, post_restore_kind: 'ssh', post_restore_command: 'x' }), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /no restore configured/);
  });

  test('a wake with no MAC and no action behind it has nothing to do', async () => {
    const result = await restoreStep('ssh', up({ restore_kind: 'wol' }), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /no restore configured/);
  });
});

describe('waiting for the host', () => {
  test('a host that never answers fails, naming the budget it waited out', async () => {
    const started = Date.now();
    const result = await restoreStep('ssh', down({ post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'systemctl start app' }), secrets);

    assert.equal(result.ok, false);
    assert.match(result.message, /SSH did not answer within 1s/);
    // The underlying reason is kept alongside the budget: "refused" and "timed
    // out" point at different problems.
    assert.match(result.message, /ECONNREFUSED|refused/i);
    assert.equal(Date.now() - started >= 1000, true, 'it waited the full budget out');
  });

  test('the post-restore action is not run when the host never came back', async () => {
    const before = ssh.commands.length;
    await restoreStep('ssh', down({ post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'must-not-run' }), secrets);
    assert.equal(ssh.commands.length, before, 'nothing reached a host');
    assert.equal(ssh.commands.includes('must-not-run'), false);
  });

  test('a host that answers on a later poll is waited for, not given up on', async () => {
    // The whole reason the wait exists: a machine that has just been woken
    // refuses connections for a while. Here it is off when the restore starts
    // and back by the second poll, on the same address it had before.
    const first = await startMockSsh({ username: 'root', password: HOST_PASSWORD });
    const port = first.address().port;
    await new Promise((resolve) => first.close(resolve));

    let rebooted = null;
    const timer = setTimeout(() => {
      rebooted = startMockSsh({
        username: 'root', password: HOST_PASSWORD, port,
        respond: (command) => ({ code: 0, output: `ran: ${command}` })
      });
    }, 300);

    const result = await restoreStep('ssh', {
      host: '127.0.0.1', port, username: 'root', auth_method: 'password',
      restore_enabled: 1, restore_wait_seconds: 3,
      post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'systemctl start app'
    }, secrets);

    clearTimeout(timer);
    (await rebooted)?.close();

    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /SSH answered/, 'the first refusal was not fatal');
    assert.match(result.message, /ran: systemctl start app/, 'and the action ran once it was back');
  });
});

describe('the order of the sequence', () => {
  test('the wake is reported before the wait, and the wait before the action', async () => {
    const result = await restoreStep('ssh', up({
      wol_mac: 'AA:BB:CC:DD:EE:FF',
      wol_broadcast: '127.0.0.1', // one packet to loopback — nothing leaves this host
      post_restore_kind: 'ssh', post_restore_inherit: 1,
      post_restore_command: 'systemctl start app'
    }), secrets);

    assert.equal(result.ok, true, result.message);
    const wake = result.message.indexOf('sent Wake-on-LAN');
    const answered = result.message.indexOf('SSH answered');
    const step = result.message.indexOf('ran: systemctl start app');
    assert.equal(wake >= 0 && answered > wake && step > answered, true,
      `expected wake -> wait -> action, got: ${result.message}`);
  });

  test('each part reports itself as it starts', async () => {
    // A restore answers 202 and keeps going for minutes; these labels are the
    // only thing the page has to show meanwhile.
    const phases = [];
    const result = await restoreStep('ssh', up({
      wol_mac: 'AA:BB:CC:DD:EE:FF', wol_broadcast: '127.0.0.1',
      post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'systemctl start app'
    }), secrets, undefined, null, (p) => phases.push(p));

    assert.equal(result.ok, true, result.message);
    assert.deepEqual(phases, [
      'waking AA:BB:CC:DD:EE:FF',
      'waiting up to 1s for SSH to answer',
      'running the restore command over SSH'
    ]);
  });

  test('a target that only waits reports only the wait', async () => {
    const phases = [];
    await restoreStep('ssh', up({ wol_mac: 'AA:BB:CC:DD:EE:FF', wol_broadcast: '127.0.0.1', restore_kind: 'wol' }),
      secrets, undefined, null, (p) => phases.push(p));
    assert.deepEqual(phases, ['waking AA:BB:CC:DD:EE:FF', 'waiting up to 1s for SSH to answer']);
  });

  test('a wake that fails stops the sequence there', async () => {
    // Nothing is waited for and no command is run: the host was never woken, so
    // the rest of the sequence would only wait out its budget for nothing.
    const before = ssh.commands.length;
    const result = await restoreStep('ssh', up({
      wol_mac: 'AA:BB:CC:DD:EE:FF',
      wake_mode: 'relay',
      post_restore_kind: 'ssh', post_restore_inherit: 1,
      post_restore_command: 'must-not-run'
    }), secrets, undefined, null);

    assert.equal(result.ok, false);
    assert.match(result.message, /relay no longer exists/);
    assert.equal(ssh.commands.length, before);
  });

  test('with no post-restore action, coming back is the whole restore', async () => {
    const result = await restoreStep('ssh', up({
      wol_mac: 'AA:BB:CC:DD:EE:FF', wol_broadcast: '127.0.0.1', restore_kind: 'wol'
    }), secrets);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /SSH answered/);
  });
});

describe('the post-restore action', () => {
  test('a command runs on the host that was waited for', async () => {
    const result = await restoreStep('ssh',
      up({ post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'systemctl start app' }), secrets);
    assert.equal(result.ok, true, result.message);
    assert.equal(ssh.commands.at(-1), 'systemctl start app');
  });

  test('a command that exits non-zero fails the restore', async () => {
    const failing = await startMockSsh({
      username: 'root', password: HOST_PASSWORD,
      respond: (cmd) => (cmd === 'systemctl start app' ? { code: 1, output: 'Unit not found' } : {})
    });
    const result = await restoreStep('ssh', {
      host: '127.0.0.1', port: failing.address().port, username: 'root', auth_method: 'password',
      restore_enabled: 1, restore_wait_seconds: 1,
      post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'systemctl start app'
    }, secrets);
    failing.close();

    assert.equal(result.ok, false);
    assert.match(result.message, /Unit not found/);
    assert.match(result.message, /SSH answered/, 'the host did come back — only the command failed');
  });

  test('an HTTP step authenticates with its own token, not the host login', async () => {
    // The service being resumed need not be the host that was shut down, so the
    // restore request carries restore_token / restore_password rather than the
    // credentials the sequence used to reach the machine.
    const url = `${base}/needs-auth?header=authorization&value=${encodeURIComponent(`Bearer ${RESTORE_TOKEN}`)}`;
    const result = await restoreStep('ssh', up({
      restore_kind: 'http', restore_url: url, restore_method: 'POST', restore_auth_scheme: 'bearer'
    }), secrets);

    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /-> 200/);
  });

  test('the host password is never what the HTTP step sends', async () => {
    // Same request, but the endpoint wants the host's password instead: it must
    // be refused, or the two credential sets are not actually separate.
    const url = `${base}/needs-auth?header=authorization&value=${encodeURIComponent(`Bearer ${HOST_PASSWORD}`)}`;
    const result = await restoreStep('ssh', up({
      restore_kind: 'http', restore_url: url, restore_method: 'POST', restore_auth_scheme: 'bearer'
    }), secrets);

    assert.equal(result.ok, false);
    assert.match(result.message, /-> 401/);
  });

  test('basic auth on the HTTP step uses restore_username and restore_password', async () => {
    const expected = `Basic ${Buffer.from(`svc:${secrets.restore_password}`).toString('base64')}`;
    const url = `${base}/needs-auth?header=authorization&value=${encodeURIComponent(expected)}`;
    const result = await restoreStep('ssh', up({
      restore_kind: 'http', restore_url: url, restore_method: 'POST',
      restore_auth_scheme: 'basic', restore_username: 'svc'
    }), secrets);
    assert.equal(result.ok, true, result.message);
  });

  test('the custom-header scheme sends the restore token under the configured name', async () => {
    const url = `${base}/needs-auth?header=x-api-key&value=${encodeURIComponent(RESTORE_TOKEN)}`;
    const result = await restoreStep('ssh', up({
      restore_kind: 'http', restore_url: url, restore_method: 'POST',
      restore_auth_scheme: 'header', restore_header_name: 'X-Api-Key'
    }), secrets);
    assert.equal(result.ok, true, result.message);
  });

  test('an HTTP step that is refused fails the restore, host or no host', async () => {
    const result = await restoreStep('ssh', up({
      restore_kind: 'http', restore_url: `${base}/down`, restore_method: 'POST'
    }), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /SSH answered/, 'the host came back');
    assert.match(result.message, /-> 500/, 'the service did not');
  });
});

describe('the two steps together', () => {
  test('step 1 runs before step 3, each against its own connection', async () => {
    // The shape the split exists for: an endpoint resumes the service, then a
    // command runs on a machine reached separately.
    const result = await restoreStep('ssh', up({
      restore_kind: 'http', restore_url: `${base}/up`, restore_method: 'POST',
      post_restore_kind: 'ssh',
      post_restore_host: '127.0.0.1', post_restore_port: ssh.address().port,
      post_restore_username: 'root', post_restore_auth_method: 'password',
      post_restore_command: 'systemctl start app'
    }), { ...secrets, post_restore_password: HOST_PASSWORD });

    assert.equal(result.ok, true, result.message);
    const sent = result.message.indexOf('-> 200');
    const ran = result.message.indexOf('ran: systemctl start app');
    assert.equal(sent >= 0 && ran > sent, true,
      `expected the request before the command, got: ${result.message}`);
  });

  test('step 3 is never reached when step 1 fails', async () => {
    const result = await restoreStep('ssh', up({
      restore_kind: 'http', restore_url: `${base}/down`, restore_method: 'POST',
      post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'must-not-run'
    }), secrets);

    assert.equal(result.ok, false);
    assert.match(result.message, /-> 500/);
    // The wait's own reachability probe does run over SSH; the command does not.
    assert.equal(ssh.commands.includes('must-not-run'), false);
  });

  test('step 3 carries its own credentials, not the target\'s', async () => {
    // A different login on a different machine — if the step fell back to the
    // target's password it would be refused here.
    const other = await startMockSsh({
      username: 'svc', password: 'svc-pw',
      respond: (command) => ({ code: 0, output: `ran: ${command}` })
    });
    const config = up({
      post_restore_kind: 'ssh',
      post_restore_host: '127.0.0.1', post_restore_port: other.address().port,
      post_restore_username: 'svc', post_restore_auth_method: 'password',
      post_restore_command: 'systemctl start app'
    });

    const ok = await restoreStep('ssh', config, { ...secrets, post_restore_password: 'svc-pw' });
    const refused = await restoreStep('ssh', config, secrets);
    other.close();

    assert.equal(ok.ok, true, ok.message);
    assert.match(ok.message, /ran: systemctl start app/);
    assert.equal(refused.ok, false, 'the target\'s own password is not on offer to step 3');
  });
});

describe('waking through a relay', () => {
  test('the relay runs its own command with the MAC substituted', async () => {
    const relayServer = await startMockSsh({ username: 'pi', password: 'relay-pw' });
    const relay = {
      name: 'garage-pi', kind: 'ssh',
      config: { host: '127.0.0.1', port: relayServer.address().port, username: 'pi', auth_method: 'password' },
      secrets: { password: 'relay-pw' },
      wake_command: 'wakeonlan {mac}'
    };

    const result = await restoreStep('ssh', up({
      wol_mac: 'AA:BB:CC:DD:EE:FF', wake_mode: 'relay', restore_kind: 'wol'
    }), secrets, undefined, relay);

    assert.equal(relayServer.commands.at(-1), 'wakeonlan AA:BB:CC:DD:EE:FF',
      'the packet is broadcast by a machine already on the target network');
    assert.match(result.message, /relay "garage-pi" sent Wake-on-LAN for AA:BB:CC:DD:EE:FF/);
    assert.equal(result.ok, true, result.message);
    relayServer.close();
  });

  test('every {mac} in the command is replaced, not just the first', async () => {
    const relayServer = await startMockSsh({ username: 'pi', password: 'relay-pw' });
    const relay = {
      name: 'garage-pi', kind: 'ssh',
      config: { host: '127.0.0.1', port: relayServer.address().port, username: 'pi', auth_method: 'password' },
      secrets: { password: 'relay-pw' },
      wake_command: 'wakeonlan {mac} && logger "woke {mac}"'
    };

    await restoreStep('ssh', up({ wol_mac: 'AA:BB:CC:DD:EE:FF', wake_mode: 'relay', restore_kind: 'wol' }),
      secrets, undefined, relay);

    assert.equal(relayServer.commands.at(-1), 'wakeonlan AA:BB:CC:DD:EE:FF && logger "woke AA:BB:CC:DD:EE:FF"');
    relayServer.close();
  });

  test('a relay whose command fails stops the sequence and says which relay', async () => {
    const relayServer = await startMockSsh({
      username: 'pi', password: 'relay-pw',
      respond: () => ({ code: 127, output: 'wakeonlan: not found' })
    });
    const relay = {
      name: 'garage-pi', kind: 'ssh',
      config: { host: '127.0.0.1', port: relayServer.address().port, username: 'pi', auth_method: 'password' },
      secrets: { password: 'relay-pw' },
      wake_command: 'wakeonlan {mac}'
    };

    const result = await restoreStep('ssh', up({
      wol_mac: 'AA:BB:CC:DD:EE:FF', wake_mode: 'relay', post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'must-not-run'
    }), secrets, undefined, relay);

    assert.equal(result.ok, false);
    assert.match(result.message, /relay "garage-pi" failed to wake AA:BB:CC:DD:EE:FF/);
    assert.match(result.message, /not found/);
    relayServer.close();
  });
});

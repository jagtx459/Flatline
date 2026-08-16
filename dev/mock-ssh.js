import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';

/**
 * An in-process SSH server, so the restore sequence and the relay wake can be
 * driven end to end without a machine to shut down. The companion to
 * dev/mock-targets.js: same idea, different protocol.
 *
 * It speaks enough of the protocol for what Flatline does — password auth, then
 * one `exec` per connection — and records every command it was asked to run, so
 * a test can assert on what reached the host rather than only on the result.
 *
 * The host key is generated per server. ssh2 does not accept PKCS#8, so it has
 * to be the legacy PKCS#1 PEM.
 */

export function startMockSsh({ username = 'root', password = 's3cr3t', respond = null, port = 0 } = {}) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  /** Every command this server was asked to run, in order. */
  const commands = [];

  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      const ok = ctx.method === 'password' && ctx.username === username && ctx.password === password;
      if (ok) ctx.accept(); else ctx.reject(['password']);
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          commands.push(info.command);
          const { code = 0, output = 'ok' } = respond?.(info.command) ?? {};
          const stream = acceptExec();
          if (output) stream.write(output);
          stream.exit(code);
          stream.end();
        });
      });
    });

    // A client that gives up mid-handshake is normal here (the reachability
    // poll does it on every failed attempt) and must not take the server down.
    client.on('error', () => {});
  });

  server.commands = commands;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // An explicit port is for a test that stops the host and starts it again on
    // the same address, the way a machine coming back from a shutdown does.
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

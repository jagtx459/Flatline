import http from 'node:http';

/**
 * Stand-in for the machines and services Flatline watches and acts on, so local
 * testing exercises the real code paths (real sockets, real timeouts) without
 * needing a NAS or a cluster to hand.
 *
 * Routes:
 *   /up         200 immediately        — a healthy endpoint / a target that succeeds
 *   /down       500 immediately        — a failing endpoint / a target that fails
 *   /slow?ms=N  200 after N ms (2000)  — a target slow enough to watch a run progress
 *   /hang       never answers          — a target that runs into its "give up after" limit
 *   /scenario   follows the outage cycle below (200 while up, 500 while down)
 *
 * And a stand-in for a service whose API sits behind a login that mints a CSRF
 * token, for the http target's 'login' auth scheme:
 *   /login             checks credentials, then hands the token back three ways
 *                      at once (JSON body, response header, Set-Cookie) so every
 *                      extraction mode has something real to read
 *   /login-after?ms=N  503 until N ms after startup, then behaves like /login —
 *                      a service still coming up, for the restore poll
 *   /login-echo        like /login but accepts anything, and echoes the
 *                      credentials it parsed — so a test can prove a password
 *                      with quotes or ampersands in it survived the body template
 *   /protected         200 only for a request carrying both the token header and
 *                      the session cookie; 401 says which half was missing
 *
 * And, for proving which credential a request carried:
 *   /needs-auth?header=H&value=V   200 only when header H is exactly V
 *
 * Used by `npm run dev` and by the action tests. The SSH side of the same idea
 * is dev/mock-ssh.js.
 */

/**
 * The scripted outage `npm run dev` runs on a loop, so a Flatline group is seen
 * healthy first, then fails long enough to arm, elapse its grace period and
 * fire its actions, then recovers and disarms. Durations assume the seeded
 * 10s check interval, thresholds of 2, and a 1 minute grace period.
 */
export const SCENARIO = [
  { state: 'up', seconds: 60, note: 'healthy — endpoints report UP' },
  { state: 'down', seconds: 120, note: 'outage — endpoints go DOWN, groups arm, grace elapses, actions fire' },
  { state: 'up', seconds: 90, note: 'recovery — endpoints report UP again, groups disarm' }
];

/** What /login accepts. Exported so tests don't restate the strings. */
export const MOCK_LOGIN = { username: 'flatline', password: 's3cr3t' };

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (d) => { data += d; });
    req.on('end', () => resolve(data));
  });
}

/** Credentials out of a JSON body, a form-encoded body, or Basic auth — the
 *  three ways a login endpoint in the wild asks for them. */
function credentials(req, body) {
  const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
  if (basic) {
    const [username, password] = Buffer.from(basic[1], 'base64').toString().split(':');
    return { username, password };
  }
  if ((req.headers['content-type'] ?? '').includes('json')) {
    try {
      const parsed = JSON.parse(body);
      return { username: parsed.username, password: parsed.password };
    } catch { return {}; }
  }
  const form = new URLSearchParams(body);
  return { username: form.get('username'), password: form.get('password') };
}

export function startMockTargets(port = 3198, { scenario = false, onPhase = null } = {}) {
  // null when the scenario isn't running — /scenario then behaves like /up.
  let phase = null;
  // Tokens this server has minted, each paired with its session — /protected
  // only accepts a pair that came from the same login.
  const issued = new Map();
  let minted = 0;
  const startedAt = Date.now();

  /**
   * The login response. The token goes back three ways at once — in the body
   * (nested, so a JSON path has something to walk), in a header, and in a
   * cookie — because real services each pick a different one, and a mock that
   * picked one too would only ever prove that mode works.
   *
   * The session is deliberately body-only *as well as* a cookie: a client that
   * has to build `Cookie: <name>=<value from the body>` itself (Proxmox's
   * PVEAuthCookie works this way) needs a body field to build it from.
   */
  function login(res, seen = null) {
    minted += 1;
    const token = `csrf-${minted}`;
    const session = `sess-${minted}`;
    issued.set(token, session);
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-csrf-token': token,
      'set-cookie': [`session=${session}; Path=/; HttpOnly`, `csrf_token=${token}; Path=/`]
    });
    res.end(JSON.stringify({ ok: true, data: { ticket: session, csrf_token: token }, seen }));
  }

  /** Whether a request carries a token/session pair from the same login. */
  function authorized(req) {
    const token = req.headers['x-csrf-token'];
    if (!token) return 'no x-csrf-token header';
    if (!issued.has(token)) return `unknown token "${token}"`;
    const cookies = new Map((req.headers.cookie ?? '').split(';')
      .map((c) => c.trim().split('='))
      .filter(([name]) => name)
      .map(([name, ...rest]) => [name, rest.join('=')]));
    if (!cookies.has('session')) return 'no session cookie';
    if (cookies.get('session') !== issued.get(token)) return 'session cookie does not match the token';
    return null;
  }

  function enterPhase(index) {
    phase = { index, since: Date.now() };
    const step = SCENARIO[index];
    if (onPhase) onPhase(step, index);
    setTimeout(() => enterPhase((index + 1) % SCENARIO.length), step.seconds * 1000);
  }
  if (scenario) enterPhase(0);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    switch (url.pathname) {
      case '/up':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      case '/down':
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"status":"broken"}');
        return;
      case '/scenario': {
        const step = phase ? SCENARIO[phase.index] : null;
        const body = JSON.stringify({
          status: !step || step.state === 'up' ? 'ok' : 'broken',
          phase: step ? step.note : 'scenario not running'
        });
        res.writeHead(step && step.state === 'down' ? 503 : 200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      case '/slow': {
        const ms = Math.min(120_000, Number(url.searchParams.get('ms')) || 2000);
        const timer = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"status":"ok"}');
        }, ms);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      case '/hang':
        return; // deliberately never responds
      case '/login-echo':
        void readBody(req).then((body) => login(res, credentials(req, body)));
        return;
      case '/login':
      case '/login-after': {
        // A service that isn't up yet — the restore poll's whole reason to exist.
        const readyMs = Number(url.searchParams.get('ms')) || 0;
        if (url.pathname === '/login-after' && Date.now() - startedAt < readyMs) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"error":"still starting up"}');
          return;
        }
        void readBody(req).then((body) => {
          const { username, password } = credentials(req, body);
          if (username !== MOCK_LOGIN.username || password !== MOCK_LOGIN.password) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end('{"error":"bad credentials"}');
            return;
          }
          login(res);
        });
        return;
      }
      case '/needs-auth': {
        // A service that only answers to one specific credential, named in the
        // query string: ?header=authorization&value=Bearer%20abc. Lets a test
        // prove *which* credential a request carried, rather than only that it
        // succeeded — the restore step authenticates separately from the host
        // it was reached through, and that is the difference worth catching.
        const name = (url.searchParams.get('header') ?? 'authorization').toLowerCase();
        const want = url.searchParams.get('value') ?? '';
        const got = req.headers[name];
        const ok = got === want;
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(ok ? '{"status":"ok"}' : JSON.stringify({ error: `expected ${name}: ${want}`, got: got ?? null }));
        return;
      }
      case '/protected': {
        const why = authorized(req);
        res.writeHead(why ? 401 : 200, { 'content-type': 'application/json' });
        res.end(why ? JSON.stringify({ error: why }) : '{"status":"ok"}');
        return;
      }
      default:
        res.writeHead(404);
        res.end('no such mock route');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

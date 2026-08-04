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
 * Used by `npm run dev` and by test/action-runs.test.js.
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

export function startMockTargets(port = 3198, { scenario = false, onPhase = null } = {}) {
  // null when the scenario isn't running — /scenario then behaves like /up.
  let phase = null;

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

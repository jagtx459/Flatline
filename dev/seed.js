import * as store from '../server/db.js';
import { encryptSecrets } from '../server/secrets.js';
import { MOCK_LOGIN } from './mock-targets.js';

/**
 * Fills a dev database with demo data that reaches the mock targets, so every
 * screen has something real on it: endpoints that go up and down, a Flatline
 * group that actually arms, and action groups whose runs take long enough to
 * pause and cancel.
 *
 * `kubeconfig` is the one thing here that isn't a mock: when the dev instance
 * has a k3s cluster to hand (see dev/start.js), a Kubernetes target is seeded
 * against it, so Run really cordons and drains a cluster and Restore really
 * brings it back. Left out, the seed is exactly what it always was.
 *
 * Import this only after FLATLINE_DATA_DIR is set — db.js opens its file at
 * import time. See dev/start.js.
 */
export function seedDemoData(mockPort, { kubeconfig = null } = {}) {
  const mock = (route) => `http://127.0.0.1:${mockPort}${route}`;
  store.resetAll();

  const endpoints = {
    router: store.createEndpoint({
      name: 'Office router', type: 'icmp', target: '127.0.0.1',
      interval_seconds: 10, timeout_ms: 2000, down_threshold: 2, up_threshold: 2,
      expect_status: null, expect_json: null, enabled: 1
    }),
    // These two ride the scripted outage cycle (see SCENARIO in mock-targets.js):
    // up for a while, then down long enough to arm and fire, then up again.
    ups: store.createEndpoint({
      name: 'UPS management', type: 'http', target: mock('/scenario'),
      interval_seconds: 10, timeout_ms: 2000, down_threshold: 2, up_threshold: 2,
      expect_status: 200, expect_json: null, enabled: 1
    }),
    labApi: store.createEndpoint({
      name: 'Lab API', type: 'http', target: mock('/scenario'),
      interval_seconds: 10, timeout_ms: 2000, down_threshold: 2, up_threshold: 2,
      expect_status: 200, expect_json: '{"status":"ok"}', enabled: 1
    }),
    nas: store.createEndpoint({
      name: 'NAS web UI', type: 'http', target: mock('/up'),
      interval_seconds: 10, timeout_ms: 2000, down_threshold: 2, up_threshold: 2,
      expect_status: 200, expect_json: '{"status":"ok"}', enabled: 1
    })
  };

  const httpTarget = (name, route, enabled = 1) => store.createActionTarget({
    name, kind: 'http',
    config: JSON.stringify({ url: mock(route), method: 'POST', auth_scheme: 'none', restore_url: mock('/up') }),
    secret_enc: null, enabled
  });

  // An API behind a login that mints a CSRF token — the mock's /login and
  // /protected routes. Its restore waits on the login rather than the undo
  // request, so the wait is visible on screen with nothing else to set up.
  const loginTarget = store.createActionTarget({
    name: 'Hypervisor API (mock login)', kind: 'http',
    config: JSON.stringify({
      url: mock('/protected'), method: 'POST', auth_scheme: 'login',
      login_url: mock('/login'), login_method: 'POST', login_auth: 'body', login_content_type: 'json',
      login_body: '{"username":"{username}","password":"{password}"}', login_username: MOCK_LOGIN.username,
      token_source: 'json', token_json_path: 'data.csrf_token', token_header: 'X-CSRF-Token',
      session_cookie_name: 'session', session_cookie_json_path: 'data.ticket', send_cookies: 1,
      insecure_tls: 0, auto_restore: 1, restore_wait_seconds: 60,
      restore_url: mock('/protected'), restore_method: 'POST'
    }),
    secret_enc: encryptSecrets({ login_password: MOCK_LOGIN.password }),
    enabled: 1
  });

  const targets = {
    k8s: httpTarget('k8s cluster (mock)', '/slow?ms=6000'),
    nas: httpTarget('NAS (mock)', '/slow?ms=3000'),
    windows: httpTarget('Windows host (mock)', '/up'),
    flaky: httpTarget('Flaky service (mock)', '/down'),
    paused: httpTarget('Retired host (mock)', '/up', 0),
    login: loginTarget
  };

  // The real one, when there is a cluster to point it at. Deliberately not put
  // in an action group: draining a cluster on every loop of the outage scenario
  // would be a surprise. It sits on the Actions page for Run and Restore, which
  // is where you would exercise it by hand.
  if (kubeconfig) {
    targets.k3s = store.createActionTarget({
      name: 'k3s cluster (real, in Docker)', kind: 'k8s',
      config: JSON.stringify({
        auth_method: 'kubeconfig', action: 'drain',
        auto_restore: 1, restore_wait_seconds: 60,
        restore_restart_deployments: 1
      }),
      secret_enc: encryptSecrets({ kubeconfig }),
      enabled: 1
    });
  }

  const actionGroups = {
    // Slow first stage on purpose: long enough to watch, pause, and cancel.
    // Its gaps are stretched past the 5s default so they are easy to catch on
    // screen, and stage 2 holds itself open with a wait step of its own.
    graceful: store.createActionGroup({
      name: 'Graceful shutdown', on_failure: 'continue', enabled: 1,
      stages: [
        { pass_rule: 'any', on_failure: null, wait_seconds: 5, steps: [
          { target_id: targets.k8s.id, timeout_seconds: 30 },
          { target_id: targets.nas.id, timeout_seconds: 30 }
        ] },
        // The wait splits this stage: the Windows host goes down, 20s pass, and
        // only then is the cluster told — the "let it settle first" shape.
        { pass_rule: 'any', on_failure: null, wait_seconds: 15, steps: [
          { target_id: targets.windows.id, timeout_seconds: 30 },
          { wait_seconds: 20 },
          { target_id: targets.k8s.id, timeout_seconds: 30 }
        ] },
        { pass_rule: 'any', on_failure: null, wait_seconds: 10,
          steps: [{ target_id: targets.nas.id, timeout_seconds: 30 }] }
      ]
    }),
    // Stage 1 always fails and stops the sequence — the "stopped early" path.
    failing: store.createActionGroup({
      name: 'Failure demo', on_failure: 'continue', enabled: 1,
      stages: [
        { pass_rule: 'any', on_failure: 'stop', wait_seconds: 5,
          steps: [{ target_id: targets.flaky.id, timeout_seconds: 10 }] },
        { pass_rule: 'any', on_failure: null, wait_seconds: 5,
          steps: [{ target_id: targets.windows.id, timeout_seconds: 10 }] }
      ]
    }),
    // No gaps anywhere: the "get out of the way now" shape.
    quick: store.createActionGroup({
      name: 'Quick notify', on_failure: 'continue', enabled: 1,
      stages: [{ pass_rule: 'any', on_failure: null, wait_seconds: 0,
        steps: [{ target_id: targets.windows.id, timeout_seconds: 10 }] }]
    })
  };

  // ALL mode: both members ride the scenario, so they fail together and the
  // group arms only during the outage phase.
  store.createFlatlineGroup({
    name: 'Power loss', grace_minutes: 1, mode: 'all', enabled: 1,
    endpoint_ids: [endpoints.ups.id, endpoints.labApi.id],
    action_group_ids: [actionGroups.graceful.id]
  });
  // ANY mode: the always-up NAS never trips it, so this one arms the moment
  // the scenario takes Lab API down — and recovers with it.
  store.createFlatlineGroup({
    name: 'Lab services', grace_minutes: 1, mode: 'any', enabled: 1,
    endpoint_ids: [endpoints.nas.id, endpoints.labApi.id],
    action_group_ids: [actionGroups.failing.id, actionGroups.quick.id]
  });

  return {
    endpoints: Object.keys(endpoints).length,
    targets: Object.keys(targets).length,
    action_groups: Object.keys(actionGroups).length,
    flatline_groups: 2
  };
}

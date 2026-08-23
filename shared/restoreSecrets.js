/**
 * The credential fields a restore carries when it connects somewhere of its own,
 * per method — separately for the two steps that can each connect somewhere.
 *
 * The names are deliberately the method's own field names under the step's
 * prefix, so resolving them is a rename and nothing more (see connectors.js
 * restoreConnection).
 *
 * Both sides need this list and they must not drift: the server uses it to
 * decide which secrets a target may keep (targetConfig.js secretFieldsFor), and
 * the Actions page uses it to decide which credential inputs to send. Node
 * imports this by path; the browser gets it at /shared/restoreSecrets.js (see
 * the static cache in server/index.js).
 */

const SECRETS_BY_KIND = {
  ssh: ['password', 'private_key', 'passphrase', 'sudo_password'],
  winrm: ['password'],
  k8s: ['token', 'kubeconfig'],
  http: ['token', 'password']
};

const prefixed = (prefix, kinds) => Object.fromEntries(
  kinds.map((kind) => [kind, SECRETS_BY_KIND[kind].map((field) => prefix + field)]));

/** Step 1, the restore itself. Only the methods that can bring something back
 *  from nothing are on offer there — a wake carries no credentials of its own. */
export const RESTORE_SECRETS_BY_KIND = { wol: [], ...prefixed('restore_', ['k8s', 'http']) };

/** Step 3, the optional post-restore action, which runs once step 1 is done and
 *  may talk to something else entirely. */
export const POST_RESTORE_SECRETS_BY_KIND = {
  none: [], ...prefixed('post_restore_', ['ssh', 'winrm', 'k8s', 'http'])
};

/** Every restore credential name, whichever step and method — what the form sends. */
export const RESTORE_SECRET_FIELDS = [...new Set([
  ...Object.values(RESTORE_SECRETS_BY_KIND).flat(),
  ...Object.values(POST_RESTORE_SECRETS_BY_KIND).flat()
])];

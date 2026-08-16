/**
 * The credential fields a restore carries when it connects somewhere of its own,
 * per restore method.
 *
 * The names are deliberately the method's own field names with a `restore_`
 * prefix, so resolving them is a rename and nothing more (see connectors.js
 * restoreConnection).
 *
 * Both sides need this list and they must not drift: the server uses it to
 * decide which secrets a target may keep (targetConfig.js secretFieldsFor), and
 * the Actions page uses it to decide which credential inputs to send. Node
 * imports this by path; the browser gets it at /shared/restoreSecrets.js (see
 * the static cache in server/index.js).
 */
export const RESTORE_SECRETS_BY_KIND = {
  none: [],
  ssh: ['restore_password', 'restore_private_key', 'restore_passphrase', 'restore_sudo_password'],
  winrm: ['restore_password'],
  k8s: ['restore_token', 'restore_kubeconfig'],
  http: ['restore_token', 'restore_password']
};

/** Every restore credential name, whatever the method — what the form sends. */
export const RESTORE_SECRET_FIELDS = [...new Set(Object.values(RESTORE_SECRETS_BY_KIND).flat())];

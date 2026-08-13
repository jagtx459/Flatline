/**
 * Address arithmetic for the Actions page's relay picker. Its own module so it
 * can be unit-tested: actions.js reaches for `document` as it loads, and cannot
 * be imported outside a browser.
 */

/** Dotted-quad -> unsigned 32-bit, or null when it isn't four 0-255 octets —
 *  which is also how a hostname (rather than an IP) is detected. */
function ipToInt(ip) {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out * 256) + n;
  }
  return out;
}

/** Whether `host` falls inside a relay's CIDR. null when it can't be told —
 *  a hostname rather than an address, which Flatline will not resolve here. */
export function hostInNetwork(host, cidr) {
  const [net, bits] = String(cidr ?? '').split('/');
  const addr = ipToInt(String(host ?? ''));
  const base = ipToInt(net ?? '');
  const prefix = Number(bits);
  if (addr === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  if (prefix === 0) return true;
  const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
  return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
}

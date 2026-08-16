/**
 * IPv4 address arithmetic, used on both sides of the wire.
 *
 * The server needs it to normalise a relay's network to its network address
 * (targetConfig.js parseRelayNetwork); the Actions page needs it to warn when
 * the relay you picked cannot reach the host you are trying to wake. Same
 * arithmetic, so it lives here rather than twice.
 *
 * Node imports this by path; the browser gets it at /shared/net.js (see the
 * static cache in server/index.js).
 */

/**
 * Dotted-quad -> unsigned 32-bit, or null when it isn't four 0-255 octets —
 * which is also how a hostname (rather than an IP) is detected.
 */
export function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    // Reject '', '1e2', '01x' and anything else Number() would be lenient about.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out * 256) + n;
  }
  return out;
}

export function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** The 32-bit mask for a prefix length, as an unsigned int. /0 is all zeroes. */
export function prefixMask(bits) {
  return bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0;
}

/**
 * Whether `host` falls inside a relay's CIDR. null when it can't be told —
 * a hostname rather than an address, which Flatline will not resolve here.
 */
export function hostInNetwork(host, cidr) {
  const [net, bits] = String(cidr ?? '').split('/');
  const addr = ipToInt(String(host ?? ''));
  const base = ipToInt(net ?? '');
  const prefix = Number(bits);
  if (addr === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  if (prefix === 0) return true;
  const mask = prefixMask(prefix);
  return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
}

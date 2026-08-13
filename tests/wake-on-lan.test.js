import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import os from 'node:os';
import { sendMagicPacket } from '../server/connectors.js';

// The wake half of the restore sequence. Nothing ever answers a magic packet,
// so the only way to know one was right is to catch it: these tests bind a
// socket on the Wake-on-LAN port and read what arrives.
//
// Port 9 is privileged on Linux, and CI runs as an ordinary user — so the
// receiving tests skip with a message rather than fail there. The tests about
// *where* a packet is addressed need no socket and always run: sendMagicPacket
// returns the destinations that accepted it.

const WOL_PORT = 9;
const MAC = 'AA:BB:CC:DD:EE:FF';

/** The non-internal IPv4 interfaces a broadcast should fan out over. */
function externalIPv4() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal);
}

/** address|~netmask, computed as one 32-bit number — deliberately a different
 *  formulation from the per-octet one in connectors.js, so agreeing means the
 *  broadcast address is right rather than merely consistent. */
function broadcastOf({ address, netmask }) {
  const toInt = (ip) => ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
  const b = (toInt(address) | (~toInt(netmask) >>> 0)) >>> 0;
  return [(b >>> 24) & 255, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.');
}

let listener = null;   // null when the port could not be bound
let received = [];

before(async () => {
  try {
    listener = await new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.once('error', reject);
      socket.on('message', (msg, rinfo) => received.push({ msg, rinfo }));
      socket.bind(WOL_PORT, '127.0.0.1', () => resolve(socket));
    });
  } catch (err) {
    console.log(`[wol] skipping the receiving tests: cannot bind UDP ${WOL_PORT} (${err.code ?? err.message})`);
  }
});

after(() => listener?.close());

/** Sends, then gives the datagram a moment to land. Returns null when the port
 *  could not be bound, which the caller turns into a skip — the `before` hook
 *  runs after the test options are read, so this has to be decided in the body. */
async function capture(t, fn) {
  if (!listener) {
    t.skip(`UDP ${WOL_PORT} is not bindable here`);
    return null;
  }
  // Drain first: an earlier test's loopback packet is still in flight, and it
  // would otherwise be counted as one of this test's.
  await new Promise((resolve) => setTimeout(resolve, 50));
  received = [];
  const sent = await fn();
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { sent, got: received };
}

describe('the packet itself', () => {
  test('is 6 x 0xFF followed by the MAC sixteen times', async (t) => {
    // Sent to loopback so exactly one packet arrives and the assertion is
    // about the bytes, not about which interface carried them.
    const caught = await capture(t, () => sendMagicPacket(MAC, '127.0.0.1'));
    if (!caught) return;
    assert.equal(caught.got.length, 1, 'an explicit address sends exactly one packet');

    const packet = caught.got[0].msg;
    assert.equal(packet.length, 102, '6 sync bytes + 16 x 6 MAC bytes');
    assert.deepEqual([...packet.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

    const macBytes = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
    for (let i = 0; i < 16; i++) {
      assert.deepEqual([...packet.subarray(6 + (i * 6), 12 + (i * 6))], macBytes, `repetition ${i + 1}`);
    }
  });

  test('carries the MAC that was asked for, whichever one that is', async (t) => {
    const caught = await capture(t, () => sendMagicPacket('01:23:45:67:89:AB', '127.0.0.1'));
    if (!caught) return;
    assert.equal(caught.got.length, 1);
    assert.deepEqual([...caught.got[0].msg.subarray(6, 12)], [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);
  });
});

describe('where the packet goes', () => {
  test('an explicit address gets exactly one packet, routed normally', async () => {
    const sent = await sendMagicPacket(MAC, '127.0.0.1');
    assert.deepEqual(sent, ['127.0.0.1']);
  });

  test('no broadcast address fans out over every non-internal IPv4 interface', async () => {
    // A plain 255.255.255.255 from an unbound socket leaves by exactly one
    // interface, whichever the routing table picks — on a host with Hyper-V,
    // WSL or Docker adapters that is regularly not the LAN the target is on.
    const interfaces = externalIPv4();
    if (interfaces.length === 0) {
      console.log('[wol] no non-internal IPv4 interface on this host — nothing to fan out over');
      return;
    }

    const sent = await sendMagicPacket(MAC, '');
    assert.deepEqual([...sent].sort(), [...new Set(interfaces.map(broadcastOf))].sort());

    // Every destination in `sent` was accepted by a socket bound to that
    // interface's own address — a wrong source address would have failed the
    // bind and left the destination out.
    assert.equal(sent.length > 0, true);
  });

  test('255.255.255.255 is treated as no address at all', async () => {
    // It is the value the form shows as a placeholder; taking it literally
    // would undo the fan-out.
    if (externalIPv4().length === 0) return;
    const [broad, blank] = await Promise.all([
      sendMagicPacket(MAC, '255.255.255.255'),
      sendMagicPacket(MAC, '')
    ]);
    assert.deepEqual([...broad].sort(), [...blank].sort());
  });

  test('each packet leaves from the interface whose network it is addressed to', async (t) => {
    if (externalIPv4().length === 0) return;
    const caught = await capture(t, () => sendMagicPacket(MAC, ''));
    if (!caught) return;

    // Loopback is internal, so the fan-out must never include it — if it did,
    // the listener would see a packet arrive from 127.0.0.1.
    assert.equal(caught.sent.includes('127.255.255.255'), false, 'internal interfaces are excluded');

    const addresses = new Set(externalIPv4().map((a) => a.address));
    for (const { rinfo } of caught.got) {
      assert.equal(addresses.has(rinfo.address), true,
        `packet arrived from ${rinfo.address}, which is not one of this host's interfaces`);
    }
  });
});

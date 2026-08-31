import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

import { winrmExec } from '../server/winrm.js';

// WinRM's HTTPS transport. Over plain HTTP the SOAP body is sealed with the
// NTLM session key, so a mock would have to implement the whole NTLM cipher
// state; over HTTPS the body goes in the clear and TLS does the encrypting,
// which is exactly what makes this side testable — the mock host below speaks
// no crypto at all beyond the TLS the runtime gives it.
//
// So these tests are about the transport fork, not about NTLM: which module
// makes the request, what content type the body carries, what the WS-Addressing
// To header says, and how the certificate is verified.

// Self-signed, CN=localhost, SAN localhost + 127.0.0.1, expires 2126. Checked in
// rather than generated so the suite needs no openssl.
const CERT = `-----BEGIN CERTIFICATE-----
MIIDBjCCAe6gAwIBAgIUQ+FdkVxVvMPAOH8GUsaiy1TS5ZwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgzMTAwNDAzM1oYDzIxMjYw
ODA3MDA0MDMzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCxqkEmo1JQZZtso5PpI5sTsGL7asPaxv74R5vO7pnE
JtjU2SmBI0ZZOADDUodBwwUTZq5ILakR6xJspbFgyrj/NaF8kM2qan58VQDtvpUL
TPntujxXi9XoSYVLcSZdSgmf+GLo6zSwxph1Ay+tTni4LG435y5ocCc1jZ4ol5az
UJharLGImVlOJTTxPffmEHfKO4Fh4oJ9QwmlHd/x9dB2huElQpN3HXz9+ELlKnKm
u8L5oGXHAJ5tmg2F5/5ygfSKNxoJC8d5j3SbibwoIb89d8SsKrQsl1r56mWemCwB
3eeBLW07mPgad4kNNoRFAuLYvc5xsXlZADv4BZoaj9mHAgMBAAGjTjBMMA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMB0GA1UdDgQW
BBTJ28B5z2dhndcLAZP3Yf4+HrLykTANBgkqhkiG9w0BAQsFAAOCAQEAJCyBInRJ
uTjYQbLogScNWTJFF/ZnazB2YWTDzecrJ+SRMt/Q9XjC/wF5cCT8eeL9RV9jAPQ8
UgwO8qwDQaTZAFZyS3v6nOaL2PC/63YM45Z/IvmbEIco5i/OxxkW8uWp3Mt58eT4
vV++M+xr8DHZA38Hiuq2QsVA6LvLi7VG/guPB0P0pYLGDdR2nZFVl8kSq6Pflpnj
52LdZEOZlD4AT15fTOy7s1+bcGWDSxvG0nSDUqhXjqYgNVpJTOyrK6FG4mmfeSQB
yBa5O628g/Psjlxt1AxgpTrakwNsEjZZfJZR+OEEH1g6m0LUYwo7vSdwNL62CnAq
avv0dfIYtaHUkQ==
-----END CERTIFICATE-----`;

// An unrelated CA, for the pinning case — same subject, different key.
const OTHER_CERT = `-----BEGIN CERTIFICATE-----
MIIDBjCCAe6gAwIBAgIUYn4YbCYeru2CPms4Ojd+/4G7GJwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgzMTAwNDkzNFoYDzIxMjYw
ODA3MDA0OTM0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCiWqY4kqMyKZAc9LHe2HjW+FWLq+nESyd8GFTgLQmo
ICZ4dYIJB01EmGsY6JK2b+tg0RmGXw4reZKAoonrWl7jBVxCfP0+REZS6ip5iM4u
QKa/sLLlzSytrj2IJg5znQukWGUMN2pYpyYAOWNWZN+fCSfihkgYUvJaFFK7sdhz
O4wQ6NT6ZmBo5m6Ba1kvQ5pLXx8K8VKYPqA1UPvxnUf8WO8zpzyzmXX9//zlOH/N
nbeWeGCKNOu+xm7f/VaIliwQeZyf+CqNcfDCE+5tptd72ZEtDUckSV52DGY8L8vj
EpLta1tI+Kvc0gQrcGSovwHOF9LVMCDIEkJw67O63vxRAgMBAAGjTjBMMA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMB0GA1UdDgQW
BBTzsL1m5OCR6v9mz0culeufCVP9/zANBgkqhkiG9w0BAQsFAAOCAQEAg4ocXqsr
20i+6PXTxhbsKdYxUn+6S517oiJn/eMEE1wHS9pp0+NRpUBs4UXyNo0HOv3YiMP2
fQWCekqyJg7SV1AtKKDwXuao8dGVWKiSRFqHTKOSQ3u141pkEp1wxH/NLjklY5jw
Q3TvEfWtVsswXDPz9SLCkVCM2KsyiqIYKQe4PijRKwWMwRrGWwjCwb7TQcfQ1rDB
fx/kmIUfOsMuVpKWXFw3IPE2kax9UCRuB/Bt0i/zMrrfnYwvqkP8k7LaFRVuzgPn
nuxbtSW9P9Zt2+fY6db+u+gfSMDW2tw9ir/oFz4M6hONHrfMYpkbJgnFrmjxtX92
lH52lmQhTZIuMA==
-----END CERTIFICATE-----`;

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEugIBADANBgkqhkiG9w0BAQEFAASCBKQwggSgAgEAAoIBAQCxqkEmo1JQZZts
o5PpI5sTsGL7asPaxv74R5vO7pnEJtjU2SmBI0ZZOADDUodBwwUTZq5ILakR6xJs
pbFgyrj/NaF8kM2qan58VQDtvpULTPntujxXi9XoSYVLcSZdSgmf+GLo6zSwxph1
Ay+tTni4LG435y5ocCc1jZ4ol5azUJharLGImVlOJTTxPffmEHfKO4Fh4oJ9Qwml
Hd/x9dB2huElQpN3HXz9+ELlKnKmu8L5oGXHAJ5tmg2F5/5ygfSKNxoJC8d5j3Sb
ibwoIb89d8SsKrQsl1r56mWemCwB3eeBLW07mPgad4kNNoRFAuLYvc5xsXlZADv4
BZoaj9mHAgMBAAECgf8Jtxmwr3HaEXO2KtxSZOPnjuosQsfsSFjipSqaKHt2xmxm
h0zK5Q/Hwck5fDaxk91rXK2YdYvGiSjfaaL0O+wALXgL2L7zDL51i1W0ng8VllJ1
3XZlUyqdN2j+84PNUQ+qfk1YsWchDWCfXetveBH8Gxvh5kdihITchOqxDm3Kkg9M
JQMjWJTFPvXDhQhZhPywtx5kJFfrFuxWHNMnnl0+rJFPexkK+lGHRUYaMOIGCE8w
IbBEqVojv4YQ47JZO+JbAq1EaEbJUGEfB7WSGydRe1ADqNZG+0PdcovfuuiPrFx0
oQjQp2F+07Kx59rNyag90uu3FecAJjBG8I8FEK0CgYEA2zyOVcA9C84q4ba+qlls
JYJWTRrGMNXubusfjJbvz56Oh29d+u+Y3zOZjKVs81QOurc51k+8Exw4R0J2rI9R
+93qtqug0xl7C2w4Hbp+aynl1WRcEdl8v4tK7pCkzJ9tm+SzHfEchy1ZlixM8ieA
+h8MeAocorURwMd6ozJ2y8MCgYEAz3UbThLyNORqj4XPY2W/hgiX02Xet7Q4hXrc
idZC1l6KIn4gvOZvQSQtELkz2hoUAnhM1j0BYXwly8sTldSnupWCvx6OKSrdxIbM
Zq6WUE+b/N1vxnBYCylYyhK/g7595PFKxMObmqLVGSWyKDIks2hDAnmldKQpRMn9
344gku0CgYANWBk9xO6ySkE37dybF8hKXC2OkeOgU1Uo8SzBbOp506fPPIsW3ACN
DWH6OpNwGByxZrehgMbsztnqFHSOukZ+Mxq3NakbUEC6CEM+I/zP3wP7QhmMiJVc
P0k3ThyJy+ZrB7eTSfq3i54ZUub4Ekl6b+tdXxgxGx5SgpHHXyn16wKBgFdISO2n
MPop499wh9mk9Fh7Aw2w/WxCycj28RSY7dPtQKbUdAel18cLZl5z3Sn08Ng9Lu6w
CgWuyuQcE6hlKRBqWPD59QvC+jz2DcdhyuINLG7N53oQyCoiAjY6fxL5sVQCZNe2
CKCdw5Rp9LPOrPxCcHb5ITCa5LYJWeOVk4TdAoGAMpcujbbPVGdjU5NIyWa6opin
uY9ru+bfuuzPCqFFTt2JPpM0jgN7q/juyxwFFG+X59jS1bd5cDNhjOMtGQRLkPnx
GZZfvhhGc86wq4JcHUNKJFZ7CLPLGLCTVu8o1iOgXHLsaHyxm5meFoguEI2V9c+n
p5Lq/CzGHTycChAU4NY=
-----END PRIVATE KEY-----`;

/** A CHALLENGE_MESSAGE just complete enough for parseChallenge: an 8-byte
 *  server challenge at 24, and a target info block located by the fields at
 *  40/44. The client derives everything else itself. */
function challengeMessage() {
  const avPairs = [];
  const pair = (id, val) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(id, 0);
    h.writeUInt16LE(val.length, 2);
    avPairs.push(h, val);
  };
  pair(2, Buffer.from('WORKGROUP', 'utf16le')); // MsvAvNbDomainName
  const ft = (BigInt(Date.now()) + 11644473600000n) * 10000n;
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(ft, 0);
  pair(7, ts);                                  // MsvAvTimestamp
  avPairs.push(Buffer.alloc(4));                // terminator
  const targetInfo = Buffer.concat(avPairs);

  const head = Buffer.alloc(56);
  head.write('NTLMSSP\0', 0, 'latin1');
  head.writeUInt32LE(2, 8);
  crypto.randomBytes(8).copy(head, 24);
  head.writeUInt16LE(targetInfo.length, 40);
  head.writeUInt16LE(targetInfo.length, 42);
  head.writeUInt32LE(56, 44);
  return Buffer.concat([head, targetInfo]);
}

const soap = (body) => '<?xml version="1.0"?><s:Envelope'
  + ' xmlns:s="http://www.w3.org/2003/05/soap-envelope"'
  + ' xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">'
  + `<s:Body>${body}</s:Body></s:Envelope>`;

/**
 * A WinRM HTTPS listener: 401 with a challenge first, then plaintext SOAP for
 * the shell, the command and one Receive that reports Done. Records every
 * request so a test can assert on what the client actually put on the wire —
 * the handler itself never asserts, or a failure would hang the response
 * instead of failing the test.
 */
function startMockHost() {
  const seen = [];
  const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ headers: req.headers, body });

      // No AUTHENTICATE yet: answer the NEGOTIATE with a challenge. The client
      // sends that first leg with no body at all.
      if (!body) {
        res.writeHead(401, {
          'WWW-Authenticate': `Negotiate ${challengeMessage().toString('base64')}`,
          'Content-Length': '0'
        });
        res.end();
        return;
      }

      let payload;
      if (body.includes('<rsp:Shell>')) {
        payload = '<rsp:Shell><rsp:ShellId>SHELL-1</rsp:ShellId></rsp:Shell>';
      } else if (body.includes('<rsp:CommandLine>')) {
        payload = '<rsp:CommandResponse><rsp:CommandId>CMD-1</rsp:CommandId></rsp:CommandResponse>';
      } else if (body.includes('<rsp:Receive>')) {
        payload = '<rsp:ReceiveResponse>'
          + `<rsp:Stream Name="stdout" CommandId="CMD-1">${Buffer.from('flatline-ok\n').toString('base64')}</rsp:Stream>`
          + '<rsp:CommandState State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done">'
          + '<rsp:ExitCode>0</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse>';
      } else {
        payload = '<rsp:DeleteResponse/>'; // the shell teardown
      }
      const out = Buffer.from(soap(payload), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/soap+xml;charset=UTF-8', 'Content-Length': String(out.length) });
      res.end(out);
    });
  });
  return { server, seen };
}

describe('winrm over https', () => {
  let server, seen, port;

  before(async () => {
    ({ server, seen } = startMockHost());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => server.close());

  const exec = (over = {}) => winrmExec(
    { host: 'localhost', port, username: 'admin', use_tls: 1, ca_cert: CERT, ...over },
    { password: 'pw' }, 'Write-Output flatline-ok', 10_000
  );

  test('a command runs end to end and its output comes back', async () => {
    seen.length = 0;
    const result = await exec();
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'flatline-ok\n');
    assert.equal(result.stderr, '');
  });

  test('the body is plain SOAP, not the NTLM-sealed multipart', async () => {
    seen.length = 0;
    await exec();
    // First request is the bodiless NEGOTIATE; the rest carry SOAP.
    const withBody = seen.filter((r) => r.body);
    assert.ok(withBody.length >= 3, 'shell, command and receive at least');
    for (const r of withBody) {
      assert.equal(r.headers['content-type'], 'application/soap+xml;charset=UTF-8');
      assert.match(r.body, /^<\?xml/, 'the SOAP envelope is the body itself');
      assert.doesNotMatch(r.body, /Encrypted Boundary/, 'no message sealing over TLS');
    }
  });

  test('the WS-Addressing To header names the https scheme', async () => {
    seen.length = 0;
    await exec();
    const shell = seen.find((r) => r.body.includes('<rsp:Shell>'));
    assert.match(shell.body, new RegExp(`<a:To>https://localhost:${port}/wsman</a:To>`));
  });

  test('only the shell-create carries the NTLM token — NTLM authenticates the connection', async () => {
    seen.length = 0;
    await exec();
    const negotiate = seen[0];
    assert.equal(negotiate.body, '', 'the handshake opens with a bodiless request');
    assert.match(negotiate.headers.authorization, /^Negotiate /);

    const shell = seen.find((r) => r.body.includes('<rsp:Shell>'));
    assert.match(shell.headers.authorization, /^Negotiate /, 'AUTHENTICATE rides with the shell create');

    const receive = seen.find((r) => r.body.includes('<rsp:Receive>'));
    assert.equal(receive.headers.authorization, undefined, 'the socket is already authenticated');
  });

  test('a certificate outside the pinned CA is refused', async () => {
    // Pinning to a CA that did not sign this host's certificate must fail the
    // handshake rather than fall back to the system store.
    await assert.rejects(exec({ ca_cert: OTHER_CERT }), /certificate|handshake|SSL|TLS/i);
  });

  test('an untrusted certificate is refused unless it is opted into', async () => {
    // No CA pinned: the self-signed certificate is not in the system store.
    await assert.rejects(exec({ ca_cert: undefined }), /self.signed|certificate/i);
    assert.equal((await exec({ ca_cert: undefined, insecure_tls: 1 })).code, 0);
  });

  test('an address in the certificate SAN is accepted', async () => {
    assert.equal((await exec({ host: '127.0.0.1' })).code, 0);
  });
});

// The other half of the fork. A mock cannot answer this path without
// re-implementing the NTLM cipher state, so the test stops at the first sealed
// request and checks only that it is sealed — which is the part the HTTPS work
// could have broken.
describe('winrm over plain http still seals the body', () => {
  let server, seen, port;

  before(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
        if (!seen[seen.length - 1].body.length) {
          res.writeHead(401, {
            'WWW-Authenticate': `Negotiate ${challengeMessage().toString('base64')}`,
            'Content-Length': '0'
          });
          res.end();
          return;
        }
        res.writeHead(500, { 'Content-Length': '0' }); // enough: the client has already sent what we assert on
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => server.close());

  test('the shell create goes out as NTLM-sealed multipart, not plain SOAP', async () => {
    await winrmExec({ host: '127.0.0.1', port, username: 'admin' }, { password: 'pw' }, 'Write-Output hi', 5000)
      .catch(() => {}); // the mock cannot decrypt a reply; only the request matters

    const sealed = seen.find((r) => r.body.length);
    assert.match(sealed.headers['content-type'], /^multipart\/encrypted;/);
    assert.match(sealed.headers['content-type'], /HTTP-SPNEGO-session-encrypted/);
    assert.match(sealed.body.toString('latin1'), /--Encrypted Boundary/);
    assert.doesNotMatch(sealed.body.toString('latin1'), /<s:Envelope/, 'the SOAP is encrypted, not readable');
  });
});

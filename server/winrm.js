import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Runs a command on a Windows host over WinRM (WS-Management SOAP on port
 * 5985) using NTLMv2 authentication with message sealing. This is the path
 * that works against a stock `Enable-PSRemoting` host: no host-side config
 * changes, local or domain accounts, and — because WinRM's default
 * AllowUnencrypted is false — every SOAP payload is RC4-encrypted with the
 * NTLM session key.
 *
 * It's all dependency-free on purpose. MD4 (the NT hash) and RC4 (the seal
 * cipher) aren't reliably available through node:crypto on OpenSSL 3, so both
 * are implemented here; MD5/HMAC-MD5 come from node:crypto.
 *
 * The command is run via `powershell.exe -EncodedCommand <base64 UTF-16LE>`,
 * which sidesteps all of WinRM's argument-splitting/quoting rules — the whole
 * command string is handed to PowerShell verbatim.
 */

const DEFAULT_PORT = 5985;
const WORKSTATION = 'FLATLINE';
const WSMAN_TIMEOUT_FAULT = '2150858793'; // ERROR_WINRM_OPERATION_TIMEOUT — means "retry Receive"

// ---------------- pure-JS crypto primitives ----------------

/** RFC 1320 MD4 — the NT hash is MD4(UTF-16LE(password)), and OpenSSL 3 no
 *  longer exposes MD4 via crypto.createHash by default. */
function md4(input) {
  const rotl = (x, c) => (x << c) | (x >>> (32 - c));
  const bytes = Buffer.from(input);
  const bitLen = bytes.length * 8;
  const padLen = (56 - ((bytes.length + 1) % 64) + 64) % 64;
  const padded = Buffer.concat([bytes, Buffer.from([0x80]), Buffer.alloc(padLen), Buffer.alloc(8)]);
  padded.writeUInt32LE(bitLen >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(bitLen / 0x100000000) >>> 0, padded.length - 4);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & y) | (x & z) | (y & z);
  const H = (x, y, z) => x ^ y ^ z;

  for (let off = 0; off < padded.length; off += 64) {
    const X = new Array(16);
    for (let i = 0; i < 16; i++) X[i] = padded.readUInt32LE(off + i * 4);
    const aa = a, bb = b, cc = c, dd = d;

    for (let i = 0; i < 16; i++) {
      a = rotl((a + F(b, c, d) + X[i]) >>> 0, [3, 7, 11, 19][i & 3]) >>> 0;
      [a, b, c, d] = [d, a, b, c];
    }
    const idx2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    for (let i = 0; i < 16; i++) {
      a = rotl((a + G(b, c, d) + X[idx2[i]] + 0x5a827999) >>> 0, [3, 5, 9, 13][i & 3]) >>> 0;
      [a, b, c, d] = [d, a, b, c];
    }
    const idx3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let i = 0; i < 16; i++) {
      a = rotl((a + H(b, c, d) + X[idx3[i]] + 0x6ed9eba1) >>> 0, [3, 9, 11, 15][i & 3]) >>> 0;
      [a, b, c, d] = [d, a, b, c];
    }
    a = (a + aa) >>> 0; b = (b + bb) >>> 0; c = (c + cc) >>> 0; d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0); out.writeUInt32LE(b, 4); out.writeUInt32LE(c, 8); out.writeUInt32LE(d, 12);
  return out;
}

/** Stateful RC4 — used as a continuous keystream per direction, so message
 *  sealing and signature-checksum encryption share one advancing handle. */
function rc4Init(key) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  return { s, i: 0, j: 0 };
}

function rc4(handle, data) {
  const s = handle.s;
  const out = Buffer.alloc(data.length);
  let { i, j } = handle;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  handle.i = i; handle.j = j;
  return out;
}

const md5 = (data) => crypto.createHash('md5').update(data).digest();
const hmacMd5 = (key, data) => crypto.createHmac('md5', key).update(data).digest();

// ---------------- NTLM messages ----------------

const NTLM = {
  UNICODE: 0x00000001, REQUEST_TARGET: 0x00000004, SIGN: 0x00000010, SEAL: 0x00000020,
  NTLM: 0x00000200, ALWAYS_SIGN: 0x00008000, EXTENDED_SESSIONSECURITY: 0x00080000,
  TARGET_INFO: 0x00800000, VERSION: 0x02000000, KEY_128: 0x20000000, KEY_EXCH: 0x40000000,
  KEY_56: 0x80000000
};
const NEGOTIATE_FLAGS = (NTLM.UNICODE | NTLM.REQUEST_TARGET | NTLM.SIGN | NTLM.SEAL | NTLM.NTLM
  | NTLM.ALWAYS_SIGN | NTLM.EXTENDED_SESSIONSECURITY | NTLM.TARGET_INFO | NTLM.VERSION
  | NTLM.KEY_128 | NTLM.KEY_EXCH | NTLM.KEY_56) >>> 0;
const VERSION = Buffer.from([10, 0, 0, 0, 0, 0, 0, 0x0f]);

function buildNegotiate() {
  const buf = Buffer.alloc(40);
  buf.write('NTLMSSP\0', 0, 'latin1');
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(NEGOTIATE_FLAGS, 12);
  VERSION.copy(buf, 32);
  return buf;
}

function parseChallenge(buf) {
  const serverChallenge = Buffer.from(buf.subarray(24, 32));
  const tiLen = buf.readUInt16LE(40);
  const tiOff = buf.readUInt32LE(44);
  const targetInfo = Buffer.from(buf.subarray(tiOff, tiOff + tiLen));
  return { serverChallenge, targetInfo };
}

function parseAvPairs(ti) {
  const pairs = [];
  let o = 0;
  while (o + 4 <= ti.length) {
    const id = ti.readUInt16LE(o);
    const len = ti.readUInt16LE(o + 2);
    if (id === 0) break;
    pairs.push({ id, val: Buffer.from(ti.subarray(o + 4, o + 4 + len)) });
    o += 4 + len;
  }
  return pairs;
}

/** Server's timestamp AV pair (MsvAvTimestamp = 7), or the current time as a
 *  Windows FILETIME if the server didn't send one. */
function targetInfoTimestamp(ti) {
  const p = parseAvPairs(ti).find((x) => x.id === 7);
  if (p && p.val.length === 8) return p.val;
  const ft = (BigInt(Date.now()) + 11644473600000n) * 10000n;
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(ft, 0);
  return b;
}

/** Re-serialize the server's target info with MsvAvFlags (6) bit 0x2 set,
 *  which signals "AUTHENTICATE carries a MIC". */
function targetInfoWithMic(ti) {
  const pairs = parseAvPairs(ti);
  const flags = pairs.find((p) => p.id === 6);
  if (flags) {
    flags.val.writeUInt32LE((flags.val.readUInt32LE(0) | 0x2) >>> 0, 0);
  } else {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(0x2, 0);
    pairs.push({ id: 6, val: b });
  }
  const chunks = [];
  for (const p of pairs) {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(p.id, 0);
    h.writeUInt16LE(p.val.length, 2);
    chunks.push(h, p.val);
  }
  chunks.push(Buffer.alloc(4)); // terminator AV pair (id 0, len 0)
  return Buffer.concat(chunks);
}

function buildAuthenticate({ lmResponse, ntResponse, domain, user, encryptedSessionKey }) {
  const domainB = Buffer.from(domain, 'utf16le');
  const userB = Buffer.from(user, 'utf16le');
  const wsB = Buffer.from(WORKSTATION, 'utf16le');
  const HEADER_LEN = 88; // through the 16-byte MIC field
  let offset = HEADER_LEN;
  const head = Buffer.alloc(HEADER_LEN);
  head.write('NTLMSSP\0', 0, 'latin1');
  head.writeUInt32LE(3, 8);
  const field = (o, data) => {
    head.writeUInt16LE(data.length, o);
    head.writeUInt16LE(data.length, o + 2);
    head.writeUInt32LE(offset, o + 4);
    offset += data.length;
  };
  field(12, lmResponse);
  field(20, ntResponse);
  field(28, domainB);
  field(36, userB);
  field(44, wsB);
  field(52, encryptedSessionKey);
  head.writeUInt32LE(NEGOTIATE_FLAGS, 60);
  VERSION.copy(head, 64);
  // MIC (offset 72, 16 bytes) stays zero until we compute it below.
  return Buffer.concat([head, lmResponse, ntResponse, domainB, userB, wsB, encryptedSessionKey]);
}

const magic = (s) => Buffer.from(`${s}\0`, 'latin1');
const SIGN_C2S = magic('session key to client-to-server signing key magic constant');
const SIGN_S2C = magic('session key to server-to-client signing key magic constant');
const SEAL_C2S = magic('session key to client-to-server sealing key magic constant');
const SEAL_S2C = magic('session key to server-to-client sealing key magic constant');

/** Runs the NTLMv2 math and returns the AUTHENTICATE message plus a session-
 *  security context (sign keys + directional RC4 handles + sequence numbers). */
function ntlmAuthenticate(negotiate, challengeMsg, { domain, username, password }) {
  const { serverChallenge, targetInfo } = parseChallenge(challengeMsg);
  const clientChallenge = crypto.randomBytes(8);

  const ntHash = md4(Buffer.from(password, 'utf16le'));
  const ntowfv2 = hmacMd5(ntHash, Buffer.from((username.toUpperCase() + domain), 'utf16le'));

  const temp = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    targetInfoTimestamp(targetInfo),
    clientChallenge,
    Buffer.from([0, 0, 0, 0]),
    targetInfoWithMic(targetInfo),
    Buffer.from([0, 0, 0, 0])
  ]);
  const ntProof = hmacMd5(ntowfv2, Buffer.concat([serverChallenge, temp]));
  const ntResponse = Buffer.concat([ntProof, temp]);
  const lmResponse = Buffer.concat([
    hmacMd5(ntowfv2, Buffer.concat([serverChallenge, clientChallenge])),
    clientChallenge
  ]);

  // Key exchange: SessionBaseKey encrypts a random ExportedSessionKey, which
  // is what actually derives the sign/seal keys.
  const sessionBaseKey = hmacMd5(ntowfv2, ntProof);
  const exportedSessionKey = crypto.randomBytes(16);
  const encryptedSessionKey = rc4(rc4Init(sessionBaseKey), exportedSessionKey);

  const authenticate = buildAuthenticate({ lmResponse, ntResponse, domain, user: username, encryptedSessionKey });
  const mic = hmacMd5(exportedSessionKey, Buffer.concat([negotiate, challengeMsg, authenticate]));
  mic.copy(authenticate, 72);

  const sec = {
    clientSigning: md5(Buffer.concat([exportedSessionKey, SIGN_C2S])),
    serverSigning: md5(Buffer.concat([exportedSessionKey, SIGN_S2C])),
    outgoing: rc4Init(md5(Buffer.concat([exportedSessionKey, SEAL_C2S]))),
    incoming: rc4Init(md5(Buffer.concat([exportedSessionKey, SEAL_S2C]))),
    outSeq: 0
  };
  return { authenticate, sec };
}

/** Seals a plaintext SOAP message: RC4 the body, then produce the 16-byte
 *  NTLM signature (checksum encrypted with the same advancing handle). */
function sealMessage(sec, message) {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32LE(sec.outSeq >>> 0, 0);
  const sealed = rc4(sec.outgoing, message);
  let checksum = hmacMd5(sec.clientSigning, Buffer.concat([seqBuf, message])).subarray(0, 8);
  checksum = rc4(sec.outgoing, checksum);
  const sig = Buffer.concat([Buffer.from([1, 0, 0, 0]), checksum, seqBuf]);
  sec.outSeq += 1;
  return { sealed, sig };
}

/** Reverses sealMessage() on a server response and verifies its signature. */
function unsealMessage(sec, sealed, sig) {
  const message = rc4(sec.incoming, sealed);
  const theirChecksum = rc4(sec.incoming, sig.subarray(4, 12));
  const seqBuf = sig.subarray(12, 16);
  const expected = hmacMd5(sec.serverSigning, Buffer.concat([seqBuf, message])).subarray(0, 8);
  if (!expected.equals(theirChecksum)) throw new Error('WinRM response signature verification failed');
  return message;
}

// ---------------- HTTP transport ----------------

function httpRequest(agent, host, port, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ agent, host, port, path: '/wsman', method: 'POST', headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

const ENCRYPTED_CONTENT_TYPE =
  'multipart/encrypted;protocol="application/HTTP-SPNEGO-session-encrypted";boundary="Encrypted Boundary"';

function wrapEncrypted(sec, xml) {
  const plaintext = Buffer.from(xml, 'utf8');
  const { sealed, sig } = sealMessage(sec, plaintext);
  const header = Buffer.from(
    '--Encrypted Boundary\r\n'
    + '\tContent-Type: application/HTTP-SPNEGO-session-encrypted\r\n'
    + `\tOriginalContent: type=application/soap+xml;charset=UTF-8;Length=${plaintext.length}\r\n`
    + '--Encrypted Boundary\r\n'
    + '\tContent-Type: application/octet-stream\r\n', 'latin1');
  const sigLen = Buffer.alloc(4);
  sigLen.writeInt32LE(sig.length, 0);
  const footer = Buffer.from('--Encrypted Boundary--\r\n', 'latin1');
  return Buffer.concat([header, sigLen, sig, sealed, footer]);
}

function unwrapEncrypted(sec, body) {
  const marker = Buffer.from('Content-Type: application/octet-stream\r\n', 'latin1');
  const idx = body.indexOf(marker);
  if (idx === -1) throw new Error('WinRM: unexpected (unencrypted?) response — check that the target is a WinRM host');
  let p = idx + marker.length;
  const sigLen = body.readInt32LE(p);
  p += 4;
  const sig = body.subarray(p, p + sigLen);
  p += sigLen;
  const lenMatch = body.toString('latin1').match(/OriginalContent:[^\r\n]*Length=(\d+)/);
  const origLen = lenMatch ? Number(lenMatch[1]) : (body.indexOf(Buffer.from('--Encrypted Boundary--', 'latin1'), p) - p);
  const sealed = body.subarray(p, p + origLen);
  return unsealMessage(sec, sealed, sig).toString('utf8');
}

// ---------------- WS-Management (WinRM) ----------------

const RESOURCE = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd';
const ACTION = {
  create: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create',
  delete: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete',
  command: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command',
  receive: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive'
};

const xmlEscape = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function envelope(conn, { action, shellId, body, options = '', operationTimeoutSec }) {
  const selector = shellId
    ? `<w:SelectorSet><w:Selector Name="ShellId">${shellId}</w:Selector></w:SelectorSet>` : '';
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"'
    + ' xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"'
    + ' xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"'
    + ' xmlns:p="http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd"'
    + ' xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">'
    + '<s:Header>'
    + `<a:To>http://${xmlEscape(conn.host)}:${conn.port}/wsman</a:To>`
    + `<w:ResourceURI s:mustUnderstand="true">${RESOURCE}</w:ResourceURI>`
    + '<a:ReplyTo><a:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>'
    + `<a:Action s:mustUnderstand="true">${action}</a:Action>`
    + '<w:MaxEnvelopeSize s:mustUnderstand="true">153600</w:MaxEnvelopeSize>'
    + `<a:MessageID>uuid:${crypto.randomUUID()}</a:MessageID>`
    + '<w:Locale xml:lang="en-US" s:mustUnderstand="false"/>'
    + '<p:DataLocale xml:lang="en-US" s:mustUnderstand="false"/>'
    + `<w:OperationTimeout>PT${operationTimeoutSec}S</w:OperationTimeout>`
    + selector + options
    + '</s:Header>'
    + `<s:Body>${body}</s:Body>`
    + '</s:Envelope>';
}

function extractFault(xml) {
  const code = xml.match(/<[fw]:WSManFault[^>]*Code="(\d+)"/)?.[1]
    ?? xml.match(/<[^>]*:Code[^>]*>\s*<[^>]*:Value>([^<]+)/)?.[1];
  const msg = xml.match(/<[fw]:Message[^>]*>([^]*?)<\/[fw]:Message>/)?.[1]
    ?? xml.match(/<[^>]*:Reason>\s*<[^>]*:Text[^>]*>([^]*?)<\/[^>]*:Text>/)?.[1];
  if (!code && !msg) return null;
  return { code, message: (msg || '').replace(/\s+/g, ' ').trim() };
}

/** Sends one encrypted SOAP request and returns { status, xml }. HTTP faults
 *  (500) still carry an encrypted body, so we decrypt before interpreting. */
async function post(conn, xml) {
  const body = wrapEncrypted(conn.sec, xml);
  const res = await httpRequest(conn.agent, conn.host, conn.port, {
    'Content-Type': ENCRYPTED_CONTENT_TYPE,
    'Content-Length': String(body.length),
    Connection: 'Keep-Alive'
  }, body, conn.timeoutMs);
  if (res.status === 401) throw new Error('WinRM authentication was rejected after the handshake');
  const respXml = unwrapEncrypted(conn.sec, res.body);
  return { status: res.status, xml: respXml };
}

async function postOrThrow(conn, xml) {
  const { status, xml: respXml } = await post(conn, xml);
  if (status >= 400) {
    const fault = extractFault(respXml);
    throw new Error(fault?.message || `WinRM SOAP fault (HTTP ${status})`);
  }
  return respXml;
}

/** NTLM negotiate → challenge → authenticate over a single kept-alive socket
 *  (NTLM authenticates the connection, not the request). */
async function authenticate(conn, creds) {
  const negotiate = buildNegotiate();
  const first = await httpRequest(conn.agent, conn.host, conn.port, {
    Authorization: `Negotiate ${negotiate.toString('base64')}`,
    'Content-Length': '0',
    Connection: 'Keep-Alive'
  }, null, conn.timeoutMs);

  if (first.status !== 401) {
    throw new Error(`WinRM did not start NTLM negotiation (HTTP ${first.status}) — is WinRM enabled on port ${conn.port}?`);
  }
  const header = [].concat(first.headers['www-authenticate'] ?? []).join(', ');
  const token = header.match(/Negotiate ([A-Za-z0-9+/=]+)/)?.[1];
  if (!token) throw new Error('WinRM did not offer NTLM/Negotiate authentication');

  const { authenticate: authMsg, sec } = ntlmAuthenticate(negotiate, Buffer.from(token, 'base64'), creds);
  conn.sec = sec;
  conn.authHeader = `Negotiate ${authMsg.toString('base64')}`;
}

/** The AUTHENTICATE message must ride along with the first encrypted request,
 *  so the shell-create doubles as completing the handshake. */
async function createShell(conn) {
  const body = '<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams>'
    + '<rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>';
  const options = '<w:OptionSet><w:Option Name="WINRS_NOPROFILE">FALSE</w:Option>'
    + '<w:Option Name="WINRS_CODEPAGE">65001</w:Option></w:OptionSet>';
  const xml = envelope(conn, { action: ACTION.create, body, options, operationTimeoutSec: conn.opTimeoutSec });

  const encrypted = wrapEncrypted(conn.sec, xml);
  const res = await httpRequest(conn.agent, conn.host, conn.port, {
    Authorization: conn.authHeader,
    'Content-Type': ENCRYPTED_CONTENT_TYPE,
    'Content-Length': String(encrypted.length),
    Connection: 'Keep-Alive'
  }, encrypted, conn.timeoutMs);
  if (res.status === 401) throw new Error('WinRM authentication failed — check the username, password, and domain');
  const respXml = unwrapEncrypted(conn.sec, res.body);
  if (res.status >= 400) throw new Error(extractFault(respXml)?.message || `WinRM shell create failed (HTTP ${res.status})`);

  const shellId = respXml.match(/<rsp:ShellId>([^<]+)<\/rsp:ShellId>/)?.[1]
    ?? respXml.match(/<w:Selector Name="ShellId">([^<]+)<\/w:Selector>/)?.[1];
  if (!shellId) throw new Error('WinRM shell created but no ShellId was returned');
  return shellId;
}

async function runCommand(conn, shellId, command) {
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const body = '<rsp:CommandLine><rsp:Command>powershell.exe</rsp:Command>'
    + '<rsp:Arguments>-NoProfile</rsp:Arguments><rsp:Arguments>-NonInteractive</rsp:Arguments>'
    + `<rsp:Arguments>-EncodedCommand</rsp:Arguments><rsp:Arguments>${encoded}</rsp:Arguments></rsp:CommandLine>`;
  const options = '<w:OptionSet><w:Option Name="WINRS_CONSOLEMODE_STDIN">TRUE</w:Option>'
    + '<w:Option Name="WINRS_SKIP_CMD_SHELL">TRUE</w:Option></w:OptionSet>';
  const xml = envelope(conn, { action: ACTION.command, shellId, body, options, operationTimeoutSec: conn.opTimeoutSec });
  const respXml = await postOrThrow(conn, xml);
  const commandId = respXml.match(/<rsp:CommandId>([^<]+)<\/rsp:CommandId>/)?.[1];
  if (!commandId) throw new Error('WinRM command started but no CommandId was returned');
  return commandId;
}

/** Polls Receive until the command reports Done, accumulating stdout/stderr.
 *  A Receive that blocks past the operation timeout comes back as a WSMan
 *  timeout fault, which just means "ask again". */
async function receiveOutput(conn, shellId, commandId, deadline) {
  let stdout = '';
  let stderr = '';
  const body = `<rsp:Receive><rsp:DesiredStream CommandId="${commandId}">stdout stderr</rsp:DesiredStream></rsp:Receive>`;

  for (;;) {
    if (Date.now() > deadline) throw new Error('WinRM command timed out waiting for output');
    const xml = envelope(conn, { action: ACTION.receive, shellId, body, operationTimeoutSec: conn.opTimeoutSec });
    const { status, xml: respXml } = await post(conn, xml);
    if (status >= 400) {
      const fault = extractFault(respXml);
      if (fault?.code === WSMAN_TIMEOUT_FAULT) continue;
      throw new Error(fault?.message || `WinRM receive failed (HTTP ${status})`);
    }

    const streamRe = /<rsp:Stream[^>]*Name="(stdout|stderr)"[^>]*>([^<]*)<\/rsp:Stream>/g;
    let m;
    while ((m = streamRe.exec(respXml)) !== null) {
      if (!m[2]) continue;
      const text = Buffer.from(m[2], 'base64').toString('utf8');
      if (m[1] === 'stdout') stdout += text; else stderr += text;
    }

    const state = respXml.match(/<rsp:CommandState[^>]*State="([^"]+)"/)?.[1];
    if (state && state.endsWith('/CommandState/Done')) {
      const exitCode = respXml.match(/<rsp:ExitCode>(\d+)<\/rsp:ExitCode>/)?.[1];
      return { code: exitCode != null ? Number(exitCode) : 0, stdout, stderr };
    }
  }
}

async function deleteShell(conn, shellId) {
  const xml = envelope(conn, { action: ACTION.delete, shellId, body: '', operationTimeoutSec: conn.opTimeoutSec });
  await postOrThrow(conn, xml);
}

/**
 * Runs `command` (as a PowerShell script) on a Windows host over WinRM.
 * Resolves to { code, stdout, stderr }; rejects on any connection, auth, or
 * protocol failure. config: { host, port?, domain?, username }, secrets:
 * { password }.
 */
export async function winrmExec(config, secrets, command, timeoutMs) {
  if (!config.host || !config.username) throw new Error('host and username are required');
  if (!secrets.password) throw new Error('no password stored for this target');

  const conn = {
    host: config.host,
    port: config.port ?? DEFAULT_PORT,
    timeoutMs,
    opTimeoutSec: Math.max(5, Math.min(60, Math.floor(timeoutMs / 1000) - 2)),
    agent: new http.Agent({ keepAlive: true, maxSockets: 1 })
  };
  const creds = { host: config.host, domain: config.domain ?? '', username: config.username, password: secrets.password };

  try {
    await authenticate(conn, creds);
    const shellId = await createShell(conn);
    try {
      const commandId = await runCommand(conn, shellId, command);
      return await receiveOutput(conn, shellId, commandId, Date.now() + timeoutMs);
    } finally {
      await deleteShell(conn, shellId).catch(() => {});
    }
  } finally {
    conn.agent.destroy();
  }
}

'use strict';

// Integrasi lokal memakai binary server/client dari source DNSTT yang dipin.
// DNSTT_NATIVE_DIR berisi dnstt-server[.exe] dan dnstt-client[.exe].
// Skenario yang sama dijalankan untuk tiap kombinasi KCP sc-fast8 (interval
// 10/20 ms x ACK langsung 0/1) plus env rusak yang wajib jatuh ke default.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const { spawn, spawnSync } = require('child_process');
const dir = process.env.DNSTT_NATIVE_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KCP_CASES = [
  { env: {}, interval: 10, ack: false },
  { env: { SLOWDNS_KCP_INTERVAL: '20', SLOWDNS_KCP_ACK_NODELAY: '0' }, interval: 20, ack: false },
  { env: { SLOWDNS_KCP_INTERVAL: '10', SLOWDNS_KCP_ACK_NODELAY: '1' }, interval: 10, ack: true },
  { env: { SLOWDNS_KCP_INTERVAL: '20', SLOWDNS_KCP_ACK_NODELAY: '1' }, interval: 20, ack: true },
  { env: { SLOWDNS_KCP_INTERVAL: '5', SLOWDNS_KCP_ACK_NODELAY: 'mungkin' }, interval: 10, ack: false, invalid: true }
];

async function main() {
  if (!dir) { console.log('slowdns native integration skipped (set DNSTT_NATIVE_DIR)'); return; }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const serverBin = path.join(dir, 'dnstt-server' + suffix);
  const clientBin = path.join(dir, 'dnstt-client' + suffix);
  assert(fs.existsSync(serverBin) && fs.existsSync(clientBin), 'native binaries tersedia');
  for (const kcp of KCP_CASES) await scenario(serverBin, clientBin, kcp);
  console.log(`slowdns native integration passed (TXT + NULL, real DNS/Noise/KCP/smux, bulk echo, 2 clients, 3 streams, cleanup; KCP ${KCP_CASES.length} konfigurasi)`);
}

async function scenario(serverBin, clientBin, kcp) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-dnstt-native-'));
  const socket = path.join(tmp, 'sc.sock');
  const children = [], sockets = new Set();
  let nullProxy;
  let nullQueries = 0;
  let logs = '';
  let serverHead = '';
  const echo = net.createServer((s) => {
    sockets.add(s); s.once('close', () => sockets.delete(s)); s.on('error', () => {}); s.pipe(s);
  });
  const launch = (file, args, env = {}) => {
    const p = spawn(file, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stderr.on('data', (data) => { logs = (logs + data).slice(-16000); });
    p.stdout.resume(); children.push(p); return p;
  };
  const freeTcp = async () => {
    const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const port = s.address().port; await new Promise((r) => s.close(r)); return port;
  };
  const connect = (port) => new Promise((resolve, reject) => {
    const s = net.createConnection(port, '127.0.0.1');
    s.once('connect', () => { sockets.add(s); s.once('close', () => sockets.delete(s)); resolve(s); });
    s.once('error', reject);
  });
  const until = async (fn) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await fn(); if (value) return value;
      await sleep(100);
    }
    throw Error('native DNSTT timeout\n' + logs);
  };
  const exchange = async (port, payload) => {
    const s = await until(async () => { try { return await connect(port); } catch (_) { return null; } });
    s.on('error', () => {});
    await new Promise((resolve, reject) => {
      let received = Buffer.alloc(0);
      const timer = setTimeout(() => reject(Error('echo timeout\n' + logs)), 15000);
      s.on('data', (part) => {
        received = Buffer.concat([received, part]);
        if (received.length >= payload.length) {
          clearTimeout(timer);
          try { assert.deepStrictEqual(received, payload); resolve(); } catch (error) { reject(error); }
        }
      });
      s.write(payload);
    });
    return s;
  };
  try {
    const key = path.join(tmp, 'private.key'), pub = path.join(tmp, 'public.key');
    const gen = spawnSync(serverBin, ['-gen-key', '-privkey-file', key, '-pubkey-file', pub], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(gen.status, 0, gen.stderr);
    await new Promise((r) => echo.listen(0, '127.0.0.1', r));
    const dns = dgram.createSocket('udp4'); await new Promise((r) => dns.bind(0, '127.0.0.1', r));
    const dnsPort = dns.address().port; await new Promise((r) => dns.close(r));
    // Satu klien melewati resolver lokal TXT <-> NULL, supaya kedua format
    // diuji lewat transport Noise/KCP/smux sungguhan, termasuk paket besar.
    const nameEnd = (p, start) => {
      let i = start;
      while (i < p.length) {
        const n = p[i++];
        if ((n & 0xc0) === 0xc0) return i + 1;
        if (n === 0) return i;
        if (n > 63 || i + n > p.length) throw Error('nama DNS proxy tidak valid');
        i += n;
      }
      throw Error('nama DNS proxy terpotong');
    };
    nullProxy = dgram.createSocket('udp4');
    let nullClient;
    nullProxy.on('message', (packet, peer) => {
      try {
        const p = Buffer.from(packet);
        const qtype = nameEnd(p, 12);
        if (peer.port !== dnsPort) {
          assert.strictEqual(p.readUInt16BE(qtype), 16);
          p.writeUInt16BE(10, qtype); nullQueries++;
          nullClient = peer;
          nullProxy.send(p, dnsPort, '127.0.0.1');
        } else if (nullClient) {
          p.writeUInt16BE(16, qtype);
          let response = p;
          if (p.readUInt16BE(6) === 1) {
            const rr = nameEnd(p, qtype + 4);
            if (p.readUInt16BE(rr) === 10) {
              const lenAt = rr + 8, dataAt = rr + 10;
              const size = p.readUInt16BE(lenAt), end = dataAt + size;
              assert(end <= p.length);
              const chunks = [];
              for (let i = dataAt; i < end; i += 255) {
                const part = p.subarray(i, Math.min(i + 255, end));
                chunks.push(Buffer.from([part.length]), part);
              }
              if (chunks.length === 0) chunks.push(Buffer.from([0]));
              const txt = Buffer.concat(chunks), length = Buffer.alloc(2);
              length.writeUInt16BE(txt.length);
              p.writeUInt16BE(16, rr);
              response = Buffer.concat([p.subarray(0, lenAt), length, txt, p.subarray(end)]);
            }
          }
          nullProxy.send(response, nullClient.port, nullClient.address);
        }
      } catch (error) { logs += '\nNULL proxy: ' + error.stack; }
    });
    await new Promise((r) => nullProxy.bind(0, '127.0.0.1', r));
    const server = launch(serverBin, ['-udp', `127.0.0.1:${dnsPort}`, '-privkey-file', key, '-mtu', '1232', 't.local.test', `127.0.0.1:${echo.address().port}`], {
      SLOWDNS_SESSION_SOCKET: socket, SLOWDNS_KCP_WINDOW: '2048', GOMAXPROCS: '2',
      SLOWDNS_KCP_INTERVAL: '', SLOWDNS_KCP_ACK_NODELAY: '', ...kcp.env
    });
    server.stderr.on('data', (data) => { if (serverHead.length < 8192) serverHead += data; });
    // AF_UNIX pada Windows tidak selalu dapat di-stat oleh Node; buktikan
    // kesiapan lewat klien IPC Go yang sama dengan helper produksi.
    await until(() => spawnSync(serverBin, ['-sc-online', socket], {
      encoding: 'utf8', timeout: 4000, windowsHide: true
    }).status === 0);
    const a = await freeTcp(), b = await freeTcp();
    launch(clientBin, ['-udp', `127.0.0.1:${dnsPort}`, '-pubkey-file', pub, 't.local.test', `127.0.0.1:${a}`]);
    launch(clientBin, ['-udp', `127.0.0.1:${nullProxy.address().port}`, '-pubkey-file', pub, 't.local.test', `127.0.0.1:${b}`]);
    const first = await exchange(a, Buffer.alloc(100, 65));
    const second = await exchange(a, Buffer.alloc(65536, 66));
    const third = await exchange(b, Buffer.alloc(131072, 67));
    const query = () => {
      const r = spawnSync(serverBin, ['-sc-online', socket], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      assert.strictEqual(r.status, 0, r.stderr);
      const lines = r.stdout.trim().split(/\r?\n/);
      assert(lines.shift().startsWith(`SC_SLOWDNS_SESSIONS_V2|${server.pid}|`));
      assert.strictEqual(lines.pop(), 'END');
      // V2 (sc-fast10): stream hidup port|cid|up|started|down, stream putus
      // E|port|cid|up|started|down|ended (dipakai kuota SSH).
      ended = lines.filter((l) => l.startsWith('E|')).map((l) => l.split('|').slice(1));
      return lines.filter((l) => !l.startsWith('E|')).map((l) => l.split('|')).filter((r) => Number(r[2]) > 0);
    };
    let ended = [];
    let rows = await until(() => { const rows = query(); return rows.length === 3 && rows; });
    assert.strictEqual(new Set(rows.map((r) => r[1])).size, 2, 'dua klien harus dua ClientID; stream ganda klien pertama tetap satu');
    assert.deepStrictEqual(rows.map((r) => Number(r[2])).sort((x, y) => x - y), [100, 65536, 131072], 'counter hanya payload dari klien');
    assert(rows.every((r) => r.length === 5 && Number(r[4]) === Number(r[2])), `byte download = payload echo: ${JSON.stringify(rows)}`);
    assert(nullQueries > 0, 'klien kedua benar-benar menggunakan record NULL');
    first.end();
    rows = await until(() => { const rows = query(); return rows.length === 2 && rows; });
    assert.strictEqual(new Set(rows.map((r) => r[1])).size, 2);
    third.end();
    rows = await until(() => { const rows = query(); return rows.length === 1 && rows; });
    assert.strictEqual(Number(rows[0][2]), 65536, 'tunnel yang sudah putus hilang');
    second.end();
    await until(() => query().length === 0);
    const finals = ended.filter((r) => Number(r[2]) > 0).map((r) => `${r[2]}/${r[4]}`).sort();
    assert.deepStrictEqual(finals, ['100/100', '131072/131072', '65536/65536'],
      `stream putus tetap tercatat dengan penghitung akhir: ${JSON.stringify(ended)}`);
    assert(ended.every((r) => r.length === 6 && BigInt(r[5]) >= BigInt(r[3])), 'waktu putus setelah waktu mulai');
    // Binary benar-benar memakai nilai yang diminta (dibaca sekali saat start).
    assert(serverHead.includes(`KCP interval ${kcp.interval} ms ack-nodelay ${kcp.ack} window 2048`),
      `log tuning KCP ${JSON.stringify(kcp.env)}:\n${serverHead}`);
    assert.strictEqual(/tidak valid/.test(serverHead), Boolean(kcp.invalid), `peringatan env rusak:\n${serverHead}`);
    console.log(`  KCP interval ${kcp.interval} ms, ACK langsung ${kcp.ack ? 1 : 0}${kcp.invalid ? ' (env rusak -> default)' : ''}: OK`);
  } finally {
    for (const s of sockets) s.destroy();
    const exits = children.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) r(); else p.once('exit', r); }));
    for (const p of children) if (p.exitCode === null) p.kill();
    await Promise.all(exits);
    if (nullProxy) await new Promise((r) => nullProxy.close(r));
    await new Promise((r) => echo.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

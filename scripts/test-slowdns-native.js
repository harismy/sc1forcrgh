'use strict';

// Integrasi lokal memakai binary server/client dari source DNSTT yang dipin.
// DNSTT_NATIVE_DIR berisi dnstt-server[.exe] dan dnstt-client[.exe].
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const { spawn, spawnSync } = require('child_process');
const dir = process.env.DNSTT_NATIVE_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!dir) { console.log('slowdns native integration skipped (set DNSTT_NATIVE_DIR)'); return; }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const serverBin = path.join(dir, 'dnstt-server' + suffix);
  const clientBin = path.join(dir, 'dnstt-client' + suffix);
  assert(fs.existsSync(serverBin) && fs.existsSync(clientBin), 'native binaries tersedia');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-dnstt-native-'));
  const socket = path.join(tmp, 'sc.sock');
  const children = [], sockets = new Set();
  let logs = '';
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
    const server = launch(serverBin, ['-udp', `127.0.0.1:${dnsPort}`, '-privkey-file', key, '-mtu', '1232', 't.local.test', `127.0.0.1:${echo.address().port}`], {
      SLOWDNS_SESSION_SOCKET: socket, SLOWDNS_KCP_WINDOW: '2048', GOMAXPROCS: '2'
    });
    // AF_UNIX pada Windows tidak selalu dapat di-stat oleh Node; buktikan
    // kesiapan lewat klien IPC Go yang sama dengan helper produksi.
    await until(() => spawnSync(serverBin, ['-sc-online', socket], {
      encoding: 'utf8', timeout: 4000, windowsHide: true
    }).status === 0);
    const a = await freeTcp(), b = await freeTcp();
    launch(clientBin, ['-udp', `127.0.0.1:${dnsPort}`, '-pubkey-file', pub, 't.local.test', `127.0.0.1:${a}`]);
    launch(clientBin, ['-udp', `127.0.0.1:${dnsPort}`, '-pubkey-file', pub, 't.local.test', `127.0.0.1:${b}`]);
    const first = await exchange(a, Buffer.alloc(100, 65));
    const second = await exchange(a, Buffer.alloc(200, 66));
    const third = await exchange(b, Buffer.alloc(300, 67));
    const query = () => {
      const r = spawnSync(serverBin, ['-sc-online', socket], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      assert.strictEqual(r.status, 0, r.stderr);
      const lines = r.stdout.trim().split(/\r?\n/);
      assert(lines.shift().startsWith(`SC_SLOWDNS_SESSIONS_V1|${server.pid}|`));
      assert.strictEqual(lines.pop(), 'END');
      return lines.map((l) => l.split('|')).filter((r) => Number(r[2]) > 0);
    };
    let rows = await until(() => { const rows = query(); return rows.length === 3 && rows; });
    assert.strictEqual(new Set(rows.map((r) => r[1])).size, 2, 'dua klien harus dua ClientID; stream ganda klien pertama tetap satu');
    assert.deepStrictEqual(rows.map((r) => Number(r[2])).sort((x, y) => x - y), [100, 200, 300], 'counter hanya payload dari klien');
    first.end();
    rows = await until(() => { const rows = query(); return rows.length === 2 && rows; });
    assert.strictEqual(new Set(rows.map((r) => r[1])).size, 2);
    third.end();
    rows = await until(() => { const rows = query(); return rows.length === 1 && rows; });
    assert.strictEqual(Number(rows[0][2]), 200, 'tunnel yang sudah putus hilang');
    second.end();
    await until(() => query().length === 0);
    console.log('slowdns native integration passed (real DNS/Noise/KCP/smux, 2 clients, 3 streams, cleanup)');
  } finally {
    for (const s of sockets) s.destroy();
    const exits = children.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) r(); else p.once('exit', r); }));
    for (const p of children) if (p.exitCode === null) p.kill();
    await Promise.all(exits);
    await new Promise((r) => echo.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

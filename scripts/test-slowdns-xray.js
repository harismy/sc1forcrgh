'use strict';

// Integrasi lokal sc-fast12 (V.1FSC.135): SlowDNS untuk Xray lewat domain NS
// kedua. Satu dnstt-server melayani dua domain dengan satu kunci:
// - t.local.test -> upstream SSH (echo)
// - x.local.test -> inbound WebSocket Xray tiruan sesuai path baris permintaan
// Diuji: kedua jalur jalan bersamaan, path tak dikenal ditolak, monitor sesi
// mencatat stream Xray sebagai baris "X|", dan ON/OFF jalur Xray lewat file
// routes tanpa restart (jalur SSH tetap jalan). DNSTT_NATIVE_DIR berisi
// dnstt-server[.exe] dan dnstt-client[.exe] dari source yang sudah dipatch.
const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const dir = process.env.DNSTT_NATIVE_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!dir) { console.log('slowdns xray integration skipped (set DNSTT_NATIVE_DIR)'); return; }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const serverBin = path.join(dir, 'dnstt-server' + suffix);
  const clientBin = path.join(dir, 'dnstt-client' + suffix);
  assert(fs.existsSync(serverBin) && fs.existsSync(clientBin), 'native binaries tersedia');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-dnstt-xray-'));
  const children = [], sockets = new Set();
  let logs = '';
  const launch = (file, args, env = {}) => {
    const p = spawn(file, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stderr.on('data', (d) => { logs = (logs + d).slice(-32000); });
    p.stdout.resume(); children.push(p); return p;
  };
  const track = (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); s.on('error', () => {}); return s; };
  // Upstream SSH tiruan: echo.
  const ssh = net.createServer((s) => { track(s); s.pipe(s); });
  // Inbound WS Xray tiruan: wajib menerima baris permintaan utuh, balas 101, lalu echo.
  const xrayHeads = [];
  const xray = net.createServer((s) => {
    track(s);
    let buf = Buffer.alloc(0), upgraded = false;
    s.on('data', (d) => {
      if (upgraded) { s.write(d); return; }
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      xrayHeads.push(buf.subarray(0, end).toString());
      upgraded = true;
      s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      if (buf.length > end + 4) s.write(buf.subarray(end + 4));
    });
  });
  const freePort = async () => {
    const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const port = s.address().port; await new Promise((r) => s.close(r)); return port;
  };
  const connect = (port) => new Promise((resolve, reject) => {
    const s = net.createConnection(port, '127.0.0.1');
    s.once('connect', () => resolve(track(s)));
    s.once('error', reject);
  });
  // Kirim payload lalu tunggu `want` byte kembali (atau gagal setelah timeoutMs).
  const roundTrip = (port, payload, want, timeoutMs = 20000) => new Promise((resolve) => {
    let got = Buffer.alloc(0), done = false;
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok, got }); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const attempt = async () => {
      let s;
      try { s = await connect(port); } catch (_) { setTimeout(attempt, 200); return; }
      s.on('data', (d) => { got = Buffer.concat([got, d]); if (got.length >= want) { s.destroy(); finish(true); } });
      s.on('close', () => { if (got.length < want) finish(false); });
      s.write(payload);
    };
    attempt();
  });
  try {
    await new Promise((r) => ssh.listen(0, '127.0.0.1', r));
    await new Promise((r) => xray.listen(0, '127.0.0.1', r));
    const key = path.join(tmp, 'k'), pub = path.join(tmp, 'p'), routes = path.join(tmp, 'slowdns.state');
    const socket = path.join(tmp, 'sc.sock');
    assert.strictEqual(spawnSync(serverBin, ['-gen-key', '-privkey-file', key, '-pubkey-file', pub]).status, 0);
    fs.writeFileSync(routes, 'ENABLED=1\nROUTE_SSH=1\nROUTE_XRAY=1\n');
    const probe = dgram.createSocket('udp4'); await new Promise((r) => probe.bind(0, '127.0.0.1', r));
    const dnsPort = probe.address().port; await new Promise((r) => probe.close(r));
    // Konfigurasi rusak harus ditolak saat start (tujuan non-loopback).
    const bad = spawnSync(serverBin, ['-udp', '127.0.0.1:1', '-privkey-file', key, '-xray-domain', 'x.local.test',
      '-xray-route', '/vless=10.1.2.3:80', 't.local.test', '127.0.0.1:1'], { encoding: 'utf8', timeout: 5000 });
    assert(bad.status !== 0 && /loopback/.test(bad.stderr), `rute non-loopback ditolak: ${bad.stderr}`);
    launch(serverBin, ['-udp', `127.0.0.1:${dnsPort}`, '-privkey-file', key, '-mtu', '1232',
      '-xray-domain', 'x.local.test', '-xray-route', `/vless=127.0.0.1:${xray.address().port}`,
      '-routes-file', routes, 't.local.test', `127.0.0.1:${ssh.address().port}`], { SLOWDNS_SESSION_SOCKET: socket });
    const client = async (domain) => {
      const port = await freePort();
      launch(clientBin, ['-udp', `127.0.0.1:${dnsPort}`, '-pubkey-file', pub, domain, `127.0.0.1:${port}`]);
      return port;
    };
    const wsRequest = (p, body) => Buffer.concat([Buffer.from(`GET ${p} HTTP/1.1\r\nHost: contoh.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`), body]);
    const RESPONSE = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n';

    // 1) Dua jalur bersamaan.
    const sshPort = await client('t.local.test');
    const xrayPort = await client('x.local.test');
    const body = Buffer.alloc(40000, 0x58);
    const [s1, x1] = await Promise.all([
      roundTrip(sshPort, Buffer.alloc(30000, 0x53), 30000),
      roundTrip(xrayPort, wsRequest('/vless?ed=2048', body), RESPONSE.length + body.length)
    ]);
    assert(s1.ok && s1.got.equals(Buffer.alloc(30000, 0x53)), 'jalur SSH (domain NS SSH) tetap ke upstream SSH');
    assert(x1.ok, `jalur Xray tersambung\n${logs}`);
    assert.strictEqual(x1.got.subarray(0, RESPONSE.length).toString(), RESPONSE, 'jawaban 101 dari inbound Xray');
    assert(x1.got.subarray(RESPONSE.length).equals(body), 'data WebSocket utuh');
    assert(xrayHeads.length === 1 && xrayHeads[0].startsWith('GET /vless?ed=2048 HTTP/1.1\r\nHost: contoh.com'),
      `baris permintaan diteruskan utuh: ${JSON.stringify(xrayHeads)}`);

    // 2) Monitor sesi: stream Xray hidup tercatat sebagai X|port|cid|up|started|down.
    const held = await connect(xrayPort);
    held.write(wsRequest('/vless', Buffer.from('ping')));
    let xline = '';
    for (let i = 0; i < 60 && !xline; i++) {
      await sleep(250);
      const r = spawnSync(serverBin, ['-sc-online', socket], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      if (r.status !== 0) continue;
      assert(r.stdout.startsWith('SC_SLOWDNS_SESSIONS_V2|'), 'header monitor tetap V2');
      xline = r.stdout.split(/\r?\n/).find((l) => l.startsWith('X|')) || '';
    }
    const xf = xline.split('|');
    assert(xf.length === 6 && /^[0-9a-f]{16}$/.test(xf[2]) && Number(xf[3]) > 0, `baris X monitor: ${xline}`);
    held.destroy();

    // 3) Path tidak dikenal ditutup tanpa menyentuh inbound.
    const unknown = await roundTrip(xrayPort, wsRequest('/trojan', Buffer.from('x')), 1, 6000);
    assert(!unknown.ok && xrayHeads.length === 2, 'path di luar -xray-route ditolak');

    // 4) Jalur Xray OFF lewat file routes (tanpa restart): klien baru tidak bisa
    //    membuat sesi, jalur SSH tetap jalan.
    fs.writeFileSync(routes, 'ENABLED=1\nROUTE_SSH=1\nROUTE_XRAY=0\n');
    await sleep(3500);
    const offPort = await client('x.local.test');
    const off = await roundTrip(offPort, wsRequest('/vless', Buffer.from('y')), RESPONSE.length + 1, 7000);
    assert(!off.ok, 'sesi Xray baru ditolak saat jalur OFF');
    const s2 = await roundTrip(sshPort, Buffer.from('masih-jalan'), 11);
    assert(s2.ok && s2.got.toString() === 'masih-jalan', 'jalur SSH tidak terganggu saat Xray OFF');
    assert(/jalur SlowDNS: ssh ON, xray OFF/.test(logs), 'perubahan jalur dicatat sekali di log');

    // 5) ON lagi: klien baru tersambung.
    fs.writeFileSync(routes, 'ENABLED=1\nROUTE_SSH=1\nROUTE_XRAY=1\n');
    await sleep(3500);
    const onPort = await client('x.local.test');
    const on = await roundTrip(onPort, wsRequest('/vless', Buffer.from('z')), RESPONSE.length + 1);
    assert(on.ok, `jalur Xray ON kembali tanpa restart\n${logs}`);
    console.log('slowdns xray integration passed (2 domain NS, 1 kunci, path WS, monitor X, ON/OFF tanpa restart)');
  } finally {
    for (const s of sockets) s.destroy();
    for (const p of children) if (p.exitCode === null) p.kill();
    await sleep(300);
    ssh.close(); xray.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });

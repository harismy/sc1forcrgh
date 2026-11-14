'use strict';

// Integrasi lokal sc-fast11 (V.1FSC.134): klien SlowDNS lewat resolver publik.
// Kasus nyata sg4 14-11-2026: lewat 8.8.8.8/1.1.1.1/9.9.9.9 resolver mengirim
// EDNS-nya sendiri (>= 1232) ke server, lalu menjawab app dengan TC=1 tanpa
// answer kalau respons lebih besar dari buffer yang diiklankan app. App
// ber-buffer 512/1024/tanpa EDNS tidak pernah konek ke binary sc-fast10.
// Resolver tiruan di sini meniru perilaku itu (EDNS ditulis ulang ke 1232,
// RD=0, respons kebesaran = TC=1 tanpa answer). DNSTT_NATIVE_DIR berisi
// dnstt-server[.exe] dan dnstt-client[.exe] dari source yang sudah dipatch.
const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const dir = process.env.DNSTT_NATIVE_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOWNLOAD = 300000;

const CASES = [
  { name: 'buffer app 1232 lewat resolver', limit: 1232, kind: 16, proven: [1232, 1232], mtu: 932 },
  { name: 'buffer app 512 lewat resolver (TXT)', limit: 512, kind: 16, proven: [0, 0], truncated: true },
  { name: 'buffer app 512 lewat resolver (NULL)', limit: 512, kind: 10, proven: [0, 0], truncated: true },
  { name: 'buffer app 1024 lewat resolver', limit: 1024, kind: 10, proven: [0, 1024], truncated: true },
  { name: 'langsung tanpa resolver', limit: 0, kind: 16, proven: [1232, 1232], mtu: 932 }
];

function nameEnd(p, start) {
  let i = start;
  while (i < p.length) {
    const n = p[i++];
    if ((n & 0xc0) === 0xc0) return i + 1;
    if (n === 0) return i;
    if (n > 63 || i + n > p.length) throw Error('nama DNS tidak valid');
    i += n;
  }
  throw Error('nama DNS terpotong');
}

// Ubah jawaban NULL dari server menjadi TXT untuk dnstt-client resmi.
function nullToTxt(p, qtypeAt) {
  p.writeUInt16BE(16, qtypeAt);
  if (p.readUInt16BE(6) !== 1) return p;
  const rr = nameEnd(p, qtypeAt + 4);
  if (p.readUInt16BE(rr) !== 10) return p;
  const lenAt = rr + 8, dataAt = rr + 10, end = dataAt + p.readUInt16BE(lenAt);
  const chunks = [];
  for (let i = dataAt; i < end; i += 255) {
    const part = p.subarray(i, Math.min(i + 255, end));
    chunks.push(Buffer.from([part.length]), part);
  }
  if (chunks.length === 0) chunks.push(Buffer.from([0]));
  const txt = Buffer.concat(chunks), length = Buffer.alloc(2);
  length.writeUInt16BE(txt.length);
  p.writeUInt16BE(16, rr);
  return Buffer.concat([p.subarray(0, lenAt), length, txt, p.subarray(end)]);
}

async function main() {
  if (!dir) { console.log('slowdns resolver integration skipped (set DNSTT_NATIVE_DIR)'); return; }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const serverBin = path.join(dir, 'dnstt-server' + suffix);
  const clientBin = path.join(dir, 'dnstt-client' + suffix);
  assert(fs.existsSync(serverBin) && fs.existsSync(clientBin), 'native binaries tersedia');
  for (const c of CASES) await scenario(serverBin, clientBin, c);
  console.log(`slowdns resolver integration passed (${CASES.length} kasus: resolver ala 8.8.8.8 dengan buffer app 512/1024/1232, TXT + NULL, dan langsung)`);
}

async function scenario(serverBin, clientBin, c) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-dnstt-resolver-'));
  const children = [], sockets = new Set();
  let logs = '';
  let truncated = 0, passed = 0;
  const blob = crypto.randomBytes(DOWNLOAD);
  const upstream = net.createServer((s) => {
    sockets.add(s); s.once('close', () => sockets.delete(s)); s.on('error', () => {}); s.write(blob);
  });
  const launch = (file, args) => {
    const p = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stderr.on('data', (d) => { logs = (logs + d).slice(-32000); });
    p.stdout.resume(); children.push(p); return p;
  };
  const freePort = async () => {
    const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const port = s.address().port; await new Promise((r) => s.close(r)); return port;
  };
  let resolver;
  try {
    const key = path.join(tmp, 'private.key'), pub = path.join(tmp, 'public.key');
    const gen = spawnSync(serverBin, ['-gen-key', '-privkey-file', key, '-pubkey-file', pub], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(gen.status, 0, gen.stderr);
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const probe = dgram.createSocket('udp4'); await new Promise((r) => probe.bind(0, '127.0.0.1', r));
    const dnsPort = probe.address().port; await new Promise((r) => probe.close(r));
    launch(serverBin, ['-udp', `127.0.0.1:${dnsPort}`, '-privkey-file', key, '-mtu', '1232', 't.local.test', `127.0.0.1:${upstream.address().port}`]);
    let clientTarget = `127.0.0.1:${dnsPort}`;
    if (c.limit) {
      resolver = dgram.createSocket('udp4');
      await new Promise((r) => resolver.bind(0, '127.0.0.1', r));
      const pending = new Map();
      resolver.on('message', (packet, peer) => {
        try {
          const p = Buffer.from(packet);
          const qtypeAt = nameEnd(p, 12);
          if (peer.port !== dnsPort) {
            pending.set(p.readUInt16BE(0), peer);
            p.writeUInt16BE(p.readUInt16BE(2) & ~0x0100, 2); // RD=0, seperti resolver rekursif
            p.writeUInt16BE(c.kind, qtypeAt);
            const opt = qtypeAt + 4;
            assert(p.readUInt16BE(10) === 1 && p.readUInt16BE(opt + 1) === 41, 'query dnstt membawa OPT');
            p.writeUInt16BE(1232, opt + 3); // EDNS milik resolver, bukan milik app
            resolver.send(p, dnsPort, '127.0.0.1');
            return;
          }
          const app = pending.get(p.readUInt16BE(0));
          if (!app) return;
          pending.delete(p.readUInt16BE(0));
          let out;
          if (p.length > c.limit) {
            out = Buffer.from(p.subarray(0, qtypeAt + 4));
            out.writeUInt16BE(out.readUInt16BE(2) | 0x0200, 2); // TC=1 tanpa answer
            out.writeUInt16BE(0, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10);
            out.writeUInt16BE(16, qtypeAt);
            truncated++;
          } else {
            out = nullToTxt(p, qtypeAt);
            passed++;
          }
          resolver.send(out, app.port, app.address);
        } catch (error) { logs += '\nresolver: ' + error.stack; }
      });
      clientTarget = `127.0.0.1:${resolver.address().port}`;
    }
    const local = await freePort();
    launch(clientBin, ['-udp', clientTarget, '-pubkey-file', pub, 't.local.test', `127.0.0.1:${local}`]);
    const got = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 45000;
      const attempt = () => {
        const s = net.createConnection(local, '127.0.0.1');
        let n = 0, done = false;
        const timer = setTimeout(() => { done = true; s.destroy(); reject(Error(`${c.name}: download macet di ${n}/${DOWNLOAD} byte\n${logs}`)); }, Math.max(1000, deadline - Date.now()));
        s.on('connect', () => sockets.add(s));
        s.on('data', (d) => { n += d.length; if (n >= DOWNLOAD && !done) { done = true; clearTimeout(timer); s.destroy(); resolve(n); } });
        s.on('error', () => { if (!done && n === 0 && Date.now() < deadline) { clearTimeout(timer); setTimeout(attempt, 200); } });
      };
      attempt();
    });
    assert.strictEqual(got, DOWNLOAD);
    await sleep(300);
    const proofs = [...logs.matchAll(/session [0-9a-f]+ mtu (\d+) \(respons (\d+) byte terbukti sampai\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const maxProven = proofs.reduce((a, [, s]) => Math.max(a, s), 0);
    assert(/session [0-9a-f]+ edns \d+ mtu 215 win \d+/.test(logs), `${c.name}: MTU awal 215 (kapasitas respons 512)\n${logs}`);
    assert(maxProven >= c.proven[0] && maxProven <= c.proven[1],
      `${c.name}: ukuran terbukti ${maxProven} di luar ${c.proven.join('..')}\n${logs}`);
    if (c.mtu) assert(proofs.some(([m]) => m === c.mtu), `${c.name}: MTU sesi naik ke ${c.mtu}\n${logs}`);
    if (c.limit) {
      assert(passed > 0, `${c.name}: resolver meneruskan respons`);
      if (c.truncated) assert(truncated > 0, `${c.name}: probe kebesaran terpotong resolver (TC=1)`);
      else assert.strictEqual(truncated, 0, `${c.name}: tidak ada respons kebesaran untuk buffer ${c.limit}`);
    }
    console.log(`  ok ${c.name}: ${DOWNLOAD} byte, terbukti ${maxProven || 512} byte, TC=${truncated}`);
  } finally {
    for (const s of sockets) s.destroy();
    for (const p of children) p.kill();
    if (resolver) resolver.close();
    await new Promise((r) => upstream.close(r));
    await sleep(200);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });

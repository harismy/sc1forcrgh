'use strict';

// Benchmark KCP SlowDNS (patch sc-fast8): membandingkan interval 10/20 ms dan
// ACK langsung 0/1 dengan binary, window, klien, resolver tiruan, RTT, loss,
// dan beban yang sama. Bukan bagian `npm test`: butuh beberapa menit dan
// hasilnya angka ukur, bukan lulus/gagal.
//
//   DNSTT_NATIVE_DIR=<dir berisi dnstt-server + dnstt-client> \
//     node scripts/bench-slowdns-kcp.js [--rounds 3] [--rtt 60] [--loss 1] [--json hasil.json]
//
// Opsi lain: --window 2048 --gomaxprocs 1 --down-mib 4 --up-mib 0.5
//   --parallel 4 --par-mib 1 --idle-clients 8 --idle-sec 20 --pings 30
//   --jitter 0 --combos 10:0,20:0,10:1,20:1 --baseline <dir binary pembanding>
//   --phases idle,ping,download,upload,parallel (mis. --phases idle --idle-clients 40)
//
// Matriks bebas (V.1FSC.126), menggantikan --combos kalau diisi:
//   --configs 'w512=SLOWDNS_KCP_WINDOW=512;w2048-A=SLOWDNS_KCP_WINDOW=2048;w2048-B=SLOWDNS_KCP_WINDOW=2048'
//   Tiap konfigurasi: label=KUNCI=NILAI,KUNCI=NILAI. Kunci BIN=<dir> memakai
//   binary server lain. Pakai dua label dengan isi sama sebagai pembanding A/A.
// --resolver-qps N   batas query/detik per klien di resolver tiruan (token
//                    bucket, burst N/10, kelebihan dibuang). 0 = tanpa batas.
// --instr 1          binary server dibangun dengan tag `scbench` lewat
//                    scripts/go/slowdns-bench/build-bench-tree.sh (lihat
//                    docs/slowdns-cpu-research-v126.md): baca kcp.DefaultSnmp,
//                    kedalaman antrean keluar, dan srtt/rto per fase.
// --profile-dir DIR  (butuh --instr) profil CPU pprof selama fase download.
//
// Yang diukur per fase: CPU-detik proses dnstt-server (bukan klien/harness),
// CPU per MiB payload, throughput, latensi ping-pong p50/p95, retransmisi KCP
// (dihitung dari segmen PUSH ganda yang lewat resolver tiruan), query tanpa
// jawaban server, paket yang sengaja dibuang resolver tiruan, drop socket UDP
// (Linux saja), dan RAM puncak. CPU dibaca dari /proc (Linux) atau
// Get-Process (Windows). Klien = dnstt-client upstream (TXT, EDNS 4096).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const { spawn, spawnSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MiB = 1024 * 1024;
const DOMAIN = 't.local.test';

function parseArgs(argv) {
  const o = {
    rounds: 3, rtt: 60, jitter: 0, loss: 1, window: 2048, gomaxprocs: 1,
    'down-mib': 4, 'up-mib': 0.5, parallel: 4, 'par-mib': 1, 'idle-clients': 8, 'idle-sec': 20,
    pings: 30, combos: '10:0,20:0,10:1,20:1', baseline: '', json: '', mtu: 1232,
    phases: 'idle,ping,download,upload,parallel', configs: '', 'resolver-qps': 0, instr: 0, 'profile-dir': ''
  };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    assert(k in o, `opsi tidak dikenal: ${argv[i]}`);
    o[k] = typeof o[k] === 'number' ? Number(argv[i + 1]) : String(argv[i + 1] || '');
    assert(typeof o[k] !== 'number' || Number.isFinite(o[k]), `nilai ${argv[i]} tidak valid`);
  }
  return o;
}

// ── Statistik proses ────────────────────────────────────────────────────────
let clkTck = 100;
if (process.platform === 'linux') {
  const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
  if (r.status === 0 && Number(r.stdout) > 0) clkTck = Number(r.stdout);
}
function procStats(pid) {
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number((status.match(new RegExp(`${k}:\\s+(\\d+)`)) || [])[1] || 0) * 1024;
    return { cpu: (Number(f[11]) + Number(f[12])) / clkTck, rss: kb('VmRSS'), peak: kb('VmHWM') };
  }
  if (process.platform === 'win32') {
    const cmd = `$p=Get-Process -Id ${pid}; [string]::Format([cultureinfo]::InvariantCulture,'{0} {1} {2}',` +
      '$p.TotalProcessorTime.TotalSeconds,$p.WorkingSet64,$p.PeakWorkingSet64)';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
    const [cpu, rss, peak] = r.stdout.trim().split(/\s+/).map(Number);
    assert(Number.isFinite(cpu), `Get-Process gagal: ${r.stdout}${r.stderr}`);
    return { cpu, rss, peak };
  }
  throw Error('platform belum didukung untuk ukur CPU');
}

// Drop socket UDP server (kolom drops /proc/net/udp*). Windows tidak punya.
function udpDrops(port) {
  if (process.platform !== 'linux') return null;
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  let total = 0;
  for (const file of ['/proc/net/udp', '/proc/net/udp6']) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 12 && cols[1].endsWith(`:${hex}`)) total += Number(cols[cols.length - 1]) || 0;
    }
  }
  return total;
}

// ── Parser DNS/KCP untuk resolver tiruan ────────────────────────────────────
function nameEnd(p, i) {
  while (i < p.length) {
    const n = p[i++];
    if ((n & 0xc0) === 0xc0) return i + 1;
    if (n === 0) return i;
    i += n;
  }
  throw Error('nama DNS terpotong');
}
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32Decode(text) {
  const out = [];
  let bits = 0, value = 0;
  for (const ch of text) {
    const v = B32.indexOf(ch);
    if (v < 0) throw Error('base32 tidak valid');
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function newDirStats() { return { push: 0, retrans: 0, ack: 0, seen: new Set() }; }
function countKcp(buf, st) {
  let off = 0;
  while (off + 24 <= buf.length) {
    const conv = buf.readUInt32LE(off), cmd = buf[off + 4], sn = buf.readUInt32LE(off + 12), len = buf.readUInt32LE(off + 20);
    if (cmd === 81) {
      st.push++;
      const key = `${conv}:${sn}`;
      if (st.seen.has(key)) st.retrans++; else st.seen.add(key);
    } else if (cmd === 82) st.ack++;
    off += 24 + len;
  }
}
// Query klien: base32(ClientID 8 + padding + [len][paket KCP]) di label sebelum domain.
function parseQuery(p, st) {
  let i = 12;
  const labels = [];
  while (p[i] !== 0) { labels.push(p.toString('latin1', i + 1, i + 1 + p[i])); i += 1 + p[i]; }
  const data = base32Decode(labels.slice(0, labels.length - DOMAIN.split('.').length).join(''));
  let off = 8;
  while (off < data.length) {
    const prefix = data[off++];
    if (prefix >= 224) { off += prefix - 224; continue; }
    countKcp(data.subarray(off, off + prefix), st);
    off += prefix;
  }
}
// Jawaban server: satu RR TXT/NULL berisi [panjang 2 byte][paket KCP]...
function parseResponse(p, st) {
  if (p.readUInt16BE(6) !== 1) return 0;
  let i = nameEnd(p, nameEnd(p, 12) + 4);
  const type = p.readUInt16BE(i), rdlen = p.readUInt16BE(i + 8);
  let rdata = p.subarray(i + 10, i + 10 + rdlen);
  if (type === 16) {
    const parts = [];
    for (let j = 0; j < rdata.length; j += 1 + rdata[j]) parts.push(rdata.subarray(j + 1, j + 1 + rdata[j]));
    rdata = Buffer.concat(parts);
  }
  let off = 0, bytes = 0;
  while (off + 2 <= rdata.length) {
    const n = rdata.readUInt16BE(off);
    countKcp(rdata.subarray(off + 2, off + 2 + n), st);
    off += 2 + n; bytes += n;
  }
  return bytes;
}

// Resolver tiruan: satu socket per klien ke server (seperti NAT), delay satu
// arah = RTT/2 (+ jitter acak), loss acak dengan PRNG ber-seed yang sama.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class Resolver {
  constructor(serverPort, opt) {
    this.serverPort = serverPort;
    this.oneWay = opt.rtt / 2;
    this.jitter = opt.jitter;
    this.loss = opt.loss / 100;
    this.rand = mulberry32(12345);
    this.qps = opt['resolver-qps'] || 0;
    this.clients = new Map();
    this.c = { queries: 0, responses: 0, lostQ: 0, lostR: 0, rateDropped: 0, unanswered: 0, down: newDirStats(), up: newDirStats(), downBytes: 0 };
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (p, peer) => this.fromClient(p, peer));
  }
  start() { return new Promise((r) => this.sock.bind(0, '127.0.0.1', r)); }
  get port() { return this.sock.address().port; }
  delay() { return this.oneWay + (this.jitter ? this.rand() * this.jitter : 0); }
  fromClient(p, peer) {
    if (this.closed) return;
    const key = `${peer.address}:${peer.port}`;
    let cl = this.clients.get(key);
    if (!cl) {
      cl = { up: dgram.createSocket('udp4'), pending: new Map(), peer, tokens: this.qps / 10, last: Date.now() };
      cl.up.on('message', (r) => this.fromServer(r, cl));
      cl.up.bind(0, '127.0.0.1');
      this.clients.set(key, cl);
    }
    this.c.queries++;
    // Resolver sungguhan membatasi laju per klien; kelebihan dibuang sebelum
    // sampai server (tidak dihitung sebagai segmen KCP yang lewat).
    if (this.qps > 0) {
      const now = Date.now();
      cl.tokens = Math.min(this.qps / 10, cl.tokens + (now - cl.last) * this.qps / 1000);
      cl.last = now;
      if (cl.tokens < 1) { this.c.rateDropped++; return; }
      cl.tokens -= 1;
    }
    try { parseQuery(p, this.c.up); } catch (_) { /* query bukan tunnel */ }
    if (this.rand() < this.loss) { this.c.lostQ++; return; }
    setTimeout(() => {
      if (this.closed) return;
      cl.pending.set(p.readUInt16BE(0), Date.now());
      cl.up.send(p, this.serverPort, '127.0.0.1');
    }, this.delay());
  }
  fromServer(r, cl) {
    this.c.responses++;
    cl.pending.delete(r.readUInt16BE(0));
    try { this.c.downBytes += parseResponse(r, this.c.down); } catch (_) { /* jawaban error */ }
    if (this.rand() < this.loss) { this.c.lostR++; return; }
    setTimeout(() => { if (!this.closed) this.sock.send(r, cl.peer.port, cl.peer.address); }, this.delay());
  }
  // Query yang sudah >3 detik di server tanpa jawaban (server menahan maks 1 detik).
  sweep() {
    const old = Date.now() - 3000;
    for (const cl of this.clients.values()) {
      for (const [id, t] of cl.pending) if (t < old) { cl.pending.delete(id); this.c.unanswered++; }
    }
  }
  snapshot() {
    this.sweep();
    const c = this.c;
    return {
      queries: c.queries, responses: c.responses, lostQ: c.lostQ, lostR: c.lostR, rateDropped: c.rateDropped, unanswered: c.unanswered,
      downPush: c.down.push, downRetrans: c.down.retrans, downAck: c.down.ack,
      upPush: c.up.push, upRetrans: c.up.retrans, upAck: c.up.ack
    };
  }
  close() {
    this.closed = true;
    for (const cl of this.clients.values()) cl.up.close();
    this.sock.close();
  }
}

// ── Backend TCP (pengganti Dropbear): D=kirim N byte, U=terima N byte, E=echo ─
function startBackend() {
  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 131 + 7) & 0xff;
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s); s.once('close', () => sockets.delete(s)); s.on('error', () => {});
    let head = Buffer.alloc(0);
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      if (head[0] === 0x45) { s.removeListener('data', onData); s.write(head.subarray(1)); s.pipe(s); return; }
      if (head.length < 5) return;
      s.removeListener('data', onData);
      const n = head.readUInt32BE(1);
      if (head[0] === 0x44) {
        let left = n;
        const pump = () => {
          while (left > 0) {
            const part = chunk.subarray(0, Math.min(chunk.length, left));
            left -= part.length;
            if (!s.write(part)) { s.once('drain', pump); return; }
          }
        };
        pump();
      } else {
        let got = head.length - 5;
        const done = () => { if (got >= n) s.write('K'); };
        s.on('data', (x) => { got += x.length; done(); });
        done();
      }
    };
    s.on('data', onData);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, sockets })));
}

// ── Satu putaran untuk satu konfigurasi ─────────────────────────────────────
async function runConfig(cfg, opt, bins) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-kcp-bench-'));
  const children = [];
  const clientSockets = new Set();
  let logs = '';
  const launch = (file, args, env) => {
    const p = spawn(file, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stderr.on('data', (d) => { logs = (logs + d).slice(-8000); });
    p.stdout.resume(); children.push(p); return p;
  };
  const freePort = async (udp) => {
    if (udp) {
      const s = dgram.createSocket('udp4'); await new Promise((r) => s.bind(0, '127.0.0.1', r));
      const port = s.address().port; await new Promise((r) => s.close(r)); return port;
    }
    const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const port = s.address().port; await new Promise((r) => s.close(r)); return port;
  };
  const connect = async (port) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        return await new Promise((resolve, reject) => {
          const s = net.createConnection(port, '127.0.0.1');
          s.once('connect', () => { clientSockets.add(s); s.once('close', () => clientSockets.delete(s)); resolve(s); });
          s.once('error', reject);
        });
      } catch (e) {
        if (Date.now() > deadline) throw Error(`klien port ${port} tidak siap\n${logs}`);
        await sleep(100);
      }
    }
  };
  // Ping-pong 64 byte di stream echo; hasil RTT dalam ms.
  const pinger = async (port) => {
    const s = await connect(port);
    s.setNoDelay(true);
    s.on('error', () => {});
    s.write('E');
    const msg = Buffer.alloc(64, 0x61);
    return {
      async ping() {
        const t0 = process.hrtime.bigint();
        await new Promise((resolve, reject) => {
          let got = 0;
          const timer = setTimeout(() => reject(Error('ping timeout')), 30000);
          const on = (d) => { got += d.length; if (got >= msg.length) { clearTimeout(timer); s.removeListener('data', on); resolve(); } };
          s.on('data', on);
          s.write(msg);
        });
        return Number(process.hrtime.bigint() - t0) / 1e6;
      },
      close() { s.destroy(); }
    };
  };
  const download = async (port, bytes) => {
    const s = await connect(port);
    s.on('error', () => {});
    const req = Buffer.alloc(5); req[0] = 0x44; req.writeUInt32BE(bytes, 1);
    const t0 = process.hrtime.bigint();
    await new Promise((resolve, reject) => {
      let got = 0;
      const timer = setTimeout(() => reject(Error(`download timeout (${got}/${bytes})\n${logs}`)), 600000);
      s.on('data', (d) => { got += d.length; if (got >= bytes) { clearTimeout(timer); resolve(); } });
      s.write(req);
    });
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    s.destroy();
    return sec;
  };
  const upload = async (port, bytes) => {
    const s = await connect(port);
    s.on('error', () => {});
    const req = Buffer.alloc(5); req[0] = 0x55; req.writeUInt32BE(bytes, 1);
    const t0 = process.hrtime.bigint();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`upload timeout\n${logs}`)), 600000);
      s.once('data', () => { clearTimeout(timer); resolve(); });
      s.write(req);
      let left = bytes;
      const block = Buffer.alloc(16 * 1024, 0x75);
      const pump = () => {
        while (left > 0) {
          const part = block.subarray(0, Math.min(block.length, left));
          left -= part.length;
          if (!s.write(part)) { s.once('drain', pump); return; }
        }
      };
      pump();
    });
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    s.destroy();
    return sec;
  };
  const pct = (arr, q) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))];
  };

  const backend = await startBackend();
  let resolver;
  try {
    const key = path.join(tmp, 'k'), pub = path.join(tmp, 'p');
    const g = spawnSync(cfg.serverBin, ['-gen-key', '-privkey-file', key, '-pubkey-file', pub], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(g.status, 0, g.stderr);
    const dnsPort = await freePort(true);
    const instrPort = opt.instr ? await freePort(false) : 0;
    const server = launch(cfg.serverBin, ['-udp', `127.0.0.1:${dnsPort}`, '-privkey-file', key, '-mtu', String(opt.mtu), DOMAIN,
      `127.0.0.1:${backend.server.address().port}`], {
      SLOWDNS_KCP_WINDOW: String(opt.window), GOMAXPROCS: String(opt.gomaxprocs), GOGC: '300', GOMEMLIMIT: '96MiB',
      SLOWDNS_KCP_INTERVAL: '', SLOWDNS_KCP_ACK_NODELAY: '', SC_BENCH_ADDR: instrPort ? `127.0.0.1:${instrPort}` : '', ...cfg.env
    });
    const instr = (pathAndQuery) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: instrPort, path: pathAndQuery, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(Error(`${pathAndQuery}: ${res.statusCode} ${body}`))));
      }).on('error', reject);
    });
    // Binary tanpa tag scbench (mis. BIN=build produksi) tidak punya endpoint: lewati.
    const snmp = async () => {
      if (!instrPort) return null;
      try { return JSON.parse(await instr('/snmp')); } catch (_) { return null; }
    };
    let head = '';
    server.stderr.on('data', (d) => { if (head.length < 4096) head += d; });
    resolver = new Resolver(dnsPort, opt);
    await resolver.start();
    const ports = [];
    for (let i = 0; i < 1 + Math.max(opt['idle-clients'], opt.parallel); i++) {
      const lp = await freePort(false);
      launch(bins.client, ['-udp', `127.0.0.1:${resolver.port}`, '-pubkey-file', pub, DOMAIN, `127.0.0.1:${lp}`], {});
      ports.push(lp);
    }
    // Semua klien membentuk sesi KCP+Noise dulu (echo pertama), lalu didiamkan.
    const keepers = [];
    for (const p of ports) { const k = await pinger(p); await k.ping(); keepers.push(k); }
    if (cfg.expectLog) assert(head.includes(cfg.expectLog), `binary tidak memakai ${cfg.expectLog}:\n${head}`);
    await sleep(3000);
    const out = { label: cfg.label, phases: {} };
    const wanted = new Set(opt.phases.split(','));
    const phase = async (name, fn) => {
      if (!wanted.has(name)) return;
      const k0 = await snmp();
      const prof = opt['profile-dir'] && instrPort && name === 'download'
        ? path.resolve(opt['profile-dir'], `${cfg.label.replace(/[^\w.-]+/g, '_')}-r${cfg.round}-${name}.pprof`) : '';
      if (prof) await instr(`/prof/start?path=${encodeURIComponent(prof)}`);
      const s0 = procStats(server.pid), r0 = resolver.snapshot(), d0 = udpDrops(dnsPort);
      const t0 = process.hrtime.bigint();
      const extra = await fn();
      const wall = Number(process.hrtime.bigint() - t0) / 1e9;
      await sleep(200);
      const s1 = procStats(server.pid), r1 = resolver.snapshot(), d1 = udpDrops(dnsPort);
      if (prof) await instr('/prof/stop');
      const k1 = await snmp();
      const delta = {};
      for (const k of Object.keys(r1)) delta[k] = r1[k] - r0[k];
      if (k0 && k1) {
        // Segmen KCP server selama fase ini: total retransmisi dan pecahannya
        // (Lost = RTO, Fast = fast resend, Early = early retransmit kcp-go).
        const kcp = {};
        for (const k of ['RetransSegs', 'LostSegs', 'FastRetransSegs', 'EarlyRetransSegs', 'OutSegs', 'InSegs', 'RepeatSegs', 'OutPkts', 'InPkts', 'BytesSent', 'BytesReceived']) {
          kcp[k] = k1.Snmp[k] - k0.Snmp[k];
        }
        kcp.dedup = (k1.Dedup || 0) - (k0.Dedup || 0);
        const qn = k1.QN - k0.QN;
        kcp.queueAvg = qn > 0 ? (k1.QSum - k0.QSum) / qn : null;
        kcp.queueMax = k1.QMax;
        kcp.srttMax = Math.max(0, ...(k1.Sessions || []).map((s) => s.SRTT));
        kcp.rtoMax = Math.max(0, ...(k1.Sessions || []).map((s) => s.RTO));
        delta.kcp = kcp;
      }
      out.phases[name] = { wall, cpu: s1.cpu - s0.cpu, udpDrops: d0 === null ? null : d1 - d0, ...delta, ...extra };
    };
    // 1. Idle: semua klien tersambung tanpa trafik.
    await phase('idle', async () => { await sleep(opt['idle-sec'] * 1000); return { clients: ports.length }; });
    // 2. Latensi saat sepi.
    const main = keepers[0];
    await phase('ping', async () => {
      const rtts = [];
      for (let i = 0; i < opt.pings; i++) rtts.push(await main.ping());
      return { p50: pct(rtts, 0.5), p95: pct(rtts, 0.95) };
    });
    // 3. Download 1 klien + ping paralel di stream lain klien yang sama.
    await phase('download', async () => {
      const bytes = Math.round(opt['down-mib'] * MiB);
      const rtts = [];
      let done = false;
      const pingLoop = (async () => { while (!done) { rtts.push(await main.ping()); await sleep(200); } })();
      const sec = await download(ports[0], bytes);
      done = true;
      await pingLoop;
      return { mib: bytes / MiB, mbps: bytes * 8 / sec / 1e6, p50: pct(rtts, 0.5), p95: pct(rtts, 0.95) };
    });
    // 4. Upload 1 klien.
    await phase('upload', async () => {
      const bytes = Math.round(opt['up-mib'] * MiB);
      const sec = await upload(ports[0], bytes);
      return { mib: bytes / MiB, mbps: bytes * 8 / sec / 1e6 };
    });
    // 5. Download paralel beberapa klien (VPS ramai).
    await phase('parallel', async () => {
      const bytes = Math.round(opt['par-mib'] * MiB);
      const t0 = Date.now();
      await Promise.all(ports.slice(1, 1 + opt.parallel).map((p) => download(p, bytes)));
      const sec = (Date.now() - t0) / 1000;
      return { mib: bytes * opt.parallel / MiB, mbps: bytes * opt.parallel * 8 / sec / 1e6 };
    });
    const end = procStats(server.pid);
    out.ram = { rss: end.rss, peak: end.peak };
    for (const k of keepers) k.close();
    return out;
  } finally {
    for (const s of clientSockets) s.destroy();
    for (const s of backend.sockets) s.destroy();
    const exits = children.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) r(); else p.once('exit', r); }));
    for (const p of children) if (p.exitCode === null) p.kill();
    await Promise.all(exits);
    if (resolver) resolver.close();
    await new Promise((r) => backend.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Ringkasan ───────────────────────────────────────────────────────────────
const median = (xs) => {
  const a = xs.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const fmt = (x, d = 2) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));

const stat = (xs) => {
  const a = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  if (!a.length) return null;
  return { med: median(a), min: Math.min(...a), max: Math.max(...a) };
};
// Median dengan rentang min-maks antar-putaran.
const fmtR = (st, d = 2) => (st ? `${st.med.toFixed(d)} (${st.min.toFixed(d)}-${st.max.toFixed(d)})` : 'n/a');
const fmtM = (st, d = 2) => (st ? st.med.toFixed(d) : 'n/a');

function summarize(results, labels) {
  const rows = [];
  for (const label of labels) {
    const runs = results.filter((r) => r.label === label);
    const m = (fn) => stat(runs.map(fn));
    const ph = (name, key) => m((r) => (r.phases[name] ? r.phases[name][key] : null));
    const per = (name) => m((r) => (r.phases[name] ? r.phases[name].cpu / r.phases[name].mib : null));
    const retr = (name, dir) => m((r) => {
      const p = r.phases[name];
      if (!p) return null;
      return p[`${dir}Push`] ? 100 * p[`${dir}Retrans`] / p[`${dir}Push`] : 0;
    });
    const kcp = (name, fn) => m((r) => (r.phases[name] && r.phases[name].kcp ? fn(r.phases[name].kcp, r.phases[name]) : null));
    const xfer = ['download', 'upload', 'parallel'];
    rows.push({
      label, runs: runs.length,
      idleCpuPct: m((r) => (r.phases.idle ? 100 * r.phases.idle.cpu / r.phases.idle.wall : null)),
      pingP50: ph('ping', 'p50'), pingP95: ph('ping', 'p95'),
      downMbps: ph('download', 'mbps'), downCpuMiB: per('download'), downP50: ph('download', 'p50'), downP95: ph('download', 'p95'),
      downRetr: retr('download', 'down'),
      upMbps: ph('upload', 'mbps'), upCpuMiB: per('upload'), upRetr: retr('upload', 'up'),
      parMbps: ph('parallel', 'mbps'), parCpuMiB: per('parallel'), parRetr: retr('parallel', 'down'),
      allCpuMiB: m((r) => {
        const ps = xfer.map((n) => r.phases[n]).filter(Boolean);
        const mib = ps.reduce((t, p) => t + p.mib, 0);
        return mib ? ps.reduce((t, p) => t + p.cpu, 0) / mib : null;
      }),
      downQps: m((r) => (r.phases.download ? r.phases.download.queries / r.phases.download.wall : null)),
      downQPerMiB: m((r) => (r.phases.download ? r.phases.download.queries / r.phases.download.mib : null)),
      downCpuPerKQ: m((r) => (r.phases.download ? 1e6 * r.phases.download.cpu / r.phases.download.queries : null)),
      // Retransmisi server per MiB download, dipecah menurut jenis (instrumen kcp-go).
      kRetr: kcp('download', (k, p) => k.RetransSegs / p.mib),
      kLost: kcp('download', (k, p) => k.LostSegs / p.mib),
      kFast: kcp('download', (k, p) => k.FastRetransSegs / p.mib),
      kEarly: kcp('download', (k, p) => k.EarlyRetransSegs / p.mib),
      kDedup: kcp('download', (k, p) => k.dedup / p.mib),
      kQAvg: kcp('download', (k) => k.queueAvg),
      kQMax: kcp('download', (k) => k.queueMax),
      kSrtt: kcp('download', (k) => k.srttMax),
      kRto: kcp('download', (k) => k.rtoMax),
      kUpRetr: kcp('upload', (k, p) => k.RetransSegs / p.mib),
      unanswered: m((r) => Object.values(r.phases).reduce((t, p) => t + p.unanswered, 0)),
      lost: m((r) => Object.values(r.phases).reduce((t, p) => t + p.lostQ + p.lostR, 0)),
      rateDropped: m((r) => Object.values(r.phases).reduce((t, p) => t + (p.rateDropped || 0), 0)),
      udpDrops: m((r) => { const v = Object.values(r.phases).map((p) => p.udpDrops); return v.includes(null) ? null : v.reduce((t, x) => t + x, 0); }),
      peakMiB: m((r) => r.ram.peak / MiB)
    });
  }
  return rows;
}

function printTable(rows) {
  const tables = [
    [
      ['Konfigurasi', (r) => r.label],
      ['Semua transfer CPU-s/MiB', (r) => fmtR(r.allCpuMiB, 3)],
      ['Down Mbps', (r) => fmtR(r.downMbps)],
      ['Down CPU-s/MiB', (r) => fmtR(r.downCpuMiB, 3)],
      ['Paralel Mbps', (r) => fmtR(r.parMbps)],
      ['Paralel CPU-s/MiB', (r) => fmtR(r.parCpuMiB, 3)],
      ['Up Mbps', (r) => fmtR(r.upMbps)],
      ['Up CPU-s/MiB', (r) => fmtR(r.upCpuMiB, 3)]
    ],
    [
      ['Konfigurasi', (r) => r.label],
      ['Ping sepi p50', (r) => fmtR(r.pingP50, 0)],
      ['Ping sepi p95', (r) => fmtR(r.pingP95, 0)],
      ['Ping saat download p50', (r) => fmtR(r.downP50, 0)],
      ['Ping saat download p95', (r) => fmtR(r.downP95, 0)],
      ['Idle %core', (r) => fmtM(r.idleCpuPct, 2)],
      ['RAM puncak MiB', (r) => fmtM(r.peakMiB, 1)]
    ],
    [
      ['Konfigurasi', (r) => r.label],
      ['Retrans down/up/paralel % (resolver)', (r) => `${fmtM(r.downRetr, 1)}/${fmtM(r.upRetr, 1)}/${fmtM(r.parRetr, 1)}`],
      ['Query/MiB download', (r) => fmtM(r.downQPerMiB, 0)],
      ['Query/s download', (r) => fmtM(r.downQps, 0)],
      ['CPU-ms/1000 query', (r) => fmtM(r.downCpuPerKQ, 1)],
      ['Retrans/MiB total (RTO/fast/early)', (r) => `${fmtM(r.kRetr, 0)} (${fmtM(r.kLost, 0)}/${fmtM(r.kFast, 0)}/${fmtM(r.kEarly, 0)})`],
      ['Dedup dibuang/MiB', (r) => fmtM(r.kDedup, 0)],
      ['Antrean keluar avg/max', (r) => `${fmtM(r.kQAvg, 0)}/${fmtM(r.kQMax, 0)}`],
      ['srtt/rto ms akhir download', (r) => `${fmtM(r.kSrtt, 0)}/${fmtM(r.kRto, 0)}`],
      ['Retrans/MiB upload', (r) => fmtM(r.kUpRetr, 0)],
      ['Tanpa jawaban', (r) => fmtM(r.unanswered, 0)],
      ['Dibuang resolver (loss/laju)', (r) => `${fmtM(r.lost, 0)}/${fmtM(r.rateDropped, 0)}`],
      ['Drop UDP', (r) => fmtM(r.udpDrops, 0)]
    ]
  ];
  for (const cols of tables) {
    console.log(`| ${cols.map((c) => c[0]).join(' | ')} |`);
    console.log(`|${cols.map(() => '---').join('|')}|`);
    for (const r of rows) console.log(`| ${cols.map((c) => c[1](r)).join(' | ')} |`);
    console.log('');
  }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const dir = process.env.DNSTT_NATIVE_DIR;
  if (!dir) { console.log('bench KCP dilewati (set DNSTT_NATIVE_DIR)'); return; }
  const sfx = process.platform === 'win32' ? '.exe' : '';
  const bins = { server: path.join(dir, `dnstt-server${sfx}`), client: path.join(dir, `dnstt-client${sfx}`) };
  assert(fs.existsSync(bins.server) && fs.existsSync(bins.client), 'binary dnstt-server dan dnstt-client tersedia');
  const configs = opt.configs
    ? opt.configs.split(';').filter(Boolean).map((spec) => {
      const eq = spec.indexOf('=');
      const label = eq < 0 ? spec : spec.slice(0, eq);
      const env = {};
      let serverBin = bins.server;
      for (const kv of (eq < 0 ? '' : spec.slice(eq + 1)).split(',').filter(Boolean)) {
        const i = kv.indexOf('=');
        assert(i > 0, `konfigurasi rusak: ${spec}`);
        if (kv.slice(0, i) === 'BIN') serverBin = path.join(kv.slice(i + 1), `dnstt-server${sfx}`);
        else env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      assert(fs.existsSync(serverBin), `binary tidak ada: ${serverBin}`);
      return { label, serverBin, env, expectLog: `window ${env.SLOWDNS_KCP_WINDOW || opt.window}` };
    })
    : opt.combos.split(',').map((c) => {
      const [iv, ack] = c.split(':');
      return {
        label: `${iv} ms, ACK ${ack === '1' ? 'langsung' : 'biasa'}`, serverBin: bins.server,
        env: { SLOWDNS_KCP_INTERVAL: iv, SLOWDNS_KCP_ACK_NODELAY: ack },
        expectLog: `KCP interval ${iv} ms ack-nodelay ${ack === '1'} window ${opt.window}`
      };
    });
  assert.strictEqual(new Set(configs.map((c) => c.label)).size, configs.length, 'label konfigurasi harus unik');
  if (opt['profile-dir']) fs.mkdirSync(opt['profile-dir'], { recursive: true });
  if (opt.baseline) {
    configs.push({ label: 'pembanding (binary lama)', serverBin: path.join(opt.baseline, `dnstt-server${sfx}`), env: {} });
  }
  console.log(`Bench KCP SlowDNS: ${process.platform}/${os.arch()}, ${os.cpus()[0].model}, GOMAXPROCS=${opt.gomaxprocs}, ` +
    `window ${opt.window}, MTU ${opt.mtu}, RTT ${opt.rtt} ms, jitter ${opt.jitter} ms, loss ${opt.loss}%/arah, ` +
    `${opt.rounds} putaran (urutan diputar), download ${opt['down-mib']} MiB, upload ${opt['up-mib']} MiB, ` +
    `paralel ${opt.parallel}x${opt['par-mib']} MiB, idle ${opt['idle-clients'] + 1} klien ${opt['idle-sec']} s, ` +
    `resolver ${opt['resolver-qps'] ? `${opt['resolver-qps']} query/s per klien` : 'tanpa batas laju'}, fase ${opt.phases}`);
  const results = [];
  for (let round = 0; round < opt.rounds; round++) {
    const order = configs.map((_, i) => configs[(i + round) % configs.length]);
    for (const cfg of order) {
      const t0 = Date.now();
      const r = await runConfig({ ...cfg, round: round + 1 }, opt, bins);
      results.push(r);
      const d = r.phases.download, idle = r.phases.idle;
      console.log(`  putaran ${round + 1} ${cfg.label}: down ${fmt(d ? d.mbps : null)} Mbps, ` +
        `CPU ${fmt(d ? d.cpu / d.mib : null, 3)} s/MiB, idle ${fmt(idle ? 100 * idle.cpu / idle.wall : null)}% core ` +
        `(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }
  const rows = summarize(results, configs.map((c) => c.label));
  console.log('\nMedian (min-maks) per konfigurasi:');
  printTable(rows);
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ opt, host: { platform: process.platform, cpu: os.cpus()[0].model, cores: os.cpus().length }, results, rows }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

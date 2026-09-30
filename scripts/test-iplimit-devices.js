'use strict';

// Regresi akurasi IP-limit akun SSH (SSH langsung, SSH-WS, UDPHC, ZIVPN):
// satu HP di jaringan CGNAT/dual-stack tidak boleh terbaca dua perangkat, sesi
// SSH-WS yang sudah mati tidak dihitung, dan lock butuh dua pengecekan
// berturut-turut dengan kelompok IP yang sama.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

const checkerSource = extract(installer, "cat > \"${APP_DIR}/iplimit-checker.js\" <<'EOF'\n", '\nEOF\n')
  .replace("cat > \"${APP_DIR}/iplimit-checker.js\" <<'EOF'\n", '');
const mainCallIndex = checkerSource.lastIndexOf('\nmain().catch((e) => {');
assert(mainCallIndex > 0, 'checker main call not found');
const policySource = `${checkerSource.slice(0, mainCallIndex)}
globalThis.__devicePolicy = {
  countEffectiveDevices,
  readSshWsActivePortIpMap,
  sampleSshDeviceLimit,
  parseXrayAllUserTraffic,
  queryAllXrayUserTraffic,
  readJournalOnce,
  minGap: SSHWS_HARD_LIMIT_MIN_GAP_SECONDS
};
`;

// File di /var/lib/sc-1forcr disimpan di memori; sisanya ke fs asli.
const files = new Map();
const isStateFile = (file) => String(file).startsWith('/var/lib/sc-1forcr/');
const fakeFs = Object.assign(Object.create(fs), {
  existsSync: (file) => (isStateFile(file) ? files.has(file) : fs.existsSync(file)),
  readFileSync: (file, enc) => {
    if (!isStateFile(file)) return fs.readFileSync(file, enc);
    if (!files.has(file)) throw new Error(`ENOENT ${file}`);
    return files.get(file);
  },
  writeFileSync: (file, data, opts) => (isStateFile(file) ? files.set(file, String(data)) : fs.writeFileSync(file, data, opts)),
  renameSync: (from, to) => {
    if (!isStateFile(from)) return fs.renameSync(from, to);
    files.set(to, files.get(from));
    files.delete(from);
    return undefined;
  }
});

// Tabel iplimit_violation_pending di memori, cukup untuk query yang dipakai sampler.
const pending = new Map();
class FakeDatabase {
  run(sql, params, cb) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('DELETE FROM iplimit_violation_pending')) {
      const [user, other] = params;
      for (const [key, row] of pending) {
        if (row.username !== user) continue;
        const devSignal = row.signal.startsWith('ssh-dev-') || row.signal === 'sshws-real-ip';
        if (s.includes("signal LIKE 'ssh-dev-%'")) {
          if (!devSignal) continue;
          if (s.includes('signal<>?') && row.signal === other) continue;
          pending.delete(key);
        } else if (s.endsWith('AND signal=?') && row.signal === other) {
          pending.delete(key);
        }
      }
    } else if (s.startsWith('INSERT OR REPLACE INTO iplimit_violation_pending')) {
      const [username, signal, firstSeen, lastSeen, hits, detected] = params;
      pending.set(`${username}|${signal}`, { username, signal, first_seen: firstSeen, last_seen: lastSeen, hits, detected });
    }
    cb.call({ changes: 1 }, null);
  }
  get(sql, params, cb) {
    cb(null, pending.get(`${params[0]}|${params[1]}`));
  }
  all(sql, params, cb) {
    cb(null, []);
  }
}

// Setiap siklus timer adalah proses checker baru, jadi dimuat ulang per siklus.
function loadChecker({ execFileSync, env = {} } = {}) {
  const context = vm.createContext({
    Buffer,
    console,
    process: { env, pid: 1 },
    require(name) {
      if (name === 'sqlite3') return { verbose: () => ({ Database: FakeDatabase }) };
      if (name === 'fs') return fakeFs;
      if (name === 'child_process' && execFileSync) return { ...require('child_process'), execFileSync };
      return require(name);
    }
  });
  new vm.Script(policySource, { filename: 'iplimit-checker.js' }).runInContext(context);
  return context.__devicePolicy;
}

// --- Hitung perangkat --------------------------------------------------------
{
  const policy = loadChecker();
  const devices = (...ips) => policy.countEffectiveDevices(new Set(ips), 16);
  assert.strictEqual(devices('114.125.10.1', '114.125.200.9'), 1, 'two IPs from one carrier pool (/16) are one device');
  assert.strictEqual(devices('114.125.10.1', '2001:448a:1050::5'), 1, 'IPv4+IPv6 at the same time is one dual-stack device');
  assert.strictEqual(devices('114.125.10.1', '114.125.99.2', '2001:448a:1050::1'), 1);
  assert.strictEqual(devices('114.125.10.1', '182.2.10.1'), 2, 'different networks are still two devices');
  assert.strictEqual(devices('114.125.10.1', '182.2.10.1', '2001:448a:1050::1'), 2);
}

// --- SSH-WS: sesi tanpa trafik baru tidak dihitung -----------------------------
{
  const tsv = '/var/lib/sc-1forcr/sshws-quota.tsv';
  const state = '/var/lib/sc-1forcr/iplimit-sshws-activity.json';
  const session = (id, port, clientBytes, active, ip) => `${id}\t${port}\t${clientBytes}\t1000\t0\t${active}\t${ip}`;
  const portIps = () => Object.fromEntries(loadChecker().readSshWsActivePortIpMap());

  files.set(tsv, [
    session('s-a', 40001, 100, 1, '114.125.1.1'),
    session('s-b', 40002, 500, 1, '36.68.1.1'),
    session('s-c', 40003, 900, 0, '182.2.1.1')
  ].join('\n'));
  assert.deepStrictEqual(portIps(), { 40001: '114.125.1.1', 40002: '36.68.1.1' }, 'new sessions count until there is a baseline');

  files.set(tsv, [session('s-a', 40001, 100, 1, '114.125.1.1'), session('s-b', 40002, 900, 1, '36.68.1.1')].join('\n'));
  assert.deepStrictEqual(portIps(), { 40002: '36.68.1.1' }, 'a session whose client sent nothing since the last check (dead after IP change) must not count');

  const staleState = JSON.parse(files.get(state));
  staleState.updatedAt -= 100000;
  files.set(state, JSON.stringify(staleState));
  assert.deepStrictEqual(portIps(), { 40001: '114.125.1.1', 40002: '36.68.1.1' }, 'a stale baseline must not hide sessions');
}

// --- Konfirmasi dua siklus dengan kelompok IP yang sama -----------------------
(async () => {
  const policy = loadChecker();
  const t0 = 1_800_000_000;
  const sample = (user, ips, detected, limit, ts) => policy.sampleSshDeviceLimit(user, new Set(ips), detected, limit, ts);

  let r = await sample('budi', ['114.125.1.1', '36.68.1.1'], 2, 1, t0);
  assert.deepStrictEqual([r.candidate, r.confirmed], [true, false], 'first violation must not lock');
  r = await sample('budi', ['114.125.1.1', '36.68.1.1'], 2, 1, t0 + 60);
  assert.strictEqual(r.confirmed, false, 'a second sample too soon must not count as a new cycle');
  r = await sample('budi', ['114.125.9.9', '36.68.7.7'], 2, 1, t0 + policy.minGap + 60);
  assert.strictEqual(r.confirmed, true, 'same IP groups over two checks must lock');

  r = await sample('sari', ['114.125.1.1', '36.68.1.1'], 2, 1, t0);
  r = await sample('sari', ['114.125.1.1', '182.2.1.1'], 2, 1, t0 + policy.minGap + 60);
  assert.strictEqual(r.confirmed, false, 'a different IP group set restarts confirmation');

  r = await sample('andi', ['114.125.1.1', '36.68.1.1'], 2, 1, t0);
  r = await sample('andi', ['114.125.1.1'], 1, 1, t0 + 200);
  assert.strictEqual(r.candidate, false);
  r = await sample('andi', ['114.125.1.1', '36.68.1.1'], 2, 1, t0 + 400);
  assert.strictEqual(r.confirmed, false, 'a clean check in between resets confirmation');

  pending.set('rina|sshws-real-ip', { username: 'rina', signal: 'sshws-real-ip', first_seen: t0, last_seen: t0, hits: 1, detected: 2 });
  await sample('rina', ['114.125.1.1', '36.68.1.1'], 2, 1, t0 + 10);
  assert(!pending.has('rina|sshws-real-ip'), 'legacy raw-count pending signal must be cleared');

  r = await sample('unlimited', ['114.125.1.1', '36.68.1.1', '182.2.1.1'], 3, 0, t0);
  assert.strictEqual(r.candidate, false, 'limit 0 means unlimited');

  // --- CGNAT: banyak IP satu operator dalam satu subnet = satu perangkat ------
  // Kasus nyata vpn444 (Trojan, limit 2): 15 IP XL semua di 140.213.148.0/24.
  // Dengan hitungan subnet /16 murni, itu 1 jaringan, jadi TIDAK terkunci.
  {
    const p = loadChecker();
    const dev = (...ips) => p.countEffectiveDevices(new Set(ips), 16);
    const vpn444 = [
      "140.213.148.10", "140.213.148.110", "140.213.148.116", "140.213.148.118",
      "140.213.148.128", "140.213.148.134", "140.213.148.149", "140.213.148.157"
    ];
    assert.strictEqual(dev(...vpn444), 1, "15 IP XL dalam satu /24 tetap 1 jaringan (tidak ada lagi hitung per-IP)");
    // seharr1234: 3 subnet /16 XL berbeda = 3 jaringan (di limit 2 masih perlu toleransi x2).
    assert.strictEqual(dev("112.215.211.178", "140.213.99.194", "203.78.124.54"), 3);
    // Tidak ada lagi argumen operator: countEffectiveDevices murni per subnet.
    assert.strictEqual(p.countEffectiveDevices.length, 2, "countEffectiveDevices hanya (ipSet, mask)");
  }

  // --- Jalur lock SSH memakai sampler, bukan hitungan sesaat -----------------
  const sshBlock = extract(checkerSource, 'async function lockIfExceeded(', '\n}\n');
  assert(/const accountLimitExceeded = deviceSample\.confirmed;/.test(sshBlock), 'SSH lock must require the two-cycle device sample');
  assert(!/cntImmediate > lim/.test(sshBlock), 'no single-sample lock path may remain');
  assert(/countEffectiveDevices\(sshCombinedIpSet, XRAY_IP_GROUP_MASK\)/.test(sshBlock), 'SSH-WS IPs must use the shared device count');
  assert(/\? countEffectiveDevices\(m\.get\(k\), XRAY_IP_GROUP_MASK\)/.test(sshBlock), 'direct SSH, UDPHC and ZIVPN must use the shared device count');
  // Toleransi ZIVPN limit 1 sengaja dipertahankan sampai ada data lock nyata.
  assert(/if \(lim === 1 && cntZivpnRaw > 0 && cntZivpnRaw <= 2\)/.test(sshBlock));
  // Aturan operator/DNS sudah dibuang seluruhnya.
  for (const gone of ['primeOperatorGroups', 'mergedOperatorByIp', 'IPLIMIT_MERGE_ASNS', 'ipNetworkGroup', "require('dns')"]) {
    assert(!checkerSource.includes(gone), `sisa kode operator harus hilang: ${gone}`);
  }
  assert(!/IPLIMIT_MERGE_ASNS/.test(installer), 'variabel IPLIMIT_MERGE_ASNS harus hilang dari installer');

  // UDP (ZIVPN/UDPHC) dan Xray memakai ambang limit x2; SSH tetap di limit.
  // SSH langsung dan SSH-WS: ambang = lim.
  assert(/\[cntSshCombined, sshCombinedIpSet, lim\]/.test(sshBlock), 'SSH combined harus memakai ambang lim');
  // UDPHC dan ZIVPN: ambang = lim x2.
  assert(/const udpDeviceLimit = lim > 0 \? lim \* 2 : 0;/.test(sshBlock), 'UDP harus memakai limit x2');
  assert(/\[cntUdphcIp, setUnionValues\(sshUdphcIpMap\), udpDeviceLimit\]/.test(sshBlock));
  assert(/\[cntZivpnEffective, zivpnIpSet, udpDeviceLimit\]/.test(sshBlock));
  assert(/if \(threshold > 0 && count > threshold\)/.test(sshBlock), 'evidence dikumpulkan per ambang sumber');
  // Xray: ambang lim x2 diteruskan ke sampler.
  const xrayBlock = sshBlock.slice(sshBlock.indexOf("{ type: 'vmess'"));
  assert(/const xrayDeviceLimit = lim > 0 \? lim \* 2 : 0;/.test(xrayBlock), 'Xray harus memakai limit x2');
  assert(/hasLiveEvidence \? xrayDeviceLimit : Number\.MAX_SAFE_INTEGER/.test(xrayBlock), 'ambang Xray diteruskan ke sampler');
  assert(/const cntGrouped = countEffectiveDevices\(lockIpSet, XRAY_IP_GROUP_MASK\);/.test(xrayBlock), 'Xray memakai hitungan subnet murni');

  // --- Kuota Xray: satu query untuk semua akun ------------------------------
  const quota = loadChecker();
  const json = JSON.stringify({ stat: [
    { name: 'user>>>Alice>>>traffic>>>uplink', value: '100' },
    { name: 'user>>>alice>>>traffic>>>downlink', value: '250' },
    { name: 'user>>>bob>>>traffic>>>uplink' },
    { name: 'user>>>bob>>>traffic>>>downlink', value: '7' },
    { name: 'inbound>>>vmess-ws>>>traffic>>>uplink', value: '999' }
  ] });
  assert.deepStrictEqual(Object.fromEntries(quota.parseXrayAllUserTraffic(json)), { alice: 350, bob: 7 },
    'JSON stats must be summed per user; zero values are omitted by protojson');
  // alice tidak punya nilai (0); pencocokan bebas akan memberi alice nilai milik bob.
  const text = 'stat: <\n  name: "user>>>alice>>>traffic>>>uplink"\n>\nstat: <\n  name: "user>>>bob>>>traffic>>>downlink"\n  value: 5\n>\nstat: <\n  name: "user>>>carol>>>traffic>>>uplink"\n  value: 9\n>\n';
  assert.deepStrictEqual(Object.fromEntries(quota.parseXrayAllUserTraffic(text)), { bob: 5, carol: 9 },
    'text stats without a value must not borrow the next stat value');

  const calls = [];
  const okExec = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return json; };
  const traffic = loadChecker({ execFileSync: okExec }).queryAllXrayUserTraffic();
  assert.strictEqual(calls.length, 1, 'all users must be read with a single xray process');
  assert(/statsquery .*-pattern user>>> -reset/.test(calls[0]));
  assert.strictEqual(traffic.get('alice'), 350);

  const failedCalls = [];
  const failExec = (cmd, args) => { failedCalls.push(cmd); throw new Error('api unreachable'); };
  assert.strictEqual(loadChecker({ execFileSync: failExec }).queryAllXrayUserTraffic(), null,
    'a failed query must return null so the per-user fallback runs');

  const quotaBlock = extract(checkerSource, 'const xrayTraffic = queryAllXrayUserTraffic();', '\n  return { zivpnChanged');
  assert(/xrayTraffic\s*\?\s*Number\(xrayTraffic\.get\(user\.toLowerCase\(\)\) \|\| 0\)\s*:\s*queryXrayUserTrafficDelta\(user\)/.test(quotaBlock),
    'quota loop must use the single query and fall back per user only when it failed');

  // --- Log dropbear dibaca sekali per argumen per siklus --------------------
  const journalCalls = [];
  const journal = loadChecker({ execFileSync: (cmd, args) => { journalCalls.push(args.join(' ')); return 'log'; } });
  journal.readJournalOnce(['-u', 'dropbear', '-n', '12000', '--no-pager']);
  journal.readJournalOnce(['-u', 'dropbear', '-n', '12000', '--no-pager']);
  journal.readJournalOnce(['-u', 'dropbear', '--since', '-5 min', '--no-pager']);
  assert.strictEqual(journalCalls.length, 2, 'identical journal reads in one cycle must be served from cache');

  console.log('iplimit device tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

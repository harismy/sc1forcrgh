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
  primeOperatorGroups,
  operatorDnsName,
  parseOperatorAsns,
  xrayRepresentativeIps,
  mergeAsns: () => Array.from(IPLIMIT_MERGE_ASNS.entries()).map(([asn, key]) => asn + '=' + key).sort(),
  ipsPerDevice: () => Array.from(IPLIMIT_MERGE_IPS_PER_DEVICE.entries()).map(([key, n]) => key + '=' + n).sort(),
  xrayViolationSignal,
  cacheSeconds: IP_OPERATOR_CACHE_SECONDS,
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

// Tabel iplimit_violation_pending dan ip_operator_cache di memori, cukup untuk
// query yang dipakai sampler dan pencarian operator. Keduanya bertahan antar
// pemuatan checker, seperti database asli antar siklus timer.
const pending = new Map();
const operatorCache = new Map();

// DNS tiruan untuk pencarian ASN (format jawaban Team Cymru). Test tidak pernah
// menyentuh jaringan.
const ASN_BY_PREFIX = {
  // XL Axiata memakai beberapa ASN (data nyata dari tabel routing); blok yang
  // lebih spesifik ditulis lebih dulu.
  '112.215.10.': '17885', '140.213.200.': '139994',
  '112.215.': '24203', '140.213.': '24203', '203.78.': '24203',
  '114.125.': '23693', '182.1.': '23693',                       // Telkomsel
  '114.4.': '4761'                                              // Indosat
};
function fakeDns({ fail = '', calls = [] } = {}) {
  return {
    promises: {
      Resolver: class {
        setServers() {}
        async resolveTxt(name) {
          calls.push(name);
          if (fail) throw Object.assign(new Error(fail), { code: fail });
          if (name.endsWith('.origin6.asn.cymru.com')) return [['24203 | 2001:448a::/32 | ID | apnic | 2005-01-01']];
          const ip = name.replace('.origin.asn.cymru.com', '').split('.').reverse().join('.');
          const hit = Object.keys(ASN_BY_PREFIX).find((prefix) => ip.startsWith(prefix));
          if (!hit) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
          return [[`${ASN_BY_PREFIX[hit]} | ${ip}/24 | ID | apnic | 2009-02-19`]];
        }
      }
    }
  };
}
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
    } else if (s.startsWith('INSERT OR REPLACE INTO ip_operator_cache')) {
      const [prefix, asns, updatedAt] = params;
      operatorCache.set(prefix, { asns, updated_at: updatedAt });
    }
    cb.call({ changes: 1 }, null);
  }
  get(sql, params, cb) {
    if (String(sql).includes('FROM ip_operator_cache')) return cb(null, operatorCache.get(params[0]));
    return cb(null, pending.get(`${params[0]}|${params[1]}`));
  }
  all(sql, params, cb) {
    cb(null, []);
  }
}

// Setiap siklus timer adalah proses checker baru, jadi dimuat ulang per siklus.
function loadChecker({ execFileSync, env = {}, dns = null } = {}) {
  const context = vm.createContext({
    Buffer,
    console,
    process: { env, pid: 1 },
    require(name) {
      if (name === 'sqlite3') return { verbose: () => ({ Database: FakeDatabase }) };
      if (name === 'fs') return fakeFs;
      if (name === 'child_process' && execFileSync) return { ...require('child_process'), execFileSync };
      // Tanpa DNS tiruan, pencarian operator harus gagal, bukan ke jaringan.
      if (name === 'dns') return dns || fakeDns({ fail: 'ECONNREFUSED' });
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

  // --- Operator yang menyebar satu kartu ke banyak IP (khusus Xray) ----------
  // Kasus nyata: satu HP XL (limit 2) teramati di tiga kelompok IP sekaligus
  // dan terkunci. Untuk XL, IP-limit Xray menghitung jumlah IP: tiap 2 IP
  // adalah satu perangkat (keputusan pemilik). SSH dan UDP tidak berubah.
  {
    // 112.215.10.1 terdaftar di AS17885, tiga lainnya di AS24203: tetap satu operator.
    const XL = ['112.215.211.178', '112.215.10.1', '140.213.99.194', '203.78.124.54'];
    const xray = (p, ips) => p.countEffectiveDevices(new Set(ips), 16, true);
    const ssh = (p, ips) => p.countEffectiveDevices(new Set(ips), 16);
    const calls = [];
    let p = loadChecker({ dns: fakeDns({ calls }) });
    assert.deepStrictEqual(Array.from(p.mergeAsns()),
      ['139994=as24203', '17885=as24203', '24203=as24203', '24208=as24203', '24518=as24203', '58496=as24203'],
      'default: semua ASN XL/Axis adalah satu operator');
    assert.deepStrictEqual(Array.from(p.ipsPerDevice()), ['as24203=2'], 'default: 2 IP XL dihitung satu perangkat');
    assert.strictEqual(xray(p, XL), 3, 'sebelum operatornya dikenali, aturan subnet melihat tiga jaringan');
    await p.primeOperatorGroups(new Set(XL), t0);
    assert.strictEqual(calls.length, 4);
    assert.strictEqual(xray(p, XL), 2, '4 IP XL = 2 perangkat, jadi akun limit 2 tidak terkunci');
    assert.strictEqual(ssh(p, XL), 3, 'SSH, ZIVPN, dan UDP tetap memakai kelompok subnet');
    await p.primeOperatorGroups(new Set(XL), t0);
    assert.strictEqual(calls.length, 4, 'IP yang sama tidak dicari dua kali dalam satu siklus');

    // Jumlah IP menentukan jumlah perangkat, tidak peduli subnetnya.
    const sameSubnet = ['112.215.211.1', '112.215.211.2', '112.215.211.3', '112.215.211.4', '112.215.211.5'];
    await p.primeOperatorGroups(new Set(sameSubnet), t0);
    assert.strictEqual(xray(p, sameSubnet.slice(0, 1)), 1);
    assert.strictEqual(xray(p, sameSubnet.slice(0, 2)), 1, '2 IP = 1 perangkat');
    assert.strictEqual(xray(p, sameSubnet.slice(0, 3)), 2);
    assert.strictEqual(xray(p, sameSubnet.slice(0, 4)), 2, '4 IP = 2 perangkat');
    assert.strictEqual(xray(p, sameSubnet), 3, '5 IP XL = 3 perangkat walau satu subnet: berbagi akun sesama XL terdeteksi');
    assert.strictEqual(ssh(p, sameSubnet), 1);
    assert.strictEqual(xray(p, [...XL, ...sameSubnet]), 5, '9 IP XL = 5 perangkat');

    // Operator lain tidak berubah: tetap per kelompok subnet.
    const telkomsel = ['114.125.10.1', '114.125.99.2', '182.1.100.1'];
    await p.primeOperatorGroups(new Set(telkomsel), t0);
    assert.strictEqual(xray(p, telkomsel), 2, 'Telkomsel tetap dihitung per kelompok subnet');
    assert.strictEqual(xray(p, [...XL, ...telkomsel]), 4, 'XL 2 perangkat + Telkomsel 2 jaringan');
    // IPv6 XL dihitung per /64 dan tetap dual-stack dengan IPv4-nya.
    const dual = [...XL, '2001:448a:1050::5', '2001:448a:1050::9'];
    await p.primeOperatorGroups(new Set(dual), t0);
    assert.strictEqual(xray(p, dual), 2);

    // Notifikasi menampilkan satu IP per perangkat yang terhitung.
    assert.strictEqual(Array.from(p.xrayRepresentativeIps(new Set(XL), 16)).length, 2);
    assert.strictEqual(Array.from(p.xrayRepresentativeIps(new Set([...XL, ...telkomsel]), 16)).length, 4);

    // Alamat XL berganti di tiap pengecekan, jadi sidik jari Xray memakai kunci
    // operatornya; kalau tidak, pelanggaran sungguhan tidak pernah terkonfirmasi.
    const xlLater = ['112.215.211.9', '140.213.99.7', '203.78.124.1', '112.215.10.8', '112.215.211.77'];
    await p.primeOperatorGroups(new Set(xlLater), t0);
    assert.strictEqual(p.xrayViolationSignal(new Set([...XL, ...sameSubnet])), p.xrayViolationSignal(new Set(xlLater)));
    assert.notStrictEqual(p.xrayViolationSignal(new Set(XL)), p.xrayViolationSignal(new Set([...XL, ...telkomsel])));
    // Sampler SSH tidak mengenal operator: XL yang pindah kelompok subnet tetap
    // mengulang konfirmasi, seperti sebelum aturan ini ada.
    let s = await p.sampleSshDeviceLimit('ssh-xl', new Set(['112.215.1.1', '114.125.1.1', '114.4.1.1']), 3, 2, t0);
    s = await p.sampleSshDeviceLimit('ssh-xl', new Set(['140.213.9.9', '114.125.2.2', '114.4.3.3']), 3, 2, t0 + p.minGap + 60);
    assert.strictEqual(s.confirmed, false);

    // Siklus berikutnya (proses baru): hasil diambil dari cache database,
    // walau DNS sedang mati.
    const offlineCalls = [];
    p = loadChecker({ dns: fakeDns({ fail: 'ETIMEOUT', calls: offlineCalls }) });
    await p.primeOperatorGroups(new Set(XL), t0 + 600);
    assert.strictEqual(xray(p, XL), 2, 'cache harus dipakai antar siklus');
    assert.strictEqual(offlineCalls.length, 0, 'IP yang masih ada di cache tidak memicu DNS');
    // Cache kedaluwarsa dan DNS gagal: nilai lama tetap dipakai, bukan dibuang.
    p = loadChecker({ dns: fakeDns({ fail: 'ETIMEOUT', calls: offlineCalls }) });
    await p.primeOperatorGroups(new Set(XL), t0 + p.cacheSeconds + 600);
    assert.strictEqual(xray(p, XL), 2, 'cache lama lebih baik daripada aturan yang salah saat DNS gagal');
    assert(new Set(offlineCalls).size >= 1 && new Set(offlineCalls).size <= 4);

    // Tanpa cache dan DNS gagal: aturan subnet tetap berlaku, dan setelah tiga
    // kegagalan sisa pencarian dilewati supaya checker tidak tertahan.
    operatorCache.clear();
    const failedCalls = [];
    p = loadChecker({ dns: fakeDns({ fail: 'ETIMEOUT', calls: failedCalls }) });
    await p.primeOperatorGroups(new Set(XL), t0);
    assert.strictEqual(xray(p, XL), 3, 'DNS gagal tidak boleh mengubah hitungan');
    await p.primeOperatorGroups(new Set(['114.4.1.1', '114.4.2.2', '114.125.1.1', '182.1.1.1']), t0);
    assert.strictEqual(new Set(failedCalls).size, 4, 'pencarian berhenti setelah beberapa kegagalan');
    assert.strictEqual(failedCalls.length, 8, 'tiap IP dicoba lewat resolver sistem lalu resolver publik');
    assert.strictEqual(operatorCache.size, 0, 'kegagalan DNS tidak boleh disimpan sebagai jawaban');

    // IP yang tidak ada di tabel routing disimpan sebagai "tidak diketahui".
    p = loadChecker({ dns: fakeDns() });
    await p.primeOperatorGroups(new Set(['198.51.100.7']), t0);
    assert.deepStrictEqual(operatorCache.get('198.51.100.0/24'), { asns: '', updated_at: t0 });

    // Daftar operator dan angkanya bisa diubah atau dikosongkan lewat env.
    const withEnv = async (value, ips) => {
      operatorCache.clear();
      const dnsCalls = [];
      const checker = loadChecker({ env: { IPLIMIT_MERGE_ASNS: value }, dns: fakeDns({ calls: dnsCalls }) });
      await checker.primeOperatorGroups(new Set(ips), t0);
      return { checker, dnsCalls };
    };
    let e = await withEnv('', XL);
    assert.strictEqual(xray(e.checker, XL), 3, 'daftar kosong mematikan aturan operator');
    assert.strictEqual(e.dnsCalls.length, 0, 'daftar kosong tidak boleh memicu DNS');
    e = await withEnv('24203+17885+139994:4', XL);
    assert.strictEqual(xray(e.checker, XL), 1, ':4 berarti 4 IP = 1 perangkat');
    e = await withEnv('24203+17885+139994', [...XL, ...sameSubnet]);
    assert.deepStrictEqual(Array.from(e.checker.ipsPerDevice()), ['as24203=0']);
    assert.strictEqual(xray(e.checker, [...XL, ...sameSubnet]), 1, 'tanpa ":N" seluruh operator satu perangkat');
    e = await withEnv('AS24203+17885:2, 23693:3 bukan-angka', [...XL, ...telkomsel]);
    assert.deepStrictEqual(Array.from(e.checker.mergeAsns()), ['17885=as24203', '23693=as23693', '24203=as24203'],
      '"+" menggabung ASN satu operator, koma memisahkan operator');
    assert.deepStrictEqual(Array.from(e.checker.ipsPerDevice()), ['as23693=3', 'as24203=2']);
    assert.strictEqual(xray(e.checker, [...XL, ...telkomsel]), 3, 'XL 4 IP = 2, Telkomsel 3 IP dengan :3 = 1');
    // ASN XL yang tidak dicantumkan kembali dihitung per subnet.
    e = await withEnv('24203:2', XL);
    assert.strictEqual(xray(e.checker, XL), 3, '3 IP AS24203 = 2 perangkat, ditambah 112.215.10.1 (AS17885) per subnet');

    assert.strictEqual(p.operatorDnsName('112.215.211.178'), '178.211.215.112.origin.asn.cymru.com');
    assert.strictEqual(p.operatorDnsName('2001:448a::5'),
      '5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.a.8.4.4.1.0.0.2.origin6.asn.cymru.com');
    assert.strictEqual(p.operatorDnsName('bukan-ip'), '');
    assert.deepStrictEqual(Array.from(p.parseOperatorAsns('24203 | 112.215.211.0/24 | ID | apnic | 2009-02-19')), ['24203']);
    assert.deepStrictEqual(Array.from(p.parseOperatorAsns('23693 4761 | 10.0.0.0/8 | ID')), ['23693', '4761']);
    operatorCache.clear();
  }

  // Aturan operator hanya dipasang di jalur Xray, dan pemilik IP dicari
  // sebelum hitungan yang dipakai untuk keputusan lock.
  {
    const lockBlock = extract(checkerSource, 'async function lockIfExceeded(', '\n}\n');
    const xrayStart = lockBlock.indexOf("{ type: 'vmess', table: 'account_vmesses' }");
    assert(xrayStart > 0, 'awal jalur Xray tidak ditemukan');
    const sshPart = lockBlock.slice(0, xrayStart);
    const xrayPart = lockBlock.slice(xrayStart);
    assert(!sshPart.includes('primeOperatorGroups') && !/countEffectiveDevices\([^)]*, true\)/.test(sshPart),
      'jalur SSH/ZIVPN/UDP tidak boleh memakai aturan operator');
    const iPrime = xrayPart.indexOf('if (lim > 0 && cntRaw > lim) await primeOperatorGroups(lockIpSet, nowTs);');
    const iCount = xrayPart.indexOf('const cntGrouped = countEffectiveDevices(lockIpSet, XRAY_IP_GROUP_MASK, true);');
    assert(iPrime > 0 && iCount > iPrime, 'jalur Xray harus mengenali operator sebelum menghitung perangkat');
    assert(checkerSource.includes('return `xray-ip-${ipGroupFingerprint(ipSet, true)}`;'));
    assert(checkerSource.includes('const signal = `ssh-dev-${ipGroupFingerprint(evidenceIps)}`;'));
    // Variabelnya harus sampai ke checker dan bertahan lintas update.
    const XL_DEFAULT = '24203+17885+24208+24518+139994+58496:2';
    assert(installer.includes(`\nIPLIMIT_MERGE_ASNS="\${IPLIMIT_MERGE_ASNS-${XL_DEFAULT}}"\n`));
    assert(checkerSource.includes(`const IPLIMIT_MERGE_ASNS_DEFAULT = '${XL_DEFAULT}';`), 'default shell dan default checker harus sama');
    assert.strictEqual((installer.match(/^IPLIMIT_MERGE_ASNS=\$\{IPLIMIT_MERGE_ASNS\}$/gm) || []).length, 2, 'harus ditulis ke .env aplikasi dan /etc/sc-1forcr.env');
    assert(installer.includes(`    IPLIMIT_MERGE_ASNS="\${IPLIMIT_MERGE_ASNS-${XL_DEFAULT}}" \\\n`), 'harus diteruskan di jalur update');
    assert(/IPLIMIT_AUTO_TUNE IPLIMIT_DEBUG IPLIMIT_MERGE_ASNS\n/.test(installer), 'harus ikut ke lanjut-install');
  }

  // --- Jalur lock SSH memakai sampler, bukan hitungan sesaat -----------------
  const sshBlock = extract(checkerSource, 'async function lockIfExceeded(', '\n}\n');
  assert(/const accountLimitExceeded = deviceSample\.confirmed;/.test(sshBlock), 'SSH lock must require the two-cycle device sample');
  assert(!/cntImmediate > lim/.test(sshBlock), 'no single-sample lock path may remain');
  assert(/countEffectiveDevices\(sshCombinedIpSet, XRAY_IP_GROUP_MASK\)/.test(sshBlock), 'SSH-WS IPs must use the shared device count');
  assert(/\? countEffectiveDevices\(m\.get\(k\), XRAY_IP_GROUP_MASK\)/.test(sshBlock), 'direct SSH, UDPHC and ZIVPN must use the shared device count');
  // Toleransi ZIVPN limit 1 sengaja dipertahankan sampai ada data lock nyata.
  assert(/if \(lim === 1 && cntZivpnRaw > 0 && cntZivpnRaw <= 2\)/.test(sshBlock));

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

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const installer = fs.readFileSync(path.join(__dirname, 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
const checker = installer.split("cat > \"${APP_DIR}/iplimit-checker.js\" <<'EOF'\n")[1].split('\nEOF\n')[0];
const part = (start, end) => checker.slice(checker.indexOf(start), checker.indexOf(end, checker.indexOf(start)));
const policy = part('function readSlowdnsTunnelUsage(', 'async function sampleSshwsHardLimit(');
const lockStart = checker.indexOf('async function lockIfExceeded(');
const lock = checker.slice(lockStart, checker.indexOf('\n}\n', lockStart) + 3);
const activity = '/var/lib/sc-1forcr/iplimit-slowdns-activity.json';

function fixture() {
  const files = new Map([['/var/lib/sc-1forcr/slowdns.state', 'ENABLED=1\n']]);
  const pending = new Map(), actions = [], histories = [], notifications = [];
  let raw = '', calls = 0, failWrite = false, failPrepare = false, accountLimit = 1, locked = false, lockedUntil = 0;
  let xrayRows = [];
  const modes = [];
  const context = vm.createContext({
    console, crypto, require, process: { pid: 7 },
    SLOWDNS_AUTO_LOCK_ENABLED: true, SLOWDNS_ACTIVITY_FILE: activity, SLOWDNS_LOCK_SECONDS: 900,
    SLOWDNS_QUOTA_STREAMS_FILE: '/var/lib/sc-1forcr/iplimit-slowdns-quota.json', lastSlowdnsSnapshot: null,
    SSHWS_HARD_LIMIT_CONFIRM_CYCLES: 2, SSHWS_HARD_LIMIT_MIN_GAP_SECONDS: 90, SSHWS_HARD_LIMIT_MAX_GAP_SECONDS: 420,
    AUTO_LOCK_ENABLED: true, IPLIMIT_DEBUG: false, ZIVPN_AUTH_MODE: 'http', XRAY_IP_GROUP_MASK: 16,
    SSHWS_ACCOUNT_SESSION_HARD_LIMIT: 8, LOCK_SECONDS: 3600,
    XRAY_LIMIT_CONFIRM_CYCLES: 2, XRAY_LIMIT_MIN_GAP_SECONDS: 90, XRAY_LIMIT_MAX_GAP_SECONDS: 420, XRAY_BLOCK_TCP_PORTS: [80, 443],
    sampleXrayIpLimit: async () => ({ candidate: false, confirmed: false, hits: 0, signal: '' }),
    addTcpDropRule: () => { actions.push(['tcp-drop']); return true; }, disconnectXrayIpNow() {},
    rebuildXrayFromDb: async () => { actions.push(['rebuild-xray']); },
    detectLockedUsersStillInXrayConfig: async () => ({ changed: false, users: [] }), stopXrayFailClosed() {},
    fs: {
      readFileSync(file) { if (!files.has(file)) throw Error('ENOENT'); return files.get(file); },
      mkdirSync() {},
      writeFileSync(file, data) { if (failWrite) throw Error('read only'); files.set(file, data); },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); }
    },
    execFileSync(command, args) {
      assert.strictEqual(command, '/usr/local/sbin/sc-1forcr-slowdns');
      assert.strictEqual(args[0], 'sessions'); calls++; modes.push(args[1]); return raw;
    },
    async run(sql, params = []) {
      const s = String(sql).replace(/\s+/g, ' ');
      // Query Xray membawa account_type=? di depan: [tipe, akun, signal].
      const p = s.includes('account_type=?') || s.includes('VALUES(?, ?, ?, ?, ?, ?, ?)') ? params.slice(1) : params;
      if (s.includes('DELETE FROM iplimit_violation_pending')) {
        for (const [key, row] of pending) {
          if (row.username !== p[0]) continue;
          const like = (s.match(/signal LIKE '([a-z-]+)%'/) || [])[1];
          if (like) {
            if (row.signal.startsWith(like) && row.signal !== p[1]) pending.delete(key);
          } else if (!s.includes('signal=?') || row.signal === p[1]) pending.delete(key);
        }
      } else if (s.includes('INSERT OR REPLACE INTO iplimit_violation_pending')) {
        const [username, signal, first_seen, last_seen, hits, detected] = p;
        pending.set(username + '|' + signal, { username, signal, first_seen, last_seen, hits, detected });
      } else if (s.includes('INSERT OR REPLACE INTO temp_ip_locks')) {
        if (failPrepare) throw Error('database write failed');
        locked = true; lockedUntil = s.includes('VALUES(?, ?, ?, 0)') ? params[2] : params[1];
        actions.push(['temporary-lock', ...params]);
      } else if (/UPDATE account_\w+ SET status='LOCK_TMP'/.test(s)) {
        actions.push(['status', ...params]);
      }
      return { changes: 1 };
    },
    async get(sql, params = []) {
      if (sql.startsWith('SELECT l.locked_until')) return { locked_until: lockedUntil, status: 'LOCK_TMP' };
      if (sql.includes('iplimit_violation_pending')) return pending.get(params.at(-2) + '|' + params.at(-1));
      if (sql.includes('temp_ip_locks')) return locked ? { ok: 1 } : undefined;
      return undefined;
    },
    async all(sql) {
      if (sql.includes('FROM account_sshs WHERE')) return [{ username: 'alice', password: 'example', limitip: accountLimit }];
      if (sql.includes('FROM account_vlesses WHERE')) return xrayRows;
      return [];
    },
    parseSshAndUdpUsage: () => Object.fromEntries(['ipMap', 'sessionMap', 'recentAuthMap', 'procSessionMap', 'wsClientPortMap', 'sshWsIpMap', 'udphcSessionMap', 'udphcIpMap', 'zivpnSessionMap', 'zivpnIpMap'].map((k) => [k, new Map()])),
    readZivpnLiveMap: async () => ({ sessionMap: new Map(), ipMap: new Map() }),
    parseXrayRecentIpMap: () => new Map(), readXrayLiveSocketMap: () => ({ available: false, sockets: new Map() }),
    getActiveUdpLockPort: () => 5667, countEffectiveDevices: (set) => set.size, countIpGroups: (set) => set.size,
    sampleSshDeviceLimit: async () => ({ confirmed: false }), sampleSshwsHardLimit: async () => ({ confirmed: false }),
    extractIp: (s) => s, isLoopbackIp: () => false,
    killSshSessionsForUser: (user) => actions.push(['disconnect', user]),
    safeExec: (cmd, args) => actions.push([cmd, ...args]),
    extractClientPortsFromSessionKeys: () => new Set(), disconnectSshWsByClientPorts() {},
    verifySshSessionsClosed: async () => {}, addUdpDropRule: () => false,
    removeZivpnUser: () => false, removeUdpcustomUser: () => false,
    createIpLimitLockHistory: async (data) => { histories.push(data); return 1; },
    notifyMultiLoginLock: async (...args) => notifications.push(args),
    notifyLongTermIpWarning: async () => {}
  });
  new vm.Script(policy + '\n' + lock + '\nglobalThis.api={readSlowdnsTunnelUsage,sampleSlowdnsTunnelLimit,sampleXraySlowdnsLimit,lockIfExceeded,parseSlowdnsSessions,readSlowdnsQuotaCounters};').runInContext(context);
  const snapshot = (rows, instance = '1008.1234567890') => {
    raw = 'SC_SLOWDNS_USERS_V1|' + instance + '\n' + rows.map(([cid, up, port, started = 500]) =>
      `alice|${cid.repeat(16)}|${up}|${port}|${BigInt(started) * 1000000000n}`).join('\n') + '\nEND\n';
  };
  return {
    api: context.api, context, files, pending, actions, histories, notifications, snapshot, modes,
    raw(value) { raw = value; }, limit(n) { accountLimit = n; }, failWrite() { failWrite = true; }, failPrepare() { failPrepare = true; }, calls: () => calls,
    xrayAccounts(rows) { xrayRows = rows; }
  };
}

(async () => {
  // Banyak koneksi SSH pada satu ClientID tetap satu tunnel.
  let f = fixture();
  f.snapshot([['a', 100, 40001], ['a', 200, 40002]]);
  assert.strictEqual(f.api.readSlowdnsTunnelUsage(1000).size, 0, 'sampel pertama hanya membangun baseline');
  f.snapshot([['a', 200, 40001], ['a', 300, 40002]]);
  let use = f.api.readSlowdnsTunnelUsage(1180);
  assert.strictEqual(use.get('alice').size, 1);
  assert.strictEqual((await f.api.sampleSlowdnsTunnelLimit('alice', use.get('alice'), 1, 1180)).confirmed, false);
  assert.strictEqual((await f.api.sampleSlowdnsTunnelLimit('alice', use.get('alice'), 0, 1360)).confirmed, false, 'limit 0 tidak dibatasi');

  // Tunnel lama tanpa trafik baru (mis. setelah mode pesawat) tidak jadi bukti.
  f = fixture();
  f.snapshot([['a', 100, 40001], ['b', 100, 40002]]); f.api.readSlowdnsTunnelUsage(1000);
  f.snapshot([['a', 100, 40001], ['b', 200, 40002]]);
  assert.strictEqual(f.api.readSlowdnsTunnelUsage(1180).get('alice').size, 1);

  // Grace koneksi baru, baseline kedaluwarsa, restart DNSTT, metadata rusak,
  // dan kegagalan menulis state tidak boleh menghasilkan bukti lock.
  f = fixture(); f.snapshot([['a', 100, 40001, 990]]); f.api.readSlowdnsTunnelUsage(1000);
  f.snapshot([['a', 200, 40001, 990]]); assert.strictEqual(f.api.readSlowdnsTunnelUsage(1050).size, 0);
  f.snapshot([['a', 300, 40001, 990]]); assert.strictEqual(f.api.readSlowdnsTunnelUsage(2000).size, 0);
  f.snapshot([['a', 400, 40001, 990]], '9999.1234567890'); assert.strictEqual(f.api.readSlowdnsTunnelUsage(2180).size, 0);
  f.raw('SC_SLOWDNS_USERS_V1|9999.1234567890\nalice|bad\nEND\n'); assert.strictEqual(f.api.readSlowdnsTunnelUsage(2360).size, 0);
  f.raw('SC_SLOWDNS_USERS_V1|9999.1234567890\n'); assert.strictEqual(f.api.readSlowdnsTunnelUsage(2360).size, 0);
  f = fixture(); f.snapshot([['a', 100, 40001]]); f.api.readSlowdnsTunnelUsage(1000);
  f.snapshot([['a', 200, 40001]]); f.failWrite(); assert.strictEqual(f.api.readSlowdnsTunnelUsage(1180).size, 0);
  f = fixture(); f.snapshot([['a', 100, 40001]]);
  f.files.set('/etc/sc-1forcr.env', 'SLOWDNS_AUTO_LOCK_ENABLE=0\n');
  assert.strictEqual(f.api.readSlowdnsTunnelUsage(1000).size, 0); assert.strictEqual(f.calls(), 0);
  f.files.set('/etc/sc-1forcr.env', 'SLOWDNS_AUTO_LOCK_ENABLE=invalid\n');
  assert.strictEqual(f.api.readSlowdnsTunnelUsage(1000).size, 0); assert.strictEqual(f.calls(), 0);
  f.files.set('/etc/sc-1forcr.env', 'SLOWDNS_AUTO_LOCK_ENABLE=1\n'); f.files.set('/var/lib/sc-1forcr/slowdns.state', 'ENABLED=0\n');
  assert.strictEqual(f.api.readSlowdnsTunnelUsage(1000).size, 0); assert.strictEqual(f.calls(), 0);

  // Identitas tunnel yang berubah mereset konfirmasi; refresh cepat tidak
  // menambah hit, dan kembali di bawah limit menghapus kandidat lama.
  f = fixture();
  const ids = new Set(['1008.1:' + 'a'.repeat(16), '1008.1:' + 'b'.repeat(16)]);
  assert.strictEqual((await f.api.sampleSlowdnsTunnelLimit('alice', ids, 1, 1000)).hits, 1);
  assert.strictEqual((await f.api.sampleSlowdnsTunnelLimit('alice', ids, 1, 1010)).hits, 1);
  const changed = new Set(['1008.1:' + 'a'.repeat(16), '1008.1:' + 'c'.repeat(16)]);
  assert.strictEqual((await f.api.sampleSlowdnsTunnelLimit('alice', changed, 1, 1180)).hits, 1);
  assert.strictEqual((await f.api.sampleSlowdnsTunnelLimit('alice', new Set(), 1, 1360)).confirmed, false);
  assert.strictEqual(f.pending.size, 0);

  // Jalur lock sungguhan: dua tunnel aktif, satu akun berlimit 1, dua cek
  // berturut-turut setelah baseline. Putus akun itu dan lock tepat 900 detik.
  f = fixture();
  f.snapshot([['a', 100, 40001], ['b', 100, 40002]]); await f.api.lockIfExceeded(1000);
  f.snapshot([['a', 200, 40001], ['b', 200, 40002]]); await f.api.lockIfExceeded(1180);
  assert.strictEqual(f.actions.length, 0, 'satu cek belum boleh lock');
  f.snapshot([['a', 300, 40001], ['b', 300, 40002]]); await f.api.lockIfExceeded(1360);
  assert(f.actions.some((a) => a[0] === 'passwd' && a[1] === '-l' && a[2] === 'alice'));
  assert(f.actions.some((a) => a[0] === 'disconnect' && a[1] === 'alice'));
  assert(f.actions.findIndex((a) => a[0] === 'passwd' && a[1] === '-l') <
    f.actions.findIndex((a) => a[0] === 'disconnect'), 'password harus terkunci sebelum sesi diputus agar reconnect tidak lolos');
  assert(f.actions.some((a) => a[0] === 'temporary-lock' && a[2] === 2260));
  assert.strictEqual(f.histories[0].service, 'slowdns');
  assert.strictEqual(f.histories[0].locked_until - f.histories[0].locked_at, 900);
  assert.strictEqual(f.notifications[0][7].unlock_minutes, 15);

  // Gagal menyimpan expiry di DB tidak boleh sampai mengubah password atau
  // memutus sesi, karena akun nantinya tidak punya jalur pemulihan otomatis.
  f = fixture(); f.failPrepare();
  for (const [at, bytes] of [[1000, 100], [1180, 200], [1360, 300]]) {
    f.snapshot([['a', bytes, 40001], ['b', bytes, 40002]]); await f.api.lockIfExceeded(at);
  }
  assert.strictEqual(f.actions.length, 0);

  // Limit 2 mengizinkan dua tunnel; saklar global OFF tidak menjalankan guard.
  f = fixture(); f.limit(2);
  for (const [at, bytes] of [[1000, 100], [1180, 200], [1360, 300]]) {
    f.snapshot([['a', bytes, 40001], ['b', bytes, 40002]]); await f.api.lockIfExceeded(at);
  }
  assert.strictEqual(f.actions.length, 0);
  f.context.AUTO_LOCK_ENABLED = false;
  const before = f.calls(); await f.api.lockIfExceeded(1540); assert.strictEqual(f.calls(), before);

  // SlowDNS Xray (V.1FSC.135): tunnel per akun Xray dari baris X helper
  // `sessions 3`. Ambang limit x2 (aturan Xray), bukti sama dengan SSH, dua cek
  // berturut-turut, lock 900 detik lewat jalur lock Xray tanpa blokir IP.
  {
    const x = fixture();
    x.xrayAccounts([{ username: 'carol', limitip: 1 }]);
    const xsnap = (rows, extra = '') => x.raw('SC_SLOWDNS_USERS_V3|1008.1234567890|2\n' + extra +
      rows.map(([cid, up, port]) => `X|vless|carol|${cid.repeat(16)}|${up}|${port}|500000000000|0\n`).join('') + 'END\n');
    // Dua tunnel dengan limit 1 (ambang 2): tidak pernah lock.
    for (const [at, bytes] of [[1000, 100], [1180, 200], [1360, 300]]) {
      xsnap([['a', bytes, 45001], ['b', bytes, 45002]]); await x.api.lockIfExceeded(at);
    }
    assert(!x.actions.some((a) => a[0] === 'temporary-lock'), 'limit 1 x2: dua tunnel (mis. Load Balance) aman');
    assert(x.modes.every((m) => m === '3'), 'checker meminta format V3');
    // Tiga tunnel: cek pertama = baseline, kedua = kandidat, ketiga = lock.
    const y = fixture();
    y.xrayAccounts([{ username: 'carol', limitip: 1, owner_telegram_id: 77 }]);
    const ysnap = (bytes) => y.raw('SC_SLOWDNS_USERS_V3|1008.1234567890|2\n' +
      // Akun SSH alice tetap di bawah limit; baris SSH tidak tercampur dengan X.
      `alice|${'d'.repeat(16)}|${bytes}|40001|500000000000|0\n` +
      ['a', 'b', 'c'].map((c, i) => `X|vless|carol|${c.repeat(16)}|${bytes}|${45001 + i}|500000000000|0\n`).join('') + 'END\n');
    ysnap(100); await y.api.lockIfExceeded(1000);
    ysnap(200); await y.api.lockIfExceeded(1180);
    assert(!y.actions.some((a) => a[0] === 'temporary-lock'), 'satu cek belum boleh lock');
    ysnap(300); await y.api.lockIfExceeded(1360);
    const lockRow = y.actions.find((a) => a[0] === 'temporary-lock');
    assert(lockRow && lockRow[1] === 'vless' && lockRow[2] === 'carol' && lockRow[3] === 1360 + 900, JSON.stringify(y.actions));
    assert(y.actions.some((a) => a[0] === 'rebuild-xray'), 'akun dicabut dari config Xray');
    assert(!y.actions.some((a) => a[0] === 'tcp-drop'), 'lock SlowDNS tidak memblokir IP (sumbernya 127.0.0.1)');
    assert(!y.actions.some((a) => a[0] === 'passwd'), 'akun SSH alice tidak tersentuh');
    const h = y.histories[0];
    assert.strictEqual(h.account_type, 'vless');
    assert.strictEqual(h.service, 'slowdns');
    assert.strictEqual(h.limitip, 2, 'batas tunnel = limit x2');
    assert.strictEqual(h.detected, 3);
    assert.strictEqual(h.locked_until - h.locked_at, 900);
    assert(/VLESS lewat SlowDNS: 3 tunnel aktif; batas 2/.test(h.device_detected_label), h.device_detected_label);
    assert.strictEqual(y.notifications[0][0], 'slowdns');
    assert.strictEqual(y.notifications[0][7].unlock_minutes, 15);
    // Saklar auto-lock SlowDNS OFF: tidak ada bukti tunnel (Xray juga).
    const z = fixture();
    z.xrayAccounts([{ username: 'carol', limitip: 1 }]);
    z.files.set('/etc/sc-1forcr.env', 'SLOWDNS_AUTO_LOCK_ENABLE=0\n');
    for (const [at, bytes] of [[1000, 100], [1180, 200], [1360, 300]]) {
      z.raw('SC_SLOWDNS_USERS_V3|1008.1234567890|2\n' + ['a', 'b', 'c'].map((c, i) =>
        `X|vless|carol|${c.repeat(16)}|${bytes}|${45001 + i}|500000000000|0\n`).join('') + 'END\n');
      await z.api.lockIfExceeded(at);
    }
    assert(!z.actions.some((a) => a[0] === 'temporary-lock'), 'auto-lock SlowDNS OFF juga untuk Xray');
    // Helper lama (tidak mengenal mode 3, mencetak V1): ulang dengan mode 2.
    const w = fixture();
    w.raw('SC_SLOWDNS_USERS_V1|1008.1234567890\nalice|' + 'a'.repeat(16) + '|100|40001|500000000000\nEND\n');
    w.api.readSlowdnsTunnelUsage(1000);
    assert.deepStrictEqual(w.modes, ['3', '2'], 'helper lama: fallback ke sessions 2 (kuota SSH tetap terhitung)');
    // Parser V3.
    const p = w.api.parseSlowdnsSessions;
    const v3 = p('SC_SLOWDNS_USERS_V3|1.2|2\nalice|' + 'a'.repeat(16) + '|1|40001|500000000000|1\n' +
      'X|trojan|dave|' + 'b'.repeat(16) + '|5|40001|500000000000|6\nEND');
    assert(v3 && v3.live.length === 1 && v3.xray.length === 1 && v3.xray[0].proto === 'trojan' && v3.xray[0].port === 40001,
      'port X boleh sama dengan port SSH (koneksi ke tujuan lain)');
    assert.strictEqual(p('SC_SLOWDNS_USERS_V3|1.2|2\nX|ssh|dave|' + 'b'.repeat(16) + '|5|40001|500000000000|6\nEND'), null, 'protokol X tidak dikenal = rusak');
    assert.strictEqual(p('SC_SLOWDNS_USERS_V3|1.2|2\nX|vless|dave|' + 'b'.repeat(16) + '|5|40001|500000000000|6\n' +
      'X|vless|erin|' + 'c'.repeat(16) + '|5|40001|500000000000|6\nEND'), null, 'port X ganda = rusak');
    assert.strictEqual(p('SC_SLOWDNS_USERS_V2|1.2|2\nX|vless|dave|' + 'b'.repeat(16) + '|5|40001|500000000000|6\nEND'), null,
      'baris X hanya sah di V3');
  }
  // Kuota SSH lewat SlowDNS (V.1FSC.130): upload+download per stream yang
  // username-nya terverifikasi, stream putus dipetakan dari sampel saat masih
  // hidup, dan data tidak utuh atau binary lama tidak menghasilkan pemakaian.
  {
    const q = fixture();
    const v2 = (live, ended = [], ver = 2, instance = '1008.1234567890') => q.raw(
      `SC_SLOWDNS_USERS_V2|${instance}|${ver}\n` +
      live.map(([u, c, up, port, down]) => `${u}|${c.repeat(16)}|${up}|${port}|500000000000|${down}\n`).join('') +
      ended.map(([c, up, port, down]) => `E|${c.repeat(16)}|${up}|${port}|500000000000|${down}|600000000000\n`).join('') + 'END\n');
    const key = (c, port, instance = '1008.1234567890') => `slowdns:${instance}:${c.repeat(16)}:${port}:500000000000`;
    const counters = (at) => { q.context.lastSlowdnsSnapshot = null; return q.api.readSlowdnsQuotaCounters(at); };

    v2([['alice', 'a', 100, 40001, 900], ['bob', 'b', 50, 40002, 50]], [['c', 70, 39000, 30]]);
    let c = counters(1000);
    assert.strictEqual(c.get('alice').get(key('a', 40001)), 1000, 'upload + download per stream');
    assert.strictEqual(c.get('bob').get(key('b', 40002)), 100);
    assert(![...c.values()].some((m) => [...m.keys()].some((k) => k.includes('c'.repeat(16)))),
      'stream putus yang tidak pernah terlihat hidup tidak dibebankan ke siapa pun');

    v2([['bob', 'b', 60, 40002, 140]], [['a', 150, 40001, 1850]]);
    c = counters(1300);
    assert.strictEqual(c.get('alice').get(key('a', 40001)), 2000, 'byte akhir stream putus tetap milik alice');
    assert.strictEqual(c.get('bob').get(key('b', 40002)), 200);

    v2([['bob', 'b', 60, 40002, 140]], [['a', 150, 40001, 1850]], 2, '2000.1234567890');
    c = counters(1600);
    assert(!c.has('alice'), 'DNSTT restart (instance baru) tidak memakai peta stream lama');

    q.raw('SC_SLOWDNS_USERS_V2|1008.1234567890|1\nalice|' + 'a'.repeat(16) + '|100|40001|500000000000|-\nEND\n');
    assert.strictEqual(counters(1900).size, 0, 'binary lama tanpa byte download tidak dihitung');
    q.raw('SC_SLOWDNS_USERS_V2|1008.1234567890|2\nalice|' + 'a'.repeat(16) + '|100|40001|500000000000|-\nEND\n');
    assert.strictEqual(counters(1900).size, 0, 'monitor V2 tanpa kolom down = data rusak');
    q.raw('SC_SLOWDNS_USERS_V2|1008.1234567890|2\nalice|' + 'a'.repeat(16) + '|100|40001|500000000000|9\n');
    assert.strictEqual(counters(1900).size, 0, 'tanpa END = tidak utuh');
    q.files.set('/var/lib/sc-1forcr/slowdns.state', 'ENABLED=0\n');
    const callsBefore = q.calls();
    assert.strictEqual(counters(1900).size, 0); assert.strictEqual(q.calls(), callsBefore, 'SlowDNS mati: helper tidak dipanggil');

    // Satu panggilan helper per siklus: limit tunnel lalu kuota memakai snapshot yang sama.
    const r = fixture();
    r.raw('SC_SLOWDNS_USERS_V2|1008.1234567890|2\nalice|' + 'a'.repeat(16) + '|100|40001|500000000000|900\nEND\n');
    r.api.readSlowdnsTunnelUsage(1000);
    assert.strictEqual(r.calls(), 1);
    assert.strictEqual(r.api.readSlowdnsQuotaCounters(1000).get('alice').size, 1);
    assert.strictEqual(r.calls(), 1, 'kuota memakai snapshot limit tunnel, bukan panggilan helper kedua');

    const p = q.api.parseSlowdnsSessions;
    assert.strictEqual(p('SC_SLOWDNS_USERS_V1|1.2\nalice|' + 'a'.repeat(16) + '|1|40001|500000000000\nEND').bytes, false);
    assert.strictEqual(p('SC_SLOWDNS_USERS_V2|1.2|1\nE|' + 'a'.repeat(16) + '|1|40001|500000000000|1|600000000000\nEND'), null,
      'baris E dari monitor lama tidak mungkin = rusak');
    assert.strictEqual(p('SC_SLOWDNS_USERS_V2|1.2|2\nalice|' + 'a'.repeat(16) + '|1|40001|500000000000|1\nbob|' +
      'b'.repeat(16) + '|1|40001|500000000000|1\nEND'), null, 'port ganda = rusak');
  }
  console.log('slowdns auto-lock tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

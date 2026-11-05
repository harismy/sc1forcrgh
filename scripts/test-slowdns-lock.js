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
  const context = vm.createContext({
    console, crypto, require, process: { pid: 7 },
    SLOWDNS_AUTO_LOCK_ENABLED: true, SLOWDNS_ACTIVITY_FILE: activity, SLOWDNS_LOCK_SECONDS: 900,
    SSHWS_HARD_LIMIT_CONFIRM_CYCLES: 2, SSHWS_HARD_LIMIT_MIN_GAP_SECONDS: 90, SSHWS_HARD_LIMIT_MAX_GAP_SECONDS: 420,
    AUTO_LOCK_ENABLED: true, IPLIMIT_DEBUG: false, ZIVPN_AUTH_MODE: 'http', XRAY_IP_GROUP_MASK: 16,
    SSHWS_ACCOUNT_SESSION_HARD_LIMIT: 8, LOCK_SECONDS: 3600,
    fs: {
      readFileSync(file) { if (!files.has(file)) throw Error('ENOENT'); return files.get(file); },
      mkdirSync() {},
      writeFileSync(file, data) { if (failWrite) throw Error('read only'); files.set(file, data); },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); }
    },
    execFileSync(command, args) {
      assert.strictEqual(command, '/usr/local/sbin/sc-1forcr-slowdns');
      assert.strictEqual(args[0], 'sessions'); calls++; return raw;
    },
    async run(sql, params = []) {
      const s = String(sql).replace(/\s+/g, ' ');
      if (s.includes('DELETE FROM iplimit_violation_pending')) {
        for (const [key, row] of pending) {
          if (row.username !== params[0]) continue;
          if (s.includes("LIKE 'slowdns-%'")) {
            if (row.signal.startsWith('slowdns-') && row.signal !== params[1]) pending.delete(key);
          } else if (!s.includes('signal=?') || row.signal === params[1]) pending.delete(key);
        }
      } else if (s.includes('INSERT OR REPLACE INTO iplimit_violation_pending')) {
        const [username, signal, first_seen, last_seen, hits, detected] = params;
        pending.set(username + '|' + signal, { username, signal, first_seen, last_seen, hits, detected });
      } else if (s.includes('INSERT OR REPLACE INTO temp_ip_locks')) {
        if (failPrepare) throw Error('database write failed');
        locked = true; lockedUntil = params[1]; actions.push(['temporary-lock', ...params]);
      } else if (s.includes("UPDATE account_sshs SET status='LOCK_TMP'")) {
        actions.push(['status', ...params]);
      }
      return { changes: 1 };
    },
    async get(sql, params = []) {
      if (sql.startsWith('SELECT l.locked_until')) return { locked_until: lockedUntil, status: 'LOCK_TMP' };
      if (sql.includes('iplimit_violation_pending')) return pending.get(params[0] + '|' + params[1]);
      if (sql.includes('temp_ip_locks')) return locked ? { ok: 1 } : undefined;
      return undefined;
    },
    async all(sql) {
      if (sql.includes('FROM account_sshs WHERE')) return [{ username: 'alice', password: 'example', limitip: accountLimit }];
      return [];
    },
    parseSshAndUdpUsage: () => Object.fromEntries(['ipMap', 'sessionMap', 'recentAuthMap', 'procSessionMap', 'wsClientPortMap', 'sshWsIpMap', 'udphcSessionMap', 'udphcIpMap', 'zivpnSessionMap', 'zivpnIpMap'].map((k) => [k, new Map()])),
    readZivpnLiveMap: async () => ({ sessionMap: new Map(), ipMap: new Map() }),
    parseXrayRecentIpMap: () => new Map(), readXrayLiveSocketMap: () => new Map(),
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
  new vm.Script(policy + '\n' + lock + '\nglobalThis.api={readSlowdnsTunnelUsage,sampleSlowdnsTunnelLimit,lockIfExceeded};').runInContext(context);
  const snapshot = (rows, instance = '1008.1234567890') => {
    raw = 'SC_SLOWDNS_USERS_V1|' + instance + '\n' + rows.map(([cid, up, port, started = 500]) =>
      `alice|${cid.repeat(16)}|${up}|${port}|${BigInt(started) * 1000000000n}`).join('\n') + '\nEND\n';
  };
  return {
    api: context.api, context, files, pending, actions, histories, notifications, snapshot,
    raw(value) { raw = value; }, limit(n) { accountLimit = n; }, failWrite() { failWrite = true; }, failPrepare() { failPrepare = true; }, calls: () => calls
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
  console.log('slowdns auto-lock tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

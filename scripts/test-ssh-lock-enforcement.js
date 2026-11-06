'use strict';

// Regresi: Dropbear forwarding-only tetap root dan tidak memuat username di args.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const installer = fs.readFileSync(path.join(__dirname, 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
const checker = installer.split("cat > \"${APP_DIR}/iplimit-checker.js\" <<'EOF'\n")[1].split('\nEOF\n')[0];
const section = checker.slice(checker.indexOf('function readSshSessionSnapshot('), checker.indexOf('function ensureTunnelHoldShell('));
const ticks = checker.slice(checker.indexOf('function readProcStartTicks('), checker.indexOf('function sshQuotaUserFromProcessArgs('));
const main = checker.slice(checker.lastIndexOf('async function main()'));
assert(main.includes('await enforceTemporarySshLocks(now);'), 'checker must execute the lock reconciliation');
assert(main.indexOf('await unlockExpired(now)') < main.indexOf('await enforceTemporarySshLocks(now)'),
  'expired locks must be released before reconciliation');

function fixture() {
  const children = new Map(), mapping = [], actions = [], errors = [], passwords = new Set();
  let rows = [], ssFails = false, recyclePid = 0;
  const reads = new Map(), calls = { ps: 0, ss: 0 };
  function add(pid, user, port, options = {}) {
    children.set(pid, { owner: 'root', args: '/usr/local/sbin/dropbear-2019.78 -R -E -F -p 109 -p 143',
      port, localPort: 109, alive: true, started: '123456', ipv6: false, ...options });
    mapping.push(`${port}|${pid}|${user}`);
  }
  add(100, 'alice', 40000, { listener: true });
  add(101, 'alice', 40001);
  add(102, 'bob', 40002);
  children.set(201, { owner: 'root', args: 'sshd: root@pts/0', alive: true, started: '2010' });
  children.set(202, { owner: 'sc-1forcr-slowdns', args: '/usr/local/lib/sc-1forcr/dnstt-server -udp :5300', alive: true, started: '2020' });
  const context = vm.createContext({
    Map, Set, process: { pid: 9000, ppid: 9001 }, DROPBEAR_PORT: '109', DROPBEAR_ALT_PORT: '143',
    console: { error: (m) => errors.push(m) }, setTimeout: (fn) => fn(),
    fs: { readFileSync(file) {
      if (file === '/run/sc-1forcr/ssh-live.map') return mapping.join('\n');
      if (file === '/etc/shadow') return Array.from(passwords, (u) => u + ':!test:0:0:0:0:0:0:').join('\n');
      const m = String(file).match(/^\/proc\/(\d+)\/stat$/);
      if (!m) throw Error('unexpected file');
      const pid = Number(m[1]), child = children.get(pid);
      if (!child?.alive) throw Error('ENOENT');
      const count = (reads.get(pid) || 0) + 1; reads.set(pid, count);
      const fields = Array(20).fill('0'); fields[0] = 'S';
      fields[19] = pid === recyclePid && count > 1 ? '999999' : child.started;
      return `${pid} (dropbear) ${fields.join(' ')}`;
    } },
    execFileSync(command, args) {
      if (command === 'ps') {
        calls.ps++;
        return Array.from(children, ([pid, c]) => c.alive ? `${pid} ${c.owner} ${c.args}` : '').join('\n');
      }
      assert.strictEqual(command, 'ss'); assert.deepStrictEqual(Array.from(args), ['-Htanp']); calls.ss++;
      if (ssFails) throw Error('unavailable');
      return Array.from(children, ([pid, c]) => {
        if (!c.alive || !c.port) return '';
        const address = c.ipv6 ? '[::ffff:127.0.0.1]' : '127.0.0.1';
        const active = `ESTAB 0 0 ${address}:${c.localPort} ${address}:${c.port} users:(("dropbear",pid=${pid},fd=5))`;
        return c.listener ? `LISTEN 0 128 0.0.0.0:109 0.0.0.0:* users:(("dropbear",pid=${pid},fd=3))\n${active}` : active;
      }).join('\n');
    },
    safeExec(command, args) {
      actions.push([command, ...args]);
      if (command === 'kill') children.get(Number(args[1])).alive = false;
      if (command === 'passwd') passwords.add(args[1]);
      return true;
    },
    async all(sql, params) {
      assert(sql.includes("l.locked_until > ?") && sql.includes("='LOCK_TMP'"));
      return rows.filter((r) => r.until > params[0] && r.status === 'LOCK_TMP');
    }
  });
  new vm.Script(section + '\n' + ticks + '\nglobalThis.api={collectSshSessionPids,killSshSessionsForUser,verifySshSessionsClosed,enforceTemporarySshLocks};').runInContext(context);
  return { api: context.api, children, mapping, actions, errors, passwords, calls, add,
    rows(value) { rows = value; }, failSockets() { ssFails = true; }, recycle(pid) { recyclePid = pid; } };
}

(async () => {
  let f = fixture();
  await f.api.enforceTemporarySshLocks(1000);
  assert.strictEqual(f.calls.ps + f.calls.ss, 0, 'no temporary locks means no extra process/socket snapshot');
  assert.deepStrictEqual(Array.from(f.api.collectSshSessionPids('alice')), [101]);
  assert.deepStrictEqual(Array.from(f.api.collectSshSessionPids('root')), []);
  const result = f.api.killSshSessionsForUser('alice');
  assert.strictEqual(result.killed, 1);
  assert.strictEqual(await f.api.verifySshSessionsClosed('alice', 'test'), true);
  for (const pid of [100, 102, 201, 202]) assert(f.children.get(pid).alive, `unrelated PID ${pid} must survive`);

  f = fixture();
  for (let i = 0; i < 5; i++) f.add(110 + i, 'alice', 40110 + i);
  assert.strictEqual(f.api.killSshSessionsForUser('alice').killed, 6, 'all six root-owned tunnels must be disconnected');
  for (const pid of [100, 102, 201, 202]) assert(f.children.get(pid).alive);

  f = fixture();
  f.children.set(301, { owner: 'root', args: 'sshd-session: alice@notty', alive: true, started: '3010' });
  f.children.set(302, { owner: 'alice', args: '/usr/local/sbin/sc-1forcr-tunnel-shell', alive: true, started: '3020' });
  f.children.set(303, { owner: 'root', args: 'sshd: alice2@notty', alive: true, started: '3030' });
  assert.deepStrictEqual(Array.from(f.api.collectSshSessionPids('alice')), [101, 301, 302]);
  f.api.killSshSessionsForUser('alice');
  assert(f.children.get(303).alive && f.children.get(201).alive, 'similar usernames and root admin must survive');

  // PID/port harus sama; state lama, proses non-Dropbear, dan listener ditolak.
  f = fixture();
  f.add(103, 'alice', 40003); f.children.get(103).port = 49999;
  f.mapping.push('40004|999|alice');
  f.add(104, 'alice', 40004, { args: 'nginx: worker process' });
  f.add(105, 'alice', 40005); f.mapping.push('40005|105|bob');
  f.add(106, 'alice', 40006, { ipv6: true, localPort: 143 });
  assert.deepStrictEqual(Array.from(f.api.collectSshSessionPids('alice')), [101, 106]);
  f.api.killSshSessionsForUser('alice');
  for (const pid of [100, 102, 103, 104, 105, 201, 202]) assert(f.children.get(pid).alive);

  f = fixture(); f.recycle(101);
  assert.strictEqual(f.api.killSshSessionsForUser('alice').killed, 0, 'PID reused before kill must survive');
  assert(f.children.get(101).alive);
  f = fixture(); f.failSockets();
  assert.deepStrictEqual(Array.from(f.api.collectSshSessionPids('alice')), [], 'no socket proof means no root Dropbear kill');
  assert.strictEqual(await f.api.verifySshSessionsClosed('alice', 'test'), false, 'unavailable snapshot must not report successful disconnection');

  // Lock yang sudah tercatat tetap ditegakkan, termasuk koneksi yang lolos kemudian.
  // Semua akun memakai satu snapshot per sapuan; expiry/status tidak pernah diubah.
  f = fixture();
  f.rows([{ username: 'alice', until: 1900, status: 'LOCK_TMP' },
    { username: 'bob', until: 900, status: 'LOCK_TMP' },
    { username: 'root', until: 1900, status: 'LOCK_TMP' }]);
  await f.api.enforceTemporarySshLocks(1000);
  assert(f.passwords.has('alice'));
  assert(!f.passwords.has('root') && !f.passwords.has('bob'));
  assert(!f.children.get(101).alive && f.children.get(102).alive);
  assert.strictEqual(f.calls.ps, 2); assert.strictEqual(f.calls.ss, 2, 'one batch snapshot and one verification');
  f.add(110, 'alice', 40110);
  const before = f.actions.filter((a) => a[0] === 'passwd').length;
  await f.api.enforceTemporarySshLocks(1180);
  assert(!f.children.get(110).alive, 'locked account must not escape the next check');
  assert.strictEqual(f.actions.filter((a) => a[0] === 'passwd').length, before, 'already locked shadow needs no passwd fork');
  f.rows([{ username: 'alice', until: 1900, status: 'AKTIF' }]);
  f.add(111, 'alice', 40111);
  await f.api.enforceTemporarySshLocks(1360);
  assert(f.children.get(111).alive, 'manual unlock must remain effective');
  f = fixture();
  f.rows([{ username: 'alice', until: 1900, status: 'LOCK_TMP' }, { username: 'bob', until: 1900, status: 'LOCK_TMP' }]);
  await f.api.enforceTemporarySshLocks(1000);
  assert(!f.children.get(101).alive && !f.children.get(102).alive);
  assert.strictEqual(f.calls.ps, 2); assert.strictEqual(f.calls.ss, 2, 'multiple locked users must share snapshots');
  console.log('SSH/SlowDNS lock enforcement tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

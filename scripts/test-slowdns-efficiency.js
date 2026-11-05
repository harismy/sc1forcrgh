'use strict';

// Efisiensi tanpa mengubah urutan firewall atau kesegaran keputusan lock.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'scripts/setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
const extract = (start, end) => {
  const a = src.indexOf(start), b = src.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, start);
  return src.slice(a + start.length, b);
};
const firewall = extract("cat > /usr/local/sbin/sc-1forcr-udp-firewall <<'UDP_FIREWALL_EOF'\n", '\nUDP_FIREWALL_EOF');
const tracker = extract("cat > /usr/local/sbin/sc-1forcr-ssh-live <<'EOF'\n", '\nEOF');
const bash = [process.env.BASH, process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '', 'bash']
  .filter(Boolean).find((p) => spawnSync(p, ['--version'], { encoding: 'utf8' }).status === 0);
assert(bash, 'bash tersedia');
const B = (p) => process.platform === 'win32'
  ? spawnSync(bash, ['-c', 'cygpath -u "$1"', '_', p], { encoding: 'utf8' }).stdout.trim() : p;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slowdns-efficiency-'));
const F = (p) => path.join(tmp, p);
const write = (p, text) => fs.writeFileSync(F(p), text);
const read = (p) => fs.existsSync(F(p)) ? fs.readFileSync(F(p), 'utf8') : '';
fs.mkdirSync(F('bin'));
const exe = (name, body) => fs.writeFileSync(F('bin/' + name), '#!/usr/bin/env bash\n' + body + '\n', { mode: 0o755 });
const env = { ...process.env, FAKE_DIR: B(tmp), FAKE_BIN: B(F('bin')), UDP_FIREWALL_STATE_DIR: B(tmp), SC_ENV_FILE: B(F('env')) };
const run = (file, args = [], input = '') => {
  const r = spawnSync(bash, ['-c', 'export PATH="$FAKE_BIN:/usr/bin:/bin"; exec bash "$@"', '_', B(F(file)), ...args], {
    encoding: 'utf8', env, input, timeout: 30000
  });
  assert(!r.error && r.status === 0, r.stdout + r.stderr + String(r.error || ''));
  return r.stdout;
};
try {
  write('firewall.sh', firewall);
  write('tracker.sh', tracker);
  for (const file of ['firewall.sh', 'tracker.sh']) {
    assert.strictEqual(spawnSync(bash, ['-n', B(F(file))], { encoding: 'utf8' }).status, 0, file);
  }
  const fakeIptables = `family="$(basename "$0")"
table="$FAKE_DIR/$family"
[[ "$1" == -w ]] && shift 2
op="$1"; shift
[[ "$1" == INPUT ]] || exit 99
shift
case "$op" in
  -S) [[ -f "$FAKE_DIR/fail-read" ]] && exit 1; cat "$table" ;;
  -D)
    [[ -f "$FAKE_DIR/fail-delete" ]] && exit 1
    line="-A INPUT $*"
    grep -qxF -- "$line" "$table" || exit 1
    awk -v rule="$line" '!removed && $0==rule {removed=1; next} {print}' "$table" > "$table.tmp"
    mv "$table.tmp" "$table"
    printf '%s|%s\\n' "$family" "$line" >> "$FAKE_DIR/writes"
    ;;
  *) exit 99 ;;
esac`;
  exe('iptables', fakeIptables);
  exe('ip6tables', fakeIptables);
  exe('flock', '[[ ! -f "$FAKE_DIR/fail-lock" ]]');
  exe('netfilter-persistent', 'printf "%s\\n" "$*" >> "$FAKE_DIR/persist"');
  const accept = (p) => `-A INPUT -p udp -m udp --dport ${p} -j ACCEPT`;
  const gate = '-A INPUT -j SC1FORCR_SVC_IN';
  const slowdns = '-A INPUT -p udp -m udp --dport 5300 -m comment --comment sc-slowdns -j ACCEPT';
  const seed = (rows, v6 = []) => {
    write('iptables', ['-P INPUT ACCEPT', ...rows, ''].join('\n'));
    write('ip6tables', ['-P INPUT ACCEPT', ...v6, ''].join('\n'));
    write('writes', ''); write('persist', '');
  };
  seed([gate, ...Array(7).fill(accept(5667)), slowdns, '-A INPUT -j DROP']);
  run('firewall.sh', ['cleanup', '5667']);
  assert.strictEqual(read('iptables'), ['-P INPUT ACCEPT', gate, accept(5667), slowdns, '-A INPUT -j DROP', ''].join('\n'));
  assert.strictEqual(read('writes').trim().split('\n').length, 6, 'enam salinan ekstra dibuang');
  assert.strictEqual(read('persist'), 'save\n', 'simpan hanya ketika ada perubahan');
  write('writes', ''); write('persist', '');
  run('firewall.sh', ['cleanup', '5667']);
  assert.strictEqual(read('writes') + read('persist'), '', 'siklus bersih tanpa mutasi');
  seed([accept(7000), accept(7000)], [accept(7001), accept(7001)]);
  run('firewall.sh', ['cleanup', '0.0.0.0:7000', '[::]:7001']);
  assert.strictEqual(read('iptables'), '-P INPUT ACCEPT\n' + accept(7000) + '\n');
  assert.strictEqual(read('ip6tables'), '-P INPUT ACCEPT\n' + accept(7001) + '\n');

  const separated = [accept(5667), gate, accept(5667), accept(5667), slowdns];
  seed(separated);
  const before = read('iptables');
  run('firewall.sh', ['cleanup', '5667']);
  assert.strictEqual(read('iptables'), before, 'duplikat di balik gate tidak boleh memindahkan ACCEPT pertama');
  assert.strictEqual(read('writes'), '');

  const otherRules = [accept(7000), accept(7000), '-A INPUT -p tcp -m tcp --dport 5667 -j ACCEPT',
    '-A INPUT -s 10.0.0.1/32 -p udp -m udp --dport 5667 -j ACCEPT',
    '-A INPUT -p udp -m udp --dport 5667 -m comment --comment owner -j ACCEPT'];
  seed([...otherRules, accept(5667), accept(5667)], [gate, accept(5667), accept(5667)]);
  run('firewall.sh', ['cleanup', '5667']);
  assert.strictEqual(read('iptables'), ['-P INPUT ACCEPT', ...otherRules, accept(5667), ''].join('\n'));
  assert.strictEqual(read('ip6tables'), ['-P INPUT ACCEPT', gate, accept(5667), ''].join('\n'));

  seed([accept(5667), accept(5667)]);
  run('firewall.sh', ['cleanup', '0', '65536', 'abc']);
  assert.strictEqual(read('writes') + read('persist'), '', 'input salah tidak menyentuh firewall');
  for (const failure of ['fail-read', 'fail-delete', 'fail-lock']) {
    write(failure, '1');
    run('firewall.sh', ['cleanup', '5667']);
    assert.strictEqual(read('writes') + read('persist'), '', 'kegagalan harus berhenti tanpa mutasi');
    fs.unlinkSync(F(failure));
  }
  seed(Array(40).fill(accept(5667)));
  run('firewall.sh', ['cleanup', '5667']);
  assert.strictEqual(read('writes').trim().split('\n').length, 32, 'kerja per siklus dibatasi');
  run('firewall.sh', ['cleanup', '5667']);
  assert.strictEqual(read('iptables'), '-P INPUT ACCEPT\n' + accept(5667) + '\n');

  // Tracker sungguhan memakai stdin snapshot segar. ss tiruan sengaja gagal;
  // auth lama dengan PID lain tetap ditolak, lalu socket kosong menghapus akun.
  exe('ss', 'echo called >> "$FAKE_DIR/ss-calls"; exit 99');
  exe('journalctl', `cat "$FAKE_DIR/journal"`);
  env.SSH_LIVE_STATE_DIR = B(F('tracker-state'));
  env.DB_PATH = B(F('missing.db'));
  env.DROPBEAR_PORT = '109';
  env.DROPBEAR_ALT_PORT = '143';
  fs.mkdirSync(F('tracker-state'));
  write('tracker-state/ssh-live.schema', '2\n');
  write('tracker-state/ssh-live.map', '40001|999|stale\n');
  write('journal', '1793903268 host dropbear[301]: Password auth succeeded for \'alice\' from 127.0.0.1:40001\n');
  const sockets = '0 0 127.0.0.1:109 127.0.0.1:40001 users:(("dropbear",pid=301,fd=4))\n';
  run('tracker.sh', ['refresh-snapshot'], sockets);
  assert.strictEqual(read('tracker-state/ssh-live.map'), '40001|301|alice\n');
  assert.strictEqual(read('ss-calls'), '', 'tracker tidak mengambil ss kedua');
  write('journal', '');
  run('tracker.sh', ['refresh-snapshot'], sockets.replace('pid=301', 'pid=302'));
  assert.strictEqual(read('tracker-state/ssh-live.map'), '', 'port dipakai ulang tidak meminjam username lama');
  run('tracker.sh', ['refresh-snapshot'], '');
  assert.strictEqual(read('tracker-state/ssh-live.map'), '', 'snapshot kosong tidak menampilkan histori');

  assert(src.includes('ExecStartPost=-/usr/local/sbin/sc-1forcr-udp-firewall cleanup'), 'cleanup setelah start backend');
  const watchdog = extract("<<'POSTBOOT_HEALTH_EOF'\n", '\nPOSTBOOT_HEALTH_EOF');
  assert(watchdog.indexOf('sc-1forcr-udp-firewall cleanup') < watchdog.indexOf('sc-1forcr-service-gate apply'), 'gate tetap terakhir');
  assert(src.includes('setup_udp_firewall_guard || return 1\n'), 'helper dipasang di jalur backend install/update');
  console.log('slowdns efficiency passed (firewall ordering/idempotency, IPv4/IPv6, fresh shared socket snapshot)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

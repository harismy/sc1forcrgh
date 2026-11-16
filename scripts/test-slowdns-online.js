'use strict';

// Hitung akun hanya dari socket DNSTT aktif + port/PID autentikasi Dropbear.
// SSHWS, journal lama, dan koneksi sebelum login tidak boleh menambah akun online.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'scripts/setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
const start = "cat > /usr/local/sbin/sc-1forcr-slowdns <<'SLOWDNS_EOF'\n";
const begin = installer.indexOf(start);
const end = installer.indexOf('\nSLOWDNS_EOF\n', begin);
assert(begin >= 0 && end > begin, 'helper SlowDNS tersedia');
const helper = installer.slice(begin + start.length, end);
const bash = [process.env.BASH, process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '', 'bash']
  .filter(Boolean).find((candidate) => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0);
assert(bash, 'bash tersedia');
const B = (file) => process.platform === 'win32'
  ? spawnSync(bash, ['-c', 'cygpath -u "$1"', '_', file], { encoding: 'utf8' }).stdout.trim() : file;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slowdns-online-'));
const F = (name) => path.join(tmp, name);
const bin = F('bin');
fs.mkdirSync(bin);
fs.writeFileSync(F('helper'), helper + '\n');
const write = (name, body) => fs.writeFileSync(F(name), body);
const read = (name) => fs.existsSync(F(name)) ? fs.readFileSync(F(name), 'utf8') : '';
const exe = (name, body) => {
  fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env bash\n' + body + '\n');
  fs.chmodSync(path.join(bin, name), 0o755);
};
exe('systemctl', `printf '%s\\n' "$*" >> "$FAKE_DIR/systemctl.log"
case "$1" in
  show) [[ -f "$FAKE_DIR/fail-service" ]] && exit 1; cat "$FAKE_DIR/mainpid" ;;
  is-active) [[ "$(cat "$FAKE_DIR/mainpid")" != 0 ]] ;;
  *) echo 'unexpected systemctl mutation' >&2; exit 99 ;;
esac`);
exe('ss', `printf '%s\\n' "$*" >> "$FAKE_DIR/ss.log"
[[ -f "$FAKE_DIR/fail-ss" ]] && exit 1
cat "$FAKE_DIR/sockets"`);
exe('ssh-live', `printf '%s\\n' "$*" >> "$FAKE_DIR/tracker.log"
cat > "$FAKE_DIR/tracker-sockets"
[[ -f "$FAKE_DIR/fail-tracker" ]] && exit 1
exit 0`);
const env = {
  ...process.env,
  FAKE_DIR: B(tmp), FAKE_BIN: B(bin), SC_ENV_FILE: B(F('env')),
  SSH_LIVE_STATE_FILE: B(F('auth.map')),
  SLOWDNS_SSH_LIVE_BIN: B(path.join(bin, 'ssh-live')),
  SLOWDNS_STATE_FILE: B(F('state')),
  SLOWDNS_LOCK_FILE: B(F('lock')),
  SLOWDNS_KEY_DIR: B(F('keys')),
  SLOWDNS_BIN_PATH: B(F('dnstt-server'))
};
const helperPath = B(F('helper'));
function run(command = 'online', expectedStatus = 0, ...args) {
  for (const name of ['systemctl.log', 'ss.log', 'tracker.log']) write(name, '');
  const r = spawnSync(bash, ['-c', 'export PATH="$FAKE_BIN:$PATH"; exec bash "$@"', '_', helperPath, command, ...args], {
    env, encoding: 'utf8', timeout: 30000
  });
  assert(!r.error, String(r.error));
  assert.strictEqual(r.status, expectedStatus, r.stdout + r.stderr);
  assert(!/unexpected/.test(r.stderr), r.stderr);
  return r.stdout;
}
function config(enabled = 1, port = 109) {
  write('env', `SLOWDNS_ENABLE=${enabled}\nDROPBEAR_PORT=${port}\nSLOWDNS_MEMORY_MAX=128M\n`);
}
function pair(port, serverPid, options = {}) {
  const { owner = 1008, addr = '127.0.0.1', target = 109, state = '' } = options;
  return [
    `${state}0 0 ${addr}:${port} ${addr}:${target} users:(("dnstt-server",pid=${owner},fd=9))`,
    `${state}0 0 ${addr}:${target} ${addr}:${port} users:(("dropbear-sc",pid=${serverPid},fd=4))`
  ].join('\n');
}
try {
  config();
  write('mainpid', '1008\n');
  const auth = '40001|301|alice\n40002|302|alice\n40003|303|bob\n40005|999|stale\n40006|306|disconnected\n41001|401|sshws\n';
  const mixed = [
    pair(40001, 301),
    pair(40002, 302, { addr: '[::ffff:127.0.0.1]', state: 'ESTAB ' }),
    pair(40003, 303, { addr: '[::1]' }),
    pair(40004, 304), // belum ada autentikasi
    pair(40005, 305), // port dipakai ulang oleh PID baru: map lama ditolak
    pair(41001, 401, { owner: 9000 }), // SSHWS ke port Dropbear yang sama
    pair(41002, 402, { owner: 10080 }), // prefix PID bukan PID DNSTT
    pair(41003, 403, { target: 143 }), // tujuan bukan port upstream aktif
    '0 0 127.0.0.1:42000 203.0.113.5:109 users:(("dnstt-server",pid=1008,fd=10))',
    '0 0 127.0.0.1:109 198.51.100.8:40001 users:(("dropbear-sc",pid=500,fd=4))',
    pair(40001, 301) // endpoint dan baris ganda tidak menggandakan hitungan
  ].join('\n') + '\n';
  write('auth.map', auth);
  write('sockets', mixed);
  let out = run();
  assert(/Akun online\s*: 2 akun unik terverifikasi/.test(out), out);
  assert(/Koneksi SSH\s*: 5 melalui SlowDNS/.test(out), out);
  assert(/Belum dikenali\s*: 2 koneksi/.test(out), out);
  assert(/^alice\s+2\s+-$/m.test(out) && /^bob\s+1\s+-$/m.test(out), out);
  assert(!/sshws|stale|disconnected/.test(out), out);
  assert.strictEqual(read('tracker.log').trim(), 'refresh-snapshot');
  assert.strictEqual(read('ss.log').trim(), '-Htnp state established', 'satu snapshot ss per siklus');
  assert.strictEqual(read('tracker-sockets'), mixed, 'tracker memakai snapshot yang sama, tanpa cache');
  assert.strictEqual(read('systemctl.log').trim(), 'show sc-1forcr-slowdns.service -p MainPID --value');
  out = run('status');
  assert(/Akun online\s*: 2 akun unik/.test(out) && /Koneksi SSH\s*: 5/.test(out), out);

  // Port sumber yang sama pada IPv4/IPv6 tidak boleh menghubungkan akun SSHWS
  // ke socket SlowDNS. Kedua sisi harus merupakan pasangan endpoint yang sama.
  write('sockets', pair(40001, 301) + '\n' + pair(40001, 401, { addr: '[::1]', owner: 9000 }) + '\n');
  out = run();
  assert(/^alice\s+1\s+-$/m.test(out), out);
  write('auth.map', '40001|401|sshws\n');
  out = run();
  assert(/0 akun/.test(out) && /Belum dikenali\s*: 1/.test(out) && !/^sshws/m.test(out), out);
  write('auth.map', auth);

  // Socket ditutup: map lama tidak boleh menambah akun ataupun koneksi.
  write('sockets', '');
  out = run();
  assert(/Akun online\s*: 0 akun/.test(out) && /Koneksi SSH\s*: 0/.test(out), out);
  assert(!/^alice|^bob/m.test(out), out);

  // Map hilang atau PID server tidak terlihat: tampilkan koneksi yang belum terpetakan.
  write('sockets', mixed);
  fs.rmSync(F('auth.map'));
  out = run();
  assert(/Akun online\s*: 0 akun/.test(out) && /Belum dikenali\s*: 5/.test(out), out);
  write('auth.map', auth);
  write('sockets', '0 0 127.0.0.1:40001 127.0.0.1:109 users:(("dnstt-server",pid=1008,fd=9))\n');
  out = run();
  assert(/Akun online\s*: 0 akun/.test(out) && /Belum dikenali\s*: 1/.test(out), out);

  // Semua pemilik socket tersembunyi: beri peringatan bahwa angka belum lengkap.
  write('sockets', mixed.replace(/ users:.*$/gm, ''));
  out = run();
  assert(/Sebagian pemilik koneksi tidak terbaca/.test(out), out);

  // Tracker gagal refresh: map yang masih cocok dengan PID/socket tetap dapat digunakan.
  write('sockets', mixed);
  write('fail-tracker', '');
  out = run();
  assert(/Akun online\s*: 2 akun/.test(out), out);
  fs.rmSync(F('fail-tracker'));

  // Kegagalan ss/systemctl adalah data tidak tersedia, bukan nol pengguna.
  write('fail-ss', '');
  out = run();
  assert(/BELUM TERSEDIA/.test(out) && !/0 akun/.test(out), out);
  fs.rmSync(F('fail-ss'));
  write('fail-service', '');
  out = run();
  assert(/BELUM TERSEDIA/.test(out), out);
  assert.strictEqual(read('ss.log'), '');
  fs.rmSync(F('fail-service'));

  // Service berhenti dan mode OFF tidak menjalankan tracker atau mengambil socket.
  write('mainpid', '0\n');
  out = run();
  assert(/Service tidak berjalan/.test(out) && /0 akun/.test(out), out);
  assert.strictEqual(read('ss.log') + read('tracker.log'), '');
  config(0);
  out = run();
  assert(/SlowDNS nonaktif/.test(out), out);
  assert.strictEqual(read('systemctl.log') + read('ss.log') + read('tracker.log'), '');

  // Port upstream non-default dan output ss yang diawali spasi tetap didukung.
  config(1, 2223);
  write('mainpid', '1008\n');
  write('sockets', pair(40001, 301, { target: 2223, state: '  ESTAB ' }) + '\n');
  out = run();
  assert(/1 akun/.test(out) && /Koneksi SSH\s*: 1/.test(out), out);
  assert.strictEqual(read('ss.log').trim(), '-Htnp state established');

  // Dua stream SSH pada ClientID yang sama adalah satu tunnel, lalu hanya
  // koneksi dengan username/PID terverifikasi yang masuk data checker.
  fs.writeFileSync(F('dnstt-server'), '#!/usr/bin/env bash\n[[ "$1" == -sc-online ]] || exit 1\ncat "$FAKE_DIR/native"\n');
  fs.chmodSync(F('dnstt-server'), 0o755);
  config(); write('sockets', mixed); write('auth.map', auth);
  const native = 'SC_SLOWDNS_SESSIONS_V1|1008|1234567890\n' +
    '40001|aaaaaaaaaaaaaaaa|100|1000000000\n40002|aaaaaaaaaaaaaaaa|200|1000000000\n' +
    '40003|bbbbbbbbbbbbbbbb|300|1000000000\n40004|cccccccccccccccc|400|1000000000\n' +
    '40005|dddddddddddddddd|500|1000000000\nEND\n';
  write('native', native);
  out = run();
  assert(/Tunnel aktif\s*: 2 identitas/.test(out), out);
  assert(/^alice\s+2\s+1$/m.test(out) && /^bob\s+1\s+1$/m.test(out), out);
  out = run('sessions');
  assert(out.startsWith('SC_SLOWDNS_USERS_V1|1008.1234567890\n'), out);
  assert.strictEqual(out.split('\n').filter((l) => /^alice\|/.test(l)).length, 2, out);
  assert(!/stale|sshws|cccccccccccccccc|dddddddddddddddd/.test(out), out);
  assert(out.endsWith('END\n'), out);
  write('native', native.replace('bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa'));
  out = run();
  assert(/Tunnel aktif\s*: 1 identitas/.test(out), 'satu ClientID dengan dua akun tidak menggandakan total tunnel: ' + out);
  write('native', native.replace('|1008|', '|10080|'));
  run('sessions', 1);
  write('native', native.replace('END\n', ''));
  run('sessions', 1);
  // Port yang didaur ulang setelah snapshot ss tidak meminjam username lama.
  const future = String((BigInt(Date.now()) + 100000n) * 1000000n);
  write('native', 'SC_SLOWDNS_SESSIONS_V1|1008|1234567890\n40001|eeeeeeeeeeeeeeee|100|' + future + '\nEND\n');
  out = run('sessions');
  assert(!out.includes('alice|'), out);
  // sessions 2 (kuota SSH, V.1FSC.130). Binary lama (monitor V1): header
  // versi 1 dan kolom down "-". Binary sc-fast10 (monitor V2): byte download
  // ikut, dan stream yang sudah putus keluar sebagai baris E tanpa username.
  write('native', native);
  out = run('sessions', 0, '2');
  assert(out.startsWith('SC_SLOWDNS_USERS_V2|1008.1234567890|1\n'), out);
  assert(/^alice\|aaaaaaaaaaaaaaaa\|100\|40001\|1000000000\|-$/m.test(out) && !/^E\|/m.test(out), out);
  const nativeV2 = 'SC_SLOWDNS_SESSIONS_V2|1008|1234567890\n' +
    '40001|aaaaaaaaaaaaaaaa|100|1000000000|7000\n40002|aaaaaaaaaaaaaaaa|200|1000000000|8000\n' +
    '40003|bbbbbbbbbbbbbbbb|300|1000000000|9000\n40004|cccccccccccccccc|400|1000000000|1\n' +
    'E|39999|ffffffffffffffff|50|1000000000|60|2000000000\nEND\n';
  write('native', nativeV2);
  out = run('sessions', 0, '2');
  assert(out.startsWith('SC_SLOWDNS_USERS_V2|1008.1234567890|2\n'), out);
  assert(/^alice\|aaaaaaaaaaaaaaaa\|100\|40001\|1000000000\|7000$/m.test(out) &&
    /^bob\|bbbbbbbbbbbbbbbb\|300\|40003\|1000000000\|9000$/m.test(out), out);
  assert(/^E\|ffffffffffffffff\|50\|39999\|1000000000\|60\|2000000000$/m.test(out), out);
  assert(!/cccccccccccccccc/.test(out) && out.endsWith('END\n'), 'koneksi tanpa username terverifikasi tidak ikut: ' + out);
  out = run('sessions');
  assert(out.startsWith('SC_SLOWDNS_USERS_V1|1008.1234567890\n') &&
    /^alice\|aaaaaaaaaaaaaaaa\|100\|40001\|1000000000$/m.test(out) && !/^E\|/m.test(out),
    'format V1 untuk limit tunnel tidak berubah walau monitor V2: ' + out);
  out = run();
  assert(/Tunnel aktif\s*: 2 identitas/.test(out), 'monitor V2 tetap dihitung untuk tunnel: ' + out);
  write('native', nativeV2.replace('|1000000000|9000\n', '|1000000000\n'));
  run('sessions', 1, '2');
  write('native', nativeV2.replace('E|39999|', 'E|x|'));
  run('sessions', 1, '2');

  // SlowDNS Xray (sc-fast12): stream dnstt -> inbound WS Xray dipetakan ke akun
  // lewat peta tracker xray-live (port sumber dnstt + PID Xray). Port yang lahir
  // setelah peta ditulis tidak dihitung sebagai tunnel; sessions 2 tidak berubah.
  exe('xray-live', 'printf "%s\\n" "$*" >> "$FAKE_DIR/xlive.log"; exit 0');
  env.SLOWDNS_XRAY_LIVE_BIN = B(path.join(bin, 'xray-live'));
  env.XRAY_LIVE_STATE_FILE = B(F('xray.map'));
  const xfuture = String((BigInt(Date.now()) + 600000n) * 1000000n);
  const xsockets = [
    pair(45001, 700, { target: 10002 }),
    pair(45002, 702, { target: 10002 }), // PID Xray di peta beda: tidak terverifikasi
    pair(45003, 700, { target: 10003 }),
    pair(45004, 700, { target: 10002 }), // port dipakai ulang setelah peta ditulis
    pair(45005, 700, { target: 10001, owner: 9000 }) // nginx/mux biasa, bukan dnstt
  ].join('\n');
  write('sockets', mixed + xsockets + '\n');
  write('xray.map', '45001|700|vless|carol|-\n45002|701|vless|mallory|-\n45003|700|trojan|dave|-\n45004|700|vless|erin|-\n45005|700|vmess|zed|-\n');
  write('native', nativeV2.replace('END\n',
    'X|45001|1111111111111111|500|1000000000|900\nX|45002|4444444444444444|5|1000000000|5\n' +
    `X|45003|2222222222222222|50|1000000000|60\nX|45004|3333333333333333|1|${xfuture}|1\nEND\n`));
  write('env', 'SLOWDNS_ENABLE=1\nDROPBEAR_PORT=109\nSLOWDNS_XRAY_ENABLE=1\nSLOWDNS_XRAY_NS_DOMAIN=nsx.contoh.net\n');
  write('xlive.log', '');
  out = run();
  assert(/Akun Xray\s*: 3 akun unik terverifikasi/.test(out), out);
  assert(/Koneksi Xray\s*: 4 melalui SlowDNS \(1 belum terpetakan\)/.test(out), out);
  assert(/Tunnel Xray\s*: 2 identitas/.test(out), out);
  assert(/^carol\s+vless\s+1\s+1$/m.test(out) && /^dave\s+trojan\s+1\s+1$/m.test(out) && /^erin\s+vless\s+1\s+0$/m.test(out), out);
  assert(!/mallory|zed/.test(out), out);
  assert(/Akun online\s*: 2 akun unik/.test(out), 'jalur SSH tetap dihitung sama: ' + out);
  assert.strictEqual(read('xlive.log').trim(), 'raw', 'tracker Xray disegarkan sekali');
  out = run('sessions', 0, '3');
  assert(out.startsWith('SC_SLOWDNS_USERS_V3|1008.1234567890|2\n'), out);
  assert(/^X\|vless\|carol\|1111111111111111\|500\|45001\|1000000000\|900$/m.test(out) &&
    /^X\|trojan\|dave\|2222222222222222\|50\|45003\|1000000000\|60$/m.test(out), out);
  assert(!/erin|mallory|4444444444444444|3333333333333333/.test(out), out);
  assert(/^alice\|aaaaaaaaaaaaaaaa\|100\|40001\|1000000000\|7000$/m.test(out) && out.endsWith('END\n'), out);
  out = run('sessions', 0, '2');
  assert(out.startsWith('SC_SLOWDNS_USERS_V2|') && !/^X\|/m.test(out), 'sessions 2 tidak berubah untuk pembaca lama: ' + out);
  // Jalur Xray mati: tracker tidak dijalankan, baris X dari monitor diabaikan.
  write('env', 'SLOWDNS_ENABLE=1\nDROPBEAR_PORT=109\n');
  write('xlive.log', '');
  out = run();
  assert(!/Akun Xray/.test(out) && /Tunnel aktif\s*: 2 identitas/.test(out), out);
  assert.strictEqual(read('xlive.log'), '', 'Xray mati: tracker Xray tidak dipanggil');
  config();
  write('sockets', mixed);
  write('native', native);
  out = run('set-lock', 0, '0');
  assert(/SLOWDNS_AUTO_LOCK_ENABLE=0/.test(read('env')), out);
  out = run();
  assert(/Auto-lock\s*: OFF/.test(out), out);
  run('set-lock', 0, '1');
  assert(/SLOWDNS_AUTO_LOCK_ENABLE=1/.test(read('env')));

  assert(installer.includes('7) ui_monitor show_slowdns_online ;;'), 'menu memakai monitor refresh/live yang sudah ada');
  // Layar SlowDNS berkelompok (V.1FSC.136): opsi 7 ada di kelompok MONITOR.
  assert(installer.includes('monitor=("6) Log SlowDNS" "7) Akun Online"'), 'opsi menu terlihat');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('slowdns online tests passed');

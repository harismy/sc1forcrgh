'use strict';

// Layar SEMUA AKUN ONLINE (menu MONITOR USER ONLINE [7]) dan collector yang
// dipakai bersama layar per layanan. Test memastikan:
// - semua layanan (SSH, UDP Custom, ZIVPN, VMESS, VLESS, TROJAN) masuk satu
//   tabel dengan status yang sama seperti layar per layanan,
// - akun Xray OFFLINE tidak ikut, RECENT tetap tampil,
// - akun SSH yang dipakai di SSH/UDP Custom/ZIVPN dihitung satu akun,
// - tracker Xray dipanggil sekali untuk tiga protokol (hemat CPU di VPS 1 GB),
// - tidak ada file temp yang tertinggal (layar ini di-refresh tiap 10 detik),
// - layar lama tetap tampil lewat collector yang sama.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

function resolveBash() {
  const candidates = [
    process.env.BASH,
    process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '',
    'bash'
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('bash not found');
}

const bash = resolveBash();
const toBashPath = (p) => (process.platform === 'win32'
  ? spawnSync(bash, ['-c', `cygpath -u '${p}'`], { encoding: 'utf8' }).stdout.trim()
  : p);

const menu = extract(installer, "cat > \"${menu_runtime_tmp}\" <<'MENU_SCRIPT_EOF'\n", '\nMENU_SCRIPT_EOF\n');
const monitors = extract(menu, 'collect_udphc_online_pairs() {', '\nshow_zivpn_online_realtime() {');
const allOnline = extract(menu, 'show_all_online() {', '\nmonitor_online_menu() {');
const onlineMenu = extract(menu, 'monitor_online_menu() {', '\n}\n');

// Menu: nomor panel, case, dan prompt sama; [7] membuka layar baru.
const panelNums = [...onlineMenu.matchAll(/^\s*"(\d+)\) [^"]+"/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
const caseNums = [...onlineMenu.matchAll(/^\s{6}(\d+)\) /gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
assert.deepStrictEqual(caseNums, panelNums, 'monitor menu case numbers must match the panel');
panelNums.forEach((n, i) => assert.strictEqual(n, i, `monitor menu numbering must be contiguous (missing ${i})`));
assert.strictEqual(Number((onlineMenu.match(/Pilih menu \[0-(\d+)\]/) || [])[1]), Math.max(...panelNums), 'monitor menu prompt range');
assert(/"7\) SEMUA AKUN ONLINE"/.test(onlineMenu), 'monitor menu must offer SEMUA AKUN ONLINE');
assert(/7\) UI_MONITOR_LIVE_SECONDS=10 ui_monitor show_all_online; continue ;;/.test(onlineMenu), '[7] must open the combined monitor');

// Layar lama memakai collector yang sama, dan trap RETURN-nya dipasang
// setelah collector (trap collector menimpa trap yang dipasang lebih dulu).
for (const [screen, collector] of [
  ['show_ssh_only_online() {', 'collect_ssh_online_rows "${rows}"'],
  ['show_xray_online_by_table() {', 'collect_xray_online_rows "${table}" "${label}" "${mode}" "${rows}" || rc=$?']
]) {
  const body = extract(menu, screen, '\n}\n');
  const collect = body.indexOf(collector);
  const trap = body.indexOf('trap \'rm -f "${rows:-}"\' RETURN');
  assert(collect >= 0 && trap > collect, `${screen} must install its RETURN trap after calling the collector`);
}
assert(monitors.includes('collect_udphc_online_pairs "${mode}" "${tmp_udp_pair}"'), 'SSH + UDP CUSTOM must use the shared UDP collector');
assert(monitors.includes('sqlite3 -header -column "${DB_PATH}" "$(zivpn_online_sql "${win}" "${handoff_grace}")"'), 'ZIVPN screen must use the shared query');
assert(allOnline.indexOf("trap 'rm -rf \"${work:-}\"' RETURN") > allOnline.lastIndexOf('collect_xray_online_rows'),
  'show_all_online must install its RETURN trap after every collector');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-online-monitor-'));
const bin = path.join(tmpDir, 'bin');
const scratch = path.join(tmpDir, 'scratch');
fs.mkdirSync(bin);
fs.mkdirSync(scratch);
const file = (name) => path.join(tmpDir, name);
const B = (p) => toBashPath(p);
const exe = (name, body) => {
  fs.writeFileSync(path.join(bin, name), body.replace(/\r\n/g, '\n'));
  fs.chmodSync(path.join(bin, name), 0o755);
};

// sqlite3 tiruan: jawaban tetap per query (SQL-nya sendiri tidak berubah dan
// diuji di layar per layanan). Dicocokkan dari potongan query.
exe('sqlite3', `#!/usr/bin/env bash
sql="\${*: -1}"
case "\${sql}" in
  *"FROM account_sshs;"*) cat '${B(file('ssh-status.txt'))}' ;;
  *"name='zivpn_live_sessions'"*) cat '${B(file('zivpn-table.txt'))}' ;;
  *"FROM zivpn_live_sessions"*) cat '${B(file('zivpn-rows.txt'))}' ;;
  *"FROM account_vmesses a"*) cat '${B(file('vmess-users.txt'))}' ;;
  *"FROM account_vlesses a"*) cat '${B(file('vless-users.txt'))}' ;;
  *"FROM account_trojans a"*) cat '${B(file('trojan-users.txt'))}' ;;
esac
exit 0
`);
exe('ss', '#!/usr/bin/env bash\nexit 0\n');
exe('ps', '#!/usr/bin/env bash\nexit 0\n');
// Log UDP Custom dibuat saat dipanggil supaya selalu di dalam TTL.
exe('journalctl', `#!/usr/bin/env bash
case "$*" in
  *"-u sc-1forcr-udpcustom"*)
    [[ -f '${B(file('udphc.off'))}' ]] && exit 0
    now="$(date +%s)"
    echo "$((now - 300)).000000 host udp[1]: Server up and running"
    echo "$((now - 60)).000000 host udp[1]: [src:192.0.2.10:5000] [user:carol] Client connected"
    echo "$((now - 50)).000000 host udp[1]: [src:192.0.2.11:5001] [user:carol] Client connected"
    echo "$((now - 40)).000000 host udp[1]: [src:192.0.2.12:5002] [user:dave] Client connected"
    echo "$((now - 30)).000000 host udp[1]: [src:192.0.2.12:5002] Client disconnected"
    echo "$((now - 20)).000000 host udp[1]: [src:192.0.2.13:5003] [user:erin] Client connected"
    ;;
esac
exit 0
`);
exe('ssh-live', `#!/usr/bin/env bash
[[ "$1" == "list" ]] && cat '${B(file('ssh-live.txt'))}'
exit 0
`);
exe('xray-live', `#!/usr/bin/env bash
echo "$1" >> '${B(file('xray-live.calls'))}'
case "$1" in
  capabilities) echo rows-v3 ;;
  rows-v3) cat '${B(file('xray-live.txt'))}' ;;
esac
exit 0
`);

function writeFixtures() {
  fs.writeFileSync(file('ssh-status.txt'), 'alice|AKTIF|1\nbob|LOCK_TMP|2\ncarol|AKTIF|1\ndave|AKTIF|0\nerin|AKTIF|1\nkim|AKTIF|1\n');
  fs.writeFileSync(file('ssh-live.txt'), 'alice(2)\nbob(1)\ncarol(1)\n');
  fs.writeFileSync(file('ssh-live.map'), '40001|x|alice\n40002|x|alice\n40003|x|bob\n');
  fs.writeFileSync(file('sshws-quota.tsv'), [
    ['a', '40001', 'b', 'c', 'd', '1', '203.0.113.5'].join('\t'),
    ['a', '40002', 'b', 'c', 'd', '1', '198.51.100.6'].join('\t'),
    ['a', '40003', 'b', 'c', 'd', '1', '203.0.113.7'].join('\t')
  ].join('\n') + '\n');
  fs.writeFileSync(file('zivpn-table.txt'), '1\n');
  fs.writeFileSync(file('zivpn-rows.txt'), 'kim|MULTI_LOGIN|1|2|2026-09-28 10:00:00|203.0.113.30, 203.0.113.31, 198.51.100.40\ncarol|AMAN|1|1|2026-09-28 10:00:05|203.0.113.40\n');
  fs.writeFileSync(file('vmess-users.txt'), 'alice|AKTIF|2|LEGACY\nfrank|AKTIF|1|DEVICE_SLOT\n');
  fs.writeFileSync(file('vless-users.txt'), 'gina|AKTIF|1|LEGACY\njane|LOCK_QUOTA|1|LEGACY\nlia|AKTIF|1|LEGACY\n');
  fs.writeFileSync(file('trojan-users.txt'), 'hank|AKTIF|1|LEGACY\n');
  fs.writeFileSync(file('xray-live.txt'), [
    'vmess|frank|2|1|1|198.51.100.7|SOURCE_IP_ACTIVE',
    'vmess|alice|1|1|1|198.51.100.9|SOURCE_IP_ACTIVE',
    'vless|gina|1|1|1|198.51.100.8|SOURCE_IP_ACTIVE',
    'vless|jane|1|1|1|198.51.100.10|SOURCE_IP_ACTIVE',
    'vless|lia|0|0|1|198.51.100.11|SOURCE_IP_RECENT',
    'trojan|hank|0|0|0|TIDAK_TERDETEKSI|PROXY_LOCAL'
  ].join('\n') + '\n');
  fs.writeFileSync(file('access.log'), '');
  try { fs.unlinkSync(file('xray-live.calls')); } catch (_) {}
  try { fs.unlinkSync(file('udphc.off')); } catch (_) {}
}

const redirect = (code) => code
  .split('/usr/local/sbin/sc-1forcr-ssh-live').join(B(path.join(bin, 'ssh-live')))
  .split('/usr/local/sbin/sc-1forcr-xray-live').join(B(path.join(bin, 'xray-live')))
  .split('/run/sc-1forcr/ssh-live.map').join(B(file('ssh-live.map')))
  .split('/var/lib/sc-1forcr/sshws-quota.tsv').join(B(file('sshws-quota.tsv')));

const scriptPath = file('run.sh');
fs.writeFileSync(scriptPath, `set -euo pipefail
export PATH='${B(bin)}':"$PATH"
export TMPDIR='${B(scratch)}'
draw_menu_header() { printf '[ %s ]\\n' "$1"; }
detect_udpcustom_service() { echo sc-1forcr-udpcustom; }
get_hc_auth_lookback_hours() { echo 2; }
DB_PATH='${B(file('fake.db'))}'
XRAY_ACCESS_LOG='${B(file('access.log'))}'
DROPBEAR_PORT=109; DROPBEAR_ALT_PORT=143
DROPBEAR_LOG_MAX_LINES=12000; DROPBEAR_RECENT_LOG_MAX_LINES=5000; UDPHC_LOG_LINES_HISTORY=1200
xray_recent_window_min=5; xray_active_window_sec=60; xray_monitor_recent_window_min=5; xray_monitor_active_window_sec=60; xray_min_hits_per_ip=2
ZIVPN_ACTIVE_WINDOW_SECONDS=90; ZIVPN_HANDOFF_GRACE_SECONDS=20
${redirect(monitors)}
${redirect(allOnline)}
"$@"
`);
fs.writeFileSync(file('fake.db'), '');

function run(...args) {
  const r = spawnSync(bash, [B(scriptPath), ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${args.join(' ')} failed:\n${r.stderr}`);
  assert.deepStrictEqual(fs.readdirSync(scratch), [], `${args.join(' ')} left temp files behind`);
  return r.stdout;
}
const tableRows = (out) => {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.startsWith('--------------------'));
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end).map((l) => l.trim().split(/\s+/).join(' '));
};

try {
  writeFixtures();
  const all = run('show_all_online');
  assert(all.startsWith('[ SEMUA USER LOGIN ]\n'), all);
  assert(all.includes('Sumber SSH  : REALTIME_STATEFUL_IP'), all);
  assert(all.includes('Sumber Xray : REALTIME_SOCKET'), all);
  assert(all.includes('USERNAME             LAYANAN  STATUS       LIMIT_IP  SESI    IP_AKTIF'), 'table header');
  assert.deepStrictEqual(tableRows(all), [
    'alice SSH MULTI_LOGIN 1 2 2',
    'bob SSH KENA_LOCK 2 1 1',
    'carol SSH ONLINE 1 1 0',
    'carol UDPHC ONLINE 1 2 2',
    'erin UDPHC ONLINE 1 1 1',
    'carol ZIVPN AMAN 1 - 1',
    'kim ZIVPN MULTI_LOGIN 1 - 2',
    'alice VMESS ONLINE 2 1 1',
    'frank VMESS ONLINE 1 2 1',
    'gina VLESS ONLINE 1 1 1',
    'jane VLESS KENA_LOCK 1 1 1',
    'lia VLESS RECENT 1 0 0'
  ], 'rows must list every online account per service; OFFLINE Xray (hank) and disconnected UDP (dave) stay out');
  // carol di SSH, UDP Custom, dan ZIVPN = satu akun SSH; alice SSH dan alice VMESS = dua akun.
  assert(all.includes('Total Akun Online : 10\n'), all);
  for (const [svc, n] of [['SSH', 3], ['UDP Custom', 2], ['ZIVPN', 2], ['VMESS', 2], ['VLESS', 3], ['TROJAN', 0]]) {
    assert(new RegExp(`^${svc} +: ${n}$`, 'm').test(all), `${svc} total must be ${n}:\n${all}`);
  }
  assert(all.includes('Catatan: akun SSH yang dipakai di SSH, UDP Custom, dan ZIVPN dihitung satu akun.'), 'notes');
  assert.deepStrictEqual(fs.readFileSync(file('xray-live.calls'), 'utf8').trim().split('\n'), ['capabilities', 'rows-v3'],
    'Xray tracker must be queried once for all three protocols');

  // Layar per layanan tetap tampil dari collector yang sama.
  const ssh = run('show_ssh_only_online');
  assert(ssh.includes('[ SSH USER LOGIN (REALTIME_STATEFUL_IP) ]') && /alice +MULTI_LOGIN +1 +2 +2/.test(ssh) && ssh.includes('Total User SSH : 3'), ssh);
  const vless = run('show_xray_online_by_table', 'account_vlesses', 'VLESS', 'realtime');
  assert(vless.includes('[ VLESS USER LOGIN (REALTIME_SOCKET) ]') && /lia +RECENT/.test(vless) && vless.includes('Total User : 3'), vless);
  const trojan = run('show_xray_online_by_table', 'account_trojans', 'TROJAN', 'realtime');
  assert(/hank +OFFLINE/.test(trojan), 'the per-protocol screen keeps showing OFFLINE rows');
  const combined = run('show_combined_online', 'realtime');
  assert(/carol +ONLINE +1 +2 +3/.test(combined) && /erin +ONLINE +0 +1 +1/.test(combined) && !/dave/.test(combined), combined);
  const zivpnSql = run('zivpn_online_sql', '90', '20');
  assert(zivpnSql.includes('FROM zivpn_live_sessions') && zivpnSql.includes('- 90)') && zivpnSql.includes('<= 20'), 'ZIVPN query must use the window and grace values');

  // Tracker Xray tidak terpasang: layanan lain tetap tampil, Xray dari log saja.
  fs.renameSync(path.join(bin, 'xray-live'), path.join(bin, 'xray-live.off'));
  const noTracker = run('show_all_online');
  assert(noTracker.includes('Sumber Xray : LOG_WINDOW_FALLBACK'), noTracker);
  assert(!/ (VMESS|VLESS|TROJAN) /.test(tableRows(noTracker).join('\n')), 'without tracker and log no Xray rows');
  assert(noTracker.includes('Total Akun Online : 5\n'), noTracker);
  fs.renameSync(path.join(bin, 'xray-live.off'), path.join(bin, 'xray-live'));

  // Tidak ada yang online sama sekali.
  for (const name of ['ssh-live.txt', 'zivpn-rows.txt', 'xray-live.txt']) fs.writeFileSync(file(name), '');
  fs.writeFileSync(file('udphc.off'), '');
  const empty = run('show_all_online');
  assert(empty.includes('Tidak ada akun yang sedang online.') && empty.includes('Total Akun Online : 0'), empty);

  // Tabel akun Xray kosong dan tabel ZIVPN belum ada: tetap jalan.
  writeFixtures();
  fs.writeFileSync(file('trojan-users.txt'), '');
  fs.writeFileSync(file('zivpn-table.txt'), '0\n');
  const partial = run('show_all_online');
  assert(!/ ZIVPN /.test(tableRows(partial).join('\n')) && /^TROJAN +: 0$/m.test(partial) && /^ZIVPN +: 0$/m.test(partial), partial);

  console.log('online monitor tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

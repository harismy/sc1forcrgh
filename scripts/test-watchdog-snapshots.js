'use strict';

// Regresi dua script berkala yang membaca `ss`:
// - sc-1forcr-udpgw-drain: satu snapshot koneksi per siklus, diambil hanya
//   kalau ada alias aktif. `ss` gagal tidak boleh dibaca sebagai 0 koneksi
//   (dulu alias yang masih dipakai ikut di-stop).
// - sc-1forcr-postboot-health: satu snapshot listener per percobaan, dipakai
//   semua port unit itu, dan tidak dipakai ulang setelah sleep/restart.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

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

function heredoc(name, delimiter) {
  const marker = `  cat > /usr/local/sbin/${name} <<'${delimiter}'\n`;
  const start = installer.indexOf(marker);
  assert(start >= 0, `${name} heredoc not found`);
  const end = installer.indexOf(`\n${delimiter}\n`, start + marker.length);
  assert(end > start, `${name} heredoc end not found`);
  return installer.slice(start + marker.length, end + 1);
}

const bash = resolveBash();
const tempDir = fs.mkdtempSync(path.join(repoRoot, '.tmp-watchdog-snapshots-'));
const file = (name) => path.join(tempDir, name);
const readLines = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8').split('\n').filter(Boolean) : []);

function reset(files) {
  for (const name of ['calls', 'ss-calls', 'logger', 'sockets', 'state']) fs.rmSync(file(name), { recursive: true, force: true });
  fs.mkdirSync(file('state'), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(file(name), content);
}

function setState(states) {
  for (const [unit, state] of Object.entries(states)) fs.writeFileSync(path.join(file('state'), unit), `${state}\n`);
}

// Stub sebagai fungsi bash, dicatat ke file karena sebagian dipanggil di subshell.
const stubs = `
systemctl() {
  printf '%s\\n' "$*" >> ./calls
  local unit="\${@: -1}" state
  state="$(cat "./state/\${unit}" 2>/dev/null || echo inactive)"
  case "$1" in
    is-enabled) [[ -f "./state/\${unit}.enabled" ]] && echo enabled || echo disabled ;;
    is-active) [[ "\${state}" == active ]] ;;
    show) printf '%s\\n' "\${state}" ;;
    stop) printf '%s\\n' "\${STOP_RESULT:-inactive}" > "./state/\${unit}" ;;
    restart) printf '%s\\n' "\${RESTART_SOCKETS:-}" > ./sockets; echo active > "./state/\${unit}" ;;
    *) return 0 ;;
  esac
}
ss() {
  echo "$*" >> ./ss-calls
  [[ "\${SS_FAIL:-0}" == 1 ]] && return 1
  cat ./sockets 2>/dev/null
}
logger() { printf '%s\\n' "$*" >> ./logger; }
sleep() { :; }
`;

function runBash(body, env = {}) {
  const result = spawnSync(bash, [], {
    cwd: tempDir,
    input: `${stubs}\n${body}`,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  if (result.error) throw result.error;
  return result;
}

try {
  // ---------------------------------------------------------------- drain
  const drain = heredoc('sc-1forcr-udpgw-drain', 'EOF')
    .split('/etc/sc-1forcr.env').join('./sc-1forcr.env')
    .split('/opt/sc-1forcr/.env').join('./app.env');
  assert.strictEqual(spawnSync(bash, ['-n'], { input: drain, encoding: 'utf8' }).status, 0, 'generated udpgw-drain syntax failed');
  assert(!/^\s*established="\$\(ss /m.test(drain), 'udpgw-drain must not call ss per alias');

  const env = 'SSHWS_UDPGW_PORTS=7300,7200,7100\nSSHWS_UDPGW_SINGLE_PROCESS=1\n';
  const A1 = 'sc-1forcr-udpgw@7200.service';
  const A2 = 'sc-1forcr-udpgw@7100.service';
  const PRIMARY = 'sc-1forcr-udpgw@7300.service';
  const calls = (verb) => readLines('calls').filter((line) => line.split(' ')[0] === verb);

  // `ss` gagal: alias aktif tidak disentuh, exit 0, alasan dicatat.
  reset({ 'sc-1forcr.env': env });
  setState({ [A1]: 'active', [A2]: 'active' });
  let r = runBash(drain, { SS_FAIL: '1' });
  assert.strictEqual(r.status, 0, `drain must exit 0 when ss fails:\n${r.stderr}`);
  assert.deepStrictEqual(calls('stop'), [], 'drain must not stop aliases when ss fails');
  assert.deepStrictEqual(calls('reset-failed'), []);
  assert.strictEqual(readLines('ss-calls').length, 1);
  assert(readLines('logger').some((line) => line.includes('snapshot koneksi (ss) gagal')), 'ss failure must be logged');

  // Alias dengan koneksi tetap jalan; alias tanpa koneksi di-stop; ss sekali saja.
  reset({ 'sc-1forcr.env': env, sockets: '0 0 127.0.0.1:7200 127.0.0.1:40000\n0 0 127.0.0.1:40001 127.0.0.1:7100\n' });
  setState({ [A1]: 'active', [A2]: 'active' });
  r = runBash(drain);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(readLines('ss-calls'), ['-Htn state established'], 'one ss snapshot per drain cycle');
  assert.deepStrictEqual(calls('stop'), [`stop ${A2}`], 'only the idle alias is stopped (peer port is not a local listener)');
  assert.deepStrictEqual(calls('reset-failed'), [], 'reset-failed only for failed units');
  assert(!readLines('calls').some((line) => line.includes(PRIMARY)), 'primary UDPGW port is never touched');

  // Semua alias inactive: ss tidak dipanggil, reset-failed tidak dipanggil.
  reset({ 'sc-1forcr.env': env });
  setState({ [A1]: 'inactive', [A2]: 'inactive' });
  r = runBash(drain);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(readLines('ss-calls'), [], 'ss must not run when no alias is active');
  assert.deepStrictEqual(calls('reset-failed'), []);
  assert.deepStrictEqual(calls('stop'), []);

  // Alias failed: reset-failed untuk unit itu saja, tetap tanpa ss.
  reset({ 'sc-1forcr.env': env });
  setState({ [A1]: 'failed', [A2]: 'inactive' });
  r = runBash(drain);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(calls('reset-failed'), [`reset-failed ${A1}`]);
  assert.deepStrictEqual(readLines('ss-calls'), []);

  // IPv6 dan kolom State: kedua alias punya koneksi, tidak ada yang di-stop.
  reset({ 'sc-1forcr.env': env, sockets: 'ESTAB 0 0 [::1]:7200 [::1]:40000\n0 0 [::ffff:127.0.0.1]:7100 [::ffff:127.0.0.1]:40002\n' });
  setState({ [A1]: 'active', [A2]: 'active' });
  r = runBash(drain);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(calls('stop'), [], 'IPv6/state-column endpoints must count as connections');

  // Unit yang berakhir failed setelah stop dibersihkan; yang inactive tidak.
  reset({ 'sc-1forcr.env': env, sockets: '' });
  setState({ [A1]: 'active', [A2]: 'active' });
  r = runBash(drain, { STOP_RESULT: 'failed' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(calls('stop'), [`stop ${A1}`, `stop ${A2}`]);
  assert.deepStrictEqual(calls('reset-failed'), [`reset-failed ${A1}`, `reset-failed ${A2}`]);
  assert.strictEqual(readLines('ss-calls').length, 1, 'snapshot is shared across aliases');

  // Alias yang masih enabled di-disable tanpa daemon-reload.
  reset({ 'sc-1forcr.env': env });
  setState({ [A1]: 'inactive', [A2]: 'inactive' });
  fs.writeFileSync(path.join(file('state'), `${A1}.enabled`), '');
  r = runBash(drain);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(calls('disable'), [`disable --no-reload ${A1}`]);
  assert.deepStrictEqual(calls('daemon-reload'), []);

  // ---------------------------------------------------------------- health
  const health = heredoc('sc-1forcr-postboot-health', 'POSTBOOT_HEALTH_EOF');
  assert.strictEqual(spawnSync(bash, ['-n'], { input: health, encoding: 'utf8' }).status, 0, 'generated postboot-health syntax failed');
  const fnStart = health.indexOf('unit_managed() {');
  const fnEnd = health.indexOf('if [[ -f "${ACCESS_LOCK_FILE}" ]]');
  assert(fnStart > 0 && fnEnd > fnStart, 'postboot-health functions not found');
  const healthFns = `
HAPROXY_CONFIG=./haproxy.cfg
REPAIR_STAMP_DIR=./stamps
REPAIR_COOLDOWN_SECONDS=900
declare -a repaired_units=()
failed=0
log_health() { printf '%s\\n' "$*" >> ./logger; }
${health.slice(fnStart, fnEnd)}
`;
  const U = 'test.service';
  const listen = 'LISTEN 0 128 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 128 [::]:443 [::]:*\n';

  // Semua port unit diperiksa dari satu snapshot (IPv4 dan IPv6).
  reset({ sockets: listen });
  setState({ [U]: 'active' });
  r = runBash(`${healthFns}\nunit_healthy ${U} 80 443`);
  assert.strictEqual(r.status, 0, `healthy unit reported unhealthy:\n${r.stderr}`);
  assert.deepStrictEqual(readLines('ss-calls'), ['-H -lnt'], 'one listener snapshot per health attempt');

  // Port yang hilang = tidak sehat.
  reset({ sockets: listen });
  setState({ [U]: 'active' });
  r = runBash(`${healthFns}\nunit_healthy ${U} 80 8443`);
  assert.notStrictEqual(r.status, 0, 'missing listener must be unhealthy');

  // Unit tanpa port: tanpa ss.
  reset({});
  setState({ [U]: 'active' });
  r = runBash(`${healthFns}\nunit_healthy ${U}`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(readLines('ss-calls'), [], 'unit without ports must not call ss');

  // ss gagal = tidak sehat (perilaku lama dipertahankan).
  reset({ sockets: listen });
  setState({ [U]: 'active' });
  r = runBash(`${healthFns}\nunit_healthy ${U} 80`, { SS_FAIL: '1' });
  assert.notStrictEqual(r.status, 0, 'ss failure must count as unhealthy');

  // Unit inactive: tidak sehat tanpa memanggil ss.
  reset({ sockets: listen });
  setState({ [U]: 'inactive' });
  r = runBash(`${healthFns}\nunit_healthy ${U} 80`);
  assert.notStrictEqual(r.status, 0);
  assert.deepStrictEqual(readLines('ss-calls'), []);

  // Jalur pulih: cek awal dan cek ulang setelah sleep masing-masing mengambil
  // snapshot sendiri; setelah restart snapshot baru melihat listener baru.
  reset({ sockets: 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n' });
  setState({ [U]: 'active' });
  r = runBash(`${healthFns}\nrepair_unit_if_needed ${U} 80 443 || exit 9\nprintf '%s\\n' "\${repaired_units[*]}" > ./repaired`,
    { RESTART_SOCKETS: listen.trimEnd() });
  assert.strictEqual(r.status, 0, `repair path failed:\n${r.stderr}`);
  assert.deepStrictEqual(calls('restart'), [`restart ${U}`]);
  assert.strictEqual(readLines('ss-calls').length, 3, 'initial check, re-check after sleep, and post-restart check each take a fresh snapshot');
  assert.deepStrictEqual(readLines('repaired'), [U]);

  console.log('Watchdog snapshot tests: OK');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

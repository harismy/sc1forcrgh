'use strict';

// Regresi rilis hemat resource: backend UDP yang tidak aktif tidak boleh bisa
// crash-loop, capacity-tune dibatasi dan tidak menghitung ulang data yang sudah
// ada, log Xray punya batas ukuran, dan notif online tidak memuat semua unit.

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

// --- Backend UDP eksklusif -------------------------------------------------
// Drop-in harus ditulis sebelum enforce menyalakan backend, di jalur yang
// dipakai install maupun update.
const enforce = extract(installer, 'enforce_single_udp_backend() {', '\n}\n');
assert(/^  write_udp_backend_exclusive_dropins$/m.test(enforce.split('\n').slice(0, 4).join('\n')),
  'enforce_single_udp_backend must write the exclusive drop-ins before starting a backend');
const dropins = extract(installer, 'write_udp_backend_exclusive_dropins() {', '\n}\n');
assert(dropins.includes("ExecCondition=/bin/sh -c '! systemctl is-active --quiet ${other}.service'"),
  'UDP backend must refuse to start while the other backend is active');
assert(!/\$\$|%/.test(dropins.match(/ExecCondition=.*/)[0]), 'ExecCondition must not need systemd $/% escaping');

// Syarat "lawan tidak aktif": exit 0 (boleh start) saat lawan mati, 1 (dilewati
// tanpa dianggap gagal, jadi Restart=always tidak mengulang) saat lawan aktif.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-udp-cond-'));
try {
  const stub = path.join(stubDir, 'systemctl');
  fs.writeFileSync(stub, '#!/bin/sh\nexit "${FAKE_OTHER_ACTIVE_RC}"\n', { mode: 0o755 });
  const condition = dropins.match(/ExecCondition=\/bin\/sh -c '(.*)'/)[1].replace('${other}', 'zivpn');
  const run = (rc) => spawnSync(bash, ['-c', `PATH="$(cygpath -u '${stubDir}' 2>/dev/null || echo '${stubDir}'):$PATH" FAKE_OTHER_ACTIVE_RC=${rc} sh -c '${condition}'`], { encoding: 'utf8' }).status;
  assert.strictEqual(run(0), 1, 'other backend active: start must be skipped');
  assert.strictEqual(run(3), 0, 'other backend inactive: start must proceed');
} finally {
  fs.rmSync(stubDir, { recursive: true, force: true });
}

// --- Capacity-tune ---------------------------------------------------------
const tuneVars = extract(installer, 'auto_tune_resource_vars() {', '\n  ram_mib=');
assert(/RESOURCE_AUTOTUNE_INTERVAL_MINUTES:-15/.test(tuneVars), 'capacity analyzer default must be 15 minutes');
assert(/== "5" \]\] && RESOURCE_AUTOTUNE_INTERVAL_MINUTES="15"/.test(tuneVars), 'old stored default 5 must migrate to 15');
const tuneSnippet = `${tuneVars.replace(/^auto_tune_resource_vars\(\) \{\n/, '')}\necho "$RESOURCE_AUTOTUNE_INTERVAL_MINUTES"`;
for (const [input, expected] of [['5', '15'], ['', '15'], ['10', '10'], ['99', '15']]) {
  const out = spawnSync(bash, ['-c', `normalize_bool_01(){ echo 1; }; sanitize_percent_value(){ echo 85; }; RESOURCE_AUTOTUNE_INTERVAL_MINUTES='${input}'; ${tuneSnippet}`], { encoding: 'utf8' });
  assert.strictEqual(out.stdout.trim(), expected, `interval ${input || '(kosong)'} must become ${expected}: ${out.stderr}`);
}

const capacityUnit = extract(installer, "cat > /etc/systemd/system/sc-1forcr-capacity-tune.service <<'EOF'\n", '\nEOF\n');
for (const line of ['TimeoutStartSec=', 'Nice=', 'CPUQuota=', 'MemoryMax=']) {
  assert(capacityUnit.includes(`\n${line}`), `capacity-tune unit must set ${line}`);
}
const capacityScript = extract(installer, "cat > /usr/local/sbin/sc-1forcr-capacity-tune <<'EOF'\n", '\nEOF\n');
const assertBashSyntax = (source, label) => {
  const result = spawnSync(bash, ['-n'], { input: source, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${label} syntax failed:\n${result.stderr}`);
};
assertBashSyntax(capacityScript, 'capacity-tune');
const onlineIndex = capacityScript.indexOf('/usr/local/sbin/sc-1forcr-online-notify >/dev/null');
const fallbackGate = capacityScript.indexOf('if [[ "${online_source}" != "online_notify" ]]; then');
const xrayTail = capacityScript.indexOf('tail -n 10000 /var/log/xray/access.log');
assert(onlineIndex > 0 && fallbackGate > onlineIndex && xrayTail > fallbackGate,
  'capacity-tune must read online-notify state first and only tail the Xray log as a fallback');

// --- Logrotate ------------------------------------------------------------
const logrotate = extract(installer, 'setup_logrotate_optimizations() {', '\nissue_letsencrypt_cert() {');
const xrayStanza = extract(logrotate, '/var/log/xray/*.log {', '}');
assert(/\n  maxsize \d+M\n/.test(xrayStanza), 'Xray logs must have a size cap');
assert(!/^\/var\/log\/nginx/m.test(logrotate), 'nginx logs belong to the nginx package config; duplicates make logrotate reject the block');
assert(/OnCalendar=\nOnCalendar=hourly/.test(logrotate), 'logrotate must run hourly so maxsize takes effect');
const updatePath = extract(installer, '    setup_resource_autotune_timer\n', '    write_cli_menu\n');
assert(updatePath.includes('setup_logrotate_optimizations'), 'logrotate config must also be refreshed on safe update');

// --- Notif online -----------------------------------------------------------
const notify = extract(installer, "cat > /usr/local/sbin/sc-1forcr-online-notify <<'EOF'\n", '\nEOF\n');
assert(!/systemctl list-unit-files \| grep -q/.test(notify), 'online-notify must not load every unit file just to check one');

console.log('resource guard tests passed');

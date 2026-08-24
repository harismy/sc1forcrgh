'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installerPath = path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh');
const installer = fs.readFileSync(installerPath, 'utf8').replace(/\r\n/g, '\n');

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

function extract(startMarker, endMarker) {
  const startIndex = installer.indexOf(startMarker);
  assert(startIndex >= 0, `start marker not found: ${startMarker}`);
  const bodyStart = startIndex + startMarker.length;
  const endIndex = installer.indexOf(endMarker, bodyStart);
  assert(endIndex >= 0, `end marker not found: ${endMarker}`);
  return `${installer.slice(bodyStart, endIndex)}\n`;
}

const start = installer.indexOf('merge_xray_observations() {');
assert(start >= 0, 'merge_xray_observations function not found');
const endMarker = '\n}\n\nshow_xray_online_by_table() {';
const end = installer.indexOf(endMarker, start);
assert(end >= 0, 'merge_xray_observations end marker not found');
const mergeSource = `${installer.slice(start, end + 2)}\n`;

assert(installer.includes('visibility=(auth_active ? "AUTH_ACTIVE" : "AUTH_RECENT")'));
assert(installer.includes('merge_xray_observations "${t_tracker}" "${t_log}" "${t_seen}"'));
assert(installer.includes('visibility=="AUTH_ACTIVE"'));
assert(installer.includes('else if (visibility ~ /RECENT/) out="RECENT";'));
assert(installer.includes('SOURCE_NET_EST_ACTIVE'));
assert(installer.includes('"NET_AKTIF"'));

const onlineNotifySource = extract(
  "cat > /usr/local/sbin/sc-1forcr-online-notify <<'EOF'\n",
  '\nEOF\n  chmod +x /usr/local/sbin/sc-1forcr-online-notify'
);
const notifySyntax = spawnSync(resolveBash(), ['-n'], { input: onlineNotifySource, encoding: 'utf8' });
assert.strictEqual(notifySyntax.status, 0, `online notify syntax failed:\n${notifySyntax.stderr || notifySyntax.stdout}`);
assert(onlineNotifySource.includes('xray_tracker_users=""'));
assert(onlineNotifySource.includes('xray_log_users=""'));
assert(onlineNotifySource.includes('xray_monitor_mode="AUTH_LOG_FALLBACK"'));
assert(onlineNotifySource.includes('"JARINGAN"'));

const tempDir = fs.mkdtempSync(path.join(repoRoot, '.tmp-xray-monitor-'));
const trackerPath = path.join(tempDir, 'tracker.txt');
const logPath = path.join(tempDir, 'log.txt');
const outputPath = path.join(tempDir, 'merged.txt');
const accessLogPath = path.join(tempDir, 'access.log');
const snapshotPath = path.join(tempDir, 'snapshot.txt');

try {
  fs.writeFileSync(trackerPath, [
    'alice|2|1|1|203.0.113.10|SOURCE_IP_ACTIVE',
    'dave|1|0|0|TIDAK_TERDETEKSI|PROXY_LOCAL'
  ].join('\n') + '\n');
  fs.writeFileSync(logPath, [
    'alice|0|0|1|203.0.113.10|SOURCE_IP_RECENT_ACTIVE',
    'bob|0|0|0|TIDAK_TERDETEKSI|AUTH_ACTIVE',
    'carol|0|0|1|198.51.100.20|SOURCE_IP_RECENT'
  ].join('\n') + '\n');

  const bash = resolveBash();
  const script = `${mergeSource}\nmerge_xray_observations "$1" "$2" "$3"\n`;
  const result = spawnSync(bash, ['-s', '--', trackerPath, logPath, outputPath], {
    cwd: repoRoot,
    input: script,
    encoding: 'utf8'
  });
  assert.strictEqual(result.status, 0, result.stderr || 'Xray monitor merge failed');

  const rows = fs.readFileSync(outputPath, 'utf8').trim().split(/\r?\n/);
  assert.deepStrictEqual(rows, [
    'alice|2|1|1|203.0.113.10|SOURCE_IP_ACTIVE',
    'bob|0|0|0|TIDAK_TERDETEKSI|AUTH_ACTIVE',
    'carol|0|0|1|198.51.100.20|SOURCE_IP_RECENT',
    'dave|1|0|0|TIDAK_TERDETEKSI|PROXY_LOCAL'
  ]);

  const snapshotStart = installer.indexOf('xray_log_snapshot() {');
  assert(snapshotStart >= 0, 'xray_log_snapshot function not found');
  const snapshotEnd = installer.indexOf('\n}\n\nmerge_xray_observations() {', snapshotStart);
  assert(snapshotEnd >= 0, 'xray_log_snapshot end marker not found');
  const snapshotSource = `${installer.slice(snapshotStart, snapshotEnd + 2)}\n`;
  const stamp = (secondsAgo) => {
    const date = new Date(Date.now() - (secondsAgo * 1000));
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  const accessRows = [
    `${stamp(50)} from tcp:140.213.1.1:40001 accepted tcp:example.com:443 [vmess >> direct] email: twophones`,
    `${stamp(25)} from tcp:182.5.10.2:40002 accepted tcp:example.com:443 [vmess >> direct] email: twophones`,
    `${stamp(20)} from tcp:140.213.1.1:40001 accepted tcp:example.com:443 [vmess >> direct] email: twophones`,
    `${stamp(10)} from tcp:182.5.10.2:40002 accepted tcp:example.com:443 [vmess >> direct] email: twophones`,
    `${stamp(45)} from tcp:140.213.1.1:41001 accepted tcp:example.com:443 [vmess >> direct] email: handoff`,
    `${stamp(30)} from tcp:140.213.200.2:41002 accepted tcp:example.com:443 [vmess >> direct] email: handoff`,
    `${stamp(15)} from tcp:140.213.1.1:41001 accepted tcp:example.com:443 [vmess >> direct] email: handoff`,
    `${stamp(5)} from tcp:140.213.200.2:41002 accepted tcp:example.com:443 [vmess >> direct] email: handoff`,
    `${stamp(35)} from tcp:203.0.113.8:42001 accepted tcp:example.com:443 [vmess >> direct] email: dualstack`,
    `${stamp(25)} from tcp:[2001:db8::8]:42002 accepted tcp:example.com:443 [vmess >> direct] email: dualstack`,
    `${stamp(15)} from tcp:203.0.113.8:42001 accepted tcp:example.com:443 [vmess >> direct] email: dualstack`,
    `${stamp(5)} from tcp:[2001:db8::8]:42002 accepted tcp:example.com:443 [vmess >> direct] email: dualstack`
  ];
  fs.writeFileSync(accessLogPath, `${accessRows.join('\n')}\n`);
  const snapshotScript = `${snapshotSource}\nxray_recent_window_min=5\nxray_active_window_sec=60\nxray_monitor_recent_window_min=5\nxray_monitor_active_window_sec=60\nxray_min_hits_per_ip=2\nXRAY_ACCESS_LOG="$1" xray_log_snapshot "$2" normal\n`;
  const snapshotResult = spawnSync(bash, ['-s', '--', accessLogPath, snapshotPath], {
    cwd: repoRoot,
    input: snapshotScript,
    encoding: 'utf8'
  });
  assert.strictEqual(snapshotResult.status, 0, snapshotResult.stderr || 'Xray log snapshot failed');
  const snapshotRows = fs.readFileSync(snapshotPath, 'utf8').trim().split(/\r?\n/).sort();
  assert(snapshotRows.includes('twophones|0|2|2|182.5.10.2|SOURCE_NET_EST_ACTIVE'));
  assert(snapshotRows.includes('handoff|0|1|2|140.213.200.2|SOURCE_NET_EST_ACTIVE'));
  assert(snapshotRows.includes('dualstack|0|1|2|2001:db8::8|SOURCE_NET_EST_ACTIVE'));
} finally {
  for (const file of [snapshotPath, accessLogPath, outputPath, trackerPath, logPath]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
  try { fs.rmdirSync(tempDir); } catch (_) {}
}

console.log('xray monitor tests: OK');

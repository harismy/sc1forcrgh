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

const tempDir = fs.mkdtempSync(path.join(repoRoot, '.tmp-xray-monitor-'));
const trackerPath = path.join(tempDir, 'tracker.txt');
const logPath = path.join(tempDir, 'log.txt');
const outputPath = path.join(tempDir, 'merged.txt');

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
} finally {
  for (const file of [outputPath, trackerPath, logPath]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
  try { fs.rmdirSync(tempDir); } catch (_) {}
}

console.log('xray monitor tests: OK');

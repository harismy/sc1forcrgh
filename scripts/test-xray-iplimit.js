'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installerPath = path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh');
const installer = fs.readFileSync(installerPath, 'utf8').replace(/\r\n/g, '\n');

function extract(startMarker, endMarker) {
  const start = installer.indexOf(startMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const bodyStart = start + startMarker.length;
  const end = installer.indexOf(endMarker, bodyStart);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return `${installer.slice(bodyStart, end)}\n`;
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

function assertBashSyntax(bash, source, label) {
  const result = spawnSync(bash, ['-n'], { input: source, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${label} syntax failed:\n${result.stderr || result.stdout}`);
}

const checkerSource = extract(
  'cat > "${APP_DIR}/iplimit-checker.js" <<\'EOF\'\n',
  '\nEOF\n}'
);
new vm.Script(checkerSource, { filename: 'iplimit-checker.js' });

const mainCall = '\nmain().catch((e) => {';
const mainCallIndex = checkerSource.lastIndexOf(mainCall);
assert(mainCallIndex > 0, 'checker main call not found');
const checkerForPolicyTest = `${checkerSource.slice(0, mainCallIndex)}
globalThis.__xrayPolicy = {
  selectXrayRecentIpMap,
  countIpGroups,
  xrayViolationSignal,
  defaults: {
    checkInterval: CHECK_INTERVAL_MINUTES,
    recentMinutes: XRAY_RECENT_WINDOW_MINUTES,
    activeSeconds: XRAY_ACTIVE_WINDOW_SECONDS,
    minHits: XRAY_MIN_HITS_PER_IP,
    confirmCycles: XRAY_LIMIT_CONFIRM_CYCLES
  }
};
`;

class FakeDatabase {}
const context = vm.createContext({
  Buffer,
  console,
  process: { env: {}, pid: 1 },
  require(name) {
    if (name === 'sqlite3') {
      return { verbose: () => ({ Database: FakeDatabase }) };
    }
    return require(name);
  }
});
new vm.Script(checkerForPolicyTest, { filename: 'iplimit-checker-policy.js' }).runInContext(context);
const policy = context.__xrayPolicy;

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(policy.defaults)),
  { checkInterval: 5, recentMinutes: 5, activeSeconds: 60, minHits: 2, confirmCycles: 2 }
);

const now = 1_000_000;
function select(entries) {
  const stats = new Map([['vmessid32026', new Map(entries)]]);
  return Array.from(policy.selectXrayRecentIpMap(stats, now).get('vmessid32026') || []).sort();
}

assert.deepStrictEqual(select([
  ['182.5.1.1', { hits: 3, firstSeen: now - 50_000, lastSeen: now - 20_000 }],
  ['140.213.1.1', { hits: 2, firstSeen: now - 10_000, lastSeen: now - 5_000 }]
]), ['140.213.1.1'], 'serial mobile handoff must replace the old IP');

assert.deepStrictEqual(select([
  ['182.5.1.1', { hits: 3, firstSeen: now - 50_000, lastSeen: now - 2_000 }],
  ['140.213.1.1', { hits: 2, firstSeen: now - 10_000, lastSeen: now - 5_000 }]
]), ['140.213.1.1', '182.5.1.1'], 'overlapping active IPs must remain candidates');

assert.deepStrictEqual(select([
  ['182.5.1.1', { hits: 1, firstSeen: now - 20_000, lastSeen: now - 2_000 }],
  ['140.213.1.1', { hits: 2, firstSeen: now - 10_000, lastSeen: now - 1_000 }]
]), ['140.213.1.1'], 'a secondary IP with one hit must be ignored');

assert.deepStrictEqual(select([
  ['182.5.1.1', { hits: 4, firstSeen: now - 120_000, lastSeen: now - 70_000 }]
]), [], 'stale IPs must not be active candidates');

const sameCarrierGroup = policy.xrayViolationSignal(new Set(['140.213.1.1', '140.213.200.2']));
assert.strictEqual(
  sameCarrierGroup,
  policy.xrayViolationSignal(new Set(['140.213.99.9'])),
  'the violation fingerprint must use unique /16 groups'
);
assert.notStrictEqual(
  sameCarrierGroup,
  policy.xrayViolationSignal(new Set(['182.5.1.1'])),
  'different carrier groups must produce a different fingerprint'
);

assert(installer.includes('const hasLiveEvidence = xrayLive.available && liveSocketCount > 0;'));
assert(installer.includes('if (!violation.confirmed) continue;'));
assert(installer.includes('active=($3+0 > 0 && $4+0 > 0 ? 1 : 0);'));
assert(installer.includes('else out="OFFLINE";'));
assert(installer.includes('tracker_schema="5"'));

const xrayLiveSource = extract(
  "cat > /usr/local/sbin/sc-1forcr-xray-live <<'EOF'\n",
  '\nEOF\n  if ! bash -n /usr/local/sbin/sc-1forcr-xray-live; then'
);
assert(xrayLiveSource.includes("printf '%s\\n' 'rows-v3'"));

const bash = resolveBash();
assertBashSyntax(bash, installer, 'installer');
assertBashSyntax(bash, xrayLiveSource, 'xray live helper');
const capabilities = spawnSync(bash, ['-s', '--', 'capabilities'], {
  input: xrayLiveSource,
  encoding: 'utf8'
});
assert.strictEqual(capabilities.status, 0, capabilities.stderr || 'capabilities failed');
assert.strictEqual(capabilities.stdout.trim(), 'rows-v3');

console.log('xray iplimit tests: OK');

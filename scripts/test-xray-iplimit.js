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
  countXrayEffectiveDevices,
  xrayRepresentativeIps,
  normalizeMultiLoginEvidence,
  xrayViolationSignal,
  selectEnforceableXrayRows,
  buildXrayRuntimeConfig,
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
  process: { env: { XRAY_REAL_IP_ENABLE: '1' }, pid: 1 },
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

const generatedConfig = JSON.parse(JSON.stringify(policy.buildXrayRuntimeConfig(
  [{ username: 'vmess-user', secret: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
  [{ username: 'vless-user', secret: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }],
  [{ username: 'trojan-user', secret: 'CaseSensitiveSecret' }]
)));
assert.strictEqual(generatedConfig.inbounds.length, 7, 'runtime config must contain API and six Xray inbounds');
const generatedVmessWs = generatedConfig.inbounds.find((inbound) => inbound.port === 10001);
assert.strictEqual(generatedVmessWs.settings.clients[0].email, 'vmess-user');
assert.deepStrictEqual(
  generatedVmessWs.streamSettings.sockopt.trustedXForwardedFor,
  ['X-SC-Real-IP-Proxy'],
  'checker runtime config must include the real-IP helper output'
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

const enforceableRows = JSON.parse(JSON.stringify(policy.selectEnforceableXrayRows([
  { username: 'locked-user', uuid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', status: 'LOCK_TMP' },
  { username: 'active-copy', uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status: 'AKTIF' },
  { username: 'active-ok', uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', status: 'AKTIF' },
  { username: 'active-duplicate', uuid: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB', status: 'AKTIF' }
], 'uuid')));
assert.deepStrictEqual(enforceableRows.rows, [
  { username: 'active-ok', secret: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
], 'credentials owned by a locked account and duplicate active credentials must not reach Xray');
assert.deepStrictEqual(enforceableRows.collisions, [
  { username: 'active-copy', reason: 'credential-owned-by-blocked-account' },
  { username: 'active-duplicate', reason: 'duplicate-active-credential' }
]);
const trojanCaseRows = JSON.parse(JSON.stringify(policy.selectEnforceableXrayRows([
  { username: 'locked-trojan', password: 'CaseSensitiveSecret', status: 'LOCK_TMP' },
  { username: 'active-trojan', password: 'casesensitivesecret', status: 'AKTIF' }
], 'password')));
assert.strictEqual(trojanCaseRows.rows.length, 1, 'Trojan password comparison must remain case-sensitive');

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

assert.strictEqual(
  policy.countXrayEffectiveDevices(new Set(['140.213.1.1', '140.213.200.2']), 16),
  1,
  'carrier handoff addresses in one /16 must count as one device'
);
assert.strictEqual(
  policy.countXrayEffectiveDevices(new Set(['140.213.1.1', '182.5.10.2']), 16),
  2,
  'two active IPv4 carrier groups must count as two devices'
);
assert.strictEqual(
  policy.countXrayEffectiveDevices(new Set(['140.213.1.1', '2001:db8::1']), 16),
  1,
  'one IPv4 plus one IPv6 address must be treated as dual-stack'
);
assert.strictEqual(
  policy.countXrayEffectiveDevices(new Set(['2001:db8::1', '2001:db8::abcd']), 16),
  1,
  'IPv6 privacy addresses in one /64 must count as one device'
);

const rawXrayIps = [
  '140.213.1.1',
  '140.213.200.2',
  '182.5.1.1',
  '182.5.100.2',
  '182.5.200.3'
];
assert.deepStrictEqual(
  Array.from(policy.xrayRepresentativeIps(new Set(rawXrayIps), 16)).sort(),
  ['140.213.1.1', '182.5.1.1'],
  'webhook IP list must contain one representative per effective Xray network'
);
const webhookEvidence = JSON.parse(JSON.stringify(policy.normalizeMultiLoginEvidence(
  'VMESS',
  2,
  rawXrayIps,
  { detected_raw: 5, detected_effective: 2 }
)));
assert.deepStrictEqual(webhookEvidence, {
  effective: 2,
  reportedRaw: 2,
  observedRaw: 5,
  ips: ['140.213.1.1', '182.5.1.1'],
  label: '2 jaringan aktif (5 IP mentah teramati; IP operator/dual-stack digabung)'
});

assert(installer.includes('const hasSocketEvidence = xrayLive.available && liveSocketCount > 0;'));
assert(installer.includes('const hasStrongLogEvidence = cnt > 0 && lockIpSet.size > 0;'));
assert(installer.includes('const hasLiveEvidence = hasSocketEvidence || hasStrongLogEvidence;'));
assert(installer.includes('observed_ip_raw_count: evidence.observedRaw'));
assert(installer.includes('if (!violation.confirmed) continue;'));
assert(installer.includes('active=($3+0 > 0 && $4+0 > 0 ? 1 : 0);'));
assert(installer.includes('else out="OFFLINE";'));
assert(installer.includes('tracker_schema="5"'));
assert(installer.includes('20-sc-managed-config.conf'));
assert(installer.includes('write_iplimit_checker() {\n  log "Menulis checker limit IP otomatis..."\n  configure_xray_managed_runtime'));
assert(installer.includes('/usr/local/etc/xray/.config.${process.pid}.tmp.json'));
assert(!installer.includes('const primaryTmpPath = `${primaryPath}.tmp`;'));
assert(installer.includes('stopXrayFailClosed(`locked credential remains in config users='));
assert(installer.includes("throw new Error('Xray lock enforcement verification failed.')"));
const xrayLockStatusIndex = installer.indexOf("await run(`UPDATE ${item.table} SET status='LOCK_TMP'");
const immediateRebuildIndex = installer.indexOf('await rebuildXrayFromDb();', xrayLockStatusIndex);
const xrayLockNotifyIndex = installer.indexOf('await notifyMultiLoginLock(', immediateRebuildIndex);
assert(xrayLockStatusIndex > 0 && immediateRebuildIndex > xrayLockStatusIndex);
assert(xrayLockNotifyIndex > immediateRebuildIndex, 'Xray runtime lock must be applied before webhook notification');

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

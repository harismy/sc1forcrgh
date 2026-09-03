'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs
  .readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8')
  .replace(/\r\n/g, '\n');
const licenseApi = fs.readFileSync(path.join(repoRoot, 'license-api.js'), 'utf8');
const botApp = fs.readFileSync(path.join(repoRoot, 'app3.js'), 'utf8');

function extract(startMarker, endMarker, offset = 0) {
  const start = installer.indexOf(startMarker, offset);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const bodyStart = start + startMarker.length;
  const end = installer.indexOf(endMarker, bodyStart);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return { body: `${installer.slice(bodyStart, end)}\n`, end };
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
const updateManager = extract(
  "cat > /usr/local/sbin/sc-1forcr-update-manager <<'UPDATE_MANAGER_EOF'\n",
  '\nUPDATE_MANAGER_EOF\n'
).body;
const updateSyntax = spawnSync(bash, ['-n'], { input: updateManager, encoding: 'utf8' });
assert.strictEqual(updateSyntax.status, 0, `generated update manager syntax failed:\n${updateSyntax.stderr || updateSyntax.stdout}`);

const godUpdater = extract(
  'cat > "${god_script_tmp}" <<\'EOF\'\n',
  '\nEOF\n  if ! bash -n "${god_script_tmp}"; then'
).body;
const godSyntax = spawnSync(bash, ['-n'], { input: godUpdater, encoding: 'utf8' });
assert.strictEqual(godSyntax.status, 0, `generated God Mode updater syntax failed:\n${godSyntax.stderr || godSyntax.stdout}`);
assert(godUpdater.includes('/sc1forcr/god-update/check'));
assert(godUpdater.includes('/sc1forcr/god-update/ack'));
assert(!godUpdater.includes('AUTO_PULL_UPDATE_ENABLE'));
assert(licenseApi.includes("app.post('/sc1forcr/god-update/check', requireKeyedUpdateClient"));
assert(licenseApi.includes("app.post('/sc1forcr/god-update/ack', requireKeyedUpdateClient"));
assert(licenseApi.includes('script_urls: needsScript ? runtimeConfig.updateScriptUrls : []'));
assert(licenseApi.includes('licenseApiUrls: baseUrls.map'));
assert(botApp.includes("const SC_IP_CHANGE_MAX = 5;"));
assert(botApp.includes("Markup.button.callback('⚡ GOD MODE UPDATE WAJIB', 'm_admin_god_update')"));
assert(botApp.includes("setInterval(() => {\n    processGodUpdateCampaigns()"));

const acceptedTimerState = '[[ "${timer_state}" == "waiting" || "${timer_state}" == "running" ]]';
assert.strictEqual((updateManager.split(acceptedTimerState).length - 1), 3);

assert(installer.includes('-DCMAKE_POLICY_VERSION_MINIMUM=3.5'));
assert.strictEqual((installer.match(/certificate_dns_host_valid "\$\{alias_host\}"/g) || []).length, 4);
assert.strictEqual((installer.match(/log \/dev\/log local0 notice/g) || []).length, 2);
assert(!installer.includes('log /dev/log local1 notice'));
assert((installer.match(/check inter 2s fall 3 rise 2/g) || []).length >= 10);
assert(installer.includes('wait_haproxy_local_backends 30'));
assert(updateManager.includes('tcp_listener_present()'));
assert(updateManager.includes('backend lokal HAProxy tidak listen'));

const certHelperBody = extract(
  'sanitize_domain_host() {\n',
  '\nnormalize_domain_host_list() {\n'
).body;
const certHelpers = `sanitize_domain_host() {\n${certHelperBody}`;
const certBehavior = spawnSync(bash, [], {
  input: `${certHelpers}\n` +
    'certificate_dns_host_valid "103.179.57.218" && exit 21\n' +
    'certificate_dns_host_valid "id1.chostore.biz.id" || exit 22\n' +
    'certificate_dns_host_valid "-invalid.example.com" && exit 23\n' +
    'exit 0\n',
  encoding: 'utf8'
});
assert.strictEqual(certBehavior.status, 0, `certificate SAN filter failed:\n${certBehavior.stderr || certBehavior.stdout}`);

console.log('Safe update compatibility tests: OK');

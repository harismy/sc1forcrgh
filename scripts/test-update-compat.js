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

const udpBootfix = extract(
  "cat > /usr/local/sbin/sc-1forcr-udp-bootfix <<'EOF'\n",
  '\nEOF\n  chmod +x /usr/local/sbin/sc-1forcr-udp-bootfix'
).body;
const udpBootfixSyntax = spawnSync(bash, ['-n'], { input: udpBootfix, encoding: 'utf8' });
assert.strictEqual(udpBootfixSyntax.status, 0, `generated UDP boot-fix syntax failed:\n${udpBootfixSyntax.stderr || udpBootfixSyntax.stdout}`);

const udpStopHelpers = `udp_backend_active_state() {\n${extract(
  'udp_backend_active_state() {\n',
  '\nenforce_single_udp_backend() {\n'
).body}`;
const udpStopBehavior = spawnSync(bash, [], {
  input: `set -euo pipefail
mock_dir="$(mktemp -d)"
trap 'rm -rf -- "\${mock_dir}"' EXIT
mock_state_file="\${mock_dir}/state"
mock_log_file="\${mock_dir}/calls"
mock_stop_mode="normal"
printf 'active\\n' >"\${mock_state_file}"
systemctl() {
  local command="\${1:-}"
  shift || true
  case "\${command}" in
    show) cat "\${mock_state_file}" ;;
    stop)
      printf 'stop %s\\n' "$*" >>"\${mock_log_file}"
      [[ "\${mock_stop_mode}" == "normal" ]] && printf 'inactive\\n' >"\${mock_state_file}"
      ;;
    kill)
      printf 'kill %s\\n' "$*" >>"\${mock_log_file}"
      printf 'inactive\\n' >"\${mock_state_file}"
      ;;
    disable|reset-failed) : ;;
    *) : ;;
  esac
}
pkill() { printf 'pkill %s\\n' "$*" >>"\${mock_log_file}"; }
sleep() { :; }
log() { :; }
${udpStopHelpers}
stop_disable_udp_backend sc-1forcr-udpcustom udp-custom
[[ "$(cat "\${mock_state_file}")" == "inactive" ]]
if grep -q '^kill ' "\${mock_log_file}"; then exit 31; fi
printf 'active\\n' >"\${mock_state_file}"
: >"\${mock_log_file}"
mock_stop_mode="stuck"
stop_disable_udp_backend sc-1forcr-udpcustom udp-custom
grep -q '^kill --kill-who=all --signal=SIGKILL sc-1forcr-udpcustom$' "\${mock_log_file}"
grep -q '^pkill -KILL -x udp-custom$' "\${mock_log_file}"
[[ "$(cat "\${mock_state_file}")" == "inactive" ]]
`,
  encoding: 'utf8'
});
assert.strictEqual(udpStopBehavior.status, 0, `UDP backend stop behavior failed:\n${udpStopBehavior.stderr || udpStopBehavior.stdout}`);

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
assert(botApp.includes("'certonly', '--webroot', '-w', '/var/www/certbot'"));
assert(botApp.includes('verifyInstallerAcmeWebroot(domain)'));
assert(botApp.includes('location ^~ /.well-known/acme-challenge/'));
assert(botApp.includes('writeNginxInstallerVhost(domain, DEFAULT_LICENSE_API_PORT, { tls: true })'));

const acceptedTimerState = '[[ "${timer_state}" == "waiting" || "${timer_state}" == "running" ]]';
assert.strictEqual((updateManager.split(acceptedTimerState).length - 1), 3);

assert(installer.includes('-DCMAKE_POLICY_VERSION_MINIMUM=3.5'));
assert.strictEqual((installer.match(/certificate_dns_host_valid "\$\{alias_host\}"/g) || []).length, 4);
assert.strictEqual((installer.match(/log \/dev\/log local0 notice/g) || []).length, 2);
assert(!installer.includes('log /dev/log local1 notice'));
assert.strictEqual((installer.match(/option clitcpka/g) || []).length, 2);
assert.strictEqual((installer.match(/option srvtcpka/g) || []).length, 2);
assert.strictEqual((installer.match(/haproxy_log_option="    option dontlog-normal/g) || []).length, 2);
assert(!installer.includes('/usr/bin/systemctl --force reboot'));
assert(installer.includes('/usr/bin/systemctl reboot'));
assert(installer.includes('activate_haproxy_connection_hardening_if_needed'));
assert(installer.includes('setup_postboot_health_guard'));
assert(installer.includes('OnActiveSec=90s'));
assert((installer.match(/check inter 2s fall 3 rise 2/g) || []).length >= 10);
assert(installer.includes('wait_haproxy_local_backends 30'));
assert(updateManager.includes('tcp_listener_present()'));
assert(updateManager.includes('backend lokal HAProxy tidak listen'));
assert(updateManager.includes('snapshot_has_postboot_health'));
assert(updateManager.includes('systemctl disable --now sc-1forcr-postboot-health.timer'));
assert(installer.includes('stop_disable_udp_backend()'));
assert(installer.includes('wait_udp_backend_quiescent "${unit}" 15'));
assert(installer.includes('systemctl stop --no-block "${unit}"'));
assert(installer.includes('systemctl kill --kill-who=all --signal=SIGKILL "${unit}"'));
assert(installer.includes('pkill -KILL -x "${process_name}"'));
assert(!installer.includes('pkill -9 -f "udp-custom"'));
assert(!installer.includes('pkill -9 -f "zivpn"'));
assert(installer.includes('Unit UDP Custom diperbarui tanpa dinyalakan karena backend aktif adalah ZIVPN.'));
assert(installer.includes('Unit ZIVPN diperbarui tanpa dinyalakan karena backend aktif adalah UDPHC.'));
assert(udpBootfix.includes('stop_disable_udp_unit "${UDPCUSTOM_SERVICE}" "udp-custom" || exit 1'));
assert(updateManager.includes('update_stop_disable_udp_unit "${udpcustom_unit}" "udp-custom" || return 1'));

const postbootHealth = extract(
  "cat > /usr/local/sbin/sc-1forcr-postboot-health <<'POSTBOOT_HEALTH_EOF'\n",
  '\nPOSTBOOT_HEALTH_EOF\n'
).body;
const postbootSyntax = spawnSync(bash, ['-n'], { input: postbootHealth, encoding: 'utf8' });
assert.strictEqual(postbootSyntax.status, 0, `generated post-boot health syntax failed:\n${postbootSyntax.stderr || postbootSyntax.stdout}`);
assert(postbootHealth.includes('unit_healthy "${unit}" "$@" && return 0'));
assert(postbootHealth.includes('Pemeriksaan dilewati: akses SC sedang dikunci'));

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

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs
  .readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8')
  .replace(/\r\n/g, '\n');

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

const guard = extract(
  "cat > /usr/local/sbin/sc-1forcr-dns-guard <<'DNS_GUARD_SCRIPT_EOF'\n",
  '\nDNS_GUARD_SCRIPT_EOF\n'
);

const syntax = spawnSync(resolveBash(), ['-n'], { input: guard, encoding: 'utf8' });
assert.strictEqual(syntax.status, 0, `generated DNS guard syntax failed:\n${syntax.stderr || syntax.stdout}`);

assert(guard.includes('DNS_TEST_HOSTS=(deb.debian.org github.com ipinfo.io)'));
assert(guard.includes('nameserver 8.8.8.8\nnameserver 1.1.1.1'));
assert(guard.includes('/etc/systemd/resolved.conf.d/sc-1forcr-dns.conf'));
assert(guard.includes('backup_resolver'));
assert(guard.includes('recovery_resolver_configured'));
assert(guard.includes('dns_resolution_healthy && exit 0'));
assert.strictEqual((guard.match(/dns_resolution_healthy && exit 0/g) || []).length, 2);
const guardMain = guard.slice(guard.indexOf('main() {'));
assert(guardMain.indexOf('dns_resolution_healthy && exit 0') < guardMain.indexOf('backup_resolver'));

assert(installer.includes('OnUnitActiveSec=${DNS_GUARD_INTERVAL_MINUTES}min'));
assert(installer.includes('ensure_dns_resolver_if_needed\n  run_install_step "00_license"'));
assert(installer.includes('run_install_step "02b_dns_guard"'));

console.log('DNS resolver guard tests: OK');

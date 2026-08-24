'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

function requireText(source, expected) {
  assert(source.includes(expected), `missing CLI account output marker: ${expected}`);
}

const menuSource = extract(
  'cat > "${menu_runtime_tmp}" <<\'MENU_SCRIPT_EOF\'\n',
  '\nMENU_SCRIPT_EOF\n'
);
const bash = resolveBash();
const syntax = spawnSync(bash, ['-n'], { input: menuSource, encoding: 'utf8' });
assert.strictEqual(syntax.status, 0, `generated menu syntax failed:\n${syntax.stderr || syntax.stdout}`);

[
  'SSH ACCOUNT CREATED',
  '[ SSH PREMIUM DETAILS ]',
  'Expiry Time : ${exp_time}',
  '[ PAYLOAD ENHANCED + SPLIT ]',
  'ZIVPN ACCOUNT CREATED',
  'UDP PASSWORD : ${user}',
  '[ ${title} DETAILS ]',
  'ALTER ID    : 0',
  'ENCRYPTION  : none',
  'PASSWORD    : ${secret}',
  'NETWORK     : ws, grpc, upgrade',
  'PATH UPGRADE: ${path_upgrade}',
  '[ ${title} URL ]',
  'gRPC:',
  'Up Non-TLS:',
  '[ HOST INFORMATION ]',
  'Terima kasih telah menggunakan layanan kami.'
].forEach((marker) => requireText(menuSource, marker));

assert(menuSource.includes('vmess|vless|trojan)'), 'all Xray account types must use the rich formatter');
assert(menuSource.includes('.data.link.grpc'), 'gRPC link must come from the API response');
assert(menuSource.includes('.data.link.uptls'), 'upgrade TLS link must come from the API response');
assert(menuSource.includes('.data.city // .data.location.city'), 'VPS city must come from the API response');
assert(menuSource.includes('.data.isp // .data.location.isp'), 'VPS ISP must come from the API response');
assert(installer.includes('SCRIPT_VERSION="${SC_SCRIPT_VERSION_OVERRIDE:-V.1FSC.30}"'));

console.log('CLI account output tests: OK');

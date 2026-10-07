'use strict';

// Detail akun di menu CLI (print_created_account) harus sama persis dengan
// pesan akun BotVPN untuk respons API yang sama. Teks yang diharapkan ada di
// scripts/fixtures/account-message-parity.json; salinan identiknya dipakai test
// BotVPN (test/fixtures/sc1forcr-account-messages.json), jadi kalau tampilan
// diubah, ubah keduanya dan salin fixture-nya.
//
// Jalankan dengan --update untuk menulis ulang teks expected dari menu.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
const fixturePath = path.join(__dirname, 'fixtures', 'account-message-parity.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const update = process.argv.includes('--update');

function extract(source, startMarker, endMarker, keepStart = false) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return source.slice(keepStart ? start : start + startMarker.length, end);
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

// --- API: port UDP Custom hanya dikirim saat backend UDP Custom aktif ---
const api = extract(installer, 'cat > "${APP_DIR}/api.js" <<\'EOF\'\n', '\nEOF\n');
const udpPortFn = extract(api, '\nfunction udpcustomPublicPort() {', '\n}\n', true);
function udpcustomPort({ envFile = {}, processEnv = {}, config = null }) {
  const ctx = vm.createContext({
    UDPCUSTOM_CONFIG: '/root/udp/config.json',
    process: { env: processEnv },
    readServiceToggles: () => envFile,
    fs: {
      readFileSync: () => {
        if (config === null) throw new Error('ENOENT');
        return JSON.stringify(config);
      }
    }
  });
  new vm.Script(`${udpPortFn}\n}\nthis.out = udpcustomPublicPort();`).runInContext(ctx);
  return ctx.out;
}
assert.strictEqual(udpcustomPort({ config: { listen: ':5667' } }), '', 'backend ZIVPN (default) tidak mengiklankan UDP Custom');
assert.strictEqual(udpcustomPort({ envFile: { ACTIVE_UDP_BACKEND: 'zivpn' }, processEnv: { ACTIVE_UDP_BACKEND: 'udpcustom' }, config: { listen: ':5667' } }), '',
  '.env API (diubah menu tanpa restart) menang atas process.env');
assert.strictEqual(udpcustomPort({ envFile: { ACTIVE_UDP_BACKEND: 'udpcustom' }, config: { listen: ':7777' } }), '7777', 'port dibaca dari config udp-custom');
assert.strictEqual(udpcustomPort({ envFile: { ACTIVE_UDP_BACKEND: 'udphc' }, processEnv: { UDPCUSTOM_LISTEN_PORT: '5668' } }), '5668', 'config tidak terbaca: pakai UDPCUSTOM_LISTEN_PORT');
const sshPayloadFn = extract(api, '\nfunction sshPayload(', '\n}\n', true);
assert(sshPayloadFn.includes('...(udpcustomPort ? { udpcustom: udpcustomPort } : {})'), 'sshPayload hanya mengirim port.udpcustom kalau ada');

const menu = extract(installer, "cat > \"${menu_runtime_tmp}\" <<'MENU_SCRIPT_EOF'\n", '\nMENU_SCRIPT_EOF\n');
const engine = extract(menu, "MENU_ESC=$'\\033'\n", '\nif [[ "${1:-}" == "update" ]]; then', true);
const printer = extract(menu, '\ncreated_json_value() {', '\nrandom_alnum8() {', true);

const bash = resolveBash();
const toBashPath = (p) => (process.platform === 'win32'
  ? spawnSync(bash, ['-c', `cygpath -u '${p}'`], { encoding: 'utf8' }).stdout.trim()
  : p);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-account-parity-'));
try {
  const bin = path.join(tmpDir, 'bin');
  fs.mkdirSync(bin);
  // jq tiruan: cukup untuk bentuk query di print_created_account
  // (alternatif ".a.b // .c // \"teks\" // empty").
  const jqShim = path.join(tmpDir, 'jq-shim.js');
  fs.writeFileSync(jqShim, `
const expr = process.argv.slice(2).filter((a) => a !== '-r')[0] || '.';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let doc;
  try { doc = JSON.parse(input); } catch (_) { process.exit(5); }
  let out;
  for (const term of expr.replace(/[()]/g, '').split('//').map((t) => t.trim())) {
    let v;
    if (term === 'empty') v = undefined;
    else if (/^".*"$/.test(term)) v = JSON.parse(term);
    else if (term === '.') v = doc;
    else v = term.slice(1).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), doc);
    if (v !== undefined && v !== null && v !== false) { out = v; break; }
  }
  if (out !== undefined) process.stdout.write((typeof out === 'string' ? out : JSON.stringify(out)) + '\\n');
});
`);
  fs.writeFileSync(path.join(bin, 'jq'), `#!/usr/bin/env bash\nexec node '${toBashPath(jqShim)}' "$@"\n`);
  fs.chmodSync(path.join(bin, 'jq'), 0o755);

  const render = (type, mode, data) => {
    const raw = path.join(tmpDir, 'raw.json');
    fs.writeFileSync(raw, JSON.stringify({ meta: { code: 200, message: 'success' }, data }));
    const sh = path.join(tmpDir, 'render.sh');
    fs.writeFileSync(sh, `set -euo pipefail\nexport PATH='${toBashPath(bin)}':"$PATH"\n${engine}\n${printer}\n` +
      `MENU_COLOR_FILE=/tidak/ada\nMENU_COLS=80\nUI_MODE=''\nprint_created_account '${type}' "$(cat '${toBashPath(raw)}')" '${mode}'\n`);
    const r = spawnSync(bash, [toBashPath(sh)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `print_created_account ${type} ${mode} failed:\n${r.stderr}`);
    return r.stdout.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  };

  for (const item of fixture.cases) {
    const actual = render(item.type, item.mode, item.data);
    assert.doesNotMatch(actual, /OVPN|SSH OHP|DNS SELOW|DOWNLOAD CONFIG|:81\//, `${item.name}: layanan yang tidak dipasang SC tidak boleh tampil`);
    if (update) {
      item.expected = actual;
      continue;
    }
    assert.strictEqual(actual, item.expected, `${item.name}: output menu berbeda dengan fixture`);
  }

  if (update) {
    fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`fixture ditulis ulang: ${fixturePath}`);
  } else {
    console.log('account message parity tests passed');
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

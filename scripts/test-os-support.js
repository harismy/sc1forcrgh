'use strict';

// OS yang diterima installer. Install baru: Debian 12 ke atas dan Ubuntu 20.04
// ke atas, ditolak sebelum pembeli diminta domain. VPS yang sudah terpasang di
// OS lama (Debian 10/11) tetap boleh update; kalau ikut ditolak, update-nya
// gagal selamanya.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
const bot = fs.readFileSync(path.join(repoRoot, 'app3.js'), 'utf8').replace(/\r\n/g, '\n');

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
const B = (p) => (process.platform === 'win32'
  ? spawnSync(bash, ['-c', `cygpath -u '${p}'`], { encoding: 'utf8' }).stdout.trim()
  : p);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-os-support-'));
const osRelease = path.join(tmpDir, 'os-release');
const envFile = path.join(tmpDir, 'sc-1forcr.env');
const menuFile = path.join(tmpDir, 'menu-sc-1forcr');

const withPaths = (source) => source
  .replace(/\/etc\/os-release/g, B(osRelease))
  .replace(/\/etc\/sc-1forcr\.env/g, B(envFile))
  .replace(/\/usr\/local\/sbin\/menu-sc-1forcr/g, B(menuFile));
const guardBlock = withPaths(extract(installer, '# >>> os-support\n', '# <<< os-support\n'));
const checkFn = withPaths(extract(installer, 'check_supported_os() {', '\nipv6_supported() {'));
assert(guardBlock.includes(B(osRelease)) && checkFn.includes('unsupported_os_reason'), 'potongan pengecekan OS tidak terambil');

const script = path.join(tmpDir, 'run.sh');
fs.writeFileSync(script, `set -euo pipefail\nlog() { echo "LOG: $*"; }\n${guardBlock}\necho "LOLOS-AWAL"\n${checkFn}\ncheck_supported_os\necho "LANJUT"\n`);

function run({ id, version, pretty, installed = false, update = false, noRelease = false }) {
  for (const file of [osRelease, envFile, menuFile]) fs.rmSync(file, { force: true });
  if (!noRelease) {
    fs.writeFileSync(osRelease, `PRETTY_NAME="${pretty || `${id} ${version}`}"\nID=${id}\n${version ? `VERSION_ID="${version}"\n` : ''}`);
  }
  if (installed) {
    fs.writeFileSync(envFile, 'DOMAIN=vpn.contoh.com\n');
    fs.writeFileSync(menuFile, '#!/bin/sh\n');
    fs.chmodSync(menuFile, 0o755);
  }
  const r = spawnSync(bash, [B(script)], { encoding: 'utf8', env: { ...process.env, UPDATE_SAFE_MODE: update ? '1' : '0' } });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

try {
  // Install baru: OS yang diterima lolos tanpa peringatan.
  for (const [id, version] of [['debian', '12'], ['debian', '13'], ['ubuntu', '20.04'], ['ubuntu', '22.04'], ['ubuntu', '24.04'], ['ubuntu', '26.04']]) {
    const r = run({ id, version });
    assert.strictEqual(r.status, 0, `${id} ${version} harus diterima:\n${r.out}`);
    assert(r.out.includes('LOLOS-AWAL') && r.out.includes('LANJUT') && !r.out.includes('PERINGATAN'), r.out);
  }

  // Install baru: OS lama ditolak sejak awal, sebelum domain dan lisensi.
  const rejected = [
    [{ id: 'debian', version: '11' }, 'Debian 11 tidak didukung. Pakai Debian 12 atau 13.'],
    [{ id: 'debian', version: '10' }, 'Debian 10 tidak didukung. Pakai Debian 12 atau 13.'],
    [{ id: 'debian', version: '' }, 'Debian 0 tidak didukung. Pakai Debian 12 atau 13.'],
    [{ id: 'ubuntu', version: '18.04' }, 'Ubuntu 18.04 tidak didukung. Minimal Ubuntu 20.04.'],
    [{ id: 'centos', version: '9' }, 'OS centos belum didukung. Pakai Debian 12 atau 13, atau Ubuntu 20.04 ke atas.'],
    // Path di pesan ikut diganti ke file sementara oleh test ini.
    [{ noRelease: true }, `OS tidak dikenali (${B(osRelease)} tidak ditemukan).`]
  ];
  for (const [setup, message] of rejected) {
    const r = run(setup);
    assert.strictEqual(r.status, 1, `harus ditolak: ${JSON.stringify(setup)}\n${r.out}`);
    assert(r.out.includes(message), `pesan tolak salah untuk ${JSON.stringify(setup)}:\n${r.out}`);
    assert(!r.out.includes('LOLOS-AWAL'), 'OS yang tidak didukung harus ditolak sebelum input domain');
  }

  // VPS yang sudah terpasang di OS lama tetap boleh update atau dijalankan ulang.
  for (const setup of [{ id: 'debian', version: '11', update: true }, { id: 'debian', version: '11', installed: true }, { id: 'debian', version: '10', update: true }]) {
    const r = run({ pretty: 'Debian GNU/Linux lama', ...setup });
    assert.strictEqual(r.status, 0, `VPS lama harus tetap jalan: ${JSON.stringify(setup)}\n${r.out}`);
    assert(r.out.includes('LANJUT'), r.out);
    assert(r.out.includes(`LOG: PERINGATAN: Debian ${setup.version} tidak didukung. Pakai Debian 12 atau 13. SC yang sudah terpasang tetap dilanjutkan.`), r.out);
    assert(r.out.includes('LOG: OS terdeteksi: Debian GNU/Linux lama'));
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Penolakan harus terjadi sebelum input domain, dan jalur update tetap
// memanggil pengecekan yang sama.
const iGuard = installer.indexOf('# >>> os-support\n');
const iPrompt = installer.indexOf('\nif [[ -z "${DOMAIN}" ]]; then\n  if iui_tty_ok; then');
assert(iGuard > 0 && iPrompt > iGuard, 'pengecekan OS harus berada sebelum input domain');
assert(installer.indexOf('\nlog() {') < iGuard, 'log() harus sudah ada sebelum pengecekan OS');
const updatePath = extract(installer, '  if [[ "${UPDATE_SAFE_MODE:-0}" == "1" ]]; then\n    install_update_manager', '  # Re-run guard:');
assert(updatePath.includes('\n    check_supported_os\n'), 'jalur update harus tetap memeriksa OS');
assert(installer.includes('run_install_step "01_check_os" 4 "Cek OS server" check_supported_os'));
assert(installer.includes('# Target OS: Debian 12+ / Ubuntu 20.04+'));

// Teks bot harus menyebut batas yang sama.
assert(bot.includes("'• VPS memakai Debian 12 ke atas atau Ubuntu 20.04 ke atas.'"), 'panduan install harus menyebut Debian 12 ke atas');
assert(bot.includes("'- Debian 12 dan 13',\n    '- Ubuntu 20.04, 22.04, dan 24.04',"), 'daftar fitur harus menyebut OS yang didukung');
assert(!/Debian 1[01]\b/.test(bot), 'bot tidak boleh lagi menyebut Debian 10 atau 11 sebagai OS yang didukung');

console.log('os support tests: OK');

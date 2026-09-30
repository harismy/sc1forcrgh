'use strict';

// Debian 11 (bullseye) sudah habis masa dukungnya. File paket di repo security
// resminya dihapus dari mirror sementara indeksnya dibiarkan, jadi apt-get
// install berujung 404. Installer memindahkan repo itu ke snapshot.debian.org.
// Test menjalankan blok "bullseye-security-repo" dengan apt-get/curl tiruan dan
// memastikan:
// - pindah hanya di Debian 11 dan hanya kalau file paket terbukti 404,
// - baris repo lama dijadikan komentar, baris lain tidak disentuh,
// - idempoten, dan sumber apt utuh kalau snapshot tidak terjangkau,
// - blok di installer utama dan di setup-summary-api.sh sama persis.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
const installer = read('scripts/setup-autoscript-compat.sh');
const summary = read('scripts/setup-summary-api.sh');
const bot = read('app3.js');
const readme = read('README.md');

const START = '# >>> bullseye-security-repo\n';
const END = '# <<< bullseye-security-repo\n';

function extractBlock(source, label) {
  const start = source.indexOf(START);
  assert(start >= 0, `blok bullseye-security-repo tidak ada di ${label}`);
  const end = source.indexOf(END, start);
  assert(end >= 0, `penutup blok bullseye-security-repo tidak ada di ${label}`);
  assert.strictEqual(source.indexOf(START, start + 1), -1, `blok ganda di ${label}`);
  return source.slice(start, end + END.length);
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

const block = extractBlock(installer, 'installer');
assert.strictEqual(extractBlock(summary, 'setup-summary-api.sh'), block,
  'blok bullseye-security-repo di installer dan setup-summary-api.sh harus sama persis');

const syntax = spawnSync(bash, ['-n'], { input: block, encoding: 'utf8' });
assert.strictEqual(syntax.status, 0, `syntax blok gagal:\n${syntax.stderr || syntax.stdout}`);

const SNAPSHOT = (block.match(/BULLSEYE_SECURITY_SNAPSHOT:-(\d{8}T\d{6}Z)\}/) || [])[1];
assert(SNAPSHOT, 'timestamp snapshot harus berformat YYYYMMDDTHHMMSSZ');
const SNAPSHOT_URL = `http://snapshot.debian.org/archive/debian-security/${SNAPSHOT}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bullseye-repo-'));
const stubDir = path.join(tmpDir, 'bin');
fs.mkdirSync(stubDir, { recursive: true });
const writeExec = (file, body) => {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
};

// apt-get tiruan: --print-uris mencetak isi FAKE_URIS, sisanya hanya dicatat.
writeExec(path.join(stubDir, 'apt-get'), `#!/usr/bin/env bash
echo "apt-get $*" >> "\${FAKE_LOG}"
for a in "$@"; do
  if [[ "\${a}" == "--print-uris" ]]; then
    cat "\${FAKE_URIS}" 2>/dev/null
    exit 0
  fi
done
exit 0
`);

// curl tiruan: hanya menjawab kode HTTP, berbeda untuk snapshot dan mirror.
writeExec(path.join(stubDir, 'curl'), `#!/usr/bin/env bash
url="\${@: -1}"
echo "curl \${url}" >> "\${FAKE_LOG}"
case "\${url}" in
  *snapshot.debian.org*) printf '%s' "\${FAKE_SNAPSHOT_CODE:-200}" ;;
  *) printf '%s' "\${FAKE_POOL_CODE:-404}" ;;
esac
`);

const harnessPath = path.join(tmpDir, 'harness.sh');
fs.writeFileSync(harnessPath, `set -euo pipefail
export PATH='${B(stubDir)}':"$PATH"
log() { echo "LOG: $*"; }
${block}
rc=0
ensure_bullseye_security_repo "$@" || rc=$?
echo "RC=\${rc} OK=\${BULLSEYE_SECURITY_REPO_OK}"
`);

const OS_BULLSEYE = 'PRETTY_NAME="Debian GNU/Linux 11 (bullseye)"\nID=debian\nVERSION_ID="11"\nVERSION_CODENAME=bullseye\n';
const OS_BOOKWORM = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n';
const OS_UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\n';

const SOURCES_DEFAULT = [
  'deb http://deb.debian.org/debian bullseye main',
  'deb http://security.debian.org/debian-security bullseye-security main contrib',
  'deb-src http://security.debian.org/debian-security bullseye-security main contrib',
  'deb http://deb.debian.org/debian bullseye-updates main',
  ''
].join('\n');

// Format sama dengan keluaran "apt-get install --print-uris -qq".
const URIS_SECURITY = [
  "'http://deb.debian.org/debian/pool/main/s/screen/screen_4.8.0-6_amd64.deb' screen_4.8.0-6_amd64.deb 608000 MD5Sum:0",
  "'http://security.debian.org/debian-security/pool/updates/main/j/jq/jq_1.6-2.1%2bdeb11u3_amd64.deb' jq_1.6-2.1+deb11u3_amd64.deb 64000 MD5Sum:0",
  ''
].join('\n');
const URIS_MAIN_ONLY = "'http://deb.debian.org/debian/pool/main/s/screen/screen_4.8.0-6_amd64.deb' screen_4.8.0-6_amd64.deb 608000 MD5Sum:0\n";

let caseNo = 0;
function sandbox({ osRelease = OS_BULLSEYE, sources = SOURCES_DEFAULT, extraLists = {}, uris = URIS_SECURITY } = {}) {
  caseNo += 1;
  const dir = path.join(tmpDir, `case-${caseNo}`);
  const aptDir = path.join(dir, 'apt');
  fs.mkdirSync(path.join(aptDir, 'sources.list.d'), { recursive: true });
  fs.writeFileSync(path.join(aptDir, 'sources.list'), sources);
  for (const [name, body] of Object.entries(extraLists)) {
    fs.writeFileSync(path.join(aptDir, 'sources.list.d', name), body);
  }
  fs.writeFileSync(path.join(dir, 'os-release'), osRelease);
  fs.writeFileSync(path.join(dir, 'uris'), uris);
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(logFile, '');
  const snapshotList = path.join(aptDir, 'sources.list.d', 'sc-1forcr-bullseye-security.list');
  return {
    run(args, extraEnv = {}) {
      const r = spawnSync(bash, [B(harnessPath), ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          BULLSEYE_APT_DIR: B(aptDir),
          BULLSEYE_OS_RELEASE: B(path.join(dir, 'os-release')),
          FAKE_LOG: B(logFile),
          FAKE_URIS: B(path.join(dir, 'uris')),
          ...extraEnv
        }
      });
      assert.strictEqual(r.status, 0, `harness gagal:\n${r.stdout}\n${r.stderr}`);
      const m = (r.stdout || '').match(/RC=(\d+) OK=(\d+)/);
      assert(m, `keluaran harness tidak dikenali:\n${r.stdout}\n${r.stderr}`);
      return { rc: Number(m[1]), ok: Number(m[2]), stdout: r.stdout };
    },
    sources: () => fs.readFileSync(path.join(aptDir, 'sources.list'), 'utf8'),
    list: (name) => fs.readFileSync(path.join(aptDir, 'sources.list.d', name), 'utf8'),
    snapshotExists: () => fs.existsSync(snapshotList),
    snapshot: () => fs.readFileSync(snapshotList, 'utf8'),
    calls: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
  };
}

const PROBE = ['probe', 'install', '-y', 'screen', 'jq'];
const activeLines = (text) => text.split('\n').filter((l) => /^\s*deb(-src)?\s/.test(l));

// 1. Debian 11, file paket di mirror 404: repo dipindah ke snapshot.
{
  const sb = sandbox();
  const r = sb.run(PROBE);
  assert.strictEqual(r.rc, 0);
  assert(r.stdout.includes('LOG: Repo security Debian 11 dipindah ke'), r.stdout);
  assert.deepStrictEqual(activeLines(sb.sources()), [
    'deb http://deb.debian.org/debian bullseye main',
    'deb http://deb.debian.org/debian bullseye-updates main'
  ], 'hanya baris bullseye-security yang boleh dinonaktifkan');
  assert(sb.sources().includes('# sc-1forcr, repo ini sudah kosong: deb http://security.debian.org/debian-security bullseye-security main contrib\n'));
  assert(sb.sources().includes('# sc-1forcr, repo ini sudah kosong: deb-src http://security.debian.org/debian-security bullseye-security main contrib\n'));
  assert.deepStrictEqual(activeLines(sb.snapshot()), [
    `deb [check-valid-until=no] ${SNAPSHOT_URL} bullseye-security main contrib`
  ], 'komponen baris lama harus dipertahankan');
  const calls = sb.calls();
  assert(calls.some((c) => /^apt-get install --print-uris .* screen jq$/.test(c)), 'opsi apt tidak boleh ikut jadi nama paket');
  assert(calls.includes('curl http://security.debian.org/debian-security/pool/updates/main/j/jq/jq_1.6-2.1%2bdeb11u3_amd64.deb'),
    'yang diperiksa harus file dari repo security, bukan dari repo utama');
  assert(calls.includes(`curl ${SNAPSHOT_URL}/dists/bullseye-security/InRelease`));
  assert.strictEqual(calls.filter((c) => c === 'apt-get update -y').length, 1, 'daftar paket harus diambil ulang sekali');

  // Jalan ulang: tidak ada yang berubah dan tidak ada pemeriksaan jaringan lagi.
  const before = { sources: sb.sources(), snapshot: sb.snapshot(), calls: sb.calls().length };
  assert.strictEqual(sb.run(PROBE).rc, 0);
  assert.strictEqual(sb.run(['force']).rc, 0);
  assert.strictEqual(sb.sources(), before.sources);
  assert.strictEqual(sb.snapshot(), before.snapshot);
  assert.strictEqual(sb.calls().length, before.calls, 'setelah pindah, pemanggilan ulang harus tanpa apt/curl');
}

// 2. Mirror masih menyimpan filenya (mis. mirror provider): tidak diubah.
{
  const sb = sandbox();
  const r = sb.run(PROBE, { FAKE_POOL_CODE: '200' });
  assert.strictEqual(r.rc, 0);
  assert.strictEqual(r.ok, 1, 'mirror sehat harus diingat supaya tidak diperiksa berulang');
  assert.strictEqual(sb.sources(), SOURCES_DEFAULT);
  assert(!sb.snapshotExists());
}

// 3. Mirror tidak menjawab (bukan 404): tidak boleh dianggap rusak.
{
  const sb = sandbox();
  const r = sb.run(PROBE, { FAKE_POOL_CODE: '000' });
  assert.strictEqual(r.rc, 0);
  assert.strictEqual(r.ok, 0);
  assert.strictEqual(sb.sources(), SOURCES_DEFAULT);
  assert(!sb.snapshotExists());
}

// 4. Tidak ada file yang akan diunduh dari repo security: tidak diubah.
{
  const sb = sandbox({ uris: URIS_MAIN_ONLY });
  assert.strictEqual(sb.run(PROBE).rc, 0);
  assert.strictEqual(sb.sources(), SOURCES_DEFAULT);
  assert(!sb.snapshotExists());
  assert(!sb.calls().some((c) => c.startsWith('curl ')), 'file repo utama tidak perlu diperiksa');
}

// 5. Snapshot tidak terjangkau: sumber apt dibiarkan utuh dan gagal dilaporkan.
{
  const sb = sandbox();
  const r = sb.run(PROBE, { FAKE_SNAPSHOT_CODE: '000' });
  assert.strictEqual(r.rc, 1);
  assert(r.stdout.includes('snapshot.debian.org tidak terjangkau'), r.stdout);
  assert.strictEqual(sb.sources(), SOURCES_DEFAULT, 'repo lama tidak boleh dilepas tanpa pengganti');
  assert(!sb.snapshotExists());
  assert(!sb.calls().includes('apt-get update -y'));
}

// 6. Bukan Debian 11: tidak ada apa pun yang dijalankan.
for (const osRelease of [OS_BOOKWORM, OS_UBUNTU]) {
  const sb = sandbox({ osRelease });
  assert.strictEqual(sb.run(PROBE).rc, 0);
  assert.strictEqual(sb.run(['force']).rc, 0);
  assert.strictEqual(sb.sources(), SOURCES_DEFAULT);
  assert(!sb.snapshotExists());
  assert.deepStrictEqual(sb.calls(), []);
}

// 7. Mode force (dipakai setelah apt-get install gagal): pindah tanpa --print-uris.
{
  const sb = sandbox({ uris: '' });
  assert.strictEqual(sb.run(['force']).rc, 0);
  assert(sb.snapshotExists());
  assert(!sb.calls().some((c) => c.includes('--print-uris')));
  assert.deepStrictEqual(activeLines(sb.sources()).filter((l) => l.includes('bullseye-security')), []);
}

// 8. Variasi penulisan: opsi [..], garis miring di akhir, file di sources.list.d,
//    dan baris yang sudah menunjuk ke snapshot.
{
  const provider = [
    'deb [arch=amd64 signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://deb.debian.org/debian-security/ bullseye-security main non-free # keamanan',
    '  deb http://mirror.contoh.net/debian-security bullseye-security/ main',
    `deb [check-valid-until=no] ${SNAPSHOT_URL} bullseye-security main`,
    'deb http://mirror.contoh.net/debian bullseye main',
    ''
  ].join('\n');
  const sb = sandbox({
    sources: 'deb http://deb.debian.org/debian bullseye main\n# deb http://security.debian.org/debian-security bullseye-security main\n',
    extraLists: { 'provider.list': provider },
    uris: "'http://deb.debian.org/debian-security/pool/updates/main/g/glibc/libc6_2.31-13%2bdeb11u14_amd64.deb' libc6.deb 1 MD5Sum:0\n"
  });
  assert.strictEqual(sb.run(PROBE).rc, 0);
  assert(sb.calls().includes('curl http://deb.debian.org/debian-security/pool/updates/main/g/glibc/libc6_2.31-13%2bdeb11u14_amd64.deb'));
  assert.deepStrictEqual(activeLines(sb.list('provider.list')), [
    `deb [check-valid-until=no] ${SNAPSHOT_URL} bullseye-security main`,
    'deb http://mirror.contoh.net/debian bullseye main'
  ]);
  assert.strictEqual(sb.sources(), 'deb http://deb.debian.org/debian bullseye main\n# deb http://security.debian.org/debian-security bullseye-security main\n',
    'baris yang sudah dikomentari tidak boleh diberi awalan lagi');
  assert.deepStrictEqual(activeLines(sb.snapshot()), [
    `deb [check-valid-until=no] ${SNAPSHOT_URL} bullseye-security main non-free`
  ], 'komponen digabung dari semua baris lama, tanpa komentar di ujung baris');
}

// 9. Debian 11 tanpa baris security aktif: tidak menambah repo yang tidak diminta.
{
  const sb = sandbox({ sources: 'deb http://deb.debian.org/debian bullseye main\n' });
  assert.strictEqual(sb.run(PROBE).rc, 0);
  assert.strictEqual(sb.run(['force']).rc, 0);
  assert(!sb.snapshotExists());
  assert.deepStrictEqual(sb.calls(), []);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

// Pemanggil: semua apt-get install lewat apt_get_safe di kedua script, dan
// jalur gagal di installer memaksa pindah sebelum mengambil ulang daftar paket.
const APT_GET_SAFE = [
  'apt_get_safe() {',
  '  repair_dpkg_state || return 1',
  '  if [[ "${1:-}" == "install" ]]; then',
  '    ensure_bullseye_security_repo probe "$@" || true',
  '  fi',
  '  DEBIAN_FRONTEND=noninteractive apt-get "$@"',
  '}'
].join('\n');
assert(installer.includes(APT_GET_SAFE), 'apt_get_safe installer harus memeriksa repo Debian 11');
assert(summary.includes(APT_GET_SAFE), 'apt_get_safe setup-summary-api.sh harus memeriksa repo Debian 11');
assert(installer.includes('    ensure_bullseye_security_repo force || true\n    apt_refresh_lists_hard\n    if ! apt_get_safe install -y "${base_pkgs[@]}"; then'),
  'install_base_packages harus memaksa pindah repo sebelum mencoba ulang');
assert(installer.includes('apt_install_with_refresh() {\n  ensure_bullseye_security_repo probe "$@" || true\n'),
  'dependency lisensi dipasang sebelum install_base_packages, jadi harus ikut diperiksa');

// Perintah yang diketik pembeli sebelum installer jalan tidak boleh memicu
// upgrade paket (yang 404 di Debian 11) dan tidak memasang paket yang memang
// dipasang installer.
const botAptInstalls = [...bot.matchAll(/installCommandBlock\('(apt(?:-get)? install [^']*)'\)/g)].map((m) => m[1]);
assert.deepStrictEqual(botAptInstalls, ['apt install --no-upgrade curl wget screen ca-certificates -y'],
  'panduan install di bot hanya boleh punya satu perintah apt install, dengan --no-upgrade');
const readmeInstalls = readme.match(/apt-get install [^&]*/g) || [];
assert(readmeInstalls.length >= 3, 'perintah install di README tidak ditemukan');
for (const cmd of readmeInstalls) {
  assert(cmd.includes('--no-upgrade'), `perintah README tanpa --no-upgrade: ${cmd}`);
}

console.log('Bullseye security repo tests: OK');

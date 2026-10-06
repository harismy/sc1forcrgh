'use strict';

// Multi path Xray WS di mux SSH-WS (ssh_mux.go di installer).
//
// Selalu dijalankan: pemeriksaan statis. Go di VPS berasal dari paket distro,
// dan Ubuntu 20.04 masih memasang Go 1.13, jadi kode mux tidak boleh memakai
// API yang baru ada di Go 1.14 ke atas; kalau dipakai, build di VPS gagal.
//
// Kalau ada toolchain Go (GO_BIN atau `go` di PATH): kode mux diekstrak lalu
// diuji perilakunya lewat scripts/go/ssh_mux_multipath_test.go dengan backend
// Xray dan SSH tiruan (VMess/VLESS/Trojan dari path bebas, early data, SSH
// mentah, klien yang menunggu banner, real IP, dan Xray yang menolak).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return source.slice(start + startMarker.length, end);
}

const mux = extract(installer, "cat > \"${APP_DIR}/go/ssh_mux.go\" <<'EOF'\n", '\nEOF\n');

// API yang tidak ada di Go 1.13.
const tooNew = [
  [/\bos\.ReadFile\(/, 'os.ReadFile (Go 1.16), pakai ioutil.ReadFile'],
  [/\bos\.WriteFile\(/, 'os.WriteFile (Go 1.16), pakai ioutil.WriteFile'],
  [/\bos\.ReadDir\(/, 'os.ReadDir (Go 1.16)'],
  [/\bio\.ReadAll\(/, 'io.ReadAll (Go 1.16), pakai ioutil.ReadAll'],
  [/\bio\.Discard\b/, 'io.Discard (Go 1.16), pakai ioutil.Discard'],
  [/\bstrings\.Cut\(/, 'strings.Cut (Go 1.18)'],
  [/\bnet\.ErrClosed\b/, 'net.ErrClosed (Go 1.16)'],
  [/\berrors\.Join\(/, 'errors.Join (Go 1.20)'],
  [/\batomic\.(Int32|Int64|Uint32|Uint64|Bool|Pointer)\b/, 'tipe atomic (Go 1.19)'],
  [/\bany\b/, 'alias any (Go 1.18)'],
  [/func\s+\w+\s*\[/, 'generics (Go 1.18)'],
  [/\bmin\(|\bmax\(/, 'builtin min/max (Go 1.21)'],
  [/\bclear\(/, 'builtin clear (Go 1.21)'],
  [/\bslices\.|\bmaps\./, 'paket slices/maps (Go 1.21)'],
  [/time\.Now\(\)\.UnixMilli\(\)/, 'Time.UnixMilli (Go 1.17)']
];
for (const [re, label] of tooNew) {
  assert(!re.test(mux), `ssh_mux.go memakai ${label}; build di VPS Ubuntu 20.04 (Go 1.13) akan gagal`);
}

// Penyambungan: hook di cabang upgrade, inisialisasi di main, dan sakelar env.
assert(/if multipathEnabled \{\n\s+if wsKey := headerValue\(rawHeader, "sec-websocket-key"\); wsKey != "" \{\n\s+handleRealWebSocket\(/.test(mux),
  'cabang upgrade harus meneruskan klien WebSocket asli ke handleRealWebSocket');
assert(/\n\tinitMultipath\(\)\n\tln, err := net\.Listen/.test(mux), 'main harus memanggil initMultipath sebelum listen');
assert(mux.includes('envBool("XRAY_MULTIPATH_ENABLE", true)'), 'multi path bisa dimatikan lewat XRAY_MULTIPATH_ENABLE');
assert(/EnvironmentFile=\$\{APP_DIR\}\/\.env\nExecStart=\$\{APP_DIR\}\/bin\/ssh-mux/.test(installer), 'service mux membaca .env aplikasi');
assert(/cat > "\$\{APP_DIR\}\/\.env" <<EOF[\s\S]*?XRAY_MULTIPATH_ENABLE=\$\{XRAY_MULTIPATH_ENABLE\}[\s\S]*?\nEOF\n/.test(installer),
  'XRAY_MULTIPATH_ENABLE harus ditulis ke .env aplikasi yang dibaca mux');

// Detail akun hanya mengiklankan path bebas kalau mux yang sedang jalan sudah
// mendukungnya (penanda ditulis mux saat start; update aman tidak me-restart mux).
const marker = (mux.match(/envOr\("SSHWS_MULTIPATH_MARKER", "([^"]+)"\)/) || [])[1];
assert(marker, 'mux harus menulis penanda multi path');
assert(installer.includes(`const SSHWS_MULTIPATH_MARKER = '${marker}';`), 'api.js harus membaca penanda yang sama dengan mux');
assert.strictEqual(installer.split('any: xrayMultipathActive()').length - 1, 3, 'path VMess/VLESS/Trojan memakai status mux yang aktif');
assert(installer.includes(`elif [[ -f ${marker} ]]; then`), 'menu port tambahan menampilkan status multi path dari penanda yang sama');

// Port inbound Xray yang dipakai mux harus sama dengan inbound WS di config.
for (const [proto, port] of [['VMESS', 10001], ['VLESS', 10002], ['TROJAN', 10003]]) {
  assert(mux.includes(`envInt("XRAY_WS_${proto}_PORT", ${port})`), `port default mux ${proto} harus ${port}`);
  assert(new RegExp(`tag: '${proto.toLowerCase()}-ws', port: ${port}, listen: '127\\.0\\.0\\.1'`).test(installer),
    `inbound ${proto.toLowerCase()}-ws harus tetap di ${port}`);
}

// Klien Xray multi path tidak boleh kena limit koneksi SSH-WS di nginx.
assert.strictEqual(installer.split('map \\$http_sec_websocket_key \\$sc_sshws_limit_scope {').length - 1, 2,
  'pengecualian limit untuk klien WebSocket asli harus ada di kedua salinan config nginx');
assert(!/limit_(req|conn)_zone \\\$sc_sshws_limit_key /.test(installer), 'zona limit harus memakai $sc_sshws_limit_scope');

function findGo() {
  const candidates = [process.env.GO_BIN, 'go'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return '';
}

const go = findGo();
if (!go) {
  console.log('mux multipath static checks passed (uji perilaku dilewati: Go tidak tersedia, set GO_BIN untuk menjalankannya)');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mux-'));
try {
  fs.writeFileSync(path.join(tmp, 'ssh_mux.go'), `${mux}\n`);
  fs.copyFileSync(path.join(__dirname, 'go', 'ssh_mux_multipath_test.go'), path.join(tmp, 'ssh_mux_multipath_test.go'));
  const env = { ...process.env, GO111MODULE: 'off', GOFLAGS: '', GOCACHE: process.env.GOCACHE || path.join(tmp, 'cache') };
  const vet = spawnSync(go, ['vet', '.'], { cwd: tmp, encoding: 'utf8', env });
  assert.strictEqual(vet.status, 0, `go vet gagal:\n${vet.stdout}${vet.stderr}`);
  const test = spawnSync(go, ['test', '-count=1', '.'], { cwd: tmp, encoding: 'utf8', env, timeout: 120000 });
  assert.strictEqual(test.status, 0, `go test gagal:\n${test.stdout}${test.stderr}`);
  const linux = spawnSync(go, ['build', '-o', path.join(tmp, 'ssh-mux'), 'ssh_mux.go'], {
    cwd: tmp, encoding: 'utf8', env: { ...env, GOOS: 'linux', GOARCH: 'amd64' }
  });
  assert.strictEqual(linux.status, 0, `build linux/amd64 gagal:\n${linux.stderr}`);
  console.log(`mux multipath tests passed (${spawnSync(go, ['version'], { encoding: 'utf8' }).stdout.trim()})`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

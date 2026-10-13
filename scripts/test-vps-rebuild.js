'use strict';

// Test logika murni rebuild VPS (tanpa SSH/jaringan). Memastikan:
// - daftar OS hanya yang didukung installer SC (Debian 12+/Ubuntu 20.04+),
// - perintah reinstall dibentuk benar dan password dikutip aman,
// - parser os-release & pencocokan OS baru benar,
// - preflight menolak OpenVZ/LXC dan VPS tanpa curl/wget,
// - deteksi perubahan sidik jari host key benar.

const assert = require('assert');
const rebuild = require('../lib/vps-rebuild');

// --- Daftar OS ---
const keys = rebuild.REBUILD_OS_OPTIONS.map((o) => o.key);
assert.deepStrictEqual(
  keys,
  ['debian12', 'debian13', 'ubuntu2004', 'ubuntu2204', 'ubuntu2404'],
  'daftar OS rebuild harus pas dengan yang didukung SC'
);
for (const o of rebuild.REBUILD_OS_OPTIONS) {
  assert(o.label && o.id && o.verId && Array.isArray(o.args) && o.args.length >= 2, `opsi ${o.key} tidak lengkap`);
}
assert(!rebuild.getOsOption('debian11'), 'Debian 11 tidak boleh ditawarkan');
assert(rebuild.getOsOption('ubuntu2404'), 'Ubuntu 24.04 harus ada');

// --- shQuote ---
assert.strictEqual(rebuild.shQuote('abc'), "'abc'");
assert.strictEqual(rebuild.shQuote("a'b"), "'a'\\''b'", 'kutip tunggal harus di-escape');

// --- buildReinstallCommand ---
const cmd = rebuild.buildReinstallCommand({ osKey: 'debian12', password: "pa'ss word" });
assert(cmd.includes('bash reinstall.sh'), 'harus menjalankan reinstall.sh');
assert(cmd.includes("'debian' '12'"), 'argumen OS harus debian 12 terkutip');
assert(cmd.includes('--password '), 'harus pakai --password');
assert(cmd.includes("'pa'\\''ss word'"), 'password harus dikutip aman');
assert(/curl -fsSL/.test(cmd) && /wget -qO/.test(cmd), 'harus ada fallback curl/wget');
assert(cmd.includes('[ -s reinstall.sh ]'), 'harus cek skrip terunduh sebelum dijalankan');
assert(!cmd.includes('\n'), 'perintah harus satu baris');
// Tanpa --username skrip memanggil `read -p "Username: "` dan macet selamanya.
assert(cmd.includes('--username root'), 'harus pakai --username root (hindari prompt)');
assert(/<\/dev\/null$/.test(cmd), 'stdin harus /dev/null supaya prompt tak terduga tidak macet');
// reinstall.sh tidak reboot sendiri: reboot wajib dipicu terpisah.
assert(!/\breboot\b/.test(cmd), 'perintah reinstall tidak boleh memuat reboot');
assert(/systemctl reboot \|\| reboot/.test(rebuild.REBOOT_COMMAND), 'reboot dipicu setelah skrip sukses');
assert(/nohup .*&$/.test(rebuild.REBOOT_COMMAND), 'reboot harus di latar supaya exec langsung kembali');

// --- CANCEL_COMMAND: pola pkill tidak boleh cocok dengan shell-nya sendiri ---
const pkillPattern = /pkill -f '([^']+)'/.exec(rebuild.CANCEL_COMMAND)[1];
const pkillRe = new RegExp(pkillPattern);
assert(!pkillRe.test(rebuild.CANCEL_COMMAND), 'pkill tidak boleh membunuh shell pembatal sendiri');
assert(pkillRe.test(cmd), 'pkill harus cocok dengan shell yang menjalankan reinstall');
assert(pkillRe.test("bash reinstall.sh debian 12 --username root --password x"), 'pkill harus cocok dengan proses reinstall.sh');
assert(/bash reinstall\.sh reset/.test(rebuild.CANCEL_COMMAND), 'pembatalan harus menjalankan reset');

// --- scrubSecret: password tidak boleh bocor ke pesan/log ---
const leaked = 'After Install\nUsername: root\nPassword: s3cr3t!x\nSSH Port: 22\nerror s3cr3t!x';
const scrubbed = rebuild.scrubSecret(leaked, 's3cr3t!x');
assert(!scrubbed.includes('s3cr3t!x'), 'password harus disensor');
assert(scrubbed.includes('Password: ***'), 'baris Password disensor');
assert(!rebuild.scrubSecret('Password: lain123', '').includes('lain123'), 'baris Password disensor walau secret kosong');

// --- hostVerifier: ssh2 memanggil verify(ret) lagi kalau fungsi return nilai ---
{
  let calls = 0;
  let seen = '';
  const hv = rebuild.makeHostVerifier((fp) => { seen = fp; }, true);
  const ret = hv(Buffer.from('k'), () => { calls += 1; });
  assert.strictEqual(ret, undefined, 'hostVerifier async tidak boleh return nilai (verify jadi dobel)');
  assert.strictEqual(calls, 1, 'verify harus dipanggil tepat sekali');
  assert(seen.startsWith('SHA256:'), 'sidik jari direkam');
  assert.strictEqual(rebuild.makeHostVerifier(() => {}, false)(Buffer.from('k')), false, 'mode sync mengembalikan keputusan');
}

assert.throws(() => rebuild.buildReinstallCommand({ osKey: 'centos7', password: 'x' }), /tidak didukung/);
assert.throws(() => rebuild.buildReinstallCommand({ osKey: 'debian12', password: '' }), /password/);

const ubuntuCmd = rebuild.buildReinstallCommand({ osKey: 'ubuntu2404', password: 'secret' });
assert(ubuntuCmd.includes("'ubuntu' '24.04'"), 'ubuntu 24.04 terkutip');

// --ssh-port hanya kalau bukan 22, supaya OS baru tetap di port yang sama.
assert(!cmd.includes('--ssh-port'), 'port 22 (default) tidak perlu --ssh-port');
assert(!rebuild.buildReinstallCommand({ osKey: 'debian12', password: 'x', sshPort: 22 }).includes('--ssh-port'), 'port 22 eksplisit tetap tanpa --ssh-port');
const cmdPort = rebuild.buildReinstallCommand({ osKey: 'debian12', password: 'x', sshPort: 2222 });
assert(cmdPort.includes("--ssh-port '2222'"), 'port non-22 harus dioper ke --ssh-port');

// --- parseOsRelease ---
const deb = rebuild.parseOsRelease('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\n');
assert.deepStrictEqual(deb, { id: 'debian', versionId: '12' });
const ubu = rebuild.parseOsRelease("NAME='Ubuntu'\nID=ubuntu\nVERSION_ID=24.04\n");
assert.deepStrictEqual(ubu, { id: 'ubuntu', versionId: '24.04' });

// --- matchesTargetOs ---
assert(rebuild.matchesTargetOs('ID=debian\nVERSION_ID="12"', 'debian12'), 'debian 12 cocok');
assert(!rebuild.matchesTargetOs('ID=debian\nVERSION_ID="11"', 'debian12'), 'debian 11 tidak cocok target 12');
assert(rebuild.matchesTargetOs('ID=ubuntu\nVERSION_ID="24.04"', 'ubuntu2404'), 'ubuntu 24.04 cocok');
assert(!rebuild.matchesTargetOs('ID=ubuntu\nVERSION_ID="22.04"', 'ubuntu2404'), 'ubuntu 22.04 tidak cocok target 24.04');
// OS installer/transisi (mis. alpine) tidak boleh dianggap selesai.
assert(!rebuild.matchesTargetOs('ID=alpine\nVERSION_ID="3.20"', 'debian12'), 'alpine installer tidak cocok');

// --- preflight ---
const okPf = rebuild.parsePreflight('VIRT=kvm\nHAS_CURL=1\nHAS_WGET=0\n');
assert.deepStrictEqual(okPf, { virt: 'kvm', hasCurl: true, hasWget: false });
assert.strictEqual(rebuild.preflightProblem(okPf), null, 'KVM + curl harus lolos');
assert.strictEqual(rebuild.preflightProblem(rebuild.parsePreflight('VIRT=openvz\nHAS_CURL=1\nHAS_WGET=1')).reason, 'virt-unsupported');
assert.strictEqual(rebuild.preflightProblem(rebuild.parsePreflight('VIRT=lxc\nHAS_CURL=1')).reason, 'virt-unsupported');
assert.strictEqual(rebuild.preflightProblem(rebuild.parsePreflight('VIRT=kvm\nHAS_CURL=0\nHAS_WGET=0')).reason, 'no-downloader');
// OpenVZ lama tanpa systemd-detect-virt dikenali lewat /proc/vz.
assert.strictEqual(rebuild.preflightProblem(rebuild.parsePreflight('VIRT=unknown\nVZ=1\nHAS_CURL=1')).reason, 'virt-unsupported');

// --- fingerprint ---
const fpA = rebuild.fingerprintFromKey(Buffer.from('key-a'));
const fpB = rebuild.fingerprintFromKey(Buffer.from('key-b'));
assert(fpA.startsWith('SHA256:') && fpA !== fpB, 'sidik jari beda untuk key beda');
assert(rebuild.fingerprintChanged(fpA, fpB), 'host key berubah terdeteksi');
assert(!rebuild.fingerprintChanged(fpA, fpA), 'host key sama bukan perubahan');
assert(!rebuild.fingerprintChanged('', fpB), 'tanpa sidik jari lama bukan perubahan');

console.log('vps rebuild tests: OK');

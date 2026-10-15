'use strict';

// Port range UDP Custom (format host:1-65535@user:pass di HTTP Custom). Klien
// mengirim ke port acak di rentang itu, jadi DNAT 1:65535 -> port listen wajib
// ada selama backend UDP Custom aktif. Pernah jadi bug nyata: SC menghapus
// semua DNAT yang menuju port UDP Custom, termasuk DNAT yang dipasang binary
// udp-custom sendiri saat start, sehingga akun hanya bisa konek lewat port
// listen persis. Test ini menjaga:
// - helper udpcustom_port_range_rule sama persis di installer, bootfix, menu;
// - rule SC dipasang sekali (idempoten), pindah port membuang rule lama, dan
//   add tidak menyentuh rule binary, DNAT ZIVPN, maupun docker;
// - del (backend ZIVPN) membuang rule SC dan rule sisa binary saja; DNAT range
//   dan port tambahan ZIVPN tetap utuh;
// - tidak ada lagi jalur yang menghapus semua DNAT ke port tertentu;
// - backend UDP Custom memanggil add, backend ZIVPN memanggil del.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function extract(source, startMarker, endMarker, from = 0) {
  const start = source.indexOf(startMarker, from);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return source.slice(start, end + endMarker.length);
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
const toBashPath = (p) => (process.platform === 'win32'
  ? spawnSync(bash, ['-c', `cygpath -u '${p}'`], { encoding: 'utf8' }).stdout.trim()
  : p);

// --- Tiga salinan helper harus identik ------------------------------------
const bootfix = extract(installer, "cat > /usr/local/sbin/sc-1forcr-udp-bootfix <<'EOF'\n", '\nEOF\n');
const menuStart = installer.indexOf("<<'MENU_SCRIPT_EOF'");
const menu = extract(installer, "<<'MENU_SCRIPT_EOF'", '\nMENU_SCRIPT_EOF\n');
const helperOf = (source) => extract(source, 'udpcustom_port_range_rule() {', '\n}\n');
const helperInstaller = helperOf(installer);
assert(installer.indexOf('udpcustom_port_range_rule() {') < installer.indexOf(bootfix), 'installer copy must sit outside the bootfix heredoc');
assert(installer.indexOf('udpcustom_port_range_rule() {') < menuStart, 'installer copy must sit outside the menu heredoc');
assert.strictEqual(helperOf(bootfix), helperInstaller, 'bootfix copy of udpcustom_port_range_rule must match the installer');
assert.strictEqual(helperOf(menu), helperInstaller, 'menu copy of udpcustom_port_range_rule must match the installer');

// --- Tidak ada lagi penghapusan semua DNAT ke satu port -------------------
for (const [name, source] of [['installer', installer], ['bootfix', bootfix], ['menu', menu]]) {
  assert(!/"to::"\s*p/.test(source), `${name}: must not delete every DNAT that points to the UDP Custom port`);
}
assert(!installer.includes('fw_delete_udp_dnat_to_port_all'), 'fw_delete_udp_dnat_to_port_all must stay removed');
assert(!installer.includes('cleanup_udphc_dnat_for_port'), 'cleanup_udphc_dnat_for_port must stay removed');

// --- Pemanggil per backend --------------------------------------------------
const setupNat = extract(installer, 'setup_udpcustom_udp_nat_rules() {', '\n}\n');
assert(setupNat.includes('udpcustom_port_range_rule add "${listen_port}"'), 'setup_udpcustom_udp_nat_rules must add the port range rule');
const enforce = extract(installer, 'enforce_single_udp_backend() {', '\n}\n');
const enforceZivpn = enforce.slice(enforce.indexOf('zivpn|*)'));
assert(enforceZivpn.includes('udpcustom_port_range_rule del'), 'ZIVPN backend must drop the UDP Custom port range rule');
const bootfixCase = bootfix.slice(bootfix.indexOf('case "${ACTIVE_UDP_BACKEND}" in'));
const bootfixDefault = bootfixCase.indexOf('\n  *)');
assert(bootfixCase.slice(0, bootfixDefault).includes('udpcustom_port_range_rule add "${udphc_port}"'), 'bootfix UDP Custom branch must add the rule');
assert(bootfixCase.slice(bootfixDefault).includes('udpcustom_port_range_rule del'), 'bootfix ZIVPN branch must drop the rule');
assert(extract(menu, 'switch_udp_to_udpcustom() {', '\n}\n').includes('udpcustom_port_range_rule add "${udphc_port}"'), 'menu switch to UDP Custom must add the rule');
assert(extract(menu, 'switch_udp_to_zivpn() {', '\n}\n').includes('udpcustom_port_range_rule del'), 'menu switch to ZIVPN must drop the rule');

// --- Perilaku dengan iptables tiruan ---------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-udpc-range-'));
try {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  // Hanya tabel nat PREROUTING; aturan disimpan persis seperti keluaran -S.
  fs.writeFileSync(path.join(bin, 'iptables'), `#!/usr/bin/env bash
st="\${FAKE_DIR}/nat"
touch "\${st}"
table=filter
args=()
while (( $# )); do
  case "$1" in
    -w) shift 2 ;;
    -t) table="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
[[ "\${table}" == "nat" ]] || exit 0
op="\${args[0]}"; chain="\${args[1]:-}"
line="-A \${chain} \${args[*]:2}"
case "\${op}" in
  -S) echo "-P PREROUTING ACCEPT"; cat "\${st}" ;;
  -C) tr -d '"' < "\${st}" | grep -qxF -- "\${line}" ;;
  -A) echo "A \${line}" >> "\${FAKE_DIR}/writes"; echo "\${line}" >> "\${st}" ;;
  -D)
    n="$(tr -d '"' < "\${st}" | grep -nxF -- "\${line}" | head -n1 | cut -d: -f1)"
    [[ -n "\${n}" ]] || exit 1
    echo "D \${line}" >> "\${FAKE_DIR}/writes"
    sed -i "\${n}d" "\${st}"
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  const helperPath = path.join(tmp, 'helper.sh');
  fs.writeFileSync(helperPath, `${helperInstaller}\n`);

  const binaryRule = '-A PREROUTING -i eth0 -p udp -m udp --dport 1:65535 -j DNAT --to-destination :5667';
  const dockerRule = '-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER';
  const scRule = (port) => `-A PREROUTING -p udp -m udp --dport 1:65535 -m addrtype --dst-type LOCAL -m comment --comment sc-udpcustom-range -j DNAT --to-destination :${port}`;
  const natFile = path.join(tmp, 'nat');
  const writesFile = path.join(tmp, 'writes');
  const readNat = () => fs.readFileSync(natFile, 'utf8').split('\n').filter(Boolean);
  const readWrites = () => (fs.existsSync(writesFile) ? fs.readFileSync(writesFile, 'utf8').split('\n').filter(Boolean) : []);

  const run = (args, { withIptables = true } = {}) => {
    fs.rmSync(writesFile, { force: true });
    const pathPrefix = withIptables ? `${toBashPath(bin)}:` : '';
    const res = spawnSync(bash, ['-c', `set -euo pipefail; PATH="${pathPrefix}/usr/bin:/bin"; source '${toBashPath(helperPath)}'; udpcustom_port_range_rule ${args}; echo done`], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_DIR: toBashPath(tmp) }
    });
    assert.strictEqual(res.status, 0, `udpcustom_port_range_rule ${args} failed: ${res.stderr}`);
    assert(res.stdout.includes('done'), `udpcustom_port_range_rule ${args} must not abort under set -e`);
    return readWrites();
  };

  // DNAT milik ZIVPN (range default dan port tambahan 553, tanpa -i) dan rule
  // lain yang mirip tidak boleh pernah tersentuh, di add maupun del.
  const zivpnRange = '-A PREROUTING -p udp -m udp --dport 6000:19999 -j DNAT --to-destination :5667';
  const zivpnExtra = '-A PREROUTING -p udp -m udp --dport 553 -j DNAT --to-destination :5667';
  const ownerRule = '-A PREROUTING -i eth0 -p udp -m udp --dport 1:65535 -j DNAT --to-destination 10.0.0.2:5667 --random';
  const untouched = [zivpnRange, zivpnExtra, dockerRule];

  fs.writeFileSync(natFile, `${zivpnRange}\n${zivpnExtra}\n${dockerRule}\n${binaryRule}\n`);

  run('add 5667');
  assert.deepStrictEqual(readNat(), [...untouched, binaryRule, scRule(5667)], 'add must append the SC rule after existing DNAT and keep the binary rule');

  assert.deepStrictEqual(run('add 5667'), [], 'second add must not touch iptables');
  assert.deepStrictEqual(readNat(), [...untouched, binaryRule, scRule(5667)], 'add must be idempotent');

  run('add 7000');
  assert.deepStrictEqual(readNat(), [...untouched, binaryRule, scRule(7000)], 'port change must replace the old SC rule only');

  // Backend ZIVPN: rule SC dan rule sisa binary (binary tidak membuangnya saat
  // mati) dibuang, DNAT ZIVPN tetap.
  run('del');
  assert.deepStrictEqual(readNat(), untouched, 'del must remove the SC rule and the stale udp-custom rule, nothing else');
  assert.deepStrictEqual(run('del'), [], 'del on a clean ZIVPN table must not touch iptables');

  fs.writeFileSync(natFile, `${zivpnRange}\n${ownerRule}\n${binaryRule.replace(':5667', '0.0.0.0:5667')}\n`);
  run('del');
  assert.deepStrictEqual(readNat(), [zivpnRange, ownerRule], 'del must drop the binary rule with an address but keep rules of another shape');

  fs.writeFileSync(natFile, `${scRule(5667).replace('sc-udpcustom-range', '"sc-udpcustom-range"')}\n${zivpnRange}\n`);
  run('del');
  assert.deepStrictEqual(readNat(), [zivpnRange], 'del must also remove the SC rule when iptables prints the comment quoted');

  fs.writeFileSync(natFile, `${scRule(5667)}\n${scRule(5667)}\n${binaryRule}\n`);
  run('add 5667');
  assert.deepStrictEqual(readNat(), [scRule(5667), scRule(5667), binaryRule], 'add must not delete a rule that already matches');

  run('add abc');
  assert.deepStrictEqual(readNat(), [binaryRule], 'invalid port must clear SC rules without adding a broken one');

  fs.writeFileSync(natFile, `${binaryRule}\n`);
  assert.deepStrictEqual(run('add 5667', { withIptables: false }), [], 'without iptables the helper must be a no-op');
  assert.deepStrictEqual(readNat(), [binaryRule]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('udpcustom port range: ok');

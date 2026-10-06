'use strict';

// Port TLS/NTLS tambahan (sc-1forcr-extra-ports). Aturan REDIRECT harus:
// - melewati port SC sendiri, port sshd, dan port yang dipakai program lain di
//   alamat publik, tapi tetap memakai port yang hanya dipakai di 127.0.0.1;
// - hanya menulis ulang iptables (dan netfilter-persistent) kalau berbeda,
//   karena dipanggil watchdog tiap 5 menit;
// - memasang IPv6 hanya untuk target yang memang listen di IPv6;
// - bersih total saat dimatikan atau di-uninstall.

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

const script = extract(installer, "cat > /usr/local/sbin/sc-1forcr-extra-ports <<'EXTRA_PORTS_EOF'\n", '\nEXTRA_PORTS_EOF\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-extra-ports-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const scriptPath = path.join(tmp, 'sc-1forcr-extra-ports');
fs.writeFileSync(scriptPath, `${script}\n`);

// iptables tiruan: aturan nat disimpan per keluarga alamat di file teks.
fs.writeFileSync(path.join(bin, 'fakeipt'), `#!/usr/bin/env bash
fam="\${FAKE_FAMILY:-4}"
st="\${FAKE_DIR}/rules\${fam}"
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
op="\${args[0]}"; chain="\${args[1]:-}"; rest=("\${args[@]:2}")
spec="\${rest[*]}"
[[ "\${table}" == "nat" ]] || exit 0
[[ -f "\${FAKE_DIR}/no-nat\${fam}" ]] && exit 1
if [[ -f "\${FAKE_DIR}/no-addrtype" && " \${spec} " == *" addrtype "* ]]; then exit 1; fi
case "\${op}" in -A|-I|-F|-N|-X) echo "\${fam} \${op} \${chain} \${spec}" >> "\${FAKE_DIR}/writes" ;; esac
case "\${op}" in
  -S)
    if [[ "\${chain}" == "PREROUTING" ]]; then
      echo "-P PREROUTING ACCEPT"
      grep '^PREROUTING ' "\${st}" | sed 's/^PREROUTING /-A PREROUTING /'
      exit 0
    fi
    grep -qx "N \${chain}" "\${st}" || exit 1
    echo "-N \${chain}"
    grep "^\${chain} " "\${st}" | sed "s/^\${chain} /-A \${chain} /"
    ;;
  -N) grep -qx "N \${chain}" "\${st}" && exit 1; echo "N \${chain}" >> "\${st}" ;;
  -F) grep -v "^\${chain} " "\${st}" > "\${st}.n"; mv "\${st}.n" "\${st}" ;;
  -X)
    grep -q -- "-j \${chain}\$" "\${st}" && exit 1
    grep -vx "N \${chain}" "\${st}" > "\${st}.n"; mv "\${st}.n" "\${st}" ;;
  -A) echo "\${chain} \${spec}" >> "\${st}" ;;
  -I) printf '%s\\n' "\${chain} \${rest[*]:1}" | cat - "\${st}" > "\${st}.n"; mv "\${st}.n" "\${st}" ;;
  -C) grep -qxF "\${chain} \${spec}" "\${st}"; exit $? ;;
  -D)
    line="$(grep -nxF "\${chain} \${spec}" "\${st}" | head -n1 | cut -d: -f1)"
    [[ -n "\${line}" ]] || exit 1
    echo "\${fam} -D \${chain} \${spec}" >> "\${FAKE_DIR}/writes"
    sed "\${line}d" "\${st}" > "\${st}.n"; mv "\${st}.n" "\${st}" ;;
esac
exit 0
`);
fs.writeFileSync(path.join(bin, 'iptables'), '#!/usr/bin/env bash\nFAKE_FAMILY=4 exec fakeipt "$@"\n');
fs.writeFileSync(path.join(bin, 'ip6tables'), '#!/usr/bin/env bash\nFAKE_FAMILY=6 exec fakeipt "$@"\n');
fs.writeFileSync(path.join(bin, 'ss'), '#!/usr/bin/env bash\ncat "${FAKE_DIR}/listen"\n');
fs.writeFileSync(path.join(bin, 'netfilter-persistent'), '#!/usr/bin/env bash\necho save >> "${FAKE_DIR}/persist"\n');
for (const f of ['fakeipt', 'iptables', 'ip6tables', 'ss', 'netfilter-persistent']) fs.chmodSync(path.join(bin, f), 0o755);

const listenBase = [
  'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=10,fd=6))',
  'LISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=10,fd=7))',
  'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("haproxy",pid=11,fd=7))',
  'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=12,fd=3))',
  'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:* users:(("sshd",pid=12,fd=4))',
  'LISTEN 0 20 0.0.0.0:109 0.0.0.0:* users:(("dropbear",pid=13,fd=3))',
  'LISTEN 0 20 0.0.0.0:143 0.0.0.0:* users:(("dropbear",pid=14,fd=3))',
  'LISTEN 0 4096 127.0.0.1:2082 0.0.0.0:* users:(("ssh-mux",pid=15,fd=3))',
  'LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("nginx",pid=10,fd=9))',
  'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=16,fd=14))',
  'LISTEN 0 4096 *:2053 *:* users:(("x-ui",pid=17,fd=8))'
];

const envFile = path.join(tmp, 'sc.env');
const stateFile = path.join(tmp, 'extra-ports.state');
const reset = () => {
  for (const f of ['rules4', 'rules6', 'writes', 'persist', 'no-addrtype', 'no-nat6']) fs.rmSync(path.join(tmp, f), { force: true });
  fs.rmSync(stateFile, { force: true });
};
const setListen = (lines) => fs.writeFileSync(path.join(tmp, 'listen'), `${lines.join('\n')}\n`);
const setEnv = (text) => fs.writeFileSync(envFile, text);
const run = (cmd) => {
  fs.rmSync(path.join(tmp, 'writes'), { force: true });
  fs.rmSync(path.join(tmp, 'persist'), { force: true });
  const r = spawnSync(bash, [toBashPath(scriptPath), cmd], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${toBashPath(bin)}:${process.env.PATH}`,
      FAKE_DIR: toBashPath(tmp),
      SC_ENV_FILE: toBashPath(envFile),
      EXTRA_PORTS_STATE_FILE: toBashPath(stateFile),
      EXTRA_PORTS_LOCK_FILE: toBashPath(path.join(tmp, 'lock')),
      // Variabel dari lingkungan penguji tidak boleh ikut terbaca.
      EXTRA_TLS_PORTS: '',
      EXTRA_NTLS_PORTS: '',
      DROPBEAR_PORT: '',
      DROPBEAR_ALT_PORT: ''
    }
  });
  assert.strictEqual(r.status, 0, `${cmd} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const read = (f) => (fs.existsSync(path.join(tmp, f)) ? fs.readFileSync(path.join(tmp, f), 'utf8') : '');
const rules = (fam) => read(`rules${fam}`).split('\n').filter(Boolean);
const pairs = (fam) => rules(fam).filter((l) => l.startsWith('SC1FORCR_PORTS '))
  .map((l) => `${l.match(/--dport (\d+)/)[1]}>${l.match(/--to-ports (\d+)/)[1]}`);
const state = () => Object.fromEntries(fs.readFileSync(stateFile, 'utf8').trim().split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));

try {
  // 1. Bawaan: x-ui di *:2053 dilewati; 2082/8080 yang hanya di 127.0.0.1 tetap dipakai.
  reset();
  setListen(listenBase);
  setEnv('DOMAIN=vpn.example.com\n');
  run('apply');
  assert.deepStrictEqual(pairs(4), ['8443>443', '2083>443', '2087>443', '2096>443',
    '8080>80', '8880>80', '2052>80', '2082>80', '2086>80', '2095>80'], 'default IPv4 redirect set');
  assert.strictEqual(rules(4).filter((l) => l.startsWith("PREROUTING "))[0], 'PREROUTING -p tcp -m addrtype --dst-type LOCAL -j SC1FORCR_PORTS',
    'jump must be first in PREROUTING and only for traffic addressed to this VPS');
  assert.deepStrictEqual(pairs(6), ['8080>80', '8880>80', '2052>80', '2082>80', '2086>80', '2095>80'],
    'IPv6 only for targets that listen on IPv6 (nginx [::]:80; HAProxy 443 is IPv4 only)');
  let st = state();
  assert.strictEqual(st.TLS_ACTIVE, '8443,2083,2087,2096');
  assert.strictEqual(st.NTLS_ACTIVE, '8080,8880,2052,2082,2086,2095');
  assert.strictEqual(st.SKIPPED, '2053:x-ui', 'a port used by another program must be skipped with its name');
  assert.strictEqual(st.IPV6_TARGETS, '80');
  assert.strictEqual(read('persist').trim(), 'save', 'changed rules must be persisted once');

  // 2. Siklus watchdog tanpa perubahan: tidak ada tulis iptables dan tidak ada save.
  run('apply');
  assert.strictEqual(read('writes'), '', `an unchanged apply must not touch iptables:\n${read('writes')}`);
  assert.strictEqual(read('persist'), '', 'an unchanged apply must not save rules');

  // 3. Program lain belakangan memakai 8880: port itu dilepas.
  setListen([...listenBase, 'LISTEN 0 511 0.0.0.0:8880 0.0.0.0:* users:(("apache2",pid=20,fd=4))']);
  run('apply');
  assert(!pairs(4).includes('8880>80') && !pairs(6).includes('8880>80'), 'a port taken later must be released');
  assert.strictEqual(state().SKIPPED, '2053:x-ui,8880:apache2');
  assert.strictEqual(rules(4).filter((l) => l.startsWith('PREROUTING ')).length, 1, 'only one jump rule');

  // 4. Daftar custom: port SC, sshd, duplikat, dan nilai tidak valid diabaikan.
  setListen(listenBase);
  setEnv('EXTRA_TLS_PORTS="443, 2222,8443 8443;09443,abc,70000"\nEXTRA_NTLS_PORTS=80,109,8443,2095\nDROPBEAR_PORT=109\n');
  run('apply');
  assert.deepStrictEqual(pairs(4), ['8443>443', '9443>443', '2095>80'], 'custom lists are cleaned');
  assert.strictEqual(state().SKIPPED, '443:port-sc,2222:port-sc,80:port-sc,109:port-sc,8443:ganda');

  // 5. Status untuk menu.
  const status = run('status');
  assert(status.includes('TLS tambahan  : 8443,9443') && status.includes('NTLS tambahan : 2095'), `status:\n${status}`);

  // 6. Dimatikan: chain dan jump hilang di IPv4 dan IPv6.
  setEnv('EXTRA_TLS_PORTS=off\nEXTRA_NTLS_PORTS=OFF\n');
  run('apply');
  assert.deepStrictEqual(rules(4), [], `IPv4 must be clean when off:\n${read('rules4')}`);
  assert.deepStrictEqual(rules(6), [], `IPv6 must be clean when off:\n${read('rules6')}`);
  run('apply');
  assert.strictEqual(read('writes'), '', 'apply while off must not touch iptables');

  // 7. Kernel tanpa modul addrtype: jump biasa, dan stabil di siklus berikutnya.
  reset();
  setListen(listenBase);
  setEnv('');
  fs.writeFileSync(path.join(tmp, 'no-addrtype'), '');
  run('apply');
  assert.strictEqual(rules(4).filter((l) => l.startsWith("PREROUTING "))[0], 'PREROUTING -p tcp -j SC1FORCR_PORTS', 'fallback jump without addrtype');
  run('apply');
  assert.strictEqual(read('writes'), '', 'the fallback jump must not be rewritten every cycle');
  assert.strictEqual(read('persist'), '');

  // 8. IPv6 tanpa tabel nat: IPv4 tetap jalan.
  reset();
  setListen(listenBase);
  fs.writeFileSync(path.join(tmp, 'no-nat6'), '');
  run('apply');
  assert.strictEqual(pairs(4).length, 10, 'IPv4 still applied when ip6tables nat is unavailable');

  // 9. Uninstall: semua aturan dan state hilang.
  fs.rmSync(path.join(tmp, 'no-nat6'));
  run('apply');
  run('clear');
  assert.deepStrictEqual(rules(4), []);
  assert.deepStrictEqual(rules(6), []);
  assert(!fs.existsSync(stateFile), 'clear must remove the state file');

  // Penyambungan di installer: manager dipasang, diterapkan di kedua jalur
  // main(), diulang watchdog, dibersihkan uninstall, dan setting bertahan.
  assert(/run_install_step "38c_extra_ports" 99 "[^"]+" apply_extra_ports/.test(installer), 'install path applies extra ports');
  assert(/apply_service_gates\n    apply_extra_ports\n/.test(installer), 'update path applies extra ports');
  assert(installer.includes('/usr/local/sbin/sc-1forcr-extra-ports apply >/dev/null 2>&1 || \\\n    log_health'), 'watchdog re-applies extra ports');
  assert(installer.includes('/usr/local/sbin/sc-1forcr-extra-ports clear'), 'uninstall clears extra ports');
  for (const key of ['EXTRA_TLS_PORTS', 'EXTRA_NTLS_PORTS', 'XRAY_MULTIPATH_ENABLE']) {
    assert.strictEqual(installer.split(`${key}=\${${key}}\n`).length - 1, 2, `${key} must be in both env dumps`);
    assert.strictEqual(installer.split(`    "${key}",\n`).length - 1, 2, `${key} must be in both backup setting lists`);
    assert(new RegExp(`vars=\\([\\s\\S]*\\b${key}\\b[\\s\\S]*?\\n  \\)`).test(installer), `${key} must survive a pending install`);
  }

  console.log('extra ports tests passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

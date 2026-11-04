'use strict';

// SlowDNS (sc-1forcr-slowdns, dnstt-server). Yang dijaga:
// - mati secara default dan watchdog tidak menyentuh iptables sama sekali;
// - setup memasang kunci, unit (MemoryMax, user sendiri), REDIRECT UDP 53 ->
//   port dnstt dengan jump di depan semua rule non-TCP (DNAT 1:65535 UDP
//   Custom ikut menelan port 53), lalu idempoten: tanpa perubahan tidak ada
//   daemon-reload, restart, atau penulisan iptables;
// - apply (watchdog) tidak pernah memanggil systemctl untuk mengubah apa pun;
// - enable dengan input salah atau setup gagal mengembalikan pengaturan lama;
// - disable melepas aturan tapi menyimpan kunci (pubkey pengguna tetap);
// - API hanya mengirim data.slowdns saat aktif dan layanan SSH ON;
// - SSH OFF di gerbang ON/OFF ikut menutup port SlowDNS;
// - urutan di install/update/watchdog: SlowDNS sebelum gerbang ON/OFF.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

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

const bash = resolveBash();
const toBashPath = (p) => (process.platform === 'win32'
  ? spawnSync(bash, ['-c', `cygpath -u '${p}'`], { encoding: 'utf8' }).stdout.trim()
  : p);

const helper = extract(installer, "cat > /usr/local/sbin/sc-1forcr-slowdns <<'SLOWDNS_EOF'\n", '\nSLOWDNS_EOF\n');
const DNSTT_VERSION = (helper.match(/^DNSTT_VERSION="([^"]+)"/m) || [])[1];
const DNSTT_PATCH_ID = (helper.match(/^DNSTT_PATCH_ID="([^"]+)"/m) || [])[1];
const DNSTT_ZIP_SHA256 = (helper.match(/^DNSTT_ZIP_SHA256="([0-9a-f]{64})"/m) || [])[1];
assert(DNSTT_VERSION && DNSTT_PATCH_ID && DNSTT_ZIP_SHA256, 'DNSTT_VERSION, DNSTT_PATCH_ID, dan DNSTT_ZIP_SHA256 dipin di helper');

// ── Isi statis ──────────────────────────────────────────────────────────────
assert(/^GO_SHA256_AMD64="[0-9a-f]{64}"$/m.test(helper) && /^GO_SHA256_ARM64="[0-9a-f]{64}"$/m.test(helper),
  'checksum toolchain Go dipin untuk amd64 dan arm64');
assert(helper.includes('GOTOOLCHAIN=local') && helper.includes('GOSUMDB=sum.golang.org'),
  'build tidak boleh mengunduh toolchain lain diam-diam dan wajib verifikasi sumdb');
assert(helper.includes('GOFLAGS="-modcacherw -p=1" GOMAXPROCS=1') && helper.includes('nice -n 10'),
  'build menahan RAM/CPU supaya tunnel tetap lancar di VPS 1 vCPU');
assert(helper.includes('BUILD_ROOT="${SLOWDNS_BUILD_ROOT:-/var/tmp}"'),
  'build di /var/tmp (disk), bukan /tmp yang bisa tmpfs di VPS 1 GB');
assert(/rm -rf "\$\{work\}"\n  return "\$\{rc\}"/.test(helper), 'folder build selalu dihapus');
assert(helper.includes('SLOWDNS_BIN_SHA256 (64 hex) wajib diisi'), 'binary dari URL wajib checksum');

// ── Build dari source yang di-patch (bukan go install upstream) ──────────────
const buildFn = extract(helper, '\nbuild_binary() {', '\n  return "${rc}"\n}\n');
assert(buildFn.includes('${DNSTT_MODULE}/@v/${DNSTT_VERSION}.zip') && buildFn.includes('${DNSTT_ZIP_SHA256}'),
  'build mengunduh zip source yang dipin dan memverifikasi checksum-nya');
assert(!buildFn.includes('go install') && /go_bin.*build -trimpath.*dnstt-server|build -trimpath[\s\S]*\.\/dnstt-server/.test(buildFn),
  'build memakai go build atas source yang sudah dipatch, bukan go install upstream');
assert(buildFn.includes('${DNSTT_VERSION}+${DNSTT_PATCH_ID}'), 'identitas binary menyertakan penanda patch');
const patchPy = extract(buildFn, "<<'SLOWDNS_PATCH_PY'\n", '\nSLOWDNS_PATCH_PY\n');
assert(patchPy.includes('rrTypeNULL = 10') && patchPy.includes('question.Type != rrTypeNULL'),
  'patch menambah dukungan record NULL');
assert(patchPy.includes('maxPayloadForResponse') && patchPy.includes('requesterPayloadSize') && patchPy.includes('_ = payloadSize'),
  'patch: ukuran jawaban per-query + buang FORMERR minimum');
assert(patchPy.includes('nodelay on (fast flush)') && patchPy.includes("const QueueSize = 8192"),
  'patch: KCP mode cepat + window besar');
assert(patchPy.includes('clientEdnsRecord') && patchPy.includes('func kcpWindow()') &&
  patchPy.includes('session %08x edns %d mtu %d win %d') && patchPy.includes('mtuCeil'),
  'patch sc-fast2: MTU KCP per sesi (sesuai buffer EDNS tiap klien)');
assert(patchPy.includes('os.Getenv') && patchPy.includes('SLOWDNS_KCP_WINDOW'),
  'patch sc-fast2: window KCP tunable lewat env SLOWDNS_KCP_WINDOW');
assert(/if \(\( MTU == 512 \)\); then MTU=1232; fi/.test(helper),
  'helper menaikkan SLOWDNS_MTU lama 512 ke 1232 (hindari choke app buffer besar)');
assert(/^kcp_window\(\) \{/m.test(helper) && helper.includes('Environment=SLOWDNS_KCP_WINDOW=$(kcp_window)'),
  'unit SlowDNS menyetel SLOWDNS_KCP_WINDOW per tier lewat kcp_window()');
assert(/wanted_binary_id\(\)[\s\S]*\$\{DNSTT_VERSION\}\+%s|printf '%s\+%s' "\$\{DNSTT_VERSION\}" "\$\{DNSTT_PATCH_ID\}"/.test(helper),
  'wanted_binary_id memakai versi+patch sehingga VPS lama rebuild');
const applyFn = extract(helper, '\ncmd_apply() {', '\n}\n');
assert(!/systemctl\s+(restart|start|stop|enable|disable|daemon-reload)/.test(applyFn) &&
  !/cmd_setup|ensure_binary/.test(applyFn), 'apply (watchdog) tidak boleh mengubah systemd atau build');

// ── Lingkungan tiruan ───────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slowdns-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const scriptPath = path.join(tmp, 'sc-1forcr-slowdns');
fs.writeFileSync(scriptPath, `${helper}\n`);

// Tiruan ditulis dengan builtin bash saja: di Git Bash Windows setiap proses
// eksternal (grep/sed/mv) mahal, dan helper memanggil iptables puluhan kali.
const fakeIptables = `#!/usr/bin/env bash
case "\${0##*/}" in ip6tables) fam=6 ;; *) fam=4 ;; esac
printf '%s\\n' "\${fam} $*" >> "\${FAKE_DIR}/ipt-calls"
table=filter
args=()
while (( $# )); do
  case "$1" in
    -w) shift 2 ;;
    -t) table="$2"; shift 2 ;;
    -n|-v|-x) shift ;;
    *) args+=("$1"); shift ;;
  esac
done
st="\${FAKE_DIR}/rules\${fam}.\${table}"
lines=()
if [[ -f "\${st}" ]]; then mapfile -t lines < "\${st}"; fi
op="\${args[0]}"; chain="\${args[1]:-}"; rest=("\${args[@]:2}")
if [[ "\${op}" == "-I" && "\${rest[0]:-}" =~ ^[0-9]+$ ]]; then rest=("\${rest[@]:1}"); fi
spec="\${rest[*]}"
[[ "\${table}" == "nat" && -f "\${FAKE_DIR}/no-nat\${fam}" ]] && exit 1
if [[ -f "\${FAKE_DIR}/no-addrtype" && " \${spec} " == *" addrtype "* ]]; then exit 1; fi
builtin_chain() { [[ "$1" == PREROUTING || "$1" == INPUT || "$1" == OUTPUT ]]; }
has_chain() { local l; for l in "\${lines[@]}"; do [[ "\${l}" == "N $1" ]] && return 0; done; return 1; }
save() { if (( \${#lines[@]} )); then printf '%s\\n' "\${lines[@]}" > "\${st}"; else : > "\${st}"; fi; }
case "\${op}" in -A|-I|-F|-N|-X) printf '%s\\n' "\${fam} \${table} \${op} \${chain} \${spec}" >> "\${FAKE_DIR}/writes" ;; esac
case "\${op}" in
  -S)
    if builtin_chain "\${chain}"; then echo "-P \${chain} ACCEPT"; else has_chain "\${chain}" || exit 1; echo "-N \${chain}"; fi
    for l in "\${lines[@]}"; do [[ "\${l}" == "\${chain} "* ]] && echo "-A \${l}"; done
    ;;
  -L)
    has_chain "\${chain}" || exit 1
    echo "Chain \${chain} (1 references)"
    echo "    pkts      bytes target     prot opt in     out     source               destination"
    c=0
    [[ -f "\${FAKE_DIR}/counter" ]] && read -r c < "\${FAKE_DIR}/counter"
    for l in "\${lines[@]}"; do
      [[ "\${l}" == "\${chain} "* ]] || continue
      t="\${l##*-j }"; t="\${t%% *}"
      echo "       \${c}        0 \${t}   udp  --  *      *       0.0.0.0/0            0.0.0.0/0"
    done
    ;;
  -N) has_chain "\${chain}" && exit 1; lines+=("N \${chain}"); save ;;
  -F) new=(); for l in "\${lines[@]}"; do [[ "\${l}" == "\${chain} "* ]] || new+=("\${l}"); done; lines=("\${new[@]}"); save ;;
  -X)
    new=()
    for l in "\${lines[@]}"; do
      [[ "\${l}" == *"-j \${chain}" ]] && exit 1
      [[ "\${l}" == "N \${chain}" ]] || new+=("\${l}")
    done
    lines=("\${new[@]}"); save ;;
  -A) builtin_chain "\${chain}" || has_chain "\${chain}" || exit 1; lines+=("\${chain} \${spec}"); save ;;
  -I) lines=("\${chain} \${spec}" "\${lines[@]}"); save ;;
  -C) for l in "\${lines[@]}"; do [[ "\${l}" == "\${chain} \${spec}" ]] && exit 0; done; exit 1 ;;
  -D)
    new=(); found=0
    for l in "\${lines[@]}"; do
      if (( ! found )) && [[ "\${l}" == "\${chain} \${spec}" ]]; then found=1; continue; fi
      new+=("\${l}")
    done
    (( found )) || exit 1
    printf '%s\\n' "\${fam} \${table} -D \${chain} \${spec}" >> "\${FAKE_DIR}/writes"
    lines=("\${new[@]}"); save ;;
esac
exit 0
`;

const fakes = {
  iptables: fakeIptables,
  ip6tables: fakeIptables,
  // systemctl tiruan: status di file, setiap panggilan dicatat.
  systemctl: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_DIR}/systemctl.log"
args=()
for a in "$@"; do [[ "\${a}" == --* ]] || args+=("\${a}"); done
case "\${args[0]:-}" in
  is-active) [[ -f "\${FAKE_DIR}/active" ]] ;;
  is-enabled) [[ -f "\${FAKE_DIR}/enabled" ]] ;;
  restart|start) [[ -f "\${FAKE_DIR}/fail-start" ]] && { rm -f "\${FAKE_DIR}/active"; exit 1; }; : > "\${FAKE_DIR}/active" ;;
  enable) : > "\${FAKE_DIR}/enabled" ;;
  disable) rm -f "\${FAKE_DIR}/enabled"; [[ " $* " == *" --now "* ]] && rm -f "\${FAKE_DIR}/active"; exit 0 ;;
  *) exit 0 ;;
esac
`,
  ss: `#!/usr/bin/env bash
if [[ -f "\${FAKE_DIR}/udp" ]]; then while IFS= read -r l; do echo "\${l}"; done < "\${FAKE_DIR}/udp"; fi
if [[ -f "\${FAKE_DIR}/active" ]]; then
  echo 'UNCONN 0 0 *:5300 *:* users:(("dnstt-server",pid=99,fd=3))'
fi
`,
  curl: `#!/usr/bin/env bash
out=""; url=""
while (( $# )); do
  case "$1" in -o) out="$2"; shift 2 ;; -H) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
echo "\${url}" >> "\${FAKE_DIR}/curl.log"
case "\${url}" in
  *ipify*|*ifconfig.me*|*ipinfo.io*) [[ -f "\${FAKE_DIR}/offline" ]] && exit 6; echo "203.0.113.7" ;;
  *dns.google*|*cloudflare-dns.com*)
    if [[ -f "\${FAKE_DIR}/delegated" ]]; then
      c="$(cat "\${FAKE_DIR}/counter" 2>/dev/null || echo 0)"; echo $((c + 1)) > "\${FAKE_DIR}/counter"
    fi
    echo '{"Status":3}' ;;
  *dnstt-bin*) [[ -n "\${out}" ]] && cp "\${FAKE_DIR}/dnstt-download" "\${out}" ;;
  *) exit 22 ;;
esac
`,
  getent: '#!/usr/bin/env bash\n[[ "$1" == group && -f "${FAKE_DIR}/group-$2" ]]\n',
  groupadd: '#!/usr/bin/env bash\ntouch "${FAKE_DIR}/group-${!#}"\n',
  useradd: '#!/usr/bin/env bash\ntouch "${FAKE_DIR}/user-${!#}"\n',
  userdel: '#!/usr/bin/env bash\nrm -f "${FAKE_DIR}/user-$1"\n',
  groupdel: '#!/usr/bin/env bash\nrm -f "${FAKE_DIR}/group-$1"\n',
  id: '#!/usr/bin/env bash\n[[ "$1" == -u && -f "${FAKE_DIR}/user-$2" ]] && echo 990\n',
  chown: '#!/usr/bin/env bash\nexit 0\n',
  nproc: '#!/usr/bin/env bash\necho 1\n',
  ip: '#!/usr/bin/env bash\n[[ -f "${FAKE_DIR}/has-ipv6" ]] && echo "    inet6 2001:db8::7/64 scope global"\nexit 0\n',
  'netfilter-persistent': '#!/usr/bin/env bash\necho save >> "${FAKE_DIR}/persist"\n',
  'service-gate': '#!/usr/bin/env bash\necho "$*" >> "${FAKE_DIR}/gate.log"\n'
};
for (const [name, body] of Object.entries(fakes)) {
  fs.writeFileSync(path.join(bin, name), body);
  fs.chmodSync(path.join(bin, name), 0o755);
}

// dnstt-server tiruan: -gen-key menulis pasangan kunci 64 hex berurutan.
const fakeDnstt = `#!/usr/bin/env bash
if [[ "$1" == "-gen-key" ]]; then
  priv=""; pub=""
  while (( $# )); do case "$1" in -privkey-file) priv="$2"; shift 2 ;; -pubkey-file) pub="$2"; shift 2 ;; *) shift ;; esac; done
  n="$(cat "\${FAKE_DIR}/keyseq" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "\${n}" > "\${FAKE_DIR}/keyseq"
  printf '%064x\\n' "\${n}" > "\${priv}"
  printf '%064x\\n' "$((n + 4096))" > "\${pub}"
  exit 0
fi
exit 1
`;

const envFile = path.join(tmp, 'sc.env');
const stateFile = path.join(tmp, 'slowdns.state');
const keyDir = path.join(tmp, 'keys');
const dnsttBin = path.join(tmp, 'lib', 'dnstt-server');
const unitFile = path.join(tmp, 'sc-1forcr-slowdns.service');
const buildRoot = path.join(tmp, 'build');
fs.mkdirSync(buildRoot);
const F = (name) => path.join(tmp, name);
const read = (name) => (fs.existsSync(F(name)) ? fs.readFileSync(F(name), 'utf8') : '');
const rules = (fam, table) => read(`rules${fam}.${table}`).split('\n').filter(Boolean);

function installFakeDnstt() {
  fs.mkdirSync(path.dirname(dnsttBin), { recursive: true });
  fs.writeFileSync(dnsttBin, fakeDnstt);
  fs.chmodSync(dnsttBin, 0o755);
  fs.writeFileSync(`${dnsttBin}.version`, `${DNSTT_VERSION}+${DNSTT_PATCH_ID}\n`);
}

function setEnv(values) {
  const base = { DOMAIN: 'sg1.contoh.net', DROPBEAR_PORT: '109' };
  fs.writeFileSync(envFile, Object.entries({ ...base, ...values }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
const envValue = (key) => ((fs.readFileSync(envFile, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]);
const state = () => Object.fromEntries(read('slowdns.state').split('\n').filter(Boolean).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));

// PATH tiruan dipasang di dalam shell: bash Git for Windows menaruh /usr/bin di
// depan PATH dari luar, sehingga nproc/curl/id asli akan menang.
function run(...args) {
  for (const f of ['writes', 'persist', 'systemctl.log', 'gate.log', 'curl.log']) fs.rmSync(F(f), { force: true });
  const started = Date.now();
  const r = spawnSync(bash, ['-c', 'export PATH="${FAKE_BIN}:${PATH}"; exec bash "$0" "$@"', toBashPath(scriptPath), ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      FAKE_BIN: toBashPath(bin),
      FAKE_DIR: toBashPath(tmp),
      SC_ENV_FILE: toBashPath(envFile),
      SLOWDNS_STATE_FILE: toBashPath(stateFile),
      SLOWDNS_KEY_DIR: toBashPath(keyDir),
      SLOWDNS_BIN_PATH: toBashPath(dnsttBin),
      SLOWDNS_UNIT_FILE: toBashPath(unitFile),
      SLOWDNS_LOCK_FILE: toBashPath(F('lock')),
      SLOWDNS_BUILD_ROOT: toBashPath(buildRoot),
      SLOWDNS_WAIT_SECONDS: '1',
      SLOWDNS_SERVICE_GATE_BIN: toBashPath(path.join(bin, 'service-gate'))
    }
  });
  if (process.env.SLOWDNS_TEST_DEBUG) console.error(`[${Date.now() - started} ms] ${args.join(' ')} -> ${r.status}`);
  assert(!r.error, `sc-1forcr-slowdns ${args.join(' ')} macet: ${r.error && r.error.message}\n${r.stdout}${r.stderr}`);
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const systemctlCalls = () => read('systemctl.log').split('\n').filter(Boolean);
const mutatingSystemctl = () => systemctlCalls().filter((c) => !/^(is-active|is-enabled)\b/.test(c.replace(/^--\S+ /, '')));

try {
  // ── 1. Default mati: watchdog tidak menyentuh iptables ───────────────────
  setEnv({});
  let r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(state().ENABLED, '0');
  assert.strictEqual(state().RULES, '0');
  assert.strictEqual(read('writes'), '', 'mati: tidak ada aturan yang ditulis');
  fs.rmSync(F('ipt-calls'), { force: true });
  r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(read('ipt-calls'), '', 'mati + state mati: watchdog tidak memanggil iptables sama sekali');
  assert.deepStrictEqual(systemctlCalls(), [], 'mati + state mati: watchdog tidak memanggil systemctl sama sekali');
  r = run('setup');
  assert.strictEqual(r.status, 0, `setup saat mati tidak boleh gagal:\n${r.out}`);
  assert(!fs.existsSync(unitFile) && !fs.existsSync(dnsttBin), 'mati: tidak ada build maupun unit');

  // ── 2. Aktif: kunci, unit, aturan, state ─────────────────────────────────
  installFakeDnstt();
  // Rule yang sudah ada sebelumnya: jump port tambahan (TCP) dan DNAT UDP Custom.
  fs.writeFileSync(F('rules4.nat'), [
    'PREROUTING -p tcp -m addrtype --dst-type LOCAL -j SC1FORCR_PORTS',
    'PREROUTING -i eth0 -p udp -m udp --dport 1:65535 -j DNAT --to-destination :5667',
    'N SC1FORCR_PORTS'
  ].join('\n') + '\n');
  setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'NS-SG1.Contoh.NET.' });
  r = run('setup');
  assert.strictEqual(r.status, 0, r.out);
  const unit = fs.readFileSync(unitFile, 'utf8');
  for (const want of [
    'User=sc-1forcr-slowdns', 'Group=sc-1forcr-slowdns', 'MemoryMax=128M', 'Environment=GOMEMLIMIT=96MiB',
    'NoNewPrivileges=yes', 'ProtectSystem=strict', 'Restart=always', 'TasksMax=64',
    ' -udp :5300 -privkey-file ', ' -mtu 1232 ns-sg1.contoh.net 127.0.0.1:109'
  ]) assert(unit.includes(want), `unit wajib memuat ${want}:\n${unit}`);
  assert(/Environment=SLOWDNS_KCP_WINDOW=\d+/.test(unit), `unit menyetel window KCP per tier:\n${unit}`);
  assert(!/^User=root|Group=sc-1forcr-tunnel/m.test(unit), 'dnstt tidak jalan sebagai root atau grup tunnel');
  assert(/^0{63}1$/.test(fs.readFileSync(path.join(keyDir, 'server.key'), 'utf8').trim()), 'kunci server dibuat');
  let s = state();
  assert.strictEqual(s.ENABLED, '1');
  assert.strictEqual(s.ACTIVE, '1');
  assert.strictEqual(s.RULES, '1');
  assert.strictEqual(s.NS, 'ns-sg1.contoh.net', 'NS dinormalkan (huruf kecil, tanpa titik di ujung)');
  assert.strictEqual(s.PUBKEY, (4097).toString(16).padStart(64, '0'));
  assert.strictEqual(s.PUBLIC_IP, '203.0.113.7');
  assert.strictEqual(s.TARGET, '127.0.0.1:109');
  const calls = mutatingSystemctl();
  assert.strictEqual(calls.filter((c) => c === 'daemon-reload').length, 1, `satu daemon-reload: ${calls}`);
  assert(calls.includes('enable --no-reload sc-1forcr-slowdns.service'), `enable tanpa reload: ${calls}`);
  assert(calls.includes('restart sc-1forcr-slowdns.service'), `service dinyalakan: ${calls}`);
  let nat = rules(4, 'nat');
  assert.strictEqual(nat[0], 'PREROUTING -p udp -m addrtype --dst-type LOCAL -j SC1FORCR_SLOWDNS',
    `jump SlowDNS di depan DNAT 1:65535 UDP Custom:\n${nat.join('\n')}`);
  assert(nat.includes('SC1FORCR_SLOWDNS -p udp -m udp --dport 53 -m comment --comment sc-slowdns -j REDIRECT --to-ports 5300'));
  assert(rules(4, 'filter').includes('INPUT -p udp -m udp --dport 5300 -m comment --comment sc-slowdns -j ACCEPT'));
  // Balasan dnstt harus lolos di OUTPUT (service non-root bisa kena chain lain).
  assert(rules(4, 'filter').includes('OUTPUT -p udp -m udp --sport 5300 -m comment --comment sc-slowdns -j ACCEPT'),
    `OUTPUT ACCEPT balasan dnstt:\n${rules(4, 'filter').join('\n')}`);
  assert.strictEqual(rules(6, 'nat').length, 0, 'tanpa IPv6 global: ip6tables tidak disentuh');
  assert(read('persist').includes('save'), 'aturan baru disimpan netfilter-persistent');

  // ── 3. Idempoten: setup dan apply kedua tidak mengubah apa pun ───────────
  r = run('setup');
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(mutatingSystemctl(), [], `setup tanpa perubahan: tanpa reload/restart (${systemctlCalls()})`);
  assert.strictEqual(read('writes'), '', 'setup tanpa perubahan: iptables tidak ditulis');
  r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(read('writes'), '', 'apply tanpa perubahan: iptables tidak ditulis');
  assert.strictEqual(read('persist'), '', 'apply tanpa perubahan: tidak menyimpan ulang');

  // ── 4. Jump tergeser DNAT UDP Custom: dikembalikan ke depan oleh watchdog ─
  fs.writeFileSync(F('rules4.nat'), ['PREROUTING -i eth0 -p udp -m udp --dport 1:65535 -j DNAT --to-destination :36712', read('rules4.nat')].join('\n'));
  r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  nat = rules(4, 'nat');
  assert.strictEqual(nat[0], 'PREROUTING -p udp -m addrtype --dst-type LOCAL -j SC1FORCR_SLOWDNS', nat.join('\n'));
  assert.strictEqual(nat.filter((l) => l.endsWith('-j SC1FORCR_SLOWDNS')).length, 1, 'jump tidak dobel');
  assert.deepStrictEqual(mutatingSystemctl(), [], 'apply tetap tidak mengubah systemd');
  // Jump TCP (port tambahan) di atasnya tidak dianggap tergeser.
  fs.writeFileSync(F('rules4.nat'), ['PREROUTING -p tcp -m addrtype --dst-type LOCAL -j SC1FORCR_PORTS', read('rules4.nat')].join('\n'));
  r = run('apply');
  assert.strictEqual(read('writes'), '', 'rule TCP di atas jump SlowDNS dibiarkan');
  // Aturan hilang (reboot tanpa netfilter-persistent) dipasang ulang.
  fs.writeFileSync(F('rules4.nat'), '');
  fs.writeFileSync(F('rules4.filter'), '');
  r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(state().RULES, '1');
  assert(rules(4, 'nat').includes('SC1FORCR_SLOWDNS -p udp -m udp --dport 53 -m comment --comment sc-slowdns -j REDIRECT --to-ports 5300'));
  // Tanpa modul addrtype: tetap dialihkan.
  fs.writeFileSync(F('rules4.nat'), '');
  fs.writeFileSync(F('no-addrtype'), '');
  r = run('apply');
  assert.strictEqual(rules(4, 'nat')[0], 'PREROUTING -p udp -j SC1FORCR_SLOWDNS');
  fs.rmSync(F('no-addrtype'));
  fs.writeFileSync(F('rules4.nat'), '');
  run('apply');

  // ── 5. IPv6 hanya kalau VPS punya alamat global ──────────────────────────
  fs.writeFileSync(F('has-ipv6'), '');
  r = run('apply');
  assert(rules(6, 'nat').includes('PREROUTING -p udp -m addrtype --dst-type LOCAL -j SC1FORCR_SLOWDNS'), 'IPv6 dipasang');
  fs.rmSync(F('has-ipv6'));

  // ── 6. Port listen dipakai program lain: setup gagal tanpa merusak ───────
  fs.rmSync(F('active'));
  fs.writeFileSync(F('udp'), 'UNCONN 0 0 0.0.0.0:5300 0.0.0.0:* users:(("dnsmasq",pid=7,fd=4))\n');
  r = run('setup');
  assert.notStrictEqual(r.status, 0, 'port bentrok harus gagal');
  assert(/port UDP 5300 sudah dipakai/.test(r.out), r.out);
  fs.rmSync(F('udp'));
  r = run('setup');
  assert.strictEqual(r.status, 0, r.out);
  assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'service mati dinyalakan lagi oleh setup');

  // ── 7. enable/set-ns: validasi dan rollback ──────────────────────────────
  r = run('enable', 'sg1.contoh.net');
  assert.notStrictEqual(r.status, 0);
  assert(/tidak boleh sama dengan domain utama/.test(r.out), r.out);
  r = run('enable', 'bukan domain');
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(envValue('SLOWDNS_NS_DOMAIN'), 'NS-SG1.Contoh.NET.', 'input salah tidak menyentuh env');
  r = run('set-ns', 'dns.contoh.net');
  assert.strictEqual(r.status, 0, r.out);
  assert(fs.readFileSync(unitFile, 'utf8').includes(' -mtu 1232 dns.contoh.net 127.0.0.1:109'));
  assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'NS baru me-restart service');
  assert(/NS  dns\.contoh\.net  ->  sg1\.contoh\.net/.test(r.out), `record NS ditampilkan:\n${r.out}`);
  // Setup gagal (service tidak mau start) saat set-ns: NS lama dipulihkan.
  fs.writeFileSync(F('fail-start'), '');
  r = run('set-ns', 'dns2.contoh.net');
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(envValue('SLOWDNS_NS_DOMAIN'), 'dns.contoh.net', 'NS lama dipulihkan');
  fs.rmSync(F('fail-start'));
  run('setup');
  // enable dari keadaan mati, lalu gagal start: kembali mati.
  setEnv({ SLOWDNS_ENABLE: '0', SLOWDNS_NS_DOMAIN: '' });
  run('setup');
  fs.writeFileSync(F('fail-start'), '');
  r = run('enable', 'ns-sg1.contoh.net');
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(envValue('SLOWDNS_ENABLE'), '0', 'enable gagal: SLOWDNS_ENABLE dikembalikan');
  assert.strictEqual(envValue('SLOWDNS_NS_DOMAIN'), '', 'enable gagal: NS dikembalikan');
  assert.strictEqual(state().ENABLED, '0');
  assert.strictEqual(state().RULES, '0', 'enable gagal: aturan dilepas lagi');
  fs.rmSync(F('fail-start'));
  r = run('enable', 'ns-sg1.contoh.net');
  assert.strictEqual(r.status, 0, r.out);
  assert(/Berhasil: SlowDNS aktif/.test(r.out) && /Pubkey: [0-9a-f]{64}/.test(r.out), r.out);
  assert(read('gate.log').includes('apply'), 'gerbang ON/OFF diterapkan ulang setelah enable');
  assert.strictEqual(fs.readFileSync(path.join(keyDir, 'server.key'), 'utf8').trim(), '1'.padStart(64, '0'),
    'kunci lama tetap dipakai saat diaktifkan ulang');
  assert.strictEqual(run('suggest').out.trim(), 'ns-sg1.contoh.net');

  // ── 8. check: penghitung rule naik = delegasi benar ──────────────────────
  r = run('check');
  assert.notStrictEqual(r.status, 0, 'tanpa delegasi: gagal');
  assert(/belum sampai ke VPS ini/.test(r.out), r.out);
  fs.writeFileSync(F('delegated'), '');
  r = run('check');
  assert.strictEqual(r.status, 0, r.out);
  assert(/Delegasi NS sudah benar/.test(r.out), r.out);
  assert(/dns\.google\/resolve\?name=cek\d+a\.ns-sg1\.contoh\.net&type=TXT/.test(read('curl.log')), read('curl.log'));

  // ── 9. regen-key: pubkey baru, service di-restart ────────────────────────
  const oldPub = state().PUBKEY;
  r = run('regen-key');
  assert.strictEqual(r.status, 0, r.out);
  assert.notStrictEqual(state().PUBKEY, oldPub, 'pubkey berganti');
  assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'));

  // ── 10. disable: aturan dilepas, kunci disimpan ─────────────────────────
  const pubBefore = state().PUBKEY;
  r = run('disable');
  assert.strictEqual(r.status, 0, r.out);
  assert(mutatingSystemctl().includes('disable --no-reload --now sc-1forcr-slowdns.service'), systemctlCalls().join('\n'));
  assert(!rules(4, 'nat').some((l) => l.includes('SLOWDNS')), 'aturan nat dilepas');
  assert(!rules(4, 'filter').some((l) => l.includes('sc-slowdns')), 'aturan INPUT dilepas');
  assert.strictEqual(state().ENABLED, '0');
  assert.strictEqual(state().PUBKEY, pubBefore, 'kunci tetap disimpan');

  // ── 11. Binary dari URL wajib checksum; binary lama dipakai kalau gagal ──
  fs.writeFileSync(F('dnstt-download'), fakeDnstt);
  const sha = crypto.createHash('sha256').update(fakeDnstt).digest('hex');
  setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'ns-sg1.contoh.net', SLOWDNS_BIN_URL: 'https://contoh.net/dnstt-bin', SLOWDNS_BIN_SHA256: sha });
  r = run('setup');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(fs.readFileSync(`${dnsttBin}.version`, 'utf8').trim(), `sha256:${sha}`);
  assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'binary baru me-restart service');
  setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'ns-sg1.contoh.net', SLOWDNS_BIN_URL: 'https://contoh.net/dnstt-bin', SLOWDNS_BIN_SHA256: 'f'.repeat(64) });
  r = run('setup');
  assert.strictEqual(r.status, 0, `checksum salah tapi binary lama ada: tetap jalan\n${r.out}`);
  assert(/Checksum binary dnstt tidak cocok/.test(r.out) && /binary lama tetap dipakai/.test(r.out), r.out);
  fs.rmSync(dnsttBin);
  r = run('setup');
  assert.notStrictEqual(r.status, 0, 'tanpa binary dan checksum salah: gagal');

  // ── 12. clear (uninstall) ───────────────────────────────────────────────
  installFakeDnstt();
  setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'ns-sg1.contoh.net' });
  run('setup');
  r = run('clear');
  assert.strictEqual(r.status, 0, r.out);
  assert(!fs.existsSync(unitFile) && !fs.existsSync(dnsttBin) && !fs.existsSync(stateFile));
  assert(!rules(4, 'nat').some((l) => l.includes('SLOWDNS')) && !rules(4, 'filter').some((l) => l.includes('sc-slowdns')));
  assert(fs.existsSync(path.join(keyDir, 'server.key')), 'uninstall menyimpan kunci');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── API: data.slowdns hanya saat aktif dan SSH ON ───────────────────────────
const api = extract(installer, 'cat > "${APP_DIR}/api.js" <<\'EOF\'\n', '\nEOF\n');
const slowdnsSrc = extract(api, '\nconst SLOWDNS_STATE_FILE', '\n// ovpntcp/ovpnudp/sshohp', true);
const sshPayloadSrc = extract(api, '\nfunction sshPayload(', '\n}\n', true);
function payload(stateText, toggles = {}) {
  const ctx = vm.createContext({
    fs: { readFileSync: () => { if (stateText === null) throw new Error('ENOENT'); return stateText; } },
    readServiceToggles: () => toggles,
    Date,
    DOMAIN: 'sg1.contoh.net',
    SSHWS_UDPGW_PORTS: ['7300'],
    udpcustomPublicPort: () => '',
    publicPorts: (extra) => ({ tls: '443', none: '80', ...extra }),
    nowTime: () => '10:00:00',
    sanitizeInfoText: (t) => t
  });
  new vm.Script(`${slowdnsSrc}\n${sshPayloadSrc}\n}\nthis.out = sshPayload('budi', 'rahasia', '2026-12-01', 1);`).runInContext(ctx);
  return ctx.out;
}
const goodState = ['ENABLED=1', 'ACTIVE=1', 'RULES=1', 'NS=ns-sg1.contoh.net', `PUBKEY=${'ab'.repeat(32)}`, 'PUBLIC_IP=203.0.113.7'].join('\n');
let p = payload(goodState);
assert.strictEqual(JSON.stringify(p.slowdns), JSON.stringify({ ns: 'ns-sg1.contoh.net', pubkey: 'ab'.repeat(32), dns: '203.0.113.7:53' }));
assert.strictEqual(p.port.slowdns, '53');
assert.strictEqual(payload(goodState, { SERVICE_SSH_ENABLE: '0' }).slowdns, undefined, 'SSH OFF: SlowDNS tidak diiklankan');
for (const bad of [goodState.replace('ACTIVE=1', 'ACTIVE=0'), goodState.replace('RULES=1', 'RULES=0'),
  goodState.replace('ENABLED=1', 'ENABLED=0'), goodState.replace(/PUBKEY=.*/, 'PUBKEY=xyz'), null]) {
  p = payload(bad);
  assert(!('slowdns' in p) && !('slowdns' in p.port), `state tidak sehat tidak boleh mengiklankan SlowDNS: ${bad}`);
}
assert.strictEqual(payload(goodState.replace('PUBLIC_IP=203.0.113.7', 'PUBLIC_IP=')).slowdns.dns, '', 'IP tidak diketahui: DNS kosong');

// ── Gerbang ON/OFF: SSH OFF ikut menutup port SlowDNS ───────────────────────
const gate = extract(installer, "cat > /usr/local/sbin/sc-1forcr-service-gate <<'SERVICE_GATE_EOF'\n", '\nSERVICE_GATE_EOF\n');
const buildRules = extract(gate, '\nbuild_rules() {', '\n}\n');
const sshBlock = buildRules.slice(0, buildRules.indexOf('service_enabled vmess'));
assert(sshBlock.includes('ports="$(slowdns_port)"') &&
  sshBlock.includes('! -i lo -p udp -m multiport --dports ${ports} -m comment --comment sc-svc-ssh -j DROP'),
  'SSH OFF wajib menolak port listen SlowDNS');
const gateFns = extract(gate, '\njoin_ports() {', '\n}\n', true) + '\n}\n' + extract(gate, '\nslowdns_port() {', '\n}\n', true) + '\n}\n';
const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slowdns-gate-'));
try {
  const st = path.join(gateTmp, 'state');
  const port = (text) => {
    if (text === null) fs.rmSync(st, { force: true }); else fs.writeFileSync(st, text);
    const r = spawnSync(bash, ['-c', `${gateFns}\nslowdns_port`], { encoding: 'utf8', env: { ...process.env, SLOWDNS_STATE_FILE: toBashPath(st) } });
    return r.stdout.trim();
  };
  assert.strictEqual(port('ENABLED=1\nLISTEN=5300\n'), '5300');
  assert.strictEqual(port('ENABLED=0\nLISTEN=5300\n'), '', 'SlowDNS mati: tidak ada rule');
  assert.strictEqual(port(null), '', 'tanpa state: tidak ada rule');
  assert.strictEqual(port('ENABLED=1\nLISTEN=53\n'), '', 'port 53 tidak pernah ditolak gerbang');
} finally {
  fs.rmSync(gateTmp, { recursive: true, force: true });
}

// ── Urutan install/update/watchdog dan persistensi env ─────────────────────
const health = extract(installer, "cat > /usr/local/sbin/sc-1forcr-postboot-health <<'POSTBOOT_HEALTH_EOF'\n", '\nPOSTBOOT_HEALTH_EOF\n');
assert(health.indexOf('sc-1forcr-slowdns apply') > 0 &&
  health.indexOf('sc-1forcr-slowdns apply') < health.indexOf('sc-1forcr-service-gate apply'),
  'watchdog: SlowDNS sebelum gerbang ON/OFF');
assert(health.includes('repair_unit_if_needed sc-1forcr-slowdns.service'), 'watchdog memulihkan service SlowDNS');
const mainFn = installer.slice(installer.lastIndexOf('\nmain() {'));
const safePath = mainFn.slice(0, mainFn.indexOf('Re-run guard'));
const fullPath = mainFn.slice(mainFn.indexOf('Re-run guard'));
for (const [name, body, gateCall] of [['update aman', safePath, '\n    apply_service_gates'], ['install penuh', fullPath, '"38b_service_gate"']]) {
  assert(body.includes('setup_slowdns') && body.indexOf('setup_slowdns') < body.indexOf(gateCall),
    `${name}: setup_slowdns dipanggil sebelum gerbang ON/OFF`);
}
assert(/^setup_slowdns\(\) \{\n  install_slowdns_manager \|\| return 0\n[\s\S]*?\n  return 0\n\}/m.test(installer),
  'setup_slowdns tidak boleh menggagalkan install/update');
const envKeys = ['SLOWDNS_ENABLE', 'SLOWDNS_NS_DOMAIN', 'SLOWDNS_LISTEN_PORT', 'SLOWDNS_MTU', 'SLOWDNS_MEMORY_MAX', 'SLOWDNS_BIN_URL', 'SLOWDNS_BIN_SHA256'];
const envDump = extract(installer, '\n  cat > /etc/sc-1forcr.env <<EOF\n', '\nEOF\n');
const pending = extract(installer, '\npersist_pending_install_env() {', '\n}\n');
const menuUpdate = extract(installer, 'echo "Menjalankan update installer..."', 'bash "${tmp}" 2>&1 | tee "${update_log}"');
for (const key of envKeys) {
  assert(envDump.includes(`\n${key}=\${${key}}`), `${key} wajib ada di /etc/sc-1forcr.env`);
  assert(new RegExp(`\\b${key}\\b`).test(pending), `${key} wajib ada di persist_pending_install_env`);
  assert(menuUpdate.includes(`${key}="\${${key}:-`), `${key} wajib diteruskan update dari menu`);
}
const uninstall = extract(installer, '\n/usr/local/sbin/sc-1forcr-extra-ports clear', '\necho "Uninstall SC 1FORCR selesai');
assert(uninstall.includes('/usr/local/sbin/sc-1forcr-slowdns clear') && uninstall.includes('rm -f /usr/local/sbin/sc-1forcr-slowdns'),
  'uninstall melepas SlowDNS');

console.log('slowdns tests passed');

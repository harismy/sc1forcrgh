'use strict';

// Menu ON/OFF LAYANAN: sc-1forcr-service-gate menolak trafik layanan yang OFF
// lewat iptables tanpa menyentuh service systemd. Test menjalankan script hasil
// generate dengan iptables/ss/systemctl/xray tiruan dan memastikan:
// - semua ON = tidak ada rule sama sekali (VPS lama tidak berubah),
// - rule tiap layanan tepat, idempoten, dan selalu di puncak chain,
// - port sshd tidak pernah ikut ditutup,
// - kegagalan iptables/Xray mengembalikan status lama,
// - API menolak akun baru hanya untuk layanan yang OFF.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-service-gate-'));
const stubDir = path.join(tmpDir, 'bin');
const fwDir = path.join(tmpDir, 'fw');
const appDir = path.join(tmpDir, 'app');
for (const dir of [stubDir, fwDir, appDir]) fs.mkdirSync(dir, { recursive: true });
const scEnv = path.join(tmpDir, 'sc.env');
const appEnv = path.join(appDir, '.env');
const xrayConf = path.join(tmpDir, 'xray.json');
const zivpnConf = path.join(tmpDir, 'zivpn.json');
const udpConf = path.join(tmpDir, 'udp.json');
const B = (p) => toBashPath(p);

const writeExec = (file, body) => {
  fs.writeFileSync(file, body.replace(/\r\n/g, '\n'));
  fs.chmodSync(file, 0o755);
};

// iptables tiruan: satu file state per perintah (iptables / ip6tables),
// format sama dengan "iptables -S". Cukup untuk -S/-N/-F/-X/-A/-I/-D/-C.
const fakeIptables = `#!/usr/bin/env bash
name="$(basename "$0")"
state="\${FAKE_FW_DIR}/\${name}.rules"
[[ -f "\${state}" ]] || printf '%s\\n' '-P INPUT ACCEPT' '-P FORWARD ACCEPT' '-P OUTPUT ACCEPT' > "\${state}"
printf '%s\\n' "$*" >> "\${FAKE_FW_DIR}/\${name}.log"
args=()
while (( $# )); do
  if [[ "$1" == "-w" ]]; then shift 2; continue; fi
  args+=("$1"); shift
done
op="\${args[0]:-}"; chain="\${args[1]:-}"
rest=("\${args[@]:2}")
spec="\${rest[*]}"
is_builtin() { [[ "$1" == INPUT || "$1" == OUTPUT || "$1" == FORWARD ]]; }
exists() { is_builtin "$1" || grep -qxF -- "-N $1" "\${state}"; }
tmp="\${state}.tmp"
case "\${op}" in
  -S)
    if [[ -z "\${chain}" ]]; then cat "\${state}"; exit 0; fi
    exists "\${chain}" || { echo "No chain/target/match by that name." >&2; exit 1; }
    if is_builtin "\${chain}"; then echo "-P \${chain} ACCEPT"; else echo "-N \${chain}"; fi
    awk -v c="\${chain}" '$1 == "-A" && $2 == c' "\${state}"
    ;;
  -N)
    exists "\${chain}" && exit 1
    echo "-N \${chain}" >> "\${state}"
    ;;
  -F)
    exists "\${chain}" || exit 1
    awk -v c="\${chain}" '!($1 == "-A" && $2 == c)' "\${state}" > "\${tmp}" && mv "\${tmp}" "\${state}"
    ;;
  -X)
    exists "\${chain}" || exit 1
    grep -qF -- "-j \${chain}" "\${state}" && exit 1
    grep -vxF -- "-N \${chain}" "\${state}" > "\${tmp}"; mv "\${tmp}" "\${state}"
    ;;
  -A)
    exists "\${chain}" || exit 1
    if [[ -n "\${FAKE_FW_FAIL_ON:-}" && "\${spec}" == *"\${FAKE_FW_FAIL_ON}"* ]]; then exit 1; fi
    echo "-A \${chain} \${spec}" >> "\${state}"
    ;;
  -I)
    exists "\${chain}" || exit 1
    pos=1
    if [[ "\${rest[0]:-}" =~ ^[0-9]+$ ]]; then pos="\${rest[0]}"; spec="\${rest[*]:1}"; fi
    awk -v c="\${chain}" -v pos="\${pos}" -v line="-A \${chain} \${spec}" '
      { if ($1 == "-A" && $2 == c) { n++; if (n == pos && !done) { print line; done = 1 } } print }
      END { if (!done) print line }' "\${state}" > "\${tmp}" && mv "\${tmp}" "\${state}"
    ;;
  -D)
    line="-A \${chain} \${spec}"
    grep -qxF -- "\${line}" "\${state}" || exit 1
    awk -v line="\${line}" '$0 == line && !done { done = 1; next } { print }' "\${state}" > "\${tmp}" && mv "\${tmp}" "\${state}"
    ;;
  -C)
    grep -qxF -- "-A \${chain} \${spec}" "\${state}"
    ;;
  *) exit 2 ;;
esac
`;
writeExec(path.join(stubDir, 'iptables'), fakeIptables);
writeExec(path.join(stubDir, 'ip6tables'), fakeIptables);
writeExec(path.join(stubDir, 'ss'), '#!/usr/bin/env bash\ncat "${FAKE_FW_DIR}/ss.out" 2>/dev/null || true\n');
writeExec(path.join(stubDir, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
writeExec(path.join(stubDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
writeExec(path.join(stubDir, 'netfilter-persistent'), '#!/usr/bin/env bash\necho "$*" >> "${FAKE_FW_DIR}/persist.log"\n');
// Seperti Xray asli: format config ditentukan dari ekstensi file, jadi file
// uji tanpa .json selalu ditolak.
writeExec(path.join(stubDir, 'xray'), `#!/usr/bin/env bash
[[ -f "\${FAKE_FW_DIR}/xray-test-fail" ]] && exit 23
[[ "$1 $2 $3" == "run -test -config" ]] || exit 23
cfg="$4"
[[ "\${cfg}" == *.json && -s "\${cfg}" ]] || exit 23
grep -q '"network":"xhttp"' "\${cfg}" || exit 23
echo "\${cfg}" >> "\${FAKE_FW_DIR}/xray-test.log"
exit 0
`);
writeExec(path.join(stubDir, 'systemctl'), `#!/usr/bin/env bash
echo "$*" >> "\${FAKE_FW_DIR}/systemctl.log"
case "$1" in
  show) echo "\${FAKE_APP_DIR}" ;;
  restart) if [[ "$2" == "sc-1forcr-api" ]]; then bash "\${FAKE_FW_DIR}/api-restart-hook"; fi ;;
esac
exit 0
`);

// Tiruan API saat start: render config Xray dari .env, lalu Xray listen.
// File xray-broken meniru Xray yang tidak bisa memuat inbound XHTTP.
const baseListeners = [
  'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=10,fd=3))',
  'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:* users:(("sshd",pid=10,fd=4))',
  'LISTEN 0 128 0.0.0.0:109 0.0.0.0:* users:(("dropbear",pid=11,fd=3))',
  'LISTEN 0 128 0.0.0.0:143 0.0.0.0:* users:(("dropbear",pid=12,fd=3))',
  'LISTEN 0 4096 127.0.0.1:2082 0.0.0.0:* users:(("ssh-mux",pid=13,fd=3))',
  'LISTEN 0 4096 127.0.0.1:10001 0.0.0.0:* users:(("xray",pid=14,fd=3))'
];
fs.writeFileSync(path.join(fwDir, 'api-restart-hook'), `
xhttp="$(sed -n 's/^XRAY_XHTTP_ENABLE=//p' '${B(appEnv)}' | tail -n1)"
base='${baseListeners.join('\\n')}'
if [[ "\${xhttp}" == "1" ]]; then
  printf '{\\n  "inbounds": [\\n    { "tag": "vless-ws" },\\n    { "tag": "vless-xhttp" }\\n  ]\\n}\\n' > '${B(xrayConf)}'
  if [[ -f "\${FAKE_FW_DIR}/xray-broken" ]]; then
    printf '%b\\n' "\${base}" > "\${FAKE_FW_DIR}/ss.out"
  else
    printf '%b\\nLISTEN 0 4096 127.0.0.1:12002 0.0.0.0:* users:(("xray",pid=14,fd=9))\\n' "\${base}" > "\${FAKE_FW_DIR}/ss.out"
  fi
else
  printf '{\\n  "inbounds": [\\n    { "tag": "vless-ws" }\\n  ]\\n}\\n' > '${B(xrayConf)}'
  printf '%b\\n' "\${base}" > "\${FAKE_FW_DIR}/ss.out"
fi
`.replace(/\r\n/g, '\n'));
fs.writeFileSync(path.join(fwDir, 'ss.out'), `${baseListeners.join('\n')}\n`);

// Script hasil generate, path produksi dialihkan ke direktori test.
let gate = extract(installer, "cat > /usr/local/sbin/sc-1forcr-service-gate <<'SERVICE_GATE_EOF'\n", '\nSERVICE_GATE_EOF\n');
const redirects = [
  ['/etc/sc-1forcr.env', B(scEnv)],
  ['/usr/local/etc/xray/config.json', B(xrayConf)],
  ['/run/sc-1forcr-service-gate.lock', B(path.join(tmpDir, 'gate.lock'))],
  ['/etc/zivpn/config.json', B(zivpnConf)],
  ['/root/udp/config.json', B(udpConf)],
  ['/usr/local/bin/xray', '/tidak/ada/xray'],
  ['/usr/bin/xray', '/tidak/ada/xray2']
];
for (const [from, to] of redirects) {
  assert(gate.includes(from), `gate script no longer references ${from}`);
  gate = gate.split(from).join(to);
}
const gatePath = path.join(tmpDir, 'gate.sh');
fs.writeFileSync(gatePath, `${gate}\n`);
const runnerPath = path.join(tmpDir, 'run.sh');
fs.writeFileSync(runnerPath, `export PATH='${B(stubDir)}':"$PATH"
export FAKE_FW_DIR='${B(fwDir)}' FAKE_APP_DIR='${B(appDir)}'
exec bash '${B(gatePath)}' "$@"
`);

function gateRun(args, extraEnv = {}) {
  const r = spawnSync(bash, [B(runnerPath), ...args], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function ok(args, extraEnv) {
  const r = gateRun(args, extraEnv);
  assert.strictEqual(r.status, 0, `gate ${args.join(' ')} failed:\n${r.stderr}${r.stdout}`);
  return r;
}
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const rules = (ipt = 'iptables') => read(path.join(fwDir, `${ipt}.rules`)).split('\n').filter(Boolean);
const chainRules = (chain, ipt) => rules(ipt).filter((l) => l.startsWith(`-A ${chain} `));
const firstRule = (parent, ipt) => chainRules(parent, ipt)[0] || '';
const logCount = (needle, ipt = 'iptables') => read(path.join(fwDir, `${ipt}.log`)).split('\n').filter((l) => l.includes(needle)).length;
const envValue = (file, key) => ((read(file).match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]);
const status = () => Object.fromEntries(ok(['status']).stdout.trim().split('\n').map((l) => {
  const [svc, state, detail] = l.split(' ');
  return [svc, `${state} ${detail}`];
}));

try {
  fs.writeFileSync(scEnv, 'DOMAIN=vpn.example.com\nDROPBEAR_PORT=22\n');
  fs.writeFileSync(appEnv, 'DOMAIN=vpn.example.com\nDROPBEAR_ALT_PORT=143\n');
  fs.writeFileSync(zivpnConf, '{\n  "listen": ":5667",\n  "cert": "/etc/zivpn/zivpn.crt"\n}\n');
  fs.writeFileSync(udpConf, '{"listen":":5668","stream_buffer":33554432}\n');

  // Default semua ON: apply tidak memasang rule apa pun.
  ok(['apply']);
  assert(!rules().some((l) => l.includes('SC1FORCR_SVC')), 'all services ON must not add any iptables rule');
  assert.strictEqual(logCount('-N '), 0, 'all services ON must not create chains');
  assert.deepStrictEqual(status(), {
    ssh: 'ON -', vmess: 'ON -', vless: 'ON -', trojan: 'ON -', udp: 'ON -', xhttp: 'OFF -'
  });

  // VMess OFF: hanya port inbound VMess, gerbang di puncak OUTPUT, disimpan.
  ok(['set', 'vmess', 'off']);
  assert.strictEqual(envValue(scEnv, 'SERVICE_VMESS_ENABLE'), '0');
  assert.strictEqual(envValue(appEnv, 'SERVICE_VMESS_ENABLE'), '0', 'API .env must follow the toggle');
  const vmessRule = chainRules('SC1FORCR_SVC_OUT').find((l) => l.includes('sc-svc-vmess'));
  assert(vmessRule, 'vmess gate rule missing');
  assert(/-o lo -p tcp -d 127\.0\.0\.1 -m multiport --dports 10001,11001,10004 .*-j REJECT --reject-with tcp-reset/.test(vmessRule), vmessRule);
  assert.strictEqual(firstRule('OUTPUT'), '-A OUTPUT -j SC1FORCR_SVC_OUT', 'gate jump must be first in OUTPUT');
  assert(!rules().some((l) => l.includes('SC1FORCR_SVC_IN')), 'vmess OFF must not touch INPUT');
  assert(!rules('ip6tables').some((l) => l.includes('SC1FORCR_SVC')), 'vmess gate is IPv4 loopback only');
  assert(read(path.join(fwDir, 'persist.log')).includes('save'), 'toggle must persist iptables rules');
  assert.strictEqual(status().vmess, 'OFF TERPASANG');

  // Apply berkala tidak membangun ulang chain yang isinya sama.
  const flushes = logCount('-F SC1FORCR_SVC_OUT');
  ok(['apply']);
  ok(['apply']);
  assert.strictEqual(logCount('-F SC1FORCR_SVC_OUT'), flushes, 'unchanged gates must not be rebuilt on every apply');

  // Rule lain yang disisipkan di puncak chain menggeser gerbang; apply mengembalikannya.
  spawnSync(bash, [B(path.join(stubDir, 'iptables')), '-w', '10', '-I', 'OUTPUT', '1', '-p', 'tcp', '--dport', '25', '-j', 'REJECT'],
    { env: { ...process.env, FAKE_FW_DIR: B(fwDir) } });
  assert.notStrictEqual(firstRule('OUTPUT'), '-A OUTPUT -j SC1FORCR_SVC_OUT');
  ok(['apply']);
  assert.strictEqual(firstRule('OUTPUT'), '-A OUTPUT -j SC1FORCR_SVC_OUT', 'apply must move the gate back to the top');
  assert.strictEqual(chainRules('OUTPUT').filter((l) => l.includes('SC1FORCR_SVC_OUT')).length, 1, 'only one jump');

  // SSH OFF: sshws + Dropbear. DROPBEAR_PORT=22 (salah konfigurasi) dan port
  // sshd lain (2222) tidak boleh ikut ditutup.
  ok(['set', 'ssh', 'off']);
  const sshOut = chainRules('SC1FORCR_SVC_OUT').find((l) => l.includes('sc-svc-ssh'));
  assert(sshOut && sshOut.includes('-d 127.0.0.1 --dport 2082'), `sshws gate missing: ${sshOut}`);
  const sshIn = chainRules('SC1FORCR_SVC_IN').find((l) => l.includes('sc-svc-ssh'));
  assert(sshIn && sshIn.includes('! -i lo -p tcp -m multiport --dports 109,143 '), `dropbear gate wrong: ${sshIn}`);
  assert(!/--dports [^ ]*\b(22|2222)\b/.test(sshIn), 'sshd ports must never be closed');
  assert.strictEqual(firstRule('INPUT'), '-A INPUT -j SC1FORCR_SVC_IN');
  assert(chainRules('SC1FORCR_SVC_IN', 'ip6tables').some((l) => l.includes('--dports 109,143')), 'dropbear gate must cover IPv6');

  // UDP OFF: port listen ZIVPN dan UDP Custom (setelah DNAT).
  ok(['set', 'udp', 'off']);
  const udpRule = chainRules('SC1FORCR_SVC_IN').find((l) => l.includes('sc-svc-udp'));
  assert(udpRule && udpRule.includes('! -i lo -p udp -m multiport --dports 5667,5668 ') && udpRule.endsWith('-j DROP'), `udp gate wrong: ${udpRule}`);
  assert.strictEqual(status().udp, 'OFF TERPASANG');

  // iptables gagal: status dikembalikan, rule tidak setengah jadi.
  const failed = gateRun(['set', 'trojan', 'off'], { FAKE_FW_FAIL_ON: 'sc-svc-trojan' });
  assert.notStrictEqual(failed.status, 0, 'failed iptables must fail the toggle');
  assert(failed.stderr.includes('dikembalikan'), failed.stderr);
  assert.strictEqual(envValue(scEnv, 'SERVICE_TROJAN_ENABLE'), '1', 'failed toggle must restore the old flag');
  assert(!rules().some((l) => l.includes('sc-svc-trojan')), 'failed toggle must not leave a trojan rule');
  assert(chainRules('SC1FORCR_SVC_OUT').some((l) => l.includes('sc-svc-vmess')), 'other gates must survive a failed toggle');

  // Semua ON lagi: chain dan jump hilang total (IPv4 dan IPv6).
  ok(['set', 'ssh', 'on']);
  ok(['set', 'vmess', 'on']);
  ok(['set', 'udp', 'on']);
  for (const ipt of ['iptables', 'ip6tables']) {
    assert(!rules(ipt).some((l) => l.includes('SC1FORCR_SVC')), `${ipt}: all ON must remove chains and jumps`);
  }

  assert.notStrictEqual(gateRun(['set', 'openvpn', 'off']).status, 0, 'unknown service must be rejected');
  assert.notStrictEqual(gateRun(['set', 'vmess', 'mati']).status, 0, 'invalid state must be rejected');

  // XHTTP: binary Xray yang tidak mendukung XHTTP ditolak sebelum apa pun diubah.
  fs.writeFileSync(path.join(fwDir, 'xray-test-fail'), '');
  const noXhttp = gateRun(['set', 'xhttp', 'on']);
  assert.notStrictEqual(noXhttp.status, 0);
  assert.notStrictEqual(envValue(scEnv, 'XRAY_XHTTP_ENABLE'), '1', 'unsupported Xray must not enable XHTTP');
  assert(!read(path.join(fwDir, 'systemctl.log')).includes('restart sc-1forcr-api'), 'unsupported Xray must not restart anything');
  fs.unlinkSync(path.join(fwDir, 'xray-test-fail'));

  // XHTTP ON: flag di kedua env, API direstart, Xray memuat inbound XHTTP.
  ok(['set', 'xhttp', 'on']);
  assert(/\.json$/m.test(read(path.join(fwDir, 'xray-test.log'))), 'XHTTP preflight must run xray -test on a .json config');
  assert.strictEqual(envValue(scEnv, 'XRAY_XHTTP_ENABLE'), '1');
  assert.strictEqual(envValue(appEnv, 'XRAY_XHTTP_ENABLE'), '1');
  assert.strictEqual(status().xhttp, 'ON INBOUND');
  ok(['set', 'xhttp', 'off']);
  assert.strictEqual(envValue(appEnv, 'XRAY_XHTTP_ENABLE'), '0');
  assert.strictEqual(status().xhttp, 'OFF -');

  // Xray tidak listen di 12002 setelah restart: flag dan config dipulihkan.
  fs.writeFileSync(path.join(fwDir, 'xray-broken'), '');
  fs.writeFileSync(path.join(fwDir, 'systemctl.log'), '');
  const broken = gateRun(['set', 'xhttp', 'on']);
  assert.notStrictEqual(broken.status, 0, 'unhealthy Xray must fail the XHTTP toggle');
  assert.strictEqual(envValue(scEnv, 'XRAY_XHTTP_ENABLE'), '0', 'XHTTP flag must be rolled back');
  assert.strictEqual(envValue(appEnv, 'XRAY_XHTTP_ENABLE'), '0');
  assert.strictEqual(read(path.join(fwDir, 'systemctl.log')).split('\n').filter((l) => l === 'restart sc-1forcr-api').length, 2,
    'rollback must restart the API again to restore the old Xray config');
  assert(!read(xrayConf).includes('vless-xhttp'), 'Xray config must be rendered without XHTTP after rollback');

  // API: akun baru ditolak hanya untuk layanan yang OFF, tanpa restart API.
  const apiSource = extract(installer, 'cat > "${APP_DIR}/api.js" <<\'EOF\'\n', '\nEOF\n');
  const toggleCode = extract(apiSource, '// Layanan yang dimatikan lewat menu ON/OFF LAYANAN (sc-1forcr-service-gate).\n',
    '\nasync function createOrUpdateSshFromBody(');
  assert(/async function createOrUpdateSshFromBody\([^)]*\) \{\n  assertServiceOpenForNewAccount\('ssh'\);/.test(apiSource),
    'SSH creation must check the service toggle first');
  assert(/async function createXray\([^)]*\) \{\n  assertServiceOpenForNewAccount\(protocol\);/.test(apiSource),
    'Xray creation must check the service toggle first');
  const apiDir = path.join(tmpDir, 'api');
  fs.mkdirSync(apiDir);
  const ctx = vm.createContext({ fs, __dirname: apiDir });
  new vm.Script(`${toggleCode}\nthis.check = assertServiceOpenForNewAccount;`).runInContext(ctx);
  const rejects = (proto) => {
    try { ctx.check(proto); return null; } catch (e) { return e; }
  };
  for (const proto of ['ssh', 'vmess', 'vless', 'trojan']) assert.strictEqual(rejects(proto), null, `${proto} allowed without .env`);
  fs.writeFileSync(path.join(apiDir, '.env'), 'SERVICE_VMESS_ENABLE=0\nSERVICE_SSH_ENABLE=0\nSERVICE_UDP_ENABLE=1\n');
  const vmessErr = rejects('vmess');
  assert(vmessErr && vmessErr.statusCode === 503 && /VMESS/.test(vmessErr.message), 'disabled VMess must be rejected with 503');
  assert.strictEqual(rejects('vless'), null, 'other protocols stay open');
  assert.strictEqual(rejects('ssh'), null, 'SSH accounts stay open while UDP (ZIVPN) is on');
  fs.writeFileSync(path.join(apiDir, '.env'), 'SERVICE_VMESS_ENABLE=1\nSERVICE_SSH_ENABLE=0\nSERVICE_UDP_ENABLE="0"\n');
  assert.strictEqual(rejects('vmess'), null, 'changed .env must be picked up without restarting the API');
  assert(rejects('ssh'), 'SSH accounts are rejected once SSH and UDP are both off');

  console.log('service gate tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

'use strict';

// Keamanan trafik tunnel dan sshd.
// - sc-1forcr-tunnel-guard: akun VPN (grup sc-1forcr-tunnel: akun SSH,
//   Dropbear, ZIVPN, UDP Custom; UID nobody: Xray) tidak bisa menjangkau
//   layanan lokal VPS selain DNS/80/443/API/UDPGW, jaringan privat, dan
//   metadata provider; port penyalahgunaan ditolak; koneksi baru ke sshd
//   dibatasi per IP. Siklus watchdog tanpa perubahan tidak menyentuh iptables.
// - apply_sshd_hardening: drop-in atau blok teratas, divalidasi sshd -t,
//   dipulihkan kalau tidak valid, reload hanya kalau berubah.
// - Dropbear menolak login root (-w) dan remote forwarding (-k), termasuk VPS
//   lama yang override-nya disisipi flag tanpa restart.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return source.slice(start + startMarker.length, end);
}
function fn(name) {
  const start = installer.indexOf(`\n${name}() {\n`);
  assert(start >= 0, `function not found: ${name}`);
  const end = installer.indexOf('\n}\n', start);
  return installer.slice(start + 1, end + 3);
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-tunnel-sec-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const write = (p, s, mode) => { fs.writeFileSync(p, s); if (mode) fs.chmodSync(p, mode); };
const read = (name) => (fs.existsSync(path.join(tmp, name)) ? fs.readFileSync(path.join(tmp, name), 'utf8') : '');

// iptables tiruan (tabel filter): chain bawaan INPUT/OUTPUT dan chain buatan.
// Hanya builtin bash (tanpa grep/sed), supaya test tetap cepat di Windows.
const fakeIptables = (fam) => `#!/usr/bin/env bash
fam=${fam}
st="\${FAKE_DIR}/rules\${fam}"
[[ -f "\${FAKE_DIR}/no-ipt\${fam}" ]] && exit 1
[[ -f "\${st}" ]] || : > "\${st}"
mapfile -t L < "\${st}"
args=()
while (( $# )); do
  case "$1" in
    -w) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
op="\${args[0]}"; chain="\${args[1]:-}"; rest=("\${args[@]:2}"); spec="\${rest[*]}"
builtin_chain() { [[ "$1" == INPUT || "$1" == OUTPUT || "$1" == FORWARD ]]; }
exists() {
  builtin_chain "$1" && return 0
  local l
  for l in "\${L[@]}"; do [[ "\${l}" == "N $1" ]] && return 0; done
  return 1
}
target_ok() {
  local s=" $1 " t
  [[ "\${s}" == *" -j "* ]] || return 0
  t="\${s##* -j }"; t="\${t%% *}"
  case "\${t}" in RETURN|REJECT|DROP|ACCEPT) return 0 ;; esac
  exists "\${t}"
}
save() { if (( \${#L[@]} )); then printf '%s\\n' "\${L[@]}" > "\${st}"; else : > "\${st}"; fi; }
logw() { printf '%s\\n' "\${fam} $*" >> "\${FAKE_DIR}/writes"; }
case "\${op}" in
  -S)
    exists "\${chain}" || exit 1
    if builtin_chain "\${chain}"; then echo "-P \${chain} ACCEPT"; else echo "-N \${chain}"; fi
    for l in "\${L[@]}"; do [[ "\${l}" == "\${chain} "* ]] && echo "-A \${l}"; done
    ;;
  -N) exists "\${chain}" && exit 1; L+=("N \${chain}"); save; logw -N "\${chain}" ;;
  -F)
    exists "\${chain}" || exit 1
    new=(); for l in "\${L[@]}"; do [[ "\${l}" == "\${chain} "* ]] || new+=("\${l}"); done
    L=("\${new[@]}"); save; logw -F "\${chain}" ;;
  -X)
    builtin_chain "\${chain}" && exit 1
    exists "\${chain}" || exit 1
    for l in "\${L[@]}"; do
      [[ "\${l} " == *" -j \${chain} "* || "\${l}" == "\${chain} "* ]] && exit 1
    done
    new=(); for l in "\${L[@]}"; do [[ "\${l}" == "N \${chain}" ]] || new+=("\${l}"); done
    L=("\${new[@]}"); save; logw -X "\${chain}" ;;
  -A)
    exists "\${chain}" || exit 1
    target_ok "\${spec}" || exit 1
    L+=("\${chain} \${spec}"); save; logw -A "\${chain} \${spec}" ;;
  -I)
    exists "\${chain}" || exit 1
    line="\${chain} \${rest[*]:1}"
    target_ok "\${line}" || exit 1
    L=("\${line}" "\${L[@]}"); save; logw -I "\${line}" ;;
  -C)
    for l in "\${L[@]}"; do [[ "\${l}" == "\${chain} \${spec}" ]] && exit 0; done
    exit 1 ;;
  -D)
    new=(); found=0
    for l in "\${L[@]}"; do
      if (( ! found )) && [[ "\${l}" == "\${chain} \${spec}" ]]; then found=1; continue; fi
      new+=("\${l}")
    done
    (( found )) || exit 1
    L=("\${new[@]}"); save; logw -D "\${chain} \${spec}" ;;
esac
exit 0
`;
write(path.join(bin, 'iptables'), fakeIptables(4), 0o755);
write(path.join(bin, 'ip6tables'), fakeIptables(6), 0o755);
write(path.join(bin, 'getent'), `#!/usr/bin/env bash
case "$1" in
  group) [[ -f "\${FAKE_DIR}/group-created" ]] && echo "sc-1forcr-tunnel:x:998:" && exit 0; exit 2 ;;
  passwd) if [[ -n "\${2:-}" ]]; then grep "^\${2}:" "\${FAKE_DIR}/passwd"; else cat "\${FAKE_DIR}/passwd"; fi ;;
esac
`, 0o755);
write(path.join(bin, 'groupadd'), '#!/usr/bin/env bash\necho "groupadd $*" >> "${FAKE_DIR}/sys"\ntouch "${FAKE_DIR}/group-created"\n', 0o755);
write(path.join(bin, 'usermod'), `#!/usr/bin/env bash
echo "usermod $*" >> "\${FAKE_DIR}/sys"
user="\${!#}"
awk -F: -v OFS=: -v u="\${user}" '$1 == u { $4 = 998 } { print }' "\${FAKE_DIR}/passwd" > "\${FAKE_DIR}/passwd.n" && mv "\${FAKE_DIR}/passwd.n" "\${FAKE_DIR}/passwd"
`, 0o755);
write(path.join(bin, 'id'), '#!/usr/bin/env bash\n[[ "$1 $2" == "-u nobody" ]] && echo 65534 && exit 0\nexit 1\n', 0o755);
write(path.join(bin, 'ss'), '#!/usr/bin/env bash\ncat "${FAKE_DIR}/listen"\n', 0o755);
write(path.join(bin, 'sshd'), '#!/usr/bin/env bash\n[[ "$1" == "-T" ]] && cat "${FAKE_DIR}/sshd-T"\nexit 0\n', 0o755);
write(path.join(bin, 'netfilter-persistent'), '#!/usr/bin/env bash\necho save >> "${FAKE_DIR}/persist"\n', 0o755);

const guardPath = path.join(tmp, 'sc-1forcr-tunnel-guard');
write(guardPath, `${between(installer, "cat > /usr/local/sbin/sc-1forcr-tunnel-guard <<'TUNNEL_GUARD_EOF'\n", '\nTUNNEL_GUARD_EOF\n')}\n`);
const envFile = path.join(tmp, 'sc.env');
const stateFile = path.join(tmp, 'guard.state');
const baseEnv = {
  ...process.env,
  PATH: `${toBashPath(bin)}:${process.env.PATH}`,
  FAKE_DIR: toBashPath(tmp),
  SC_ENV_FILE: toBashPath(envFile),
  TUNNEL_GUARD_STATE_FILE: toBashPath(stateFile),
  TUNNEL_GUARD_LOCK_FILE: toBashPath(path.join(tmp, 'lock'))
};
for (const k of ['TUNNEL_LOCAL_GUARD_ENABLE', 'TUNNEL_ADMIN_SSH_ALLOW', 'SSH_BRUTE_GUARD_ENABLE', 'TUNNEL_ABUSE_GUARD_ENABLE', 'TUNNEL_ABUSE_BLOCK_TCP_PORTS',
  'SSH_TUNNEL_BLOCK_OUTBOUND_SSH', 'SSH_TUNNEL_BLOCK_OUTBOUND_PORTS', 'API_PORT', 'SSHWS_UDPGW_PORTS', 'SSH_TUNNEL_SHELL']) delete baseEnv[k];
const guard = (cmd) => {
  for (const f of ['writes', 'persist', 'sys']) fs.rmSync(path.join(tmp, f), { force: true });
  const r = spawnSync(bash, [toBashPath(guardPath), cmd], { encoding: 'utf8', env: baseEnv });
  assert.strictEqual(r.status, 0, `guard ${cmd} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const rules = (fam) => read(`rules${fam}`).split('\n').filter((l) => l && !l.startsWith('N '));
const chain = (fam, name) => rules(fam).filter((l) => l.startsWith(`${name} `)).map((l) => l.slice(name.length + 1));
const chains = (fam) => read(`rules${fam}`).split('\n').filter((l) => l.startsWith('N ')).map((l) => l.slice(2)).sort();

try {
  // ── Pembatas trafik tunnel ──
  write(path.join(tmp, 'passwd'), [
    'root:x:0:0:root:/root:/bin/bash',
    'admin:x:1000:1000::/home/admin:/bin/bash',
    'budi:x:1001:1001::/home/budi:/usr/local/sbin/sc-1forcr-tunnel-shell',
    'sari:x:1002:1002::/home/sari:/usr/local/sbin/sc-1forcr-tunnel-shell',
    'nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin'
  ].join('\n') + '\n');
  write(path.join(tmp, 'listen'), [
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=12,fd=3))',
    'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:* users:(("sshd",pid=12,fd=4))',
    'LISTEN 0 20 0.0.0.0:109 0.0.0.0:* users:(("dropbear",pid=13,fd=3))'
  ].join('\n') + '\n');
  write(path.join(tmp, 'sshd-T'), 'port 22\nport 2222\nallowtcpforwarding local\n');
  write(envFile, 'API_PORT=8088\nSSHWS_UDPGW_PORTS=7300,7200\n');

  guard('apply');
  assert(read('sys').includes('groupadd -r sc-1forcr-tunnel'), 'the tunnel group must be created');
  assert.deepStrictEqual(read('sys').split('\n').filter((l) => l.startsWith('usermod')).sort(),
    ['usermod -g sc-1forcr-tunnel budi', 'usermod -g sc-1forcr-tunnel sari'], 'only accounts with the tunnel shell move to the tunnel group');
  assert.deepStrictEqual(chains(4), ['SC1FORCR_SSH_GUARD', 'SC1FORCR_TUN_LOCAL', 'SC1FORCR_TUN_OUT', 'SC1FORCR_TUN_PRIV']);
  assert.deepStrictEqual(chain(4, 'OUTPUT'), [
    '-m conntrack --ctstate NEW -m owner --uid-owner 65534 -j SC1FORCR_TUN_OUT',
    '-m conntrack --ctstate NEW -m owner --gid-owner 998 -j SC1FORCR_TUN_OUT'
  ], 'only NEW packets from the tunnel group and Xray (nobody) are inspected');
  // Mode longgar: akun VPN bebas ping/konek ke mana saja. Yang tetap ditutup
  // cuma Xray API 10085, metadata cloud, dan port abuse. ICMP echo lolos.
  assert.deepStrictEqual(chain(4, 'SC1FORCR_TUN_OUT'), [
    '-p icmp --icmp-type echo-request -j RETURN',
    '-m addrtype --dst-type LOCAL -j SC1FORCR_TUN_LOCAL',
    '-d 169.254.169.254 -j SC1FORCR_TUN_PRIV',
    '-p tcp -m multiport --dports 3389,5900,5901,5902,445,135,139,25,465,587 -j REJECT --reject-with tcp-reset'
  ], 'ICMP allowed; only the VPS itself, the cloud metadata IP, and abuse ports are inspected (other private ranges pass)');
  assert.deepStrictEqual(chain(4, 'SC1FORCR_TUN_LOCAL'), [
    '-p tcp --dport 10085 -j REJECT --reject-with tcp-reset',
    '-p tcp -m multiport --dports 22,2222 -m hashlimit --hashlimit-name sc_tunssh4 --hashlimit-above 4/minute --hashlimit-burst 8 -j REJECT --reject-with tcp-reset',
    '-p tcp -m multiport --dports 22,2222 -j RETURN',
    '-j RETURN'
  ], 'to the VPS itself everything is allowed except Xray API 10085; sshd stays rate-limited; final RETURN lets the rest (Dropbear, ping, bug loopback) through');
  assert(chain(4, 'SC1FORCR_TUN_LOCAL').some((r) => /--dport 10085 .*REJECT/.test(r)), 'Xray API 10085 stays closed to tunnels');
  assert(!chain(4, 'SC1FORCR_TUN_LOCAL').some((r) => /\b(109|143|2082)\b/.test(r)), 'Dropbear and mux are no longer blocked (loose mode)');
  assert.deepStrictEqual(chain(4, 'SC1FORCR_TUN_PRIV'), [
    '-p tcp -j REJECT --reject-with tcp-reset', '-j REJECT'
  ], 'the cloud metadata IP is fully blocked (credential theft)');
  assert.deepStrictEqual(chain(4, 'INPUT'), ['! -i lo -p tcp -m conntrack --ctstate NEW -j SC1FORCR_SSH_GUARD']);
  assert.deepStrictEqual(chain(4, 'SC1FORCR_SSH_GUARD'), [
    '-p tcp -m multiport --dports 22,2222 -m hashlimit --hashlimit-name sc_sshd4 --hashlimit-mode srcip --hashlimit-srcmask 32 --hashlimit-above 15/minute --hashlimit-burst 30 -j DROP'
  ], 'new sshd connections are rate limited per IP (Dropbear 109 is never included)');
  assert.deepStrictEqual(chain(6, 'SC1FORCR_TUN_OUT').filter((r) => r.startsWith('-d ')), [
    '-d fd00:ec2::254 -j SC1FORCR_TUN_PRIV'
  ], 'IPv6: only the cloud metadata IP is blocked');
  assert(chain(6, 'SC1FORCR_TUN_OUT').includes('-p ipv6-icmp --icmpv6-type echo-request -j RETURN'), 'IPv6 ping (echo-request) is allowed too');
  assert(chain(6, 'SC1FORCR_SSH_GUARD')[0].includes('--hashlimit-name sc_sshd6 --hashlimit-mode srcip --hashlimit-srcmask 64'), 'IPv6 rate limit per /64');
  assert.strictEqual(read('persist').trim(), 'save', 'changed rules are saved once');

  // Siklus watchdog tanpa perubahan.
  guard('apply');
  assert.strictEqual(read('writes'), '', `an unchanged apply must not touch iptables:\n${read('writes')}`);
  assert.strictEqual(read('persist'), '');
  assert.strictEqual(read('sys'), '', 'no user or group changes when nothing changed');

  // Jump hilang (mis. iptables dibersihkan pihak lain): hanya jump yang dipasang lagi.
  const r4 = read('rules4').split('\n').filter((l) => !l.startsWith('OUTPUT -m conntrack --ctstate NEW -m owner --gid-owner'));
  write(path.join(tmp, 'rules4'), r4.join('\n'));
  guard('apply');
  assert.deepStrictEqual(read('writes').trim().split('\n'), ['4 -I OUTPUT -m conntrack --ctstate NEW -m owner --gid-owner 998 -j SC1FORCR_TUN_OUT'],
    'a missing jump is restored without rebuilding the chains');

  // Isi chain berubah: dibangun ulang.
  write(path.join(tmp, 'rules4'), read('rules4').split('\n').filter((l) => !l.startsWith('SC1FORCR_TUN_PRIV -p tcp -j REJECT')).join('\n'));
  guard('apply');
  assert.strictEqual(chain(4, 'SC1FORCR_TUN_PRIV').length, 2, 'a damaged chain is rebuilt');
  assert.strictEqual(chain(4, 'OUTPUT').length, 2, 'rebuild keeps exactly one jump per owner');

  // Config berubah: mode longgar tetap (port API/UDPGW tidak lagi memengaruhi chain).
  write(envFile, 'API_PORT=9090\nSSHWS_UDPGW_PORTS=7300\n');
  guard('apply');
  assert(chain(4, 'SC1FORCR_TUN_LOCAL').includes('-p tcp --dport 10085 -j REJECT --reject-with tcp-reset')
    && chain(4, 'SC1FORCR_TUN_LOCAL').slice(-1)[0] === '-j RETURN', 'loose mode stays: only 10085 closed, rest allowed');

  // Pemilik bisa menolak SSH lewat VPN sama sekali.
  write(envFile, 'TUNNEL_ADMIN_SSH_ALLOW=0\n');
  guard('apply');
  assert(chain(4, 'SC1FORCR_TUN_LOCAL').some((r) => r.includes('22,2222') && /REJECT/.test(r))
    && !chain(4, 'SC1FORCR_TUN_LOCAL').some((r) => r.includes('22,2222') && /-j RETURN/.test(r)),
    'TUNNEL_ADMIN_SSH_ALLOW=0 closes sshd to tunnels again');
  assert(guard('status').includes('SSH admin lewat VPN   : DITOLAK'));

  // Hanya penjaga port penyalahgunaan yang aktif.
  write(envFile, 'TUNNEL_LOCAL_GUARD_ENABLE=0\n');
  guard('apply');
  assert.deepStrictEqual(chains(4), ['SC1FORCR_SSH_GUARD', 'SC1FORCR_TUN_OUT']);
  assert.deepStrictEqual(chain(4, 'SC1FORCR_TUN_OUT'), ['-p tcp -m multiport --dports 3389,5900,5901,5902,445,135,139,25,465,587 -j REJECT --reject-with tcp-reset']);
  assert.strictEqual(chain(4, 'OUTPUT').length, 2, 'abuse ports still apply to root forwarders (Dropbear/ZIVPN/UDP Custom)');

  // Blokir SSH keluar kalau diaktifkan.
  write(envFile, 'TUNNEL_LOCAL_GUARD_ENABLE=0\nSSH_TUNNEL_BLOCK_OUTBOUND_SSH=1\n');
  guard('apply');
  assert(chain(4, 'SC1FORCR_TUN_OUT').includes('-p tcp -m multiport --dports 22,2222 -j REJECT --reject-with tcp-reset'), 'outbound SSH block covers the tunnel group');

  // Semua mati: tidak ada chain dan jump.
  write(envFile, 'TUNNEL_LOCAL_GUARD_ENABLE=0\nTUNNEL_ABUSE_GUARD_ENABLE=0\nSSH_BRUTE_GUARD_ENABLE=0\n');
  guard('apply');
  assert.deepStrictEqual(rules(4), [], `everything off must leave no rules:\n${read('rules4')}`);
  assert.deepStrictEqual(chains(4), []);
  assert.deepStrictEqual(chains(6), []);
  guard('apply');
  assert.strictEqual(read('writes'), '', 'apply while off must not touch iptables');

  // Tanpa ip6tables: IPv4 tetap terpasang. Lalu clear.
  write(envFile, '');
  fs.writeFileSync(path.join(tmp, 'no-ipt6'), '');
  guard('apply');
  assert.strictEqual(chains(4).length, 4, 'IPv4 still applied without ip6tables');
  fs.rmSync(path.join(tmp, 'no-ipt6'));
  guard('apply');
  const status = guard('status');
  assert(status.includes('Pembatas lokal/privat : AKTIF') && status.includes('AKTIF (port 22,2222)'), `status:\n${status}`);
  assert(status.includes('SSH admin lewat VPN   : DIIZINKAN (port 22,2222, 4/menit)'), `status:\n${status}`);
  guard('clear');
  assert.deepStrictEqual(rules(4), []);
  assert.deepStrictEqual(chains(4), []);
  assert.deepStrictEqual(rules(6), []);
  assert(!fs.existsSync(stateFile), 'clear removes the state file');
  assert(!/systemctl|daemon-reload/.test(fs.readFileSync(guardPath, 'utf8')), 'the periodic guard must never call systemctl (no daemon-reload from watchdog)');

  // ── Hardening sshd ──
  const sshDir = path.join(tmp, 'ssh');
  fs.mkdirSync(path.join(sshDir, 'sshd_config.d'), { recursive: true });
  const mainCfg = path.join(sshDir, 'sshd_config');
  const sshScript = path.join(tmp, 'sshd-harden.sh');
  // systemctl tiruan: unit aktif dibaca dari file active-units.
  write(path.join(bin, 'systemctl'), '#!/usr/bin/env bash\necho "systemctl $*" >> "${FAKE_DIR}/sys"\n' +
    'if [[ "$1" == "is-active" ]]; then grep -qx "${!#}" "${FAKE_DIR}/active-units" 2>/dev/null; exit $?; fi\nexit 0\n', 0o755);
  write(path.join(tmp, 'active-units'), 'ssh\ndropbear\n');
  write(path.join(bin, 'sshd'), '#!/usr/bin/env bash\nif [[ "$1" == "-t" ]]; then [[ -f "${FAKE_DIR}/sshd-invalid" ]] && exit 255; exit 0; fi\n[[ "$1" == "-T" ]] && cat "${FAKE_DIR}/sshd-T"\nexit 0\n', 0o755);
  write(sshScript, 'set -euo pipefail\nlog() { echo "LOG: $*"; }\nflag_enabled() { [[ "${1:-}" == "1" ]]; }\n' +
    `SSHD_CONFIG_FILE='${toBashPath(mainCfg)}'\nSSHD_CONFIG_DIR='${toBashPath(path.join(sshDir, 'sshd_config.d'))}'\n` +
    ['sshd_hardening_body', 'sshd_reload_if_active', 'sshd_top_block', 'apply_sshd_hardening'].map(fn).join('\n') +
    '\napply_sshd_hardening\n');
  const harden = (enable = '1') => {
    for (const f of ['sys']) fs.rmSync(path.join(tmp, f), { force: true });
    const r = spawnSync(bash, [toBashPath(sshScript)], { encoding: 'utf8', env: { ...baseEnv, SSHD_HARDEN_ENABLE: enable } });
    assert.strictEqual(r.status, 0, `sshd hardening failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const dropin = path.join(sshDir, 'sshd_config.d', '00-sc-1forcr.conf');
  const original = 'Include /etc/ssh/sshd_config.d/*.conf\nPort 22\nPermitRootLogin yes\nPasswordAuthentication yes\nX11Forwarding yes\nSubsystem sftp /usr/lib/openssh/sftp-server\n';
  write(mainCfg, original);
  write(path.join(tmp, 'sshd-T'), 'allowtcpforwarding local\nx11forwarding no\n');
  harden();
  assert(fs.readFileSync(dropin, 'utf8').includes('AllowTcpForwarding local'), 'drop-in written when sshd_config includes sshd_config.d');
  assert.strictEqual(fs.readFileSync(mainCfg, 'utf8'), original, 'sshd_config itself untouched when the drop-in is effective');
  assert(read('sys').includes('systemctl reload ssh'), 'sshd is reloaded (not restarted) after a change');
  assert(!/PermitRootLogin|PasswordAuthentication/.test(fs.readFileSync(dropin, 'utf8')), 'root/password login are never changed (owner must not be locked out)');
  harden();
  assert(!read('sys').includes('reload'), 'no reload when nothing changed');

  // Include ada tapi nilai lama yang menang: blok teratas dipasang.
  write(path.join(tmp, 'sshd-T'), 'allowtcpforwarding yes\n');
  harden();
  assert(fs.readFileSync(mainCfg, 'utf8').startsWith('# >>> sc-1forcr hardening >>>\n'), 'top block added when the drop-in is not effective');
  assert(fs.readFileSync(mainCfg, 'utf8').endsWith(original), 'the original config follows the block unchanged');

  // Tanpa Include: blok teratas, sekali saja.
  const noInclude = 'Port 22\nX11Forwarding yes\nMatch User backup\n    ForceCommand internal-sftp\n';
  write(mainCfg, noInclude);
  fs.rmSync(dropin, { force: true });
  harden();
  harden();
  const cfg = fs.readFileSync(mainCfg, 'utf8');
  assert.strictEqual(cfg.split('# >>> sc-1forcr hardening >>>').length - 1, 1, 'the block is added once');
  assert(cfg.startsWith('# >>> sc-1forcr hardening >>>\n') && cfg.endsWith(noInclude), 'block on top, existing Match blocks keep their place');

  // Config tidak valid: dipulihkan, tidak di-reload.
  write(mainCfg, original);
  fs.rmSync(dropin, { force: true });
  write(path.join(tmp, 'sshd-T'), 'allowtcpforwarding local\n');
  fs.writeFileSync(path.join(tmp, 'sshd-invalid'), '');
  const out = harden();
  assert.strictEqual(fs.readFileSync(mainCfg, 'utf8'), original, 'invalid config is rolled back');
  assert(!fs.existsSync(dropin), 'invalid drop-in is removed');
  assert(!read('sys').includes('reload') && out.includes('PERINGATAN'), 'no reload after a failed validation');
  fs.rmSync(path.join(tmp, 'sshd-invalid'));

  // Dimatikan: drop-in dan blok dibuang.
  harden();
  write(mainCfg, `# >>> sc-1forcr hardening >>>\nAllowTcpForwarding local\n# <<< sc-1forcr hardening <<<\n${original}`);
  harden('0');
  assert(!fs.existsSync(dropin) && fs.readFileSync(mainCfg, 'utf8') === original, 'SSHD_HARDEN_ENABLE=0 removes everything');
  assert(read('sys').includes('reload'), 'reload after removing the hardening');

  // ── Dropbear dan grup service ──
  const unitDir = path.join(tmp, 'systemd');
  fs.mkdirSync(path.join(unitDir, 'dropbear.service.d'), { recursive: true });
  const override = path.join(unitDir, 'dropbear.service.d', 'override.conf');
  const defaults = path.join(tmp, 'default-dropbear');
  write(override, '[Service]\nExecStart=\nExecStart=/usr/local/sbin/dropbear-2019.78 -R -E -F -K 30 -I 300 -p 109 -p 143 -b /etc/sc-1forcr/banner.html\n');
  write(defaults, 'NO_START=0\nDROPBEAR_PORT=109\nDROPBEAR_EXTRA_ARGS="-K 30 -I 300 -p 143"\n');
  const dbScript = path.join(tmp, 'dropbear.sh');
  write(dbScript, 'set -euo pipefail\nlog() { echo "LOG: $*"; }\n' +
    `SYSTEMD_UNIT_DIR='${toBashPath(unitDir)}'\nDROPBEAR_DEFAULTS_FILE='${toBashPath(defaults)}'\nTUNNEL_GROUP_NAME=sc-1forcr-tunnel\nZIVPN_SERVICE_NAME=zivpn\nUDPCUSTOM_SERVICE_NAME=sc-1forcr-udpcustom\n` +
    fn('ensure_dropbear_hardening_flags') + fn('install_tunnel_group_dropins') + '\nensure_dropbear_hardening_flags\ninstall_tunnel_group_dropins\n');
  const runDb = () => {
    fs.rmSync(path.join(tmp, 'sys'), { force: true });
    const r = spawnSync(bash, [toBashPath(dbScript)], { encoding: 'utf8', env: baseEnv });
    assert.strictEqual(r.status, 0, `dropbear script failed:\n${r.stdout}\n${r.stderr}`);
  };
  fs.writeFileSync(path.join(tmp, 'group-created'), '');
  runDb();
  assert(fs.readFileSync(override, 'utf8').includes('ExecStart=/usr/local/sbin/dropbear-2019.78 -R -E -F -w -k -K 30 -I 300 -p 109 -p 143 -b /etc/sc-1forcr/banner.html'),
    `existing override gets -w -k:\n${fs.readFileSync(override, 'utf8')}`);
  assert(fs.readFileSync(defaults, 'utf8').includes('DROPBEAR_EXTRA_ARGS="-w -k -K 30 -I 300 -p 143"'));
  assert(read('sys').includes('systemctl daemon-reload'), 'systemd reloads the changed override');
  assert(!read('sys').includes('systemctl restart dropbear'), 'a running Dropbear is not restarted (users stay connected)');
  for (const unit of ['dropbear', 'zivpn', 'sc-1forcr-udpcustom']) {
    assert.strictEqual(fs.readFileSync(path.join(unitDir, `${unit}.service.d`, '40-sc-1forcr-tunnel-group.conf'), 'utf8'),
      '[Service]\nGroup=sc-1forcr-tunnel\n', `${unit} runs with the tunnel group (user stays root)`);
  }
  runDb();
  assert.strictEqual(read('sys'), '', 'second run changes nothing and does not reload systemd');
  write(override, '[Service]\nExecStart=\nExecStart=/usr/sbin/dropbear -R -E -F -w -K 30 -p 109\n');
  write(path.join(tmp, 'active-units'), 'ssh\n');
  runDb();
  assert(fs.readFileSync(override, 'utf8').includes('ExecStart=/usr/sbin/dropbear -R -E -F -w -k -K 30 -p 109'), 'no duplicate flags');
  assert(read('sys').includes('systemctl restart dropbear'), 'a Dropbear that is down is started with the new flags');

  // ── Penyambungan di installer dan api.js ──
  assert.strictEqual(installer.split("printf -- '-w -k -K %s -I %s'").length - 1, 3, 'all three dropbear_runtime_args copies reject root and remote forwarding');
  assert(/const TUNNEL_GROUP = 'sc-1forcr-tunnel';/.test(installer) && installer.includes("'-s', shell, ...groupArgs, username"), 'new SSH accounts get the tunnel group');
  assert(installer.includes('GROUP="sc-1forcr-tunnel"') && installer.includes('TUNNEL_GROUP_NAME="sc-1forcr-tunnel"'), 'same group name everywhere');
  const install = installer.slice(installer.indexOf('run_install_step "00_license"'));
  const at = (s) => install.indexOf(s);
  assert(at('"09b_tunnel_group"') > 0 && at('"09b_tunnel_group"') < at('"10_dropbear"'), 'group drop-ins exist before Dropbear is first started');
  assert(at('"37b_tunnel_security"') > at('"37_tunnel_guard"') && at('"37b_tunnel_security"') < at('"38b_service_gate"'), 'tunnel guard before the service gate');
  assert(/apply_tunnel_outbound_guard_rules\n    install_tunnel_group_dropins\n    ensure_dropbear_hardening_flags\n    apply_tunnel_security\n    restart_update_safe_services\n[\s\S]*?apply_service_gates/.test(installer),
    'safe update applies the hardening before the service gate, without restarting tunnels');
  const watchdog = between(installer, "cat > /usr/local/sbin/sc-1forcr-postboot-health <<'POSTBOOT_HEALTH_EOF'\n", '\nPOSTBOOT_HEALTH_EOF\n');
  assert(watchdog.indexOf('sc-1forcr-tunnel-guard apply') > 0 && watchdog.indexOf('sc-1forcr-tunnel-guard apply') < watchdog.indexOf('sc-1forcr-service-gate apply'),
    'watchdog re-applies the guard before the service gate');
  for (const key of ['TUNNEL_LOCAL_GUARD_ENABLE', 'TUNNEL_ADMIN_SSH_ALLOW', 'SSH_BRUTE_GUARD_ENABLE', 'SSHD_HARDEN_ENABLE']) {
    assert.strictEqual(installer.split(`${key}=\${${key}}\n`).length - 1, 2, `${key} must be in both env dumps`);
    assert.strictEqual(installer.split(`    "${key}",\n`).length - 1, 2, `${key} must be in both backup setting lists`);
    assert(new RegExp(`vars=\\([\\s\\S]*\\b${key}\\b[\\s\\S]*?\\n  \\)`).test(installer), `${key} must survive a pending install`);
  }
  assert(installer.includes('/usr/local/sbin/sc-1forcr-tunnel-guard clear') && installer.includes('rm -f /etc/ssh/sshd_config.d/00-sc-1forcr.conf'), 'uninstall cleans up');

  console.log('tunnel security tests passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

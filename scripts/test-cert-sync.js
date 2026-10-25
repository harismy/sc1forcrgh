'use strict';

// Sinkron cert TLS HAProxy (sc-1forcr-cert-sync). Pernah terjadi sungguhan:
// - HAProxy menyajikan cert Let's Encrypt yang sudah kedaluwarsa walau certbot
//   sudah renew, karena pem gabungan di /etc/haproxy/certs hanya dibangun saat
//   install penuh;
// - cert self-signed sementara (3 hari) saat Let's Encrypt gagal tidak pernah
//   diganti.
// Yang dijaga: pem hanya diganti kalau cert live lebih baru, lolos haproxy -c,
// dan kuncinya cocok; gagal = pem lama dipulihkan; reload hanya saat berubah;
// ensure mencoba certbot lagi paling sering sekali per 12 jam.

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

const script = extract(installer, "cat > /usr/local/sbin/sc-1forcr-cert-sync <<'CERT_SYNC_EOF'\n", '\nCERT_SYNC_EOF\n');
const setupFn = extract(installer, 'setup_cert_sync() {\n', '\n}\n\n# Simpan permintaan cert terakhir');
const helperMarker = 'write_cert_request_file() {\n';
const helperInstaller = extract(installer, helperMarker, '\n}\n');
const menuStart = installer.indexOf("<<'MENU_SCRIPT_EOF'");
assert(menuStart > 0, 'menu heredoc not found');
const helperMenu = extract(installer, helperMarker, '\n}\n', menuStart);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-cert-sync-'));
const bin = path.join(tmp, 'bin');
const certs = path.join(tmp, 'certs');
const live = path.join(tmp, 'live');
const state = path.join(tmp, 'state');
const fixtures = path.join(tmp, 'fixtures');
for (const d of [bin, certs, live, state, fixtures]) fs.mkdirSync(d);
const scriptPath = path.join(tmp, 'sc-1forcr-cert-sync');
fs.writeFileSync(scriptPath, `${script}\n`);
// Helper diuji dengan path state milik test, bukan /var/lib asli.
const helperPath = path.join(tmp, 'write-request.sh');
fs.writeFileSync(helperPath, `write_cert_request_file() {\n${helperInstaller.replace(/\/var\/lib\/sc-1forcr/g, '"${TEST_STATE_DIR}"')}\n}\nwrite_cert_request_file "$@"\n`);

fs.writeFileSync(path.join(bin, 'haproxy'), `#!/usr/bin/env bash
echo "haproxy $*" >> "\${FAKE_DIR}/haproxy-calls"
[[ -f "\${FAKE_DIR}/haproxy-bad" ]] && exit 1
exit 0
`);
fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash
case "$1" in
  is-active) [[ -f "\${FAKE_DIR}/haproxy-down" ]] && exit 3; exit 0 ;;
  reload) echo "$2" >> "\${FAKE_DIR}/reloads"; exit 0 ;;
  *) echo "systemctl $*" >> "\${FAKE_DIR}/systemctl-other"; exit 0 ;;
esac
`);
// certbot tiruan: catat argumen; mode "issue" menaruh cert berikutnya di live.
fs.writeFileSync(path.join(bin, 'certbot'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_DIR}/certbot-calls"
mode="$(cat "\${FAKE_DIR}/certbot-mode" 2>/dev/null)"
if [[ "\${mode}" == "fail" ]]; then
  echo "Some challenges have failed."
  echo "Detail: DNS problem: NXDOMAIN looking up A for alias.example.net"
  exit 1
fi
name=""
while (( $# )); do
  [[ "$1" == "--cert-name" ]] && name="$2"
  shift
done
mkdir -p "\${CERT_SYNC_LIVE_DIR}/\${name}"
cp "\${FAKE_DIR}/next-fullchain.pem" "\${CERT_SYNC_LIVE_DIR}/\${name}/fullchain.pem"
cp "\${FAKE_DIR}/next-privkey.pem" "\${CERT_SYNC_LIVE_DIR}/\${name}/privkey.pem"
exit 0
`);
for (const f of ['haproxy', 'systemctl', 'certbot']) fs.chmodSync(path.join(bin, f), 0o755);

// Config openssl milik test, supaya OPENSSL_CONF dari mesin penguji tidak ikut
// terbaca. Subjek cert ada di config (prompt = no), jadi tidak perlu -subj yang
// diubah jadi path oleh Git Bash. Path config ditulis dalam format OS asli,
// karena openssl di Git Bash adalah build Windows.
const opensslConf = path.join(tmp, 'openssl.cnf');
fs.writeFileSync(opensslConf, '[ req ]\ndistinguished_name = dn\nprompt = no\n[ dn ]\nCN = vpn.example.com\n');

// Cert uji dibuat dengan openssl sungguhan; yang dibandingkan masa berlakunya.
function makeCert(name, days) {
  const crt = path.join(fixtures, `${name}.crt`);
  const key = path.join(fixtures, `${name}.key`);
  const r = spawnSync(bash, ['-c', `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days ${days} -keyout '${toBashPath(key)}' -out '${toBashPath(crt)}'`], {
    encoding: 'utf8',
    env: { ...process.env, OPENSSL_CONF: opensslConf }
  });
  assert.strictEqual(r.status, 0, `openssl failed:\n${r.stderr}`);
  return { crt: fs.readFileSync(crt, 'utf8'), key: fs.readFileSync(key, 'utf8') };
}
const selfSigned = makeCert('selfsigned', 3);
const fresh = makeCert('fresh', 90);
const expiring = makeCert('expiring', 10);

const read = (f) => (fs.existsSync(path.join(tmp, f)) ? fs.readFileSync(path.join(tmp, f), 'utf8') : '');
const lines = (f) => read(f).split('\n').filter(Boolean);

function writeCfg(name) {
  fs.writeFileSync(path.join(tmp, 'haproxy.cfg'), [
    'global',
    '    maxconn 4096',
    'frontend ft_443',
    `    bind *:443 ssl crt ${toBashPath(path.join(certs, `${name}.pem`))} alpn h2,http/1.1 ssl-min-ver TLSv1.0 ssl-max-ver TLSv1.3`,
    '    default_backend bk_mux',
    ''
  ].join('\n'));
}
const pemPath = (name) => path.join(certs, `${name}.pem`);
const setPem = (name, cert) => fs.writeFileSync(pemPath(name), cert.crt + cert.key);
function setLive(name, cert, key = cert.key) {
  fs.mkdirSync(path.join(live, name), { recursive: true });
  fs.writeFileSync(path.join(live, name, 'fullchain.pem'), cert.crt);
  fs.writeFileSync(path.join(live, name, 'privkey.pem'), key);
}
function reset() {
  for (const f of ['haproxy-calls', 'reloads', 'systemctl-other', 'certbot-calls', 'certbot-mode', 'haproxy-bad', 'haproxy-down',
    'next-fullchain.pem', 'next-privkey.pem']) fs.rmSync(path.join(tmp, f), { force: true });
  for (const d of [certs, live, state]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d);
  }
}
function clearCalls() {
  for (const f of ['haproxy-calls', 'reloads', 'certbot-calls']) fs.rmSync(path.join(tmp, f), { force: true });
}
const env = {
  ...process.env,
  PATH: `${toBashPath(bin)}:${process.env.PATH}`,
  FAKE_DIR: toBashPath(tmp),
  CERT_SYNC_HAPROXY_CFG: toBashPath(path.join(tmp, 'haproxy.cfg')),
  CERT_SYNC_LIVE_DIR: toBashPath(live),
  CERT_SYNC_STATE_DIR: toBashPath(state),
  CERT_SYNC_LOCK_FILE: toBashPath(path.join(tmp, 'lock')),
  CERT_SYNC_WEBROOT: '/var/www/html',
  CERT_SYNC_CF_CREDENTIALS: toBashPath(path.join(tmp, 'cloudflare.ini')),
  TEST_STATE_DIR: toBashPath(state),
  OPENSSL_CONF: opensslConf
};
function run(cmd, expectStatus = 0) {
  const r = spawnSync(bash, [toBashPath(scriptPath), cmd], { encoding: 'utf8', env });
  assert.strictEqual(r.status, expectStatus, `${cmd} exit ${r.status}, expected ${expectStatus}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function writeRequest(...args) {
  const r = spawnSync(bash, [toBashPath(helperPath), ...args], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `write_cert_request_file failed:\n${r.stderr}`);
}
const setAttempt = (secondsAgo) => fs.writeFileSync(path.join(state, 'cert-attempt'), `${Math.floor(Date.now() / 1000) - secondsAgo}\n`);
const leftovers = () => fs.readdirSync(certs).filter((f) => /\.(new|sc-bak)$/.test(f));

try {
  // 1. Belum ada cert LE: sync tidak menyentuh apa pun.
  reset();
  writeCfg('vpn.example.com');
  setPem('vpn.example.com', selfSigned);
  run('sync');
  assert.strictEqual(fs.readFileSync(pemPath('vpn.example.com'), 'utf8'), selfSigned.crt + selfSigned.key, 'no live cert = pem untouched');
  assert.strictEqual(read('reloads'), '', 'no live cert = no reload');

  // 2. certbot sudah renew: pem dibangun ulang dari live, dicek haproxy -c, reload sekali.
  setLive('vpn.example.com', fresh);
  let out = run('sync');
  assert.strictEqual(fs.readFileSync(pemPath('vpn.example.com'), 'utf8'), fresh.crt + fresh.key, 'pem must be rebuilt from live fullchain + privkey');
  assert.match(read('haproxy-calls'), /^haproxy -c -f .*haproxy\.cfg\n$/, 'new pem must pass haproxy -c');
  assert.deepStrictEqual(lines('reloads'), ['haproxy'], 'exactly one graceful reload');
  assert.match(out, /Cert HAProxy diperbarui: vpn\.example\.com, berlaku sampai \d{4}-\d{2}-\d{2}/);
  assert.deepStrictEqual(leftovers(), [], 'no temp or backup files left');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(pemPath('vpn.example.com')).mode & 0o777, 0o600, 'pem holds the private key');
  }

  // 3. Siklus berikutnya tanpa perubahan: tidak ada haproxy -c dan tidak ada reload.
  clearCalls();
  run('sync');
  assert.strictEqual(read('reloads'), '', 'unchanged sync must not reload');
  assert.strictEqual(read('haproxy-calls'), '', 'unchanged sync must not even validate');

  // 4. Cert live lebih tua dari pem (mis. cert pasang manual): pem dibiarkan.
  setLive('vpn.example.com', expiring);
  run('sync');
  assert.strictEqual(fs.readFileSync(pemPath('vpn.example.com'), 'utf8'), fresh.crt + fresh.key, 'an older live cert must not replace a newer pem');
  assert.strictEqual(read('reloads'), '');

  // 5. haproxy -c menolak pem baru: pem lama dipulihkan, tanpa reload.
  reset();
  writeCfg('vpn.example.com');
  setPem('vpn.example.com', selfSigned);
  setLive('vpn.example.com', fresh);
  fs.writeFileSync(path.join(tmp, 'haproxy-bad'), '');
  out = run('sync', 1);
  assert.strictEqual(fs.readFileSync(pemPath('vpn.example.com'), 'utf8'), selfSigned.crt + selfSigned.key, 'rejected pem must be rolled back');
  assert.strictEqual(read('reloads'), '', 'no reload after a failed check');
  assert.match(out, /pem lama dipulihkan/);
  assert.deepStrictEqual(leftovers(), [], 'rollback leaves no temp or backup files');

  // 6. Kunci privat bukan pasangan cert: pem tidak diubah sama sekali.
  fs.rmSync(path.join(tmp, 'haproxy-bad'));
  clearCalls();
  setLive('vpn.example.com', fresh, expiring.key);
  out = run('sync', 1);
  assert.strictEqual(fs.readFileSync(pemPath('vpn.example.com'), 'utf8'), selfSigned.crt + selfSigned.key, 'mismatched key must not be installed');
  assert.strictEqual(read('haproxy-calls'), '', 'mismatched key is caught before haproxy -c');
  assert.match(out, /tidak cocok/);

  // 7. HAProxy sedang mati: pem tetap diperbarui, tapi tidak di-reload (bukan tugas script ini menyalakan).
  setLive('vpn.example.com', fresh);
  fs.writeFileSync(path.join(tmp, 'haproxy-down'), '');
  run('sync');
  assert.strictEqual(fs.readFileSync(pemPath('vpn.example.com'), 'utf8'), fresh.crt + fresh.key);
  assert.strictEqual(read('reloads'), '', 'inactive HAProxy is not reloaded');
  assert.strictEqual(read('systemctl-other'), '', 'only is-active/reload are ever called');

  // 8. ensure: LE belum pernah terbit (self-signed sementara) -> terbitkan lagi dengan
  //    permintaan yang disimpan installer, lalu pem diganti.
  reset();
  writeCfg('vpn.example.com');
  setPem('vpn.example.com', selfSigned);
  writeRequest('webroot', 'vpn.example.com', '', 'vpn.example.com', 'alias.example.net');
  fs.rmSync(path.join(state, 'cert-attempt'));
  fs.writeFileSync(path.join(tmp, 'next-fullchain.pem'), fresh.crt);
  fs.writeFileSync(path.join(tmp, 'next-privkey.pem'), fresh.key);
  out = run('ensure');
  assert.deepStrictEqual(lines('certbot-calls'), [
    'certonly --cert-name vpn.example.com --expand --non-interactive --agree-tos --webroot -w /var/www/html -d vpn.example.com -d alias.example.net --register-unsafely-without-email'
  ], 'ensure must reissue with the saved domains');
  assert.strictEqual(fs.readFileSync(pemPath('vpn.example.com'), 'utf8'), fresh.crt + fresh.key, 'issued cert must reach HAProxy');
  assert.deepStrictEqual(lines('reloads'), ['haproxy']);
  assert(/^\d+$/.test(read('state/cert-attempt').trim()), 'attempt time is recorded');

  // 9. Cert masih panjang: ensure tidak memanggil certbot.
  clearCalls();
  run('ensure');
  assert.strictEqual(read('certbot-calls'), '', 'no certbot while the cert has > 30 days left');

  // 10. Batas 12 jam antar percobaan (Let's Encrypt membatasi validasi gagal).
  reset();
  writeCfg('vpn.example.com');
  setPem('vpn.example.com', selfSigned);
  writeRequest('webroot', 'vpn.example.com', 'owner@vpn.example.com', 'vpn.example.com');
  fs.writeFileSync(path.join(tmp, 'certbot-mode'), 'fail');
  run('ensure');
  assert.strictEqual(read('certbot-calls'), '', 'the installer attempt just now counts: no second attempt within 12h');
  setAttempt(11 * 3600);
  run('ensure');
  assert.strictEqual(read('certbot-calls'), '', 'still within 12h');
  setAttempt(13 * 3600);
  out = run('ensure');
  assert.deepStrictEqual(lines('certbot-calls'), [
    'certonly --cert-name vpn.example.com --expand --non-interactive --agree-tos --webroot -w /var/www/html -d vpn.example.com -m owner@vpn.example.com'
  ], 'retry after 12h, with the saved email');
  assert.match(out, /certbot gagal \(kode 1\); dicoba lagi paling cepat 12 jam lagi/);
  assert.match(out, /\[cert-sync\] {3}Detail: DNS problem/, 'certbot reason is logged for the owner');
  assert.strictEqual(fs.readFileSync(pemPath('vpn.example.com'), 'utf8'), selfSigned.crt + selfSigned.key, 'failed issue leaves the pem alone');
  clearCalls();
  run('ensure');
  assert.strictEqual(read('certbot-calls'), '', 'a failed attempt also starts the 12h wait');

  // 11. Cert LE ada tapi tinggal <= 30 hari: minta certbot renew untuk lineage itu.
  reset();
  writeCfg('vpn.example.com');
  setPem('vpn.example.com', expiring);
  setLive('vpn.example.com', expiring);
  fs.writeFileSync(path.join(tmp, 'next-fullchain.pem'), fresh.crt);
  fs.writeFileSync(path.join(tmp, 'next-privkey.pem'), fresh.key);
  run('ensure');
  assert.deepStrictEqual(lines('certbot-calls'), ['renew --cert-name vpn.example.com --non-interactive']);
  assert.strictEqual(fs.readFileSync(pemPath('vpn.example.com'), 'utf8'), fresh.crt + fresh.key, 'renewed cert must reach HAProxy');

  // 12. Wildcard (DNS-01 Cloudflare): *.domain tidak boleh di-glob, kredensial wajib ada.
  reset();
  writeCfg('example.com');
  setPem('example.com', selfSigned);
  writeRequest('cloudflare', 'example.com', '', 'example.com', '*.example.com', 'vpn.other.net');
  fs.rmSync(path.join(state, 'cert-attempt'));
  out = run('ensure');
  assert.strictEqual(read('certbot-calls'), '', 'no credentials = no attempt');
  assert.match(out, /Kredensial Cloudflare/);
  fs.writeFileSync(path.join(tmp, 'cloudflare.ini'), 'dns_cloudflare_api_key = x\n');
  fs.writeFileSync(path.join(tmp, 'next-fullchain.pem'), fresh.crt);
  fs.writeFileSync(path.join(tmp, 'next-privkey.pem'), fresh.key);
  run('ensure');
  assert.deepStrictEqual(lines('certbot-calls'), [
    `certonly --cert-name example.com --expand --non-interactive --agree-tos --dns-cloudflare --dns-cloudflare-credentials ${toBashPath(path.join(tmp, 'cloudflare.ini'))} --dns-cloudflare-propagation-seconds 30 -d example.com -d *.example.com -d vpn.other.net --register-unsafely-without-email`
  ]);
  fs.rmSync(path.join(tmp, 'cloudflare.ini'));

  // 13. Permintaan tersimpan untuk domain lain (domain sudah diganti): dilewati.
  reset();
  writeCfg('new.example.com');
  setPem('new.example.com', selfSigned);
  writeRequest('webroot', 'old.example.com', '', 'old.example.com');
  fs.rmSync(path.join(state, 'cert-attempt'));
  out = run('ensure');
  assert.strictEqual(read('certbot-calls'), '', 'a request for another domain must not be used');
  assert.match(out, /bukan untuk domain HAProxy/);

  // 14. status untuk pemilik VPS.
  reset();
  writeCfg('vpn.example.com');
  setPem('vpn.example.com', selfSigned);
  out = run('status');
  assert.match(out, /Cert HAProxy : .*vpn\.example\.com\.pem/);
  assert.match(out, /Berlaku s\/d  : \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(2 hari lagi\)/);
  assert.match(out, /Penerbit     : self-signed \(sementara\)/);
  assert.match(out, /Cert LE live : belum ada/);
  setLive('vpn.example.com', fresh);
  assert.match(run('status'), /Cert LE live : .* \(89 hari lagi\)/);
  run('bogus', 2);

  // Penyambungan di installer.
  assert(/activate_haproxy_connection_hardening_if_needed\n    setup_cert_sync\n/.test(installer), 'update path syncs the cert (after HAProxy config is final)');
  assert(/run_install_step "14_haproxy_mux"[^\n]*\n  run_install_step "14b_cert_sync" 57 "[^"]+" setup_cert_sync\n/.test(installer), 'install path sets up cert sync right after HAProxy');
  const afterHeredoc = setupFn.slice(setupFn.indexOf('\nCERT_SYNC_EOF\n'));
  assert(!/return 1/.test(afterHeredoc) && /return 0$/.test(afterHeredoc.trim()), 'setup_cert_sync must never fail install/update');
  assert(afterHeredoc.includes('cat > /etc/letsencrypt/renewal-hooks/deploy/sc-1forcr-haproxy'), 'certbot deploy hook is installed');
  assert(afterHeredoc.includes('exec /usr/local/sbin/sc-1forcr-cert-sync sync'), 'deploy hook runs sync');
  const service = extract(afterHeredoc, "cat > /etc/systemd/system/sc-1forcr-cert-sync.service <<'EOF'\n", '\nEOF\n');
  for (const key of ['MemoryMax=', 'Nice=', 'CPUQuota=', 'ExecStart=/usr/local/sbin/sc-1forcr-cert-sync ensure']) {
    assert(service.includes(key), `service must have ${key}`);
  }
  const timer = extract(afterHeredoc, "cat > /etc/systemd/system/sc-1forcr-cert-sync.timer <<'EOF'\n", '\nEOF\n');
  assert(/^OnUnitInactiveSec=12h$/m.test(timer), 'timer must repeat (OnUnitInactiveSec)');
  assert(/^OnBootSec=/m.test(timer), 'timer must also run after reboot');
  const scriptCode = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert(!/daemon-reload|systemctl (restart|enable|disable|start|stop)/.test(scriptCode), 'the periodic script must not reload units or restart services');
  assert(script.indexOf('haproxy -c -f') < script.indexOf('systemctl reload haproxy'), 'haproxy -c before reload');
  assert.strictEqual(helperInstaller, helperMenu, 'write_cert_request_file must be identical in installer and menu');
  assert.strictEqual(installer.split('write_cert_request_file webroot "${cert_domain}"').length - 1, 2, 'both issue_letsencrypt_cert copies save webroot requests');
  assert.strictEqual(installer.split('write_cert_request_file cloudflare "${WILDCARD_BASE_DOMAIN}"').length - 1, 2, 'both copies save wildcard requests');
  for (const needle of [
    'systemctl disable --now sc-1forcr-cert-sync.timer',
    'rm -f /etc/systemd/system/sc-1forcr-cert-sync.service',
    'rm -f /etc/systemd/system/sc-1forcr-cert-sync.timer',
    'rm -f /usr/local/sbin/sc-1forcr-cert-sync',
    'rm -f /etc/letsencrypt/renewal-hooks/deploy/sc-1forcr-haproxy'
  ]) {
    assert(installer.includes(needle), `uninstall must run: ${needle}`);
  }

  console.log('cert sync tests passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

'use strict';

// Link akun Xray: HTTPUpgrade (TLS/non-TLS), XHTTP VLESS (TLS/non-TLS, hanya
// saat XHTTP aktif), dan OneRing untuk aplikasi 1FTunnel. Test memastikan:
// - link memakai path inbound yang benar-benar ada di config Xray,
// - "Upgrade" benar-benar httpupgrade, bukan salinan link WS,
// - OneRing sama persis dengan contoh pemilik, bug diganti domain server,
// - nginx meneruskan /xhvless lewat HTTP/1.1 (non-TLS) dan h2 (TLS),
// - manager real-IP ikut memasang header di location /up* dan /xhvless,
// - output CLI menampilkan link baru hanya kalau API mengirimnya.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function extract(source, startMarker, endMarker, keepStart = true) {
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

const api = extract(installer, 'cat > "${APP_DIR}/api.js" <<\'EOF\'\n', '\nEOF\n', false);
const menu = extract(installer, "cat > \"${menu_runtime_tmp}\" <<'MENU_SCRIPT_EOF'\n", '\nMENU_SCRIPT_EOF\n', false);

// --- Builder link, dijalankan dari kode api.js asli ---
const builders = extract(api, 'function vmessLink(', '\nfunction addFrontBugLink(');
function loadBuilders(env) {
  const ctx = vm.createContext({
    Buffer,
    process: { env },
    VMESS_BUG_PROFILE_ALLOW_INSECURE: false,
    VMESS_BUG_PROFILE_SNI: '', VMESS_BUG_PROFILE_ADDRESS: '', VMESS_BUG_PROFILE_HOST: '',
    XRAY_PUBLIC_HOST: '', DOMAIN: '',
    XRAY_PATH_VMESS: '/vmess', XRAY_PATH_VLESS: '/vless', XRAY_PATH_TROJAN: '/trojan'
  });
  new vm.Script(`${extract(api, 'function normalizeHost(', '\n}\n')}\n}\n${builders}\nthis.out = {
    vmessLink, vmessUpgradeLink, vlessUpgradeLink, trojanUpgradeLink, vlessXhttpLink,
    vmessOneringLink, vlessOneringLink, trojanOneringLink, XRAY_UPGRADE_PATH, XRAY_XHTTP_PATH_VLESS, XRAY_XHTTP_ENABLED
  };`).runInContext(ctx);
  return ctx.out;
}
const L = loadBuilders({});
assert.strictEqual(L.XRAY_XHTTP_ENABLED, false, 'XHTTP links are off by default');
assert.strictEqual(loadBuilders({ XRAY_XHTTP_ENABLE: '1' }).XRAY_XHTTP_ENABLED, true, 'XRAY_XHTTP_ENABLE=1 enables XHTTP links');

const host = 'id3-grey.1forcrkuota.com';
const uuid = 'f5029bdf-8cf4-426a-ae59-b58c429fbcdc';
const vmessJson = (link) => {
  assert(link.startsWith('vmess://'), link);
  return JSON.parse(Buffer.from(link.slice('vmess://'.length), 'base64').toString('utf8'));
};
const urlParts = (link) => {
  const u = new URL(link);
  return { scheme: u.protocol, port: u.port, host: u.hostname, user: decodeURIComponent(u.username), q: Object.fromEntries(u.searchParams), name: decodeURIComponent(u.hash.slice(1)) };
};

// Path link harus sama dengan path inbound Xray.
const runtimeBuilder = extract(api, 'function buildXrayRuntimeConfig(', '\n}\n');
for (const [proto, p] of Object.entries(L.XRAY_UPGRADE_PATH)) {
  assert(runtimeBuilder.includes(`httpupgradeSettings: { path: '${p}' }`), `${proto} upgrade path ${p} must exist in the Xray config`);
}
assert(runtimeBuilder.includes(`xhttpSettings: { path: '${L.XRAY_XHTTP_PATH_VLESS}'`), 'XHTTP path must exist in the Xray config');

// HTTPUpgrade VMess.
const upVmessTls = vmessJson(L.vmessUpgradeLink(host, uuid, true, 'budi'));
assert.deepStrictEqual(
  [upVmessTls.net, upVmessTls.path, upVmessTls.port, upVmessTls.tls, upVmessTls.add, upVmessTls.host, upVmessTls.sni, upVmessTls.alpn, upVmessTls.ps],
  ['httpupgrade', '/upvmess', '443', 'tls', host, host, host, 'http/1.1', 'budi']);
const upVmessNtls = vmessJson(L.vmessUpgradeLink(host, uuid, false, 'budi'));
assert.deepStrictEqual([upVmessNtls.net, upVmessNtls.path, upVmessNtls.port, upVmessNtls.tls], ['httpupgrade', '/upvmess', '80', 'none']);
assert.notStrictEqual(L.vmessUpgradeLink(host, uuid, true, 'budi'), L.vmessLink(host, uuid, true, 'budi'), 'upgrade link must not be a copy of the WS link');

// HTTPUpgrade VLESS/Trojan.
for (const [fnName, scheme, p] of [['vlessUpgradeLink', 'vless:', '/upvless'], ['trojanUpgradeLink', 'trojan:', '/uptrojan']]) {
  const tls = urlParts(L[fnName](host, uuid, true, 'budi'));
  assert.deepStrictEqual([tls.scheme, tls.port, tls.host, tls.user, tls.q.type, tls.q.path, tls.q.security, tls.q.sni, tls.q.host, tls.q.alpn, tls.name],
    [scheme, '443', host, uuid, 'httpupgrade', p, 'tls', host, host, 'http/1.1', 'budi'], `${fnName} TLS`);
  const ntls = urlParts(L[fnName](host, uuid, false, 'budi'));
  assert.deepStrictEqual([ntls.port, ntls.q.type, ntls.q.path, ntls.q.security, ntls.q.host], ['80', 'httpupgrade', p, 'none', host], `${fnName} non-TLS`);
  assert(!('sni' in ntls.q), `${fnName} non-TLS must not carry an SNI`);
}

// XHTTP VLESS: TLS lewat h2, non-TLS lewat HTTP/1.1 port 80.
const xTls = urlParts(L.vlessXhttpLink(host, uuid, true, 'budi'));
assert.deepStrictEqual([xTls.port, xTls.q.type, xTls.q.path, xTls.q.security, xTls.q.sni, xTls.q.alpn, xTls.q.mode, xTls.q.encryption],
  ['443', 'xhttp', '/xhvless', 'tls', host, 'h2', 'auto', 'none']);
const xNtls = urlParts(L.vlessXhttpLink(host, uuid, false, 'budi'));
assert.deepStrictEqual([xNtls.port, xNtls.q.type, xNtls.q.path, xNtls.q.security, xNtls.q.host], ['80', 'xhttp', '/xhvless', 'none', host]);

// OneRing: sama persis dengan contoh pemilik, bug listen.noice.id diganti domain server.
const example = vmessJson('vmess://eyJ2IjoiMiIsInBzIjoiaWQzLVdBLW9uZXJpbmciLCJhZGQiOiJpZDMtZ3JleS4xZm9yY3JrdW90YS5jb20iLCJwb3J0IjoiNDQzIiwiaWQiOiJmNTAyOWJkZi04Y2Y0LTQyNmEtYWU1OS1iNThjNDI5ZmJjZGMiLCJhaWQiOiIwIiwic2N5IjoiYXV0byIsIm5ldCI6IndzIiwidHlwZSI6Im5vbmUiLCJob3N0IjoiaWQzLWdyZXkuMWZvcmNya3VvdGEuY29tIiwicGF0aCI6Ii92bWVzcyIsInRscyI6InRscyIsInNuaSI6Im9uZXJpbmc6bGlzdGVuLm5vaWNlLmlkOmlkMy1ncmV5LjFmb3Jjcmt1b3RhLmNvbSIsImFscG4iOiJodHRwLzEuMSIsImFsbG93SW5zZWN1cmUiOiIxIn0=');
const onering = vmessJson(L.vmessOneringLink(host, uuid, 'id3-WA'));
assert.deepStrictEqual(Object.keys(onering), Object.keys(example), 'OneRing must keep the field order of the 1FTunnel example');
assert.deepStrictEqual(onering, { ...example, sni: `onering:${host}:${host}` }, 'OneRing must match the example with the server domain as bug');
for (const [fnName, scheme, p] of [['vlessOneringLink', 'vless:', '/vless'], ['trojanOneringLink', 'trojan:', '/trojan']]) {
  const o = urlParts(L[fnName](host, uuid, 'id3-WA'));
  assert.deepStrictEqual([o.scheme, o.port, o.q.type, o.q.path, o.q.security, o.q.sni, o.q.host, o.q.alpn, o.q.allowInsecure, o.name],
    [scheme, '443', 'ws', p, 'tls', `onering:${host}:${host}`, host, 'http/1.1', '1', 'id3-WA-onering'], fnName);
}

// Akun baru memakai builder di atas; XHTTP hanya untuk VLESS dan hanya saat aktif.
const createXray = extract(api, 'async function createXray(', '\n}\n');
for (const proto of ['vmess', 'vless', 'trojan']) {
  assert(createXray.includes(`uptls: ${proto}UpgradeLink(`) && createXray.includes(`upntls: ${proto}UpgradeLink(`), `${proto} upgrade links must be httpupgrade`);
  assert(createXray.includes(`onering: ${proto}OneringLink(`), `${proto} must include the OneRing link`);
}
assert(/\.\.\.\(XRAY_XHTTP_ENABLED \? \{\s*xhttptls: vlessXhttpLink\(xrayHost, uuid, true, finalUsername\),\s*xhttpntls: vlessXhttpLink\(xrayHost, uuid, false, finalUsername\)\s*\} : \{\}\)/.test(createXray),
  'XHTTP links only when XHTTP is enabled');
assert.strictEqual((createXray.match(/vlessXhttpLink/g) || []).length, 2, 'XHTTP links are VLESS only');

// --- nginx: /xhvless HTTP/1.1 di blok 80/8083 dan h2 di blok 8081, dua salinan identik ---
const nginxInstall = extract(installer, 'cat > /etc/nginx/sites-available/sc-1forcr.conf <<EOF\n', '\nEOF\n', false);
const nginxChange = extract(installer, 'cat > /etc/nginx/sites-available/sc-1forcr.conf <<EONGINX\n', '\nEONGINX\n', false);
assert.strictEqual(nginxChange, nginxInstall, 'install and change-domain nginx configs must stay identical');
const wsServer = extract(nginxInstall, 'listen 80;', '\nserver {');
const h2Server = nginxInstall.slice(nginxInstall.indexOf('listen 127.0.0.1:8081 http2;'));
const h1Xhttp = extract(wsServer, '    location /xhvless {', '\n    }\n');
assert(h1Xhttp.includes('proxy_pass http://127.0.0.1:12002;') && h1Xhttp.includes('proxy_request_buffering off;') && h1Xhttp.includes('proxy_buffering off;'),
  'port 80/8083 must stream XHTTP over HTTP/1.1');
assert(extract(h2Server, '    location /xhvless {', '\n    }\n').includes('grpc_pass grpc://127.0.0.1:12002;'), 'port 8081 must forward XHTTP h2');
for (const [loc, port] of [['/upvmess', 10004], ['/upvless', 10005], ['/uptrojan', 10006]]) {
  assert(extract(wsServer, `    location ${loc} {`, '\n    }\n').includes(`proxy_pass http://127.0.0.1:${port};`), `${loc} must reach Xray`);
}

// --- Manager real-IP memasang header di semua location Xray, termasuk /up* dan /xhvless ---
const bash = resolveBash();
const toBashPath = (p) => (process.platform === 'win32'
  ? spawnSync(bash, ['-c', `cygpath -u '${p}'`], { encoding: 'utf8' }).stdout.trim()
  : p);
const realipAwk = extract(installer, 'awk -v have_map="${have_map}" -v have_ws="${have_ws}" -v have_grpc="${have_grpc}" \'\n', '\n  \' "${NGINX_CONF}" > "${tmp}"', false);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-xray-links-'));
try {
  const conf = path.join(tmpDir, 'nginx.conf');
  fs.writeFileSync(conf, nginxInstall.replace(/\\\$/g, '$').replace(/^\$\{xray_(proxy|grpc)_realip_headers\}\n/gm, ''));
  const prog = path.join(tmpDir, 'realip.awk');
  fs.writeFileSync(prog, realipAwk);
  const patched = spawnSync(bash, ['-c', `awk -v have_map=0 -v have_ws=1 -v have_grpc=0 -f '${toBashPath(prog)}' '${toBashPath(conf)}'`], { encoding: 'utf8' });
  assert.strictEqual(patched.status, 0, patched.stderr);
  const blocks = [];
  let current = null;
  for (const line of patched.stdout.split('\n')) {
    const m = /^\s*location\s+(\S+)\s*\{/.exec(line);
    if (m) { current = { loc: m[1], lines: [] }; blocks.push(current); continue; }
    if (current && /^\s*\}\s*$/.test(line)) { current = null; continue; }
    if (current) current.lines.push(line);
  }
  for (const loc of ['/vmess', '/upvmess', '/upvless', '/uptrojan', '/xhvless', '/vless-grpc']) {
    const found = blocks.filter((b) => b.loc === loc);
    assert(found.length > 0, `location ${loc} missing`);
    for (const b of found) {
      assert(b.lines.some((l) => /(proxy|grpc)_set_header X-SC-Real-IP-Proxy "1";/.test(l)), `real-IP manager must patch ${loc}`);
    }
  }
  assert.strictEqual(blocks.filter((b) => b.loc === '/xhvless').length, 2, 'both /xhvless locations (HTTP/1.1 and h2) must be patched');

  // --- Output CLI setelah akun dibuat ---
  const bin = path.join(tmpDir, 'bin');
  fs.mkdirSync(bin);
  // jq tiruan: cukup untuk bentuk query di print_created_account
  // (alternatif ".a.b // .c // \"teks\" // empty").
  const jqShim = path.join(tmpDir, 'jq-shim.js');
  fs.writeFileSync(jqShim, `
const expr = process.argv.slice(2).filter((a) => a !== '-r')[0] || '.';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let doc;
  try { doc = JSON.parse(input); } catch (_) { process.exit(5); }
  let out;
  for (const term of expr.replace(/[()]/g, '').split('//').map((t) => t.trim())) {
    let v;
    if (term === 'empty') v = undefined;
    else if (/^".*"$/.test(term)) v = JSON.parse(term);
    else if (term === '.') v = doc;
    else v = term.slice(1).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), doc);
    if (v !== undefined && v !== null && v !== false) { out = v; break; }
  }
  if (out !== undefined) process.stdout.write((typeof out === 'string' ? out : JSON.stringify(out)) + '\\n');
});
`);
  fs.writeFileSync(path.join(bin, 'jq'), `#!/usr/bin/env bash\nexec node '${toBashPath(jqShim)}' "$@"\n`);
  fs.chmodSync(path.join(bin, 'jq'), 0o755);
  const engine = extract(menu, "MENU_ESC=$'\\033'\n", '\nif [[ "${1:-}" == "update" ]]; then');
  const printer = extract(menu, 'created_json_value() {', '\nprint_created_account() {') +
    extract(menu, '\nprint_created_account() {', '\n}\n') + '\n}\n';
  const render = (type, data) => {
    const raw = path.join(tmpDir, `${type}.json`);
    fs.writeFileSync(raw, JSON.stringify({ meta: { code: 200, message: 'success' }, data }));
    const sh = path.join(tmpDir, 'render.sh');
    fs.writeFileSync(sh, `set -euo pipefail\nexport PATH='${toBashPath(bin)}':"$PATH"\n${engine}\n${printer}\n` +
      `MENU_COLOR_FILE=/tidak/ada\nMENU_COLS=80\nUI_MODE=''\nprint_created_account '${type}' "$(cat '${toBashPath(raw)}')"\n`);
    const r = spawnSync(bash, [toBashPath(sh)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `print_created_account ${type} failed:\n${r.stderr}`);
    return r.stdout;
  };
  const base = (proto, username) => ({
    hostname: host, username, uuid, password: uuid, exp: '2030-01-01 23:59:59', time: '23:59:59', quota: '50', limitip: '1',
    city: 'Jakarta', isp: 'Contoh', port: { tls: '443', none: '80', any: '443', grpc: '443' }, serviceName: `${proto}-grpc`
  });
  const vless = render('vless', {
    ...base('vless', 'citra'),
    path: { ws: '/vless', upgrade: '/upvless', xhttp: '/xhvless' },
    link: {
      tls: 'vless://ws-tls', none: 'vless://ws-ntls', grpc: 'vless://grpc',
      uptls: 'vless://up-tls', upntls: 'vless://up-ntls', xhttptls: 'vless://xh-tls', xhttpntls: 'vless://xh-ntls', onering: 'vless://onering'
    }
  });
  for (const expected of ['PATH UPGRADE: /upvless', 'PATH XHTTP  : /xhvless', 'Up TLS:\nvless://up-tls', 'Up Non-TLS:\nvless://up-ntls',
    'XHTTP TLS:\nvless://xh-tls', 'XHTTP Non-TLS:\nvless://xh-ntls', 'OneRing (1FTunnel):\nvless://onering', '[ HOST INFORMATION ]']) {
    assert(vless.includes(expected), `VLESS output must contain ${JSON.stringify(expected)}:\n${vless}`);
  }
  const vmess = render('vmess', {
    ...base('vmess', 'budi'),
    path: { ws: '/vmess', upgrade: '/upvmess' },
    link: { tls: 'vmess://ws-tls', none: 'vmess://ws-ntls', grpc: 'vmess://grpc', uptls: 'vmess://up-tls', upntls: 'vmess://up-ntls', onering: 'vmess://onering' }
  });
  assert(vmess.includes('OneRing (1FTunnel):\nvmess://onering') && !vmess.includes('XHTTP'), `VMess shows OneRing but no XHTTP:\n${vmess}`);
  // Respons API versi lama (tanpa link baru) tetap tampil tanpa bagian kosong.
  const old = render('trojan', {
    ...base('trojan', 'dewi'),
    path: { ws: '/trojan', upgrade: '/uptrojan' },
    link: { tls: 'trojan://ws-tls', none: 'trojan://ws-ntls', grpc: 'trojan://grpc', uptls: 'trojan://ws-tls', upntls: 'trojan://ws-ntls' }
  });
  assert(!old.includes('XHTTP') && !old.includes('OneRing') && old.includes('Up TLS:\ntrojan://ws-tls'), `old API response:\n${old}`);

  console.log('xray link tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

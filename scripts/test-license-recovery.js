'use strict';

// Regresi VPS terkunci karena key di database bot berbeda dengan key di VPS:
// - Bot hanya menyimpan key ketikan pengguna setelah VPS menerimanya.
// - Menu admin "Pulihkan Key VPS" mengecek key ke VPS, menyimpan, lalu unlock.
// - License API menolak key tak dikenal dengan kode jelas dan mencatatnya
//   tanpa menulis key asli ke log.
// - License guard VPS mencatat alasan asli (api-rejected:server-key-unknown),
//   bukan akibatnya (lease-grace-expired).
// - Summary API memperbarui lisensi sebelum membuka kunci.
// - Layar kunci menu menjelaskan langkah pulih sesuai reason.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFile, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
const appSource = read('app3.js');
const licenseSource = read('license-api.js');
const installer = read('scripts/setup-autoscript-compat.sh');
const summarySource = read('scripts/setup-summary-api.sh');

function extractFunction(source, name, label) {
  const match = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(source);
  assert(match, `function ${name} tidak ditemukan di ${label}`);
  const start = match.index + 1;
  const end = source.indexOf('\n}\n', start);
  assert(end > start, `akhir function ${name} tidak ditemukan di ${label}`);
  return source.slice(start, end + 2);
}

function extractDeclaration(source, name, label) {
  const match = new RegExp(`\\n((?:const|let) ${name} = [^\\n]*;)\\n`).exec(source);
  assert(match, `deklarasi ${name} tidak ditemukan di ${label}`);
  return match[1];
}

function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `marker tidak ditemukan: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end > start, `marker akhir tidak ditemukan setelah: ${startMarker}`);
  return source.slice(start, end);
}

function stepBlock(step) {
  const marker = `if (state.step === '${step}') {`;
  const start = appSource.indexOf(marker);
  assert(start >= 0, `langkah ${step} tidak ditemukan`);
  // Blok berakhir di langkah berikutnya, atau di catch handler teks untuk
  // langkah terakhir.
  const ends = ['\n    if (state.step === ', '\n  } catch (err) {']
    .map((endMarker) => appSource.indexOf(endMarker, start + marker.length))
    .filter((index) => index > start);
  assert(ends.length, `akhir langkah ${step} tidak ditemukan`);
  return appSource.slice(start, Math.min(...ends));
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
  throw new Error('bash tidak ditemukan');
}

async function testBotKeyVerification() {
  const saved = [];
  const axiosCalls = [];
  let axiosImpl = async () => ({ status: 200, data: { ok: true } });
  const sandbox = {
    axios: { get: (...args) => { axiosCalls.push(args); return axiosImpl(...args); } },
    saveServerKeyForHost: async (uid, host, key) => { saved.push({ uid, host, key }); },
    crypto
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(appSource, 'normalizeHost', 'app3.js'),
    extractFunction(appSource, 'isIpv4', 'app3.js'),
    extractFunction(appSource, 'parseErr', 'app3.js'),
    extractDeclaration(appSource, 'SERVER_KEY_VERIFY_TIMEOUT_MS', 'app3.js'),
    extractFunction(appSource, 'verifyServerKeyOnHost', 'app3.js'),
    extractFunction(appSource, 'serverKeyVerifyFailureText', 'app3.js'),
    extractFunction(appSource, 'acceptServerKeyFromUser', 'app3.js'),
    extractFunction(appSource, 'serverKeyHashPrefix', 'app3.js'),
    extractFunction(appSource, 'licenseDenyHint', 'app3.js'),
    'this.api = { verifyServerKeyOnHost, acceptServerKeyFromUser, serverKeyHashPrefix, licenseDenyHint };'
  ].join('\n'), sandbox);
  const api = sandbox.api;
  const key = 'a'.repeat(48);
  const replies = [];
  const ctx = { from: { id: 77 }, reply: async (text) => { replies.push(String(text)); } };

  // Key ditolak VPS: tidak disimpan, pengguna diminta kirim ulang.
  axiosImpl = async () => ({ status: 401, data: { ok: false, message: 'unauthorized' } });
  assert.strictEqual((await api.verifyServerKeyOnHost('203.0.113.9', key)).reason, 'unauthorized');
  assert.strictEqual(await api.acceptServerKeyFromUser(ctx, '203.0.113.9', key), false);
  assert.strictEqual(saved.length, 0, 'key yang ditolak VPS tidak boleh disimpan');
  assert(/TIDAK disimpan/.test(replies.at(-1)) && /SC_UPDATE_KEY/.test(replies.at(-1)));
  const [url, options] = axiosCalls.at(-1);
  assert.strictEqual(url, 'http://203.0.113.9:8789/internal/account-summary');
  assert.strictEqual(options.headers['x-sync-token'], key);
  assert(options.timeout <= 20000, 'cek key harus cepat, jauh di bawah batas handler Telegram 90 detik');

  // VPS tidak terjangkau: juga tidak disimpan.
  axiosImpl = async () => { throw new Error('connect ECONNREFUSED 203.0.113.9:8789'); };
  assert.strictEqual((await api.verifyServerKeyOnHost('203.0.113.9', key)).reason, 'unreachable');
  assert.strictEqual(await api.acceptServerKeyFromUser(ctx, '203.0.113.9', key), false);
  assert.strictEqual(saved.length, 0, 'key tidak boleh disimpan kalau VPS tidak bisa dihubungi');

  // Input tidak valid tidak memanggil VPS sama sekali.
  const callsBefore = axiosCalls.length;
  assert.strictEqual((await api.verifyServerKeyOnHost('bukan-ip', key)).reason, 'invalid');
  assert.strictEqual((await api.verifyServerKeyOnHost('203.0.113.9', 'pendek')).reason, 'invalid');
  assert.strictEqual(axiosCalls.length, callsBefore);

  // Key diterima VPS: baru disimpan.
  axiosImpl = async () => ({ status: 200, data: { ok: true, summary: {} } });
  assert.strictEqual(await api.acceptServerKeyFromUser(ctx, '203.0.113.9', key), true);
  assert.deepStrictEqual(saved, [{ uid: 77, host: '203.0.113.9', key }]);

  const hash = api.serverKeyHashPrefix(key);
  assert(/^[0-9a-f]{8}$/.test(hash) && !key.includes(hash));

  const hint = (reason) => api.licenseDenyHint(reason);
  assert(hint('api-rejected:server-key-unknown').includes('Pulihkan Key VPS'));
  assert(hint('api-rejected:source-ip-mismatch').includes('Ganti IP VPS'));
  assert(hint('license-blocked:machine-id-mismatch').includes('Reset Binding VPS'));
  assert(hint('license-expired:registration-expired').includes('Perpanjang'));
  assert(hint('license-rejected:registration-not-active').includes('registrasi aktif'));
  assert(hint('refresh-failed:license-request-timeout').includes('koneksi'));
  assert(hint('lease-grace-expired').includes('koneksi'), 'lease-grace-expired bukan tanda SC expired');
  assert.strictEqual(hint(''), '');
}

function testBotFlows() {
  // Lima langkah yang meminta key: cek ke VPS dulu, tidak ada simpan langsung.
  for (const step of ['delete_all_key', 'migrate_src_key', 'migrate_dst_key', 'backup_key', 'restore_key']) {
    const block = stepBlock(step);
    const accept = block.indexOf('acceptServerKeyFromUser(');
    assert(accept >= 0, `${step}: key wajib dicek lewat acceptServerKeyFromUser`);
    assert(!block.includes('saveServerKeyForHost('), `${step}: key tidak boleh disimpan sebelum dicek`);
    assert(block.includes('))) return;'), `${step}: langkah harus berhenti kalau key ditolak`);
    const next = block.search(/state\.step = |apiGet\(/);
    if (next >= 0) assert(accept < next, `${step}: cek key harus sebelum langkah berikutnya`);
  }

  // Menu admin Pulihkan Key VPS.
  const menu = extractFunction(appSource, 'adminMenu', 'app3.js');
  assert(menu.includes("'Pulihkan Key VPS', 'm_admin_restore_vps_key'"));
  assert(appSource.includes("bot.action('m_admin_restore_vps_key'"));
  const restore = stepBlock('admin_restore_vps_key');
  const order = [
    'ctx.deleteMessage()',
    'isAdmin(ctx.from.id)',
    'verifyServerKeyOnHost(ip, key)',
    'if (!check.ok)',
    'saveServerKeyForHostAllOwners(ip, key, ctx.from.id)',
    'unlockScAccessByHost(ip, key'
  ].map((marker) => {
    const index = restore.indexOf(marker);
    assert(index >= 0, `Pulihkan Key VPS: ${marker} tidak ditemukan`);
    return index;
  });
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'urutan Pulihkan Key VPS salah');
  const rejectBranch = restore.slice(restore.indexOf('if (!check.ok)'), restore.indexOf('saveServerKeyForHostAllOwners('));
  assert(rejectBranch.includes('return ctx.reply('), 'key yang ditolak harus berhenti sebelum disimpan');
  assert(restore.includes('serverKeyHashPrefix(key)'), 'log admin memakai hash key');
  assert(!/console\.\w+\([^;]*\$\{key\}/.test(restore), 'key asli tidak boleh masuk log');
  assert(restore.includes('=== 409') && restore.includes('license_reason'), 'unlock 409 harus menampilkan reason lisensi');

  // Peringatan Reset Binding menyebut risikonya dan menunjuk ke Pulihkan Key VPS.
  const resetAction = extractBlock(appSource, "bot.action('m_admin_reset_machine_binding'", '\n});\n');
  assert(resetAction.includes('TERKUNCI') && resetAction.includes('Pulihkan Key VPS'));
  const resetStep = stepBlock('admin_reset_machine_binding_ip');
  assert(resetStep.includes('TERKUNCI') && resetStep.includes('Pulihkan Key VPS'));
}

async function testLicenseApi() {
  const warnings = [];
  let registration = null;
  const sandbox = {
    crypto,
    Buffer,
    console: { warn: (line) => warnings.push(String(line)), log() {}, error() {} },
    LICENSE_API_TOKEN: 'bearer-rahasia',
    LICENSE_ALLOW_LEGACY_BEARER: false,
    LICENSE_ENFORCE_SOURCE_IP: true,
    findRegistrationByServerKey: async () => registration
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(licenseSource, 'cleanIp', 'license-api.js'),
    extractFunction(licenseSource, 'getClientIp', 'license-api.js'),
    extractFunction(licenseSource, 'sourceIpMatchesRegistration', 'license-api.js'),
    extractFunction(licenseSource, 'safeEqualSecret', 'license-api.js'),
    extractFunction(licenseSource, 'requireBearer', 'license-api.js'),
    extractFunction(licenseSource, 'bearerTokenValid', 'license-api.js'),
    extractDeclaration(licenseSource, 'LICENSE_REJECT_LOG_INTERVAL_MS', 'license-api.js'),
    extractDeclaration(licenseSource, 'licenseRejectLogSeen', 'license-api.js'),
    extractFunction(licenseSource, 'logLicenseRejection', 'license-api.js'),
    extractFunction(licenseSource, 'requireLicenseClient', 'license-api.js'),
    'this.requireLicenseClient = requireLicenseClient;'
  ].join('\n'), sandbox);

  const key = crypto.randomBytes(24).toString('hex');
  const call = async (headers, ip) => {
    const req = { headers, socket: { remoteAddress: ip } };
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    let nextCalled = false;
    await sandbox.requireLicenseClient(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
  };

  // Key tidak dikenal: 401 dengan kode jelas, dicatat dengan hash key saja.
  let out = await call({ 'x-sc-key': key }, '198.51.100.1');
  assert.strictEqual(out.res.statusCode, 401);
  assert.strictEqual(out.res.body.code, 'server-key-unknown');
  assert(!out.nextCalled);
  assert.strictEqual(warnings.length, 1);
  assert(warnings[0].includes('ip=198.51.100.1') && warnings[0].includes('alasan=server-key-unknown'));
  assert(warnings[0].includes(`key_sha256=${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)}`));
  assert(!warnings[0].includes(key), 'key asli tidak boleh masuk log');
  await call({ 'x-sc-key': key }, '198.51.100.1');
  assert.strictEqual(warnings.length, 1, 'penolakan yang sama tidak dicatat ulang dalam 10 menit');

  // Legacy bearer aktif tapi bearer salah: tetap 401 server-key-unknown.
  sandbox.LICENSE_ALLOW_LEGACY_BEARER = true;
  out = await call({ 'x-sc-key': key, authorization: 'Bearer salah' }, '198.51.100.2');
  assert.strictEqual(out.res.statusCode, 401);
  assert.strictEqual(out.res.body.code, 'server-key-unknown');
  // Bearer legacy valid tetap boleh lewat untuk migrasi VPS lama.
  out = await call({ 'x-sc-key': key, authorization: 'Bearer bearer-rahasia' }, '198.51.100.3');
  assert(out.nextCalled);
  assert.strictEqual(out.req.scLicenseAuth, 'legacy-bearer');
  sandbox.LICENSE_ALLOW_LEGACY_BEARER = false;

  // Tanpa key sama sekali.
  out = await call({}, '198.51.100.4');
  assert.strictEqual(out.res.statusCode, 401);
  assert.strictEqual(out.res.body.code, 'server-key-missing');

  // Key dikenal tapi IP sumber lain.
  registration = { user_id: 1, vps_ip: '192.0.2.10', status: 'active' };
  out = await call({ 'x-sc-key': key }, '198.51.100.5');
  assert.strictEqual(out.res.statusCode, 403);
  assert.strictEqual(out.res.body.code, 'source-ip-mismatch');
  assert(warnings.some((line) => line.includes('alasan=source-ip-mismatch') && line.includes('terdaftar=192.0.2.10')));

  // Key dikenal dan IP cocok.
  out = await call({ 'x-sc-key': key }, '192.0.2.10');
  assert(out.nextCalled);
  assert.strictEqual(out.req.scLicenseAuth, 'vps-key');

  for (const code of ['registration-expired', 'registration-not-active']) {
    assert(licenseSource.includes(`logLicenseRejection(req, '${code}'`), `activate harus mencatat ${code}`);
  }
  assert(licenseSource.includes("logLicenseRejection(req, machineBinding.reason || 'machine-binding-failed'"));
}

function extractGuardSource() {
  return extractBlock(installer, "<<'LICENSE_GUARD_JS_EOF'\n", '\nLICENSE_GUARD_JS_EOF\n')
    .slice("<<'LICENSE_GUARD_JS_EOF'\n".length) + '\n';
}

function signPayload(privateKey, payload) {
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.sign(null, Buffer.from(segment, 'ascii'), privateKey);
  return `${segment}.${signature.toString('base64url')}`;
}

const sha256Hex = (input) => crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');

function runGuardAsync(guardPath, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [guardPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 60000
    }, (error, stdout, stderr) => {
      const lastLine = String(stdout || '').trim().split('\n').pop() || '';
      let json = null;
      try { json = JSON.parse(lastLine); } catch (_) {}
      resolve({ status: error ? error.code : 0, json, stdout, stderr });
    });
  });
}

async function testLicenseGuard() {
  const guardSource = extractGuardSource();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-license-recovery-'));
  let server = null;
  try {
    const guardPath = path.join(tmp, 'license-guard.js');
    fs.writeFileSync(guardPath, guardSource, { mode: 0o700 });
    const pair = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(tmp, 'public.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const machineId = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(tmp, 'machine-id'), `${machineId}\n`);
    const serverKey = crypto.randomBytes(24).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const basePayload = {
      v: 1,
      iss: 'sc1forcr-license-api',
      aud: 'sc1forcr-runtime',
      status: 'active',
      reason: 'test',
      bound_ip: '127.0.0.1',
      machine_id_hash: sha256Hex(machineId),
      key_id: sha256Hex(serverKey).slice(0, 32),
      registration_expires_at: now + 86400
    };
    const leasePath = path.join(tmp, 'lease.token');
    const writeLease = (payload) => fs.writeFileSync(leasePath, `${signPayload(pair.privateKey, payload)}\n`);
    const expiredLease = {
      ...basePayload,
      issued_at: now - 7200,
      refresh_after: now - 7000,
      lease_until: now - 3600,
      grace_until: now - 60
    };
    const graceLease = {
      ...basePayload,
      issued_at: now - 600,
      refresh_after: now - 300,
      lease_until: now - 60,
      grace_until: now + 3600
    };

    let reply = { status: 401, body: { ok: false, message: 'unauthorized' } };
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const statePath = path.join(tmp, 'state.json');
    const env = {
      LICENSE_LEASE_FILE: leasePath,
      LICENSE_PUBLIC_KEY_FILE: path.join(tmp, 'public.pem'),
      LICENSE_REQUIRED_MARKER: path.join(tmp, 'required'),
      LICENSE_GUARD_STATE_FILE: statePath,
      LICENSE_MACHINE_ID_FILE: path.join(tmp, 'machine-id'),
      SC_ENV_FILE: path.join(tmp, 'sc-1forcr.env'),
      SC_UPDATE_KEY: serverKey,
      LICENSE_API_TOKEN: '',
      LICENSE_API_URLS: '',
      LICENSE_API_URL: `http://127.0.0.1:${port}/sc1forcr/license/activate`,
      SCRIPT_VERSION: 'V.TEST'
    };
    const refresh = () => runGuardAsync(guardPath, ['refresh', '--force', '--json'], env);

    // Kasus nyata: lease habis dan license API tidak mengenal key VPS.
    writeLease(expiredLease);
    reply = { status: 401, body: { ok: false, allowed: false, code: 'server-key-unknown', message: 'key VPS tidak dikenal' } };
    let out = await refresh();
    assert.strictEqual(out.status, 1, out.stdout + out.stderr);
    assert.strictEqual(out.json.reason, 'api-rejected:server-key-unknown');
    assert.strictEqual(out.json.leaseReason, 'lease-grace-expired');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.refresh_error, 'api-rejected:server-key-unknown');
    assert.strictEqual(state.lease_reason, 'lease-grace-expired');

    // License API versi lama (401 "unauthorized" tanpa kode) dibaca sama.
    reply = { status: 401, body: { ok: false, message: 'unauthorized' } };
    out = await refresh();
    assert.strictEqual(out.json.reason, 'api-rejected:server-key-unknown');

    reply = { status: 403, body: { ok: false, allowed: false, status: 'blocked', message: 'source IP mismatch' } };
    out = await refresh();
    assert.strictEqual(out.json.reason, 'api-rejected:source-ip-mismatch');

    // Server error bukan penolakan.
    reply = { status: 500, body: { ok: false, message: 'database is locked' } };
    out = await refresh();
    assert.strictEqual(out.json.reason, 'refresh-failed:api-error:http-500');

    // Lease masih dalam grace: penolakan tidak langsung mengunci VPS.
    writeLease(graceLease);
    reply = { status: 401, body: { ok: false, code: 'server-key-unknown' } };
    out = await refresh();
    assert.strictEqual(out.status, 0, 'lease grace yang masih berlaku tetap mengizinkan akses');
    assert.strictEqual(out.json.allowed, true);
    assert.strictEqual(out.json.refreshError, 'api-rejected:server-key-unknown');

    // License API tidak terjangkau.
    await new Promise((resolve) => server.close(resolve));
    server = null;
    writeLease(expiredLease);
    out = await refresh();
    assert.strictEqual(out.status, 1);
    assert(/^refresh-failed:/.test(out.json.reason), `reason unreachable salah: ${out.json.reason}`);

    // Vonis bertanda tangan membawa alasan detail dari license API.
    writeLease({ ...graceLease, lease_until: now + 600, grace_until: now + 1200, status: 'blocked', reason: 'machine-id-mismatch' });
    out = await runGuardAsync(guardPath, ['check', '--json'], env);
    assert.strictEqual(out.status, 1);
    assert.strictEqual(out.json.reason, 'license-blocked:machine-id-mismatch');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testSummaryUnlock() {
  const route = extractBlock(summarySource, "app.post('/internal/sc-access-lock'", '\n});\n');
  const refreshAt = route.indexOf('await refreshSignedLicenseForUnlock()');
  const applyAt = route.indexOf('applyScAccessLock(');
  assert(refreshAt >= 0 && applyAt > refreshAt, 'unlock harus memperbarui lisensi sebelum menghapus lock');
  assert(route.includes('status(409)') && route.includes('license_reason: refresh.reason'));
  assert(route.includes('license_refresh: licenseRefresh'));

  let exists = { marker: true, guard: true };
  let execImpl = null;
  const execCalls = [];
  const sandbox = {
    fs: {
      existsSync: (p) => (String(p).endsWith('license-required') ? exists.marker : exists.guard)
    },
    execFile: (file, args, options, callback) => { execCalls.push({ file, args, options }); execImpl(callback); }
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractDeclaration(summarySource, 'LICENSE_REQUIRED_MARKER', 'setup-summary-api.sh'),
    extractDeclaration(summarySource, 'LICENSE_GUARD_BIN', 'setup-summary-api.sh'),
    extractDeclaration(summarySource, 'LICENSE_GUARD_UNLOCK_TIMEOUT_MS', 'setup-summary-api.sh'),
    extractFunction(summarySource, 'refreshSignedLicenseForUnlock', 'setup-summary-api.sh'),
    'this.refresh = refreshSignedLicenseForUnlock;'
  ].join('\n'), sandbox);

  exists = { marker: false, guard: true };
  assert.deepStrictEqual({ ...(await sandbox.refresh()) }, { ok: true, mode: 'legacy', reason: '' });
  exists = { marker: true, guard: false };
  assert.strictEqual((await sandbox.refresh()).reason, 'license-guard-missing');

  exists = { marker: true, guard: true };
  execImpl = (cb) => cb(null, '{"allowed":true,"reason":"lease-fresh"}\n', '');
  let result = await sandbox.refresh();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mode, 'ok');
  assert.deepStrictEqual([...execCalls.at(-1).args], ['refresh-enforce', '--force', '--json']);
  assert(execCalls.at(-1).options.timeout < 60000, 'guard harus selesai sebelum timeout Pulihkan Key VPS di bot');

  execImpl = (cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), '{"allowed":false,"reason":"api-rejected:server-key-unknown"}\n', '');
  result = await sandbox.refresh();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'api-rejected:server-key-unknown');

  execImpl = (cb) => cb(Object.assign(new Error('timeout'), { killed: true }), '', '');
  assert.strictEqual((await sandbox.refresh()).reason, 'license-guard-timeout');
}

function testMenuLockScreen() {
  const menuSource = extractBlock(installer, "<<'MENU_SCRIPT_EOF'\n", '\nMENU_SCRIPT_EOF\n');
  const shellFunction = (name) => extractBlock(menuSource, `\n${name}() {\n`, '\n}\n').slice(1) + '\n}\n';
  const fn = shellFunction('menu_lock_reason_text');
  const enforce = shellFunction('enforce_menu_license_access');
  assert(enforce.includes('menu_lock_reason_text "${lock_reason}" "${lock_managed_by}"'));
  const bash = resolveBash();
  const render = (reason, managedBy) => {
    const out = spawnSync(bash, ['-c', `set -euo pipefail\n${fn}\nmenu_lock_reason_text "$1" "$2"`, 'x', reason, managedBy], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    for (const line of out.stdout.split('\n').filter((l) => !l.startsWith('Reason : '))) {
      assert(line.length <= 61, `baris layar kunci terlalu lebar (${line.length}): ${line}`);
    }
    return out.stdout;
  };
  let text = render('api-rejected:server-key-unknown', 'license-guard');
  assert(text.includes('Reason : api-rejected:server-key-unknown'));
  assert(text.includes('Pulihkan Key VPS') && text.includes('grep SC_UPDATE_KEY /etc/sc-1forcr.env'));
  assert(!text.includes('SC expired'), 'key tidak dikenal bukan SC expired');
  assert(render('api-rejected:source-ip-mismatch', 'license-guard').includes('Ganti IP VPS'));
  assert(render('license-blocked:machine-id-mismatch', 'license-guard').includes('Reset Binding VPS'));
  assert(render('license-rejected:registration-not-active', 'license-guard').includes('registrasi SC aktif'));
  text = render('refresh-failed:license-request-timeout', 'license-guard');
  assert(text.includes('gagal memperbarui lisensi') && !text.includes('SC expired'));
  assert(render('lease-grace-expired', 'license-guard').includes('gagal memperbarui lisensi'));
  assert(render('license-expired:registration-expired', 'license-guard').includes('SC expired'));
  assert(render('migrate_ip_to_new_host', 'control-plane').includes('IP VPS baru'));
  assert(render('admin_remove_sc_ip', 'control-plane').includes('dinonaktifkan admin'));
  assert(render('locked_by_admin', '').includes('dinonaktifkan admin'));
  assert(render('lease-signature-invalid', 'license-guard').includes('Lisensi VPS ditolak'));
}

async function main() {
  await testBotKeyVerification();
  testBotFlows();
  await testLicenseApi();
  await testLicenseGuard();
  await testSummaryUnlock();
  testMenuLockScreen();
  console.log('license recovery tests: OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

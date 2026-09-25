'use strict';

// Regresi backup & restore server bot untuk pindah server:
// - Backup terenkripsi: password salah / file diubah / file asing ditolak.
// - Restore database di tempat: kolom dicocokkan per nama, tabel lama ikut,
//   sqlite_sequence ikut, data server baru terganti.
// - .env digabung: BOT_TOKEN & path server baru dipertahankan, ADMIN_IDS digabung.
// - Signing key lisensi ikut (fingerprint sama), script tidak diturunkan versinya.
// - Sertifikat Let's Encrypt ikut beserta symlink live -> archive.
// - Database backup rusak: restore batal sebelum file lain disentuh.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync = null;
const originalEmitWarning = process.emitWarning;
process.emitWarning = function quietSqliteWarning(warning, ...args) {
  if (/SQLite is an experimental feature/i.test(String(warning?.message || warning))) return undefined;
  return originalEmitWarning.call(process, warning, ...args);
};
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  console.log('server migration tests: SKIP (node:sqlite tidak tersedia, butuh Node >= 22.5)');
  process.exit(0);
} finally {
  process.emitWarning = originalEmitWarning;
}

const migration = require('../lib/server-migration');

const repoRoot = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(repoRoot, 'app3.js'), 'utf8').replace(/\r\n/g, '\n');

async function openDb(file) {
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA busy_timeout = 30000');
  return {
    run: async (sql, params = []) => conn.prepare(sql).run(...params),
    all: async (sql, params = []) => conn.prepare(sql).all(...params),
    close: async () => conn.close()
  };
}

function withSync(file, fn) {
  const conn = new DatabaseSync(file);
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

function canSymlink(dir) {
  const probe = path.join(dir, 'symlink-probe');
  try {
    fs.symlinkSync('target', probe);
    fs.rmSync(probe, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function writeEd25519Key(privateFile, publicFile) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(publicFile, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

async function expectCode(promise, code) {
  let caught = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert(caught, `harus gagal dengan ${code}`);
  assert.strictEqual(caught.code, code, `kode error ${caught.code} bukan ${code}: ${caught.message}`);
}

function testEnvMerge() {
  const backup = [
    '# konfigurasi produksi',
    'BOT_TOKEN=token-lama',
    'ADMIN_IDS=111,222',
    'DB_PATH=/root/lama/sc1forcrnexus.db',
    'LICENSE_API_TOKEN=rahasia-lama',
    'LICENSE_API_TOKEN=rahasia-final',
    'LICENSE_PUBLIC_BASE_URL="https://installer.example.com"',
    'LICENSE_SIGNING_PRIVATE_KEY_FILE=/root/lama/.priv.pem'
  ].join('\n');
  const current = [
    'BOT_TOKEN=token-baru',
    'ADMIN_IDS=222,333',
    'DB_PATH=/root/baru/sc1forcrnexus.db',
    'INSTALL_SCRIPT_URL=',
    'LICENSE_API_TOKEN=dummy'
  ].join('\n');
  const merged = migration.mergeEnvForRestore(backup, current);
  const env = merged.env;
  assert.strictEqual(env.BOT_TOKEN, 'token-baru', 'BOT_TOKEN server ini harus dipertahankan');
  assert.strictEqual(env.ADMIN_IDS, '111,222,333', 'ADMIN_IDS harus digabung');
  assert.strictEqual(env.DB_PATH, '/root/baru/sc1forcrnexus.db', 'DB_PATH server ini harus dipertahankan');
  assert.strictEqual(env.LICENSE_API_TOKEN, 'rahasia-final', 'nilai terakhir di backup yang dipakai, seperti dotenv');
  assert.strictEqual(env.LICENSE_PUBLIC_BASE_URL, 'https://installer.example.com');
  assert(!('LICENSE_SIGNING_PRIVATE_KEY_FILE' in env), 'path key server lama harus dibuang kalau server ini tidak mengisinya');
  assert.strictEqual(env.INSTALL_SCRIPT_URL, '', 'kunci yang hanya ada di server ini tetap ada');
  assert(merged.text.includes('# konfigurasi produksi'), 'komentar backup dipertahankan');
  assert.strictEqual((merged.text.match(/^LICENSE_API_TOKEN=/gm) || []).length, 1, 'kunci duplikat ditulis sekali');
  assert(!merged.text.includes('token-lama'), 'token lama tidak boleh tertulis');
  assert(merged.notes.some((note) => note.startsWith('BOT_TOKEN')), 'perbedaan BOT_TOKEN dicatat');
  assert(merged.notes.every((note) => !note.includes('token-')), 'catatan tidak boleh membocorkan token');
}

function testScriptVersion() {
  assert.strictEqual(migration.extractScriptVersion('#!/bin/bash\nSCRIPT_VERSION="${SC_SCRIPT_VERSION_OVERRIDE:-V.1FSC.64}"\n'), 'V.1FSC.64');
  assert.strictEqual(migration.compareScriptVersions('V.1FSC.64', 'V.1FSC.65'), -1);
  assert.strictEqual(migration.compareScriptVersions('V.1FSC.70', 'V.1FSC.65'), 1);
  assert.strictEqual(migration.compareScriptVersions('V.1FSC.64', 'V.1FSC.64'), 0);
  assert.strictEqual(migration.compareScriptVersions('V.1FSC.64', 'X.9'), 0);
  const realInstaller = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8');
  assert(/^V\.1FSC\.\d+$/.test(migration.extractScriptVersion(realInstaller)), 'versi installer asli harus terbaca');
}

function testAppWiring() {
  assert(appSource.includes("require('./lib/server-migration')"), 'app3.js harus memakai lib/server-migration');
  assert(/function adminMenu\(\)[\s\S]*?'m_admin_srv_menu'/.test(appSource), 'menu admin harus punya tombol Pindah Server');
  for (const step of ['admin_srv_backup_password', 'admin_srv_backup_password_confirm', 'admin_srv_restore_password']) {
    const start = appSource.indexOf(`if (state.step === '${step}') {`);
    assert(start >= 0, `handler ${step} tidak ditemukan`);
    const block = appSource.slice(start, start + 1200);
    assert(block.includes('deleteServerPasswordMessage(ctx)'), `pesan password di ${step} harus dihapus dari chat`);
  }
  const launchIdx = appSource.indexOf('await launchBotWithRetry();');
  const markerIdx = appSource.indexOf('readServerMigratedMarker()', appSource.indexOf('(async () => {\n  try {\n    await initDb();'));
  assert(markerIdx > 0 && markerIdx < launchIdx, 'bot yang dibekukan tidak boleh polling Telegram');
  const expiryJob = appSource.slice(appSource.indexOf('async function runScExpiryJobOnce('));
  assert(expiryJob.slice(0, 600).includes('SERVER_MIGRATED_MARKER'), 'expiry job harus berhenti di server yang dibekukan');
  const freeze = appSource.slice(appSource.indexOf("bot.action(/^m_admin_srv_freeze_confirm_"));
  assert(freeze.slice(0, 1500).includes('localServerId()'), 'tombol bekukan harus terikat ke server asalnya');
}

async function testFullMigration(tmp) {
  const oldApp = path.join(tmp, 'server-lama');
  const newApp = path.join(tmp, 'server-baru');
  const oldLe = path.join(tmp, 'le-lama');
  const newLe = path.join(tmp, 'le-baru');
  for (const dir of [oldApp, newApp, oldLe, newLe]) fs.mkdirSync(dir, { recursive: true });
  const symlinkOk = canSymlink(tmp);

  // ----- server lama -----
  const oldDb = path.join(oldApp, 'sc1forcrnexus.db');
  withSync(oldDb, (db) => {
    db.exec(`
      CREATE TABLE users (user_id INTEGER PRIMARY KEY, saldo INTEGER DEFAULT 0, is_reseller INTEGER DEFAULT 0);
      CREATE TABLE sc_registrations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, vps_ip TEXT NOT NULL,
        client_name TEXT, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_used_at INTEGER, expires_at INTEGER, UNIQUE(user_id, vps_ip));
      CREATE TABLE api_domains (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL UNIQUE, is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, added_by INTEGER);
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by INTEGER);
      CREATE TABLE legacy_only (id INTEGER PRIMARY KEY, note TEXT);
      INSERT INTO users (user_id, saldo, is_reseller) VALUES (1001, 50000, 1), (1002, 7500, 0);
      INSERT INTO sc_registrations (user_id, vps_ip, client_name, created_at, updated_at, expires_at)
        VALUES (1001, '10.0.0.1', 'budi', 1, 1, 0), (1002, '10.0.0.2', 'ani', 1, 1, 0);
      DELETE FROM sc_registrations WHERE id = 2;
      INSERT INTO sc_registrations (user_id, vps_ip, client_name, created_at, updated_at, expires_at)
        VALUES (1002, '10.0.0.3', 'ani', 1, 1, 0);
      INSERT INTO api_domains (domain, created_at, updated_at) VALUES ('installer.example.com', 1, 1);
      INSERT INTO app_settings (key, value, updated_at) VALUES ('SC_INSTALLER_LOCAL_PATH', '/root/lama/scripts/setup-autoscript-compat.sh', 1);
      INSERT INTO legacy_only (id, note) VALUES (1, 'ikut pindah');
    `);
  });
  const oldEnvFile = path.join(oldApp, '.env');
  fs.writeFileSync(oldEnvFile, [
    'BOT_TOKEN=token-produksi',
    'ADMIN_IDS=111',
    `DB_PATH=${oldDb}`,
    'LICENSE_API_TOKEN=rahasia-produksi',
    'LICENSE_API_PORT=8123'
  ].join('\n'));
  const oldVarsFile = path.join(oldApp, '.vars.json');
  fs.writeFileSync(oldVarsFile, JSON.stringify({ PAYMENT_GATEWAY_MODE: 'both', GOPAY_API_KEY: 'gopay-produksi' }));
  const oldPriv = path.join(oldApp, '.sc1forcr-license-ed25519-private.pem');
  const oldPub = path.join(oldApp, '.sc1forcr-license-ed25519-public.pem');
  const fingerprint = writeEd25519Key(oldPriv, oldPub);
  fs.mkdirSync(path.join(oldApp, 'scripts'));
  const oldInstaller = path.join(oldApp, 'scripts', 'setup-autoscript-compat.sh');
  const oldSummary = path.join(oldApp, 'scripts', 'setup-summary-api.sh');
  fs.writeFileSync(oldInstaller, '#!/usr/bin/env bash\nSCRIPT_VERSION="${SC_SCRIPT_VERSION_OVERRIDE:-V.1FSC.64}"\necho produksi\n');
  fs.writeFileSync(oldSummary, '#!/usr/bin/env bash\necho summary-produksi\n');

  if (symlinkOk) {
    const domain = 'installer.example.com';
    fs.mkdirSync(path.join(oldLe, 'accounts', 'acme', 'directory', 'abc123'), { recursive: true });
    fs.writeFileSync(path.join(oldLe, 'accounts', 'acme', 'directory', 'abc123', 'private_key.json'), '{"k":1}');
    fs.mkdirSync(path.join(oldLe, 'archive', domain), { recursive: true });
    fs.mkdirSync(path.join(oldLe, 'live', domain), { recursive: true });
    fs.mkdirSync(path.join(oldLe, 'renewal'), { recursive: true });
    for (const name of ['cert', 'chain', 'fullchain', 'privkey']) {
      fs.writeFileSync(path.join(oldLe, 'archive', domain, `${name}2.pem`), `${name}-isi`);
      fs.symlinkSync(`../../archive/${domain}/${name}2.pem`, path.join(oldLe, 'live', domain, `${name}.pem`));
    }
    fs.writeFileSync(path.join(oldLe, 'renewal', `${domain}.conf`), 'account = abc123\n');
    fs.writeFileSync(path.join(oldLe, 'renewal', 'lain.example.org.conf'), 'bukan domain bot\n');
  }

  await expectCode(migration.createServerBackup({ password: 'pendek', openDb }), 'WEAK_PASSWORD');

  const password = 'rahasia-pindah-123';
  const backup = await migration.createServerBackup({
    password,
    openDb,
    dbPath: oldDb,
    appDir: oldApp,
    env: migration.parseEnvText(fs.readFileSync(oldEnvFile, 'utf8')),
    envFile: oldEnvFile,
    varsFile: oldVarsFile,
    scInstallerFile: oldInstaller,
    summaryApiFile: oldSummary,
    letsencryptDir: symlinkOk ? oldLe : null,
    hostname: 'bot-lama'
  });
  const { manifest } = backup;
  assert.strictEqual(manifest.summary.users, 2);
  assert.strictEqual(manifest.summary.saldo_total, 57500);
  assert.strictEqual(manifest.summary.registrations_total, 2);
  assert.deepStrictEqual(manifest.summary.domains, ['installer.example.com']);
  assert.strictEqual(manifest.license_key_fingerprint, fingerprint);
  assert.strictEqual(manifest.sc_installer_version, 'V.1FSC.64');
  if (symlinkOk) assert.deepStrictEqual(manifest.summary.ssl_domains, ['installer.example.com']);
  assert(!manifest.warnings.some((warning) => /IP/.test(warning)), 'tidak ada peringatan URL berbasis IP');
  const ipBased = await migration.createServerBackup({
    password,
    openDb,
    dbPath: oldDb,
    appDir: oldApp,
    env: { LICENSE_PUBLIC_BASE_URL: 'http://203.0.113.5:8099' },
    envFile: oldEnvFile
  });
  assert(ipBased.manifest.warnings.some((warning) => warning.includes('203.0.113.5')), 'URL lisensi berbasis IP harus diperingatkan');
  assert.strictEqual(ipBased.manifest.license_key_fingerprint, fingerprint, 'tanpa DB_PATH, key dicari di folder database seperti license-api');
  const noKey = await migration.createServerBackup({
    password,
    openDb,
    dbPath: oldDb,
    appDir: oldApp,
    env: { LICENSE_SIGNING_PRIVATE_KEY_FILE: path.join(oldApp, 'tidak-ada.pem') }
  });
  assert(noKey.manifest.warnings.some((warning) => warning.includes('PRIVATE KEY')), 'key lisensi yang tidak ketemu harus diperingatkan');
  assert(!backup.buffer.includes(Buffer.from('rahasia-produksi')), 'isi backup harus terenkripsi');
  assert(!backup.buffer.includes(Buffer.from('BEGIN PRIVATE KEY')), 'private key tidak boleh terbaca polos');

  await expectCode(migration.decodeServerBackup(backup.buffer, 'password-salah'), 'BAD_PASSWORD');
  const tampered = Buffer.from(backup.buffer);
  tampered[tampered.length - 5] ^= 0xff;
  await expectCode(migration.decodeServerBackup(tampered, password), 'BAD_PASSWORD');
  await expectCode(migration.decodeServerBackup(Buffer.from('{"meta":{}}'), password), 'BAD_FORMAT');

  const archive = await migration.decodeServerBackup(backup.buffer, password);
  const leNames = archive.entries.filter((entry) => entry.role === 'letsencrypt').map((entry) => entry.name);
  assert(!leNames.includes('renewal/lain.example.org.conf'), 'sertifikat domain lain di server tidak ikut');

  // ----- server baru (sudah jalan start.sh, data masih kosong/dummy) -----
  const newDb = path.join(newApp, 'sc1forcrnexus.db');
  withSync(newDb, (db) => {
    db.exec(`
      CREATE TABLE users (user_id INTEGER PRIMARY KEY, is_reseller INTEGER DEFAULT 0, saldo INTEGER DEFAULT 0, created_note TEXT DEFAULT 'baru');
      CREATE TABLE sc_registrations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, vps_ip TEXT NOT NULL,
        client_name TEXT, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_used_at INTEGER, expires_at INTEGER, UNIQUE(user_id, vps_ip));
      CREATE TABLE api_domains (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL UNIQUE, is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, added_by INTEGER);
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by INTEGER);
      CREATE TABLE new_only (id INTEGER PRIMARY KEY, note TEXT);
      INSERT INTO users (user_id, saldo) VALUES (999, 1);
      INSERT INTO new_only (id, note) VALUES (1, 'tetap');
    `);
  });
  const newEnvFile = path.join(newApp, '.env');
  const newEnvBefore = ['BOT_TOKEN=token-produksi', 'ADMIN_IDS=111', `DB_PATH=${newDb}`, 'LICENSE_API_TOKEN=dummy', 'INSTALL_SCRIPT_URL='].join('\n');
  fs.writeFileSync(newEnvFile, newEnvBefore);
  const newVarsFile = path.join(newApp, '.vars.json');
  fs.writeFileSync(newVarsFile, JSON.stringify({ PAYMENT_GATEWAY_MODE: 'gopay', GOPAY_API_KEY: 'dummy', EXTRA_BARU: 'ada' }));
  const newPriv = path.join(newApp, '.sc1forcr-license-ed25519-private.pem');
  const newPub = path.join(newApp, '.sc1forcr-license-ed25519-public.pem');
  const generatedFingerprint = writeEd25519Key(newPriv, newPub);
  assert.notStrictEqual(generatedFingerprint, fingerprint);
  fs.mkdirSync(path.join(newApp, 'scripts'));
  const newInstaller = path.join(newApp, 'scripts', 'setup-autoscript-compat.sh');
  const newSummary = path.join(newApp, 'scripts', 'setup-summary-api.sh');
  fs.writeFileSync(newInstaller, '#!/usr/bin/env bash\nSCRIPT_VERSION="${SC_SCRIPT_VERSION_OVERRIDE:-V.1FSC.65}"\necho git-lebih-baru\n');
  fs.writeFileSync(newSummary, '#!/usr/bin/env bash\necho summary-git\n');

  // Database backup rusak: restore harus batal sebelum .env dan key ditimpa.
  const brokenBuffer = await migration.encodeServerBackup({
    manifest: { ...archive.manifest, files: undefined },
    entries: archive.entries.map((entry) => (
      entry.role === 'database' ? { ...entry, data: Buffer.from('bukan database sqlite sama sekali'.repeat(64)) } : entry
    )),
    password
  });
  const brokenArchive = await migration.decodeServerBackup(brokenBuffer, password);
  const restoreOptions = {
    openDb,
    dbPath: newDb,
    appDir: newApp,
    envFile: newEnvFile,
    varsFile: newVarsFile,
    scInstallerFile: newInstaller,
    summaryApiFile: newSummary,
    letsencryptDir: symlinkOk ? newLe : null
  };
  await assert.rejects(migration.restoreServerBackup({ ...restoreOptions, archive: brokenArchive }));
  assert.strictEqual(fs.readFileSync(newEnvFile, 'utf8'), newEnvBefore, '.env tidak boleh berubah kalau database gagal');
  assert.strictEqual(migration.licenseKeyFingerprintOfFile(newPriv), generatedFingerprint, 'key tidak boleh berubah kalau database gagal');
  withSync(newDb, (db) => {
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'database gagal restore harus utuh');
  });

  const report = await migration.restoreServerBackup({ ...restoreOptions, archive });

  withSync(newDb, (db) => {
    const users = db.prepare('SELECT user_id, saldo, is_reseller, created_note FROM users ORDER BY user_id').all()
      .map((row) => ({ ...row }));
    assert.deepStrictEqual(users, [
      { user_id: 1001, saldo: 50000, is_reseller: 1, created_note: 'baru' },
      { user_id: 1002, saldo: 7500, is_reseller: 0, created_note: 'baru' }
    ], 'kolom harus dicocokkan per nama dan data server baru terganti');
    const regs = db.prepare('SELECT id, vps_ip FROM sc_registrations ORDER BY id').all().map((row) => ({ ...row }));
    assert.deepStrictEqual(regs, [{ id: 1, vps_ip: '10.0.0.1' }, { id: 3, vps_ip: '10.0.0.3' }]);
    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sc_registrations'").get();
    assert.strictEqual(seq.seq, 3, 'sqlite_sequence harus ikut');
    assert.strictEqual(db.prepare('SELECT note FROM legacy_only WHERE id = 1').get().note, 'ikut pindah');
    assert.strictEqual(db.prepare('SELECT note FROM new_only WHERE id = 1').get().note, 'tetap');
    const installerSetting = db.prepare("SELECT value FROM app_settings WHERE key = 'SC_INSTALLER_LOCAL_PATH'").get().value;
    assert.strictEqual(installerSetting, newInstaller, 'path installer dari server lama diarahkan ke server ini');
  });
  assert(report.database.created.includes('legacy_only'));

  const envAfter = migration.parseEnvText(fs.readFileSync(newEnvFile, 'utf8'));
  assert.strictEqual(envAfter.LICENSE_API_TOKEN, 'rahasia-produksi');
  assert.strictEqual(envAfter.DB_PATH, newDb);
  assert.strictEqual(envAfter.INSTALL_SCRIPT_URL, '');
  assert.strictEqual(report.licenseApiPort, 8123);

  const varsAfter = JSON.parse(fs.readFileSync(newVarsFile, 'utf8'));
  assert.deepStrictEqual(varsAfter, { PAYMENT_GATEWAY_MODE: 'both', GOPAY_API_KEY: 'gopay-produksi', EXTRA_BARU: 'ada' });

  assert.strictEqual(migration.licenseKeyFingerprintOfFile(newPriv), fingerprint, 'signing key lisensi harus sama dengan server lama');
  assert.strictEqual(report.license.fingerprint, fingerprint);
  assert.strictEqual(report.license.replaced, true);
  const pubAfter = crypto.createPublicKey(fs.readFileSync(newPub, 'utf8'));
  assert.strictEqual(
    crypto.createHash('sha256').update(pubAfter.export({ type: 'spki', format: 'der' })).digest('hex'),
    fingerprint,
    'public key harus pasangan private key yang dipulihkan'
  );

  assert(fs.readFileSync(newInstaller, 'utf8').includes('git-lebih-baru'), 'installer yang lebih baru tidak boleh diturunkan');
  assert(fs.readFileSync(newSummary, 'utf8').includes('summary-produksi'), 'script Summary API produksi harus ikut');
  assert.strictEqual(report.scripts.find((item) => item.role === 'sc_installer').action, 'kept');
  assert.strictEqual(report.scripts.find((item) => item.role === 'summary_api').action, 'restored');

  if (symlinkOk) {
    const domain = 'installer.example.com';
    assert.deepStrictEqual(report.ssl.restored, [domain]);
    const liveCert = path.join(newLe, 'live', domain, 'fullchain.pem');
    assert(fs.lstatSync(liveCert).isSymbolicLink(), 'live harus tetap symlink');
    assert.strictEqual(fs.readFileSync(liveCert, 'utf8'), 'fullchain-isi');
    assert(fs.existsSync(path.join(newLe, 'accounts', 'acme', 'directory', 'abc123', 'private_key.json')), 'akun ACME ikut');

    // Restore kedua: domain yang sudah punya sertifikat di server ini dilewati.
    const again = await migration.restoreServerBackup({ ...restoreOptions, archive });
    assert.deepStrictEqual(again.ssl.skipped, [domain]);
  } else {
    await testSslRestoreWithSymlinkStub(tmp, archive, restoreOptions, password);
  }

  // Backup berisi symlink yang keluar dari /etc/letsencrypt harus ditolak.
  const evilBuffer = await migration.encodeServerBackup({
    manifest: { ...archive.manifest, files: undefined },
    entries: [...archive.entries, { role: 'letsencrypt', name: 'live/x/cert.pem', type: 'symlink', target: '../../../../etc/shadow' }],
    password
  });
  const evilArchive = await migration.decodeServerBackup(evilBuffer, password);
  await assert.rejects(migration.restoreServerBackup({ ...restoreOptions, archive: evilArchive }), /symlink tidak aman/);
}

// OS tanpa izin symlink (Windows biasa): entri sertifikat dibuat manual dan
// fs.symlinkSync diganti pencatat, supaya urutan dan target symlink tetap teruji.
async function testSslRestoreWithSymlinkStub(tmp, archive, restoreOptions, password) {
  const domain = 'installer.example.com';
  const le = path.join(tmp, 'le-stub');
  fs.mkdirSync(le, { recursive: true });
  const sslEntries = [
    { role: 'letsencrypt', name: 'accounts', type: 'dir', mode: 0o700 },
    { role: 'letsencrypt', name: 'accounts/acme/directory/abc123/private_key.json', type: 'file', mode: 0o600, data: Buffer.from('{"k":1}') },
    { role: 'letsencrypt', name: 'archive', type: 'dir', mode: 0o700 },
    { role: 'letsencrypt', name: `archive/${domain}`, type: 'dir', mode: 0o755 },
    { role: 'letsencrypt', name: `archive/${domain}/fullchain2.pem`, type: 'file', mode: 0o644, data: Buffer.from('fullchain-isi') },
    { role: 'letsencrypt', name: `archive/${domain}/privkey2.pem`, type: 'file', mode: 0o600, data: Buffer.from('privkey-isi') },
    { role: 'letsencrypt', name: 'live', type: 'dir', mode: 0o700 },
    { role: 'letsencrypt', name: `live/${domain}`, type: 'dir', mode: 0o755 },
    { role: 'letsencrypt', name: `live/${domain}/fullchain.pem`, type: 'symlink', target: `../../archive/${domain}/fullchain2.pem` },
    { role: 'letsencrypt', name: `live/${domain}/privkey.pem`, type: 'symlink', target: `../../archive/${domain}/privkey2.pem` },
    { role: 'letsencrypt', name: `renewal/${domain}.conf`, type: 'file', mode: 0o644, data: Buffer.from('account = abc123\n') }
  ];
  const buffer = await migration.encodeServerBackup({
    manifest: {
      ...archive.manifest,
      files: undefined,
      summary: { ...archive.manifest.summary, ssl_domains: [domain] }
    },
    entries: [...archive.entries.filter((entry) => entry.role !== 'letsencrypt'), ...sslEntries],
    password
  });
  const sslArchive = await migration.decodeServerBackup(buffer, password);
  assert.deepStrictEqual(
    sslArchive.entries.filter((entry) => entry.type === 'symlink').map((entry) => entry.target),
    [`../../archive/${domain}/fullchain2.pem`, `../../archive/${domain}/privkey2.pem`],
    'target symlink harus utuh setelah enkripsi'
  );

  const calls = [];
  const realSymlink = fs.symlinkSync;
  fs.symlinkSync = (target, linkPath) => {
    calls.push({ target, link: path.relative(le, linkPath).split(path.sep).join('/') });
    fs.writeFileSync(linkPath, `-> ${target}`);
  };
  try {
    const report = await migration.restoreServerBackup({ ...restoreOptions, archive: sslArchive, letsencryptDir: le });
    assert.deepStrictEqual(report.ssl.restored, [domain]);
    assert.deepStrictEqual(calls, [
      { target: `../../archive/${domain}/fullchain2.pem`, link: `live/${domain}/fullchain.pem` },
      { target: `../../archive/${domain}/privkey2.pem`, link: `live/${domain}/privkey.pem` }
    ]);
    assert.strictEqual(fs.readFileSync(path.join(le, 'archive', domain, 'privkey2.pem'), 'utf8'), 'privkey-isi');
    assert(fs.existsSync(path.join(le, 'accounts', 'acme', 'directory', 'abc123', 'private_key.json')), 'akun ACME ikut');
    assert(fs.existsSync(path.join(le, 'renewal', `${domain}.conf`)), 'renewal conf ikut');

    // Restore kedua: domain yang sudah punya sertifikat di server ini dilewati.
    calls.length = 0;
    const again = await migration.restoreServerBackup({ ...restoreOptions, archive: sslArchive, letsencryptDir: le });
    assert.deepStrictEqual(again.ssl.skipped, [domain]);
    assert.deepStrictEqual(calls, [], 'sertifikat yang sudah ada tidak boleh ditimpa');
  } finally {
    fs.symlinkSync = realSymlink;
  }

  // Tanpa akses root (letsencryptDir null) sertifikat dilewati dengan catatan.
  const noRoot = await migration.restoreServerBackup({ ...restoreOptions, archive: sslArchive, letsencryptDir: null });
  assert(/root/.test(noRoot.ssl.note), 'restore tanpa root harus mencatat SSL dilewati');
}

(async () => {
  testEnvMerge();
  testScriptVersion();
  testAppWiring();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-server-migration-'));
  try {
    await testFullMigration(tmp);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('server migration tests: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

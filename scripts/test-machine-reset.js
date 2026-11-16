'use strict';

// Reset Machine ID mandiri (lib/machine-reset.js) + pesan installer.
// Memakai sqlite3 di memori dengan tabel sc_server_keys versi bot.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mr = require('../lib/machine-reset');

// node:sqlite (Node >= 22.5) supaya tidak butuh binary native sqlite3.
let DatabaseSync;
const originalEmitWarning = process.emitWarning;
try {
  process.emitWarning = () => {};
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  console.log('machine reset tests: SKIP (node:sqlite tidak tersedia, butuh Node >= 22.5)');
  process.exit(0);
} finally {
  process.emitWarning = originalEmitWarning;
}

const ROOT = path.join(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;

// Bentuk {run, get, all} berbasis Promise, sama dengan dbRun/dbGet/dbAll bot.
function openDb() {
  const raw = new DatabaseSync(':memory:');
  const later = (fn) => new Promise((resolve, reject) => setImmediate(() => {
    try { resolve(fn()); } catch (err) { reject(err); }
  }));
  const plain = (row) => (row ? { ...row } : null);
  return {
    raw,
    run: (sql, params = []) => later(() => (params.length ? raw.prepare(sql).run(...params) : raw.exec(sql))),
    get: (sql, params = []) => later(() => plain(raw.prepare(sql).get(...params))),
    all: (sql, params = []) => later(() => raw.prepare(sql).all(...params).map(plain))
  };
}

const HASH_OLD = 'a'.repeat(64);
const HASH_NEW = 'b'.repeat(64);
const HASH_OTHER = 'c'.repeat(64);
const IP = '203.0.113.7';
const OWNER = 1001;
const OTHER = 2002;

async function keyRow(db) {
  return db.get('SELECT * FROM sc_server_keys WHERE user_id = ? AND vps_ip = ?', [OWNER, IP]);
}

async function main() {
  const db = openDb();
  await db.run(`CREATE TABLE sc_server_keys (
    user_id INTEGER NOT NULL, vps_ip TEXT NOT NULL, server_key TEXT NOT NULL,
    machine_id_hash TEXT, machine_bound_at INTEGER, last_lease_at INTEGER, updated_at INTEGER
  )`);
  await db.run(
    'INSERT INTO sc_server_keys (user_id, vps_ip, server_key, machine_id_hash, machine_bound_at, last_lease_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 1)',
    [OWNER, IP, 'kunci-rahasia', HASH_OLD]
  );
  await mr.ensureMachineResetSchema(db);
  await mr.ensureMachineResetSchema(db); // idempoten

  let now = 1_800_000_000_000;

  // Input tidak valid: tidak ada kode.
  assert.deepStrictEqual(await mr.issueMachineResetCode(db, { userId: OWNER, ip: IP, machineIdHash: 'xyz', now }), { code: null, usage: null });
  assert.deepStrictEqual(await mr.issueMachineResetCode(db, { userId: 0, ip: IP, machineIdHash: HASH_NEW, now }), { code: null, usage: null });

  // Mesin yang sama mendapat kode yang sama selama berlaku.
  const first = await mr.issueMachineResetCode(db, { userId: OWNER, ip: IP, machineIdHash: HASH_NEW, now });
  assert.match(first.code, /^\d{6}$/);
  assert.strictEqual(first.expiresAt, now + mr.RESET_CODE_TTL_MS);
  assert.deepStrictEqual(first.usage, { used: 0, left: 2, nextAt: 0 });
  const again = await mr.issueMachineResetCode(db, { userId: OWNER, ip: IP, machineIdHash: HASH_NEW, now: now + 60000 });
  assert.strictEqual(again.code, first.code, 'installer diulang = kode sama');
  assert.strictEqual(again.expiresAt, first.expiresAt, 'kode diulang tidak memperpanjang masa berlaku');

  // Format salah tidak menghitung percobaan.
  assert.strictEqual((await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: '12ab56', now })).reason, 'format');

  // Kode benar tapi bukan pemilik registrasi = dianggap salah.
  const wrongOwner = await mr.redeemMachineResetCode(db, { userId: OTHER, ip: IP, code: first.code, now });
  assert.strictEqual(wrongOwner.reason, 'wrong-code');
  assert.strictEqual(wrongOwner.attemptsLeft, 4);
  assert.strictEqual((await keyRow(db)).machine_id_hash, HASH_OLD, 'binding tidak berubah');

  // Kode salah.
  const bad = first.code === '000000' ? '111111' : '000000';
  const wrong = await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: bad, now });
  assert.strictEqual(wrong.reason, 'wrong-code');
  assert.strictEqual(wrong.attemptsLeft, 3);

  // Kode benar dari pemilik: binding pindah, key tidak dirotasi, kode dibuang.
  const ok = await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: ` ${first.code} `, now });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.usage, { used: 1, left: 1, nextAt: 0 });
  let key = await keyRow(db);
  assert.strictEqual(key.machine_id_hash, HASH_NEW);
  assert.strictEqual(key.server_key, 'kunci-rahasia', 'key VPS tetap, perintah install sama');
  assert.strictEqual(key.machine_bound_at, now);
  assert.strictEqual(key.last_lease_at, null);
  assert.strictEqual(await db.get('SELECT * FROM sc_machine_reset_codes WHERE vps_ip = ?', [IP]), null);
  assert.strictEqual((await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: first.code, now })).reason, 'no-code', 'kode sekali pakai');
  const history = await db.all('SELECT * FROM sc_machine_resets');
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].old_hash, HASH_OLD);
  assert.strictEqual(history[0].new_hash, HASH_NEW);
  assert.strictEqual(history[0].source, 'self');

  // Mesin berbeda mengganti kode lama (satu kode aktif per IP).
  now += DAY;
  const c1 = await mr.issueMachineResetCode(db, { userId: OWNER, ip: IP, machineIdHash: HASH_OTHER, now });
  const c2 = await mr.issueMachineResetCode(db, { userId: OWNER, ip: IP, machineIdHash: HASH_OLD, now });
  assert.strictEqual((await db.all('SELECT * FROM sc_machine_reset_codes')).length, 1);
  assert.strictEqual((await db.get('SELECT machine_id_hash FROM sc_machine_reset_codes')).machine_id_hash, HASH_OLD);
  if (c1.code !== c2.code) {
    assert.strictEqual((await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: c1.code, now })).reason, 'wrong-code');
  }

  // Kedaluwarsa.
  const late = await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: c2.code, now: now + mr.RESET_CODE_TTL_MS });
  assert.strictEqual(late.reason, 'expired');

  // Percobaan habis: kode diblokir, installer membuat kode baru.
  const c3 = await mr.issueMachineResetCode(db, { userId: OWNER, ip: IP, machineIdHash: HASH_OTHER, now });
  const wrong3 = c3.code === '999999' ? '888888' : '999999';
  let last;
  for (let i = 0; i < mr.RESET_CODE_MAX_ATTEMPTS; i += 1) {
    last = await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: wrong3, now });
  }
  assert.strictEqual(last.reason, 'too-many-attempts');
  assert.strictEqual((await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: c3.code, now })).reason, 'too-many-attempts');
  const c4 = await mr.issueMachineResetCode(db, { userId: OWNER, ip: IP, machineIdHash: HASH_OTHER, now: now + 1000 });
  assert.match(c4.code, /^\d{6}$/);
  assert.strictEqual((await db.get('SELECT attempts FROM sc_machine_reset_codes')).attempts, 0);

  // Reset kedua: jatah habis.
  const ok2 = await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: c4.code, now: now + 2000 });
  assert.strictEqual(ok2.ok, true);
  assert.strictEqual(ok2.usage.left, 0);
  const firstResetAt = now - DAY;
  assert.strictEqual(ok2.usage.nextAt, firstResetAt + mr.RESET_WINDOW_MS, 'jatah terbuka 7 hari setelah reset pertama');
  assert.strictEqual((await keyRow(db)).machine_id_hash, HASH_OTHER);

  // Jatah habis: tidak ada kode, installer diberi tahu kapan bisa lagi.
  const none = await mr.issueMachineResetCode(db, { userId: OWNER, ip: IP, machineIdHash: HASH_NEW, now: now + 3000 });
  assert.strictEqual(none.code, null);
  assert.strictEqual(none.usage.left, 0);

  // Kode yang terlanjur dibuat sebelum jatah habis tetap ditolak saat dipakai.
  await db.run(
    'INSERT INTO sc_machine_reset_codes (vps_ip, user_id, code, machine_id_hash, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)',
    [IP, OWNER, '123456', HASH_NEW, now, now + mr.RESET_CODE_TTL_MS]
  );
  assert.strictEqual((await mr.redeemMachineResetCode(db, { userId: OWNER, ip: IP, code: '123456', now: now + 4000 })).reason, 'limit');

  // Reset admin dicatat tapi tidak dihitung jatah, dan membuang kode menunggu.
  await mr.recordAdminMachineReset(db, { userId: 0, ip: IP, actorId: 99, now: now + 5000 });
  assert.strictEqual(await db.get('SELECT * FROM sc_machine_reset_codes WHERE vps_ip = ?', [IP]), null);
  assert.strictEqual((await mr.machineResetUsage(db, IP, now + 5000)).used, 2);

  // Setelah 7 hari dari reset pertama, satu jatah terbuka lagi.
  const reopened = await mr.issueMachineResetCode(db, { userId: OWNER, ip: IP, machineIdHash: HASH_NEW, now: firstResetAt + mr.RESET_WINDOW_MS + 1 });
  assert.match(reopened.code, /^\d{6}$/);
  assert.strictEqual(reopened.usage.left, 1);

  // IP tanpa key di bot: transaksi dibatalkan, tidak ada riwayat baru.
  const ip2 = '198.51.100.9';
  const k2 = await mr.issueMachineResetCode(db, { userId: OWNER, ip: ip2, machineIdHash: HASH_NEW, now });
  const before = (await db.all('SELECT * FROM sc_machine_resets')).length;
  assert.strictEqual((await mr.redeemMachineResetCode(db, { userId: OWNER, ip: ip2, code: k2.code, now })).reason, 'no-key');
  assert.strictEqual((await db.all('SELECT * FROM sc_machine_resets')).length, before);
  await db.run('BEGIN IMMEDIATE'); // transaksi sebelumnya benar-benar ditutup
  await db.run('ROLLBACK');

  db.raw.close();
}

// Pesan installer saat machine-id berbeda.
function installerNotice() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'setup-autoscript-compat.sh'), 'utf8');
  const grab = (name) => {
    const start = src.indexOf(`${name}() {`);
    assert(start >= 0, `${name} ada di installer`);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 3);
  };
  assert(src.includes('    machine-id-mismatch)\n      license_machine_reset_notice "${resp}" "${vps_ip}"\n      exit 1'), 'installer menangani machine-id-mismatch');
  const bash = process.platform === 'win32' ? 'bash' : '/bin/bash';
  const probe = spawnSync(bash, ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log('  (bash tidak ada, uji tampilan installer dilewati)');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mreset-'));
  const script = path.join(tmp, 'notice.sh');
  fs.writeFileSync(script, `${grab('license_resp_field')}\n${grab('license_machine_reset_notice')}\nlicense_machine_reset_notice "$(cat "$1")" 203.0.113.7\n`);
  const run = (obj) => {
    const f = path.join(tmp, 'resp.json');
    fs.writeFileSync(f, JSON.stringify(obj));
    const out = spawnSync(bash, [script.replace(/\\/g, '/'), f.replace(/\\/g, '/')], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    return out.stdout;
  };
  const withCode = run({
    ok: false, code: 'machine-id-mismatch', reset_code: '045123', reset_expires_in_min: 30,
    reset_bot_url: 'https://t.me/contoh_bot', resets_left: 2, reset_limit: 2
  });
  assert(withCode.includes('Machine ID VPS ini berbeda'), withCode);
  assert(withCode.includes('Reset sendiri di bot: https://t.me/contoh_bot'), withCode);
  assert(withCode.includes('pilih IP 203.0.113.7'), withCode);
  assert(withCode.includes('Masukkan kode: 045123'), 'nol di depan kode tidak hilang');
  assert(withCode.includes('berlaku 30 menit'), withCode);
  assert(withCode.includes('Sisa reset mandiri: 2 dari 2 per 7 hari.'), withCode);

  const limit = run({
    ok: false, code: 'machine-id-mismatch', reset_bot_url: 'https://t.me/contoh_bot',
    resets_left: 0, reset_limit: 2, reset_available_at: 1800604800000
  });
  assert(limit.includes('Batas reset mandiri (2x per 7 hari) untuk IP 203.0.113.7 sudah habis.'), limit);
  assert(/Reset mandiri bisa lagi mulai \d{2}-\d{2}-\d{4} \d{2}:\d{2}\./.test(limit), limit);
  assert(limit.includes('Atau hubungi admin lewat bot: https://t.me/contoh_bot'), limit);
  assert(!limit.includes('Masukkan kode'), limit);

  // URL bot aneh dari respons tidak dicetak; pakai bawaan.
  const odd = run({ code: 'machine-id-mismatch', reset_code: '111222', reset_bot_url: 'javascript:alert(1)' });
  assert(odd.includes('Reset sendiri di bot: https://t.me/sc1forcrnexusbot'), odd);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// license-api memberi kode di respons 403 machine-id-mismatch.
function licenseApiWiring() {
  const src = fs.readFileSync(path.join(ROOT, 'license-api.js'), 'utf8');
  assert(src.includes("require('./lib/machine-reset')"));
  assert(src.includes('machineReset.ensureMachineResetSchema('));
  assert(src.includes('machineReset.issueMachineResetCode('));
  for (const field of ['reset_bot_url', 'reset_code', 'reset_expires_in_min', 'resets_left', 'reset_limit', 'reset_available_at']) {
    assert(src.includes(`${field}:`), `respons memuat ${field}`);
  }
  const app = fs.readFileSync(path.join(ROOT, 'app3.js'), 'utf8');
  assert(app.includes("bot.action('m_reset_machine'"));
  assert(app.includes("state.step === 'reset_machine_code'"));
  // Bot wajib memeriksa pemilik registrasi sebelum memakai kode.
  const step = app.slice(app.indexOf("state.step === 'reset_machine_code'"));
  assert(step.indexOf('getRegistrationStateByIp(ctx.from.id, ip, false)') < step.indexOf('redeemMachineResetCode'));
  assert(app.includes('machineReset.recordAdminMachineReset('));
}

main()
  .then(() => {
    installerNotice();
    licenseApiWiring();
    console.log('machine reset tests: OK');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

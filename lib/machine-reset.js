'use strict';

// Reset machine-id mandiri setelah VPS di-rebuild (install ulang OS).
//
// Lisensi SC diikat ke IP + key VPS + machine-id. Rebuild mengganti
// machine-id, jadi installer di VPS baru ditolak "machine-id-mismatch".
// Dulu hanya admin yang bisa membuka ikatan itu (Reset Binding VPS).
//
// Alur mandiri:
// 1. license-api menolak aktivasi dan memberi KODE 6 digit untuk mesin yang
//    sedang menjalankan installer (kode terikat ke hash machine-id mesin itu,
//    berlaku 30 menit, satu kode aktif per IP). Kode tampil di layar installer.
// 2. Pemilik registrasi IP itu memasukkan IP + kode di bot (menu Reset
//    Machine ID). Bot memeriksa kepemilikan IP, kode, dan batas reset.
// 3. Binding pindah ke mesin yang menampilkan kode itu, lalu installer yang
//    sama dijalankan lagi dan langsung lolos.
//
// Keamanan: orang yang mendapat IP bekas dari provider bisa melihat kode,
// tetapi tidak bisa memakainya karena IP itu bukan miliknya di bot. Kode
// membuktikan pemilik memegang VPS baru di IP itu. Batas 2 reset per 7 hari
// per IP mencegah satu lisensi dipindah-pindah antara dua mesin di balik IP
// yang sama. Reset oleh admin tidak dihitung.

const crypto = require('crypto');

const RESET_CODE_TTL_MS = 30 * 60 * 1000;
const RESET_LIMIT = 2;
const RESET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_CODE_MAX_ATTEMPTS = 5;

async function ensureMachineResetSchema(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS sc_machine_reset_codes (
    vps_ip TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    machine_id_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  )`);
  await db.run(`CREATE TABLE IF NOT EXISTS sc_machine_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    vps_ip TEXT NOT NULL,
    old_hash TEXT,
    new_hash TEXT,
    source TEXT NOT NULL,
    actor_id INTEGER,
    created_at INTEGER NOT NULL
  )`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_sc_machine_resets_ip ON sc_machine_resets(vps_ip, created_at)');
}

// Pemakaian reset mandiri dalam 7 hari terakhir untuk satu IP.
async function machineResetUsage(db, ip, now = Date.now()) {
  const rows = await db.all(
    "SELECT created_at FROM sc_machine_resets WHERE vps_ip = ? AND source = 'self' AND created_at > ? ORDER BY created_at ASC",
    [ip, now - RESET_WINDOW_MS]
  );
  const used = rows.length;
  return {
    used,
    left: Math.max(0, RESET_LIMIT - used),
    // Kapan jatah berikutnya terbuka (0 = masih ada jatah).
    nextAt: used >= RESET_LIMIT ? Number(rows[used - RESET_LIMIT].created_at) + RESET_WINDOW_MS : 0
  };
}

function newResetCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Dipanggil license-api saat aktivasi ditolak karena machine-id berbeda.
// Mesin yang sama mendapat kode yang sama selama belum kedaluwarsa, supaya
// menjalankan installer berulang tidak membuat kode di layar berganti-ganti.
// Jatah reset habis = tidak ada kode (installer menampilkan kapan bisa lagi).
async function issueMachineResetCode(db, { userId, ip, machineIdHash, now = Date.now() }) {
  const uid = Number(userId || 0);
  const hash = String(machineIdHash || '').trim().toLowerCase();
  if (!uid || !ip || !/^[0-9a-f]{16,128}$/.test(hash)) return { code: null, usage: null };
  const usage = await machineResetUsage(db, ip, now);
  if (usage.left <= 0) return { code: null, usage };
  await db.run('DELETE FROM sc_machine_reset_codes WHERE expires_at <= ?', [now]);
  const row = await db.get('SELECT * FROM sc_machine_reset_codes WHERE vps_ip = ?', [ip]);
  if (row && Number(row.user_id) === uid && row.machine_id_hash === hash &&
      Number(row.expires_at) > now && Number(row.attempts) < RESET_CODE_MAX_ATTEMPTS) {
    return { code: row.code, expiresAt: Number(row.expires_at), usage };
  }
  const code = newResetCode();
  const expiresAt = now + RESET_CODE_TTL_MS;
  await db.run(
    `INSERT INTO sc_machine_reset_codes (vps_ip, user_id, code, machine_id_hash, created_at, expires_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(vps_ip) DO UPDATE SET user_id = excluded.user_id, code = excluded.code,
       machine_id_hash = excluded.machine_id_hash, created_at = excluded.created_at,
       expires_at = excluded.expires_at, attempts = 0`,
    [ip, uid, code, hash, now, expiresAt]
  );
  return { code, expiresAt, usage };
}

function sameCode(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Dipanggil bot setelah memastikan userId memang pemilik registrasi aktif IP
// itu. Binding pindah ke mesin yang menampilkan kode; key VPS tidak dirotasi,
// jadi perintah install yang sama tetap dipakai. Mesin lama (kalau masih ada)
// ditolak karena machine-id-nya tidak lagi cocok.
async function redeemMachineResetCode(db, { userId, ip, code, now = Date.now() }) {
  const uid = Number(userId || 0);
  const input = String(code || '').trim();
  if (!uid || !ip || !/^\d{6}$/.test(input)) return { ok: false, reason: 'format' };
  const row = await db.get('SELECT * FROM sc_machine_reset_codes WHERE vps_ip = ?', [ip]);
  if (!row) return { ok: false, reason: 'no-code' };
  if (Number(row.expires_at) <= now) {
    await db.run('DELETE FROM sc_machine_reset_codes WHERE vps_ip = ?', [ip]);
    return { ok: false, reason: 'expired' };
  }
  if (Number(row.attempts) >= RESET_CODE_MAX_ATTEMPTS) return { ok: false, reason: 'too-many-attempts' };
  // Kode milik pemilik lain diperlakukan sama dengan kode salah.
  if (Number(row.user_id) !== uid || !sameCode(row.code, input)) {
    await db.run('UPDATE sc_machine_reset_codes SET attempts = attempts + 1 WHERE vps_ip = ?', [ip]);
    const left = Math.max(0, RESET_CODE_MAX_ATTEMPTS - Number(row.attempts) - 1);
    return { ok: false, reason: left > 0 ? 'wrong-code' : 'too-many-attempts', attemptsLeft: left };
  }
  const usage = await machineResetUsage(db, ip, now);
  if (usage.left <= 0) return { ok: false, reason: 'limit', usage };

  await db.run('BEGIN IMMEDIATE');
  try {
    const key = await db.get(
      'SELECT machine_id_hash FROM sc_server_keys WHERE user_id = ? AND vps_ip = ?',
      [uid, ip]
    );
    if (!key) {
      await db.run('ROLLBACK');
      return { ok: false, reason: 'no-key' };
    }
    await db.run(
      `UPDATE sc_server_keys SET machine_id_hash = ?, machine_bound_at = ?, last_lease_at = NULL, updated_at = ?
       WHERE user_id = ? AND vps_ip = ?`,
      [row.machine_id_hash, now, now, uid, ip]
    );
    await db.run(
      "INSERT INTO sc_machine_resets (user_id, vps_ip, old_hash, new_hash, source, actor_id, created_at) VALUES (?, ?, ?, ?, 'self', ?, ?)",
      [uid, ip, key.machine_id_hash || null, row.machine_id_hash, uid, now]
    );
    await db.run('DELETE FROM sc_machine_reset_codes WHERE vps_ip = ?', [ip]);
    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK').catch(() => {});
    throw err;
  }
  return { ok: true, usage: await machineResetUsage(db, ip, now) };
}

// Reset oleh admin (Reset Binding VPS) dicatat untuk riwayat, tidak dihitung
// ke jatah mandiri. Kode yang masih menunggu untuk IP itu dibuang.
async function recordAdminMachineReset(db, { userId, ip, actorId, now = Date.now() }) {
  await db.run(
    "INSERT INTO sc_machine_resets (user_id, vps_ip, old_hash, new_hash, source, actor_id, created_at) VALUES (?, ?, NULL, NULL, 'admin', ?, ?)",
    [Number(userId || 0), ip, Number(actorId || 0) || null, now]
  );
  await db.run('DELETE FROM sc_machine_reset_codes WHERE vps_ip = ?', [ip]);
}

module.exports = {
  RESET_CODE_TTL_MS,
  RESET_LIMIT,
  RESET_WINDOW_MS,
  RESET_CODE_MAX_ATTEMPTS,
  ensureMachineResetSchema,
  machineResetUsage,
  issueMachineResetCode,
  redeemMachineResetCode,
  recordAdminMachineReset
};

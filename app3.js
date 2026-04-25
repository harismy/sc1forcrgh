const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN belum diisi di .env');
  process.exit(1);
}

const DB_PATH = String(process.env.DB_PATH || path.join(__dirname, 'sc1forcrnexus.db')).trim();
const DEFAULT_SC_REGISTRATION_PRICE_PER_DAY = Math.max(
  0,
  Number(process.env.SC_REGISTRATION_PRICE_PER_DAY || process.env.SC_REGISTRATION_FEE || 25000) || 25000
);
const DEFAULT_SC_REGISTRATION_MIN_DAYS = Math.max(1, Number(process.env.SC_REGISTRATION_MIN_DAYS || 1) || 1);
const DEFAULT_TOPUP_MIN = Math.max(1000, Number(process.env.TOPUP_MIN || 5000) || 5000);
const DEFAULT_TOPUP_EXPIRE_MS = Math.max(60000, Number(process.env.TOPUP_EXPIRE_MS || (5 * 60 * 1000)) || (5 * 60 * 1000));
const DEFAULT_LICENSE_API_PORT = Math.max(1, Number(process.env.LICENSE_API_PORT || 8099) || 8099);
const DEFAULT_AUTO_PROVISION_DOMAIN = /^(1|true|yes|on)$/i.test(String(process.env.AUTO_PROVISION_DOMAIN || '1').trim());
const DEFAULT_CERTBOT_EMAIL = String(process.env.CERTBOT_EMAIL || '').trim();
const DEFAULT_SC_INSTALLER_LOCAL_PATH = String(
  process.env.SC_INSTALLER_LOCAL_PATH || path.join(__dirname, 'payload', 'setup-autoscript-compat.sh')
).trim();
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map((v) => Number(String(v || '').trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const bot = new Telegraf(BOT_TOKEN);
const userState = new Map();
const db = new sqlite3.Database(DB_PATH);
const DYNAMIC_SETTING_KEYS = [
  'SC_REGISTRATION_PRICE_PER_DAY',
  'SC_REGISTRATION_MIN_DAYS',
  'TOPUP_MIN',
  'TOPUP_EXPIRE_MS',
  'AUTO_PROVISION_DOMAIN',
  'CERTBOT_EMAIL',
  'SC_INSTALLER_LOCAL_PATH'
];
const SETTING_LABELS = {
  SC_REGISTRATION_PRICE_PER_DAY: 'Harga SC per Hari',
  SC_REGISTRATION_MIN_DAYS: 'Minimal Hari Pembelian',
  TOPUP_MIN: 'Minimal Top Up Saldo',
  TOPUP_EXPIRE_MS: 'Masa Aktif QR Top Up',
  AUTO_PROVISION_DOMAIN: 'Auto Setup Domain',
  CERTBOT_EMAIL: 'Email Certbot',
  SC_INSTALLER_LOCAL_PATH: 'Path Script Installer'
};
const DAY_MS = 24 * 60 * 60 * 1000;

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function initDb() {
  await dbRun('CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, saldo INTEGER DEFAULT 0)');
  await dbRun(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount INTEGER,
    type TEXT,
    reference_id TEXT,
    timestamp INTEGER
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS sc_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    vps_ip TEXT NOT NULL,
    client_name TEXT,
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER,
    UNIQUE(user_id, vps_ip)
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS pending_deposits_app3 (
    unique_code TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    provider_tx_id TEXT,
    qr_url TEXT,
    reference_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS api_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    added_by INTEGER
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER
  )`);
  await ensureScRegistrationSchema();
  await seedDefaultSettings();
}

async function ensureScRegistrationSchema() {
  const cols = await dbAll('PRAGMA table_info(sc_registrations)');
  const hasExpires = cols.some((c) => String(c?.name || '').toLowerCase() === 'expires_at');
  const hasClientName = cols.some((c) => String(c?.name || '').toLowerCase() === 'client_name');
  if (!hasExpires) {
    await dbRun('ALTER TABLE sc_registrations ADD COLUMN expires_at INTEGER');
  }
  if (!hasClientName) {
    await dbRun('ALTER TABLE sc_registrations ADD COLUMN client_name TEXT');
  }
}

async function seedDefaultSettings() {
  const now = Date.now();
  const defaults = {
    SC_REGISTRATION_PRICE_PER_DAY: String(DEFAULT_SC_REGISTRATION_PRICE_PER_DAY),
    SC_REGISTRATION_MIN_DAYS: String(DEFAULT_SC_REGISTRATION_MIN_DAYS),
    TOPUP_MIN: String(DEFAULT_TOPUP_MIN),
    TOPUP_EXPIRE_MS: String(DEFAULT_TOPUP_EXPIRE_MS),
    AUTO_PROVISION_DOMAIN: DEFAULT_AUTO_PROVISION_DOMAIN ? '1' : '0',
    CERTBOT_EMAIL: DEFAULT_CERTBOT_EMAIL,
    SC_INSTALLER_LOCAL_PATH: DEFAULT_SC_INSTALLER_LOCAL_PATH
  };
  for (const [key, value] of Object.entries(defaults)) {
    await dbRun(
      'INSERT OR IGNORE INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)',
      [key, String(value), now, 0]
    );
  }
}

async function setDynamicSetting(key, value, userId = 0) {
  const now = Date.now();
  await dbRun(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    [key, String(value), now, Number(userId) || 0]
  );
}

async function getDynamicSetting(key, fallback = '') {
  const row = await dbGet('SELECT value FROM app_settings WHERE key = ? LIMIT 1', [key]);
  const v = String(row?.value || '').trim();
  return v === '' ? String(fallback || '') : v;
}

function parseBool01(raw, fallback = false) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

async function getSettingNumber(key, fallback, min = null, max = null) {
  const raw = await getDynamicSetting(key, String(fallback));
  let n = Number(raw);
  if (!Number.isFinite(n)) n = Number(fallback);
  n = Math.floor(n);
  if (Number.isFinite(min) && n < min) n = min;
  if (Number.isFinite(max) && n > max) n = max;
  return n;
}

async function getRegistrationPricePerDay() {
  const rawNew = await getDynamicSetting('SC_REGISTRATION_PRICE_PER_DAY', '');
  if (rawNew) {
    const n = Number(rawNew);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return getSettingNumber('SC_REGISTRATION_FEE', DEFAULT_SC_REGISTRATION_PRICE_PER_DAY, 0, 1000000000);
}

async function getRegistrationMinDays() {
  return getSettingNumber('SC_REGISTRATION_MIN_DAYS', DEFAULT_SC_REGISTRATION_MIN_DAYS, 1, 3650);
}

async function getTopupMin() {
  return getSettingNumber('TOPUP_MIN', DEFAULT_TOPUP_MIN, 1000, 1000000000);
}

async function getTopupExpireMs() {
  return getSettingNumber('TOPUP_EXPIRE_MS', DEFAULT_TOPUP_EXPIRE_MS, 60000, 86400000);
}

async function getAutoProvisionDomain() {
  const raw = await getDynamicSetting('AUTO_PROVISION_DOMAIN', DEFAULT_AUTO_PROVISION_DOMAIN ? '1' : '0');
  return parseBool01(raw, DEFAULT_AUTO_PROVISION_DOMAIN);
}

async function getCertbotEmail() {
  return getDynamicSetting('CERTBOT_EMAIL', DEFAULT_CERTBOT_EMAIL);
}

async function getScInstallerLocalPath() {
  return getDynamicSetting('SC_INSTALLER_LOCAL_PATH', DEFAULT_SC_INSTALLER_LOCAL_PATH);
}

async function getDynamicSettingsSnapshot() {
  const [pricePerDay, minDays, minTopup, expMs, autoProv, certEmail, installerPath] = await Promise.all([
    getRegistrationPricePerDay(),
    getRegistrationMinDays(),
    getTopupMin(),
    getTopupExpireMs(),
    getAutoProvisionDomain(),
    getCertbotEmail(),
    getScInstallerLocalPath()
  ]);
  return {
    SC_REGISTRATION_PRICE_PER_DAY: String(pricePerDay),
    SC_REGISTRATION_MIN_DAYS: String(minDays),
    TOPUP_MIN: String(minTopup),
    TOPUP_EXPIRE_MS: String(expMs),
    AUTO_PROVISION_DOMAIN: autoProv ? '1' : '0',
    CERTBOT_EMAIL: certEmail || '-',
    SC_INSTALLER_LOCAL_PATH: installerPath
  };
}

function normalizeHost(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return cleaned.split('/')[0].trim();
}

function isIpv4(input) {
  const s = String(input || '').trim();
  if (!/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(s)) return false;
  return s.split('.').every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function parseErr(err) {
  const status = err?.response?.status;
  const msg = err?.response?.data?.message || err?.message || 'unknown error';
  if (status === 401) return 'Tidak diizinkan: key server salah atau tidak terdaftar.';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) {
    return 'Host tidak bisa diakses. Pastikan API summary aktif di port 8789.';
  }
  return msg;
}

function uiBox(title, lines = []) {
  const sep = '============================================================';
  const body = Array.isArray(lines) ? lines.map((x) => String(x ?? '')) : [String(lines || '')];
  return [sep, ` ${String(title || '').trim()}`, sep, '', ...body, sep].join('\n');
}

function normalizeScriptLineEndings(input) {
  const s = String(input || '');
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function formatDateTime(ts) {
  const n = Number(ts || 0);
  if (!n) return '-';
  return new Date(n).toLocaleString('id-ID', { hour12: false, timeZone: 'Asia/Jakarta' });
}

function formatRemainingDays(expiresAt) {
  const n = Number(expiresAt || 0);
  if (!n) return 'tanpa batas';
  const diff = n - Date.now();
  if (diff <= 0) return 'sudah kedaluwarsa';
  const days = Math.ceil(diff / DAY_MS);
  return `${days} hari lagi`;
}

function formatTopupStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'pending') return 'menunggu pembayaran';
  if (s === 'paid') return 'berhasil';
  if (s === 'expired') return 'kedaluwarsa';
  if (s === 'cancelled') return 'dibatalkan';
  return s || '-';
}

function normalizeClientName(input) {
  const raw = String(input || '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  return raw.slice(0, 60);
}

function loadVars() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.vars.json'), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function normalizeHttpUrl(urlLike) {
  const raw = String(urlLike || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '');
  return `https://${raw.replace(/\/$/, '')}`;
}

function isGopayEnabled() {
  const vars = loadVars();
  const mode = String(vars.PAYMENT_GATEWAY_MODE || 'both').trim().toLowerCase();
  return mode === 'gopay' || mode === 'both';
}

function getGopayConfig() {
  const vars = loadVars();
  const baseUrl = normalizeHttpUrl(vars.GOPAY_API_BASE_URL || 'https://api-gopay.sawargipay.cloud');
  const apiKey = String(vars.GOPAY_API_KEY || '').trim();
  return { baseUrl, apiKey };
}

async function createGoPayQr(amount) {
  const { baseUrl, apiKey } = getGopayConfig();
  if (!isGopayEnabled()) throw new Error('Gateway GoPay sedang nonaktif di konfigurasi admin.');
  if (!apiKey) throw new Error('GOPAY_API_KEY belum diisi di .vars.json');

  const response = await axios.post(
    `${baseUrl}/qris/generate`,
    { amount: Number(amount) },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );
  const body = response?.data || {};
  if (!body.success || !body?.data?.transaction_id || !body?.data?.qr_url) {
    throw new Error('GoPay gagal create QR: ' + JSON.stringify(body));
  }
  return {
    providerTxId: String(body.data.transaction_id),
    qrUrl: String(body.data.qr_url)
  };
}

async function checkGoPayStatus(transactionId) {
  const { baseUrl, apiKey } = getGopayConfig();
  if (!apiKey) throw new Error('GOPAY_API_KEY belum diisi di .vars.json');

  const response = await axios.post(
    `${baseUrl}/qris/status`,
    { transaction_id: transactionId },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );
  const body = response?.data || {};
  const status = String(body?.data?.transaction_status || '').toLowerCase();
  return {
    status,
    settled: status === 'settlement' || status === 'paid' || status === 'success',
    pending: status === 'pending' || !status
  };
}

async function ensureUser(userId) {
  await dbRun('INSERT OR IGNORE INTO users (user_id, saldo) VALUES (?, 0)', [userId]);
}

async function getSaldo(userId) {
  await ensureUser(userId);
  const row = await dbGet('SELECT saldo FROM users WHERE user_id = ?', [userId]);
  return Number(row?.saldo || 0);
}

async function addSaldo(userId, amount) {
  await ensureUser(userId);
  await dbRun('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, userId]);
}

async function deductSaldoAtomic(userId, amount) {
  const tx = await dbRun('UPDATE users SET saldo = saldo - ? WHERE user_id = ? AND saldo >= ?', [amount, userId, amount]);
  return Number(tx?.changes || 0) > 0;
}

async function saveTransaction(userId, amount, type, referenceId) {
  await dbRun(
    'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
    [userId, amount, type, referenceId, Date.now()]
  ).catch(() => {});
}

async function getActiveRegistrations(userId) {
  await dbRun(
    "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [Date.now(), Date.now()]
  ).catch(() => {});
  return dbAll(
    "SELECT vps_ip, client_name, created_at, updated_at, expires_at FROM sc_registrations WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?) ORDER BY updated_at DESC",
    [userId, Date.now()]
  );
}

async function listActiveRegistrationsForAdmin(limit = 15) {
  const now = Date.now();
  await dbRun(
    "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [now, now]
  ).catch(() => {});
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 15));
  return dbAll(
    "SELECT user_id, vps_ip, client_name, expires_at, updated_at FROM sc_registrations " +
      "WHERE status = 'active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?) " +
      "ORDER BY updated_at DESC LIMIT ?",
    [now, safeLimit]
  );
}

async function adminRemoveRegisteredIp(ip, adminId) {
  const now = Date.now();
  const rows = await dbAll(
    "SELECT id, user_id, vps_ip, client_name, expires_at FROM sc_registrations " +
      "WHERE LOWER(vps_ip)=LOWER(?) AND status='active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?)",
    [ip, now]
  );
  if (!rows.length) {
    return { removed: 0, rows: [] };
  }
  const tx = await dbRun(
    "UPDATE sc_registrations SET status = 'deleted_by_admin', updated_at = ?, expires_at = ? " +
      "WHERE LOWER(vps_ip)=LOWER(?) AND status='active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?)",
    [now, now, ip, now]
  );
  await saveTransaction(
    Number(adminId) || 0,
    0,
    'admin_remove_sc_ip',
    `admin_remove_sc_ip_${ip}_${now}`
  ).catch(() => {});
  return { removed: Number(tx?.changes || 0), rows };
}

async function isIpOwnedByOther(ip, userId) {
  await dbRun(
    "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [Date.now(), Date.now()]
  ).catch(() => {});
  const row = await dbGet(
    "SELECT user_id FROM sc_registrations WHERE vps_ip = ? AND status = 'active' AND user_id <> ? AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?) LIMIT 1",
    [ip, userId, Date.now()]
  );
  return !!row;
}

async function hasRegisteredSc(userId) {
  await dbRun(
    "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [Date.now(), Date.now()]
  ).catch(() => {});
  const row = await dbGet(
    "SELECT 1 AS ok FROM sc_registrations WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?) LIMIT 1",
    [userId, Date.now()]
  );
  return !!row;
}

async function isRegisteredHost(userId, host) {
  await dbRun(
    "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [Date.now(), Date.now()]
  ).catch(() => {});
  const row = await dbGet(
    "SELECT 1 AS ok FROM sc_registrations WHERE user_id = ? AND vps_ip = ? AND status = 'active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?) LIMIT 1",
    [userId, host, Date.now()]
  );
  return !!row;
}

async function getUserRegistration(userId, ip) {
  return dbGet(
    'SELECT id, user_id, vps_ip, client_name, status, created_at, updated_at, expires_at FROM sc_registrations WHERE user_id = ? AND vps_ip = ? LIMIT 1',
    [userId, ip]
  );
}

async function registerScIp(userId, ip, clientName, days, totalFee) {
  await ensureUser(userId);

  if (await isIpOwnedByOther(ip, userId)) {
    throw new Error('IP VPS ini sudah terdaftar oleh user lain.');
  }

  const existing = await dbGet(
    "SELECT id, status, expires_at, client_name FROM sc_registrations WHERE user_id = ? AND vps_ip = ? LIMIT 1",
    [userId, ip]
  );

  await dbRun('BEGIN IMMEDIATE TRANSACTION');
  try {
    const ok = await deductSaldoAtomic(userId, totalFee);
    if (!ok) {
      await dbRun('ROLLBACK');
      return { insufficient: true };
    }

    const now = Date.now();
    const baseExpiry = Math.max(now, Number(existing?.expires_at || 0));
    const nextExpiry = baseExpiry + (days * DAY_MS);
    const finalClientName = normalizeClientName(clientName || existing?.client_name || ip);
    await dbRun(
      `INSERT INTO sc_registrations (user_id, vps_ip, client_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)
       ON CONFLICT(user_id, vps_ip) DO UPDATE SET
         status='active',
         updated_at=excluded.updated_at,
         client_name=excluded.client_name`,
      [userId, ip, finalClientName, now, now]
    );
    await dbRun(
      'UPDATE sc_registrations SET status = ?, updated_at = ?, expires_at = ?, client_name = ? WHERE user_id = ? AND vps_ip = ?',
      ['active', now, nextExpiry, finalClientName, userId, ip]
    );

    await saveTransaction(userId, -totalFee, 'sc_registration', `sc_reg_${userId}_${ip}_${days}d_${now}`);
    await dbRun('COMMIT');
    return { success: true, expiresAt: nextExpiry, clientName: finalClientName };
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Daftar / Perpanjang SC', 'm_register_sc')],
    [Markup.button.callback('SC Saya', 'm_my_sc')],
    [Markup.button.callback('Link Instalasi', 'm_install_link')],
    [Markup.button.callback('Top Up Saldo', 'm_topup_saldo')],
    [Markup.button.callback('Cek Saldo', 'm_cek_saldo')],
    [Markup.button.callback('Cadangkan SC', 'm_backup_now')],
    [Markup.button.callback('Pulihkan SC', 'm_restore_upload')],
    [Markup.button.callback('Menu Admin', 'm_admin_menu')]
  ]);
}

function registerScMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Registrasi Baru', 'm_register_sc_new')],
    [Markup.button.callback('Perpanjang SC', 'm_register_sc_extend')],
    [Markup.button.callback('Kembali', 'm_register_sc_back')]
  ]);
}

function adminMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Tambah Domain', 'm_admin_add_domain')],
    [Markup.button.callback('Daftar Domain', 'm_admin_list_domains')],
    [Markup.button.callback('Hapus Domain', 'm_admin_remove_domain')],
    [Markup.button.callback('Hapus IP VPS Terdaftar', 'm_admin_remove_sc_ip')],
    [Markup.button.callback('Tambah Saldo User', 'm_admin_add_saldo')],
    [Markup.button.callback('Lihat Pengaturan', 'm_admin_env_show')],
    [Markup.button.callback('Ubah Pengaturan', 'm_admin_env_set')],
    [Markup.button.callback('Unggah Script SC', 'm_admin_upload_sc')],
    [Markup.button.callback('Kembali', 'm_admin_back')]
  ]);
}

function adminEnvMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Tagihan', 'm_admin_env_group_billing')],
    [Markup.button.callback('Domain/SSL', 'm_admin_env_group_prov')],
    [Markup.button.callback('File Installer', 'm_admin_env_group_installer')],
    [Markup.button.callback('Input Manual', 'm_admin_env_manual')],
    [Markup.button.callback('Kembali', 'm_admin_env_back_admin')]
  ]);
}

function adminEnvGroupMenu(group) {
  const g = String(group || '').toLowerCase();
  if (g === 'billing') {
    return Markup.inlineKeyboard([
      [Markup.button.callback(getSettingLabel('SC_REGISTRATION_PRICE_PER_DAY'), 'm_admin_env_pick_SC_REGISTRATION_PRICE_PER_DAY')],
      [Markup.button.callback(getSettingLabel('SC_REGISTRATION_MIN_DAYS'), 'm_admin_env_pick_SC_REGISTRATION_MIN_DAYS')],
      [Markup.button.callback(getSettingLabel('TOPUP_MIN'), 'm_admin_env_pick_TOPUP_MIN')],
      [Markup.button.callback(getSettingLabel('TOPUP_EXPIRE_MS'), 'm_admin_env_pick_TOPUP_EXPIRE_MS')],
      [Markup.button.callback('Kembali', 'm_admin_env_set')]
    ]);
  }
  if (g === 'prov') {
    return Markup.inlineKeyboard([
      [Markup.button.callback(getSettingLabel('AUTO_PROVISION_DOMAIN'), 'm_admin_env_pick_AUTO_PROVISION_DOMAIN')],
      [Markup.button.callback(getSettingLabel('CERTBOT_EMAIL'), 'm_admin_env_pick_CERTBOT_EMAIL')],
      [Markup.button.callback('Kembali', 'm_admin_env_set')]
    ]);
  }
  if (g === 'installer') {
    return Markup.inlineKeyboard([
      [Markup.button.callback(getSettingLabel('SC_INSTALLER_LOCAL_PATH'), 'm_admin_env_pick_SC_INSTALLER_LOCAL_PATH')],
      [Markup.button.callback('Kembali', 'm_admin_env_set')]
    ]);
  }
  return adminEnvMenu();
}

function envKeyInputHint(key) {
  switch (String(key || '').toUpperCase()) {
    case 'SC_REGISTRATION_PRICE_PER_DAY':
      return 'Contoh: 25000 (rupiah per hari, angka bulat).';
    case 'SC_REGISTRATION_MIN_DAYS':
      return 'Contoh: 1 (minimal hari pembelian user).';
    case 'TOPUP_MIN':
      return 'Contoh: 5000 (minimal top up saldo).';
    case 'TOPUP_EXPIRE_MS':
      return 'Contoh: 900000 untuk 15 menit.';
    case 'AUTO_PROVISION_DOMAIN':
      return 'Isi: 1 atau 0 (1=aktif, 0=nonaktif).';
    case 'CERTBOT_EMAIL':
      return 'Contoh: admin@domainkamu.com (boleh kosong).';
    case 'SC_INSTALLER_LOCAL_PATH':
      return 'Contoh: /root/botsc1forcrnexus/payload/setup-autoscript-compat.sh';
    default:
      return '';
  }
}

function getSettingLabel(key) {
  const k = String(key || '').trim().toUpperCase();
  return SETTING_LABELS[k] || k;
}

function resolveSettingKeyInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (DYNAMIC_SETTING_KEYS.includes(upper)) return upper;

  const byNum = Number(raw);
  if (Number.isInteger(byNum) && byNum >= 1 && byNum <= DYNAMIC_SETTING_KEYS.length) {
    return DYNAMIC_SETTING_KEYS[byNum - 1];
  }

  const normalized = upper.replace(/\s+/g, ' ').trim();
  for (const key of DYNAMIC_SETTING_KEYS) {
    if (getSettingLabel(key).toUpperCase() === normalized) return key;
  }
  return '';
}

async function requireRegistered(ctx) {
  const ok = await hasRegisteredSc(ctx.from.id);
  if (ok) return true;
  await ctx.reply(
    'Akses fitur SC ditolak.\n\n' +
      'Kamu harus registrasi/perpanjang SC 1FORCR Nexus dulu (wajib punya saldo).\n' +
      'Gunakan menu: "Daftar / Perpanjang SC".',
    mainMenu()
  );
  return false;
}

async function apiGet(host, key, endpoint, params = {}) {
  const url = `http://${host}:8789${endpoint}`;
  const res = await axios.get(url, {
    timeout: 60000,
    headers: { 'x-sync-token': key },
    params
  });
  if (!res.data?.ok) throw new Error(res.data?.message || 'request gagal');
  return res.data;
}

async function apiPost(host, key, endpoint, body = {}, timeoutMs = 120000) {
  const url = `http://${host}:8789${endpoint}`;
  const res = await axios.post(url, body, {
    timeout: Number(timeoutMs) || 120000,
    headers: { 'x-sync-token': key }
  });
  if (!res.data?.ok) throw new Error(res.data?.message || 'request gagal');
  return res.data;
}

function makeUniqueCode(userId) {
  return `${Date.now()}_${userId}_${Math.floor(Math.random() * 1000)}`;
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function normalizeDomain(input) {
  const host = normalizeHost(input);
  return String(host || '').toLowerCase();
}

function isDomainLike(input) {
  const d = String(input || '').trim().toLowerCase();
  if (!d) return false;
  return /^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(d);
}

function normalizeDomainWithoutPort(input) {
  const raw = normalizeDomain(input);
  if (!raw) return '';
  const noPort = raw.replace(/:\d{1,5}$/, '');
  return noPort.trim();
}

function isProvisionableDomain(input) {
  const d = normalizeDomainWithoutPort(input);
  if (!d) return false;
  if (isIpv4(d)) return false;
  return /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d);
}

function runCmd(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function ensureRuntimeDeps() {
  try {
    runCmd('nginx', ['-v']);
  } catch (_) {
    throw new Error('nginx belum terpasang di server bot.');
  }
  try {
    runCmd('certbot', ['--version']);
  } catch (_) {
    throw new Error('certbot belum terpasang di server bot.');
  }
}

function writeNginxInstallerVhost(domain, targetPort) {
  const confPath = `/etc/nginx/sites-available/sc1forcr-installer-${domain}.conf`;
  const linkPath = `/etc/nginx/sites-enabled/sc1forcr-installer-${domain}.conf`;
  const cfg = [
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${domain};`,
    '    client_max_body_size 16m;',
    '',
    '    location /.well-known/acme-challenge/ {',
    '        root /var/www/certbot;',
    '    }',
    '',
    '    location / {',
    `        proxy_pass http://127.0.0.1:${targetPort};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_read_timeout 300s;',
    '    }',
    '}',
    ''
  ].join('\n');
  fs.mkdirSync('/var/www/certbot', { recursive: true });
  fs.writeFileSync(confPath, cfg, 'utf8');
  try { fs.chmodSync(confPath, 0o644); } catch (_) {}
  try {
    if (!fs.existsSync(linkPath)) fs.symlinkSync(confPath, linkPath);
  } catch (_) {
    // If symlink already exists but broken/invalid, overwrite it.
    try {
      fs.rmSync(linkPath, { force: true });
      fs.symlinkSync(confPath, linkPath);
    } catch (e) {
      throw new Error(`gagal membuat symlink nginx: ${e.message}`);
    }
  }
}

async function provisionInstallerDomain(domain) {
  const autoProvisionEnabled = await getAutoProvisionDomain();
  if (!autoProvisionEnabled) return;
  if (!isProvisionableDomain(domain)) {
    throw new Error('domain tidak valid untuk auto-provision SSL.');
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('bot harus jalan sebagai root agar bisa auto-setup nginx+SSL.');
  }

  ensureRuntimeDeps();
  writeNginxInstallerVhost(domain, DEFAULT_LICENSE_API_PORT);
  runCmd('nginx', ['-t']);
  runCmd('systemctl', ['reload', 'nginx']);

  const certbotEmail = await getCertbotEmail();
  const certbotArgs = ['--nginx', '-d', domain, '--non-interactive', '--agree-tos', '--redirect'];
  if (certbotEmail) {
    certbotArgs.push('-m', certbotEmail);
  } else {
    certbotArgs.push('--register-unsafely-without-email');
  }
  runCmd('certbot', certbotArgs);
  runCmd('nginx', ['-t']);
  runCmd('systemctl', ['reload', 'nginx']);
}

async function addApiDomain(domain, adminId) {
  const now = Date.now();
  await dbRun(
    `INSERT INTO api_domains (domain, is_active, created_at, updated_at, added_by)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET is_active=1, updated_at=excluded.updated_at, added_by=excluded.added_by`,
    [domain, now, now, adminId]
  );
}

async function removeApiDomain(domain) {
  await dbRun('DELETE FROM api_domains WHERE LOWER(domain)=LOWER(?)', [domain]);
}

async function listApiDomains() {
  return dbAll('SELECT domain, is_active, updated_at FROM api_domains ORDER BY domain ASC');
}

async function getPrimaryApiDomain() {
  const row = await dbGet('SELECT domain FROM api_domains WHERE is_active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1');
  return String(row?.domain || '').trim();
}

async function buildInstallerQuickCopyText() {
  const domain = await getPrimaryApiDomain();
  if (!domain) {
    return '\n\nLink installer belum tersedia. Hubungi admin untuk set domain installer.';
  }
  const installerUrl = `https://${domain}/sc1forcr/installer.sh`;
  const cmd = ```bash -c "$(curl -fsSL ${installerUrl})"```;
  return `\n\nLink installer:\n${installerUrl}\n\nPerintah install (copy-paste):\n${cmd}`;
}

async function markPendingPaid(row) {
  if (!row) return false;
  await dbRun('BEGIN IMMEDIATE TRANSACTION');
  try {
    const latest = await dbGet('SELECT status FROM pending_deposits_app3 WHERE unique_code = ?', [row.unique_code]);
    if (!latest || latest.status !== 'pending') {
      await dbRun('ROLLBACK');
      return false;
    }
    await addSaldo(row.user_id, Number(row.amount || 0));
    await dbRun("UPDATE pending_deposits_app3 SET status='paid' WHERE unique_code = ?", [row.unique_code]);
    await saveTransaction(row.user_id, Number(row.amount || 0), 'deposit', String(row.reference_id || row.unique_code));
    await dbRun('COMMIT');
    return true;
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function pollPendingTopups() {
  try {
    const now = Date.now();
    const rows = await dbAll("SELECT * FROM pending_deposits_app3 WHERE status = 'pending' ORDER BY created_at ASC LIMIT 30");
    for (const row of rows) {
      const expiresAt = Number(row.expires_at || 0);
      if (expiresAt > 0 && now > expiresAt) {
        await dbRun("UPDATE pending_deposits_app3 SET status='expired' WHERE unique_code = ?", [row.unique_code]);
        await bot.telegram.sendMessage(
          row.user_id,
          `Top Up Saldo kedaluwarsa.\nRef: ${row.reference_id || row.unique_code}\nNominal: Rp ${Number(row.amount || 0).toLocaleString('id-ID')}`
        ).catch(() => {});
        continue;
      }

      const st = await checkGoPayStatus(String(row.provider_tx_id || '')).catch(() => null);
      if (!st || st.pending) continue;
      if (st.settled) {
        const credited = await markPendingPaid(row);
        if (credited) {
          const saldoNow = await getSaldo(row.user_id).catch(() => 0);
          await bot.telegram.sendMessage(
            row.user_id,
            `Top Up Saldo berhasil.\nRef: ${row.reference_id || row.unique_code}\nNominal: Rp ${Number(row.amount || 0).toLocaleString('id-ID')}\nSaldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}`
          ).catch(() => {});
        }
      }
    }
  } catch (_) {
    // ignore polling errors
  }
}

bot.start(async (ctx) => {
  userState.delete(ctx.chat.id);
  const saldo = await getSaldo(ctx.from.id).catch(() => 0);
  const regs = await getActiveRegistrations(ctx.from.id).catch(() => []);
  const [pricePerDay, minDays] = await Promise.all([getRegistrationPricePerDay(), getRegistrationMinDays()]);
  await ctx.reply(
    uiBox('SC 1FORCR NEXUS - INFORMASI AKUN', [
      `Saldo Kamu       : Rp ${Number(saldo).toLocaleString('id-ID')}`,
      `IP Terdaftar     : ${regs.length}`,
      `Harga SC / Hari  : Rp ${pricePerDay.toLocaleString('id-ID')}`,
      `Minimal Hari     : ${minDays} hari`,
      '',
      'Alur Cepat:',
      '1) Top Up Saldo',
      '2) Daftar / Perpanjang SC',
      '3) Gunakan fitur SC (backup/restore)',
      isAdmin(ctx.from.id) ? '' : '',
      isAdmin(ctx.from.id) ? 'Admin: gunakan /admin untuk kelola layanan.' : ''
    ]),
    mainMenu()
  );
});

bot.command('menu', async (ctx) => {
  userState.delete(ctx.chat.id);
  await ctx.reply('Pilih menu:', mainMenu());
});

bot.command('admin', async (ctx) => {
  userState.delete(ctx.chat.id);
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  await ctx.reply('Menu admin SC1FORCR Nexus:', adminMenu());
});

bot.action('m_admin_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  await ctx.reply('Menu admin SC1FORCR Nexus:', adminMenu());
});

bot.action('m_admin_back', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('Kembali ke menu utama.', mainMenu());
});

bot.action('m_admin_add_domain', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_add_domain' });
  await ctx.reply(
    'Masukkan domain API installer (tanpa port). Contoh: installer.domainkamu.com\n' +
      'Bot akan auto-setup nginx + SSL certbot di server ini.'
  );
});

bot.action('m_admin_remove_domain', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_remove_domain' });
  await ctx.reply('Masukkan domain API yang ingin dihapus.');
});

bot.action('m_admin_remove_sc_ip', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_remove_sc_ip' });
  const rows = await listActiveRegistrationsForAdmin(12).catch(() => []);
  const preview = rows.length
    ? rows.map((r, i) => `${i + 1}. ${r.vps_ip} (user ${r.user_id})`).join('\n')
    : '(tidak ada registrasi aktif)';
  await ctx.reply(
    uiBox('HAPUS IP VPS TERDAFTAR', [
      'Masukkan IP VPS yang ingin dihapus dari registrasi aktif.',
      'Contoh: 103.10.10.2',
      '',
      'Preview IP aktif:',
      preview,
      '',
      'Ketik "batal" untuk membatalkan.'
    ]),
    adminMenu()
  );
});

bot.action('m_admin_add_saldo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_add_saldo_user' });
  await ctx.reply(
    'Masukkan Telegram User ID yang ingin ditambah saldo.\n' +
      'Contoh: 123456789\n' +
      'Ketik "batal" untuk batal.'
  );
});

bot.action('m_admin_env_show', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  const snap = await getDynamicSettingsSnapshot();
  const topupExpireMinute = Math.max(1, Math.floor(Number(snap.TOPUP_EXPIRE_MS || 0) / 60000));
  await ctx.reply(
    uiBox('PENGATURAN SAAT INI', [
      `${getSettingLabel('SC_REGISTRATION_PRICE_PER_DAY')} : Rp ${Number(snap.SC_REGISTRATION_PRICE_PER_DAY || 0).toLocaleString('id-ID')}`,
      `${getSettingLabel('SC_REGISTRATION_MIN_DAYS')} : ${snap.SC_REGISTRATION_MIN_DAYS} hari`,
      `${getSettingLabel('TOPUP_MIN')} : Rp ${Number(snap.TOPUP_MIN || 0).toLocaleString('id-ID')}`,
      `${getSettingLabel('TOPUP_EXPIRE_MS')} : ${topupExpireMinute} menit`,
      `${getSettingLabel('AUTO_PROVISION_DOMAIN')} : ${String(snap.AUTO_PROVISION_DOMAIN) === '1' ? 'Aktif' : 'Nonaktif'}`,
      `${getSettingLabel('CERTBOT_EMAIL')} : ${snap.CERTBOT_EMAIL || '-'}`,
      `${getSettingLabel('SC_INSTALLER_LOCAL_PATH')} :`,
      `${snap.SC_INSTALLER_LOCAL_PATH}`
    ]),
    adminMenu()
  );
});

bot.action('m_admin_env_set', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.delete(ctx.chat.id);
  await ctx.reply('Pilih grup pengaturan yang ingin diubah:', adminEnvMenu());
});

bot.action('m_admin_env_back_admin', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.delete(ctx.chat.id);
  await ctx.reply('Kembali ke menu admin.', adminMenu());
});

bot.action('m_admin_env_manual', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_set_env_key' });
  await ctx.reply(
    uiBox('PILIH PENGATURAN (INPUT MANUAL)', [
      ...DYNAMIC_SETTING_KEYS.map((k, i) => `${i + 1}) ${getSettingLabel(k)}`),
      '',
      'Ketik nomor, nama pengaturan, atau kode asli.',
      'Contoh: 1'
    ])
  );
});

bot.action('m_admin_env_group_billing', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.delete(ctx.chat.id);
  await ctx.reply('Pengaturan Tagihan:', adminEnvGroupMenu('billing'));
});

bot.action('m_admin_env_group_prov', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.delete(ctx.chat.id);
  await ctx.reply('Pengaturan Domain & SSL:', adminEnvGroupMenu('prov'));
});

bot.action('m_admin_env_group_installer', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.delete(ctx.chat.id);
  await ctx.reply('Pengaturan File Installer:', adminEnvGroupMenu('installer'));
});

bot.action(/m_admin_env_pick_(.+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  const key = String(ctx.match?.[1] || '').trim().toUpperCase();
  if (!DYNAMIC_SETTING_KEYS.includes(key)) return ctx.reply('Pengaturan tidak valid.', adminEnvMenu());
  userState.set(ctx.chat.id, { step: 'admin_set_env_value', envKey: key });
  const hint = envKeyInputHint(key);
  await ctx.reply(`Masukkan nilai baru untuk "${getSettingLabel(key)}":\n${hint}`);
});

bot.action('m_admin_list_domains', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  const rows = await listApiDomains().catch(() => []);
  if (!rows.length) return ctx.reply('Belum ada domain API tersimpan.', adminMenu());
  const lines = rows.map((r, i) => `${i + 1}. ${r.domain} (${Number(r.is_active) === 1 ? 'aktif' : 'nonaktif'})`);
  await ctx.reply(`Domain API:\n${lines.join('\n')}`, adminMenu());
});

bot.action('m_admin_upload_sc', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_upload_sc_script' });
  await ctx.reply(
    'Upload file update SC (.sh) sebagai document.\n' +
      'File akan disimpan lokal di VPS bot ini sebagai sumber installer.'
  );
});

bot.action('m_cek_saldo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const saldo = await getSaldo(ctx.from.id).catch(() => 0);
  await ctx.reply(`Saldo kamu: Rp ${Number(saldo).toLocaleString('id-ID')}`, mainMenu());
});

bot.action('m_my_sc', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const regs = await getActiveRegistrations(ctx.from.id).catch(() => []);
  if (regs.length === 0) {
    return ctx.reply('Belum ada IP SC terdaftar.', mainMenu());
  }
  const lines = regs.map(
    (r, i) =>
      `${i + 1}. ${r.vps_ip}\n   Nama Client : ${normalizeClientName(r.client_name) || '-'}\n   Expired     : ${formatDateTime(r.expires_at)}\n   Status      : ${formatRemainingDays(r.expires_at)}`
  );
  return ctx.reply(`IP SC terdaftar (${regs.length}):\n${lines.join('\n')}`, mainMenu());
});

bot.action('m_install_link', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await requireRegistered(ctx))) return;
  const domain = await getPrimaryApiDomain();
  if (!domain) {
    return ctx.reply(
      'Domain API installer belum diset admin.\nHubungi admin agar tambah domain via menu admin.',
      mainMenu()
    );
  }
  const installerUrl = `https://${domain}/sc1forcr/installer.sh`;
  const cmd = `bash -c \"$(curl -fsSL ${installerUrl})\"`;
  return ctx.reply(
    `Link instalasi:\n${installerUrl}\n\nPerintah instal di VPS terdaftar:\n${cmd}`,
    mainMenu()
  );
});

bot.action('m_register_sc', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const [pricePerDay, minDays] = await Promise.all([getRegistrationPricePerDay(), getRegistrationMinDays()]);
  await ctx.reply(
    uiBox('REGISTRASI / PERPANJANG SC', [
      'Pilih jenis layanan:',
      '- Registrasi Baru',
      '- Perpanjang SC',
      '',
      `Harga           : Rp ${pricePerDay.toLocaleString('id-ID')} / hari`,
      `Minimal Durasi  : ${minDays} hari`,
      '',
      'Perpanjang cukup masukkan IP VPS yang terdaftar.',
      'Tekan tombol di bawah ini.'
    ]),
    registerScMenu()
  );
});

bot.action('m_register_sc_new', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const [pricePerDay, minDays] = await Promise.all([getRegistrationPricePerDay(), getRegistrationMinDays()]);
  userState.set(ctx.chat.id, { step: 'register_sc_client_name' });
  await ctx.reply(
    uiBox('REGISTRASI BARU SC', [
      'Masukkan nama client.',
      'Contoh: Haris Premium 01',
      '',
      `Harga           : Rp ${pricePerDay.toLocaleString('id-ID')} / hari`,
      `Minimal Durasi  : ${minDays} hari`,
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action('m_register_sc_extend', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userState.set(ctx.chat.id, { step: 'extend_sc_ip' });
  await ctx.reply(
    uiBox('PERPANJANG SC', [
      'Masukkan IP VPS yang ingin diperpanjang.',
      'Contoh: 103.10.10.2',
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action('m_register_sc_back', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userState.delete(ctx.chat.id);
  await ctx.reply('Kembali ke menu utama.', mainMenu());
});

bot.action('m_topup_saldo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const minTopup = await getTopupMin();
  userState.set(ctx.chat.id, { step: 'topup_amount' });
  await ctx.reply(
    uiBox('TOP UP SALDO', [
      `Minimal Top Up : Rp ${minTopup.toLocaleString('id-ID')}`,
      '',
      'Masukkan nominal top up.',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action(/m_check_topup_(.+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const code = String(ctx.match?.[1] || '');
  if (!code) return;
  const row = await dbGet('SELECT * FROM pending_deposits_app3 WHERE unique_code = ? AND user_id = ?', [code, ctx.from.id]);
  if (!row) return ctx.reply('Transaksi Top Up Saldo tidak ditemukan.');
  if (row.status !== 'pending') return ctx.reply(`Status Top Up Saldo: ${formatTopupStatus(row.status)}`);

  const now = Date.now();
  if (Number(row.expires_at || 0) > 0 && now > Number(row.expires_at || 0)) {
    await dbRun("UPDATE pending_deposits_app3 SET status='expired' WHERE unique_code = ?", [row.unique_code]);
    return ctx.reply('Top Up Saldo sudah kedaluwarsa.');
  }

  const st = await checkGoPayStatus(String(row.provider_tx_id || '')).catch((e) => ({ error: e.message }));
  if (st?.error) return ctx.reply(`Gagal cek status: ${st.error}`);
  if (st.settled) {
    const credited = await markPendingPaid(row);
    const saldoNow = await getSaldo(ctx.from.id).catch(() => 0);
    if (credited) {
      return ctx.reply(`Top Up Saldo berhasil. Saldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}`, mainMenu());
    }
    return ctx.reply('Top Up Saldo sudah diproses sebelumnya.');
  }
  return ctx.reply(`Top Up Saldo masih menunggu. Status gateway: ${formatTopupStatus(st.status || 'pending')}`);
});

bot.action(/m_cancel_topup_(.+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const code = String(ctx.match?.[1] || '');
  if (!code) return;
  const row = await dbGet('SELECT * FROM pending_deposits_app3 WHERE unique_code = ? AND user_id = ?', [code, ctx.from.id]);
  if (!row) return ctx.reply('Transaksi Top Up Saldo tidak ditemukan.');
  if (row.status !== 'pending') return ctx.reply(`Status Top Up Saldo: ${formatTopupStatus(row.status)}`);
  await dbRun("UPDATE pending_deposits_app3 SET status='cancelled' WHERE unique_code = ?", [code]);
  return ctx.reply('Top Up Saldo dibatalkan.');
});

bot.action('m_backup_now', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await requireRegistered(ctx))) return;
  userState.set(ctx.chat.id, { step: 'backup_host' });
  await ctx.reply(
    uiBox('BACKUP SC', [
      'Masukkan IP VPS sumber backup.',
      'Syarat: IP harus sudah terdaftar di akun kamu.',
      'Contoh: 103.10.10.2',
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action('m_restore_upload', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await requireRegistered(ctx))) return;
  userState.set(ctx.chat.id, { step: 'restore_host' });
  await ctx.reply(
    uiBox('RESTORE SC', [
      'Masukkan IP VPS tujuan restore.',
      'Syarat: IP harus sudah terdaftar di akun kamu.',
      'Contoh: 103.10.10.2',
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.on('text', async (ctx) => {
  const state = userState.get(ctx.chat.id);
  if (!state) return;

  const text = String(ctx.message.text || '').trim();
  if (!text) return;
  if (text.toLowerCase() === 'batal') {
    userState.delete(ctx.chat.id);
    return ctx.reply('Dibatalkan.', mainMenu());
  }

  try {
    if (state.step === 'admin_set_env_key') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const key = resolveSettingKeyInput(text);
      if (!key) {
        return ctx.reply(
          uiBox('PENGATURAN TIDAK VALID', [
            'Pilih salah satu dari daftar berikut:',
            ...DYNAMIC_SETTING_KEYS.map((k, i) => `${i + 1}) ${getSettingLabel(k)}`)
          ])
        );
      }
      state.step = 'admin_set_env_value';
      state.envKey = key;
      userState.set(ctx.chat.id, state);
      return ctx.reply(`Masukkan nilai baru untuk "${getSettingLabel(key)}":\n${envKeyInputHint(key)}`);
    }

    if (state.step === 'admin_add_saldo_user') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const targetUserId = Number(String(text || '').replace(/[^0-9]/g, ''));
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return ctx.reply('User ID tidak valid. Contoh: 123456789');
      }
      state.step = 'admin_add_saldo_amount';
      state.targetUserId = targetUserId;
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        `User ID: ${targetUserId}\n` +
          'Masukkan nominal saldo yang ingin ditambahkan (rupiah).\n' +
          'Contoh: 25000'
      );
    }

    if (state.step === 'admin_add_saldo_amount') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const targetUserId = Number(state.targetUserId || 0);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        userState.delete(ctx.chat.id);
        return ctx.reply('State tambah saldo tidak valid. Ulangi dari menu admin.', adminMenu());
      }
      const amount = Number(String(text || '').replace(/[^0-9]/g, ''));
      if (!Number.isFinite(amount) || amount < 1) {
        return ctx.reply('Nominal tidak valid. Minimal Rp 1.');
      }
      const nominal = Math.floor(amount);
      await addSaldo(targetUserId, nominal);
      await saveTransaction(targetUserId, nominal, 'admin_credit', `admin_${ctx.from.id}_${Date.now()}`);
      const saldoNow = await getSaldo(targetUserId);
      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Berhasil tambah saldo.\n` +
          `User ID: ${targetUserId}\n` +
          `Nominal: Rp ${nominal.toLocaleString('id-ID')}\n` +
          `Saldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}`,
        adminMenu()
      );
    }

    if (state.step === 'admin_set_env_value') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const key = String(state.envKey || '').trim().toUpperCase();
      let value = String(text || '').trim();
      if (!DYNAMIC_SETTING_KEYS.includes(key)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('State pengaturan tidak valid, ulangi dari menu pengaturan.', adminEnvMenu());
      }

      if (key === 'SC_REGISTRATION_PRICE_PER_DAY') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return ctx.reply('Harus angka >= 0.');
        value = String(Math.floor(n));
      } else if (key === 'SC_REGISTRATION_MIN_DAYS') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1) return ctx.reply('Harus angka >= 1.');
        value = String(Math.floor(n));
      } else if (key === 'TOPUP_MIN') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1000) return ctx.reply('Harus angka >= 1000.');
        value = String(Math.floor(n));
      } else if (key === 'TOPUP_EXPIRE_MS') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 60000) return ctx.reply('Harus angka >= 60000 (1 menit).');
        value = String(Math.floor(n));
      } else if (key === 'AUTO_PROVISION_DOMAIN') {
        const s = value.toLowerCase();
        if (!['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(s)) {
          return ctx.reply('Isi 1/0 (atau true/false).');
        }
        value = parseBool01(s, true) ? '1' : '0';
      } else if (key === 'SC_INSTALLER_LOCAL_PATH') {
        if (!value) return ctx.reply('Path tidak boleh kosong.');
      } else if (key === 'CERTBOT_EMAIL') {
        // Boleh kosong.
      }

      await setDynamicSetting(key, value, ctx.from.id);
      userState.delete(ctx.chat.id);
      return ctx.reply(`Berhasil update "${getSettingLabel(key)}" menjadi: ${value}`, adminEnvMenu());
    }

    if (state.step === 'admin_add_domain') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const domain = normalizeDomainWithoutPort(text);
      if (!isDomainLike(domain) || !isProvisionableDomain(domain)) {
        return ctx.reply('Format domain tidak valid. Contoh: installer.domainkamu.com (tanpa port).');
      }
      await ctx.reply(`Proses auto-setup domain ${domain}...\n- set nginx vhost\n- issue SSL certbot`);
      try {
        await provisionInstallerDomain(domain);
      } catch (e) {
        userState.delete(ctx.chat.id);
        return ctx.reply(`Auto-setup domain gagal: ${String(e?.message || e)}`, adminMenu());
      }
      await addApiDomain(domain, ctx.from.id);
      userState.delete(ctx.chat.id);
      return ctx.reply(`Domain API ditambahkan dan auto-setup SSL selesai: ${domain}`, adminMenu());
    }

    if (state.step === 'admin_remove_domain') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const domain = normalizeDomainWithoutPort(text);
      if (!isDomainLike(domain)) return ctx.reply('Format domain tidak valid.');
      await removeApiDomain(domain);
      userState.delete(ctx.chat.id);
      return ctx.reply(`Domain API dihapus (jika ada): ${domain}`, adminMenu());
    }

    if (state.step === 'admin_remove_sc_ip') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const ip = normalizeHost(text);
      if (!isIpv4(ip)) {
        return ctx.reply('Format IP tidak valid. Contoh: 103.10.10.2');
      }
      const result = await adminRemoveRegisteredIp(ip, ctx.from.id);
      userState.delete(ctx.chat.id);
      if (!result.removed) {
        return ctx.reply(`IP ${ip} tidak ditemukan pada registrasi aktif.`, adminMenu());
      }
      const users = Array.from(new Set((result.rows || []).map((r) => Number(r.user_id || 0)).filter((n) => n > 0)));
      return ctx.reply(
        `Berhasil hapus registrasi aktif untuk IP ${ip}.\n` +
          `Baris terhapus: ${result.removed}\n` +
          `User terdampak: ${users.length ? users.join(', ') : '-'}`,
        adminMenu()
      );
    }

    if (state.step === 'register_sc_client_name') {
      const clientName = normalizeClientName(text);
      if (!clientName || clientName.length < 2) {
        return ctx.reply(
          uiBox('INPUT NAMA CLIENT', [
            'Nama client minimal 2 karakter.',
            'Contoh: Haris Premium 01'
          ])
        );
      }
      state.step = 'register_sc_ip';
      state.clientName = clientName;
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('LANJUT REGISTRASI SC', [
          `Nama Client : ${clientName}`,
          '',
          'Masukkan IP VPS yang ingin didaftarkan.',
          'Contoh: 103.10.10.2'
        ])
      );
    }

    if (state.step === 'register_sc_ip') {
      const ip = normalizeHost(text);
      if (!isIpv4(ip)) {
        return ctx.reply(
          uiBox('INPUT IP VPS', [
            'Format IP tidak valid.',
            'Contoh: 103.10.10.2'
          ])
        );
      }
      if (await isIpOwnedByOther(ip, ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply(`IP ${ip} sudah terdaftar oleh user lain.`, mainMenu());
      }
      const [pricePerDay, minDays, reg] = await Promise.all([
        getRegistrationPricePerDay(),
        getRegistrationMinDays(),
        getUserRegistration(ctx.from.id, ip)
      ]);
      state.step = 'register_sc_days';
      state.ip = ip;
      state.clientName = normalizeClientName(state.clientName || reg?.client_name || ctx.from.first_name || ip) || ip;
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('KONFIRMASI DATA SC', [
          `Nama Client   : ${state.clientName}`,
          `IP VPS        : ${ip}`,
          reg ? `Expired Saat Ini : ${formatDateTime(reg.expires_at)}` : 'Status         : Belum terdaftar',
          '',
          `Harga / Hari  : Rp ${pricePerDay.toLocaleString('id-ID')}`,
          `Minimal Hari  : ${minDays}`,
          `Contoh        : ${minDays} hari = Rp ${(minDays * pricePerDay).toLocaleString('id-ID')}`,
          '',
          'Masukkan jumlah hari sekarang.'
        ])
      );
    }

    if (state.step === 'register_sc_days') {
      const ip = String(state.ip || '').trim();
      if (!isIpv4(ip)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('State registrasi tidak valid. Ulangi dari menu registrasi.', mainMenu());
      }
      const [pricePerDay, minDays] = await Promise.all([getRegistrationPricePerDay(), getRegistrationMinDays()]);
      const days = Number(String(text).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(days) || days < minDays) {
        return ctx.reply(`Jumlah hari tidak valid. Minimal ${minDays} hari.`);
      }
      const totalFee = Math.floor(days) * pricePerDay;
      const clientName = normalizeClientName(state.clientName || ip) || ip;
      const result = await registerScIp(ctx.from.id, ip, clientName, Math.floor(days), totalFee);
      if (result.insufficient) {
        const saldo = await getSaldo(ctx.from.id);
        userState.delete(ctx.chat.id);
        return ctx.reply(
          `Saldo tidak cukup untuk registrasi/perpanjang.\n` +
            `Nama Client: ${clientName}\n` +
            `IP: ${ip}\n` +
            `Durasi: ${Math.floor(days)} hari\n` +
            `Total biaya: Rp ${totalFee.toLocaleString('id-ID')}\n` +
            `Saldo kamu: Rp ${Number(saldo).toLocaleString('id-ID')}\n\n` +
            'Silakan top up dulu via menu "Top Up Saldo".',
          mainMenu()
        );
      }
      const saldoNow = await getSaldo(ctx.from.id);
      const installerText = await buildInstallerQuickCopyText();
      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Registrasi/perpanjang SC berhasil.\n` +
          `Nama Client: ${result.clientName || clientName}\n` +
          `IP: ${ip}\n` +
          `Durasi: ${Math.floor(days)} hari\n` +
          `Biaya potong saldo: Rp ${totalFee.toLocaleString('id-ID')}\n` +
          `Expired baru: ${formatDateTime(result.expiresAt)}\n` +
          `Saldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}` +
          installerText,
        mainMenu()
      );
    }

    if (state.step === 'extend_sc_ip') {
      const ip = normalizeHost(text);
      if (!isIpv4(ip)) {
        return ctx.reply(
          uiBox('INPUT IP VPS', [
            'Format IP tidak valid.',
            'Contoh: 103.10.10.2'
          ])
        );
      }

      const [pricePerDay, minDays, reg, ownedByOther] = await Promise.all([
        getRegistrationPricePerDay(),
        getRegistrationMinDays(),
        getUserRegistration(ctx.from.id, ip),
        isIpOwnedByOther(ip, ctx.from.id)
      ]);

      if (!reg) {
        if (ownedByOther) {
          userState.delete(ctx.chat.id);
          return ctx.reply(`IP ${ip} terdaftar di user lain dan tidak bisa diperpanjang dari akun ini.`, mainMenu());
        }
        userState.delete(ctx.chat.id);
        return ctx.reply(`IP ${ip} belum pernah terdaftar di akun kamu. Gunakan menu "Registrasi Baru".`, mainMenu());
      }

      const clientName = normalizeClientName(reg.client_name || ctx.from.first_name || ip) || ip;
      state.step = 'extend_sc_days';
      state.ip = ip;
      state.clientName = clientName;
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('KONFIRMASI PERPANJANGAN SC', [
          `Nama Client   : ${clientName}`,
          `IP VPS        : ${ip}`,
          `Expired Saat Ini : ${formatDateTime(reg.expires_at)}`,
          '',
          `Harga / Hari  : Rp ${pricePerDay.toLocaleString('id-ID')}`,
          `Minimal Hari  : ${minDays}`,
          `Contoh        : ${minDays} hari = Rp ${(minDays * pricePerDay).toLocaleString('id-ID')}`,
          '',
          'Masukkan jumlah hari perpanjangan.'
        ])
      );
    }

    if (state.step === 'extend_sc_days') {
      const ip = String(state.ip || '').trim();
      if (!isIpv4(ip)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('State perpanjangan tidak valid. Ulangi dari menu perpanjang.', mainMenu());
      }
      const [pricePerDay, minDays] = await Promise.all([getRegistrationPricePerDay(), getRegistrationMinDays()]);
      const days = Number(String(text).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(days) || days < minDays) {
        return ctx.reply(`Jumlah hari tidak valid. Minimal ${minDays} hari.`);
      }

      const totalFee = Math.floor(days) * pricePerDay;
      const clientName = normalizeClientName(state.clientName || ip) || ip;
      const result = await registerScIp(ctx.from.id, ip, clientName, Math.floor(days), totalFee);
      if (result.insufficient) {
        const saldo = await getSaldo(ctx.from.id);
        userState.delete(ctx.chat.id);
        return ctx.reply(
          `Saldo tidak cukup untuk perpanjang SC.\n` +
            `Nama Client: ${clientName}\n` +
            `IP: ${ip}\n` +
            `Durasi: ${Math.floor(days)} hari\n` +
            `Total biaya: Rp ${totalFee.toLocaleString('id-ID')}\n` +
            `Saldo kamu: Rp ${Number(saldo).toLocaleString('id-ID')}\n\n` +
            'Silakan top up dulu via menu "Top Up Saldo".',
          mainMenu()
        );
      }

      const saldoNow = await getSaldo(ctx.from.id);
      const installerText = await buildInstallerQuickCopyText();
      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Perpanjang SC berhasil.\n` +
          `Nama Client: ${result.clientName || clientName}\n` +
          `IP: ${ip}\n` +
          `Durasi tambah: ${Math.floor(days)} hari\n` +
          `Biaya potong saldo: Rp ${totalFee.toLocaleString('id-ID')}\n` +
          `Expired baru: ${formatDateTime(result.expiresAt)}\n` +
          `Saldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}` +
          installerText,
        mainMenu()
      );
    }

    if (state.step === 'topup_amount') {
      const minTopup = await getTopupMin();
      const topupExpireMs = await getTopupExpireMs();
      const amount = Number(String(text).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(amount) || amount < minTopup) {
        return ctx.reply(`Nominal tidak valid. Minimal Rp ${minTopup.toLocaleString('id-ID')}.`);
      }

      await ctx.reply('Membuat QR Top Up Saldo, tunggu...');
      const qr = await createGoPayQr(amount);
      const code = makeUniqueCode(ctx.from.id);
      const now = Date.now();
      const expires = now + topupExpireMs;
      const ref = `TOPUP_APP3_${ctx.from.id}_${now}`;

      await dbRun(
        `INSERT INTO pending_deposits_app3
         (unique_code, user_id, amount, status, provider_tx_id, qr_url, reference_id, created_at, expires_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [code, ctx.from.id, amount, qr.providerTxId, qr.qrUrl, ref, now, expires]
      );

      userState.delete(ctx.chat.id);
      const caption =
        `Top Up Saldo dibuat.\n` +
        `Nominal: Rp ${amount.toLocaleString('id-ID')}\n` +
        `Ref: ${ref}\n` +
        `Expired: ${Math.floor(topupExpireMs / 60000)} menit`;

      try {
        await ctx.replyWithPhoto(qr.qrUrl, {
          caption,
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Cek Status', `m_check_topup_${code}`)],
            [Markup.button.callback('Batalkan', `m_cancel_topup_${code}`)]
          ])
        });
      } catch (_) {
        await ctx.reply(
          `${caption}\nQR: ${qr.qrUrl}`,
          Markup.inlineKeyboard([
            [Markup.button.callback('Cek Status', `m_check_topup_${code}`)],
            [Markup.button.callback('Batalkan', `m_cancel_topup_${code}`)]
          ])
        );
      }
      return;
    }

    if (state.step === 'backup_host') {
      const host = normalizeHost(text);
      if (!isIpv4(host)) return ctx.reply('IP VPS harus valid.');
      if (!(await isRegisteredHost(ctx.from.id, host))) {
        return ctx.reply('IP belum terdaftar di akun kamu. Registrasi dulu di menu Registrasi SC.');
      }
      state.host = host;
      state.step = 'backup_key';
      userState.set(ctx.chat.id, state);
      return ctx.reply('Masukkan key server sumber.');
    }

    if (state.step === 'backup_key') {
      const key = text;
      if (key.length < 8) return ctx.reply('Key tidak valid.');

      await ctx.reply('Membuat backup, tunggu...');

      const [ssh, vmess, vless, trojan] = await Promise.all([
        apiGet(state.host, key, '/internal/export-accounts', { type: 'ssh', limit: 50000 }),
        apiGet(state.host, key, '/internal/export-accounts', { type: 'vmess', limit: 50000 }),
        apiGet(state.host, key, '/internal/export-accounts', { type: 'vless', limit: 50000 }),
        apiGet(state.host, key, '/internal/export-accounts', { type: 'trojan', limit: 50000 })
      ]);

      let zivpnAuth = [];
      try {
        const za = await apiGet(state.host, key, '/internal/export-zivpn-auth');
        zivpnAuth = Array.isArray(za.users) ? za.users : [];
      } catch (_) {
        try {
          const zcfg = await apiGet(state.host, key, '/internal/export-zivpn-config');
          const cfgList = zcfg?.config?.auth?.config;
          zivpnAuth = Array.isArray(cfgList) ? cfgList : [];
        } catch (__){
          zivpnAuth = [];
        }
      }

      let bannerHtml = '';
      let bannerTxt = '';
      try {
        const bcfg = await apiGet(state.host, key, '/internal/export-banner-config');
        bannerHtml = String(bcfg?.banner_html || '');
        bannerTxt = String(bcfg?.banner_txt || '');
      } catch (_) {
        // optional endpoint
      }

      const backupPayload = {
        meta: {
          format: 'sc1forcr-backup-v1',
          created_at: new Date().toISOString(),
          source_host: state.host,
          user_id: ctx.from.id
        },
        data: {
          ssh: Array.isArray(ssh.accounts) ? ssh.accounts : [],
          vmess: Array.isArray(vmess.accounts) ? vmess.accounts : [],
          vless: Array.isArray(vless.accounts) ? vless.accounts : [],
          trojan: Array.isArray(trojan.accounts) ? trojan.accounts : [],
          zivpn_auth: Array.isArray(zivpnAuth) ? zivpnAuth : [],
          banner_html: bannerHtml,
          banner_txt: bannerTxt
        }
      };

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `backup-sc-${state.host.replace(/[^a-zA-Z0-9.-]/g, '_')}-${stamp}.json`;
      const content = Buffer.from(JSON.stringify(backupPayload, null, 2), 'utf8');

      await dbRun("UPDATE sc_registrations SET last_used_at = ?, updated_at = ? WHERE user_id = ? AND vps_ip = ? AND status = 'active'", [Date.now(), Date.now(), ctx.from.id, state.host]).catch(() => {});

      userState.delete(ctx.chat.id);
      await ctx.replyWithDocument(
        { source: content, filename },
        { caption: `Backup selesai.\nIP VPS: ${state.host}\nSSH: ${backupPayload.data.ssh.length}, VMESS: ${backupPayload.data.vmess.length}, VLESS: ${backupPayload.data.vless.length}, TROJAN: ${backupPayload.data.trojan.length}, ZIVPN: ${backupPayload.data.zivpn_auth.length}` }
      );
      return;
    }

    if (state.step === 'restore_host') {
      const host = normalizeHost(text);
      if (!isIpv4(host)) return ctx.reply('IP VPS harus valid.');
      if (!(await isRegisteredHost(ctx.from.id, host))) {
        return ctx.reply('IP belum terdaftar di akun kamu. Registrasi dulu di menu Registrasi SC.');
      }
      state.host = host;
      state.step = 'restore_key';
      userState.set(ctx.chat.id, state);
      return ctx.reply('Masukkan key server tujuan.');
    }

    if (state.step === 'restore_key') {
      if (text.length < 8) return ctx.reply('Key tidak valid.');
      state.key = text;
      state.step = 'restore_wait_file';
      userState.set(ctx.chat.id, state);
      return ctx.reply('Upload file backup sebagai document (.json).');
    }
  } catch (err) {
    userState.delete(ctx.chat.id);
    return ctx.reply(`Gagal: ${parseErr(err)}`, mainMenu());
  }
});

bot.on('document', async (ctx) => {
  const state = userState.get(ctx.chat.id);
  if (!state) return;

  if (state.step === 'admin_upload_sc_script') {
    try {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const doc = ctx.message.document;
      const fileName = String(doc?.file_name || '').toLowerCase();
      if (!fileName.endsWith('.sh')) {
        return ctx.reply('File harus .sh');
      }

      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const fileResp = await axios.get(fileLink.toString(), {
        timeout: 120000,
        responseType: 'arraybuffer'
      });
      const content = Buffer.from(fileResp.data || '');
      if (!content.length) return ctx.reply('File kosong.');
      if (content.length > 5 * 1024 * 1024) return ctx.reply('File terlalu besar (maks 5MB).');

      const normalizedText = normalizeScriptLineEndings(content.toString('utf8'));
      const normalizedContent = Buffer.from(normalizedText, 'utf8');
      const textSample = normalizedText.slice(0, 2000);
      if (!/setup-autoscript-compat|^#!\/usr\/bin\/env bash|^#!\/bin\/bash/m.test(textSample)) {
        return ctx.reply('File tidak terlihat seperti script installer bash yang valid.');
      }

      const targetPath = await getScInstallerLocalPath();
      const targetDir = path.dirname(targetPath);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, normalizedContent);
      try { fs.chmodSync(targetPath, 0o755); } catch (_) {}

      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Upload update SC berhasil.\n` +
          `Path lokal: ${targetPath}\n` +
          `Ukuran: ${normalizedContent.length} bytes`,
        adminMenu()
      );
    } catch (err) {
      userState.delete(ctx.chat.id);
      return ctx.reply(`Gagal upload file update SC: ${parseErr(err)}`, adminMenu());
    }
  }

  if (state.step !== 'restore_wait_file') return;

  try {
    if (!(await isRegisteredHost(ctx.from.id, state.host))) {
      userState.delete(ctx.chat.id);
      return ctx.reply('Akses restore ditolak karena host belum terdaftar aktif di akun kamu.', mainMenu());
    }

    const doc = ctx.message.document;
    const fileName = String(doc?.file_name || '').toLowerCase();
    if (!fileName.endsWith('.json')) {
      return ctx.reply('File harus .json (backup akun).');
    }

    await ctx.reply('Memproses restore backup...');

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const fileResp = await axios.get(fileLink.toString(), {
      timeout: 60000,
      responseType: 'text'
    });
    const raw = String(fileResp.data || '').trim();
    if (!raw) return ctx.reply('Isi file kosong.');

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return ctx.reply('File backup bukan JSON valid.');
    }

    const backupData = parsed?.data || {};
    const types = ['ssh', 'vmess', 'vless', 'trojan'];
    const resultLines = [];

    for (const type of types) {
      const accounts = Array.isArray(backupData[type]) ? backupData[type] : [];
      if (accounts.length === 0) {
        resultLines.push(`${type.toUpperCase()}: 0 akun (skip)`);
        continue;
      }
      const imported = await apiPost(state.host, state.key, '/internal/import-accounts', { type, accounts });
      resultLines.push(`${type.toUpperCase()}: imported ${Number(imported.imported || 0)}, skipped ${Number(imported.skipped || 0)}`);
    }

    if (Array.isArray(backupData.zivpn_auth)) {
      try {
        const restoreZ = await apiPost(state.host, state.key, '/internal/restore-zivpn-auth', {
          users: backupData.zivpn_auth
        });
        resultLines.push(`ZIVPN auth: restored (${Number(restoreZ.total_entries || 0)})`);
      } catch (zErr) {
        resultLines.push(`ZIVPN auth: gagal (${parseErr(zErr)})`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(backupData, 'banner_html') || Object.prototype.hasOwnProperty.call(backupData, 'banner_txt')) {
      try {
        await apiPost(state.host, state.key, '/internal/restore-banner-config', {
          banner_html: String(backupData.banner_html || ''),
          banner_txt: String(backupData.banner_txt || '')
        });
        resultLines.push('Banner: restored');
      } catch (bErr) {
        resultLines.push(`Banner: gagal (${parseErr(bErr)})`);
      }
    }

    await dbRun("UPDATE sc_registrations SET last_used_at = ?, updated_at = ? WHERE user_id = ? AND vps_ip = ? AND status = 'active'", [Date.now(), Date.now(), ctx.from.id, state.host]).catch(() => {});

    userState.delete(ctx.chat.id);
    return ctx.reply(
      `Restore selesai.\nTarget: ${state.host}\n\n${resultLines.join('\n')}`,
      mainMenu()
    );
  } catch (err) {
    userState.delete(ctx.chat.id);
    return ctx.reply(`Gagal restore: ${parseErr(err)}`, mainMenu());
  }
});

bot.catch((err, ctx) => {
  console.error('app3 error:', err.message);
  if (ctx?.chat?.id) userState.delete(ctx.chat.id);
});

(async () => {
  try {
    await initDb();
    setInterval(pollPendingTopups, 15000);
    await pollPendingTopups();
    await bot.launch();
    console.log('app3 bot running...');
  } catch (e) {
    console.error('app3 start failed:', e.message);
    process.exit(1);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

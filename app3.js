const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { buildPayload, headers, API_URL } = require('./api-cekpayment-orkut');

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
const SC_UNLIMITED_PRICE = Math.max(0, Number(process.env.SC_UNLIMITED_PRICE || 70000) || 70000);
const DEFAULT_SC_REGISTRATION_MIN_DAYS = Math.max(1, Number(process.env.SC_REGISTRATION_MIN_DAYS || 1) || 1);
const DEFAULT_TOPUP_MIN = Math.max(1000, Number(process.env.TOPUP_MIN || 5000) || 5000);
const DEFAULT_TOPUP_EXPIRE_MS = Math.max(60000, Number(process.env.TOPUP_EXPIRE_MS || (5 * 60 * 1000)) || (5 * 60 * 1000));
const DEFAULT_LICENSE_API_PORT = Math.max(1, Number(process.env.LICENSE_API_PORT || 8099) || 8099);
const DEFAULT_AUTO_PROVISION_DOMAIN = /^(1|true|yes|on)$/i.test(String(process.env.AUTO_PROVISION_DOMAIN || '1').trim());
const DEFAULT_CERTBOT_EMAIL = String(process.env.CERTBOT_EMAIL || '').trim();
const DEFAULT_SC_INSTALLER_LOCAL_PATH = String(
  process.env.SC_INSTALLER_LOCAL_PATH || path.join(__dirname, 'scripts', 'setup-autoscript-compat.sh')
).trim();
const DEFAULT_SUMMARY_API_LOCAL_PATH = String(
  process.env.SUMMARY_API_LOCAL_PATH || path.join(__dirname, 'scripts', 'setup-summary-api.sh')
).trim();
const LEGACY_SC_INSTALLER_LOCAL_PATH = path.join(__dirname, 'payload', 'setup-autoscript-compat.sh');
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map((v) => Number(String(v || '').trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const bot = new Telegraf(BOT_TOKEN);
const userState = new Map();
const db = new sqlite3.Database(DB_PATH);
const DYNAMIC_SETTING_KEYS = [
  'SC_REGISTRATION_PRICE_PER_DAY',
  'SC_RESELLER_PRICE_PER_DAY',
  'SC_UNLIMITED_PRICE',
  'SC_REGISTRATION_MIN_DAYS',
  'TOPUP_MIN',
  'TOPUP_EXPIRE_MS',
  'TOPUP_SUCCESS_NOTIFY_ENABLE',
  'TOPUP_SUCCESS_NOTIFY_ADMIN_IDS',
  'RESELLER_ADMIN_WA',
  'AUTO_PROVISION_DOMAIN',
  'CERTBOT_EMAIL',
  'SC_INSTALLER_LOCAL_PATH'
];
const SETTING_LABELS = {
  SC_REGISTRATION_PRICE_PER_DAY: 'Harga SC per Hari',
  SC_RESELLER_PRICE_PER_DAY: 'Harga SC Reseller per Hari',
  SC_UNLIMITED_PRICE: 'Harga SC Unlimited',
  SC_REGISTRATION_MIN_DAYS: 'Minimal Hari Pembelian',
  TOPUP_MIN: 'Minimal Top Up Saldo',
  TOPUP_EXPIRE_MS: 'Masa Aktif QR Top Up',
  TOPUP_SUCCESS_NOTIFY_ENABLE: 'Notif TopUp Sukses',
  TOPUP_SUCCESS_NOTIFY_ADMIN_IDS: 'Admin ID Notif TopUp',
  RESELLER_ADMIN_WA: 'Nomor WA Admin Reseller',
  AUTO_PROVISION_DOMAIN: 'Auto Setup Domain',
  CERTBOT_EMAIL: 'Email Certbot',
  SC_INSTALLER_LOCAL_PATH: 'Path Script Installer'
};
const DAY_MS = 24 * 60 * 60 * 1000;
const SC_NOTIFY_INTERVAL_MS = 30 * 60 * 1000;
const SC_H2_WINDOW_MS = 2 * DAY_MS;

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
  await dbRun(`CREATE TABLE IF NOT EXISTS sc_server_keys (
    user_id INTEGER NOT NULL,
    vps_ip TEXT NOT NULL,
    server_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, vps_ip)
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS sc_notify_state (
    user_id INTEGER NOT NULL,
    vps_ip TEXT NOT NULL,
    event TEXT NOT NULL,
    last_sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, vps_ip, event)
  )`);
  await ensureScRegistrationSchema();
  await ensureUsersSchema();
  await ensurePendingDepositSchema();
  await ensureOrderKuotaAmountLockSchema();
  await seedDefaultSettings();
  await autoMigrateLegacyInstallerPathSetting();
}

async function ensureUsersSchema() {
  const cols = await dbAll('PRAGMA table_info(users)');
  const hasReseller = cols.some((c) => String(c?.name || '').toLowerCase() === 'is_reseller');
  if (!hasReseller) {
    await dbRun('ALTER TABLE users ADD COLUMN is_reseller INTEGER DEFAULT 0');
  }
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

async function ensurePendingDepositSchema() {
  const cols = await dbAll('PRAGMA table_info(pending_deposits_app3)');
  const hasGatewayProvider = cols.some((c) => String(c?.name || '').toLowerCase() === 'gateway_provider');
  const hasOriginalAmount = cols.some((c) => String(c?.name || '').toLowerCase() === 'original_amount');
  const hasAdminFee = cols.some((c) => String(c?.name || '').toLowerCase() === 'admin_fee');
  if (!hasGatewayProvider) {
    await dbRun("ALTER TABLE pending_deposits_app3 ADD COLUMN gateway_provider TEXT DEFAULT 'gopay'");
  }
  if (!hasOriginalAmount) {
    await dbRun('ALTER TABLE pending_deposits_app3 ADD COLUMN original_amount INTEGER');
  }
  if (!hasAdminFee) {
    await dbRun('ALTER TABLE pending_deposits_app3 ADD COLUMN admin_fee INTEGER DEFAULT 0');
  }
}

async function ensureOrderKuotaAmountLockSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS orderkuota_amount_locks (
    amount INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  )`);
}

async function seedDefaultSettings() {
  const now = Date.now();
  const defaultScFeaturesText = [
    'SERVICE DI SC (VPS):',
    '- SSH/OpenSSH',
    '- Dropbear',
    '- Nginx',
    '- HAProxy (TLS 443 mux)',
    '- Xray',
    '- SSH-WS bridge (sc-1forcr-sshws)',
    '- UDP backend (ZIVPN/UDPHC tergantung mode)',
    '',
    'SUPPORT PROTOKOL/AKUN:',
    '- SSH + SSHWS',
    '- VMESS WS',
    '- VLESS WS',
    '- TROJAN WS',
    '',
    'PORT & PATH UMUM (DEFAULT):',
    '- TLS/SSL: 443',
    '- HTTP: 80',
    '- Dropbear: 109 dan 143',
    '- SSHWS path: /ssh-ws, /ws, /ws-ssh, /ssh',
    '- Xray WS path: /vmess, /vless, /trojan',
    '',
    'MENU DI SC (VPS):',
    '- Kelola akun SSH/VMESS/VLESS/TROJAN',
    '- Monitor user online/lock',
    '- Tools update script',
    '- Change domain',
    '- Backup/restore',
    '',
    'MENU DI BOT:',
    '- Registrasi/Perpanjang/Unlimited SC',
    '- Top Up Saldo + cek status',
    '- Cek saldo, SC saya, cek expired',
    '- Backup/restore akun, migrasi akun, hapus akun',
    '- Fitur reseller dan admin panel'
  ].join('\n');
  const defaults = {
    SC_REGISTRATION_PRICE_PER_DAY: String(DEFAULT_SC_REGISTRATION_PRICE_PER_DAY),
    SC_RESELLER_PRICE_PER_DAY: String(DEFAULT_SC_REGISTRATION_PRICE_PER_DAY),
    SC_UNLIMITED_PRICE: String(SC_UNLIMITED_PRICE),
    SC_REGISTRATION_MIN_DAYS: String(DEFAULT_SC_REGISTRATION_MIN_DAYS),
    TOPUP_MIN: String(DEFAULT_TOPUP_MIN),
    TOPUP_EXPIRE_MS: String(DEFAULT_TOPUP_EXPIRE_MS),
    TOPUP_SUCCESS_NOTIFY_ENABLE: '1',
    TOPUP_SUCCESS_NOTIFY_ADMIN_IDS: ADMIN_IDS.join(','),
    RESELLER_ADMIN_WA: '089612745096',
    SC_FEATURES_INFO_TEXT: defaultScFeaturesText,
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

async function getScFeaturesInfoText() {
  const fallback = 'Info fitur SC belum diisi admin.';
  return getDynamicSetting('SC_FEATURES_INFO_TEXT', fallback);
}

function normalizeLegacyInstallerPathValue(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return raw;
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.endsWith('/payload/setup-autoscript-compat.sh')) {
    return normalized.replace(/\/payload\/setup-autoscript-compat\.sh$/, '/scripts/setup-autoscript-compat.sh');
  }
  return raw;
}

async function autoMigrateLegacyInstallerPathSetting() {
  const row = await dbGet('SELECT value FROM app_settings WHERE key = ? LIMIT 1', ['SC_INSTALLER_LOCAL_PATH']);
  const current = String(row?.value || '').trim();
  const migrated = normalizeLegacyInstallerPathValue(current);
  if (migrated && migrated !== current) {
    await setDynamicSetting('SC_INSTALLER_LOCAL_PATH', migrated, 0);
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

async function isResellerUser(userId) {
  const row = await dbGet('SELECT is_reseller FROM users WHERE user_id = ? LIMIT 1', [userId]);
  return Number(row?.is_reseller || 0) === 1;
}

async function setResellerUser(userId, enabled) {
  await ensureUser(userId);
  await dbRun('UPDATE users SET is_reseller = ? WHERE user_id = ?', [enabled ? 1 : 0, userId]);
}

async function getRegistrationPricePerDayForUser(userId) {
  const normalPrice = await getRegistrationPricePerDay();
  const isReseller = await isResellerUser(userId);
  if (!isReseller) return { pricePerDay: normalPrice, isReseller: false };
  const resellerPrice = await getSettingNumber('SC_RESELLER_PRICE_PER_DAY', normalPrice, 0, 1000000000);
  return { pricePerDay: resellerPrice, isReseller: true };
}

async function getRegistrationMinDays() {
  return getSettingNumber('SC_REGISTRATION_MIN_DAYS', DEFAULT_SC_REGISTRATION_MIN_DAYS, 1, 3650);
}

async function getUnlimitedPrice() {
  return getSettingNumber('SC_UNLIMITED_PRICE', SC_UNLIMITED_PRICE, 0, 1000000000);
}

async function getTopupMin() {
  return getSettingNumber('TOPUP_MIN', DEFAULT_TOPUP_MIN, 1000, 1000000000);
}

async function getTopupExpireMs() {
  return getSettingNumber('TOPUP_EXPIRE_MS', DEFAULT_TOPUP_EXPIRE_MS, 60000, 86400000);
}

async function getTopupSuccessNotifyEnable() {
  return getSettingBool('TOPUP_SUCCESS_NOTIFY_ENABLE', true);
}

async function getTopupSuccessNotifyAdminIds() {
  const raw = await getDynamicSetting('TOPUP_SUCCESS_NOTIFY_ADMIN_IDS', ADMIN_IDS.join(','));
  const ids = String(raw || '')
    .split(',')
    .map((v) => Number(String(v || '').trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : ADMIN_IDS;
}

function normalizeWaNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits;
}

async function getResellerAdminWaNumber() {
  const raw = await getDynamicSetting('RESELLER_ADMIN_WA', '089612745096');
  return normalizeWaNumber(raw);
}

function buildResellerWaUrl(waNumber, user) {
  const userId = Number(user?.id || 0);
  const username = String(user?.username || '').trim();
  const fullName = [String(user?.first_name || '').trim(), String(user?.last_name || '').trim()].filter(Boolean).join(' ').trim();
  const text =
    `Halo Admin, saya mau daftar reseller SC.\n` +
    `ID Telegram: ${userId || '-'}\n` +
    `Username: ${username ? `@${username}` : '-'}\n` +
    `Nama: ${fullName || '-'}\n` +
    `Mohon info syarat dan prosesnya.`;
  return `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`;
}

async function notifyAdminsTopupSuccess(row) {
  const enabled = await getTopupSuccessNotifyEnable().catch(() => true);
  if (!enabled) return;
  const adminIds = await getTopupSuccessNotifyAdminIds().catch(() => ADMIN_IDS);
  if (!Array.isArray(adminIds) || !adminIds.length) return;
  const userId = Number(row?.user_id || 0);
  const provider = String(row?.gateway_provider || 'gopay').toUpperCase();
  const saldoMasuk = Number(row?.original_amount || row?.amount || 0);
  const fee = Number(row?.admin_fee || 0);
  const totalTransfer = Number(row?.amount || saldoMasuk || 0);
  const ref = String(row?.reference_id || row?.unique_code || '-');
  const message =
    `TOPUP SUKSES\n` +
    `User ID: ${userId}\n` +
    `Gateway: ${provider}\n` +
    `Saldo Masuk: Rp ${saldoMasuk.toLocaleString('id-ID')}\n` +
    `Fee: Rp ${fee.toLocaleString('id-ID')}\n` +
    `Total Transfer: Rp ${totalTransfer.toLocaleString('id-ID')}\n` +
    `Ref: ${ref}`;
  for (const aid of adminIds) {
    await bot.telegram.sendMessage(aid, message).catch(() => {});
  }
}

async function getAutoProvisionDomain() {
  const raw = await getDynamicSetting('AUTO_PROVISION_DOMAIN', DEFAULT_AUTO_PROVISION_DOMAIN ? '1' : '0');
  return parseBool01(raw, DEFAULT_AUTO_PROVISION_DOMAIN);
}

async function getCertbotEmail() {
  return getDynamicSetting('CERTBOT_EMAIL', DEFAULT_CERTBOT_EMAIL);
}

async function getScInstallerLocalPath() {
  const dynamicPath = String(await getDynamicSetting('SC_INSTALLER_LOCAL_PATH', DEFAULT_SC_INSTALLER_LOCAL_PATH)).trim();
  const candidates = [
    DEFAULT_SC_INSTALLER_LOCAL_PATH,
    dynamicPath,
    normalizeLegacyInstallerPathValue(dynamicPath),
    LEGACY_SC_INSTALLER_LOCAL_PATH
  ].filter(Boolean);
  const uniq = [...new Set(candidates)];
  for (const p of uniq) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return DEFAULT_SC_INSTALLER_LOCAL_PATH;
}

async function getSummaryApiLocalPath() {
  const envPath = String(process.env.SUMMARY_API_LOCAL_PATH || '').trim();
  const candidates = [DEFAULT_SUMMARY_API_LOCAL_PATH, envPath].filter(Boolean);
  const uniq = [...new Set(candidates)];
  for (const p of uniq) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return DEFAULT_SUMMARY_API_LOCAL_PATH;
}

async function getDynamicSettingsSnapshot() {
  const [pricePerDay, unlimitedPrice, minDays, minTopup, expMs, autoProv, certEmail, installerPath] = await Promise.all([
    getRegistrationPricePerDay(),
    getUnlimitedPrice(),
    getRegistrationMinDays(),
    getTopupMin(),
    getTopupExpireMs(),
    getAutoProvisionDomain(),
    getCertbotEmail(),
    getScInstallerLocalPath()
  ]);
  return {
    SC_REGISTRATION_PRICE_PER_DAY: String(pricePerDay),
    SC_UNLIMITED_PRICE: String(unlimitedPrice),
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

function parseRenewErr(err) {
  const status = Number(err?.response?.status || 0);
  if (status === 404) {
    return 'endpoint renew tidak tersedia di API summary (:8789), perlu trigger via API utama (:8088)';
  }
  return parseErr(err);
}

function uiBox(title, lines = []) {
  const body = Array.isArray(lines) ? lines.map((x) => String(x ?? '')) : [String(lines || '')];
  const titleText = String(title || '').trim();
  const width = Math.max(
    titleText.length,
    ...body.map((line) => String(line || '').length),
    24
  );
  const sep = '─'.repeat(Math.min(width, 64));
  return [sep, titleText, '', ...body, sep].join('\n');
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
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} hari ${hours} jam ${minutes} menit`;
  if (hours > 0) return `${hours} jam ${minutes} menit`;
  return `${Math.max(1, minutes)} menit`;
}

function formatTopupStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'pending') return 'menunggu pembayaran';
  if (s === 'paid') return 'berhasil';
  if (s === 'expired') return 'kedaluwarsa';
  if (s === 'cancelled') return 'dibatalkan';
  return s || '-';
}

function toYmdUtc(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isDateExpExpired(dateExp) {
  const raw = String(dateExp || '').trim();
  if (!raw) return true;
  const normalized = raw.replace(' ', 'T');
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return true;
  const end = new Date(ms);
  const now = new Date();
  return end.getTime() < now.getTime();
}

function normalizeAccountForImport(type, row, opts = {}) {
  const t = String(type || '').trim().toLowerCase();
  const out = { ...(row || {}) };
  const forceActive = opts.forceActive !== false;
  if (forceActive) out.status = 'AKTIF';

  const shouldFixDate = opts.ensureNotExpired !== false;
  if (shouldFixDate) {
    const future = new Date(Date.now() + (24 * 60 * 60 * 1000));
    const fallbackDate = toYmdUtc(future);
    if (isDateExpExpired(out.date_exp)) {
      out.date_exp = fallbackDate;
      out.exp = fallbackDate;
      out.to = fallbackDate;
    }
  }

  if (t === 'ssh') {
    const username = String(out.username || '').trim();
    if (!String(out.password || '').trim()) out.password = username || '123456';
  }

  return out;
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

function saveVars(nextVars) {
  const file = path.join(__dirname, '.vars.json');
  const payload = { ...(nextVars || {}) };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function normalizeHttpUrl(urlLike) {
  const raw = String(urlLike || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '');
  return `https://${raw.replace(/\/$/, '')}`;
}

function getPaymentConfig() {
  const vars = loadVars();
  let mode = String(vars.PAYMENT_GATEWAY_MODE || 'gopay').trim().toLowerCase();
  if (!['orderkuota', 'gopay', 'both'].includes(mode)) mode = 'gopay';
  return {
    mode,
    orderkuotaBaseUrl: normalizeHttpUrl(vars.PAYMENT_GATEWAY_BASE_URL || 'https://api.rajaserver.web.id/orderkuota/createpayment'),
    orderkuotaApiKey: String(vars.RAJASERVER_API_KEY || '').trim(),
    qrisString: String(vars.DATA_QRIS || '').trim(),
    gopayBaseUrl: normalizeHttpUrl(vars.GOPAY_API_BASE_URL || 'https://api-gopay.sawargipay.cloud'),
    gopayApiKey: String(vars.GOPAY_API_KEY || '').trim()
  };
}

function paymentGatewayModeLabel(mode) {
  const m = String(mode || '').toLowerCase();
  if (m === 'orderkuota') return 'OrderKuota saja';
  if (m === 'gopay') return 'GoPay saja';
  if (m === 'both') return 'OrderKuota + GoPay';
  return m || '-';
}

function parseCurrencyNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : NaN;
  const text = String(value || '').trim();
  if (!text) return NaN;
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (!cleaned) return NaN;
  const normalized = cleaned.includes(',')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/\./g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.floor(parsed) : NaN;
}

function parseOrderKuotaMutations(responseData) {
  const mutations = [];
  const seen = new Set();
  const pushAmount = (amount, raw) => {
    const parsed = parseCurrencyNumber(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const key = `${parsed}:${String(raw || '').slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    mutations.push({ amount: parsed, raw: String(raw || '').slice(0, 200) });
  };
  const scanText = (text) => {
    const value = String(text || '');
    if (!value) return;
    const kreditRegex = /(?:Kredit|Credit|Masuk|Nominal|Amount|Jumlah|Total)\s*[:=]\s*(?:Rp\s*)?([\d.,]+)/gi;
    let match;
    while ((match = kreditRegex.exec(value)) !== null) pushAmount(match[1], match[0]);
  };
  const scanObject = (value) => {
    if (Array.isArray(value)) return value.forEach(scanObject);
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (/kredit|credit|amount|nominal|jumlah|total|nilai|mutasi/.test(lowerKey)) pushAmount(item, JSON.stringify(value));
      if (item && typeof item === 'object') scanObject(item);
      else if (typeof item === 'string' && /kredit|credit|nominal|amount|jumlah|masuk/i.test(item)) scanText(item);
    }
  };
  if (typeof responseData === 'string') {
    scanText(responseData);
    try { scanObject(JSON.parse(responseData)); } catch (_) {}
  } else {
    scanObject(responseData);
    scanText(JSON.stringify(responseData || {}));
  }
  return mutations;
}

async function checkOrderKuotaPaidByAmount(expectedAmount) {
  const data = buildPayload();
  const resultcek = await axios.post(API_URL, data, { headers, timeout: 10000 });
  const muts = parseOrderKuotaMutations(resultcek?.data);
  const target = Math.floor(Number(expectedAmount || 0));
  const amounts = new Set(muts.map((m) => Math.floor(Number(m.amount || 0))).filter((n) => Number.isFinite(n) && n > 0));
  return { paid: amounts.has(target), amounts };
}

async function syncOrderKuotaAmountLocks(currentAmountsSet) {
  const now = Date.now();
  const rows = await dbAll('SELECT amount FROM orderkuota_amount_locks');
  for (const row of rows) {
    const amt = Math.floor(Number(row?.amount || 0));
    if (!amt) continue;
    if (!currentAmountsSet.has(amt)) {
      await dbRun('DELETE FROM orderkuota_amount_locks WHERE amount = ?', [amt]);
    } else {
      await dbRun('UPDATE orderkuota_amount_locks SET last_seen_at = ? WHERE amount = ?', [now, amt]);
    }
  }
}

async function lockOrderKuotaAmount(amount) {
  const amt = Math.floor(Number(amount || 0));
  if (!Number.isFinite(amt) || amt <= 0) return;
  const now = Date.now();
  await dbRun(
    `INSERT INTO orderkuota_amount_locks (amount, created_at, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(amount) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [amt, now, now]
  );
}

async function getReservedOrderKuotaAmounts() {
  const reserved = new Set();
  const pendingRows = await dbAll(
    "SELECT amount FROM pending_deposits_app3 WHERE status = 'pending' AND LOWER(COALESCE(gateway_provider,'')) = 'orderkuota'"
  ).catch(() => []);
  for (const row of pendingRows) {
    const amt = Math.floor(Number(row?.amount || 0));
    if (Number.isFinite(amt) && amt > 0) reserved.add(amt);
  }
  const lockRows = await dbAll('SELECT amount FROM orderkuota_amount_locks').catch(() => []);
  for (const row of lockRows) {
    const amt = Math.floor(Number(row?.amount || 0));
    if (Number.isFinite(amt) && amt > 0) reserved.add(amt);
  }
  return reserved;
}

function getGopayConfig() {
  const cfg = getPaymentConfig();
  return { baseUrl: cfg.gopayBaseUrl, apiKey: cfg.gopayApiKey };
}

async function createGoPayQr(amount) {
  const cfg = getPaymentConfig();
  const { baseUrl, apiKey } = getGopayConfig();
  if (!(cfg.mode === 'gopay' || cfg.mode === 'both')) throw new Error('Gateway GoPay sedang nonaktif di konfigurasi admin.');
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
    provider: 'gopay',
    providerTxId: String(body.data.transaction_id),
    qrUrl: String(body.data.qr_url),
    billedAmount: Number(amount),
    originalAmount: Number(amount),
    adminFee: 0
  };
}

async function createOrderKuotaQr(amount, referenceId) {
  const cfg = getPaymentConfig();
  if (!(cfg.mode === 'orderkuota' || cfg.mode === 'both')) throw new Error('Gateway OrderKuota sedang nonaktif di konfigurasi admin.');
  if (!cfg.orderkuotaApiKey) throw new Error('RAJASERVER_API_KEY belum diisi di .vars.json');
  if (!cfg.qrisString) throw new Error('DATA_QRIS belum diisi di .vars.json');
  const gatewayUrl = `${cfg.orderkuotaBaseUrl}?${new URLSearchParams({
    apikey: cfg.orderkuotaApiKey,
    amount: String(amount),
    codeqr: cfg.qrisString,
    reference: String(referenceId || '')
  }).toString()}`;
  const bayar = await axios.get(gatewayUrl, { timeout: 15000 });
  if (String(bayar?.data?.status || '').toLowerCase() !== 'success') {
    throw new Error('OrderKuota gagal create QR: ' + JSON.stringify(bayar?.data || {}));
  }
  const qrUrl = String(bayar?.data?.result?.imageqris?.url || '');
  if (!qrUrl || qrUrl.includes('undefined')) {
    throw new Error('OrderKuota mengembalikan URL QR tidak valid.');
  }
  return {
    provider: 'orderkuota',
    providerTxId: String(bayar?.data?.result?.reference || referenceId || ''),
    qrUrl,
    billedAmount: Number(amount),
    originalAmount: Number(amount),
    adminFee: 0
  };
}

function randomOrderKuotaFee() {
  return Math.floor(Math.random() * 200) + 1;
}

async function createPaymentQrByMode(amount, referenceId) {
  const cfg = getPaymentConfig();
  if (cfg.mode === 'orderkuota') {
    const reserved = await getReservedOrderKuotaAmounts();
    let fee = randomOrderKuotaFee();
    let billedAmount = Number(amount) + fee;
    for (let i = 0; i < 300 && reserved.has(billedAmount); i++) {
      fee = randomOrderKuotaFee();
      billedAmount = Number(amount) + fee;
    }
    if (reserved.has(billedAmount)) {
      for (let f = 1; f <= 200; f++) {
        const candidate = Number(amount) + f;
        if (!reserved.has(candidate)) {
          fee = f;
          billedAmount = candidate;
          break;
        }
      }
    }
    if (reserved.has(billedAmount)) {
      throw new Error('Tidak ada nominal unik OrderKuota tersedia (range fee 1-200 penuh).');
    }
    const out = await createOrderKuotaQr(billedAmount, referenceId);
    return { ...out, billedAmount, originalAmount: Number(amount), adminFee: fee };
  }
  if (cfg.mode === 'gopay') return createGoPayQr(amount);
  try {
    const reserved = await getReservedOrderKuotaAmounts();
    let fee = randomOrderKuotaFee();
    let billedAmount = Number(amount) + fee;
    for (let i = 0; i < 300 && reserved.has(billedAmount); i++) {
      fee = randomOrderKuotaFee();
      billedAmount = Number(amount) + fee;
    }
    if (reserved.has(billedAmount)) {
      for (let f = 1; f <= 200; f++) {
        const candidate = Number(amount) + f;
        if (!reserved.has(candidate)) {
          fee = f;
          billedAmount = candidate;
          break;
        }
      }
    }
    if (reserved.has(billedAmount)) {
      throw new Error('Tidak ada nominal unik OrderKuota tersedia (range fee 1-200 penuh).');
    }
    const out = await createOrderKuotaQr(billedAmount, referenceId);
    return { ...out, billedAmount, originalAmount: Number(amount), adminFee: fee };
  } catch (_) {
    return createGoPayQr(amount);
  }
}

function getGatewayMinTopup() {
  const cfg = getPaymentConfig();
  const vars = loadVars();
  const okRaw = Number(vars.ORDERKUOTA_MIN_TOPUP || 0);
  const gopayRaw = Number(vars.GOPAY_MIN_TOPUP || 0);
  const okMin = Number.isFinite(okRaw) && okRaw >= 1000 ? Math.floor(okRaw) : 0;
  const gopayMin = Number.isFinite(gopayRaw) && gopayRaw >= 1000 ? Math.floor(gopayRaw) : 0;
  if (cfg.mode === 'orderkuota') return okMin;
  if (cfg.mode === 'both') return Math.max(okMin || 0, gopayMin || 0);
  return gopayMin;
}

async function getEffectiveTopupMin() {
  const gatewayMin = Number(getGatewayMinTopup() || 0);
  if (gatewayMin >= 1000) return gatewayMin;
  return getTopupMin();
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

async function saveServerKeyForHost(userId, host, key) {
  const uid = Number(userId || 0);
  const ip = normalizeHost(host);
  const k = String(key || '').trim();
  if (!uid || !isIpv4(ip) || k.length < 8) return;
  await dbRun(
    `INSERT INTO sc_server_keys (user_id, vps_ip, server_key, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, vps_ip) DO UPDATE SET
       server_key=excluded.server_key,
       updated_at=excluded.updated_at`,
    [uid, ip, k, Date.now()]
  ).catch(() => {});
}

async function getOwnerUserIdsByHost(host) {
  const ip = normalizeHost(host);
  if (!isIpv4(ip)) return [];
  const rows = await dbAll(
    "SELECT DISTINCT user_id FROM sc_registrations WHERE vps_ip = ? ORDER BY user_id ASC",
    [ip]
  ).catch(() => []);
  return rows
    .map((r) => Number(r?.user_id || 0))
    .filter((n) => Number.isInteger(n) && n > 0);
}

async function saveServerKeyForHostAllOwners(host, key, actorId = 0) {
  const ip = normalizeHost(host);
  const k = String(key || '').trim();
  if (!isIpv4(ip) || k.length < 8) return { saved_for: 0 };

  const ids = await getOwnerUserIdsByHost(ip);
  const uidActor = Number(actorId || 0);
  if (uidActor > 0 && !ids.includes(uidActor)) ids.push(uidActor);
  if (!ids.length) return { saved_for: 0 };

  let saved = 0;
  for (const uid of ids) {
    await saveServerKeyForHost(uid, ip, k);
    saved += 1;
  }
  return { saved_for: saved };
}

async function getServerKeyForHost(userId, host) {
  const uid = Number(userId || 0);
  const ip = normalizeHost(host);
  if (!uid || !isIpv4(ip)) return '';
  const row = await dbGet('SELECT server_key FROM sc_server_keys WHERE user_id = ? AND vps_ip = ? LIMIT 1', [uid, ip]);
  const own = String(row?.server_key || '').trim();
  if (own) return own;
  const fallback = await dbGet(
    'SELECT server_key FROM sc_server_keys WHERE vps_ip = ? ORDER BY updated_at DESC LIMIT 1',
    [ip]
  );
  return String(fallback?.server_key || '').trim();
}

async function syncKnownServerKeyAfterScRegistration(userId, host) {
  const uid = Number(userId || 0);
  const ip = normalizeHost(host);
  if (!uid || !isIpv4(ip)) return { ok: false, saved: false, message: 'invalid-user-or-host' };
  let key = await getServerKeyForHost(uid, ip);
  if (!key) key = String(process.env.DEFAULT_SERVER_KEY || '').trim();
  if (!key || key.length < 8) return { ok: false, saved: false, message: 'key-not-found' };
  await saveServerKeyForHost(uid, ip, key);
  await saveServerKeyForHostAllOwners(ip, key, uid);
  return { ok: true, saved: true };
}

async function shouldSendScNotify(userId, host, event, intervalMs = SC_NOTIFY_INTERVAL_MS) {
  const uid = Number(userId || 0);
  const ip = normalizeHost(host);
  const ev = String(event || '').trim().toLowerCase();
  if (!uid || !isIpv4(ip) || !ev) return false;
  const now = Date.now();
  const row = await dbGet(
    'SELECT last_sent_at FROM sc_notify_state WHERE user_id = ? AND vps_ip = ? AND event = ? LIMIT 1',
    [uid, ip, ev]
  );
  const last = Number(row?.last_sent_at || 0);
  if (last > 0 && now - last < Math.max(60000, Number(intervalMs) || SC_NOTIFY_INTERVAL_MS)) {
    return false;
  }
  await dbRun(
    `INSERT INTO sc_notify_state (user_id, vps_ip, event, last_sent_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, vps_ip, event) DO UPDATE SET last_sent_at=excluded.last_sent_at`,
    [uid, ip, ev, now]
  ).catch(() => {});
  return true;
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

async function getLatestRegistrationState(userId) {
  const now = Date.now();
  await dbRun(
    "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [now, now]
  ).catch(() => {});
  return dbGet(
    "SELECT vps_ip, client_name, status, expires_at, updated_at FROM sc_registrations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1",
    [userId]
  );
}

async function getRegistrationStateByIp(userId, ip, adminMode = false) {
  const now = Date.now();
  await dbRun(
    "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [now, now]
  ).catch(() => {});
  const host = normalizeHost(ip);
  if (!isIpv4(host)) return null;
  if (adminMode) {
    return dbGet(
      "SELECT user_id, vps_ip, client_name, status, expires_at, updated_at FROM sc_registrations WHERE LOWER(TRIM(REPLACE(vps_ip, char(13), ''))) = LOWER(TRIM(?)) ORDER BY updated_at DESC LIMIT 1",
      [host]
    );
  }
  return dbGet(
    "SELECT user_id, vps_ip, client_name, status, expires_at, updated_at FROM sc_registrations WHERE user_id = ? AND LOWER(TRIM(REPLACE(vps_ip, char(13), ''))) = LOWER(TRIM(?)) ORDER BY updated_at DESC LIMIT 1",
    [userId, host]
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

async function listActiveScHosts(limit = 1000) {
  const now = Date.now();
  await dbRun(
    "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [now, now]
  ).catch(() => {});
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 1000));
  const rows = await dbAll(
    "SELECT DISTINCT vps_ip FROM sc_registrations " +
      "WHERE status='active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?) " +
      "ORDER BY updated_at DESC LIMIT ?",
    [now, safeLimit]
  );
  return rows
    .map((r) => normalizeHost(r?.vps_ip || ''))
    .filter((ip) => isIpv4(ip));
}

async function adminRemoveRegisteredIp(ip, adminId) {
  const now = Date.now();
  const rows = await dbAll(
    "SELECT id, user_id, vps_ip, client_name, expires_at FROM sc_registrations " +
      "WHERE LOWER(TRIM(REPLACE(vps_ip, char(13), '')))=LOWER(TRIM(?)) AND status='active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?)",
    [ip, now]
  );
  if (!rows.length) {
    return { removed: 0, rows: [], affectedUsers: [], removedRowsAllIps: 0 };
  }
  const affectedUsers = Array.from(
    new Set(
      rows
        .map((r) => Number(r?.user_id || 0))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  );
  if (!affectedUsers.length) {
    return { removed: 0, rows, affectedUsers: [], removedRowsAllIps: 0 };
  }
  const tx = await dbRun(
    `UPDATE sc_registrations
     SET status = 'deleted_by_admin', updated_at = ?, expires_at = ?
     WHERE LOWER(TRIM(REPLACE(vps_ip, char(13), ''))) = LOWER(TRIM(?))
       AND status='active'
       AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?)`,
    [now, now, ip, now]
  );
  await saveTransaction(
    Number(adminId) || 0,
    0,
    'admin_remove_sc_ip',
    `admin_remove_sc_ip_${ip}_${now}`
  ).catch(() => {});
  return {
    removed: rows.length,
    rows,
    affectedUsers,
    removedRowsAllIps: Number(tx?.changes || 0)
  };
}

async function lockScAccessByHost(host, key, actorId, reason = 'admin_remove_sc_ip') {
  return apiPost(host, key, '/internal/sc-access-lock', {
    blocked: true,
    reason: String(reason || 'admin_remove_sc_ip'),
    actor: String(actorId || '')
  });
}

async function unlockScAccessByHost(host, key, actorId, reason = 'renew_after_expired') {
  return apiPost(host, key, '/internal/sc-access-lock', {
    blocked: false,
    reason: String(reason || 'renew_after_expired'),
    actor: String(actorId || '')
  });
}

async function tryAutoUnlockAfterRenew(userId, host, reason = 'renew_after_expired') {
  const ip = normalizeHost(host);
  if (!isIpv4(ip)) return { attempted: false, ok: false, message: 'ip tidak valid' };
  const key = await getServerKeyForHost(userId, ip);
  if (String(key || '').trim().length < 8) {
    return { attempted: false, ok: false, message: 'key server belum tersimpan' };
  }
  try {
    const res = await unlockScAccessByHost(ip, key, userId, reason);
    return { attempted: true, ok: res?.blocked === false, message: 'unlock berhasil' };
  } catch (err) {
    return { attempted: true, ok: false, message: parseErr(err) };
  }
}

async function notifyScExpiredOnHost(host, key, payload = {}) {
  return apiPost(host, key, '/internal/sc-expired-notify', payload);
}

async function notifyExpiredUsersInBot(ctx, userIds, ip, reason = 'admin_remove_sc_ip') {
  const ids = Array.isArray(userIds)
    ? Array.from(new Set(userIds.map((n) => Number(n || 0)).filter((n) => Number.isInteger(n) && n > 0)))
    : [];
  let ok = 0;
  let fail = 0;
  for (const uid of ids) {
    try {
      await ctx.telegram.sendMessage(
        uid,
        `SC kamu telah expired oleh admin.\n` +
          `IP VPS: ${ip}\n` +
          `Reason: ${reason}\n\n` +
          `Silakan perpanjang SC untuk akses kembali.`
      );
      ok += 1;
    } catch (_) {
      fail += 1;
    }
  }
  return { total: ids.length, ok, fail };
}

async function notifySingleUserInBot(userId, message) {
  const uid = Number(userId || 0);
  if (!uid) return false;
  try {
    await bot.telegram.sendMessage(uid, String(message || '').trim());
    return true;
  } catch (_) {
    return false;
  }
}

async function runNaturalScExpiryJobs() {
  const now = Date.now();
  const remindUntil = now + SC_H2_WINDOW_MS;
  const activeRows = await dbAll(
    "SELECT user_id, vps_ip, client_name, status, expires_at FROM sc_registrations " +
      "WHERE status='active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [remindUntil]
  ).catch(() => []);

  for (const row of activeRows) {
    const uid = Number(row?.user_id || 0);
    const host = normalizeHost(row?.vps_ip || '');
    const expTs = Number(row?.expires_at || 0);
    if (!uid || !isIpv4(host) || !expTs) continue;

    if (expTs <= now) {
      await dbRun(
        "UPDATE sc_registrations SET status='expired', updated_at=? WHERE user_id=? AND vps_ip=? AND status='active'",
        [now, uid, host]
      ).catch(() => {});

      const canNotifyUser = await shouldSendScNotify(uid, host, 'natural_expired_user', SC_NOTIFY_INTERVAL_MS);
      if (canNotifyUser) {
        await notifySingleUserInBot(
          uid,
          `SC kamu sudah expired karena masa aktif habis.\n` +
            `IP VPS: ${host}\n` +
            `Expired: ${formatDateTime(expTs)}\n\n` +
            `Akses menu SC ditolak sampai diperpanjang.`
        );
      }

      const serverKey = await getServerKeyForHost(uid, host);
      if (serverKey) {
        await syncScRegistrationMetaToHost(host, serverKey, {
          status: 'expired',
          client_name: normalizeClientName(row?.client_name || host) || host,
          expires_at: Number(expTs || 0)
        }).catch(() => {});
        await lockScAccessByHost(host, serverKey, uid, 'natural_expired').catch(() => {});
        const canNotifyLocal = await shouldSendScNotify(uid, host, 'natural_expired_local', SC_NOTIFY_INTERVAL_MS);
        if (canNotifyLocal) {
          await notifyScExpiredOnHost(host, serverKey, {
            ip: host,
            reason: 'natural_expired',
            actor: String(uid),
            users: [String(uid)],
            message:
              'SC 1FORCR NOTIF\n' +
              'Status : SC expired (natural)\n' +
              `IP VPS : ${host}\n` +
              `User   : ${uid}\n\n` +
              'SC harus diperpanjang untuk akses kembali.'
          }).catch(() => {});
        }
      }
      continue;
    }

    const canRemind = await shouldSendScNotify(uid, host, 'h2_reminder_user', SC_NOTIFY_INTERVAL_MS);
    if (canRemind) {
      const remain = formatRemainingDays(expTs);
      await notifySingleUserInBot(
        uid,
        `Pengingat H-2: masa aktif SC akan segera habis.\n` +
          `IP VPS: ${host}\n` +
          `Expired: ${formatDateTime(expTs)}\n` +
          `Sisa: ${remain}\n\n` +
          `Silakan perpanjang agar akses tidak terblokir.`
      );
    }

    const serverKey = await getServerKeyForHost(uid, host);
    if (serverKey) {
      const canRemindLocal = await shouldSendScNotify(uid, host, 'h2_reminder_local', SC_NOTIFY_INTERVAL_MS);
      if (canRemindLocal) {
        await notifyScExpiredOnHost(host, serverKey, {
          ip: host,
          reason: 'h2_reminder',
          actor: String(uid),
          users: [String(uid)],
          message:
            'SC 1FORCR NOTIF\n' +
            'Reminder : H-2 masa aktif SC\n' +
            `IP VPS   : ${host}\n` +
            `User     : ${uid}\n` +
            `Expired  : ${formatDateTime(expTs)}\n\n` +
            'Silakan perpanjang sebelum expired.'
        }).catch(() => {});
      }
    }
  }
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

async function isAnyRegisteredHost(host) {
  await dbRun(
    "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
    [Date.now(), Date.now()]
  ).catch(() => {});
  const row = await dbGet(
    "SELECT 1 AS ok FROM sc_registrations WHERE vps_ip = ? AND status = 'active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?) LIMIT 1",
    [host, Date.now()]
  );
  return !!row;
}

async function canAccessHostForScOps(userId, host) {
  const normalizedHost = normalizeHost(host);
  if (!isIpv4(normalizedHost)) return false;
  if (isAdmin(userId)) return isAnyRegisteredHost(normalizedHost);
  return isRegisteredHost(userId, normalizedHost);
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
    const prevStatus = String(existing?.status || '').trim().toLowerCase();
    const isCarryForward = prevStatus === 'active';
    const baseExpiry = isCarryForward ? Math.max(now, Number(existing?.expires_at || 0)) : now;
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
    return {
      success: true,
      expiresAt: nextExpiry,
      clientName: finalClientName,
      prevStatus,
      reactivatedFromExpired: prevStatus === 'expired'
    };
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function registerScIpUnlimited(userId, ip, clientName, options = {}) {
  await ensureUser(userId);

  if (await isIpOwnedByOther(ip, userId)) {
    throw new Error('IP VPS ini sudah terdaftar oleh user lain.');
  }

  const existing = await dbGet(
    "SELECT id, status, expires_at, client_name FROM sc_registrations WHERE user_id = ? AND vps_ip = ? LIMIT 1",
    [userId, ip]
  );

  const chargeSaldo = options?.chargeSaldo === true;
  const totalFee = Math.max(0, Number(options?.totalFee || 0));
  const txType = String(options?.txType || (chargeSaldo ? 'sc_registration_unlimited' : 'sc_registration_unlimited_admin')).trim();
  const txRef = String(options?.txRef || `sc_unl_${userId}_${ip}_${Date.now()}`).trim();

  await dbRun('BEGIN IMMEDIATE TRANSACTION');
  try {
    if (chargeSaldo) {
      const ok = await deductSaldoAtomic(userId, totalFee);
      if (!ok) {
        await dbRun('ROLLBACK');
        return { insufficient: true };
      }
    }

    const now = Date.now();
    const prevStatus = String(existing?.status || '').trim().toLowerCase();
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
      ['active', now, 0, finalClientName, userId, ip]
    );

    if (chargeSaldo && totalFee > 0) {
      await saveTransaction(userId, -totalFee, txType, txRef);
    }
    await dbRun('COMMIT');
    return {
      success: true,
      expiresAt: 0,
      clientName: finalClientName,
      prevStatus,
      reactivatedFromExpired: prevStatus === 'expired'
    };
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Daftar / Perpanjang SC', 'm_register_sc'), Markup.button.callback('SC Saya', 'm_my_sc')],
    [Markup.button.callback('Fitur-Fitur SC 1FORCR NEXUS', 'm_sc_features')],
    [Markup.button.callback('Jadi Reseller', 'm_become_reseller')],
    [Markup.button.callback('Cek Expired IP VPS', 'm_check_sc_ip_expiry')],
    [Markup.button.callback('Link Instalasi', 'm_install_link'), Markup.button.callback('Top Up Saldo', 'm_topup_saldo')],
    [Markup.button.callback('Cek Saldo', 'm_cek_saldo'), Markup.button.callback('Cadangkan SC', 'm_backup_now')],
    [Markup.button.callback('Pulihkan SC', 'm_restore_upload'), Markup.button.callback('Hapus Semua Akun', 'm_delete_all_accounts')],
    [Markup.button.callback('Migrasi Akun', 'm_migrate_accounts')],
    [Markup.button.callback('Menu Admin', 'm_admin_menu')]
  ]);
}

const ACCOUNT_PROTOCOLS = [
  { type: 'ssh', label: 'SSH (termasuk UDP/ZIVPN)' },
  { type: 'vmess', label: 'VMESS' },
  { type: 'vless', label: 'VLESS' },
  { type: 'trojan', label: 'TROJAN' }
];

function protocolLabel(type) {
  const t = String(type || '').trim().toLowerCase();
  const found = ACCOUNT_PROTOCOLS.find((p) => p.type === t);
  return found ? found.label : t.toUpperCase();
}

function protocolKeyboard(prefix, cancelAction) {
  const rows = ACCOUNT_PROTOCOLS.map((p) => [Markup.button.callback(p.label, `${prefix}_${p.type}`)]);
  rows.push([Markup.button.callback('Batal', cancelAction)]);
  return Markup.inlineKeyboard(rows);
}

function deleteProtocolKeyboard(prefix, cancelAction) {
  const rows = [
    [Markup.button.callback('SEMUA PROTOKOL (SSH+VMESS+VLESS+TROJAN)', `${prefix}_all`)],
    ...ACCOUNT_PROTOCOLS.map((p) => [Markup.button.callback(p.label, `${prefix}_${p.type}`)]),
    [Markup.button.callback('Batal', cancelAction)]
  ];
  return Markup.inlineKeyboard(rows);
}

function migrateProtocolKeyboard(prefix, cancelAction) {
  const rows = [
    [Markup.button.callback('SEMUA PROTOKOL (SSH+VMESS+VLESS+TROJAN)', `${prefix}_all`)],
    ...ACCOUNT_PROTOCOLS.map((p) => [Markup.button.callback(p.label, `${prefix}_${p.type}`)]),
    [Markup.button.callback('Batal', cancelAction)]
  ];
  return Markup.inlineKeyboard(rows);
}

async function registerScMenu() {
  const unlimitedPrice = await getUnlimitedPrice();
  return Markup.inlineKeyboard([
    [Markup.button.callback('Registrasi Baru', 'm_register_sc_new')],
    [Markup.button.callback('Perpanjang SC', 'm_register_sc_extend')],
    [Markup.button.callback(`SC Unlimited (Rp ${Number(unlimitedPrice).toLocaleString('id-ID')})`, 'm_register_sc_unlimited')],
    [Markup.button.callback('Jadi Reseller', 'm_become_reseller')],
    [Markup.button.callback('Kembali', 'm_register_sc_back')]
  ]);
}

function adminMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Tambah Saldo User', 'm_admin_add_saldo'), Markup.button.callback('Daftarkan SC Unlimited', 'm_admin_sc_unlimited')],
    [Markup.button.callback('Set User Jadi Reseller', 'm_admin_reseller_enable'), Markup.button.callback('Nonaktifkan User Reseller', 'm_admin_reseller_disable')],
    [Markup.button.callback('Set WA Admin Reseller', 'm_admin_set_reseller_wa')],
    [Markup.button.callback('Edit Info Fitur SC', 'm_admin_set_sc_features_info')],
    [Markup.button.callback('Tambah Domain', 'm_admin_add_domain'), Markup.button.callback('Daftar Domain', 'm_admin_list_domains')],
    [Markup.button.callback('Hapus Domain', 'm_admin_remove_domain'), Markup.button.callback('Hapus IP VPS', 'm_admin_remove_sc_ip')],
    [Markup.button.callback('Unlock Akses VPS', 'm_admin_unlock_sc_access'), Markup.button.callback('Daftar IP + KEY + ID', 'm_admin_list_ip_keys_0')],
    [Markup.button.callback('Setting Payment Gateway', 'm_admin_payment_gateway_menu')],
    [Markup.button.callback('Lihat Pengaturan', 'm_admin_env_show'), Markup.button.callback('Ubah Pengaturan', 'm_admin_env_set')],
    [Markup.button.callback('Unggah Script SC', 'm_admin_upload_sc'), Markup.button.callback('Unggah Script Summary API', 'm_admin_upload_summary_api')],
    [Markup.button.callback('Kembali', 'm_admin_back')]
  ]);
}

function adminPaymentGatewayMainMenu() {
  const cfg = getPaymentConfig();
  return Markup.inlineKeyboard([
    [Markup.button.callback('Mode: OrderKuota saja', 'm_pg_mode_orderkuota')],
    [Markup.button.callback('Mode: GoPay saja', 'm_pg_mode_gopay')],
    [Markup.button.callback('Mode: Keduanya (fallback)', 'm_pg_mode_both')],
    [Markup.button.callback('Setting OrderKuota', 'm_pg_menu_orderkuota')],
    [Markup.button.callback('Setting GoPay', 'm_pg_menu_gopay')],
    [Markup.button.callback('Kembali', 'm_admin_menu')]
  ]);
}

function adminPaymentGatewayOrderKuotaMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Set Gateway URL', 'm_pg_set_orderkuota_url')],
    [Markup.button.callback('Set RajaServer API Key', 'm_pg_set_orderkuota_api_key')],
    [Markup.button.callback('Set DATA_QRIS String', 'm_pg_set_orderkuota_qris')],
    [Markup.button.callback('Set ORKUT Username', 'm_pg_set_orkut_username')],
    [Markup.button.callback('Set ORKUT Token', 'm_pg_set_orkut_token')],
    [Markup.button.callback('Set Minimal TopUp', 'm_pg_set_orderkuota_min_topup')],
    [Markup.button.callback('Kembali', 'm_admin_payment_gateway_menu')]
  ]);
}

function adminPaymentGatewayGoPayMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Set GoPay API Base URL', 'm_pg_set_gopay_base_url')],
    [Markup.button.callback('Set GoPay API Key', 'm_pg_set_gopay_api_key')],
    [Markup.button.callback('Set Minimal TopUp', 'm_pg_set_gopay_min_topup')],
    [Markup.button.callback('Kembali', 'm_admin_payment_gateway_menu')]
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
      [Markup.button.callback(getSettingLabel('SC_RESELLER_PRICE_PER_DAY'), 'm_admin_env_pick_SC_RESELLER_PRICE_PER_DAY')],
      [Markup.button.callback(getSettingLabel('SC_UNLIMITED_PRICE'), 'm_admin_env_pick_SC_UNLIMITED_PRICE')],
      [Markup.button.callback(getSettingLabel('SC_REGISTRATION_MIN_DAYS'), 'm_admin_env_pick_SC_REGISTRATION_MIN_DAYS')],
      [Markup.button.callback(getSettingLabel('TOPUP_MIN'), 'm_admin_env_pick_TOPUP_MIN')],
      [Markup.button.callback(getSettingLabel('TOPUP_EXPIRE_MS'), 'm_admin_env_pick_TOPUP_EXPIRE_MS')],
      [Markup.button.callback(getSettingLabel('TOPUP_SUCCESS_NOTIFY_ENABLE'), 'm_admin_env_pick_TOPUP_SUCCESS_NOTIFY_ENABLE')],
      [Markup.button.callback(getSettingLabel('TOPUP_SUCCESS_NOTIFY_ADMIN_IDS'), 'm_admin_env_pick_TOPUP_SUCCESS_NOTIFY_ADMIN_IDS')],
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
    case 'SC_RESELLER_PRICE_PER_DAY':
      return 'Contoh: 15000 (rupiah per hari untuk reseller).';
    case 'SC_UNLIMITED_PRICE':
      return 'Contoh: 70000 (rupiah, angka bulat).';
    case 'SC_REGISTRATION_MIN_DAYS':
      return 'Contoh: 1 (minimal hari pembelian user).';
    case 'TOPUP_MIN':
      return 'Contoh: 5000 (minimal top up saldo).';
    case 'TOPUP_EXPIRE_MS':
      return 'Contoh: 900000 untuk 15 menit.';
    case 'TOPUP_SUCCESS_NOTIFY_ENABLE':
      return 'Isi: 1 atau 0 (1=aktif, 0=nonaktif).';
    case 'TOPUP_SUCCESS_NOTIFY_ADMIN_IDS':
      return 'Contoh: 123456789,987654321 (pisah koma).';
    case 'RESELLER_ADMIN_WA':
      return 'Contoh: 089612745096 atau 6289612745096.';
    case 'AUTO_PROVISION_DOMAIN':
      return 'Isi: 1 atau 0 (1=aktif, 0=nonaktif).';
    case 'CERTBOT_EMAIL':
      return 'Contoh: admin@domainkamu.com (boleh kosong).';
    case 'SC_INSTALLER_LOCAL_PATH':
      return 'Contoh: /root/botsc1forcrnexus/scripts/setup-autoscript-compat.sh';
    default:
      return '';
  }
}

function adminIpKeyListKeyboard(page, totalPages) {
  const p = Math.max(0, Number(page) || 0);
  const total = Math.max(1, Number(totalPages) || 1);
  const rows = [];
  if (total > 1) {
    const nav = [];
    if (p > 0) nav.push(Markup.button.callback('Prev', `m_admin_list_ip_keys_${p - 1}`));
    if (p < total - 1) nav.push(Markup.button.callback('Next', `m_admin_list_ip_keys_${p + 1}`));
    if (nav.length) rows.push(nav);
  }
  rows.push([Markup.button.callback('Refresh', `m_admin_list_ip_keys_${p}`)]);
  rows.push([Markup.button.callback('Kembali', 'm_admin_menu')]);
  return Markup.inlineKeyboard(rows);
}

async function countServerKeysForAdmin() {
  const row = await dbGet('SELECT COUNT(*) AS c FROM sc_server_keys');
  return Number(row?.c || 0);
}

async function listServerKeysForAdminPage(page = 0, pageSize = 12) {
  const p = Math.max(0, Number(page) || 0);
  const size = Math.max(5, Math.min(30, Number(pageSize) || 12));
  const offset = p * size;
  return dbAll(
    'SELECT user_id, vps_ip, server_key, updated_at FROM sc_server_keys ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    [size, offset]
  );
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
  const latest = await getLatestRegistrationState(ctx.from.id).catch(() => null);
  if (latest) {
    const st = String(latest.status || '').trim().toLowerCase();
    if (st === 'expired' || st === 'deleted_by_admin') {
      await ctx.reply(
        'Akses fitur SC ditolak karena SC kamu expired.\n\n' +
          `IP terakhir: ${latest.vps_ip || '-'}\n` +
          `Expired: ${formatDateTime(latest.expires_at)}\n\n` +
          'SC harus diperpanjang dulu dari menu: "Daftar / Perpanjang SC".',
        mainMenu()
      );
      return false;
    }
  }
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

async function syncScRegistrationMetaToHost(host, key, meta = {}) {
  const safeHost = normalizeHost(host);
  const safeKey = String(key || '').trim();
  if (!isIpv4(safeHost) || safeKey.length < 8) {
    return { ok: false, skipped: true, message: 'host/key tidak tersedia' };
  }
  try {
    const payload = {
      status: String(meta.status || 'active').trim().toLowerCase() || 'active',
      client_name: String(meta.client_name || '').trim(),
      expires_at: Number(meta.expires_at || 0)
    };
    await apiPost(safeHost, safeKey, '/internal/sc-registration-meta', payload, 30000);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: parseErr(err) };
  }
}

function normalizeReleaseVersion(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').slice(0, 64);
}

function normalizeReleaseDescription(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{2,}/g, '\n').slice(0, 1200);
}

async function getActiveUserIdsByHosts(hostsInput) {
  const hosts = Array.from(
    new Set(
      (Array.isArray(hostsInput) ? hostsInput : [])
        .map((h) => normalizeHost(h))
        .filter((h) => isIpv4(h))
    )
  );
  if (!hosts.length) return [];
  const now = Date.now();
  const placeholders = hosts.map(() => '?').join(',');
  const rows = await dbAll(
    `SELECT DISTINCT user_id
     FROM sc_registrations
     WHERE status='active'
       AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?)
       AND vps_ip IN (${placeholders})`,
    [now, ...hosts]
  );
  return Array.from(
    new Set(
      rows
        .map((r) => Number(r?.user_id || 0))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  );
}

async function broadcastUpdateNoticeToUsers(userIdsInput, message) {
  const userIds = Array.from(
    new Set(
      (Array.isArray(userIdsInput) ? userIdsInput : [])
        .map((n) => Number(n || 0))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  );
  let sent = 0;
  let failed = 0;
  for (const uid of userIds) {
    const ok = await notifySingleUserInBot(uid, message);
    if (ok) sent += 1;
    else failed += 1;
  }
  return { total: userIds.length, sent, failed };
}

function uniqUsernames(accounts) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(accounts) ? accounts : []) {
    const u = String(row?.username || '').trim();
    if (!u) continue;
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

function chunkArray(input, size = 200) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  const chunkSize = Math.max(1, Number(size) || 200);
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, i + chunkSize));
  }
  return out;
}

async function rebuildXrayFromType(host, key, type, sampleUser) {
  const t = String(type || '').trim().toLowerCase();
  const u = String(sampleUser || '').trim();
  if (!u) return { ok: false, skipped: true, message: 'sample username kosong' };
  if (!['vmess', 'vless', 'trojan'].includes(t)) {
    return { ok: false, skipped: true, message: 'protocol non-xray' };
  }
  try {
    await apiPost(host, key, '/internal/sync-xray-from-db', { type: t, restart: false });
    return { ok: true, mode: 'sync-xray-from-db' };
  } catch (syncErr) {
    await apiPost(host, key, '/internal/renew-xray-account', {
      type: t,
      username: u,
      days: 0
    });
    return { ok: true, mode: 'renew-fallback' };
  }
}

async function applyXrayRestart(host, key) {
  return apiPost(host, key, '/internal/apply-xray-restart', {});
}

async function tryRebuildXrayAny(host, key, preferredType = '') {
  const pref = String(preferredType || '').trim().toLowerCase();
  const ordered = ['vmess', 'vless', 'trojan'];
  if (ordered.includes(pref)) {
    ordered.splice(ordered.indexOf(pref), 1);
    ordered.unshift(pref);
  }
  for (const type of ordered) {
    const exported = await apiGet(host, key, '/internal/export-accounts', { type, limit: 1 });
    const list = Array.isArray(exported?.accounts) ? exported.accounts : [];
    const sampleUser = String(list[0]?.username || '').trim();
    if (!sampleUser) continue;
    await rebuildXrayFromType(host, key, type, sampleUser);
    return { ok: true, type, username: sampleUser };
  }
  return { ok: false, message: 'tidak ada akun VMESS/VLESS/TROJAN aktif untuk trigger rebuild' };
}

async function deleteAllByProtocol(host, key, type) {
  const t = String(type || '').trim().toLowerCase();
  const exported = await apiGet(host, key, '/internal/export-accounts', { type: t, limit: 50000 });
  const accounts = Array.isArray(exported?.accounts) ? exported.accounts : [];
  const usernames = uniqUsernames(accounts);
  if (usernames.length === 0) {
    return { exported: 0, deleted: 0, mode: 'empty' };
  }

  if (t === 'ssh') {
    const res = await apiPost(host, key, '/internal/delete-all-accounts', { type: 'ssh' });
    return {
      exported: usernames.length,
      deleted: Number(res?.deleted_db || 0),
      mode: 'delete-all'
    };
  }

  let deleted = 0;
  for (const part of chunkArray(usernames, 200)) {
    const res = await apiPost(host, key, '/internal/delete-accounts', { type: t, usernames: part });
    deleted += Number(res?.deleted || 0);
  }
  return { exported: usernames.length, deleted, mode: 'batch-delete' };
}

async function deleteAllProtocols(host, key) {
  const types = ['ssh', 'vmess', 'vless', 'trojan'];
  const results = {};
  for (const type of types) {
    results[type] = await deleteAllByProtocol(host, key, type);
  }
  return results;
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

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buildInstallerQuickCopyText() {
  const domain = await getPrimaryApiDomain();
  if (!domain) {
    return {
      ok: false,
      text: 'Link installer belum tersedia. Hubungi admin untuk set domain installer.',
      parse_mode: undefined
    };
  }
  const installerUrl = `https://${domain}/sc1forcr/installer.sh`;
  const cmd = `apt-get update -y && apt-get upgrade -y && apt-get install -y curl ca-certificates htop && bash -c "$(curl -fsSL ${installerUrl})"`;
  const safeUrl = escapeHtml(installerUrl);
  const safeCmd = escapeHtml(cmd);
  return {
    ok: true,
    text:
      `Link instalasi untuk di vps:\n<pre><code>${safeCmd}</code></pre>`,
    parse_mode: 'HTML'
  };
}

async function buildBotScriptUrls() {
  const domain = await getPrimaryApiDomain().catch(() => '');
  const d = String(domain || '').trim();
  if (!d) return { updateScriptUrl: '' };
  return {
    updateScriptUrl: `https://${d}/sc1forcr/payload/scripts/setup-autoscript-compat.sh`
  };
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
    const creditAmount = Number(row.original_amount || row.amount || 0);
    await addSaldo(row.user_id, creditAmount);
    await dbRun("UPDATE pending_deposits_app3 SET status='paid' WHERE unique_code = ?", [row.unique_code]);
    await saveTransaction(row.user_id, creditAmount, 'deposit', String(row.reference_id || row.unique_code));
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

      const provider = String(row.gateway_provider || 'gopay').toLowerCase();
      if (provider !== 'gopay') continue;
      const st = await checkGoPayStatus(String(row.provider_tx_id || '')).catch(() => null);
      if (!st || st.pending) continue;
      if (st.settled) {
        const credited = await markPendingPaid(row);
        if (credited) {
          await notifyAdminsTopupSuccess(row).catch(() => {});
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
  const [{ pricePerDay, isReseller }, minDays] = await Promise.all([getRegistrationPricePerDayForUser(ctx.from.id), getRegistrationMinDays()]);
  await ctx.reply(
    uiBox('SC 1FORCR NEXUS - INFORMASI AKUN', [
      `Saldo Kamu       : Rp ${Number(saldo).toLocaleString('id-ID')}`,
      `IP Terdaftar     : ${regs.length}`,
      `Harga SC / Hari  : Rp ${pricePerDay.toLocaleString('id-ID')}${isReseller ? ' (RESELLER)' : ''}`,
      `Status Reseller  : ${isReseller ? 'RESELLER' : 'NON-RESELLER'}`,
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

bot.action('m_become_reseller', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const wa = await getResellerAdminWaNumber();
  if (!wa) {
    return ctx.reply('Nomor WA admin reseller belum diset. Hubungi admin bot.');
  }
  const waUrl = buildResellerWaUrl(wa, ctx.from || {});
  return ctx.reply(
    uiBox('DAFTAR RESELLER', [
      'Untuk jadi reseller SC, silakan hubungi admin via WhatsApp:',
      `wa.me/${wa}`,
      '',
      'Template pesan sudah disiapkan dan memuat ID Telegram kamu.'
    ]),
    Markup.inlineKeyboard([
      [Markup.button.url('Hubungi Admin WA', waUrl)],
      [Markup.button.callback('Kembali', 'm_register_sc_back')]
    ])
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

bot.action('m_admin_payment_gateway_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  const cfg = getPaymentConfig();
  return ctx.reply(
    uiBox('SETTING PAYMENT GATEWAY', [
      `Mode aktif: ${paymentGatewayModeLabel(cfg.mode)}`,
      '',
      'Pilih mode atau masuk ke submenu provider.'
    ]),
    adminPaymentGatewayMainMenu()
  );
});

async function setPaymentMode(ctx, mode) {
  const m = String(mode || '').toLowerCase();
  if (!['orderkuota', 'gopay', 'both'].includes(m)) return ctx.reply('Mode gateway tidak valid.');
  const v = loadVars();
  v.PAYMENT_GATEWAY_MODE = m;
  saveVars(v);
  await ctx.answerCbQuery('Mode gateway tersimpan.').catch(() => {});
  return ctx.reply(`Mode gateway aktif: ${paymentGatewayModeLabel(m)}`, adminPaymentGatewayMainMenu());
}

bot.action('m_pg_mode_orderkuota', async (ctx) => setPaymentMode(ctx, 'orderkuota'));
bot.action('m_pg_mode_gopay', async (ctx) => setPaymentMode(ctx, 'gopay'));
bot.action('m_pg_mode_both', async (ctx) => setPaymentMode(ctx, 'both'));

bot.action('m_pg_menu_orderkuota', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  const cfg = getPaymentConfig();
  return ctx.reply(
    uiBox('SETTING ORDERKUOTA', [
      `Gateway URL: ${cfg.orderkuotaBaseUrl || '-'}`,
      `API Key: ${cfg.orderkuotaApiKey ? 'Tersimpan' : 'Belum diisi'}`,
      `DATA_QRIS: ${cfg.qrisString ? 'Tersimpan' : 'Belum diisi'}`,
      `ORKUT Username: ${String(loadVars().ORKUT_USERNAME || '').trim() ? 'Tersimpan' : 'Belum diisi'}`,
      `ORKUT Token: ${String(loadVars().ORKUT_TOKEN || '').trim() ? 'Tersimpan' : 'Belum diisi'}`,
      `Minimal TopUp: Rp ${Math.max(1000, Number(loadVars().ORDERKUOTA_MIN_TOPUP || 2000) || 2000).toLocaleString('id-ID')}`
    ]),
    adminPaymentGatewayOrderKuotaMenu()
  );
});

bot.action('m_pg_menu_gopay', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  const cfg = getPaymentConfig();
  return ctx.reply(
    uiBox('SETTING GOPAY', [
      `Base URL: ${cfg.gopayBaseUrl || '-'}`,
      `API Key: ${cfg.gopayApiKey ? 'Tersimpan' : 'Belum diisi'}`,
      `Minimal TopUp: Rp ${Math.max(1000, Number(loadVars().GOPAY_MIN_TOPUP || 2000) || 2000).toLocaleString('id-ID')}`
    ]),
    adminPaymentGatewayGoPayMenu()
  );
});

bot.action('m_pg_set_orderkuota_url', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'pg_set_orderkuota_url' });
  return ctx.reply('Kirim Gateway URL OrderKuota. Contoh: https://api.rajaserver.web.id/orderkuota/createpayment');
});
bot.action('m_pg_set_orderkuota_api_key', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'pg_set_orderkuota_api_key' });
  return ctx.reply('Kirim RAJASERVER_API_KEY baru.');
});
bot.action('m_pg_set_orderkuota_qris', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'pg_set_orderkuota_qris' });
  return ctx.reply('Kirim DATA_QRIS string baru.');
});
bot.action('m_pg_set_orderkuota_min_topup', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'pg_set_orderkuota_min_topup' });
  return ctx.reply('Kirim minimal topup OrderKuota (angka rupiah). Contoh: 2000');
});
bot.action('m_pg_set_orkut_username', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'pg_set_orkut_username' });
  return ctx.reply('Kirim ORKUT_USERNAME baru.');
});
bot.action('m_pg_set_orkut_token', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'pg_set_orkut_token' });
  return ctx.reply('Kirim ORKUT_TOKEN baru.');
});
bot.action('m_pg_set_gopay_base_url', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'pg_set_gopay_base_url' });
  return ctx.reply('Kirim GoPay API Base URL. Contoh: https://api-gopay.sawargipay.cloud');
});
bot.action('m_pg_set_gopay_api_key', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'pg_set_gopay_api_key' });
  return ctx.reply('Kirim GoPay API Key baru.');
});
bot.action('m_pg_set_gopay_min_topup', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'pg_set_gopay_min_topup' });
  return ctx.reply('Kirim minimal topup GoPay (angka rupiah). Contoh: 2000');
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
      'Bot akan coba ambil key server otomatis dari database key tersimpan.',
      '',
      'Preview IP aktif:',
      preview,
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action('m_admin_unlock_sc_access', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_unlock_sc_ip' });
  await ctx.reply(
    uiBox('BUKA KUNCI AKSES SC VPS', [
      'Masukkan IP VPS yang ingin dibuka kunci akses menunya.',
      'Contoh: 103.10.10.2',
      'Bot akan gunakan key tersimpan otomatis.',
      'Ketik "batal" untuk membatalkan.'
    ])
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

bot.action('m_admin_reseller_enable', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_reseller_enable_user' });
  return ctx.reply('Masukkan Telegram User ID yang akan dijadikan reseller.');
});

bot.action('m_admin_reseller_disable', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_reseller_disable_user' });
  return ctx.reply('Masukkan Telegram User ID yang akan dinonaktifkan reseller.');
});

bot.action('m_admin_set_reseller_wa', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_set_reseller_wa' });
  return ctx.reply('Masukkan nomor WA admin reseller. Contoh: 089612745096 atau 6289612745096');
});

bot.action('m_admin_set_sc_features_info', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_set_sc_features_info' });
  return ctx.reply(
    'Kirim isi "Info Fitur SC" versi terbaru.\n' +
      'Boleh multi-baris langsung.\n' +
      'Ketik "batal" untuk membatalkan.'
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
      `${getSettingLabel('SC_RESELLER_PRICE_PER_DAY')} : Rp ${Number(snap.SC_RESELLER_PRICE_PER_DAY || 0).toLocaleString('id-ID')}`,
      `${getSettingLabel('SC_UNLIMITED_PRICE')} : Rp ${Number(snap.SC_UNLIMITED_PRICE || 0).toLocaleString('id-ID')}`,
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

bot.action(/m_admin_list_ip_keys_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  const page = Math.max(0, Number(ctx.match?.[1] || 0));
  const pageSize = 10;
  const total = await countServerKeysForAdmin().catch(() => 0);
  if (total <= 0) {
    return ctx.reply('Belum ada data IP+KEY tersimpan.', adminMenu());
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const rows = await listServerKeysForAdminPage(safePage, pageSize).catch(() => []);
  const startNo = safePage * pageSize;
  const lines = rows.map((r, i) => {
    const no = startNo + i + 1;
    const uid = Number(r?.user_id || 0);
    const ip = normalizeHost(r?.vps_ip || '-');
    const key = String(r?.server_key || '').trim() || '-';
    const at = formatDateTime(r?.updated_at);
    return `${no}. id=${uid} | ip=${ip}\nkey=${key}\nupdated=${at}`;
  });
  const text = uiBox(`DAFTAR IP+KEY+ID (PAGE ${safePage + 1}/${totalPages})`, [
    `Total data: ${total}`,
    '',
    ...(lines.length ? lines : ['(kosong)'])
  ]);
  return ctx.reply(text, adminIpKeyListKeyboard(safePage, totalPages));
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

bot.action('m_admin_upload_summary_api', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_upload_summary_api_script' });
  await ctx.reply(
    'Upload file update Summary API (.sh) sebagai document.\n' +
      'File akan disimpan lokal di VPS bot ini sebagai sumber installer Summary API.'
  );
});

bot.action('m_cek_saldo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const saldo = await getSaldo(ctx.from.id).catch(() => 0);
  await ctx.reply(`Saldo kamu: Rp ${Number(saldo).toLocaleString('id-ID')}`, mainMenu());
});

bot.action('m_sc_features', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const info = await getScFeaturesInfoText();
  await ctx.reply(
    uiBox('FITUR-FITUR SC 1FORCR NEXUS', String(info || '').split('\n')),
    mainMenu()
  );
});

bot.action('m_my_sc', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const regs = await getActiveRegistrations(ctx.from.id).catch(() => []);
  if (regs.length === 0) {
    const latest = await getLatestRegistrationState(ctx.from.id).catch(() => null);
    if (latest) {
      const st = String(latest.status || '').trim().toLowerCase();
      if (st === 'expired') {
        return ctx.reply(
          `SC kamu saat ini expired.\n` +
            `IP terakhir : ${latest.vps_ip || '-'}\n` +
            `Expired     : ${formatDateTime(latest.expires_at)}\n\n` +
            `Silakan perpanjang dari menu "Daftar / Perpanjang SC".`,
          mainMenu()
        );
      }
      if (st === 'deleted_by_admin') {
        return ctx.reply(
          `IP SC kamu telah dihapus admin.\n` +
            `IP terakhir : ${latest.vps_ip || '-'}\n` +
            `Status      : expired by admin\n\n` +
            `Masa aktif sudah direset. Silakan registrasi ulang dari menu "Daftar / Perpanjang SC".`,
          mainMenu()
        );
      }
    }
    return ctx.reply('Belum ada IP SC terdaftar.', mainMenu());
  }
  const lines = regs.map(
    (r, i) =>
      `${i + 1}. ${r.vps_ip}\n   Nama Client : ${normalizeClientName(r.client_name) || '-'}\n   Expired     : ${formatDateTime(r.expires_at)}\n   Status      : ${formatRemainingDays(r.expires_at)}`
  );
  return ctx.reply(`IP SC terdaftar (${regs.length}):\n${lines.join('\n')}`, mainMenu());
});

bot.action('m_check_sc_ip_expiry', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userState.set(ctx.chat.id, { step: 'check_sc_ip_expiry' });
  return ctx.reply(
    uiBox('CEK EXPIRED IP VPS', [
      'Masukkan IP VPS yang ingin dicek.',
      'Contoh: 103.10.10.2',
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action('m_install_link', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await requireRegistered(ctx))) return;
  const installerText = await buildInstallerQuickCopyText();
  if (!installerText.ok) {
    return ctx.reply(
      'Domain API installer belum diset admin.\nHubungi admin agar tambah domain via menu admin.',
      mainMenu()
    );
  }
  return ctx.reply(installerText.text, {
    ...mainMenu(),
    parse_mode: installerText.parse_mode,
    disable_web_page_preview: true
  });
});

bot.action('m_register_sc', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const [{ pricePerDay, isReseller }, unlimitedPrice, minDays, regMenu] = await Promise.all([
    getRegistrationPricePerDayForUser(ctx.from.id),
    getUnlimitedPrice(),
    getRegistrationMinDays(),
    registerScMenu()
  ]);
  await ctx.reply(
    uiBox('REGISTRASI / PERPANJANG SC', [
      'Pilih jenis layanan:',
      '- Registrasi Baru',
      '- Perpanjang SC',
      '- SC Unlimited',
      '',
      `Harga           : Rp ${pricePerDay.toLocaleString('id-ID')} / hari${isReseller ? ' (RESELLER)' : ''}`,
      `Harga Unlimited : Rp ${Number(unlimitedPrice).toLocaleString('id-ID')} sekali bayar`,
      `Minimal Durasi  : ${minDays} hari`,
      '',
      'Perpanjang cukup masukkan IP VPS yang terdaftar.',
      'Tekan tombol di bawah ini.'
    ]),
    regMenu
  );
});

bot.action('m_register_sc_new', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const [{ pricePerDay, isReseller }, minDays] = await Promise.all([getRegistrationPricePerDayForUser(ctx.from.id), getRegistrationMinDays()]);
  userState.set(ctx.chat.id, { step: 'register_sc_client_name' });
  await ctx.reply(
    uiBox('REGISTRASI BARU SC', [
      'Masukkan nama client.',
      'Contoh: Haris Premium 01',
      '',
      `Harga           : Rp ${pricePerDay.toLocaleString('id-ID')} / hari${isReseller ? ' (RESELLER)' : ''}`,
      `Minimal Durasi  : ${minDays} hari`,
      '',
      'Setelah input IP, bot akan minta key server VPS.',
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action('m_register_sc_unlimited', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const unlimitedPrice = await getUnlimitedPrice();
  userState.set(ctx.chat.id, { step: 'register_sc_unlimited_client_name' });
  await ctx.reply(
    uiBox('REGISTRASI SC UNLIMITED', [
      'Masukkan nama client.',
      'Contoh: Haris Unlimited 01',
      '',
      `Harga paket     : Rp ${Number(unlimitedPrice).toLocaleString('id-ID')}`,
      'Masa aktif      : tanpa batas',
      '',
      'Setelah input IP, bot akan minta key server VPS.',
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
      'Setelah itu bot akan minta key server VPS.',
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action('m_admin_sc_unlimited', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_sc_unlimited_user_id' });
  return ctx.reply(
    uiBox('ADMIN DAFTAR SC UNLIMITED', [
      'Masukkan Telegram User ID target.',
      'Contoh: 123456789',
      '',
      'Paket ini manual oleh admin, tanpa potong saldo.',
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
  const minTopup = await getEffectiveTopupMin();
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

  const provider = String(row.gateway_provider || 'gopay').toLowerCase();
  if (provider !== 'gopay') {
    const check = await checkOrderKuotaPaidByAmount(Number(row.amount || 0)).catch((e) => ({ err: e }));
    if (check && check.err) return ctx.reply(`Gagal cek status: ${String(check.err?.message || check.err)}`);
    if (check && check.amounts instanceof Set) {
      await syncOrderKuotaAmountLocks(check.amounts).catch(() => {});
    }
    if (check && check.paid === true) {
      await lockOrderKuotaAmount(Number(row.amount || 0)).catch(() => {});
      const credited = await markPendingPaid(row);
      const saldoNow = await getSaldo(ctx.from.id).catch(() => 0);
      if (credited) {
        await notifyAdminsTopupSuccess(row).catch(() => {});
        return ctx.reply(`Top Up Saldo berhasil. Saldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}`, mainMenu());
      }
      return ctx.reply('Top Up Saldo sudah diproses sebelumnya.');
    }
    return ctx.reply('Top Up Saldo masih menunggu. Status gateway: pending');
  }
  const st = await checkGoPayStatus(String(row.provider_tx_id || '')).catch((e) => ({ error: e.message }));
  if (st?.error) return ctx.reply(`Gagal cek status: ${st.error}`);
  if (st.settled) {
    const credited = await markPendingPaid(row);
    const saldoNow = await getSaldo(ctx.from.id).catch(() => 0);
    if (credited) {
      await notifyAdminsTopupSuccess(row).catch(() => {});
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

bot.action('m_delete_all_accounts', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await requireRegistered(ctx))) return;
  userState.set(ctx.chat.id, { step: 'delete_all_host' });
  await ctx.reply(
    uiBox('HAPUS SEMUA AKUN', [
      'Masukkan IP VPS target.',
      'Aksi ini menghapus semua akun berdasarkan protokol yang nanti dipilih.',
      'Contoh: 103.10.10.2',
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action(/m_delall_proto_(all|ssh|vmess|vless|trojan)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = userState.get(ctx.chat.id);
  if (!state || state.step !== 'delete_all_choose_protocol') {
    return ctx.reply('Sesi hapus akun tidak aktif. Ulangi dari menu.', mainMenu());
  }
  const protocol = String(ctx.match?.[1] || '').toLowerCase();
  state.protocol = protocol;
  state.step = 'delete_all_confirm';
  userState.set(ctx.chat.id, state);
  return ctx.reply(
    uiBox('KONFIRMASI HAPUS SEMUA AKUN', [
      `Host      : ${state.host}`,
      `Protokol  : ${protocol === 'all' ? 'SEMUA PROTOKOL' : protocolLabel(protocol)}`,
      '',
      'Lanjutkan hapus semua akun?'
    ]),
    Markup.inlineKeyboard([
      [Markup.button.callback('Ya, Hapus', 'm_delall_confirm_yes')],
      [Markup.button.callback('Batal', 'm_delall_confirm_no')]
    ])
  );
});

bot.action('m_delall_confirm_no', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userState.delete(ctx.chat.id);
  return ctx.reply('Hapus semua akun dibatalkan.', mainMenu());
});

bot.action('m_delall_confirm_yes', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = userState.get(ctx.chat.id);
  if (!state || state.step !== 'delete_all_confirm') {
    return ctx.reply('Sesi hapus akun tidak aktif. Ulangi dari menu.', mainMenu());
  }
  try {
    await ctx.reply('Menghapus akun, tunggu...');
    const type = String(state.protocol || '').toLowerCase();
    let summaryText = '';
    let xrayReloadLine = '';
    let needXrayRestart = false;
    if (type === 'all') {
      const allStats = await deleteAllProtocols(state.host, state.key);
      const lines = ['Rincian hasil:'];
      for (const t of ['ssh', 'vmess', 'vless', 'trojan']) {
        const st = allStats[t] || { exported: 0, deleted: 0 };
        lines.push(`- ${protocolLabel(t)}: data ${st.exported}, terhapus ${st.deleted}`);
      }
      summaryText = lines.join('\n');
    } else {
      const stats = await deleteAllByProtocol(state.host, state.key, type);
      summaryText =
        `Rincian hasil:\n` +
        `- ${protocolLabel(type)}: data ${stats.exported}, terhapus ${stats.deleted}`;
    }
    if (type === 'all') {
      const syncLines = [];
      for (const t of ['vmess', 'vless', 'trojan']) {
        try {
          const r = await apiPost(state.host, state.key, '/internal/sync-xray-from-db', { type: t, restart: false });
          needXrayRestart = true;
          syncLines.push(`- ${t.toUpperCase()}: OK (${Number(r?.synced_clients || 0)} client)`);
        } catch (syncErr) {
          syncLines.push(`- ${t.toUpperCase()}: gagal (${parseErr(syncErr)})`);
        }
      }
      xrayReloadLine = `\nXRAY sync:\n${syncLines.join('\n')}`;
    } else if (['vmess', 'vless', 'trojan'].includes(type)) {
      try {
        const r = await apiPost(state.host, state.key, '/internal/sync-xray-from-db', { type, restart: false });
        needXrayRestart = true;
        xrayReloadLine = `\nXRAY sync: OK (${type.toUpperCase()} ${Number(r?.synced_clients || 0)} client)`;
      } catch (syncErr) {
        xrayReloadLine = `\nXRAY sync: gagal (${parseErr(syncErr)})`;
      }
    }
    if (needXrayRestart) {
      try {
        await applyXrayRestart(state.host, state.key);
        xrayReloadLine += '\nXRAY restart: OK (single-restart batch)';
      } catch (restartErr) {
        xrayReloadLine += `\nXRAY restart: gagal (${parseErr(restartErr)})`;
      }
    }
    await dbRun("UPDATE sc_registrations SET last_used_at = ?, updated_at = ? WHERE user_id = ? AND vps_ip = ? AND status = 'active'", [Date.now(), Date.now(), ctx.from.id, state.host]).catch(() => {});
    userState.delete(ctx.chat.id);
    return ctx.reply(
      `Hapus semua akun selesai.\n` +
        `Host: ${state.host}\n` +
        `Protokol: ${type === 'all' ? 'SEMUA PROTOKOL' : protocolLabel(type)}\n` +
        `${summaryText}${xrayReloadLine}`,
      mainMenu()
    );
  } catch (err) {
    userState.delete(ctx.chat.id);
    return ctx.reply(`Gagal hapus semua akun: ${parseErr(err)}`, mainMenu());
  }
});

bot.action('m_migrate_accounts', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await requireRegistered(ctx))) return;
  userState.set(ctx.chat.id, { step: 'migrate_src_host' });
  await ctx.reply(
    uiBox('MIGRASI AKUN', [
      'Masukkan IP VPS sumber data akun.',
      'Contoh: 103.10.10.2',
      '',
      'Ketik "batal" untuk membatalkan.'
    ])
  );
});

bot.action(/m_migrate_proto_(all|ssh|vmess|vless|trojan)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = userState.get(ctx.chat.id);
  if (!state || state.step !== 'migrate_choose_protocol') {
    return ctx.reply('Sesi migrasi tidak aktif. Ulangi dari menu.', mainMenu());
  }
  const protocol = String(ctx.match?.[1] || '').toLowerCase();
  state.protocol = protocol;
  state.step = 'migrate_confirm';
  userState.set(ctx.chat.id, state);
  return ctx.reply(
    uiBox('KONFIRMASI MIGRASI AKUN', [
      `Sumber    : ${state.srcHost}`,
      `Tujuan    : ${state.dstHost}`,
      `Protokol  : ${protocol === 'all' ? 'SEMUA PROTOKOL' : protocolLabel(protocol)}`,
      '',
      'Lanjutkan migrasi akun?'
    ]),
    Markup.inlineKeyboard([
      [Markup.button.callback('Ya, Migrasi', 'm_migrate_confirm_yes')],
      [Markup.button.callback('Batal', 'm_migrate_confirm_no')]
    ])
  );
});

bot.action('m_migrate_confirm_no', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userState.delete(ctx.chat.id);
  return ctx.reply('Migrasi dibatalkan.', mainMenu());
});

bot.action('m_migrate_confirm_yes', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = userState.get(ctx.chat.id);
  if (!state || state.step !== 'migrate_confirm') {
    return ctx.reply('Sesi migrasi tidak aktif. Ulangi dari menu.', mainMenu());
  }

  try {
    await ctx.reply('Migrasi akun berjalan, tunggu...');
    const type = String(state.protocol || '').toLowerCase();
    const migrateTypes = type === 'all' ? ['ssh', 'vmess', 'vless', 'trojan'] : [type];
    const lines = [
      'Migrasi selesai.',
      `Sumber: ${state.srcHost}`,
      `Tujuan: ${state.dstHost}`,
      `Protokol: ${type === 'all' ? 'SEMUA PROTOKOL' : protocolLabel(type)}`
    ];

    let totalFound = 0;
    let totalImported = 0;
    let totalSkipped = 0;
    let migratedAny = false;
    let xrayTouched = false;

    for (const t of migrateTypes) {
      const exported = await apiGet(state.srcHost, state.srcKey, '/internal/export-accounts', { type: t, limit: 50000 });
      const srcAccounts = Array.isArray(exported?.accounts) ? exported.accounts : [];
      const accounts = srcAccounts
        .map((row) => normalizeAccountForImport(t, row, { forceActive: true, ensureNotExpired: true }))
        .filter((row) => String(row?.username || '').trim().length > 0);

      if (accounts.length === 0) {
        lines.push(`- ${protocolLabel(t)}: sumber 0 (skip)`);
        continue;
      }

      migratedAny = true;
      totalFound += accounts.length;
      const imported = await apiPost(state.dstHost, state.dstKey, '/internal/import-accounts', { type: t, accounts });
      const importedN = Number(imported?.imported || 0);
      const skippedN = Number(imported?.skipped || 0);
      totalImported += importedN;
      totalSkipped += skippedN;
      lines.push(`- ${protocolLabel(t)}: sumber ${accounts.length}, imported ${importedN}, skipped ${skippedN}`);

      if (['vmess', 'vless', 'trojan'].includes(t)) {
        const sampleUser = String(accounts[0]?.username || '').trim();
        try {
          await rebuildXrayFromType(state.dstHost, state.dstKey, t, sampleUser);
          xrayTouched = true;
          lines.push(`  XRAY sync ${t.toUpperCase()}: OK`);
        } catch (reloadErr) {
          lines.push(`  XRAY sync ${t.toUpperCase()}: gagal (${parseRenewErr(reloadErr)})`);
        }
      }
    }

    if (!migratedAny) {
      userState.delete(ctx.chat.id);
      return ctx.reply(
        `${lines.join('\n')}\nTidak ada akun yang bisa dipindahkan.`,
        mainMenu()
      );
    }

    lines.push(`Total sumber: ${totalFound}`);
    lines.push(`Total imported: ${totalImported}`);
    lines.push(`Total skipped: ${totalSkipped}`);
    if (xrayTouched) {
      try {
        await applyXrayRestart(state.dstHost, state.dstKey);
        lines.push('XRAY restart: OK (single-restart batch)');
      } catch (restartErr) {
        lines.push(`XRAY restart: gagal (${parseErr(restartErr)})`);
      }
    }

    await dbRun("UPDATE sc_registrations SET last_used_at = ?, updated_at = ? WHERE user_id = ? AND vps_ip IN (?, ?) AND status = 'active'", [Date.now(), Date.now(), ctx.from.id, state.srcHost, state.dstHost]).catch(() => {});
    userState.delete(ctx.chat.id);
    return ctx.reply(lines.join('\n'), mainMenu());
  } catch (err) {
    userState.delete(ctx.chat.id);
    return ctx.reply(`Gagal migrasi: ${parseErr(err)}`, mainMenu());
  }
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

    if (state.step === 'admin_reseller_enable_user') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const targetUserId = Number(String(text || '').replace(/[^0-9]/g, ''));
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) return ctx.reply('User ID tidak valid. Contoh: 123456789');
      await setResellerUser(targetUserId, true);
      const cfg = await getRegistrationPricePerDayForUser(targetUserId);
      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Reseller AKTIF untuk user ${targetUserId}.\nHarga SC per hari user ini: Rp ${Number(cfg.pricePerDay || 0).toLocaleString('id-ID')}`,
        adminMenu()
      );
    }

    if (state.step === 'admin_reseller_disable_user') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const targetUserId = Number(String(text || '').replace(/[^0-9]/g, ''));
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) return ctx.reply('User ID tidak valid. Contoh: 123456789');
      await setResellerUser(targetUserId, false);
      const normalPrice = await getRegistrationPricePerDay();
      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Reseller NONAKTIF untuk user ${targetUserId}.\nHarga SC per hari kembali normal: Rp ${Number(normalPrice || 0).toLocaleString('id-ID')}`,
        adminMenu()
      );
    }

    if (state.step === 'admin_set_reseller_wa') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const wa = normalizeWaNumber(text);
      if (!wa || wa.length < 9) return ctx.reply('Nomor WA tidak valid.');
      await setDynamicSetting('RESELLER_ADMIN_WA', wa, ctx.from.id);
      userState.delete(ctx.chat.id);
      return ctx.reply(`Nomor WA admin reseller disimpan: ${wa}`, adminMenu());
    }

    if (state.step === 'admin_set_sc_features_info') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const payload = String(text || '').trim();
      if (payload.length < 10) return ctx.reply('Isi fitur terlalu pendek.');
      await setDynamicSetting('SC_FEATURES_INFO_TEXT', payload, ctx.from.id);
      userState.delete(ctx.chat.id);
      return ctx.reply('Info fitur SC berhasil diperbarui.', adminMenu());
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
      } else if (key === 'SC_RESELLER_PRICE_PER_DAY') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return ctx.reply('Harus angka >= 0.');
        value = String(Math.floor(n));
      } else if (key === 'SC_UNLIMITED_PRICE') {
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
      } else if (key === 'TOPUP_SUCCESS_NOTIFY_ENABLE') {
        const s = value.toLowerCase();
        if (!['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(s)) {
          return ctx.reply('Isi 1/0 (atau true/false).');
        }
        value = parseBool01(s, true) ? '1' : '0';
      } else if (key === 'TOPUP_SUCCESS_NOTIFY_ADMIN_IDS') {
        const ids = String(value || '')
          .split(',')
          .map((v) => Number(String(v || '').trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (!ids.length) return ctx.reply('Isi minimal 1 Telegram ID admin. Contoh: 12345,67890');
        value = ids.join(',');
      } else if (key === 'RESELLER_ADMIN_WA') {
        const wa = normalizeWaNumber(value);
        if (!wa || wa.length < 9) return ctx.reply('Nomor WA tidak valid.');
        value = wa;
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

    if (state.step === 'pg_set_orderkuota_url') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const normalized = normalizeHttpUrl(text);
      if (!normalized) return ctx.reply('URL tidak valid.');
      const v = loadVars();
      v.PAYMENT_GATEWAY_BASE_URL = normalized;
      saveVars(v);
      userState.delete(ctx.chat.id);
      return ctx.reply(`Gateway URL OrderKuota disimpan:\n${normalized}`, adminPaymentGatewayOrderKuotaMenu());
    }

    if (state.step === 'pg_set_orderkuota_api_key') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      if (text.length < 6) return ctx.reply('API Key terlalu pendek.');
      const v = loadVars();
      v.RAJASERVER_API_KEY = text;
      saveVars(v);
      userState.delete(ctx.chat.id);
      return ctx.reply('RAJASERVER_API_KEY berhasil disimpan.', adminPaymentGatewayOrderKuotaMenu());
    }

    if (state.step === 'pg_set_orderkuota_qris') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      if (text.length < 8) return ctx.reply('DATA_QRIS terlalu pendek.');
      const v = loadVars();
      v.DATA_QRIS = text;
      saveVars(v);
      userState.delete(ctx.chat.id);
      return ctx.reply('DATA_QRIS berhasil disimpan.', adminPaymentGatewayOrderKuotaMenu());
    }

    if (state.step === 'pg_set_orderkuota_min_topup') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const amount = Number(String(text).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(amount) || amount < 1000) return ctx.reply('Minimal topup harus angka, minimal 1000.');
      const v = loadVars();
      v.ORDERKUOTA_MIN_TOPUP = Math.floor(amount);
      saveVars(v);
      userState.delete(ctx.chat.id);
      return ctx.reply(`Minimal TopUp OrderKuota disimpan: Rp ${Math.floor(amount).toLocaleString('id-ID')}`, adminPaymentGatewayOrderKuotaMenu());
    }

    if (state.step === 'pg_set_orkut_username') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      if (text.length < 3) return ctx.reply('ORKUT_USERNAME terlalu pendek.');
      const v = loadVars();
      v.ORKUT_USERNAME = text;
      saveVars(v);
      userState.delete(ctx.chat.id);
      return ctx.reply('ORKUT_USERNAME berhasil disimpan.', adminPaymentGatewayOrderKuotaMenu());
    }

    if (state.step === 'pg_set_orkut_token') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      if (text.length < 8) return ctx.reply('ORKUT_TOKEN terlalu pendek.');
      const v = loadVars();
      v.ORKUT_TOKEN = text;
      saveVars(v);
      userState.delete(ctx.chat.id);
      return ctx.reply('ORKUT_TOKEN berhasil disimpan.', adminPaymentGatewayOrderKuotaMenu());
    }

    if (state.step === 'pg_set_gopay_base_url') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const normalized = normalizeHttpUrl(text);
      if (!normalized) return ctx.reply('URL GoPay tidak valid.');
      const v = loadVars();
      v.GOPAY_API_BASE_URL = normalized;
      saveVars(v);
      userState.delete(ctx.chat.id);
      return ctx.reply(`GoPay API Base URL disimpan:\n${normalized}`, adminPaymentGatewayGoPayMenu());
    }

    if (state.step === 'pg_set_gopay_api_key') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      if (text.length < 8) return ctx.reply('GoPay API key terlalu pendek.');
      const v = loadVars();
      v.GOPAY_API_KEY = text;
      saveVars(v);
      userState.delete(ctx.chat.id);
      return ctx.reply('GoPay API Key berhasil disimpan.', adminPaymentGatewayGoPayMenu());
    }

    if (state.step === 'pg_set_gopay_min_topup') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const amount = Number(String(text).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(amount) || amount < 1000) return ctx.reply('Minimal topup harus angka, minimal 1000.');
      const v = loadVars();
      v.GOPAY_MIN_TOPUP = Math.floor(amount);
      saveVars(v);
      userState.delete(ctx.chat.id);
      return ctx.reply(`Minimal TopUp GoPay disimpan: Rp ${Math.floor(amount).toLocaleString('id-ID')}`, adminPaymentGatewayGoPayMenu());
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
      const key = await getServerKeyForHost(ctx.from.id, ip);
      const result = await adminRemoveRegisteredIp(ip, ctx.from.id);
      if (!result.removed) {
        userState.delete(ctx.chat.id);
        return ctx.reply(`IP ${ip} tidak ditemukan pada registrasi aktif.`, adminMenu());
      }

      let lockMsg = 'Lock menu VPS: skip (key belum tersimpan)';
      if (String(key || '').trim().length >= 8) {
        try {
          const lockResp = await lockScAccessByHost(ip, key, ctx.from.id, 'admin_remove_sc_ip');
          const blocked = lockResp?.blocked === true;
          lockMsg = blocked ? 'Lock menu VPS: berhasil' : 'Lock menu VPS: gagal';
        } catch (lockErr) {
          lockMsg = `Lock menu VPS: gagal (${parseErr(lockErr)})`;
        }
      }

      const users = Array.isArray(result.affectedUsers) ? result.affectedUsers : [];
      const userNotify = await notifyExpiredUsersInBot(ctx, users, ip, 'admin_remove_sc_ip').catch(() => ({ total: users.length, ok: 0, fail: users.length }));

      let vpsNotifyMsg = 'Notif bot VPS: skip (key belum tersimpan)';
      if (String(key || '').trim().length >= 8) {
        try {
          await syncScRegistrationMetaToHost(ip, key, {
            status: 'expired',
            client_name: '-',
            expires_at: Date.now()
          }).catch(() => {});
          await notifyScExpiredOnHost(ip, key, {
            ip,
            reason: 'admin_remove_sc_ip',
            actor: String(ctx.from.id || ''),
            users: users.map((u) => String(u))
          });
          vpsNotifyMsg = 'Notif bot VPS: berhasil';
        } catch (notifyErr) {
          vpsNotifyMsg = `Notif bot VPS: gagal (${parseErr(notifyErr)})`;
        }
      }

      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Berhasil hapus registrasi aktif untuk IP ${ip}.\n` +
          `Baris IP cocok: ${result.removed}\n` +
          `Total baris aktif yang di-expire: ${Number(result.removedRowsAllIps || 0)}\n` +
          `User terdampak: ${users.length ? users.join(', ') : '-'}\n` +
          `${lockMsg}\n` +
          `Notif user Bot SC: ${userNotify.ok}/${userNotify.total} terkirim\n` +
          `${vpsNotifyMsg}\n` +
          `Efek: SC client expired + menu VPS terkunci (jika lock berhasil).`,
        adminMenu()
      );
    }

    if (state.step === 'admin_unlock_sc_ip') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const ip = normalizeHost(text);
      if (!isIpv4(ip)) {
        return ctx.reply('Format IP tidak valid. Contoh: 103.10.10.2');
      }
      const key = await getServerKeyForHost(ctx.from.id, ip);
      if (String(key || '').trim().length < 8) {
        userState.delete(ctx.chat.id);
        return ctx.reply(
          `Gagal unlock akses SC VPS untuk ${ip}: key server belum tersimpan.\n` +
            'Simpan dulu key lewat fitur yang meminta key (backup/restore/migrasi).',
          adminMenu()
        );
      }
      try {
        const unlockResp = await apiPost(ip, key, '/internal/sc-access-lock', {
          blocked: false,
          reason: 'admin_unlock_sc_access',
          actor: String(ctx.from.id || '')
        });
        userState.delete(ctx.chat.id);
        return ctx.reply(
          `Unlock akses SC VPS berhasil.\n` +
            `IP: ${ip}\n` +
            `Blocked: ${unlockResp?.blocked === true ? 'yes' : 'no'}`,
          adminMenu()
        );
      } catch (unlockErr) {
        userState.delete(ctx.chat.id);
        return ctx.reply(`Gagal unlock akses SC VPS: ${parseErr(unlockErr)}`, adminMenu());
      }
    }

    if (state.step === 'check_sc_ip_expiry') {
      const ip = normalizeHost(text);
      if (!isIpv4(ip)) {
        return ctx.reply('Format IP tidak valid. Contoh: 103.10.10.2');
      }
      const row = await getRegistrationStateByIp(ctx.from.id, ip, isAdmin(ctx.from.id));
      userState.delete(ctx.chat.id);
      if (!row) {
        return ctx.reply(`IP ${ip} tidak ditemukan pada data SC kamu.`, mainMenu());
      }

      const st = String(row.status || '').trim().toLowerCase() || '-';
      const exp = Number(row.expires_at || 0);
      const statusText = st === 'active' ? formatRemainingDays(exp) : (st === 'deleted_by_admin' ? 'Expired by admin' : 'Expired');
      return ctx.reply(
        uiBox('STATUS IP VPS', [
          `IP          : ${normalizeHost(row.vps_ip || ip)}`,
          `Client Name : ${normalizeClientName(row.client_name) || '-'}`,
          `Status DB   : ${st}`,
          `Expired At  : ${formatDateTime(row.expires_at)}`,
          `Sisa Aktif  : ${statusText}`
        ]),
        mainMenu()
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

    if (state.step === 'register_sc_unlimited_client_name') {
      const clientName = normalizeClientName(text);
      if (!clientName || clientName.length < 2) {
        return ctx.reply(
          uiBox('INPUT NAMA CLIENT', [
            'Nama client minimal 2 karakter.',
            'Contoh: Haris Unlimited 01'
          ])
        );
      }
      state.step = 'register_sc_unlimited_ip';
      state.clientName = clientName;
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('LANJUT REGISTRASI UNLIMITED', [
          `Nama Client : ${clientName}`,
          '',
          'Masukkan IP VPS yang ingin didaftarkan.',
          'Contoh: 103.10.10.2'
        ])
      );
    }

    if (state.step === 'register_sc_unlimited_ip') {
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
      state.step = 'register_sc_unlimited_key';
      state.ip = ip;
      state.clientName = normalizeClientName(state.clientName || ctx.from.first_name || ip) || ip;
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('INPUT KEY UNTUK SERVER VPS', [
          `Nama Client : ${state.clientName}`,
          `IP VPS      : ${ip}`,
          '',
          'Masukkan key server VPS.',
          '',
          'Contoh key: abcdefgh12345678'
        ])
      );
    }

    if (state.step === 'register_sc_unlimited_key') {
      const ip = String(state.ip || '').trim();
      if (!isIpv4(ip)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('State registrasi unlimited tidak valid. Ulangi dari menu registrasi.', mainMenu());
      }
      const serverKey = String(text || '').trim();
      if (serverKey.length < 8) {
        return ctx.reply('Key server tidak valid. Minimal 8 karakter.');
      }

      const unlimitedPrice = await getUnlimitedPrice();
      const clientName = normalizeClientName(state.clientName || ctx.from.first_name || ip) || ip;
      const result = await registerScIpUnlimited(ctx.from.id, ip, clientName, {
        chargeSaldo: true,
        totalFee: unlimitedPrice,
        txType: 'sc_registration_unlimited',
        txRef: `sc_unl_${ctx.from.id}_${ip}_${Date.now()}`
      });
      if (result.insufficient) {
        const saldo = await getSaldo(ctx.from.id);
        userState.delete(ctx.chat.id);
        return ctx.reply(
          `Saldo tidak cukup untuk SC Unlimited.\n` +
            `Nama Client: ${clientName}\n` +
            `IP: ${ip}\n` +
            `Total biaya: Rp ${Number(unlimitedPrice).toLocaleString('id-ID')}\n` +
            `Saldo kamu: Rp ${Number(saldo).toLocaleString('id-ID')}\n\n` +
            'Silakan top up dulu via menu "Top Up Saldo".',
          mainMenu()
        );
      }

      const saldoNow = await getSaldo(ctx.from.id);
      const installerText = await buildInstallerQuickCopyText();
      userState.delete(ctx.chat.id);
      await ctx.reply(
        `Registrasi SC Unlimited berhasil.\n` +
          `Nama Client: ${result.clientName || clientName}\n` +
          `IP: ${ip}\n` +
          `Biaya potong saldo: Rp ${Number(unlimitedPrice).toLocaleString('id-ID')}\n` +
          `Expired: tanpa batas\n` +
          `Saldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}`,
        mainMenu()
      );
      await saveServerKeyForHost(ctx.from.id, ip, serverKey);
      await saveServerKeyForHostAllOwners(ip, serverKey, ctx.from.id);
      await syncKnownServerKeyAfterScRegistration(ctx.from.id, ip).catch(() => {});
      await syncScRegistrationMetaToHost(ip, serverKey, {
        status: 'active',
        client_name: result.clientName || clientName,
        expires_at: 0
      }).catch(() => {});
      if (installerText.ok) {
        await ctx.reply(installerText.text, {
          parse_mode: installerText.parse_mode,
          disable_web_page_preview: true
        });
      } else {
        await ctx.reply(installerText.text);
      }
      return;
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
      const [{ pricePerDay }, minDays, reg] = await Promise.all([
        getRegistrationPricePerDayForUser(ctx.from.id),
        getRegistrationMinDays(),
        getUserRegistration(ctx.from.id, ip)
      ]);
      state.step = 'register_sc_key';
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
          'Masukkan key server VPS terlebih dahulu.',
          '',
          'Contoh key: abcdefgh12345678'
        ])
      );
    }

    if (state.step === 'register_sc_key') {
      const ip = String(state.ip || '').trim();
      if (!isIpv4(ip)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('State registrasi tidak valid. Ulangi dari menu registrasi.', mainMenu());
      }
      const serverKey = String(text || '').trim();
      if (serverKey.length < 8) {
        return ctx.reply('Key server tidak valid. Minimal 8 karakter.');
      }
      const [{ pricePerDay }, minDays] = await Promise.all([getRegistrationPricePerDayForUser(ctx.from.id), getRegistrationMinDays()]);
      state.serverKey = serverKey;
      state.step = 'register_sc_days';
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('INPUT DURASI REGISTRASI SC', [
          `Nama Client   : ${state.clientName || ip}`,
          `IP VPS        : ${ip}`,
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
      const [{ pricePerDay }, minDays] = await Promise.all([getRegistrationPricePerDayForUser(ctx.from.id), getRegistrationMinDays()]);
      const days = Number(String(text).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(days) || days < minDays) {
        return ctx.reply(`Jumlah hari tidak valid. Minimal ${minDays} hari.`);
      }
      const totalFee = Math.floor(days) * pricePerDay;
      const clientName = normalizeClientName(state.clientName || ip) || ip;
      const serverKey = String(state.serverKey || '').trim();
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
      let unlockResult = { attempted: false, ok: false, message: '' };
      if (result.reactivatedFromExpired) {
        unlockResult = await tryAutoUnlockAfterRenew(ctx.from.id, ip, 'renew_after_natural_expired');
      }
      userState.delete(ctx.chat.id);
      await ctx.reply(
        `Registrasi/perpanjang SC berhasil.\n` +
          `Nama Client: ${result.clientName || clientName}\n` +
          `IP: ${ip}\n` +
          `Durasi: ${Math.floor(days)} hari\n` +
          `Biaya potong saldo: Rp ${totalFee.toLocaleString('id-ID')}\n` +
          `Expired baru: ${formatDateTime(result.expiresAt)}\n` +
          `Saldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}` +
          `${result.reactivatedFromExpired
            ? `\nUnlock menu VPS otomatis: ${unlockResult.ok ? 'berhasil' : `gagal (${unlockResult.message || 'unknown'})`}`
            : ''}`,
        mainMenu()
      );
      if (serverKey.length >= 8) {
        await saveServerKeyForHost(ctx.from.id, ip, serverKey);
        await saveServerKeyForHostAllOwners(ip, serverKey, ctx.from.id);
      }
      await syncKnownServerKeyAfterScRegistration(ctx.from.id, ip).catch(() => {});
      const hostKeyReg = serverKey.length >= 8 ? serverKey : await getServerKeyForHost(ctx.from.id, ip);
      await syncScRegistrationMetaToHost(ip, hostKeyReg, {
        status: 'active',
        client_name: result.clientName || clientName,
        expires_at: Number(result.expiresAt || 0)
      }).catch(() => {});
      if (installerText.ok) {
        await ctx.reply(installerText.text, {
          parse_mode: installerText.parse_mode,
          disable_web_page_preview: true
        });
      } else {
        await ctx.reply(installerText.text);
      }
      return;
    }

    if (state.step === 'admin_sc_unlimited_user_id') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const targetUserId = Number(String(text || '').replace(/[^0-9]/g, ''));
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return ctx.reply('User ID tidak valid. Contoh: 123456789');
      }
      state.targetUserId = targetUserId;
      state.step = 'admin_sc_unlimited_client_name';
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        `Target user ID: ${targetUserId}\n` +
          'Masukkan nama client SC unlimited.\n' +
          'Contoh: User Premium Unlimited'
      );
    }

    if (state.step === 'admin_sc_unlimited_client_name') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const clientName = normalizeClientName(text);
      if (!clientName || clientName.length < 2) {
        return ctx.reply('Nama client minimal 2 karakter.');
      }
      state.clientName = clientName;
      state.step = 'admin_sc_unlimited_ip';
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        `Nama client: ${clientName}\n` +
          'Masukkan IP VPS target.\n' +
          'Contoh: 103.10.10.2'
      );
    }

    if (state.step === 'admin_sc_unlimited_ip') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const ip = normalizeHost(text);
      if (!isIpv4(ip)) {
        return ctx.reply('Format IP tidak valid. Contoh: 103.10.10.2');
      }
      const targetUserId = Number(state.targetUserId || 0);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        userState.delete(ctx.chat.id);
        return ctx.reply('State target user tidak valid. Ulangi dari menu admin.', adminMenu());
      }
      if (await isIpOwnedByOther(ip, targetUserId)) {
        userState.delete(ctx.chat.id);
        return ctx.reply(`IP ${ip} sudah terdaftar oleh user lain.`, adminMenu());
      }
      const clientName = normalizeClientName(state.clientName || ip) || ip;
      const result = await registerScIpUnlimited(targetUserId, ip, clientName, {
        chargeSaldo: false,
        txType: 'sc_registration_unlimited_admin',
        txRef: `sc_unl_admin_${ctx.from.id}_${targetUserId}_${ip}_${Date.now()}`
      });
      userState.delete(ctx.chat.id);
      if (!result.success) {
        return ctx.reply('Gagal daftarkan SC unlimited manual.', adminMenu());
      }
      await syncKnownServerKeyAfterScRegistration(targetUserId, ip).catch(() => {});
      const hostKeyAdminUnl = await getServerKeyForHost(targetUserId, ip);
      await syncScRegistrationMetaToHost(ip, hostKeyAdminUnl, {
        status: 'active',
        client_name: result.clientName || clientName,
        expires_at: 0
      }).catch(() => {});
      return ctx.reply(
        `SC Unlimited manual berhasil didaftarkan.\n` +
          `Target user ID: ${targetUserId}\n` +
          `Nama Client: ${result.clientName || clientName}\n` +
          `IP: ${ip}\n` +
          `Biaya: Rp 0 (manual admin)\n` +
          `Expired: tanpa batas`,
        adminMenu()
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

      const [{ pricePerDay }, minDays, reg, ownedByOther] = await Promise.all([
        getRegistrationPricePerDayForUser(ctx.from.id),
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
      state.step = 'extend_sc_key';
      state.ip = ip;
      state.clientName = clientName;
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('KONFIRMASI PERPANJANGAN SC', [
          `Nama Client   : ${clientName}`,
          `IP VPS        : ${ip}`,
          `Expired Saat Ini : ${formatDateTime(reg.expires_at)}`,
          '',
          'Masukkan key server VPS terlebih dahulu.',
          'Key ini akan disimpan otomatis di database bot.',
          '',
          'Contoh key: abcdefgh12345678'
        ])
      );
    }

    if (state.step === 'extend_sc_key') {
      const ip = String(state.ip || '').trim();
      if (!isIpv4(ip)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('State perpanjangan tidak valid. Ulangi dari menu perpanjang.', mainMenu());
      }
      const serverKey = String(text || '').trim();
      if (serverKey.length < 8) {
        return ctx.reply('Key server tidak valid. Minimal 8 karakter.');
      }
      const [{ pricePerDay }, minDays] = await Promise.all([getRegistrationPricePerDayForUser(ctx.from.id), getRegistrationMinDays()]);
      state.serverKey = serverKey;
      state.step = 'extend_sc_days';
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('INPUT DURASI PERPANJANGAN', [
          `Nama Client   : ${state.clientName || ip}`,
          `IP VPS        : ${ip}`,
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
      const [{ pricePerDay }, minDays] = await Promise.all([getRegistrationPricePerDayForUser(ctx.from.id), getRegistrationMinDays()]);
      const days = Number(String(text).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(days) || days < minDays) {
        return ctx.reply(`Jumlah hari tidak valid. Minimal ${minDays} hari.`);
      }

      const totalFee = Math.floor(days) * pricePerDay;
      const clientName = normalizeClientName(state.clientName || ip) || ip;
      const serverKey = String(state.serverKey || '').trim();
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
      let unlockResult = { attempted: false, ok: false, message: '' };
      if (result.reactivatedFromExpired) {
        unlockResult = await tryAutoUnlockAfterRenew(ctx.from.id, ip, 'renew_after_natural_expired');
      }
      userState.delete(ctx.chat.id);
      await ctx.reply(
        `Perpanjang SC berhasil.\n` +
          `Nama Client: ${result.clientName || clientName}\n` +
          `IP: ${ip}\n` +
          `Durasi tambah: ${Math.floor(days)} hari\n` +
          `Biaya potong saldo: Rp ${totalFee.toLocaleString('id-ID')}\n` +
          `Expired baru: ${formatDateTime(result.expiresAt)}\n` +
          `Saldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}` +
          `${result.reactivatedFromExpired
            ? `\nUnlock menu VPS otomatis: ${unlockResult.ok ? 'berhasil' : `gagal (${unlockResult.message || 'unknown'})`}`
            : ''}`,
        mainMenu()
      );
      if (serverKey.length >= 8) {
        await saveServerKeyForHost(ctx.from.id, ip, serverKey);
        await saveServerKeyForHostAllOwners(ip, serverKey, ctx.from.id);
      }
      await syncKnownServerKeyAfterScRegistration(ctx.from.id, ip).catch(() => {});
      const hostKeyExtend = await getServerKeyForHost(ctx.from.id, ip);
      await syncScRegistrationMetaToHost(ip, hostKeyExtend, {
        status: 'active',
        client_name: result.clientName || clientName,
        expires_at: Number(result.expiresAt || 0)
      }).catch(() => {});
      if (installerText.ok) {
        await ctx.reply(installerText.text, {
          parse_mode: installerText.parse_mode,
          disable_web_page_preview: true
        });
      } else {
        await ctx.reply(installerText.text);
      }
      return;
    }

    if (state.step === 'topup_amount') {
      const minTopup = await getEffectiveTopupMin();
      const topupExpireMs = await getTopupExpireMs();
      const amount = Number(String(text).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(amount) || amount < minTopup) {
        return ctx.reply(`Nominal tidak valid. Minimal Rp ${minTopup.toLocaleString('id-ID')}.`);
      }

      await ctx.reply('Membuat QR Top Up Saldo, tunggu...');
      const code = makeUniqueCode(ctx.from.id);
      const now = Date.now();
      const expires = now + topupExpireMs;
      const ref = `TOPUP_APP3_${ctx.from.id}_${now}`;
      const qr = await createPaymentQrByMode(amount, ref);
      const gatewayProvider = String(qr.provider || 'gopay').toLowerCase();
      const billedAmount = Number(qr.billedAmount || amount || 0);
      const originalAmount = Number(qr.originalAmount || amount || 0);
      const adminFee = Number(qr.adminFee || 0);

      await dbRun(
        `INSERT INTO pending_deposits_app3
         (unique_code, user_id, amount, original_amount, admin_fee, status, provider_tx_id, qr_url, reference_id, created_at, expires_at, gateway_provider)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        [code, ctx.from.id, billedAmount, originalAmount, adminFee, qr.providerTxId, qr.qrUrl, ref, now, expires, gatewayProvider]
      );

      userState.delete(ctx.chat.id);
      const caption =
        `Top Up Saldo dibuat.\n` +
        `Saldo Masuk: Rp ${originalAmount.toLocaleString('id-ID')}\n` +
        `${adminFee > 0 ? `Fee Unik: Rp ${adminFee.toLocaleString('id-ID')}\n` : ''}` +
        `Total Transfer: Rp ${billedAmount.toLocaleString('id-ID')}\n` +
        `Gateway: ${gatewayProvider.toUpperCase()}\n` +
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

    if (state.step === 'delete_all_host') {
      const host = normalizeHost(text);
      if (!isIpv4(host)) return ctx.reply('IP VPS harus valid.');
      if (!(await isRegisteredHost(ctx.from.id, host))) {
        return ctx.reply('IP belum terdaftar di akun kamu. Registrasi dulu di menu Registrasi SC.');
      }
      state.host = host;
      state.step = 'delete_all_key';
      userState.set(ctx.chat.id, state);
      return ctx.reply('Masukkan key server target.');
    }

    if (state.step === 'delete_all_key') {
      const key = String(text || '').trim();
      if (key.length < 8) return ctx.reply('Key tidak valid.');
      state.key = key;
      await saveServerKeyForHost(ctx.from.id, state.host, key);
      state.step = 'delete_all_choose_protocol';
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('PILIH PROTOKOL', [
          `Host: ${state.host}`,
          'Pilih protokol yang ingin dihapus semua akunnya.'
        ]),
        deleteProtocolKeyboard('m_delall_proto', 'm_delall_confirm_no')
      );
    }

    if (state.step === 'migrate_src_host') {
      const srcHost = normalizeHost(text);
      if (!isIpv4(srcHost)) return ctx.reply('IP VPS sumber harus valid.');
      if (!(await isRegisteredHost(ctx.from.id, srcHost))) {
        return ctx.reply('IP sumber belum terdaftar di akun kamu.');
      }
      state.srcHost = srcHost;
      state.step = 'migrate_src_key';
      userState.set(ctx.chat.id, state);
      return ctx.reply('Masukkan key server sumber.');
    }

    if (state.step === 'migrate_src_key') {
      const srcKey = String(text || '').trim();
      if (srcKey.length < 8) return ctx.reply('Key sumber tidak valid.');
      state.srcKey = srcKey;
      await saveServerKeyForHost(ctx.from.id, state.srcHost, srcKey);
      state.step = 'migrate_dst_host';
      userState.set(ctx.chat.id, state);
      return ctx.reply('Masukkan IP VPS tujuan migrasi.');
    }

    if (state.step === 'migrate_dst_host') {
      const dstHost = normalizeHost(text);
      if (!isIpv4(dstHost)) return ctx.reply('IP VPS tujuan harus valid.');
      if (!(await isRegisteredHost(ctx.from.id, dstHost))) {
        return ctx.reply('IP tujuan belum terdaftar di akun kamu.');
      }
      state.dstHost = dstHost;
      state.step = 'migrate_dst_key';
      userState.set(ctx.chat.id, state);
      return ctx.reply('Masukkan key server tujuan.');
    }

    if (state.step === 'migrate_dst_key') {
      const dstKey = String(text || '').trim();
      if (dstKey.length < 8) return ctx.reply('Key tujuan tidak valid.');
      state.dstKey = dstKey;
      await saveServerKeyForHost(ctx.from.id, state.dstHost, dstKey);
      state.step = 'migrate_choose_protocol';
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        uiBox('PILIH PROTOKOL MIGRASI', [
          `Sumber : ${state.srcHost}`,
          `Tujuan : ${state.dstHost}`,
          'Pilih protokol yang ingin dimigrasikan.'
        ]),
        migrateProtocolKeyboard('m_migrate_proto', 'm_migrate_confirm_no')
      );
    }

    if (state.step === 'backup_host') {
      const host = normalizeHost(text);
      if (!isIpv4(host)) return ctx.reply('IP VPS harus valid.');
      if (!(await canAccessHostForScOps(ctx.from.id, host))) {
        return ctx.reply('IP belum terdaftar aktif atau kamu tidak punya akses ke IP ini.');
      }
      state.host = host;
      state.step = 'backup_key';
      userState.set(ctx.chat.id, state);
      return ctx.reply('Masukkan key server sumber.');
    }

    if (state.step === 'backup_key') {
      const key = text;
      if (key.length < 8) return ctx.reply('Key tidak valid.');
      await saveServerKeyForHost(ctx.from.id, state.host, key);

      await ctx.reply('Membuat backup, tunggu...');

      const [ssh, vmess, vless, trojan] = await Promise.all([
        apiGet(state.host, key, '/internal/export-accounts', { type: 'ssh', limit: 50000 }),
        apiGet(state.host, key, '/internal/export-accounts', { type: 'vmess', limit: 50000 }),
        apiGet(state.host, key, '/internal/export-accounts', { type: 'vless', limit: 50000 }),
        apiGet(state.host, key, '/internal/export-accounts', { type: 'trojan', limit: 50000 })
      ]);

      // ZIVPN disatukan dengan SSH: auth source mengikuti akun SSH.
      const sshAccounts = Array.isArray(ssh.accounts) ? ssh.accounts : [];
      const zivpnAuth = Array.from(
        new Set(
          sshAccounts
            .map((r) => String(r?.username || '').trim().toLowerCase())
            .filter(Boolean)
        )
      );

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
          ssh: sshAccounts,
          vmess: Array.isArray(vmess.accounts) ? vmess.accounts : [],
          vless: Array.isArray(vless.accounts) ? vless.accounts : [],
          trojan: Array.isArray(trojan.accounts) ? trojan.accounts : [],
          zivpn_auth: zivpnAuth,
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
        { caption: `Backup selesai.\nIP VPS: ${state.host}\nSSH/ZIVPN: ${backupPayload.data.ssh.length}, VMESS: ${backupPayload.data.vmess.length}, VLESS: ${backupPayload.data.vless.length}, TROJAN: ${backupPayload.data.trojan.length}` }
      );
      return;
    }

    if (state.step === 'restore_host') {
      const host = normalizeHost(text);
      if (!isIpv4(host)) return ctx.reply('IP VPS harus valid.');
      if (!(await canAccessHostForScOps(ctx.from.id, host))) {
        return ctx.reply('IP belum terdaftar aktif atau kamu tidak punya akses ke IP ini.');
      }
      state.host = host;
      state.step = 'restore_key';
      userState.set(ctx.chat.id, state);
      return ctx.reply('Masukkan key server tujuan.');
    }

    if (state.step === 'restore_key') {
      if (text.length < 8) return ctx.reply('Key tidak valid.');
      state.key = text;
      await saveServerKeyForHost(ctx.from.id, state.host, text);
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

  if (state.step === 'admin_upload_summary_api_script') {
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
      if (!/setup-summary-api|^#!\/usr\/bin\/env bash|^#!\/bin\/bash/m.test(textSample)) {
        return ctx.reply('File tidak terlihat seperti script setup summary api yang valid.');
      }

      const targetPath = await getSummaryApiLocalPath();
      const targetDir = path.dirname(targetPath);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, normalizedContent);
      try { fs.chmodSync(targetPath, 0o755); } catch (_) {}

      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Upload update Summary API berhasil.\n` +
          `Path lokal: ${targetPath}\n` +
          `Ukuran: ${normalizedContent.length} bytes`,
        adminMenu()
      );
    } catch (err) {
      userState.delete(ctx.chat.id);
      return ctx.reply(`Gagal upload file update Summary API: ${parseErr(err)}`, adminMenu());
    }
  }

  if (state.step !== 'restore_wait_file') return;

  try {
    if (!(await canAccessHostForScOps(ctx.from.id, state.host))) {
      userState.delete(ctx.chat.id);
      return ctx.reply('Akses restore ditolak: IP belum terdaftar aktif atau kamu tidak punya akses.', mainMenu());
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

    const restoredAccountsByType = {};
    for (const type of types) {
      const rawAccounts = Array.isArray(backupData[type]) ? backupData[type] : [];
      const accounts = rawAccounts
        .map((row) => normalizeAccountForImport(type, row, { forceActive: true, ensureNotExpired: true }))
        .filter((row) => String(row?.username || '').trim().length > 0);
      restoredAccountsByType[type] = accounts;
      if (accounts.length === 0) {
        resultLines.push(`${type.toUpperCase()}: 0 akun (skip)`);
        continue;
      }
      const imported = await apiPost(state.host, state.key, '/internal/import-accounts', { type, accounts });
      resultLines.push(`${type.toUpperCase()}: imported ${Number(imported.imported || 0)}, skipped ${Number(imported.skipped || 0)}`);
    }

    // Paksa sinkronisasi DB -> config Xray untuk setiap protocol Xray.
    let xrayTouched = false;
    for (const t of ['vmess', 'vless', 'trojan']) {
      const list = restoredAccountsByType[t] || [];
      if (!list.length) continue;
      try {
        const r = await apiPost(state.host, state.key, '/internal/sync-xray-from-db', { type: t, restart: false });
        xrayTouched = true;
        resultLines.push(`XRAY sync ${t.toUpperCase()}: OK (${Number(r?.synced_clients || 0)} client)`);
      } catch (syncErr) {
        resultLines.push(`XRAY sync ${t.toUpperCase()}: gagal (${parseErr(syncErr)})`);
      }
    }
    if (xrayTouched) {
      try {
        await applyXrayRestart(state.host, state.key);
        resultLines.push('XRAY restart: OK (single-restart batch)');
      } catch (restartErr) {
        resultLines.push(`XRAY restart: gagal (${parseErr(restartErr)})`);
      }
    }

    resultLines.push('ZIVPN auth: mengikuti akun SSH (mode unified)');

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
    setInterval(() => {
      runNaturalScExpiryJobs().catch(() => {});
    }, SC_NOTIFY_INTERVAL_MS);
    await pollPendingTopups();
    await runNaturalScExpiryJobs().catch(() => {});
    await bot.launch();
    console.log('app3 bot running...');
  } catch (e) {
    console.error('app3 start failed:', e.message);
    process.exit(1);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

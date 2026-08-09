const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = String(process.env.DB_PATH || path.join(__dirname, 'sc1forcrnexus.db')).trim();
const PORT = Math.max(1, Number(process.env.LICENSE_API_PORT || 8099) || 8099);
const HOST = String(process.env.LICENSE_API_HOST || '127.0.0.1').trim() || '127.0.0.1';
const LICENSE_API_TOKEN = String(process.env.LICENSE_API_TOKEN || '').trim();
const DEFAULT_SC_INSTALLER_LOCAL_PATH = path.join(__dirname, 'scripts', 'setup-autoscript-compat.sh');
const LEGACY_SC_INSTALLER_LOCAL_PATH = path.join(__dirname, 'payload', 'setup-autoscript-compat.sh');
const DEFAULT_SUMMARY_API_LOCAL_PATH = path.join(__dirname, 'scripts', 'setup-summary-api.sh');
const ENV_SC_INSTALLER_LOCAL_PATH = String(process.env.SC_INSTALLER_LOCAL_PATH || '').trim();
const ENV_SUMMARY_API_LOCAL_PATH = String(process.env.SUMMARY_API_LOCAL_PATH || '').trim();
const LICENSE_PUBLIC_BASE_URL = String(process.env.LICENSE_PUBLIC_BASE_URL || '').trim();
const LICENSE_ALLOW_LEGACY_BEARER = /^(1|true|yes|on)$/i.test(
  String(process.env.LICENSE_ALLOW_LEGACY_BEARER || '1').trim()
);
const LICENSE_REQUIRE_MACHINE_ID = /^(1|true|yes|on)$/i.test(
  String(process.env.LICENSE_REQUIRE_MACHINE_ID || '1').trim()
);
const LICENSE_ENFORCE_SOURCE_IP = /^(1|true|yes|on)$/i.test(
  String(process.env.LICENSE_ENFORCE_SOURCE_IP || '1').trim()
);
const LICENSE_LEASE_TTL_SECONDS = Math.min(
  86400,
  Math.max(300, Number(process.env.LICENSE_LEASE_TTL_SECONDS || 21600) || 21600)
);
const LICENSE_LEASE_GRACE_SECONDS = Math.min(
  604800,
  Math.max(0, Number(process.env.LICENSE_LEASE_GRACE_SECONDS || 86400) || 86400)
);
const LICENSE_SIGNING_PRIVATE_KEY_FILE = path.resolve(
  String(
    process.env.LICENSE_SIGNING_PRIVATE_KEY_FILE ||
      path.join(path.dirname(path.resolve(DB_PATH)), '.sc1forcr-license-ed25519-private.pem')
  ).trim()
);
const LICENSE_SIGNING_PUBLIC_KEY_FILE = path.resolve(
  String(
    process.env.LICENSE_SIGNING_PUBLIC_KEY_FILE ||
      path.join(path.dirname(LICENSE_SIGNING_PRIVATE_KEY_FILE), '.sc1forcr-license-ed25519-public.pem')
  ).trim()
);

let licenseSigningPrivateKey = null;
let licenseSigningPublicKey = null;
let licenseSigningPublicPem = '';
let licenseSigningKeyFingerprint = '';

const db = new sqlite3.Database(DB_PATH);
const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false }));

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

function writeFileAtomicSync(filePath, content, mode) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, mode);
    } catch (_) {}
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

function initLicenseSigningKeys() {
  let privatePem = '';
  if (fs.existsSync(LICENSE_SIGNING_PRIVATE_KEY_FILE)) {
    privatePem = String(fs.readFileSync(LICENSE_SIGNING_PRIVATE_KEY_FILE, 'utf8') || '').trim();
    licenseSigningPrivateKey = crypto.createPrivateKey(privatePem);
    if (licenseSigningPrivateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('license signing private key harus Ed25519');
    }
    licenseSigningPublicKey = crypto.createPublicKey(licenseSigningPrivateKey);
    try { fs.chmodSync(LICENSE_SIGNING_PRIVATE_KEY_FILE, 0o600); } catch (_) {}
  } else {
    if (fs.existsSync(LICENSE_SIGNING_PUBLIC_KEY_FILE)) {
      throw new Error(
        `private signing key hilang sementara public key masih ada: ${LICENSE_SIGNING_PRIVATE_KEY_FILE}`
      );
    }
    const generated = crypto.generateKeyPairSync('ed25519');
    licenseSigningPrivateKey = generated.privateKey;
    licenseSigningPublicKey = generated.publicKey;
    privatePem = licenseSigningPrivateKey.export({ type: 'pkcs8', format: 'pem' });
    writeFileAtomicSync(LICENSE_SIGNING_PRIVATE_KEY_FILE, privatePem, 0o600);
  }

  licenseSigningPublicPem = String(
    licenseSigningPublicKey.export({ type: 'spki', format: 'pem' })
  ).trim() + '\n';
  writeFileAtomicSync(LICENSE_SIGNING_PUBLIC_KEY_FILE, licenseSigningPublicPem, 0o644);
  const publicDer = licenseSigningPublicKey.export({ type: 'spki', format: 'der' });
  licenseSigningKeyFingerprint = crypto.createHash('sha256').update(publicDer).digest('hex');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function normalizeMachineId(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9._:-]/g, '').slice(0, 256);
}

function machineIdHash(raw) {
  const normalized = normalizeMachineId(raw);
  return normalized ? sha256Hex(normalized) : '';
}

function serverKeyId(raw) {
  const key = String(raw || '').trim();
  return key ? sha256Hex(key).slice(0, 32) : '';
}

function signLicensePayload(payload) {
  if (!licenseSigningPrivateKey || !licenseSigningPublicKey) {
    throw new Error('license signing key belum siap');
  }
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.sign(null, Buffer.from(payloadSegment, 'ascii'), licenseSigningPrivateKey);
  return `${payloadSegment}.${signature.toString('base64url')}`;
}

function registrationIsActive(reg, nowMs = Date.now()) {
  if (!reg || String(reg.status || '').trim().toLowerCase() !== 'active') return false;
  const expiresMs = Number(reg.expires_at || 0);
  return !(expiresMs > 0 && expiresMs <= nowMs);
}

function createSignedLicenseLease({
  reg = null,
  requestedIp = '',
  machineId = '',
  serverKey = '',
  status = '',
  reason = '',
  scriptVersion = ''
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const regActive = registrationIsActive(reg, now * 1000);
  const safeStatus = String(status || (regActive ? 'active' : (reg?.status || 'rejected')))
    .trim().toLowerCase().slice(0, 40) || 'rejected';
  const active = safeStatus === 'active' && regActive;
  const boundIp = cleanIp(reg?.vps_ip) || cleanIp(requestedIp);
  const registrationExpiresAt = Math.max(0, Math.floor(Number(reg?.expires_at || 0) / 1000));
  let leaseUntil = active ? now + LICENSE_LEASE_TTL_SECONDS : now;
  let graceUntil = active ? leaseUntil + LICENSE_LEASE_GRACE_SECONDS : now;
  if (registrationExpiresAt > 0) {
    leaseUntil = Math.min(leaseUntil, registrationExpiresAt);
    graceUntil = Math.min(graceUntil, registrationExpiresAt);
  }
  const refreshAfter = active
    ? Math.min(leaseUntil, now + Math.max(60, Math.floor(LICENSE_LEASE_TTL_SECONDS / 2)))
    : now;
  const payload = {
    v: 1,
    iss: 'sc1forcr-license-api',
    aud: 'sc1forcr-runtime',
    sub: `${Number(reg?.user_id || 0)}:${boundIp || '-'}`,
    status: active ? 'active' : safeStatus,
    reason: String(reason || (active ? 'license-valid' : 'license-denied')).trim().slice(0, 160),
    user_id: Number(reg?.user_id || 0),
    bound_ip: boundIp,
    machine_id_hash: machineIdHash(machineId),
    key_id: serverKeyId(serverKey),
    issued_at: now,
    refresh_after: refreshAfter,
    lease_until: leaseUntil,
    grace_until: graceUntil,
    registration_expires_at: registrationExpiresAt,
    script_version: String(scriptVersion || '').trim().slice(0, 80)
  };
  return {
    payload,
    token: signLicensePayload(payload),
    public_key_b64: Buffer.from(licenseSigningPublicPem, 'utf8').toString('base64'),
    public_key_fingerprint: licenseSigningKeyFingerprint
  };
}

function attachSignedLease(body, options) {
  const lease = createSignedLicenseLease(options);
  return {
    ...body,
    license_lease: lease.token,
    license_public_key_b64: lease.public_key_b64,
    license_key_fingerprint: lease.public_key_fingerprint,
    lease_ttl_seconds: LICENSE_LEASE_TTL_SECONDS,
    lease_grace_seconds: LICENSE_LEASE_GRACE_SECONDS,
    server_time: Math.floor(Date.now() / 1000)
  };
}

async function initDb() {
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
  await dbRun(`CREATE TABLE IF NOT EXISTS api_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    added_by INTEGER
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS sc_server_keys (
    user_id INTEGER NOT NULL,
    vps_ip TEXT NOT NULL,
    server_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, vps_ip)
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS sc_update_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    note TEXT,
    target_ip TEXT,
    created_at INTEGER NOT NULL,
    triggered_by INTEGER,
    status TEXT DEFAULT 'active'
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS sc_update_acks (
    vps_ip TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (vps_ip, version)
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS summary_update_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    note TEXT,
    created_at INTEGER NOT NULL,
    triggered_by INTEGER,
    status TEXT DEFAULT 'active'
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS summary_update_acks (
    vps_ip TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (vps_ip, version)
  )`);
  await ensureScRegistrationSchema();
  await ensureScServerKeySchema();
  await ensureScUpdateTriggerSchema();
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { if (fs.existsSync(file)) fs.chmodSync(file, 0o600); } catch (_) {}
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

async function ensureScServerKeySchema() {
  const cols = await dbAll('PRAGMA table_info(sc_server_keys)');
  const names = new Set(cols.map((c) => String(c?.name || '').toLowerCase()));
  const additions = [
    ['machine_id_hash', 'TEXT'],
    ['machine_bound_at', 'INTEGER'],
    ['last_lease_at', 'INTEGER']
  ];
  for (const [name, type] of additions) {
    if (names.has(name)) continue;
    await dbRun(`ALTER TABLE sc_server_keys ADD COLUMN ${name} ${type}`).catch((e) => {
      if (!/duplicate column name/i.test(String(e?.message || ''))) throw e;
    });
  }
}

async function ensureScUpdateTriggerSchema() {
  const cols = await dbAll('PRAGMA table_info(sc_update_triggers)');
  const hasTargetIp = cols.some((c) => String(c?.name || '').toLowerCase() === 'target_ip');
  if (!hasTargetIp) {
    await dbRun('ALTER TABLE sc_update_triggers ADD COLUMN target_ip TEXT').catch((e) => {
      if (!/duplicate column name/i.test(String(e?.message || ''))) throw e;
    });
  }
}

function cleanIp(raw) {
  const x = String(raw || '').split(',')[0].trim();
  if (!x) return '';
  if (x.startsWith('::ffff:')) return x.replace('::ffff:', '');
  return x;
}

function getClientIp(req) {
  const peerIp = cleanIp(req.socket?.remoteAddress);
  // Header proxy hanya dipercaya ketika koneksi benar-benar datang dari reverse
  // proxy lokal. Jika API suatu saat bind ke publik, klien tidak dapat memalsukan
  // X-Real-IP/X-Forwarded-For untuk melewati ikatan IP registrasi.
  if (peerIp === '127.0.0.1' || peerIp === '::1') {
    return cleanIp(req.headers['x-real-ip']) || cleanIp(req.headers['x-forwarded-for']) || peerIp;
  }
  return peerIp;
}

function sourceIpMatchesRegistration(req, reg) {
  if (!LICENSE_ENFORCE_SOURCE_IP) return true;
  const sourceIp = cleanIp(getClientIp(req));
  const boundIp = cleanIp(reg?.vps_ip);
  return Boolean(sourceIp && boundIp && sourceIp === boundIp);
}

function getRequestHost(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim().toLowerCase();
  if (!host) return '';
  return host.split(',')[0].trim().split(':')[0].trim();
}

function getBaseUrl(req) {
  if (LICENSE_PUBLIC_BASE_URL) return LICENSE_PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`.replace(/\/$/, '');
}

function normalizeScriptLineEndings(input) {
  const s = String(input || '');
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function getDistributionId(reg, serverKey) {
  const material = [
    Number(reg?.user_id || 0),
    cleanIp(reg?.vps_ip),
    String(serverKey || '').trim()
  ].join('|');
  return material.replace(/\|/g, '')
    ? crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32)
    : '';
}

function personalizeScInstaller(input, reg, serverKey) {
  const content = normalizeScriptLineEndings(input);
  const distributionId = getDistributionId(reg, serverKey);
  if (!distributionId) return content;
  const marker = `# SC_DISTRIBUTION_ID=${distributionId}`;
  if (content.includes(marker)) return content;
  const firstNewline = content.indexOf('\n');
  if (firstNewline < 0) return `${content}\n${marker}\n`;
  return `${content.slice(0, firstNewline + 1)}${marker}\n${content.slice(firstNewline + 1)}`;
}

function shellQuote(input) {
  return `'${String(input || '').replace(/'/g, `'\\''`)}'`;
}

function uniqPaths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : []).map((p) => String(p || '').trim()).filter(Boolean))];
}

function resolveScInstallerLocalPath() {
  const candidates = uniqPaths([
    DEFAULT_SC_INSTALLER_LOCAL_PATH,
    ENV_SC_INSTALLER_LOCAL_PATH,
    LEGACY_SC_INSTALLER_LOCAL_PATH
  ]);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return DEFAULT_SC_INSTALLER_LOCAL_PATH;
}

function resolveSummaryApiLocalPath() {
  const candidates = uniqPaths([
    DEFAULT_SUMMARY_API_LOCAL_PATH,
    ENV_SUMMARY_API_LOCAL_PATH
  ]);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return DEFAULT_SUMMARY_API_LOCAL_PATH;
}

function renderNotRegisteredNotice(ip = '') {
  const ipText = ip || '-';
  return [
    '============================================================',
    '               SC 1FORCR NEXUS - AKSES DITOLAK            ',
    '============================================================',
    '',
    `IP Anda (${ipText}) belum terdaftar.`,
    '',
    'Silakan lakukan registrasi IP VPS Anda terlebih dahulu di bot:',
    'https://t.me/sc1forcrnexusbot',
    '',
    'Setelah registrasi berhasil, silakan ulangi install/update.',
    '============================================================'
  ].join('\n');
}

function renderExpiredNotice(ip = '') {
  const ipText = ip || '-';
  return [
    '============================================================',
    '               SC 1FORCR NEXUS - AKSES DITOLAK            ',
    '============================================================',
    '',
    `Script 1FORCRNEXUS anda sudah expired untuk IP (${ipText}).`,
    '',
    'Silahkan perpanjang melalui bot resmi:',
    'https://t.me/sc1forcrnexusbot',
    '',
    'Setelah perpanjang berhasil, silakan ulangi install/update.',
    '============================================================'
  ].join('\n');
}

function renderNotRegisteredBash(ip = '') {
  const msg = renderNotRegisteredNotice(ip);
  return `#!/usr/bin/env bash
set -euo pipefail
cat <<'EOF'
${msg}
EOF
exit 1
`;
}

function renderExpiredBash(ip = '') {
  const msg = renderExpiredNotice(ip);
  return `#!/usr/bin/env bash
set -euo pipefail
cat <<'EOF'
${msg}
EOF
exit 1
`;
}

function safeEqualSecret(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireBearer(req, res, next) {
  if (!LICENSE_API_TOKEN) {
    return res.status(500).json({ ok: false, message: 'LICENSE_API_TOKEN not configured' });
  }
  const auth = String(req.headers.authorization || '').trim();
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : auth;
  if (!safeEqualSecret(token, LICENSE_API_TOKEN)) {
    return res.status(401).json({ ok: false, message: 'unauthorized' });
  }
  return next();
}

async function findRegistrationByServerKey(serverKey, { activeOnly = false } = {}) {
  const key = String(serverKey || '').trim();
  if (!key) return null;
  const now = Date.now();
  const activeSql = activeOnly
    ? "AND r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at <= 0 OR r.expires_at > ?) "
    : '';
  const params = activeOnly ? [key, now] : [key];
  return dbGet(
    'SELECT r.user_id, r.vps_ip, r.client_name, r.status, r.updated_at, r.expires_at, ' +
      'k.server_key, k.machine_id_hash, k.machine_bound_at, k.last_lease_at ' +
      'FROM sc_server_keys k JOIN sc_registrations r ON r.user_id = k.user_id AND r.vps_ip = k.vps_ip ' +
      'WHERE k.server_key = ? ' + activeSql +
      'ORDER BY k.updated_at DESC, r.updated_at DESC LIMIT 1',
    params
  );
}

async function requireLicenseClient(req, res, next) {
  try {
    const serverKey = String(req.headers['x-sc-key'] || '').trim();
    if (serverKey) {
      const reg = await findRegistrationByServerKey(serverKey, { activeOnly: false });
      if (reg) {
        if (!sourceIpMatchesRegistration(req, reg)) {
          return res.status(403).json({ ok: false, allowed: false, status: 'blocked', message: 'source IP mismatch' });
        }
        req.scLicenseRegistration = reg;
        req.scLicenseServerKey = serverKey;
        req.scLicenseAuth = 'vps-key';
        return next();
      }
    }
    if (!LICENSE_ALLOW_LEGACY_BEARER) {
      return res.status(401).json({ ok: false, message: 'per-VPS X-SC-Key required' });
    }
    return requireBearer(req, res, () => {
      req.scLicenseAuth = 'legacy-bearer';
      next();
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

async function requireUpdateClient(req, res, next) {
  try {
    const serverKey = String(req.headers['x-sc-key'] || '').trim();
    if (serverKey) {
      const reg = await findRegistrationByServerKey(serverKey, { activeOnly: true });
      if (reg) {
        if (!sourceIpMatchesRegistration(req, reg)) {
          return res.status(403).json({ ok: false, allowed: false, message: 'source IP mismatch' });
        }
        req.scUpdateRegistration = reg;
        req.scUpdateServerKey = serverKey;
        req.scUpdateAuth = 'vps-key';
        return next();
      }
    }

    if (!LICENSE_ALLOW_LEGACY_BEARER) {
      return res.status(401).json({ ok: false, message: 'per-VPS X-SC-Key required' });
    }
    // Kompatibilitas sementara untuk VPS lama. Matikan setelah seluruh VPS memakai V.1FSC.8.
    return requireBearer(req, res, () => {
      req.scUpdateAuth = 'legacy-bearer';
      next();
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

async function isDomainAllowed(req) {
  const domains = await dbAll('SELECT domain FROM api_domains WHERE is_active = 1');
  if (!domains.length) return true;
  const host = getRequestHost(req);
  if (!host) return false;
  const set = new Set(domains.map((r) => String(r.domain || '').trim().toLowerCase()).filter(Boolean));
  return set.has(host);
}

async function findActiveRegistrationByIp(ip) {
  const safeIp = cleanIp(ip);
  if (!safeIp) return null;
  const now = Date.now();
  return dbGet(
    "SELECT user_id, vps_ip, client_name, status, updated_at, expires_at FROM sc_registrations " +
      "WHERE LOWER(TRIM(REPLACE(REPLACE(vps_ip, char(13), ''), char(10), ''))) = LOWER(TRIM(?)) " +
      "AND status = 'active' AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?) LIMIT 1",
    [safeIp, now]
  );
}

async function findLatestRegistrationByIp(ip) {
  const safeIp = cleanIp(ip);
  if (!safeIp) return null;
  return dbGet(
    "SELECT user_id, vps_ip, client_name, status, updated_at, expires_at FROM sc_registrations " +
      "WHERE LOWER(TRIM(REPLACE(REPLACE(vps_ip, char(13), ''), char(10), ''))) = LOWER(TRIM(?)) " +
      "ORDER BY updated_at DESC, id DESC LIMIT 1",
    [safeIp]
  );
}

async function ensureServerKeyForRegistration(reg) {
  const userId = Number(reg?.user_id || 0);
  const ip = cleanIp(reg?.vps_ip);
  if (!userId || !ip) throw new Error('Data registrasi untuk API key tidak valid');

  const existing = await dbGet(
    'SELECT server_key FROM sc_server_keys WHERE user_id = ? AND vps_ip = ? LIMIT 1',
    [userId, ip]
  );
  const existingKey = String(existing?.server_key || '').trim();
  if (existingKey.length >= 8) return existingKey;

  const serverKey = crypto.randomBytes(24).toString('hex');
  await dbRun(
    `INSERT INTO sc_server_keys (user_id, vps_ip, server_key, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, vps_ip) DO UPDATE SET
       server_key=excluded.server_key,
       updated_at=excluded.updated_at`,
    [userId, ip, serverKey, Date.now()]
  );
  return serverKey;
}

async function ensureModernServerKeyForLegacyMigration(reg, currentKey) {
  const userId = Number(reg?.user_id || 0);
  const ip = cleanIp(reg?.vps_ip);
  let key = String(currentKey || '').trim();
  if (!userId || !ip) throw new Error('registrasi migrasi key tidak valid');
  if (/^[a-f0-9]{48}$/.test(key)) return { key, rotated: false };

  // Key lama dapat berupa token manual/base64 yang tidak aman ditulis mentah ke
  // file env. Rotasi atomik ke 48 hex; CAS mencegah dua aktivasi bersamaan
  // menghasilkan key berbeda untuk VPS yang sama.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nextKey = crypto.randomBytes(24).toString('hex');
    const result = await dbRun(
      `UPDATE sc_server_keys
       SET server_key = ?, updated_at = ?
       WHERE user_id = ? AND vps_ip = ? AND server_key = ?`,
      [nextKey, Date.now(), userId, ip, key]
    );
    if (Number(result?.changes || 0) === 1) return { key: nextKey, rotated: true };
    const latest = await dbGet(
      'SELECT server_key FROM sc_server_keys WHERE user_id = ? AND vps_ip = ? LIMIT 1',
      [userId, ip]
    );
    key = String(latest?.server_key || '').trim();
    if (/^[a-f0-9]{48}$/.test(key)) return { key, rotated: true };
  }
  throw new Error('rotasi key legacy gagal karena perubahan bersamaan');
}

async function bindMachineIdForRegistration(reg, serverKey, rawMachineId) {
  const userId = Number(reg?.user_id || 0);
  const ip = cleanIp(reg?.vps_ip);
  const incomingHash = machineIdHash(rawMachineId);
  if (!userId || !ip || !String(serverKey || '').trim()) {
    return { ok: false, reason: 'registration-key-invalid', machineIdHash: incomingHash };
  }
  if (!incomingHash) {
    return LICENSE_REQUIRE_MACHINE_ID
      ? { ok: false, reason: 'machine-id-required', machineIdHash: '' }
      : { ok: true, reason: 'machine-id-optional', machineIdHash: '' };
  }

  const row = await dbGet(
    'SELECT machine_id_hash FROM sc_server_keys WHERE user_id = ? AND vps_ip = ? AND server_key = ? LIMIT 1',
    [userId, ip, String(serverKey).trim()]
  );
  const existingHash = String(row?.machine_id_hash || '').trim().toLowerCase();
  if (existingHash && existingHash !== incomingHash) {
    return { ok: false, reason: 'machine-id-mismatch', machineIdHash: incomingHash, existingHash };
  }
  const now = Date.now();
  await dbRun(
    `UPDATE sc_server_keys
     SET machine_id_hash = COALESCE(NULLIF(machine_id_hash, ''), ?),
         machine_bound_at = COALESCE(machine_bound_at, ?),
         last_lease_at = ?
     WHERE user_id = ? AND vps_ip = ? AND server_key = ?`,
    [incomingHash, now, now, userId, ip, String(serverKey).trim()]
  );
  return { ok: true, reason: existingHash ? 'machine-id-match' : 'machine-id-bound', machineIdHash: incomingHash };
}

async function getLatestActiveUpdateTrigger(ip) {
  const safeIp = cleanIp(ip);
  if (!safeIp) return null;
  return dbGet(
    "SELECT version, note, target_ip, created_at, triggered_by FROM sc_update_triggers " +
      "WHERE status = 'active' AND (target_ip IS NULL OR TRIM(target_ip) = '' OR target_ip = ?) " +
      'ORDER BY created_at DESC, id DESC LIMIT 1',
    [safeIp]
  );
}

async function getLatestActiveSummaryUpdateTrigger() {
  return dbGet(
    "SELECT version, note, created_at, triggered_by FROM summary_update_triggers WHERE status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1"
  );
}

async function recordUpdateAck(ip, version, status, message) {
  const safeIp = cleanIp(ip);
  const safeVersion = String(version || '').trim().slice(0, 80);
  const safeStatusRaw = String(status || '').trim().toLowerCase();
  const safeStatus = ['running', 'success', 'failed', 'skipped'].includes(safeStatusRaw) ? safeStatusRaw : 'running';
  const safeMessage = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  if (!safeIp || !safeVersion) return { ok: false, message: 'ip/version required' };
  await dbRun(
    `INSERT INTO sc_update_acks (vps_ip, version, status, message, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(vps_ip, version) DO UPDATE SET
       status=excluded.status,
       message=excluded.message,
       updated_at=excluded.updated_at`,
    [safeIp, safeVersion, safeStatus, safeMessage, Date.now()]
  );
  return { ok: true, ip: safeIp, version: safeVersion, status: safeStatus };
}

async function getUpdateAckStatus(ip, version) {
  const safeIp = cleanIp(ip);
  const safeVersion = String(version || '').trim().slice(0, 80);
  if (!safeIp || !safeVersion) return '';
  const row = await dbGet(
    'SELECT status FROM sc_update_acks WHERE vps_ip = ? AND version = ? LIMIT 1',
    [safeIp, safeVersion]
  ).catch(() => null);
  return String(row?.status || '').trim().toLowerCase();
}

async function recordSummaryUpdateAck(ip, version, status, message) {
  const safeIp = cleanIp(ip);
  const safeVersion = String(version || '').trim().slice(0, 80);
  const safeStatusRaw = String(status || '').trim().toLowerCase();
  const safeStatus = ['running', 'success', 'failed', 'skipped'].includes(safeStatusRaw) ? safeStatusRaw : 'running';
  const safeMessage = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  if (!safeIp || !safeVersion) return { ok: false, message: 'ip/version required' };
  await dbRun(
    `INSERT INTO summary_update_acks (vps_ip, version, status, message, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(vps_ip, version) DO UPDATE SET
       status=excluded.status,
       message=excluded.message,
       updated_at=excluded.updated_at`,
    [safeIp, safeVersion, safeStatus, safeMessage, Date.now()]
  );
  return { ok: true, ip: safeIp, version: safeVersion, status: safeStatus };
}

async function getSummaryUpdateAckStatus(ip, version) {
  const safeIp = cleanIp(ip);
  const safeVersion = String(version || '').trim().slice(0, 80);
  if (!safeIp || !safeVersion) return '';
  const row = await dbGet(
    'SELECT status FROM summary_update_acks WHERE vps_ip = ? AND version = ? LIMIT 1',
    [safeIp, safeVersion]
  ).catch(() => null);
  return String(row?.status || '').trim().toLowerCase();
}

app.get('/health', async (_req, res) => {
  return res.json({ ok: true, service: 'sc1forcr-license-api', db: DB_PATH });
});

async function sendInstallerScript(req, res) {
  try {
    const allowDomain = await isDomainAllowed(req);
    if (!allowDomain) {
      return res.status(403).type('text/plain').send('Forbidden domain');
    }

    const ip = getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
    if (!reg) {
      const latest = await findLatestRegistrationByIp(ip);
      const isExpired = Number(latest?.expires_at || 0) > 0 && Date.now() > Number(latest.expires_at);
      if (latest && isExpired) return res.type('text/plain').send(renderExpiredBash(ip));
      return res.type('text/plain').send(renderNotRegisteredBash(ip));
    }

    const serverKey = await ensureServerKeyForRegistration(reg);

    const baseUrl = getBaseUrl(req);
    const scInstallerPath = resolveScInstallerLocalPath();
    const hasLocalInstaller = fs.existsSync(scInstallerPath);
    if (!hasLocalInstaller) {
      return res.status(500).type('text/plain').send('Installer lokal belum tersedia di VPS bot (scripts/setup-autoscript-compat.sh).');
    }
    const sourceUrl = `${baseUrl}/sc1forcr/payload/scripts/setup-autoscript-compat.sh`;
    const summaryApiPath = resolveSummaryApiLocalPath();
    const hasLocalSummaryApi = fs.existsSync(summaryApiPath);
    const summaryApiUrl = hasLocalSummaryApi
      ? `${baseUrl}/sc1forcr/payload/scripts/setup-summary-api.sh`
      : '';
    const activateUrl = `${baseUrl}/sc1forcr/license/activate`;
    const personalizedInstaller = personalizeScInstaller(
      fs.readFileSync(scInstallerPath, 'utf8'),
      reg,
      serverKey
    );
    const installerSha256 = crypto
      .createHash('sha256')
      .update(personalizedInstaller, 'utf8')
      .digest('hex');
    const envLines = [
      'export LICENSE_ENFORCE=1',
      'export LICENSE_LEASE_REQUIRED=1',
      `export LICENSE_API_URL=${shellQuote(activateUrl)}`,
      "export LICENSE_API_TOKEN=''",
      `export LICENSE_KEY=${shellQuote(`IP_REGISTERED_${ip}`)}`,
      `export UPDATE_SCRIPT_URL=${shellQuote(sourceUrl)}`,
      `export INSTALL_AUTH_TOKEN=${shellQuote(serverKey)}`,
      `export API_AUTH_TOKEN=${shellQuote(serverKey)}`,
      `export AUTH_TOKEN=${shellQuote(serverKey)}`,
      `export SC_UPDATE_KEY=${shellQuote(serverKey)}`,
      `export LICENSE_PUBLIC_KEY_B64=${shellQuote(Buffer.from(licenseSigningPublicPem, 'utf8').toString('base64'))}`
    ];
    if (hasLocalSummaryApi) {
      envLines.push(`export SUMMARY_API_SETUP_URL=${shellQuote(summaryApiUrl)}`);
    }
    const script = `#!/usr/bin/env bash
set -euo pipefail

TMP_SC="$(mktemp /tmp/setup-autoscript-compat.XXXXXX.sh)"

cleanup() {
  rm -f "$TMP_SC"
}
trap cleanup EXIT

package_manager_busy() {
  local proc comm state
  if command -v fuser >/dev/null 2>&1; then
    if fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi
  for proc in /proc/[0-9]*/comm; do
    [ -r "$proc" ] || continue
    IFS= read -r comm < "$proc" || continue
    state="$(awk '{print $3}' "\${proc%/comm}/stat" 2>/dev/null || true)"
    [ "$state" = "Z" ] && continue
    case "$comm" in
      apt|apt-get|dpkg|unattended-upgr*) return 0 ;;
    esac
  done
  return 1
}

wait_apt_locks() {
  local waited=0
  local max_wait=900
  while package_manager_busy; do
    if [ "$waited" -eq 0 ]; then
      echo "Menunggu apt/dpkg lock selesai..."
    fi
    sleep 5
    waited=$((waited + 5))
    if [ "$waited" -ge "$max_wait" ]; then
      echo "Timeout menunggu apt/dpkg lock."
      return 1
    fi
  done
}

repair_dpkg_state() {
  wait_apt_locks || return 1
  DEBIAN_FRONTEND=noninteractive dpkg --configure -a || true
  wait_apt_locks || return 1
  DEBIAN_FRONTEND=noninteractive apt-get install -f -y || true
}

ensure_curl_ready() {
  command -v curl >/dev/null 2>&1 && return 0
  repair_dpkg_state || true
  wait_apt_locks || return 1
  DEBIAN_FRONTEND=noninteractive apt-get update -y || true
  wait_apt_locks || return 1
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates || true
  command -v curl >/dev/null 2>&1
}

download_installer_payload() {
  local url="$1"
  local out="$2"
  if curl -4fsSL --connect-timeout 15 --max-time 120 --retry 5 --retry-delay 2 "$url" -o "$out"; then
    return 0
  fi
  curl -fsSL --connect-timeout 15 --max-time 120 --retry 5 --retry-delay 2 "$url" -o "$out"
}

repair_dpkg_state || true
ensure_curl_ready
echo "Mengunduh installer utama..."
download_installer_payload "${sourceUrl}" "$TMP_SC"
if ! head -n 1 "$TMP_SC" | grep -q '^#!'; then
  echo "Installer utama tidak valid atau gagal diunduh."
  exit 1
fi
if ! printf '%s  %s\n' "${installerSha256}" "$TMP_SC" | sha256sum -c --status; then
  echo "Checksum installer utama tidak cocok."
  exit 1
fi
chmod +x "$TMP_SC"

${envLines.join('\n')}
if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  bash "$TMP_SC" </dev/tty
else
  bash "$TMP_SC"
fi
`;
    return res.type('text/plain').send(script);
  } catch (e) {
    return res.status(500).type('text/plain').send(`Internal error: ${e.message}`);
  }
}

app.get('/i', sendInstallerScript);
app.get('/sc1forcr/installer.sh', sendInstallerScript);

app.get('/sc1forcr/payload/setup-autoscript-compat.sh', async (req, res) => {
  try {
    const allowDomain = await isDomainAllowed(req);
    if (!allowDomain) return res.status(403).type('text/plain').send('Forbidden domain');
    const ip = getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
    if (!reg) {
      const latest = await findLatestRegistrationByIp(ip);
      const isExpired = Number(latest?.expires_at || 0) > 0 && Date.now() > Number(latest.expires_at);
      if (latest && isExpired) return res.type('text/plain').send(renderExpiredBash(ip));
      return res.type('text/plain').send(renderNotRegisteredBash(ip));
    }
    const scInstallerPath = resolveScInstallerLocalPath();
    if (!fs.existsSync(scInstallerPath)) {
      return res.status(404).type('text/plain').send('Installer lokal belum diupload admin.');
    }
    const serverKey = await ensureServerKeyForRegistration(reg);
    const content = personalizeScInstaller(fs.readFileSync(scInstallerPath, 'utf8'), reg, serverKey);
    return res.type('text/plain').send(content);
  } catch (e) {
    return res.status(500).type('text/plain').send(`Internal error: ${e.message}`);
  }
});

app.get('/sc1forcr/payload/scripts/setup-autoscript-compat.sh', async (req, res) => {
  try {
    const allowDomain = await isDomainAllowed(req);
    if (!allowDomain) return res.status(403).type('text/plain').send('Forbidden domain');
    const ip = getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
    if (!reg) {
      const latest = await findLatestRegistrationByIp(ip);
      const isExpired = Number(latest?.expires_at || 0) > 0 && Date.now() > Number(latest.expires_at);
      if (latest && isExpired) return res.type('text/plain').send(renderExpiredBash(ip));
      return res.type('text/plain').send(renderNotRegisteredBash(ip));
    }
    const scInstallerPath = resolveScInstallerLocalPath();
    if (!fs.existsSync(scInstallerPath)) {
      return res.status(404).type('text/plain').send('Installer lokal belum diupload admin.');
    }
    const serverKey = await ensureServerKeyForRegistration(reg);
    const content = personalizeScInstaller(fs.readFileSync(scInstallerPath, 'utf8'), reg, serverKey);
    return res.type('text/plain').send(content);
  } catch (e) {
    return res.status(500).type('text/plain').send(`Internal error: ${e.message}`);
  }
});

app.get('/sc1forcr/payload/scripts/setup-summary-api.sh', async (req, res) => {
  try {
    const allowDomain = await isDomainAllowed(req);
    if (!allowDomain) return res.status(403).type('text/plain').send('Forbidden domain');
    const ip = getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
    if (!reg) {
      const latest = await findLatestRegistrationByIp(ip);
      const isExpired = Number(latest?.expires_at || 0) > 0 && Date.now() > Number(latest.expires_at);
      if (latest && isExpired) return res.type('text/plain').send(renderExpiredBash(ip));
      return res.type('text/plain').send(renderNotRegisteredBash(ip));
    }
    const summaryApiPath = resolveSummaryApiLocalPath();
    if (!fs.existsSync(summaryApiPath)) {
      return res.status(404).type('text/plain').send('Summary API installer lokal belum tersedia.');
    }
    const content = normalizeScriptLineEndings(fs.readFileSync(summaryApiPath, 'utf8'));
    return res.type('text/plain').send(content);
  } catch (e) {
    return res.status(500).type('text/plain').send(`Internal error: ${e.message}`);
  }
});

app.get('/sc1forcr/license/public-key', (_req, res) => {
  return res.json({
    ok: true,
    algorithm: 'Ed25519',
    public_key_b64: Buffer.from(licenseSigningPublicPem, 'utf8').toString('base64'),
    fingerprint_sha256: licenseSigningKeyFingerprint
  });
});

app.get('/sc1forcr/payload/manifest', requireUpdateClient, async (req, res) => {
  try {
    const reg = req.scUpdateRegistration || null;
    const installerPath = resolveScInstallerLocalPath();
    if (!reg || !fs.existsSync(installerPath)) {
      return res.status(404).json({ ok: false, message: 'installer/registrasi tidak tersedia' });
    }
    const serverKey = String(req.scUpdateServerKey || '').trim();
    const content = personalizeScInstaller(fs.readFileSync(installerPath, 'utf8'), reg, serverKey);
    const match = content.match(/SC_SCRIPT_VERSION_OVERRIDE:-([^}"\r\n]+)/);
    const version = String(match?.[1] || '').trim();
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1,
      iss: 'sc1forcr-license-api',
      aud: 'sc1forcr-update',
      bound_ip: cleanIp(reg.vps_ip),
      user_id: Number(reg.user_id || 0),
      key_id: serverKeyId(req.scUpdateServerKey || ''),
      file: 'scripts/setup-autoscript-compat.sh',
      version,
      sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
      size: Buffer.byteLength(content, 'utf8'),
      issued_at: now,
      valid_until: now + 600
    };
    return res.json({
      ok: true,
      algorithm: 'Ed25519',
      manifest: signLicensePayload(payload),
      ...payload,
      public_key_fingerprint: licenseSigningKeyFingerprint
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/sc1forcr/license/activate', requireLicenseClient, async (req, res) => {
  try {
    const keyedReg = req.scLicenseRegistration || null;
    // Klien legacy membawa bearer global dan karena itu tidak boleh memilih IP
    // dari body. Migrasi key hanya boleh mengikuti IP sumber yang dilihat server.
    const ip = cleanIp(keyedReg?.vps_ip) || (
      req.scLicenseAuth === 'legacy-bearer'
        ? cleanIp(getClientIp(req))
        : (cleanIp(req.body?.ip) || cleanIp(getClientIp(req)))
    );
    const latest = keyedReg || (await findLatestRegistrationByIp(ip));
    const reg = registrationIsActive(latest) ? latest : null;
    const machineId = normalizeMachineId(req.body?.machine_id);
    const scriptVersion = String(req.body?.script_version || '').trim();
    let serverKey = String(req.scLicenseServerKey || (reg ? await ensureServerKeyForRegistration(reg) : '')).trim();
    let legacyKeyRotated = false;

    if (!reg) {
      const isExpired = Boolean(latest) && (
        String(latest?.status || '').trim().toLowerCase() === 'expired' ||
        (Number(latest?.expires_at || 0) > 0 && Date.now() >= Number(latest.expires_at))
      );
      if (isExpired) {
        await dbRun(
          "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE vps_ip = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
          [Date.now(), ip, Date.now()]
        ).catch(() => {});
        return res.status(403).json(attachSignedLease({
          ok: false,
          allowed: false,
          status: 'expired',
          message: 'Script 1FORCRNEXUS anda sudah expired silahkan perpanjang melalui bot',
          ip,
          expires_at: Number(latest.expires_at || 0) || null
        }, {
          reg: latest,
          requestedIp: ip,
          machineId,
          serverKey,
          status: 'expired',
          reason: 'registration-expired',
          scriptVersion
        }));
      }
      return res.status(403).json(attachSignedLease({
        ok: false,
        allowed: false,
        status: 'rejected',
        message: 'IP anda belum terdaftar silahkan melakukan registrasi di bot https://t.me/sc1forcrnexusbot',
        ip
      }, {
        reg: latest,
        requestedIp: ip,
        machineId,
        serverKey,
        status: 'rejected',
        reason: 'registration-not-active',
        scriptVersion
      }));
    }

    if (req.scLicenseAuth === 'legacy-bearer') {
      const migratedKey = await ensureModernServerKeyForLegacyMigration(reg, serverKey);
      serverKey = migratedKey.key;
      legacyKeyRotated = migratedKey.rotated;
    }

    const machineBinding = req.scLicenseAuth === 'legacy-bearer' && !machineId
      ? { ok: true, reason: 'legacy-machine-id-unbound', machineIdHash: '' }
      : await bindMachineIdForRegistration(reg, serverKey, machineId);
    if (!machineBinding.ok) {
      return res.status(403).json(attachSignedLease({
        ok: false,
        allowed: false,
        status: 'blocked',
        message: machineBinding.reason === 'machine-id-mismatch'
          ? 'Machine ID VPS tidak cocok dengan registrasi lisensi'
          : 'Machine ID VPS wajib tersedia untuk aktivasi lisensi',
        ip: reg.vps_ip,
        expires_at: Number(reg.expires_at || 0) || null
      }, {
        reg,
        requestedIp: ip,
        machineId,
        serverKey,
        status: 'blocked',
        reason: machineBinding.reason,
        scriptVersion
      }));
    }

    await dbRun('UPDATE sc_registrations SET last_used_at = ?, updated_at = ? WHERE user_id = ? AND vps_ip = ?', [
      Date.now(),
      Date.now(),
      reg.user_id,
      reg.vps_ip
    ]).catch(() => {});

    return res.json(attachSignedLease({
      ok: true,
      allowed: true,
      status: 'active',
      message: 'License valid',
      distribution: 'BOT 1FORCR NEXUS',
      client_name: String(reg.client_name || reg.vps_ip || ip).trim(),
      bound_ip: reg.vps_ip,
      user_id: reg.user_id,
      expires_at: Number(reg.expires_at || 0) || null,
      ...(req.scLicenseAuth === 'legacy-bearer'
        ? { sc_update_key: serverKey, key_migrated: true, key_rotated: legacyKeyRotated }
        : {})
    }, {
      reg,
      requestedIp: ip,
      machineId,
      serverKey,
      status: 'active',
      reason: machineBinding.reason,
      scriptVersion
    }));
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/sc1forcr/update/check', requireUpdateClient, async (req, res) => {
  try {
    const keyedReg = req.scUpdateRegistration || null;
    const ip = cleanIp(keyedReg?.vps_ip) || cleanIp(req.body?.ip) || getClientIp(req);
    const reg = keyedReg || (await findActiveRegistrationByIp(ip));
    if (!reg) {
      const latest = await findLatestRegistrationByIp(ip);
      const isExpired = Number(latest?.expires_at || 0) > 0 && Date.now() > Number(latest.expires_at);
      if (latest && isExpired) {
        await dbRun(
          "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE vps_ip = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
          [Date.now(), ip, Date.now()]
        ).catch(() => {});
        return res.status(403).json({ ok: false, allowed: false, status: 'expired', message: 'SC expired', ip });
      }
      return res.status(403).json({ ok: false, allowed: false, status: 'rejected', message: 'IP belum terdaftar', ip });
    }

    await dbRun('UPDATE sc_registrations SET last_used_at = ?, updated_at = ? WHERE user_id = ? AND vps_ip = ?', [
      Date.now(),
      Date.now(),
      reg.user_id,
      reg.vps_ip
    ]).catch(() => {});

    const trigger = await getLatestActiveUpdateTrigger(reg.vps_ip);
    if (!trigger?.version) {
      return res.json({ ok: true, allowed: true, update_required: false, ip: reg.vps_ip });
    }

    const currentVersion = String(req.body?.current_version || '').trim();
    const baseUrl = getBaseUrl(req);
    const scInstallerPath = resolveScInstallerLocalPath();
    const summaryApiPath = resolveSummaryApiLocalPath();
    const hasInstaller = fs.existsSync(scInstallerPath);
    const triggerVersion = String(trigger.version);
    const ackStatus = await getUpdateAckStatus(reg.vps_ip, triggerVersion);
    const alreadySucceeded = ackStatus === 'success';
    const scriptUrl = `${baseUrl}/sc1forcr/payload/scripts/setup-autoscript-compat.sh`;
    const summaryApiUrl = fs.existsSync(summaryApiPath)
      ? `${baseUrl}/sc1forcr/payload/scripts/setup-summary-api.sh`
      : '';

    return res.json({
      ok: true,
      allowed: true,
      update_required: hasInstaller && !alreadySucceeded && currentVersion !== triggerVersion,
      version: triggerVersion,
      note: String(trigger.note || ''),
      target_ip: cleanIp(trigger.target_ip) || null,
      created_at: Number(trigger.created_at || 0) || null,
      script_url: hasInstaller ? scriptUrl : '',
      summary_api_url: summaryApiUrl,
      ack_status: ackStatus,
      ip: reg.vps_ip
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/sc1forcr/update/ack', requireUpdateClient, async (req, res) => {
  try {
    const keyedReg = req.scUpdateRegistration || null;
    const ip = cleanIp(keyedReg?.vps_ip) || cleanIp(req.body?.ip) || getClientIp(req);
    const reg = keyedReg || (await findActiveRegistrationByIp(ip));
    if (!reg) {
      return res.status(403).json({ ok: false, allowed: false, message: 'IP belum terdaftar atau expired', ip });
    }
    const result = await recordUpdateAck(
      reg.vps_ip,
      req.body?.version,
      req.body?.status,
      req.body?.message
    );
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/sc1forcr/summary-update/check', requireUpdateClient, async (req, res) => {
  try {
    const keyedReg = req.scUpdateRegistration || null;
    const ip = cleanIp(keyedReg?.vps_ip) || cleanIp(req.body?.ip) || getClientIp(req);
    const reg = keyedReg || (await findActiveRegistrationByIp(ip));
    if (!reg) {
      const latest = await findLatestRegistrationByIp(ip);
      const isExpired = Number(latest?.expires_at || 0) > 0 && Date.now() > Number(latest.expires_at);
      if (latest && isExpired) {
        await dbRun(
          "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE vps_ip = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
          [Date.now(), ip, Date.now()]
        ).catch(() => {});
        return res.status(403).json({ ok: false, allowed: false, status: 'expired', message: 'SC expired', ip });
      }
      return res.status(403).json({ ok: false, allowed: false, status: 'rejected', message: 'IP belum terdaftar', ip });
    }

    await dbRun('UPDATE sc_registrations SET last_used_at = ?, updated_at = ? WHERE user_id = ? AND vps_ip = ?', [
      Date.now(),
      Date.now(),
      reg.user_id,
      reg.vps_ip
    ]).catch(() => {});

    const trigger = await getLatestActiveSummaryUpdateTrigger();
    if (!trigger?.version) {
      return res.json({ ok: true, allowed: true, update_required: false, ip: reg.vps_ip });
    }

    const currentVersion = String(req.body?.current_version || '').trim();
    const baseUrl = getBaseUrl(req);
    const summaryApiPath = resolveSummaryApiLocalPath();
    const hasInstaller = fs.existsSync(summaryApiPath);
    const triggerVersion = String(trigger.version);
    const ackStatus = await getSummaryUpdateAckStatus(reg.vps_ip, triggerVersion);
    const alreadySucceeded = ackStatus === 'success';
    const summaryApiUrl = `${baseUrl}/sc1forcr/payload/scripts/setup-summary-api.sh`;

    return res.json({
      ok: true,
      allowed: true,
      update_required: hasInstaller && !alreadySucceeded && currentVersion !== triggerVersion,
      version: triggerVersion,
      note: String(trigger.note || ''),
      created_at: Number(trigger.created_at || 0) || null,
      summary_api_url: hasInstaller ? summaryApiUrl : '',
      ack_status: ackStatus,
      ip: reg.vps_ip
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/sc1forcr/summary-update/ack', requireUpdateClient, async (req, res) => {
  try {
    const keyedReg = req.scUpdateRegistration || null;
    const ip = cleanIp(keyedReg?.vps_ip) || cleanIp(req.body?.ip) || getClientIp(req);
    const reg = keyedReg || (await findActiveRegistrationByIp(ip));
    if (!reg) {
      return res.status(403).json({ ok: false, allowed: false, message: 'IP belum terdaftar atau expired', ip });
    }
    const result = await recordSummaryUpdateAck(
      reg.vps_ip,
      req.body?.version,
      req.body?.status,
      req.body?.message
    );
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, message: 'not found' });
});

Promise.resolve()
  .then(() => initLicenseSigningKeys())
  .then(() => initDb())
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`sc1forcr-license-api listening on ${HOST}:${PORT}`);
      console.log(`license signing key fingerprint: ${licenseSigningKeyFingerprint}`);
      console.log(`legacy bearer compatibility: ${LICENSE_ALLOW_LEGACY_BEARER ? 'enabled' : 'disabled'}`);
    });
  })
  .catch((e) => {
    console.error('license-api start failed:', e.message);
    process.exit(1);
  });

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = String(process.env.DB_PATH || path.join(__dirname, 'sc1forcrnexus.db')).trim();
const PORT = Math.max(1, Number(process.env.LICENSE_API_PORT || 8099) || 8099);
const LICENSE_API_TOKEN = String(process.env.LICENSE_API_TOKEN || '').trim();
const DEFAULT_SC_INSTALLER_LOCAL_PATH = path.join(__dirname, 'scripts', 'setup-autoscript-compat.sh');
const LEGACY_SC_INSTALLER_LOCAL_PATH = path.join(__dirname, 'payload', 'setup-autoscript-compat.sh');
const DEFAULT_SUMMARY_API_LOCAL_PATH = path.join(__dirname, 'scripts', 'setup-summary-api.sh');
const ENV_SC_INSTALLER_LOCAL_PATH = String(process.env.SC_INSTALLER_LOCAL_PATH || '').trim();
const ENV_SUMMARY_API_LOCAL_PATH = String(process.env.SUMMARY_API_LOCAL_PATH || '').trim();
const LICENSE_PUBLIC_BASE_URL = String(process.env.LICENSE_PUBLIC_BASE_URL || '').trim();

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
  await dbRun(`CREATE TABLE IF NOT EXISTS sc_update_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    note TEXT,
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

function cleanIp(raw) {
  const x = String(raw || '').split(',')[0].trim();
  if (!x) return '';
  if (x.startsWith('::ffff:')) return x.replace('::ffff:', '');
  return x;
}

function getClientIp(req) {
  return (
    cleanIp(req.headers['x-real-ip']) ||
    cleanIp(req.headers['x-forwarded-for']) ||
    cleanIp(req.socket?.remoteAddress) ||
    ''
  );
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

function requireBearer(req, res, next) {
  if (!LICENSE_API_TOKEN) {
    return res.status(500).json({ ok: false, message: 'LICENSE_API_TOKEN not configured' });
  }
  const auth = String(req.headers.authorization || '').trim();
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : auth;
  if (!token || token !== LICENSE_API_TOKEN) {
    return res.status(401).json({ ok: false, message: 'unauthorized' });
  }
  return next();
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

async function getLatestActiveUpdateTrigger() {
  return dbGet(
    "SELECT version, note, created_at, triggered_by FROM sc_update_triggers WHERE status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1"
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
    const envLines = [
      'export LICENSE_ENFORCE=1',
      `export LICENSE_API_URL=${shellQuote(activateUrl)}`,
      `export LICENSE_API_TOKEN=${shellQuote(LICENSE_API_TOKEN)}`,
      `export LICENSE_KEY=${shellQuote(`IP_REGISTERED_${ip}`)}`,
      `export UPDATE_SCRIPT_URL=${shellQuote(sourceUrl)}`
    ];
    if (hasLocalSummaryApi) {
      envLines.push(`export SUMMARY_API_SETUP_URL=${shellQuote(summaryApiUrl)}`);
    }
    const script = `#!/usr/bin/env bash
set -euo pipefail

TMP_SC="/tmp/setup-autoscript-compat.sh"

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
    const content = normalizeScriptLineEndings(fs.readFileSync(scInstallerPath, 'utf8'));
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
    const content = normalizeScriptLineEndings(fs.readFileSync(scInstallerPath, 'utf8'));
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

app.post('/sc1forcr/license/activate', requireBearer, async (req, res) => {
  try {
    const ip = cleanIp(req.body?.ip) || getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
    if (!reg) {
      const latest = await findLatestRegistrationByIp(ip);
      const isExpired = Number(latest?.expires_at || 0) > 0 && Date.now() > Number(latest.expires_at);
      if (latest && isExpired) {
        await dbRun(
          "UPDATE sc_registrations SET status = 'expired', updated_at = ? WHERE vps_ip = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?",
          [Date.now(), ip, Date.now()]
        ).catch(() => {});
        return res.status(403).json({
          ok: false,
          allowed: false,
          status: 'expired',
          message: 'Script 1FORCRNEXUS anda sudah expired silahkan perpanjang melalui bot',
          ip,
          expires_at: Number(latest.expires_at || 0) || null
        });
      }
      return res.status(403).json({
        ok: false,
        allowed: false,
        status: 'rejected',
        message: 'IP anda belum terdaftar silahkan melakukan registrasi di bot https://t.me/sc1forcrnexusbot',
        ip
      });
    }
    await dbRun('UPDATE sc_registrations SET last_used_at = ?, updated_at = ? WHERE user_id = ? AND vps_ip = ?', [
      Date.now(),
      Date.now(),
      reg.user_id,
      reg.vps_ip
    ]).catch(() => {});

    return res.json({
      ok: true,
      allowed: true,
      status: 'active',
      message: 'License valid',
      distribution: 'BOT 1FORCR NEXUS',
      client_name: String(reg.client_name || reg.vps_ip || ip).trim(),
      bound_ip: reg.vps_ip,
      user_id: reg.user_id,
      expires_at: Number(reg.expires_at || 0) || null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/sc1forcr/update/check', requireBearer, async (req, res) => {
  try {
    const ip = cleanIp(req.body?.ip) || getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
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

    const trigger = await getLatestActiveUpdateTrigger();
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

app.post('/sc1forcr/update/ack', requireBearer, async (req, res) => {
  try {
    const ip = cleanIp(req.body?.ip) || getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
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

app.post('/sc1forcr/summary-update/check', requireBearer, async (req, res) => {
  try {
    const ip = cleanIp(req.body?.ip) || getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
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

app.post('/sc1forcr/summary-update/ack', requireBearer, async (req, res) => {
  try {
    const ip = cleanIp(req.body?.ip) || getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
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

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`sc1forcr-license-api listening on :${PORT}`);
    });
  })
  .catch((e) => {
    console.error('license-api start failed:', e.message);
    process.exit(1);
  });

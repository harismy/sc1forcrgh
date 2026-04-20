const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = String(process.env.DB_PATH || path.join(__dirname, 'sc1forcrnexus.db')).trim();
const PORT = Math.max(1, Number(process.env.LICENSE_API_PORT || 8099) || 8099);
const LICENSE_API_TOKEN = String(process.env.LICENSE_API_TOKEN || '').trim();
const INSTALL_SCRIPT_URL = String(
  process.env.INSTALL_SCRIPT_URL ||
  'https://raw.githubusercontent.com/harismy/sc1forcr/main/setup-autoscript-compat.sh'
).trim();
const SC_INSTALLER_LOCAL_PATH = String(
  process.env.SC_INSTALLER_LOCAL_PATH || path.join(__dirname, 'payload', 'setup-autoscript-compat.sh')
).trim();
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
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
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
  if (!ip) return null;
  return dbGet(
    "SELECT user_id, vps_ip, status, updated_at FROM sc_registrations WHERE vps_ip = ? AND status = 'active' LIMIT 1",
    [ip]
  );
}

app.get('/health', async (_req, res) => {
  return res.json({ ok: true, service: 'sc1forcr-license-api', db: DB_PATH });
});

app.get('/sc1forcr/installer.sh', async (req, res) => {
  try {
    const allowDomain = await isDomainAllowed(req);
    if (!allowDomain) {
      return res.status(403).type('text/plain').send('Forbidden domain');
    }

    const ip = getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
    if (!reg) {
      return res.type('text/plain').send(renderNotRegisteredBash(ip));
    }

    const baseUrl = getBaseUrl(req);
    const hasLocalInstaller = fs.existsSync(SC_INSTALLER_LOCAL_PATH);
    const sourceUrl = hasLocalInstaller
      ? `${baseUrl}/sc1forcr/payload/setup-autoscript-compat.sh`
      : INSTALL_SCRIPT_URL;
    const activateUrl = `${baseUrl}/sc1forcr/license/activate`;
    const script = `#!/usr/bin/env bash
set -euo pipefail

TMP_SC="/tmp/setup-autoscript-compat.sh"
curl -fsSL "${sourceUrl}" -o "$TMP_SC"
chmod +x "$TMP_SC"

LICENSE_ENFORCE=1 \\
LICENSE_API_URL="${activateUrl}" \\
LICENSE_API_TOKEN="${LICENSE_API_TOKEN}" \\
LICENSE_KEY="IP_REGISTERED_${ip}" \\
bash "$TMP_SC"
`;
    return res.type('text/plain').send(script);
  } catch (e) {
    return res.status(500).type('text/plain').send(`Internal error: ${e.message}`);
  }
});

app.get('/sc1forcr/payload/setup-autoscript-compat.sh', async (req, res) => {
  try {
    const allowDomain = await isDomainAllowed(req);
    if (!allowDomain) return res.status(403).type('text/plain').send('Forbidden domain');
    const ip = getClientIp(req);
    const reg = await findActiveRegistrationByIp(ip);
    if (!reg) return res.type('text/plain').send(renderNotRegisteredBash(ip));
    if (!fs.existsSync(SC_INSTALLER_LOCAL_PATH)) {
      return res.status(404).type('text/plain').send('Installer lokal belum diupload admin.');
    }
    const content = fs.readFileSync(SC_INSTALLER_LOCAL_PATH, 'utf8');
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
      bound_ip: reg.vps_ip,
      user_id: reg.user_id,
      expires_at: null
    });
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

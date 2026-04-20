#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/tunnel-sync}"
APP_NAME="${APP_NAME:-tunnel-summary}"
SUMMARY_PORT="${SUMMARY_PORT:-8789}"
POTATO_DB="${POTATO_DB:-/usr/sbin/potatonc/potato.db}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root (or use sudo)."
  exit 1
fi

log() {
  echo "[setup-summary-api] $*"
}

install_node_if_missing() {
  if command -v node >/dev/null 2>&1; then
    log "Node.js already installed: $(node -v)"
    return
  fi

  log "Installing Node.js 20.x..."
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg apt-transport-https
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  log "Node.js installed: $(node -v)"
}

install_pm2_if_missing() {
  if command -v pm2 >/dev/null 2>&1; then
    log "PM2 already installed: $(pm2 -v)"
    return
  fi

  log "Installing PM2..."
  npm install -g pm2
  log "PM2 installed: $(pm2 -v)"
}

install_vnstat_if_missing() {
  if command -v vnstat >/dev/null 2>&1; then
    log "vnstat already installed: $(vnstat --version | head -n1)"
    return
  fi

  log "Installing vnstat..."
  apt-get update -y
  apt-get install -y vnstat
  systemctl enable vnstat >/dev/null 2>&1 || true
  systemctl restart vnstat >/dev/null 2>&1 || true
  log "vnstat installed"
}

write_files() {
  mkdir -p "${APP_DIR}"

  cat > "${APP_DIR}/summary-api.js" <<'JS'
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = Number(process.env.SUMMARY_PORT || 8789);
const DB = process.env.POTATO_DB || '/usr/sbin/potatonc/potato.db';
const USE_DB_AUTH = String(process.env.USE_DB_AUTH || '1') !== '0';
const STATIC_TOKEN = (process.env.SYNC_TOKEN || '').trim();
const FULL_RESTORE_SCRIPT = String(process.env.FULL_RESTORE_SCRIPT || '/usr/local/sbin/sc-1forcr-restore-backup').trim();
const RESTORE_TMP_DIR = String(process.env.RESTORE_TMP_DIR || '/tmp').trim();
const BANNER_HTML_FILE = String(process.env.BANNER_HTML_FILE || '/etc/sc-1forcr/banner.html').trim();
const BANNER_TXT_FILE = String(process.env.BANNER_TXT_FILE || '/etc/sc-1forcr/banner.txt').trim();

if (!USE_DB_AUTH && !STATIC_TOKEN) {
  console.error('SYNC_TOKEN kosong saat USE_DB_AUTH=0');
  process.exit(1);
}

function sendSummary(db, res) {
  db.get(
    `
    SELECT
      (SELECT COUNT(*) FROM account_sshs    WHERE UPPER(TRIM(status))='AKTIF') AS ssh,
      (SELECT COUNT(*) FROM account_vmesses WHERE UPPER(TRIM(status))='AKTIF') AS vmess,
      (SELECT COUNT(*) FROM account_vlesses WHERE UPPER(TRIM(status))='AKTIF') AS vless,
      (SELECT COUNT(*) FROM account_trojans WHERE UPPER(TRIM(status))='AKTIF') AS trojan
    `,
    (err, row) => {
      db.close();
      if (err) return res.status(500).json({ ok: false, message: err.message });

      const ssh = Number(row?.ssh || 0);
      const vmess = Number(row?.vmess || 0);
      const vless = Number(row?.vless || 0);
      const trojan = Number(row?.trojan || 0);

      return res.json({
        ok: true,
        ssh,
        vmess,
        vless,
        trojan,
        total: ssh + vmess + vless + trojan
      });
    }
  );
}

function sendAccountExpiry(db, res, username) {
  db.get(
    `
    SELECT service, date_exp FROM (
      SELECT 'ssh' AS service, date_exp FROM account_sshs
       WHERE LOWER(username) = LOWER(?) AND UPPER(TRIM(status)) = 'AKTIF'
      UNION ALL
      SELECT 'vmess' AS service, date_exp FROM account_vmesses
       WHERE LOWER(username) = LOWER(?) AND UPPER(TRIM(status)) = 'AKTIF'
      UNION ALL
      SELECT 'vless' AS service, date_exp FROM account_vlesses
       WHERE LOWER(username) = LOWER(?) AND UPPER(TRIM(status)) = 'AKTIF'
      UNION ALL
      SELECT 'trojan' AS service, date_exp FROM account_trojans
       WHERE LOWER(username) = LOWER(?) AND UPPER(TRIM(status)) = 'AKTIF'
      UNION ALL
      SELECT 'udp_http' AS service, date_exp FROM account_sshs
       WHERE LOWER(username) = LOWER(?) AND UPPER(TRIM(status)) = 'AKTIF'
      UNION ALL
      SELECT 'zivpn' AS service, date_exp FROM account_sshs
       WHERE LOWER(username) = LOWER(?) AND UPPER(TRIM(status)) = 'AKTIF'
    ) q
    ORDER BY date(date_exp) DESC
    LIMIT 1
    `,
    [username, username, username, username, username, username],
    (err, row) => {
      db.close();
      if (err) return res.status(500).json({ ok: false, message: err.message });
      if (!row) return res.json({ ok: true, found: false });

      return res.json({
        ok: true,
        found: true,
        service: String(row.service || '').toLowerCase(),
        date_exp: String(row.date_exp || '').trim()
      });
    }
  );
}

function sendExpirySummary(db, res, dateYmd) {
  db.get(
    `
    SELECT
      (SELECT COUNT(*) FROM account_sshs    WHERE date(date_exp)=date(?) ) AS ssh,
      (SELECT COUNT(*) FROM account_vmesses WHERE date(date_exp)=date(?) ) AS vmess,
      (SELECT COUNT(*) FROM account_vlesses WHERE date(date_exp)=date(?) ) AS vless,
      (SELECT COUNT(*) FROM account_trojans WHERE date(date_exp)=date(?) ) AS trojan
    `,
    [dateYmd, dateYmd, dateYmd, dateYmd],
    (err, row) => {
      db.close();
      if (err) return res.status(500).json({ ok: false, message: err.message });

      const ssh = Number(row?.ssh || 0);
      const vmess = Number(row?.vmess || 0);
      const vless = Number(row?.vless || 0);
      const trojan = Number(row?.trojan || 0);
      const totalExpired = ssh + vmess + vless + trojan;

      return res.json({
        ok: true,
        date: dateYmd,
        ssh,
        vmess,
        vless,
        trojan,
        total_expired: totalExpired
      });
    }
  );
}

function bytesToGb(bytes) {
  return Number(bytes || 0) / (1024 * 1024 * 1024);
}

function isSshLikeType(rawType) {
  const type = String(rawType || '').trim().toLowerCase();
  return type === 'ssh' || type === 'zivpn' || type === 'udp_http';
}

function isValidUnixUsername(username) {
  return /^[a-z0-9][a-z0-9_-]{2,31}$/.test(String(username || '').trim());
}

function syncSshLinuxUsers(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const row of rows) {
    const username = String(row?.username || '').trim();
    if (!isValidUnixUsername(username)) {
      skipped += 1;
      continue;
    }

    const password = String(row?.password || username).trim() || username;
    const dateExp = String(row?.date_exp || '').trim();
    const homeDir = `/home/${username}`;

    try {
      let exists = true;
      try {
        execFileSync('id', ['-u', username], { stdio: 'ignore' });
      } catch (_) {
        exists = false;
      }

      if (!exists) {
        execFileSync('useradd', ['-m', '-d', homeDir, '-s', '/bin/bash', username], { stdio: 'ignore' });
        created += 1;
      } else {
        updated += 1;
      }

      try { fs.mkdirSync(homeDir, { recursive: true }); } catch (_) {}
      execFileSync('chown', ['-R', `${username}:${username}`, homeDir], { stdio: 'ignore' });
      execFileSync('usermod', ['-d', homeDir, '-s', '/bin/bash', username], { stdio: 'ignore' });
      execFileSync('chpasswd', [], { input: `${username}:${password}\n` });

      if (/^\d{4}-\d{2}-\d{2}$/.test(dateExp)) {
        execFileSync('chage', ['-E', dateExp, username], { stdio: 'ignore' });
      }
    } catch (err) {
      failed += 1;
      errors.push(`${username}: ${err.message}`);
    }
  }

  return {
    ok: failed === 0,
    created,
    updated,
    skipped,
    failed,
    errors
  };
}

function deleteSshLinuxUsers(usernamesInput) {
  const usernames = Array.isArray(usernamesInput)
    ? usernamesInput.map((v) => String(v || '').trim()).filter(Boolean)
    : [];

  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const username of usernames) {
    if (!isValidUnixUsername(username)) {
      skipped += 1;
      continue;
    }
    try {
      try {
        execFileSync('id', ['-u', username], { stdio: 'ignore' });
      } catch (_) {
        skipped += 1;
        continue;
      }
      execFileSync('userdel', ['-r', username], { stdio: 'ignore' });
      deleted += 1;
    } catch (err) {
      failed += 1;
      errors.push(`${username}: ${err.message}`);
    }
  }

  return { ok: failed === 0, deleted, skipped, failed, errors };
}

function getEntryDateParts(entry) {
  const idObj = (entry && typeof entry.id === 'object' && entry.id !== null) ? entry.id : null;
  const dateObj = (entry && typeof entry.date === 'object' && entry.date !== null) ? entry.date : null;
  const src = idObj || dateObj || {};
  return {
    year: Number(src?.year || 0),
    month: Number(src?.month || 0),
    day: Number(src?.day || 0)
  };
}

function safeDateFromEntry(entry) {
  const parts = getEntryDateParts(entry);
  const y = Number(parts.year || 0);
  const m = Number(parts.month || 0);
  const d = Number(parts.day || 0);
  if (!y || !m || !d) return 0;
  return new Date(y, m - 1, d).getTime();
}

function pickLatestDayEntry(dayEntries) {
  if (!Array.isArray(dayEntries) || dayEntries.length === 0) return null;
  return dayEntries.reduce((latest, item) => {
    if (!latest) return item;
    return safeDateFromEntry(item) > safeDateFromEntry(latest) ? item : latest;
  }, null);
}

function pickDayEntryForToday(dayEntries) {
  if (!Array.isArray(dayEntries) || dayEntries.length === 0) return null;
  const now = new Date();
  const yy = now.getFullYear();
  const mm = now.getMonth() + 1;
  const dd = now.getDate();
  const today = dayEntries.find((entry) => {
    const p = getEntryDateParts(entry);
    return Number(p.year) === yy && Number(p.month) === mm && Number(p.day) === dd;
  });
  if (today) return today;
  return pickLatestDayEntry(dayEntries);
}

function pickCurrentMonthEntry(monthEntries) {
  if (!Array.isArray(monthEntries) || monthEntries.length === 0) return null;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const exact = monthEntries.find((m) => {
    const idObj = (m && typeof m.id === 'object' && m.id !== null) ? m.id : null;
    const dateObj = (m && typeof m.date === 'object' && m.date !== null) ? m.date : null;
    const src = idObj || dateObj || {};
    return Number(src?.year) === year && Number(src?.month) === month;
  });
  if (exact) return exact;
  return monthEntries[monthEntries.length - 1] || null;
}

function sendVnstatDaily(res) {
  execFile('vnstat', ['--json'], { timeout: 15000, maxBuffer: 1024 * 1024 * 4 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ ok: false, message: `vnstat exec gagal: ${err.message}` });
    }

    let parsed;
    try {
      parsed = JSON.parse(String(stdout || '{}'));
    } catch (parseErr) {
      return res.status(500).json({ ok: false, message: `vnstat json invalid: ${parseErr.message}` });
    }

    const interfaces = Array.isArray(parsed.interfaces) ? parsed.interfaces : [];
    if (interfaces.length === 0) {
      return res.status(500).json({ ok: false, message: 'tidak ada interface vnstat' });
    }

    let totalRxBytes = 0;
    let totalTxBytes = 0;
    let totalMonthBytes = 0;
    let latestDate = '';
    let latestDateTs = 0;

    for (const iface of interfaces) {
      const name = String(iface?.name || '').toLowerCase();
      if (name === 'lo' || name.startsWith('ifb')) continue;

      const dayEntry = pickDayEntryForToday(iface?.traffic?.day || []);
      if (dayEntry) {
        totalRxBytes += Number(dayEntry.rx || 0);
        totalTxBytes += Number(dayEntry.tx || 0);
        const d = getEntryDateParts(dayEntry);
        const ts = safeDateFromEntry(dayEntry);
        if (ts > 0 && ts >= latestDateTs && d.year > 0 && d.month > 0 && d.day > 0) {
          const y = String(d.year).padStart(4, '0');
          const m = String(d.month).padStart(2, '0');
          const day = String(d.day).padStart(2, '0');
          latestDateTs = ts;
          latestDate = `${y}-${m}-${day}`;
        }
      }

      const monthEntry = pickCurrentMonthEntry(iface?.traffic?.month || []);
      if (monthEntry) {
        totalMonthBytes += Number(monthEntry.rx || 0) + Number(monthEntry.tx || 0);
      }
    }

    const totalBytes = totalRxBytes + totalTxBytes;
    const rxGb = bytesToGb(totalRxBytes);
    const txGb = bytesToGb(totalTxBytes);
    const totalGb = bytesToGb(totalBytes);
    const monthTotalGb = bytesToGb(totalMonthBytes);

    return res.json({
      ok: true,
      date: latestDate || new Date().toISOString().slice(0, 10),
      rx_gb: Number(rxGb.toFixed(3)),
      tx_gb: Number(txGb.toFixed(3)),
      total_gb: Number(totalGb.toFixed(3)),
      month_total_gb: Number(monthTotalGb.toFixed(3)),
      month_total_tb: Number((monthTotalGb / 1024).toFixed(4))
    });
  });
}

function getAccountTableByType(rawType) {
  const type = String(rawType || '').trim().toLowerCase();
  if (type === 'ssh' || type === 'udp_http' || type === 'zivpn') return 'account_sshs';
  if (type === 'vmess') return 'account_vmesses';
  if (type === 'vless') return 'account_vlesses';
  if (type === 'trojan') return 'account_trojans';
  return '';
}

function detectZivpnUsersContainer(root) {
  if (Array.isArray(root)) {
    return { root, users: root, key: null, style: 'array_object' };
  }
  const obj = (root && typeof root === 'object') ? root : {};
  if (obj.auth && typeof obj.auth === 'object' && Array.isArray(obj.auth.config)) {
    return { root: obj, users: obj.auth.config, key: 'auth.config', style: 'auth_config' };
  }
  if (Array.isArray(obj.users)) return { root: obj, users: obj.users, key: 'users', style: 'array_object' };
  if (Array.isArray(obj.accounts)) return { root: obj, users: obj.accounts, key: 'accounts', style: 'array_object' };
  if (Array.isArray(obj.clients)) return { root: obj, users: obj.clients, key: 'clients', style: 'array_object' };
  obj.users = [];
  return { root: obj, users: obj.users, key: 'users', style: 'array_object' };
}

function mergeZivpnConfigFromSshAccounts(accounts) {
  const cfgPath = process.env.ZIVPN_CONFIG || '/etc/zivpn/config.json';
  let raw = '{}';
  try {
    if (fs.existsSync(cfgPath)) {
      raw = fs.readFileSync(cfgPath, 'utf8');
    }
  } catch (readErr) {
    return { ok: false, message: `gagal baca config zivpn: ${readErr.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    return { ok: false, message: `config zivpn bukan JSON valid: ${parseErr.message}` };
  }

  const container = detectZivpnUsersContainer(parsed);
  if (container.style === 'auth_config') {
    // Pakai satu sumber kebenaran di auth.config (mode passwords).
    delete container.root.users;
    delete container.root.accounts;
    delete container.root.clients;
  }
  const list = container.users;
  const identity = (entry) => {
    if (container.style === 'auth_config') return String(entry || '').trim().toLowerCase();
    return String(entry?.username ?? entry?.user ?? entry?.name ?? entry?.password ?? '').trim().toLowerCase();
  };
  const existing = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const id = identity(list[i]);
    if (id) existing.set(id, i);
  }

  const sample = list.length > 0 && typeof list[0] === 'object' ? list[0] : null;
  const passwordOnlyStyle = sample && ('password' in sample) && !('username' in sample) && !('user' in sample) && !('name' in sample);

  let added = 0;
  let updated = 0;

  for (const row of accounts) {
    const username = String(row?.username || '').trim();
    if (!username) continue;
    if (container.style === 'auth_config') {
      const key = username.toLowerCase();
      if (!existing.has(key)) {
        list.push(username);
        existing.set(key, list.length - 1);
        added += 1;
      } else {
        const idx = existing.get(key);
        if (Number.isInteger(idx)) list[idx] = username;
        updated += 1;
      }
      continue;
    }

    const sshPass = String(row?.password || '').trim();
    const key = username.toLowerCase();
    const idx = existing.get(key);
    if (idx === undefined) {
      if (passwordOnlyStyle) {
        list.push({ password: username });
      } else {
        list.push({ username, password: sshPass || username });
      }
      existing.set(key, list.length - 1);
      added += 1;
      continue;
    }

    const entry = list[idx];
    if (entry && typeof entry === 'object') {
      if (passwordOnlyStyle) {
        entry.password = username;
      } else {
        if ('username' in entry || (!('user' in entry) && !('name' in entry))) entry.username = username;
        if ('password' in entry || !('pass' in entry)) entry.password = sshPass || username;
      }
      updated += 1;
    }
  }

  try {
    fs.writeFileSync(cfgPath, JSON.stringify(container.root, null, 2));
  } catch (writeErr) {
    return { ok: false, message: `gagal tulis config zivpn: ${writeErr.message}` };
  }

  return { ok: true, path: cfgPath, added, updated };
}

function removeZivpnUsersByUsername(usernamesInput) {
  const usernames = Array.isArray(usernamesInput)
    ? usernamesInput.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  if (usernames.length === 0) return { ok: true, removed: 0 };

  const cfgPath = process.env.ZIVPN_CONFIG || '/etc/zivpn/config.json';
  let raw = '{}';
  try {
    if (fs.existsSync(cfgPath)) raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (readErr) {
    return { ok: false, message: `gagal baca config zivpn: ${readErr.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    return { ok: false, message: `config zivpn bukan JSON valid: ${parseErr.message}` };
  }

  const container = detectZivpnUsersContainer(parsed);
  if (container.style === 'auth_config') {
    // Jangan simpan duplikasi array user lain saat mode auth.config dipakai.
    delete container.root.users;
    delete container.root.accounts;
    delete container.root.clients;
  }
  const set = new Set(usernames.map((u) => u.toLowerCase()));
  const before = container.users.length;
  container.users = container.users.filter((entry) => {
    const id = container.style === 'auth_config'
      ? String(entry || '').trim().toLowerCase()
      : String(entry?.username ?? entry?.user ?? entry?.name ?? entry?.password ?? '').trim().toLowerCase();
    return !set.has(id);
  });
  if (container.key === 'auth.config') {
    container.root.auth.config = container.users;
  } else if (container.key) {
    container.root[container.key] = container.users;
  }

  try {
    fs.writeFileSync(cfgPath, JSON.stringify(container.root, null, 2));
  } catch (writeErr) {
    return { ok: false, message: `gagal tulis config zivpn: ${writeErr.message}` };
  }

  return { ok: true, removed: Math.max(0, before - container.users.length) };
}

function clearAllZivpnUsers() {
  const cfgPath = process.env.ZIVPN_CONFIG || '/etc/zivpn/config.json';
  let raw = '{}';
  try {
    if (fs.existsSync(cfgPath)) raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (readErr) {
    return { ok: false, message: `gagal baca config zivpn: ${readErr.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    return { ok: false, message: `config zivpn bukan JSON valid: ${parseErr.message}` };
  }

  const container = detectZivpnUsersContainer(parsed);
  const before = Array.isArray(container.users) ? container.users.length : 0;
  container.users = [];
  if (container.key === 'auth.config') {
    if (!container.root.auth || typeof container.root.auth !== 'object') container.root.auth = {};
    container.root.auth.config = container.users;
  } else if (container.key) {
    container.root[container.key] = container.users;
  }

  // Jika format auth.config dipakai, pastikan tidak ada duplikasi array lain.
  if (container.style === 'auth_config') {
    delete container.root.users;
    delete container.root.accounts;
    delete container.root.clients;
  }

  try {
    fs.writeFileSync(cfgPath, JSON.stringify(container.root, null, 2));
  } catch (writeErr) {
    return { ok: false, message: `gagal tulis config zivpn: ${writeErr.message}` };
  }

  return { ok: true, removed: before, path: cfgPath };
}

function restoreZivpnConfig(configInput) {
  if (!configInput || typeof configInput !== 'object') {
    return { ok: false, message: 'config harus JSON object' };
  }

  const cfgPath = process.env.ZIVPN_CONFIG || '/etc/zivpn/config.json';
  const clone = JSON.parse(JSON.stringify(configInput));

  // Validasi minimum agar tidak menulis file random.
  if (!clone.auth || typeof clone.auth !== 'object' || !Array.isArray(clone.auth.config)) {
    return { ok: false, message: 'config.auth.config wajib ada dan harus array' };
  }

  try {
    fs.writeFileSync(cfgPath, JSON.stringify(clone, null, 2));
  } catch (writeErr) {
    return { ok: false, message: `gagal tulis config zivpn: ${writeErr.message}` };
  }

  return { ok: true, path: cfgPath, total: clone.auth.config.length };
}

function sendExportZivpnConfig(res) {
  const cfgPath = process.env.ZIVPN_CONFIG || '/etc/zivpn/config.json';
  try {
    if (!fs.existsSync(cfgPath)) {
      return res.status(404).json({ ok: false, message: `config tidak ditemukan: ${cfgPath}` });
    }
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return res.json({
      ok: true,
      path: cfgPath,
      config: parsed
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: `gagal export config zivpn: ${err.message}` });
  }
}

function sendExportZivpnAuth(res) {
  const cfgPath = process.env.ZIVPN_CONFIG || '/etc/zivpn/config.json';
  try {
    if (!fs.existsSync(cfgPath)) {
      return res.status(404).json({ ok: false, message: `config tidak ditemukan: ${cfgPath}` });
    }
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const authList = Array.isArray(parsed?.auth?.config) ? parsed.auth.config : [];
    const users = [];
    const seen = new Set();
    for (const item of authList) {
      const v = String(item || '').trim().toLowerCase();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      users.push(v);
    }
    return res.json({ ok: true, path: cfgPath, total: users.length, users });
  } catch (err) {
    return res.status(500).json({ ok: false, message: `gagal export auth zivpn: ${err.message}` });
  }
}

function restoreZivpnAuth(usersInput) {
  const cfgPath = process.env.ZIVPN_CONFIG || '/etc/zivpn/config.json';
  const raw = Array.isArray(usersInput) ? usersInput : [];
  const users = [];
  const seen = new Set();
  for (const item of raw) {
    const v = String(item || '').trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    users.push(v);
  }

  let root = {};
  try {
    if (fs.existsSync(cfgPath)) {
      root = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch (_) {
    root = {};
  }
  if (!root || typeof root !== 'object') root = {};
  if (!root.auth || typeof root.auth !== 'object') root.auth = {};
  root.auth.mode = 'passwords';
  root.auth.config = users;

  try {
    fs.writeFileSync(cfgPath, JSON.stringify(root, null, 2));
  } catch (err) {
    return { ok: false, message: `gagal tulis auth zivpn: ${err.message}` };
  }

  return { ok: true, path: cfgPath, total: users.length };
}

function sendExportBannerConfig(res) {
  try {
    const out = {
      ok: true,
      banner_html: '',
      banner_txt: '',
      html_path: BANNER_HTML_FILE,
      txt_path: BANNER_TXT_FILE
    };
    if (BANNER_HTML_FILE && fs.existsSync(BANNER_HTML_FILE)) {
      out.banner_html = fs.readFileSync(BANNER_HTML_FILE, 'utf8');
    }
    if (BANNER_TXT_FILE && fs.existsSync(BANNER_TXT_FILE)) {
      out.banner_txt = fs.readFileSync(BANNER_TXT_FILE, 'utf8');
    }
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, message: `gagal export banner: ${err.message}` });
  }
}

function restoreBannerConfig(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'payload banner harus object' };
  }
  const hasHtml = Object.prototype.hasOwnProperty.call(payload, 'banner_html');
  const hasTxt = Object.prototype.hasOwnProperty.call(payload, 'banner_txt');
  const html = hasHtml ? String(payload.banner_html || '') : null;
  const txt = hasTxt ? String(payload.banner_txt || '') : null;
  if (!hasHtml && !hasTxt) {
    return { ok: false, message: 'banner_html atau banner_txt wajib diisi' };
  }

  try {
    fs.mkdirSync('/etc/sc-1forcr', { recursive: true });
    if (hasHtml) {
      if (html) fs.writeFileSync(BANNER_HTML_FILE, html, 'utf8');
      else if (fs.existsSync(BANNER_HTML_FILE)) fs.unlinkSync(BANNER_HTML_FILE);
    }
    if (hasTxt) {
      if (txt) fs.writeFileSync(BANNER_TXT_FILE, txt, 'utf8');
      else if (fs.existsSync(BANNER_TXT_FILE)) fs.unlinkSync(BANNER_TXT_FILE);
    }
    if (fs.existsSync(BANNER_HTML_FILE)) fs.chmodSync(BANNER_HTML_FILE, 0o644);
    if (fs.existsSync(BANNER_TXT_FILE)) fs.chmodSync(BANNER_TXT_FILE, 0o644);
  } catch (err) {
    return { ok: false, message: `gagal restore banner: ${err.message}` };
  }

  return {
    ok: true,
    html_written: hasHtml && !!html,
    txt_written: hasTxt && !!txt,
    html_path: BANNER_HTML_FILE,
    txt_path: BANNER_TXT_FILE
  };
}

function sendExportAccounts(db, res, rawType, rawLimit) {
  const type = String(rawType || '').trim().toLowerCase();
  const table = getAccountTableByType(type);
  if (!table) {
    db.close();
    return res.status(400).json({ ok: false, message: 'type tidak valid' });
  }

  const limit = Math.max(1, Math.min(50000, Number(rawLimit || 1000)));
  db.all(
    `SELECT * FROM ${table} WHERE UPPER(TRIM(COALESCE(status, '')))='AKTIF' ORDER BY rowid DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      db.close();
      if (err) return res.status(500).json({ ok: false, message: err.message });
      return res.json({
        ok: true,
        type,
        table,
        exported: Array.isArray(rows) ? rows.length : 0,
        accounts: Array.isArray(rows) ? rows : []
      });
    }
  );
}

function sendImportAccounts(db, res, rawType, accountsInput) {
  const type = String(rawType || '').trim().toLowerCase();
  const table = getAccountTableByType(type);
  if (!table) {
    db.close();
    return res.status(400).json({ ok: false, message: 'type tidak valid' });
  }

  const accounts = Array.isArray(accountsInput) ? accountsInput : [];
  if (accounts.length === 0) {
    db.close();
    return res.status(400).json({ ok: false, message: 'accounts kosong' });
  }

  db.all(`PRAGMA table_info(${table})`, [], (schemaErr, schemaRows) => {
    if (schemaErr) {
      db.close();
      return res.status(500).json({ ok: false, message: schemaErr.message });
    }

    const columns = (Array.isArray(schemaRows) ? schemaRows : []).map((c) => String(c.name || '').trim()).filter(Boolean);
    if (!columns.includes('username')) {
      db.close();
      return res.status(500).json({ ok: false, message: `kolom username tidak ada di ${table}` });
    }

    const insertCols = columns.filter((col) => accounts.some((row) => Object.prototype.hasOwnProperty.call(row || {}, col)));
    if (!insertCols.includes('username')) insertCols.unshift('username');

    const placeholders = insertCols.map(() => '?').join(',');
    const sql = `INSERT OR REPLACE INTO ${table} (${insertCols.join(',')}) VALUES (${placeholders})`;
    const stmt = db.prepare(sql);

    let imported = 0;
    let skipped = 0;
    const importedUsernames = [];
    let hasError = null;
    let pending = 0;

    const finalize = () => {
      stmt.finalize(() => {
        if (hasError) {
          return db.run('ROLLBACK', () => {
            db.close();
            return res.status(500).json({ ok: false, message: hasError.message || String(hasError) });
          });
        }

        return db.run('COMMIT', () => {
          let linuxUserSync = null;
          let zivpnServiceReload = null;
          if (isSshLikeType(type)) {
            linuxUserSync = syncSshLinuxUsers(accounts);
          }
          if (type === 'zivpn') {
            const zivpnResult = mergeZivpnConfigFromSshAccounts(accounts);
            if (!zivpnResult.ok) {
              db.close();
              return res.status(500).json({ ok: false, message: zivpnResult.message, imported, skipped });
            }
            zivpnServiceReload = reloadZivpnService();
          }
          db.close();
          if (linuxUserSync && !linuxUserSync.ok) {
            return res.status(500).json({
              ok: false,
              message: 'sync user linux gagal sebagian',
              type,
              table,
              imported,
              skipped,
              usernames: importedUsernames,
              linux_user_sync: linuxUserSync
            });
          }
          return res.json({
            ok: true,
            type,
            table,
            imported,
            skipped,
            usernames: importedUsernames,
            linux_user_sync: linuxUserSync || null,
            zivpn_service_reload: zivpnServiceReload
          });
        });
      });
    };

    db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
      if (beginErr) {
        db.close();
        return res.status(500).json({ ok: false, message: beginErr.message });
      }

      for (const row of accounts) {
        const username = String(row?.username || '').trim();
        if (!username) {
          skipped += 1;
          continue;
        }
        const values = insertCols.map((col) => {
          if (col === 'username') return username;
          const val = row?.[col];
          return val === undefined ? null : val;
        });

        pending += 1;
        stmt.run(values, (runErr) => {
          if (runErr && !hasError) hasError = runErr;
          if (!runErr) {
            imported += 1;
            importedUsernames.push(username);
          }
          if (runErr) skipped += 1;
          pending -= 1;
          if (pending === 0) finalize();
        });
      }

      if (pending === 0) finalize();
    });
  });
}

function sendDeleteAccounts(db, res, rawType, usernamesInput) {
  const type = String(rawType || '').trim().toLowerCase();
  const table = getAccountTableByType(type);
  if (!table) {
    db.close();
    return res.status(400).json({ ok: false, message: 'type tidak valid' });
  }

  const usernames = Array.isArray(usernamesInput)
    ? usernamesInput.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  if (usernames.length === 0) {
    db.close();
    return res.status(400).json({ ok: false, message: 'usernames kosong' });
  }

  const stmt = db.prepare(`DELETE FROM ${table} WHERE LOWER(username) = LOWER(?)`);
  let deleted = 0;
  let pending = 0;
  let hasError = null;

  const finalize = () => {
    stmt.finalize(() => {
      if (hasError) {
        return db.run('ROLLBACK', () => {
          db.close();
          return res.status(500).json({ ok: false, message: hasError.message || String(hasError) });
        });
      }

      return db.run('COMMIT', () => {
        let linuxUserDelete = null;
        let zivpnServiceReload = null;
        if (isSshLikeType(type)) {
          linuxUserDelete = deleteSshLinuxUsers(usernames);
        }
        if (type === 'zivpn') {
          const removeResult = removeZivpnUsersByUsername(usernames);
          if (!removeResult.ok) {
            db.close();
            return res.status(500).json({ ok: false, message: removeResult.message, deleted });
          }
          zivpnServiceReload = reloadZivpnService();
        }
        db.close();
        if (linuxUserDelete && !linuxUserDelete.ok) {
          return res.status(500).json({
            ok: false,
            message: 'hapus user linux gagal sebagian',
            type,
            table,
            deleted,
            linux_user_delete: linuxUserDelete
          });
        }
        return res.json({
          ok: true,
          type,
          table,
          deleted,
          linux_user_delete: linuxUserDelete || null,
          zivpn_service_reload: zivpnServiceReload
        });
      });
    });
  };

  db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
    if (beginErr) {
      db.close();
      return res.status(500).json({ ok: false, message: beginErr.message });
    }

    for (const username of usernames) {
      pending += 1;
      stmt.run([username], function onRun(runErr) {
        if (runErr && !hasError) hasError = runErr;
        if (!runErr) deleted += Number(this?.changes || 0);
        pending -= 1;
        if (pending === 0) finalize();
      });
    }

    if (pending === 0) finalize();
  });
}

function sendDeleteAllAccounts(db, res, rawType) {
  const type = String(rawType || '').trim().toLowerCase();
  if (!isSshLikeType(type)) {
    db.close();
    return res.status(400).json({ ok: false, message: 'delete-all hanya untuk ssh/udp_http/zivpn' });
  }

  const table = getAccountTableByType(type);
  if (!table) {
    db.close();
    return res.status(400).json({ ok: false, message: 'type tidak valid' });
  }

  db.all(
    `SELECT username FROM ${table}`,
    [],
    (listErr, rows) => {
      if (listErr) {
        db.close();
        return res.status(500).json({ ok: false, message: listErr.message });
      }

      const usernames = (Array.isArray(rows) ? rows : [])
        .map((r) => String(r?.username || '').trim())
        .filter(Boolean);

      db.run(`DELETE FROM ${table}`, [], function onDelete(delErr) {
        if (delErr) {
          db.close();
          return res.status(500).json({ ok: false, message: delErr.message });
        }

        const deletedDb = Number(this?.changes || 0);
        const linuxUserDelete = deleteSshLinuxUsers(usernames);
        const zivpnDelete = type === 'zivpn'
          ? clearAllZivpnUsers()
          : removeZivpnUsersByUsername(usernames);
        const zivpnServiceReload = type === 'zivpn' ? reloadZivpnService() : null;
        db.close();

        if (!zivpnDelete.ok) {
          return res.status(500).json({
            ok: false,
            message: zivpnDelete.message,
            deleted_db: deletedDb,
            linux_user_delete: linuxUserDelete
          });
        }

        if (!linuxUserDelete.ok) {
          return res.status(500).json({
            ok: false,
            message: 'hapus user linux gagal sebagian',
            deleted_db: deletedDb,
            linux_user_delete: linuxUserDelete
          });
        }

        return res.json({
          ok: true,
          type,
          table,
          deleted_db: deletedDb,
          deleted_zivpn: Number(zivpnDelete.removed || 0),
          linux_user_delete: linuxUserDelete,
          zivpn_service_reload: zivpnServiceReload
        });
      });
    }
  );
}

function getZivpnServiceCandidates() {
  const fromEnv = String(process.env.ZIVPN_SERVICE || '').trim();
  const defaults = ['zivpn', 'zivpn.service', 'udp-custom', 'udp-custom.service'];
  return fromEnv ? [fromEnv, ...defaults] : defaults;
}

function tryServiceAction(action, serviceName) {
  const act = String(action || '').trim().toLowerCase();
  const svc = String(serviceName || '').trim();
  if (!svc) return false;
  if (!['start', 'stop', 'restart', 'status'].includes(act)) return false;

  try {
    if (act === 'status') {
      const out = execFileSync('systemctl', ['is-active', svc], { stdio: ['ignore', 'pipe', 'pipe'] });
      return String(out || '').trim();
    }
    execFileSync('systemctl', [act, svc], { stdio: 'ignore' });
    return true;
  } catch (_) {
    try {
      if (act === 'status') {
        execFileSync('service', [svc, 'status'], { stdio: 'ignore' });
        return 'active';
      }
      execFileSync('service', [svc, act], { stdio: 'ignore' });
      return true;
    } catch (__){
      return false;
    }
  }
}

function controlZivpnService(action) {
  const act = String(action || '').trim().toLowerCase();
  if (!['start', 'stop', 'restart', 'status'].includes(act)) {
    return { ok: false, message: 'action harus start/stop/restart/status' };
  }

  const candidates = getZivpnServiceCandidates();
  for (const svc of candidates) {
    const result = tryServiceAction(act, svc);
    if (result) {
      return { ok: true, action: act, service: svc, status: typeof result === 'string' ? result : undefined };
    }
  }

  return {
    ok: false,
    message: 'service zivpn tidak ditemukan. Set env ZIVPN_SERVICE pada .env jika nama service custom.',
    tried: candidates
  };
}

function reloadZivpnService() {
  const restart = controlZivpnService('restart');
  if (restart.ok) {
    return { ok: true, method: 'restart', service: restart.service };
  }

  const stop = controlZivpnService('stop');
  const start = controlZivpnService('start');
  if (stop.ok && start.ok) {
    return { ok: true, method: 'stop+start', service: start.service || stop.service };
  }

  return {
    ok: false,
    message: 'gagal reload service zivpn',
    restart,
    stop,
    start
  };
}

function isAllowedTelegramFileUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  return /^https:\/\/api\.telegram\.org\/file\/bot[^/]+\/.+$/i.test(url);
}

function safeFileToken(raw) {
  const token = String(raw || '').trim();
  if (!token) return 'backup';
  return token.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'backup';
}

function runFullBackupRestoreFromUrl(fileUrl, fileNameInput) {
  if (!isAllowedTelegramFileUrl(fileUrl)) {
    return { ok: false, statusCode: 400, message: 'file_url tidak valid (hanya telegram file URL).' };
  }
  if (!fs.existsSync(FULL_RESTORE_SCRIPT)) {
    return { ok: false, statusCode: 500, message: `restore script tidak ditemukan: ${FULL_RESTORE_SCRIPT}` };
  }

  const fileName = String(fileNameInput || '').trim().toLowerCase();
  if (!(fileName.endsWith('.tar.gz') || fileName.endsWith('.tgz'))) {
    return { ok: false, statusCode: 400, message: 'file_name harus .tar.gz atau .tgz' };
  }

  const stamp = Date.now();
  const tmpName = `sc1forcr-restore-${safeFileToken(fileName || `backup-${stamp}.tar.gz`)}`;
  const tmpPath = `${RESTORE_TMP_DIR}/${tmpName}`;

  try {
    execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', String(fileUrl), '-o', tmpPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 3 * 60 * 1000
    });
    execFileSync('tar', ['-tzf', tmpPath], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60 * 1000 });
    execFileSync(FULL_RESTORE_SCRIPT, [tmpPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10 * 60 * 1000
    });

    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return {
      ok: true,
      restored: true,
      file: fileName,
      services_restarted: true
    };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return {
      ok: false,
      statusCode: 500,
      message: err?.message || 'restore full backup gagal'
    };
  }
}

function authorizeAndRun(req, res, runHandler) {
  const incomingToken = String(req.headers['x-sync-token'] || '').trim();
  if (!incomingToken) {
    return res.status(401).json({ ok: false, message: 'unauthorized' });
  }

  const db = new sqlite3.Database(DB);

  if (USE_DB_AUTH) {
    db.get('SELECT COUNT(*) AS c FROM servers WHERE "key" = ?', [incomingToken], (authErr, authRow) => {
      if (authErr) {
        db.close();
        return res.status(500).json({ ok: false, message: authErr.message });
      }
      if (!authRow || Number(authRow.c || 0) < 1) {
        db.close();
        return res.status(401).json({ ok: false, message: 'unauthorized' });
      }
      return runHandler(db);
    });
    return;
  }

  if (incomingToken !== STATIC_TOKEN) {
    db.close();
    return res.status(401).json({ ok: false, message: 'unauthorized' });
  }

  return runHandler(db);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tunnel-summary', useDbAuth: USE_DB_AUTH });
});

app.get('/internal/account-summary', (req, res) => {
  return authorizeAndRun(req, res, (db) => sendSummary(db, res));
});

app.get('/internal/account-expiry', (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username) {
    return res.status(400).json({ ok: false, message: 'username required' });
  }
  return authorizeAndRun(req, res, (db) => sendAccountExpiry(db, res, username));
});

app.get('/internal/expiry-summary', (req, res) => {
  const dateYmd = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    return res.status(400).json({ ok: false, message: 'date must be YYYY-MM-DD' });
  }
  return authorizeAndRun(req, res, (db) => sendExpirySummary(db, res, dateYmd));
});

app.get('/internal/vnstat-daily', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    return sendVnstatDaily(res);
  });
});

app.get('/internal/export-accounts', (req, res) => {
  const type = String(req.query.type || '').trim();
  const limit = Number(req.query.limit || 0);
  return authorizeAndRun(req, res, (db) => sendExportAccounts(db, res, type, limit));
});

app.get('/internal/export-zivpn-config', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    return sendExportZivpnConfig(res);
  });
});

app.get('/internal/export-zivpn-auth', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    return sendExportZivpnAuth(res);
  });
});

app.get('/internal/export-banner-config', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    return sendExportBannerConfig(res);
  });
});

app.post('/internal/import-accounts', (req, res) => {
  const type = String(req.body?.type || '').trim();
  const accounts = req.body?.accounts;
  return authorizeAndRun(req, res, (db) => sendImportAccounts(db, res, type, accounts));
});

app.post('/internal/delete-accounts', (req, res) => {
  const type = String(req.body?.type || '').trim();
  const usernames = req.body?.usernames;
  return authorizeAndRun(req, res, (db) => sendDeleteAccounts(db, res, type, usernames));
});

app.post('/internal/delete-all-accounts', (req, res) => {
  const type = String(req.body?.type || '').trim();
  return authorizeAndRun(req, res, (db) => sendDeleteAllAccounts(db, res, type));
});

app.post('/internal/restore-zivpn-config', (req, res) => {
  const config = req.body?.config;
  return authorizeAndRun(req, res, (db) => {
    db.close();
    const result = restoreZivpnConfig(config);
    if (!result.ok) {
      return res.status(400).json({ ok: false, message: result.message });
    }
    const zivpnServiceReload = reloadZivpnService();
    return res.json({
      ok: true,
      path: result.path,
      total_entries: Number(result.total || 0),
      zivpn_service_reload: zivpnServiceReload
    });
  });
});

app.post('/internal/restore-zivpn-auth', (req, res) => {
  const users = req.body?.users;
  return authorizeAndRun(req, res, (db) => {
    db.close();
    const result = restoreZivpnAuth(users);
    if (!result.ok) {
      return res.status(400).json({ ok: false, message: result.message });
    }
    const zivpnServiceReload = reloadZivpnService();
    return res.json({
      ok: true,
      path: result.path,
      total_entries: Number(result.total || 0),
      zivpn_service_reload: zivpnServiceReload
    });
  });
});

app.post('/internal/restore-banner-config', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    const result = restoreBannerConfig(req.body || {});
    if (!result.ok) {
      return res.status(400).json({ ok: false, message: result.message });
    }
    return res.json(result);
  });
});

app.post('/internal/restore-full-backup-url', (req, res) => {
  const fileUrl = String(req.body?.file_url || '').trim();
  const fileName = String(req.body?.file_name || '').trim();
  return authorizeAndRun(req, res, (db) => {
    db.close();
    const result = runFullBackupRestoreFromUrl(fileUrl, fileName);
    if (!result.ok) {
      return res.status(Number(result.statusCode || 500)).json({ ok: false, message: result.message });
    }
    return res.json(result);
  });
});

app.post('/internal/zivpn-service', (req, res) => {
  const action = String(req.body?.action || '').trim();
  return authorizeAndRun(req, res, (db) => {
    db.close();
    const result = controlZivpnService(action);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    return res.json({ ok: true, action: result.action, service: result.service, status: result.status || '-' });
  });
});

app.listen(PORT, () => {
  console.log(`summary api on port ${PORT}`);
});
JS

  cat > "${APP_DIR}/.env" <<EOF
SUMMARY_PORT=${SUMMARY_PORT}
POTATO_DB=${POTATO_DB}
USE_DB_AUTH=1
SYNC_TOKEN=
ZIVPN_CONFIG=/etc/zivpn/config.json
ZIVPN_SERVICE=
BANNER_HTML_FILE=/etc/sc-1forcr/banner.html
BANNER_TXT_FILE=/etc/sc-1forcr/banner.txt
FULL_RESTORE_SCRIPT=/usr/local/sbin/sc-1forcr-restore-backup
RESTORE_TMP_DIR=/tmp
EOF

  chmod 600 "${APP_DIR}/.env"
}

install_dependencies() {
  cd "${APP_DIR}"
  if [[ ! -f package.json ]]; then
    npm init -y >/dev/null 2>&1
  fi

  # sqlite3 prebuilt sering gagal di VPS dengan glibc lama,
  # jadi paksa build from source agar kompatibel dengan sistem.
  log "Installing build tools for sqlite3 (source build)..."
  apt-get update -y
  apt-get install -y build-essential python3 make g++ gcc libc6-dev pkg-config

  log "Installing npm dependencies..."
  # Bersihkan hasil install lama agar sqlite3 binary lama tidak kepakai.
  rm -rf node_modules package-lock.json
  npm cache clean --force >/dev/null 2>&1 || true

  npm install express dotenv --omit=dev

  # Paksa compile sqlite3 dari source (jangan ambil prebuilt binary).
  export npm_config_build_from_source=true
  export npm_config_fallback_to_build=true
  export npm_config_update_binary=false
  npm install sqlite3@5.1.7 --unsafe-perm --omit=dev --build-from-source --foreground-scripts --verbose

  # Verifikasi binary sqlite3 harus load normal.
  node -e "require('sqlite3'); console.log('sqlite3 load ok')"
}

start_pm2_service() {
  cd "${APP_DIR}"

  pm2 delete "${APP_NAME}" >/dev/null 2>&1 || true
  pm2 start "${APP_DIR}/summary-api.js" --name "${APP_NAME}"
  pm2 save --force

  pm2 startup systemd -u root --hp /root >/tmp/pm2-startup.out 2>&1 || true
  STARTUP_CMD="$(grep -Eo 'sudo .+' /tmp/pm2-startup.out | head -n1 || true)"
  if [[ -n "${STARTUP_CMD}" ]]; then
    bash -lc "${STARTUP_CMD#sudo }" || true
  fi

  systemctl enable pm2-root >/dev/null 2>&1 || true
  systemctl restart pm2-root >/dev/null 2>&1 || true
}

print_result() {
  log "Done."
  echo
  echo "Service Name : ${APP_NAME}"
  echo "Service Path : ${APP_DIR}/summary-api.js"
  echo "Port         : ${SUMMARY_PORT}"
  echo "DB Path      : ${POTATO_DB}"
  echo "Auth Mode    : DB (servers.key)"
  echo
  echo "Health check:"
  echo "  curl -s http://127.0.0.1:${SUMMARY_PORT}/health && echo"
  echo
  echo "Summary check (token harus ada di potato.db tabel servers kolom key):"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" http://127.0.0.1:${SUMMARY_PORT}/internal/account-summary && echo"
  echo
  echo "Expiry summary check:"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" \"http://127.0.0.1:${SUMMARY_PORT}/internal/expiry-summary?date=$(date +%F)\" && echo"
  echo
  echo "Vnstat daily check:"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" \"http://127.0.0.1:${SUMMARY_PORT}/internal/vnstat-daily\" && echo"
  echo
  echo "Export accounts check:"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" \"http://127.0.0.1:${SUMMARY_PORT}/internal/export-accounts?type=ssh&limit=5\" && echo"
  echo
  echo "Delete ALL SSH/UDP/ZIVPN check (DANGEROUS):"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" -H \"content-type: application/json\" -d '{\"type\":\"ssh\"}' \"http://127.0.0.1:${SUMMARY_PORT}/internal/delete-all-accounts\" && echo"
  echo
  echo "ZIVPN service control check:"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" -H \"content-type: application/json\" -d '{\"action\":\"status\"}' \"http://127.0.0.1:${SUMMARY_PORT}/internal/zivpn-service\" && echo"
  echo
  echo "Full restore from Telegram URL check:"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" -H \"content-type: application/json\" \\"
  echo "    -d '{\"file_url\":\"https://api.telegram.org/file/bot.../backup.tar.gz\",\"file_name\":\"backup.tar.gz\"}' \\"
  echo "    \"http://127.0.0.1:${SUMMARY_PORT}/internal/restore-full-backup-url\" && echo"
}

install_node_if_missing
install_pm2_if_missing
install_vnstat_if_missing
write_files
install_dependencies
start_pm2_service
print_result

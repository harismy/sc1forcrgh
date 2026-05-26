#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/tunnel-sync}"
APP_NAME="${APP_NAME:-tunnel-summary}"
SUMMARY_PORT="${SUMMARY_PORT:-8789}"
SUMMARY_HOST="${SUMMARY_HOST:-0.0.0.0}"
POTATO_DB="${POTATO_DB:-/usr/sbin/potatonc/potato.db}"
SSH_TUNNEL_SHELL="${SSH_TUNNEL_SHELL:-/usr/sbin/nologin}"

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
const HOST = String(process.env.SUMMARY_HOST || '0.0.0.0').trim() || '0.0.0.0';
const DB = process.env.POTATO_DB || '/usr/sbin/potatonc/potato.db';
const SSH_TUNNEL_SHELL = String(process.env.SSH_TUNNEL_SHELL || '/usr/sbin/nologin').trim() || '/usr/sbin/nologin';
const USE_DB_AUTH = String(process.env.USE_DB_AUTH || '1') !== '0';
const STATIC_TOKEN = (process.env.SYNC_TOKEN || '').trim();
const FULL_RESTORE_SCRIPT = String(process.env.FULL_RESTORE_SCRIPT || '/usr/local/sbin/sc-1forcr-restore-backup').trim();
const RESTORE_TMP_DIR = String(process.env.RESTORE_TMP_DIR || '/tmp').trim();
const BANNER_HTML_FILE = String(process.env.BANNER_HTML_FILE || '/etc/sc-1forcr/banner.html').trim();
const BANNER_TXT_FILE = String(process.env.BANNER_TXT_FILE || '/etc/sc-1forcr/banner.txt').trim();
const XRAY_CONFIG_FILE = String(process.env.XRAY_CONFIG_FILE || '/usr/local/etc/xray/config.json').trim();
const SC_ACCESS_LOCK_FILE = String(process.env.SC_ACCESS_LOCK_FILE || '/etc/sc-1forcr-access.lock').trim();
const SC_RUNTIME_ENV_FILE = String(process.env.SC_RUNTIME_ENV_FILE || '/etc/sc-1forcr.env').trim();
const SC_REG_META_FILE = String(process.env.SC_REG_META_FILE || '/etc/sc-1forcr-registration.env').trim();
const SC_APP_ENV_FILE = String(process.env.SC_APP_ENV_FILE || '/opt/sc-1forcr/.env').trim();
const RUNTIME_SETTINGS_KEYS = Object.freeze([
  'AUTO_BACKUP_ENABLE',
  'AUTO_BACKUP_DIR',
  'AUTO_BACKUP_KEEP_DAYS',
  'AUTO_BACKUP_INTERVAL_MINUTES',
  'AUTO_BACKUP_SCHEDULE_MODE',
  'AUTO_BACKUP_WIB_HOUR',
  'AUTO_REBOOT_ENABLE',
  'AUTO_REBOOT_INTERVAL_MINUTES',
  'AUTO_PULL_UPDATE_ENABLE',
  'AUTO_PULL_UPDATE_INTERVAL_MINUTES',
  'ONLINE_NOTIFY_ENABLE',
  'ONLINE_NOTIFY_INTERVAL_HOURS',
  'ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS',
  'IPLIMIT_CHECK_INTERVAL_MINUTES',
  'IPLIMIT_LOCK_MINUTES',
  'IPLIMIT_AUTO_LOCK_ENABLE',
  'IPLIMIT_AUTO_TUNE',
  'IPLIMIT_DEBUG',
  'DROPBEAR_LOG_MAX_LINES',
  'DROPBEAR_RECENT_LOG_MAX_LINES',
  'UDPHC_LOG_LINES_HISTORY',
  'UDPHC_LOG_LINES_REALTIME',
  'UDPHC_LOG_LINES_CHECKER',
  'XRAY_BLOCK_TCP_PORTS',
  'XRAY_RECENT_WINDOW_MINUTES',
  'XRAY_ACTIVE_WINDOW_SECONDS',
  'XRAY_MIN_HITS_PER_IP',
  'XRAY_PATHS_VMESS',
  'XRAY_PATHS_VLESS',
  'XRAY_PATHS_TROJAN',
  'VMESS_BUG_PROFILE_ADDRESS',
  'VMESS_BUG_PROFILE_SNI',
  'VMESS_BUG_PROFILE_HOST',
  'VMESS_BUG_PROFILE_ALLOW_INSECURE',
  'ZIVPN_ACTIVE_WINDOW_SECONDS',
  'ZIVPN_HANDOFF_GRACE_SECONDS',
  'ZIVPN_LIVE_TTL_SECONDS',
  'ZIVPN_AUTH_APPLY_MODE',
  'ZIVPN_AUTH_MODE',
  'ZIVPN_RELOAD_ON_AUTH_CHANGE',
  'ACTIVE_UDP_BACKEND',
  'SSH_HC_AUTH_LOOKBACK_HOURS',
  'SSHWS_UDPGW_PORTS',
  'SSH_TUNNEL_SHELL',
  'SSH_TUNNEL_BLOCK_OUTBOUND_SSH',
  'SSH_TUNNEL_BLOCK_OUTBOUND_PORTS',
  'SSHWS_LOOP_GUARD_ENABLE',
  'SSHWS_LOOP_GUARD_PORTS',
  'SSHWS_LOOP_GUARD_NEW_ABOVE',
  'SSHWS_LOOP_GUARD_BURST',
  'SSHWS_LOOP_GUARD_CONNLIMIT_ABOVE',
  'SSHWS_NGINX_LIMIT_ENABLE',
  'SSHWS_NGINX_LIMIT_RATE',
  'SSHWS_NGINX_LIMIT_BURST',
  'SSHWS_NGINX_LIMIT_CONN',
  'NGINX_WORKER_CONNECTIONS',
  'NGINX_WORKER_RLIMIT_NOFILE',
  'NGINX_SERVICE_LIMIT_NOFILE'
]);
const RUNTIME_SETTINGS_KEY_SET = new Set(RUNTIME_SETTINGS_KEYS);

if (!USE_DB_AUTH && !STATIC_TOKEN) {
  console.error('SYNC_TOKEN kosong saat USE_DB_AUTH=0');
  process.exit(1);
}

function ensureRuntimeTables(db, cb) {
  db.run(
    `CREATE TABLE IF NOT EXISTS account_trial_flags (
      account_type TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (account_type, username)
    )`,
    [],
    (err) => cb(err || null)
  );
}

function sendSummary(db, res) {
  ensureRuntimeTables(db, (tableErr) => {
    if (tableErr) {
      db.close();
      return res.status(500).json({ ok: false, message: tableErr.message });
    }
    db.get(
      `
      SELECT
        (SELECT COUNT(*) FROM account_sshs WHERE UPPER(TRIM(COALESCE(status,'')))='AKTIF' AND (TRIM(COALESCE(date_exp,''))='' OR CASE WHEN TRIM(COALESCE(date_exp,'')) GLOB '????-??-??' THEN date(TRIM(date_exp)) > date('now','localtime') ELSE datetime(REPLACE(TRIM(date_exp),'T',' ')) > datetime('now','localtime') END) AND NOT (LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='ssh' AND LOWER(f.username)=LOWER(account_sshs.username)))) AS ssh,
        (SELECT COUNT(*) FROM account_vmesses WHERE UPPER(TRIM(COALESCE(status,'')))='AKTIF' AND (TRIM(COALESCE(date_exp,''))='' OR CASE WHEN TRIM(COALESCE(date_exp,'')) GLOB '????-??-??' THEN date(TRIM(date_exp)) > date('now','localtime') ELSE datetime(REPLACE(TRIM(date_exp),'T',' ')) > datetime('now','localtime') END) AND NOT (LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='vmess' AND LOWER(f.username)=LOWER(account_vmesses.username)))) AS vmess,
        (SELECT COUNT(*) FROM account_vlesses WHERE UPPER(TRIM(COALESCE(status,'')))='AKTIF' AND (TRIM(COALESCE(date_exp,''))='' OR CASE WHEN TRIM(COALESCE(date_exp,'')) GLOB '????-??-??' THEN date(TRIM(date_exp)) > date('now','localtime') ELSE datetime(REPLACE(TRIM(date_exp),'T',' ')) > datetime('now','localtime') END) AND NOT (LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='vless' AND LOWER(f.username)=LOWER(account_vlesses.username)))) AS vless,
        (SELECT COUNT(*) FROM account_trojans WHERE UPPER(TRIM(COALESCE(status,'')))='AKTIF' AND (TRIM(COALESCE(date_exp,''))='' OR CASE WHEN TRIM(COALESCE(date_exp,'')) GLOB '????-??-??' THEN date(TRIM(date_exp)) > date('now','localtime') ELSE datetime(REPLACE(TRIM(date_exp),'T',' ')) > datetime('now','localtime') END) AND NOT (LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='trojan' AND LOWER(f.username)=LOWER(account_trojans.username)))) AS trojan,
        (SELECT COUNT(*) FROM account_sshs WHERE LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='ssh' AND LOWER(f.username)=LOWER(account_sshs.username))) AS trial_ssh,
        (SELECT COUNT(*) FROM account_vmesses WHERE LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='vmess' AND LOWER(f.username)=LOWER(account_vmesses.username))) AS trial_vmess,
        (SELECT COUNT(*) FROM account_vlesses WHERE LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='vless' AND LOWER(f.username)=LOWER(account_vlesses.username))) AS trial_vless,
        (SELECT COUNT(*) FROM account_trojans WHERE LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='trojan' AND LOWER(f.username)=LOWER(account_trojans.username))) AS trial_trojan,
        (SELECT COUNT(*) FROM account_sshs WHERE (UPPER(TRIM(COALESCE(status,'')))='EXPIRED' OR date(COALESCE(date_exp,'')) < date('now','localtime')) AND NOT (LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='ssh' AND LOWER(f.username)=LOWER(account_sshs.username)))) AS expired_ssh,
        (SELECT COUNT(*) FROM account_vmesses WHERE (UPPER(TRIM(COALESCE(status,'')))='EXPIRED' OR date(COALESCE(date_exp,'')) < date('now','localtime')) AND NOT (LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='vmess' AND LOWER(f.username)=LOWER(account_vmesses.username)))) AS expired_vmess,
        (SELECT COUNT(*) FROM account_vlesses WHERE (UPPER(TRIM(COALESCE(status,'')))='EXPIRED' OR date(COALESCE(date_exp,'')) < date('now','localtime')) AND NOT (LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='vless' AND LOWER(f.username)=LOWER(account_vlesses.username)))) AS expired_vless,
        (SELECT COUNT(*) FROM account_trojans WHERE (UPPER(TRIM(COALESCE(status,'')))='EXPIRED' OR date(COALESCE(date_exp,'')) < date('now','localtime')) AND NOT (LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='trojan' AND LOWER(f.username)=LOWER(account_trojans.username)))) AS expired_trojan
      `,
      (err, row) => {
        db.close();
        if (err) return res.status(500).json({ ok: false, message: err.message });

      const ssh = Number(row?.ssh || 0);
      const vmess = Number(row?.vmess || 0);
      const vless = Number(row?.vless || 0);
      const trojan = Number(row?.trojan || 0);
      const trial = {
        ssh: Number(row?.trial_ssh || 0),
        vmess: Number(row?.trial_vmess || 0),
        vless: Number(row?.trial_vless || 0),
        trojan: Number(row?.trial_trojan || 0)
      };
      trial.total = trial.ssh + trial.vmess + trial.vless + trial.trojan;
      const expired = {
        ssh: Number(row?.expired_ssh || 0),
        vmess: Number(row?.expired_vmess || 0),
        vless: Number(row?.expired_vless || 0),
        trojan: Number(row?.expired_trojan || 0)
      };
      expired.total = expired.ssh + expired.vmess + expired.vless + expired.trojan;

        return res.json({
          ok: true,
          ssh,
          vmess,
          vless,
          trojan,
          total: ssh + vmess + vless + trojan,
          active_regular: { ssh, vmess, vless, trojan, total: ssh + vmess + vless + trojan },
          trial,
          expired
        });
      }
    );
  });
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

function resolveTunnelShell() {
  const choices = [SSH_TUNNEL_SHELL, '/usr/sbin/nologin', '/sbin/nologin', '/bin/false']
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  for (const shell of choices) {
    try {
      if (fs.existsSync(shell)) return shell;
    } catch (_) {}
  }
  return '/usr/sbin/nologin';
}

function ensureTunnelShellAllowed() {
  const shell = resolveTunnelShell();
  try {
    const shellsFile = '/etc/shells';
    const current = fs.existsSync(shellsFile) ? fs.readFileSync(shellsFile, 'utf8') : '';
    const exists = current.split(/\r?\n/).map((line) => line.trim()).includes(shell);
    if (!exists) {
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(shellsFile, `${prefix}${shell}\n`);
    }
  } catch (_) {}
  return shell;
}

function syncSshLinuxUsers(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const tunnelShell = ensureTunnelShellAllowed();
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
        execFileSync('useradd', ['-m', '-d', homeDir, '-s', tunnelShell, username], { stdio: 'ignore' });
        created += 1;
      } else {
        updated += 1;
      }

      try { fs.mkdirSync(homeDir, { recursive: true }); } catch (_) {}
      execFileSync('chown', ['-R', `${username}:${username}`, homeDir], { stdio: 'ignore' });
      execFileSync('usermod', ['-d', homeDir, '-s', tunnelShell, username], { stdio: 'ignore' });
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

function getXrayProtocolByType(rawType) {
  const type = String(rawType || '').trim().toLowerCase();
  if (type === 'vmess' || type === 'vless' || type === 'trojan') return type;
  return '';
}

function getXrayCredentialFromRow(type, row) {
  const r = row && typeof row === 'object' ? row : {};
  const fromUuid = String(r.uuid || '').trim();
  const fromId = String(r.id || '').trim();
  const fromPassword = String(r.password || '').trim();
  if (type === 'vmess' || type === 'vless') {
    return fromUuid || fromId || '';
  }
  if (type === 'trojan') {
    return fromPassword || fromUuid || '';
  }
  return '';
}

function normalizeXrayClientsForType(type, rows, templateClient) {
  const list = Array.isArray(rows) ? rows : [];
  const tpl = (templateClient && typeof templateClient === 'object') ? { ...templateClient } : {};
  const out = [];
  for (const row of list) {
    const username = String(row?.username || '').trim();
    if (!username) continue;
    const cred = getXrayCredentialFromRow(type, row);
    if (!cred) continue;
    const c = { ...tpl };
    if (type === 'vmess' || type === 'vless') {
      c.id = cred;
      c.email = username;
      if (type === 'vmess' && c.alterId === undefined) c.alterId = 0;
      delete c.password;
    } else if (type === 'trojan') {
      c.password = cred;
      c.email = username;
      delete c.id;
      delete c.alterId;
    }
    out.push(c);
  }
  return out;
}

function getXrayConfigCandidates() {
  const base = String(XRAY_CONFIG_FILE || '').trim();
  const list = [base, '/usr/local/etc/xray/config.json', '/etc/xray/config.json']
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return list.filter((v, i) => list.indexOf(v) === i);
}

function resolveReadableXrayConfigPath() {
  const candidates = getXrayConfigCandidates();
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      JSON.parse(raw);
      return p;
    } catch (_) {}
  }
  return candidates[0] || XRAY_CONFIG_FILE;
}

function buildDefaultXrayInbound(type) {
  if (type === 'vmess') {
    return {
      port: 10001, listen: '127.0.0.1', protocol: 'vmess',
      settings: { clients: [], alterId: 0 },
      streamSettings: { network: 'ws', wsSettings: { path: '/vmess' } }
    };
  }
  if (type === 'vless') {
    return {
      port: 10002, listen: '127.0.0.1', protocol: 'vless',
      settings: { clients: [], decryption: 'none' },
      streamSettings: { network: 'ws', security: 'none', wsSettings: { path: '/vless' } }
    };
  }
  if (type === 'trojan') {
    return {
      port: 10003, listen: '127.0.0.1', protocol: 'trojan',
      settings: { clients: [] },
      streamSettings: { network: 'ws', security: 'none', wsSettings: { path: '/trojan' } }
    };
  }
  return null;
}

function writeXrayConfigToCandidates(cfgObj, primaryPath) {
  const content = JSON.stringify(cfgObj, null, 2);
  const candidates = getXrayConfigCandidates();
  const ordered = [String(primaryPath || '').trim(), ...candidates].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);
  let wrote = false;
  for (const p of ordered) {
    try {
      fs.mkdirSync(require('path').dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${Date.now()}`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, p);
      wrote = true;
    } catch (_) {}
  }
  return wrote;
}

function restartXrayService() {
  try {
    execFileSync('systemctl', ['restart', 'xray'], { stdio: 'ignore' });
    return { ok: true, method: 'systemctl' };
  } catch (_) {
    try {
      execFileSync('service', ['xray', 'restart'], { stdio: 'ignore' });
      return { ok: true, method: 'service' };
    } catch (err) {
      return { ok: false, message: err?.message || 'restart xray gagal' };
    }
  }
}

function syncXrayConfigFromDbByType(typeInput, restartAfter = false) {
  return new Promise((resolve) => {
    const type = getXrayProtocolByType(typeInput);
    if (!type) {
      return resolve({ ok: false, statusCode: 400, message: 'type harus vmess/vless/trojan' });
    }
    const table = getAccountTableByType(type);
    if (!table) {
      return resolve({ ok: false, statusCode: 400, message: 'table type tidak valid' });
    }
    const cfgPath = resolveReadableXrayConfigPath();
    if (!fs.existsSync(cfgPath)) {
      return resolve({ ok: false, statusCode: 500, message: `config xray tidak ditemukan: ${cfgPath}` });
    }

    const cfgDb = new sqlite3.Database(DB);
    cfgDb.all(
      `SELECT * FROM ${table} WHERE UPPER(TRIM(COALESCE(status, '')))='AKTIF' ORDER BY rowid DESC`,
      [],
      (dbErr, rows) => {
        cfgDb.close();
        if (dbErr) {
          return resolve({ ok: false, statusCode: 500, message: dbErr.message });
        }

        let parsed;
        try {
          const raw = fs.readFileSync(cfgPath, 'utf8');
          parsed = JSON.parse(raw);
        } catch (err) {
          return resolve({ ok: false, statusCode: 500, message: `gagal baca config xray: ${err.message}` });
        }

        if (!Array.isArray(parsed?.inbounds)) parsed.inbounds = [];
        const inbounds = parsed.inbounds;
        let targetInbounds = inbounds.filter((ib) => String(ib?.protocol || '').trim().toLowerCase() === type);
        if (!targetInbounds.length) {
          const createdInbound = buildDefaultXrayInbound(type);
          if (!createdInbound) {
            return resolve({ ok: false, statusCode: 400, message: `inbound ${type} tidak ditemukan di config xray` });
          }
          inbounds.push(createdInbound);
          targetInbounds = [createdInbound];
        }

        const firstTemplate = Array.isArray(targetInbounds[0]?.settings?.clients) && targetInbounds[0].settings.clients[0]
          ? targetInbounds[0].settings.clients[0]
          : {};
        const normalizedClients = normalizeXrayClientsForType(type, rows || [], firstTemplate);

        for (const ib of targetInbounds) {
          if (!ib.settings || typeof ib.settings !== 'object') ib.settings = {};
          ib.settings.clients = normalizedClients.map((c) => ({ ...c }));
        }

        try {
          const wrote = writeXrayConfigToCandidates(parsed, cfgPath);
          if (!wrote) {
            return resolve({ ok: false, statusCode: 500, message: 'gagal tulis config xray ke semua candidate path' });
          }
        } catch (writeErr) {
          return resolve({ ok: false, statusCode: 500, message: `gagal tulis config xray: ${writeErr.message}` });
        }

        const shouldRestart = !!restartAfter;
        let restart = null;
        if (shouldRestart) {
          restart = restartXrayService();
          if (!restart.ok) {
            return resolve({
              ok: false,
              statusCode: 500,
              message: restart.message || 'restart xray gagal',
              type,
              synced_clients: normalizedClients.length
            });
          }
        }
        return resolve({
          ok: true,
          type,
          table,
          synced_clients: normalizedClients.length,
          restart_applied: shouldRestart,
          xray_restart: restart,
          xray_needs_restart: !shouldRestart
        });
      }
    );
  });
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

function unquoteEnvValue(valueInput) {
  let value = String(valueInput || '').trim();
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    value = value.slice(1, -1);
  }
  return value;
}

function readRuntimeSettingsFromFile(filePath) {
  const settings = {};
  if (!filePath) return settings;
  try {
    if (!fs.existsSync(filePath)) return settings;
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      if (!RUNTIME_SETTINGS_KEY_SET.has(key)) continue;
      settings[key] = unquoteEnvValue(trimmed.slice(idx + 1));
    }
  } catch (_) {}
  return settings;
}

function readRuntimeSettings() {
  return {
    ...readRuntimeSettingsFromFile(SC_APP_ENV_FILE),
    ...readRuntimeSettingsFromFile(SC_RUNTIME_ENV_FILE)
  };
}

function cleanRuntimeSettingValue(valueInput) {
  return String(valueInput ?? '').replace(/\r/g, '').replace(/\n/g, '').trim().slice(0, 512);
}

function filterRuntimeSettings(settingsInput) {
  const input = settingsInput && typeof settingsInput === 'object' ? settingsInput : {};
  const out = {};
  for (const key of RUNTIME_SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    out[key] = cleanRuntimeSettingValue(input[key]);
  }
  return out;
}

function quoteEnvValue(valueInput) {
  const value = String(valueInput ?? '');
  if (/^[A-Za-z0-9_@%+=:,./-]*$/.test(value)) return value || "''";
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function writeRuntimeSettingsFile(filePath, settings) {
  if (!filePath || !settings || typeof settings !== 'object') return 0;
  const keys = Object.keys(settings).filter((key) => RUNTIME_SETTINGS_KEY_SET.has(key));
  if (keys.length === 0) return 0;

  let lines = [];
  try {
    if (fs.existsSync(filePath)) lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  } catch (_) {
    lines = [];
  }

  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    if (RUNTIME_SETTINGS_KEY_SET.has(key) && Object.prototype.hasOwnProperty.call(settings, key)) {
      out.push(`${key}=${quoteEnvValue(settings[key])}`);
      seen.add(key);
      continue;
    }
    out.push(line);
  }

  for (const key of RUNTIME_SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(settings, key) || seen.has(key)) continue;
    out.push(`${key}=${quoteEnvValue(settings[key])}`);
  }

  try {
    const dir = require('path').dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, `${out.join('\n').replace(/\n+$/g, '')}\n`, 'utf8');
    if (filePath === SC_RUNTIME_ENV_FILE) {
      try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    }
  } catch (err) {
    throw new Error(`gagal tulis ${filePath}: ${err.message}`);
  }
  return keys.length;
}

function intSetting(settings, key, fallback, min, max) {
  const n = Number(String(settings?.[key] ?? '').replace(/[^0-9]/g, ''));
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.floor(n);
}

function enabledSetting(settings, key, fallback = '1') {
  const value = String(settings?.[key] ?? fallback).trim().toLowerCase();
  return /^(0|off|false|no|nonaktif)$/.test(value) ? '0' : '1';
}

function runSystemctl(args) {
  try {
    execFileSync('systemctl', args, { stdio: 'ignore' });
    return { ok: true, command: `systemctl ${args.join(' ')}` };
  } catch (err) {
    return { ok: false, command: `systemctl ${args.join(' ')}`, message: err?.message || 'systemctl gagal' };
  }
}

function writeIpLimitTimerUnit(intervalMinutes) {
  fs.writeFileSync('/etc/systemd/system/sc-1forcr-iplimit.timer', `[Unit]
Description=Run SC 1FORCR IP Limit Checker every ${intervalMinutes} minutes

[Timer]
OnBootSec=15s
OnUnitActiveSec=${intervalMinutes}min
AccuracySec=1s
RandomizedDelaySec=0
Persistent=true
Unit=sc-1forcr-iplimit.service

[Install]
WantedBy=timers.target
`, 'utf8');
}

function writeAutoBackupTimerUnit(settings) {
  if (!fs.existsSync('/etc/systemd/system/sc-1forcr-autobackup.service')) return false;
  const modeRaw = String(settings.AUTO_BACKUP_SCHEDULE_MODE || 'interval').trim().toLowerCase();
  const mode = /^(daily|daily_wib|wib)$/.test(modeRaw) ? 'daily_wib' : 'interval';
  const interval = intSetting(settings, 'AUTO_BACKUP_INTERVAL_MINUTES', 1440, 1, 10080);
  const hour = intSetting(settings, 'AUTO_BACKUP_WIB_HOUR', 2, 0, 23);
  if (mode === 'daily_wib') {
    fs.writeFileSync('/etc/systemd/system/sc-1forcr-autobackup.timer', `[Unit]
Description=Run SC 1FORCR auto backup daily at ${String(hour).padStart(2, '0')}:00 WIB

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=30s
Unit=sc-1forcr-autobackup.service

[Install]
WantedBy=timers.target
`, 'utf8');
    return true;
  }
  fs.writeFileSync('/etc/systemd/system/sc-1forcr-autobackup.timer', `[Unit]
Description=Run SC 1FORCR auto backup every ${interval} minutes

[Timer]
OnBootSec=5m
OnUnitActiveSec=${interval}min
AccuracySec=1s
Persistent=true
RandomizedDelaySec=30s
Unit=sc-1forcr-autobackup.service

[Install]
WantedBy=timers.target
`, 'utf8');
  return true;
}

function writeAutoRebootTimerUnit(settings) {
  if (!fs.existsSync('/etc/systemd/system/sc-1forcr-autoreboot.service')) return false;
  const interval = intSetting(settings, 'AUTO_REBOOT_INTERVAL_MINUTES', 1440, 30, 10080);
  fs.writeFileSync('/etc/systemd/system/sc-1forcr-autoreboot.timer', `[Unit]
Description=Run SC 1FORCR auto reboot every ${interval} minutes

[Timer]
OnBootSec=10m
OnUnitActiveSec=${interval}min
Persistent=true
AccuracySec=1min
Unit=sc-1forcr-autoreboot.service

[Install]
WantedBy=timers.target
`, 'utf8');
  return true;
}

function writePullUpdateTimerUnit(settings) {
  if (!fs.existsSync('/etc/systemd/system/sc-1forcr-pull-update.service')) return false;
  const interval = intSetting(settings, 'AUTO_PULL_UPDATE_INTERVAL_MINUTES', 10, 1, 1440);
  fs.writeFileSync('/etc/systemd/system/sc-1forcr-pull-update.timer', `[Unit]
Description=Check SC 1FORCR update trigger every ${interval} minutes

[Timer]
OnBootSec=3m
OnUnitActiveSec=${interval}min
AccuracySec=30s
Persistent=true
RandomizedDelaySec=30s
Unit=sc-1forcr-pull-update.service

[Install]
WantedBy=timers.target
`, 'utf8');
  return true;
}

function writeOnlineNotifyTimerUnit(settings) {
  if (!fs.existsSync('/etc/systemd/system/sc-1forcr-online-notify.service')) return false;
  const interval = intSetting(settings, 'ONLINE_NOTIFY_INTERVAL_HOURS', 3, 1, 168);
  fs.writeFileSync('/etc/systemd/system/sc-1forcr-online-notify.timer', `[Unit]
Description=Run SC 1FORCR online account notifier every ${interval} hours

[Timer]
OnBootSec=10min
OnUnitActiveSec=${interval}h
AccuracySec=1min
RandomizedDelaySec=0
Persistent=true
Unit=sc-1forcr-online-notify.service

[Install]
WantedBy=timers.target
`, 'utf8');
  return true;
}

function applyRuntimeSettingsUnits(settings) {
  const actions = [];
  writeIpLimitTimerUnit(intSetting(settings, 'IPLIMIT_CHECK_INTERVAL_MINUTES', 1, 1, 1440));
  const hasAutoBackupTimer = writeAutoBackupTimerUnit(settings);
  const hasAutoRebootTimer = writeAutoRebootTimerUnit(settings);
  const hasPullUpdateTimer = writePullUpdateTimerUnit(settings);
  const hasOnlineNotifyTimer = writeOnlineNotifyTimerUnit(settings);

  actions.push(runSystemctl(['daemon-reload']));
  actions.push(runSystemctl(['enable', '--now', 'sc-1forcr-iplimit.timer']));
  actions.push(runSystemctl(['restart', 'sc-1forcr-iplimit.timer']));
  actions.push(runSystemctl(['start', 'sc-1forcr-iplimit.service']));

  if (hasAutoBackupTimer) {
    if (enabledSetting(settings, 'AUTO_BACKUP_ENABLE', '1') === '1') {
      actions.push(runSystemctl(['enable', '--now', 'sc-1forcr-autobackup.timer']));
      actions.push(runSystemctl(['restart', 'sc-1forcr-autobackup.timer']));
    } else {
      actions.push(runSystemctl(['disable', '--now', 'sc-1forcr-autobackup.timer']));
    }
  }

  if (hasAutoRebootTimer) {
    if (enabledSetting(settings, 'AUTO_REBOOT_ENABLE', '1') === '1') {
      actions.push(runSystemctl(['enable', '--now', 'sc-1forcr-autoreboot.timer']));
      actions.push(runSystemctl(['restart', 'sc-1forcr-autoreboot.timer']));
    } else {
      actions.push(runSystemctl(['disable', '--now', 'sc-1forcr-autoreboot.timer']));
    }
  }

  if (hasPullUpdateTimer) {
    if (enabledSetting(settings, 'AUTO_PULL_UPDATE_ENABLE', '1') === '1') {
      actions.push(runSystemctl(['enable', '--now', 'sc-1forcr-pull-update.timer']));
      actions.push(runSystemctl(['restart', 'sc-1forcr-pull-update.timer']));
    } else {
      actions.push(runSystemctl(['disable', '--now', 'sc-1forcr-pull-update.timer']));
    }
  }

  if (hasOnlineNotifyTimer) {
    if (enabledSetting(settings, 'ONLINE_NOTIFY_ENABLE', '1') === '1') {
      actions.push(runSystemctl(['enable', '--now', 'sc-1forcr-online-notify.timer']));
      actions.push(runSystemctl(['restart', 'sc-1forcr-online-notify.timer']));
    } else {
      actions.push(runSystemctl(['disable', '--now', 'sc-1forcr-online-notify.timer']));
    }
  }

  return actions;
}

function sendExportRuntimeSettings(res) {
  try {
    const settings = readRuntimeSettings();
    return res.json({
      ok: true,
      settings,
      total_settings: Object.keys(settings).length,
      runtime_env_path: SC_RUNTIME_ENV_FILE,
      app_env_path: SC_APP_ENV_FILE
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: `gagal export settings: ${err.message}` });
  }
}

function restoreRuntimeSettings(settingsInput) {
  const settings = filterRuntimeSettings(settingsInput);
  const total = Object.keys(settings).length;
  if (total === 0) {
    return { ok: false, message: 'settings valid tidak ditemukan' };
  }

  writeRuntimeSettingsFile(SC_RUNTIME_ENV_FILE, settings);
  if (fs.existsSync(SC_APP_ENV_FILE)) {
    writeRuntimeSettingsFile(SC_APP_ENV_FILE, settings);
  }

  const effectiveSettings = {
    ...readRuntimeSettings(),
    ...settings
  };
  const unitActions = applyRuntimeSettingsUnits(effectiveSettings);
  const apiRestart = runSystemctl(['restart', 'sc-1forcr-api']);

  return {
    ok: true,
    restored_settings: total,
    settings,
    unit_actions: unitActions,
    api_restart: apiRestart
  };
}

function sendExportAccounts(db, res, rawType, rawLimit, rawIncludeInactive = false) {
  const type = String(rawType || '').trim().toLowerCase();
  const table = getAccountTableByType(type);
  if (!table) {
    db.close();
    return res.status(400).json({ ok: false, message: 'type tidak valid' });
  }

  const limit = Math.max(1, Math.min(50000, Number(rawLimit || 1000)));
  const includeInactive = rawIncludeInactive === true || /^(1|true|yes|on)$/i.test(String(rawIncludeInactive || '').trim());
  const where = includeInactive ? '1=1' : "UPPER(TRIM(COALESCE(status, '')))='AKTIF'";
  db.all(
    `SELECT * FROM ${table} WHERE ${where} ORDER BY rowid DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      db.close();
      if (err) return res.status(500).json({ ok: false, message: err.message });
      return res.json({
        ok: true,
        type,
        table,
        include_inactive: includeInactive,
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

    const importRows = (Array.isArray(accounts) ? accounts : []).map((raw) => ({ ...(raw || {}) }));

    // Kompatibilitas backup lintas script:
    // - Beberapa backup (mis. potato) mengirim trojan credential di field "uuid"
    // - DB 1FORCR menyimpan trojan credential di kolom "password"
    if (type === 'trojan') {
      for (const r of importRows) {
        const pass = String(r.password || '').trim();
        const uid = String(r.uuid || r.id || r.secret || '').trim();
        if (!pass && uid) r.password = uid;
      }
    }

    // Kompatibilitas nama field limit IP lintas source.
    for (const r of importRows) {
      if ((r.limitip === undefined || r.limitip === null || r.limitip === '') && r.limit_ip !== undefined && r.limit_ip !== null) {
        r.limitip = r.limit_ip;
      }
    }

    const insertCols = columns.filter((col) => importRows.some((row) => Object.prototype.hasOwnProperty.call(row || {}, col)));
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
          const finalizeOk = (xraySyncResult = null) => {
            return res.json({
              ok: true,
              type,
              table,
              imported,
              skipped,
              usernames: importedUsernames,
              linux_user_sync: linuxUserSync || null,
              zivpn_service_reload: zivpnServiceReload,
              xray_sync: xraySyncResult
            });
          };
          if (getXrayProtocolByType(type)) {
            return syncXrayConfigFromDbByType(type, false).then((syncRes) => {
              if (!syncRes.ok) {
                return res.status(Number(syncRes.statusCode || 500)).json({
                  ok: false,
                  message: syncRes.message || 'sync xray gagal',
                  type,
                  table,
                  imported,
                  skipped,
                  usernames: importedUsernames,
                  xray_sync: syncRes
                });
              }
              return finalizeOk(syncRes);
            });
          }
          return finalizeOk(null);
        });
      });
    };

    db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
      if (beginErr) {
        db.close();
        return res.status(500).json({ ok: false, message: beginErr.message });
      }

      for (const row of importRows) {
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
        const finalizeOk = (xraySyncResult = null) => {
          return res.json({
            ok: true,
            type,
            table,
            deleted,
            linux_user_delete: linuxUserDelete || null,
            zivpn_service_reload: zivpnServiceReload,
            xray_sync: xraySyncResult
          });
        };
        if (getXrayProtocolByType(type)) {
          return syncXrayConfigFromDbByType(type, false).then((syncRes) => {
            if (!syncRes.ok) {
              return res.status(Number(syncRes.statusCode || 500)).json({
                ok: false,
                message: syncRes.message || 'sync xray gagal',
                type,
                table,
                deleted,
                xray_sync: syncRes
              });
            }
            return finalizeOk(syncRes);
          });
        }
        return finalizeOk(null);
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

function setScMenuExecutable() {
  const mode = '755';
  const targets = ['/usr/local/sbin/menu', '/usr/local/sbin/menu-sc-1forcr'];
  const changed = [];
  for (const p of targets) {
    try {
      if (!fs.existsSync(p)) continue;
      execFileSync('chmod', [mode, p], { stdio: 'ignore' });
      changed.push(p);
    } catch (_) {}
  }
  return changed;
}

function applyScAccessLock(blockedInput, reasonInput, actorInput) {
  const blocked = blockedInput === true || /^(1|true|yes|on)$/i.test(String(blockedInput || '').trim());
  const reason = String(reasonInput || 'locked_by_admin').trim() || 'locked_by_admin';
  const actor = String(actorInput || '').trim() || '-';

  if (blocked) {
    const payload = [
      `blocked=1`,
      `reason=${reason}`,
      `actor=${actor}`,
      `at=${new Date().toISOString()}`
    ].join('\n') + '\n';
    try {
      fs.writeFileSync(SC_ACCESS_LOCK_FILE, payload, 'utf8');
      try { fs.chmodSync(SC_ACCESS_LOCK_FILE, 0o600); } catch (_) {}
      const changedMenus = setScMenuExecutable();
      return { ok: true, blocked: true, lock_file: SC_ACCESS_LOCK_FILE, changed_menus: changedMenus };
    } catch (err) {
      return { ok: false, statusCode: 500, message: `gagal tulis lock file: ${err.message}` };
    }
  }

  try {
    if (fs.existsSync(SC_ACCESS_LOCK_FILE)) fs.unlinkSync(SC_ACCESS_LOCK_FILE);
    const changedMenus = setScMenuExecutable();
    return { ok: true, blocked: false, lock_file: SC_ACCESS_LOCK_FILE, changed_menus: changedMenus };
  } catch (err) {
    return { ok: false, statusCode: 500, message: `gagal hapus lock file: ${err.message}` };
  }
}

function sanitizeUpdateLine(input, maxLen = 512) {
  return String(input || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, ' | ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, Number(maxLen) || 512));
}

function parseEnvLine(rawContent, key) {
  const content = String(rawContent || '');
  const re = new RegExp(`^${String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.*)$`, 'm');
  const m = content.match(re);
  if (!m) return '';
  return String(m[1] || '').trim().replace(/^["']|["']$/g, '');
}

function applyScRegistrationMeta(payloadInput = {}) {
  const payload = payloadInput && typeof payloadInput === 'object' ? payloadInput : {};
  const clientName = sanitizeUpdateLine(payload.client_name || payload.client || '', 96);
  const status = sanitizeUpdateLine(payload.status || 'active', 24).toLowerCase() || 'active';
  const nowIso = new Date().toISOString();

  let expiresAt = Number(payload.expires_at);
  if (!Number.isFinite(expiresAt)) expiresAt = Number(payload.expired_at);
  if (!Number.isFinite(expiresAt)) expiresAt = Number(payload.expiry);
  if (!Number.isFinite(expiresAt)) expiresAt = 0;
  expiresAt = Math.floor(Math.max(0, expiresAt));

  const lines = [
    `SC_STATUS=${status || 'active'}`,
    `SC_CLIENT_NAME=${clientName || '-'}`,
    `SC_EXPIRES_AT=${expiresAt}`,
    `SC_UPDATED_AT_ISO=${nowIso}`,
    ''
  ].join('\n');

  try {
    const dir = require('path').dirname(SC_REG_META_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SC_REG_META_FILE, lines, 'utf8');
    try { fs.chmodSync(SC_REG_META_FILE, 0o644); } catch (_) {}
    return { ok: true, path: SC_REG_META_FILE, status, client_name: clientName || '-', expires_at: expiresAt };
  } catch (err) {
    return { ok: false, statusCode: 500, message: `gagal tulis sc registration meta: ${err.message}` };
  }
}

function readScTelegramConfig() {
  let token = String(process.env.SC_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  let chatId = String(process.env.SC_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').trim();
  try {
    if (fs.existsSync(SC_RUNTIME_ENV_FILE)) {
      const raw = fs.readFileSync(SC_RUNTIME_ENV_FILE, 'utf8');
      if (!token) token = parseEnvLine(raw, 'TELEGRAM_BOT_TOKEN');
      if (!chatId) chatId = parseEnvLine(raw, 'TELEGRAM_CHAT_ID');
    }
  } catch (_) {}
  return { token, chatId };
}

async function sendScTelegramMessage(textInput) {
  const text = String(textInput || '').trim();
  if (!text) return { ok: false, statusCode: 400, message: 'message kosong' };
  const cfg = readScTelegramConfig();
  if (!cfg.token || !cfg.chatId) {
    return { ok: false, statusCode: 400, message: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diset di VPS' };
  }
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
  try {
    const body = new URLSearchParams();
    body.append('chat_id', cfg.chatId);
    body.append('text', text);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const raw = await resp.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!resp.ok || !parsed?.ok) {
      return {
        ok: false,
        statusCode: Number(resp.status || 500),
        message: 'telegram sendMessage gagal',
        telegram_response: parsed || raw || null
      };
    }
    return { ok: true, chat_id: cfg.chatId };
  } catch (err) {
    return { ok: false, statusCode: 500, message: err?.message || 'request telegram gagal' };
  }
}

function readCoreApiRuntimeConfig() {
  const envFile = '/opt/sc-1forcr/.env';
  let token = String(process.env.CORE_AUTH_TOKEN || '').trim();
  let port = Number(process.env.CORE_API_PORT || 8088);

  try {
    if (fs.existsSync(envFile)) {
      const raw = fs.readFileSync(envFile, 'utf8');
      if (!token) token = parseEnvLine(raw, 'AUTH_TOKEN');
      const p = Number(parseEnvLine(raw, 'API_PORT') || 0);
      if (Number.isFinite(p) && p > 0) port = p;
    }
  } catch (_) {}

  if (!token) return { ok: false, message: 'AUTH_TOKEN API utama tidak ditemukan' };
  if (!Number.isFinite(port) || port < 1) port = 8088;
  return { ok: true, token, port };
}

async function renewXrayAccount(typeInput, usernameInput, daysInput) {
  const type = String(typeInput || '').trim().toLowerCase();
  const username = String(usernameInput || '').trim();
  const days = Number.isFinite(Number(daysInput)) ? Math.max(0, Math.floor(Number(daysInput))) : 0;
  const routeMap = {
    vmess: '/vps/renewvmess',
    vless: '/vps/renewvless',
    trojan: '/vps/renewtrojan'
  };
  const renewBase = routeMap[type];
  if (!renewBase) {
    return { ok: false, statusCode: 400, message: 'type harus vmess/vless/trojan' };
  }
  if (!username) {
    return { ok: false, statusCode: 400, message: 'username required' };
  }

  const core = readCoreApiRuntimeConfig();
  if (!core.ok) {
    return { ok: false, statusCode: 500, message: core.message };
  }

  const url = `http://127.0.0.1:${core.port}${renewBase}/${encodeURIComponent(username)}/${days}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: core.token,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    const text = await resp.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) {}
    if (!resp.ok) {
      return {
        ok: false,
        statusCode: Number(resp.status || 500),
        message: `core renew gagal (${resp.status})`,
        core_response: body || text || null
      };
    }
    return { ok: true, type, username, days, core_response: body || text || null };
  } catch (err) {
    return {
      ok: false,
      statusCode: 500,
      message: err?.message || 'request renew ke API utama gagal'
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
  const includeInactive = req.query.include_inactive ?? req.query.all_status;
  return authorizeAndRun(req, res, (db) => sendExportAccounts(db, res, type, limit, includeInactive));
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

app.get('/internal/export-runtime-settings', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    return sendExportRuntimeSettings(res);
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

app.post('/internal/restore-runtime-settings', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    const result = restoreRuntimeSettings(req.body?.settings || req.body || {});
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

app.post('/internal/renew-xray-account', (req, res) => {
  const type = String(req.body?.type || '').trim();
  const username = String(req.body?.username || '').trim();
  const days = Number(req.body?.days || 0);
  return authorizeAndRun(req, res, (db) => {
    db.close();
    renewXrayAccount(type, username, days)
      .then((result) => {
        if (!result.ok) {
          return res.status(Number(result.statusCode || 500)).json({
            ok: false,
            message: result.message,
            core_response: result.core_response || null
          });
        }
        return res.json(result);
      })
      .catch((err) => {
        return res.status(500).json({ ok: false, message: err?.message || 'renew gagal' });
      });
  });
});

app.post('/internal/sync-xray-from-db', (req, res) => {
  const type = String(req.body?.type || '').trim().toLowerCase();
  const restartRaw = req.body?.restart;
  const restart = restartRaw === true || /^(1|true|yes|on)$/i.test(String(restartRaw || '').trim());
  return authorizeAndRun(req, res, (db) => {
    db.close();
    syncXrayConfigFromDbByType(type, restart)
      .then((result) => {
        if (!result.ok) {
          return res.status(Number(result.statusCode || 500)).json(result);
        }
        return res.json(result);
      })
      .catch((err) => {
        return res.status(500).json({ ok: false, message: err?.message || 'sync xray gagal' });
      });
  });
});

app.post('/internal/apply-xray-restart', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    const restart = restartXrayService();
    if (!restart.ok) {
      return res.status(500).json({ ok: false, message: restart.message || 'restart xray gagal' });
    }
    return res.json({ ok: true, xray_restart: restart });
  });
});

app.post('/internal/sc-access-lock', (req, res) => {
  const blocked = req.body?.blocked;
  const reason = String(req.body?.reason || '').trim();
  const actor = String(req.body?.actor || '').trim();
  return authorizeAndRun(req, res, (db) => {
    db.close();
    const result = applyScAccessLock(blocked, reason, actor);
    if (!result.ok) {
      return res.status(Number(result.statusCode || 500)).json(result);
    }
    return res.json(result);
  });
});

app.post('/internal/sc-expired-notify', (req, res) => {
  const ip = String(req.body?.ip || '').trim() || '-';
  const reason = String(req.body?.reason || 'expired').trim();
  const actor = String(req.body?.actor || '-').trim();
  const users = Array.isArray(req.body?.users) ? req.body.users : [];
  const usersText = users
    .map((u) => String(u || '').trim())
    .filter(Boolean)
    .slice(0, 50)
    .join(', ');
  const customMessage = String(req.body?.message || '').trim();
  const message = customMessage || [
    'SC 1FORCR NOTIF',
    `Status : SC expired`,
    `IP VPS : ${ip}`,
    `Reason : ${reason}`,
    `Actor  : ${actor}`,
    `Users  : ${usersText || '-'}`,
    '',
    'Silakan perpanjang SC jika ingin akses kembali.'
  ].join('\n');
  return authorizeAndRun(req, res, (db) => {
    db.close();
    sendScTelegramMessage(message)
      .then((result) => {
        if (!result.ok) {
          return res.status(Number(result.statusCode || 500)).json(result);
        }
        return res.json({ ok: true, sent: true, chat_id: result.chat_id });
      })
      .catch((err) => {
        return res.status(500).json({ ok: false, message: err?.message || 'notif telegram gagal' });
      });
  });
});

app.post('/internal/sc-registration-meta', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    const result = applyScRegistrationMeta(req.body || {});
    if (!result.ok) {
      return res.status(Number(result.statusCode || 500)).json(result);
    }
    return res.json(result);
  });
});

app.post('/internal/trigger-update', (req, res) => {
  return authorizeAndRun(req, res, (db) => {
    db.close();
    return res.status(410).json({
      ok: false,
      message: 'endpoint trigger-update sudah dinonaktifkan permanen'
    });
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

app.listen(PORT, HOST, () => {
  console.log(`summary api on ${HOST}:${PORT}`);
});
JS

  cat > "${APP_DIR}/.env" <<EOF
SUMMARY_PORT=${SUMMARY_PORT}
SUMMARY_HOST=${SUMMARY_HOST}
POTATO_DB=${POTATO_DB}
SSH_TUNNEL_SHELL=${SSH_TUNNEL_SHELL}
USE_DB_AUTH=1
SYNC_TOKEN=
ZIVPN_CONFIG=/etc/zivpn/config.json
ZIVPN_SERVICE=
BANNER_HTML_FILE=/etc/sc-1forcr/banner.html
BANNER_TXT_FILE=/etc/sc-1forcr/banner.txt
XRAY_CONFIG_FILE=/usr/local/etc/xray/config.json
SC_ACCESS_LOCK_FILE=/etc/sc-1forcr-access.lock
SC_RUNTIME_ENV_FILE=/etc/sc-1forcr.env
SC_REG_META_FILE=/etc/sc-1forcr-registration.env
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

open_summary_firewall() {
  local port
  port="$(echo "${SUMMARY_PORT:-8789}" | tr -cd '0-9')"
  [[ -z "${port}" || "${port}" -lt 1 || "${port}" -gt 65535 ]] && port="8789"

  if command -v iptables >/dev/null 2>&1; then
    iptables -w 10 -C INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1 || \
      iptables -w 10 -I INPUT -p tcp --dport "${port}" -j ACCEPT
  elif command -v nft >/dev/null 2>&1; then
    if nft list chain inet filter input >/dev/null 2>&1; then
      nft list chain inet filter input | grep -F -- "tcp dport ${port} accept" >/dev/null 2>&1 || \
        nft add rule inet filter input tcp dport "${port}" accept
    elif nft list chain ip filter input >/dev/null 2>&1; then
      nft list chain ip filter input | grep -F -- "tcp dport ${port} accept" >/dev/null 2>&1 || \
        nft add rule ip filter input tcp dport "${port}" accept
    fi
  fi

  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
    systemctl enable netfilter-persistent >/dev/null 2>&1 || true
  elif command -v nft >/dev/null 2>&1 && systemctl is-enabled --quiet nftables 2>/dev/null; then
    nft list ruleset >/etc/nftables.conf 2>/dev/null || true
  fi
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
  echo "Listen       : ${SUMMARY_HOST}:${SUMMARY_PORT}"
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
  echo "Sync Xray from DB check:"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" -H \"content-type: application/json\" -d '{\"type\":\"vmess\"}' \"http://127.0.0.1:${SUMMARY_PORT}/internal/sync-xray-from-db\" && echo"
  echo
  echo "Apply Xray restart check:"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" -H \"content-type: application/json\" -d '{}' \"http://127.0.0.1:${SUMMARY_PORT}/internal/apply-xray-restart\" && echo"
  echo
  echo "SC access lock check:"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" -H \"content-type: application/json\" -d '{\"blocked\":true,\"reason\":\"admin_remove_sc_ip\"}' \"http://127.0.0.1:${SUMMARY_PORT}/internal/sc-access-lock\" && echo"
  echo
  echo "SC expired notify check:"
  echo "  curl -s -H \"x-sync-token: TOKEN_DARI_SERVERS_KEY\" -H \"content-type: application/json\" -d '{\"ip\":\"1.2.3.4\",\"reason\":\"admin_remove_sc_ip\",\"actor\":\"123\"}' \"http://127.0.0.1:${SUMMARY_PORT}/internal/sc-expired-notify\" && echo"
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
open_summary_firewall
print_result

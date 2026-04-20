const fs = require('fs');
const path = require('path');
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
const SC_REGISTRATION_FEE = Math.max(0, Number(process.env.SC_REGISTRATION_FEE || 25000) || 25000);
const TOPUP_MIN = Math.max(1000, Number(process.env.TOPUP_MIN || 5000) || 5000);
const TOPUP_EXPIRE_MS = Math.max(60000, Number(process.env.TOPUP_EXPIRE_MS || (5 * 60 * 1000)) || (5 * 60 * 1000));
const SC_INSTALLER_LOCAL_PATH = String(
  process.env.SC_INSTALLER_LOCAL_PATH || path.join(__dirname, 'payload', 'setup-autoscript-compat.sh')
).trim();
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map((v) => Number(String(v || '').trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const bot = new Telegraf(BOT_TOKEN);
const userState = new Map();
const db = new sqlite3.Database(DB_PATH);

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
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
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
  if (status === 401) return 'Unauthorized: key server salah atau tidak terdaftar.';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) {
    return 'Host tidak bisa diakses. Pastikan API summary aktif di port 8789.';
  }
  return msg;
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
  return dbAll(
    "SELECT vps_ip, created_at, updated_at FROM sc_registrations WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC",
    [userId]
  );
}

async function isIpOwnedByOther(ip, userId) {
  const row = await dbGet(
    "SELECT user_id FROM sc_registrations WHERE vps_ip = ? AND status = 'active' AND user_id <> ? LIMIT 1",
    [ip, userId]
  );
  return !!row;
}

async function hasRegisteredSc(userId) {
  const row = await dbGet(
    "SELECT 1 AS ok FROM sc_registrations WHERE user_id = ? AND status = 'active' LIMIT 1",
    [userId]
  );
  return !!row;
}

async function isRegisteredHost(userId, host) {
  const row = await dbGet(
    "SELECT 1 AS ok FROM sc_registrations WHERE user_id = ? AND vps_ip = ? AND status = 'active' LIMIT 1",
    [userId, host]
  );
  return !!row;
}

async function registerScIp(userId, ip) {
  await ensureUser(userId);

  if (await isIpOwnedByOther(ip, userId)) {
    throw new Error('IP VPS ini sudah terdaftar oleh user lain.');
  }

  const existing = await dbGet(
    "SELECT id, status FROM sc_registrations WHERE user_id = ? AND vps_ip = ? LIMIT 1",
    [userId, ip]
  );
  if (existing && String(existing.status).toLowerCase() === 'active') {
    return { already: true };
  }

  await dbRun('BEGIN IMMEDIATE TRANSACTION');
  try {
    const ok = await deductSaldoAtomic(userId, SC_REGISTRATION_FEE);
    if (!ok) {
      await dbRun('ROLLBACK');
      return { insufficient: true };
    }

    const now = Date.now();
    await dbRun(
      `INSERT INTO sc_registrations (user_id, vps_ip, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)
       ON CONFLICT(user_id, vps_ip) DO UPDATE SET status='active', updated_at=excluded.updated_at`,
      [userId, ip, now, now]
    );

    await saveTransaction(userId, -SC_REGISTRATION_FEE, 'sc_registration', `sc_reg_${userId}_${now}`);
    await dbRun('COMMIT');
    return { success: true };
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Registrasi SC 1FORCR Nexus', 'm_register_sc')],
    [Markup.button.callback('Cek Registrasi SC Saya', 'm_my_sc')],
    [Markup.button.callback('Ambil Link Install SC', 'm_install_link')],
    [Markup.button.callback('Topup Saldo GoPay', 'm_topup_saldo')],
    [Markup.button.callback('Cek Saldo', 'm_cek_saldo')],
    [Markup.button.callback('Auto Backup SC (kirim file)', 'm_backup_now')],
    [Markup.button.callback('Restore by Upload Backup', 'm_restore_upload')],
    [Markup.button.callback('Menu Admin API', 'm_admin_menu')]
  ]);
}

function adminMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Tambah Domain API', 'm_admin_add_domain')],
    [Markup.button.callback('List Domain API', 'm_admin_list_domains')],
    [Markup.button.callback('Hapus Domain API', 'm_admin_remove_domain')],
    [Markup.button.callback('Upload File Update SC', 'm_admin_upload_sc')],
    [Markup.button.callback('Kembali', 'm_admin_back')]
  ]);
}

async function requireRegistered(ctx) {
  const ok = await hasRegisteredSc(ctx.from.id);
  if (ok) return true;
  await ctx.reply(
    'Akses fitur SC ditolak.\n\n' +
      'Kamu harus registrasi SC 1FORCR Nexus dulu (wajib punya saldo).\n' +
      'Gunakan menu: "Registrasi SC 1FORCR Nexus".',
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
          `Topup expired.\nRef: ${row.reference_id || row.unique_code}\nNominal: Rp ${Number(row.amount || 0).toLocaleString('id-ID')}`
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
            `Topup berhasil.\nRef: ${row.reference_id || row.unique_code}\nNominal: Rp ${Number(row.amount || 0).toLocaleString('id-ID')}\nSaldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}`
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
  await ctx.reply(
    'SC 1FORCR Nexus Bot\n\n' +
      `Saldo kamu: Rp ${Number(saldo).toLocaleString('id-ID')}\n` +
      `IP SC terdaftar: ${regs.length}\n` +
      `Biaya registrasi SC per IP: Rp ${SC_REGISTRATION_FEE.toLocaleString('id-ID')}\n\n` +
      'Alur:\n' +
      '1) Topup saldo dulu (GoPay).\n' +
      '2) Registrasi IP VPS SC.\n' +
      '3) Setelah registrasi aktif, fitur SC (backup/restore/dinamis) bisa dipakai.' +
      (isAdmin(ctx.from.id) ? '\n\nAdmin: gunakan /admin untuk kelola domain API installer.' : ''),
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
  await ctx.reply('Masukkan domain API installer. Contoh: installer.domainkamu.com');
});

bot.action('m_admin_remove_domain', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx.from.id)) return ctx.reply('Akses ditolak. Hanya admin.');
  userState.set(ctx.chat.id, { step: 'admin_remove_domain' });
  await ctx.reply('Masukkan domain API yang ingin dihapus.');
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
  const lines = regs.map((r, i) => `${i + 1}. ${r.vps_ip}`);
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
    `Link installer:\n${installerUrl}\n\nPerintah install di VPS terdaftar:\n${cmd}`,
    mainMenu()
  );
});

bot.action('m_register_sc', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userState.set(ctx.chat.id, { step: 'register_sc_ip' });
  await ctx.reply(
    `Masukkan IP VPS SC yang ingin didaftarkan.\nBiaya registrasi: Rp ${SC_REGISTRATION_FEE.toLocaleString('id-ID')} / IP.\nKetik "batal" untuk batal.`
  );
});

bot.action('m_topup_saldo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userState.set(ctx.chat.id, { step: 'topup_amount' });
  await ctx.reply(
    `Masukkan nominal topup (minimal Rp ${TOPUP_MIN.toLocaleString('id-ID')}).\nKetik "batal" untuk batal.`
  );
});

bot.action(/m_check_topup_(.+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const code = String(ctx.match?.[1] || '');
  if (!code) return;
  const row = await dbGet('SELECT * FROM pending_deposits_app3 WHERE unique_code = ? AND user_id = ?', [code, ctx.from.id]);
  if (!row) return ctx.reply('Transaksi topup tidak ditemukan.');
  if (row.status !== 'pending') return ctx.reply(`Status topup: ${row.status}`);

  const now = Date.now();
  if (Number(row.expires_at || 0) > 0 && now > Number(row.expires_at || 0)) {
    await dbRun("UPDATE pending_deposits_app3 SET status='expired' WHERE unique_code = ?", [row.unique_code]);
    return ctx.reply('Topup sudah expired.');
  }

  const st = await checkGoPayStatus(String(row.provider_tx_id || '')).catch((e) => ({ error: e.message }));
  if (st?.error) return ctx.reply(`Gagal cek status: ${st.error}`);
  if (st.settled) {
    const credited = await markPendingPaid(row);
    const saldoNow = await getSaldo(ctx.from.id).catch(() => 0);
    if (credited) {
      return ctx.reply(`Topup berhasil. Saldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}`, mainMenu());
    }
    return ctx.reply('Topup sudah diproses sebelumnya.');
  }
  return ctx.reply(`Topup masih pending. Status gateway: ${st.status || 'pending'}`);
});

bot.action(/m_cancel_topup_(.+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const code = String(ctx.match?.[1] || '');
  if (!code) return;
  const row = await dbGet('SELECT * FROM pending_deposits_app3 WHERE unique_code = ? AND user_id = ?', [code, ctx.from.id]);
  if (!row) return ctx.reply('Transaksi topup tidak ditemukan.');
  if (row.status !== 'pending') return ctx.reply(`Status topup: ${row.status}`);
  await dbRun("UPDATE pending_deposits_app3 SET status='cancelled' WHERE unique_code = ?", [code]);
  return ctx.reply('Topup dibatalkan.');
});

bot.action('m_backup_now', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await requireRegistered(ctx))) return;
  userState.set(ctx.chat.id, { step: 'backup_host' });
  await ctx.reply('Masukkan IP VPS sumber backup (wajib IP yang sudah terdaftar). Ketik "batal" untuk batal.');
});

bot.action('m_restore_upload', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await requireRegistered(ctx))) return;
  userState.set(ctx.chat.id, { step: 'restore_host' });
  await ctx.reply('Masukkan IP VPS tujuan restore (wajib IP yang sudah terdaftar). Ketik "batal" untuk batal.');
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
    if (state.step === 'admin_add_domain') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const domain = normalizeDomain(text);
      if (!isDomainLike(domain)) return ctx.reply('Format domain tidak valid. Contoh: installer.domainkamu.com');
      await addApiDomain(domain, ctx.from.id);
      userState.delete(ctx.chat.id);
      return ctx.reply(`Domain API ditambahkan: ${domain}`, adminMenu());
    }

    if (state.step === 'admin_remove_domain') {
      if (!isAdmin(ctx.from.id)) {
        userState.delete(ctx.chat.id);
        return ctx.reply('Akses ditolak. Hanya admin.');
      }
      const domain = normalizeDomain(text);
      if (!isDomainLike(domain)) return ctx.reply('Format domain tidak valid.');
      await removeApiDomain(domain);
      userState.delete(ctx.chat.id);
      return ctx.reply(`Domain API dihapus (jika ada): ${domain}`, adminMenu());
    }

    if (state.step === 'register_sc_ip') {
      const ip = normalizeHost(text);
      if (!isIpv4(ip)) return ctx.reply('Format IP tidak valid. Contoh: 103.10.10.2');
      const result = await registerScIp(ctx.from.id, ip);
      if (result.already) {
        userState.delete(ctx.chat.id);
        return ctx.reply(`IP ${ip} sudah terdaftar di akun kamu.`, mainMenu());
      }
      if (result.insufficient) {
        const saldo = await getSaldo(ctx.from.id);
        userState.delete(ctx.chat.id);
        return ctx.reply(
          `Saldo tidak cukup untuk registrasi.\n` +
            `Biaya: Rp ${SC_REGISTRATION_FEE.toLocaleString('id-ID')}\n` +
            `Saldo kamu: Rp ${Number(saldo).toLocaleString('id-ID')}\n\n` +
            `Silakan topup dulu via menu "Topup Saldo GoPay".`,
          mainMenu()
        );
      }
      const saldoNow = await getSaldo(ctx.from.id);
      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Registrasi SC berhasil.\nIP: ${ip}\nBiaya potong saldo: Rp ${SC_REGISTRATION_FEE.toLocaleString('id-ID')}\nSaldo sekarang: Rp ${Number(saldoNow).toLocaleString('id-ID')}`,
        mainMenu()
      );
    }

    if (state.step === 'topup_amount') {
      const amount = Number(String(text).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(amount) || amount < TOPUP_MIN) {
        return ctx.reply(`Nominal tidak valid. Minimal Rp ${TOPUP_MIN.toLocaleString('id-ID')}.`);
      }

      await ctx.reply('Membuat QR topup GoPay, tunggu...');
      const qr = await createGoPayQr(amount);
      const code = makeUniqueCode(ctx.from.id);
      const now = Date.now();
      const expires = now + TOPUP_EXPIRE_MS;
      const ref = `TOPUP_APP3_${ctx.from.id}_${now}`;

      await dbRun(
        `INSERT INTO pending_deposits_app3
         (unique_code, user_id, amount, status, provider_tx_id, qr_url, reference_id, created_at, expires_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [code, ctx.from.id, amount, qr.providerTxId, qr.qrUrl, ref, now, expires]
      );

      userState.delete(ctx.chat.id);
      const caption =
        `Topup GoPay dibuat.\n` +
        `Nominal: Rp ${amount.toLocaleString('id-ID')}\n` +
        `Ref: ${ref}\n` +
        `Expired: ${Math.floor(TOPUP_EXPIRE_MS / 60000)} menit`;

      try {
        await ctx.replyWithPhoto(qr.qrUrl, {
          caption,
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Cek Status Topup', `m_check_topup_${code}`)],
            [Markup.button.callback('Batalkan Topup', `m_cancel_topup_${code}`)]
          ])
        });
      } catch (_) {
        await ctx.reply(
          `${caption}\nQR: ${qr.qrUrl}`,
          Markup.inlineKeyboard([
            [Markup.button.callback('Cek Status Topup', `m_check_topup_${code}`)],
            [Markup.button.callback('Batalkan Topup', `m_cancel_topup_${code}`)]
          ])
        );
      }
      return;
    }

    if (state.step === 'backup_host') {
      const host = normalizeHost(text);
      if (!isIpv4(host)) return ctx.reply('Host harus IP VPS yang valid.');
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
        { caption: `Backup selesai.\nHost: ${state.host}\nSSH: ${backupPayload.data.ssh.length}, VMESS: ${backupPayload.data.vmess.length}, VLESS: ${backupPayload.data.vless.length}, TROJAN: ${backupPayload.data.trojan.length}, ZIVPN: ${backupPayload.data.zivpn_auth.length}` }
      );
      return;
    }

    if (state.step === 'restore_host') {
      const host = normalizeHost(text);
      if (!isIpv4(host)) return ctx.reply('Host harus IP VPS yang valid.');
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

      const textSample = content.toString('utf8', 0, Math.min(content.length, 2000));
      if (!/setup-autoscript-compat|^#!\/usr\/bin\/env bash|^#!\/bin\/bash/m.test(textSample)) {
        return ctx.reply('File tidak terlihat seperti script installer bash yang valid.');
      }

      const targetPath = SC_INSTALLER_LOCAL_PATH;
      const targetDir = path.dirname(targetPath);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, content);
      try { fs.chmodSync(targetPath, 0o755); } catch (_) {}

      userState.delete(ctx.chat.id);
      return ctx.reply(
        `Upload update SC berhasil.\n` +
          `Path lokal: ${targetPath}\n` +
          `Ukuran: ${content.length} bytes`,
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

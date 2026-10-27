'use strict';

// Regresi Mode Bot Panel (bot Telegram jualan akun di VPS, bot-panel.js hasil
// generate installer):
// - Detail akun sama persis dengan menu CLI dan BotVPN (fixture parity).
// - Uang pembeli: top up hanya dikredit sekali, pembelian gagal dikembalikan,
//   hasil tidak pasti diserahkan ke admin, klik ganda tidak memotong dua kali.
// - Server ini tersembunyi sampai admin mengisi harga; callback rakitan
//   (durasi aneh, menu admin, akun orang lain) ditolak.
// - Backup dan restore database (caption /restore dan menu dengan konfirmasi).
// - Broadcast teks/gambar ke semua pengguna atau reseller lewat copyMessage.
// - Broadcast teks + lampiran video/stiker: teks jadi caption atau pesan kedua,
//   dan retry 429 tidak mengirim ulang media.
// - Integrasi installer: service hemat resource dan mati secara default.
//
// Database memakai SQLite sungguhan lewat node:sqlite (Node 22.5+), dipasang
// dengan adaptor yang meniru API callback modul sqlite3 milik VPS.
// BOT_PANEL_SOURCE=path/bot-panel.js menguji file lepas (tanpa cek installer).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
const HEREDOC_START = '  cat > "${APP_DIR}/bot-panel.js" <<\'BOT_PANEL_EOF\'\n';
const sourceOverride = process.env.BOT_PANEL_SOURCE || '';

function extractSource() {
  if (sourceOverride) return fs.readFileSync(sourceOverride, 'utf8').replace(/\r\n/g, '\n');
  const start = installer.indexOf(HEREDOC_START);
  assert(start >= 0, 'heredoc bot-panel.js tidak ditemukan di installer');
  const body = start + HEREDOC_START.length;
  const end = installer.indexOf('\nBOT_PANEL_EOF\n', body);
  assert(end > body, 'penutup BOT_PANEL_EOF tidak ditemukan');
  return installer.slice(body, end + 1);
}

const source = extractSource();

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_err) {
  console.log('test-bot-panel: node:sqlite tidak tersedia (butuh Node 22.5+), test dilewati.');
  process.exit(0);
}

// ── Cek statis source ───────────────────────────────────────────────────────

const EMOJI_RE = /\p{Extended_Pictographic}/u;
assert.deepStrictEqual(
  source.split('\n').map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => EMOJI_RE.test(line)).map(({ n, line }) => `${n}: ${line.trim()}`),
  [],
  'bot-panel.js tidak boleh memakai emoji'
);
assert(!/\bfetch\(/.test(source), 'jangan pakai fetch global (Node 18 ke bawah di VPS lama)');
const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
assert.deepStrictEqual([...new Set(requires)].sort(), ['crypto', 'fs', 'http', 'https', 'path', 'sqlite3'],
  'bot-panel.js hanya boleh memakai modul bawaan Node dan sqlite3 milik api.js');
assert(!/log\([^)]*CONFIG\.(token|localToken)/.test(source), 'token tidak boleh ditulis ke log');
// Bot jualan terpisah dari bot notifikasi: token dan chat notif tidak dibaca.
assert(!/envStr\('TELEGRAM_|process\.env\.TELEGRAM_|ENV\.TELEGRAM_/.test(source), 'bot jualan tidak boleh memakai TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID milik bot notif');
assert(/envStr\('BOT_PANEL_TOKEN'\)/.test(source), 'bot jualan memakai BOT_PANEL_TOKEN');

// ── Muat modul dengan env tiruan ────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-panel-test-'));
const dbPath = path.join(tmp, 'state', 'bot-panel.db');
Object.assign(process.env, {
  BOT_PANEL_ENABLE: '1',
  BOT_PANEL_TOKEN: '654321:JUALANTOKEN',
  TELEGRAM_BOT_TOKEN: '123456:NOTIFTOKEN',
  TELEGRAM_CHAT_ID: '-1009999',
  BOT_PANEL_ADMIN_IDS: '1001',
  BOT_PANEL_DB: dbPath,
  DOMAIN: 'vpn.example.com',
  PORT: '5888',
  API_AUTH_TOKEN: 'localtoken123'
});

function loadBot() {
  const file = path.join(tmp, 'bot-panel.js');
  const mod = new Module(file, null);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(repoRoot);
  mod._compile(source, file);
  return mod.exports;
}

const bot = loadBot();

function openShim(file) {
  const handle = new DatabaseSync(file);
  const norm = (params) => (Array.isArray(params) ? params : []).map((v) => (v === undefined ? null : v));
  return Promise.resolve({
    run(sql, params, cb) {
      let result;
      try { result = handle.prepare(sql).run(...norm(params)); } catch (err) { cb.call({}, err); return; }
      cb.call({ changes: Number(result.changes), lastID: Number(result.lastInsertRowid) }, null);
    },
    get(sql, params, cb) {
      let row;
      try { row = handle.prepare(sql).get(...norm(params)); } catch (err) { cb(err); return; }
      cb(null, row ? { ...row } : undefined);
    },
    all(sql, params, cb) {
      let rows;
      try { rows = handle.prepare(sql).all(...norm(params)); } catch (err) { cb(err); return; }
      cb(null, rows.map((r) => ({ ...r })));
    },
    exec(sql, cb) {
      try { handle.exec(sql); } catch (err) { cb(err); return; }
      cb(null);
    },
    close(cb) {
      try { handle.close(); } catch (_err) { /* sudah tertutup */ }
      if (cb) cb(null);
    }
  });
}

const tgCalls = [];
let messageSeq = 1000;
const httpCalls = [];
let httpHandler = () => { throw new Error('httpHandler belum diatur'); };
const sentDocs = [];
let downloadSource = '';

bot.deps.openDatabase = openShim;
const blockedChats = new Set();
let copyRateLimit = null;
bot.deps.tgRequest = async (method, payload) => {
  tgCalls.push({ method, payload });
  if (method === 'copyMessage' && copyRateLimit && copyRateLimit(payload)) {
    const err = new Error('Too Many Requests: retry after 0');
    err.code = 429;
    err.retryAfter = 0;
    throw err;
  }
  if (method === 'copyMessage' && blockedChats.has(Number(payload.chat_id))) {
    const err = new Error('Forbidden: bot was blocked by the user');
    err.code = 403;
    throw err;
  }
  if (method === 'getMe') return { username: 'tokobot' };
  if (method === 'getFile') return { file_path: 'documents/backup.db' };
  if (['sendMessage', 'sendPhoto', 'editMessageText'].includes(method)) return { message_id: messageSeq++ };
  return true;
};
bot.deps.httpJson = async (req) => {
  httpCalls.push(req);
  return httpHandler(req);
};
bot.deps.sendDocument = async (chatId, filePath, fileName, caption) => {
  assert(fs.existsSync(filePath), 'file backup harus ada saat dikirim');
  sentDocs.push({ chatId, filePath, fileName, caption, size: fs.statSync(filePath).size, copy: fs.readFileSync(filePath) });
  return { message_id: messageSeq++ };
};
bot.deps.downloadTelegramFile = async (_filePath, target) => {
  fs.copyFileSync(downloadSource, target);
  return fs.statSync(target).size;
};

const ADMIN = 1001;
const BUYER = 2002;
const OTHER = 3003;
let updateSeq = 1;

function textUpdate(userId, text, chatType = 'private') {
  return { update_id: updateSeq++, message: { message_id: messageSeq++, from: { id: userId, first_name: `User${userId}` }, chat: { id: chatType === 'private' ? userId : -100555, type: chatType }, text } };
}

function cbUpdate(userId, data) {
  return { update_id: updateSeq++, callback_query: { id: `cb${updateSeq}`, from: { id: userId, first_name: `User${userId}` }, data, message: { message_id: 777, chat: { id: userId, type: 'private' }, text: 'menu' } } };
}

function since(mark) {
  return tgCalls.slice(mark);
}

function texts(calls) {
  return calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.payload.text).join('\n----\n');
}

function alerts(calls) {
  return calls.filter((c) => c.method === 'answerCallbackQuery' && c.payload.text).map((c) => c.payload.text).join('\n');
}

async function step(update) {
  const mark = tgCalls.length;
  await bot.handleUpdate(update);
  return since(mark);
}

const ok = (data) => ({ status: 200, json: { meta: { code: 200, message: 'success' }, data } });
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'account-message-parity.json'), 'utf8'));

async function saldo(id) {
  return Number((await bot.get('SELECT saldo FROM users WHERE id = ?', [id])).saldo);
}

(async () => {
  await bot.openStore();

  // ── Detail akun = menu CLI = BotVPN ─────────────────────────────────────
  for (const item of fixture.cases) {
    const trial = item.mode === 'trial';
    const message = item.type === 'ssh'
      ? bot.formatSshAccountMessage(item.data, { trial })
      : bot.formatXrayAccountMessage(item.type, item.data, { trial });
    const footer = bot.storeFooter(undefined, trial);
    const plain = String(message).replace(/[*`]/g, '').split('\n').filter((line) => line !== footer).join('\n').replace(/^\n+|\n+$/g, '');
    assert.strictEqual(plain, item.expected, `${item.name}: detail akun bot panel berbeda dengan menu`);
  }

  // ── Format kecil ────────────────────────────────────────────────────────
  assert.strictEqual(bot.rupiah(1234567), 'Rp 1.234.567');
  assert.strictEqual(bot.rupiah(-5000), '-Rp 5.000');
  assert.strictEqual(bot.normalizeDomain('https://SG1.Example.com/vps/'), 'sg1.example.com');
  assert.strictEqual(bot.normalizeDomain('http://1.2.3.4'), '');
  assert.strictEqual(bot.normalizeDomain('bad domain'), '');
  assert.strictEqual(bot.normalizeBaseUrl('api-gopay.sawargipay.cloud/qris/generate', ['/qris/generate']), 'https://api-gopay.sawargipay.cloud');
  assert.strictEqual(bot.parseExpiry('2026-11-06 14:05:09', 0), Date.parse('2026-11-06T14:05:09+07:00'));
  assert.strictEqual(bot.inferStyle('Kembali'), '');
  assert.strictEqual(bot.inferStyle('Hapus Server'), 'danger');
  assert.strictEqual(bot.inferStyle('Buka Blokir'), 'primary');
  assert.strictEqual(bot.inferStyle('Ya, Buat Akun'), 'success');
  assert.strictEqual(bot.inferStyle('Kelola Server'), 'primary');

  // ── /start, grup, dan menu admin ────────────────────────────────────────
  let calls = await step(textUpdate(BUYER, '/start'));
  let home = calls.find((c) => c.method === 'sendMessage');
  assert(home && /Saldo/.test(home.payload.text) && /Rp 0/.test(home.payload.text), '/start harus menampilkan info dan saldo');
  const buyerButtons = home.payload.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert(!buyerButtons.includes('Menu Admin'), 'pembeli tidak boleh melihat Menu Admin');
  assert.deepStrictEqual(home.payload.reply_markup.inline_keyboard.map((row) => row.map((b) => b.style || '')),
    [['success', 'success'], ['success', 'success'], ['success', 'success'], ['primary', 'primary']], 'warna menu utama per baris');
  assert(buyerButtons.includes('Hubungi Admin'), 'menu utama pembeli punya Hubungi Admin');
  assert(/╭━+\n┃ <b>/.test(home.payload.text) && /┃ ╰ Saldo  : <b>Rp 0<\/b>/.test(home.payload.text) && /\n╰━+/.test(home.payload.text), `menu utama memakai bingkai garis:\n${home.payload.text}`);
  assert(/Status : Member/.test(home.payload.text) && /Top up minimal Rp 30\.000 sekaligus untuk otomatis jadi reseller/.test(home.payload.text), 'pembeli biasa melihat status dan syarat reseller otomatis');
  // Kontak admin: tanpa kontak tombol membuka layar kontak; @username dan nomor WA jadi link.
  const contactBtn = (markup) => markup.inline_keyboard.flat().find((b) => b.text === 'Hubungi Admin');
  assert.strictEqual(contactBtn(home.payload.reply_markup).callback_data, 'ct');
  calls = await step(cbUpdate(BUYER, 'ct'));
  assert(/HUBUNGI ADMIN/.test(texts(calls)) && /tg:\/\/user\?id=1001/.test(texts(calls)) && new RegExp(`<code>${BUYER}</code>`).test(texts(calls)), 'layar kontak menyebut admin dan ID pembeli');
  assert.strictEqual(bot.contactUrl('@toko_vpn'), 'https://t.me/toko_vpn');
  assert.strictEqual(bot.contactUrl('t.me/toko_vpn'), 'https://t.me/toko_vpn');
  assert.strictEqual(bot.contactUrl('0812-3456-7890'), 'https://wa.me/6281234567890');
  assert.strictEqual(bot.contactUrl('https://wa.me/6281234567890'), 'https://wa.me/6281234567890');
  assert.strictEqual(bot.contactUrl('chat admin di grup'), '');
  assert.strictEqual(bot.contactUrl('javascript:alert(1)'), '');
  await bot.setSetting('contact', '@toko_vpn');
  calls = await step(textUpdate(BUYER, '/start'));
  assert.strictEqual(contactBtn(calls.find((c) => c.method === 'sendMessage').payload.reply_markup).url, 'https://t.me/toko_vpn', 'kontak @username jadi tombol link');
  await bot.setSetting('contact', '');
  calls = await step(textUpdate(ADMIN, '/start'));
  assert(calls.find((c) => c.method === 'sendMessage').payload.reply_markup.inline_keyboard.flat().some((b) => b.text === 'Menu Admin'), 'admin harus melihat Menu Admin');
  await step(textUpdate(OTHER, '/start'));

  calls = await step(textUpdate(4004, '/start', 'group'));
  assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 0, 'pesan di grup (grup notifikasi) diabaikan');
  assert(!(await bot.get('SELECT id FROM users WHERE id = 4004')), 'pengguna grup tidak didaftarkan');

  calls = await step(cbUpdate(BUYER, 'a:sv'));
  assert(/khusus admin/.test(alerts(calls)), 'callback admin rakitan dari pembeli harus ditolak');

  // ── Server ini tersembunyi sampai harga diisi ───────────────────────────
  const local = await bot.get('SELECT * FROM servers WHERE local = 1');
  assert(local && local.domain === 'vpn.example.com' && Number(local.price_day) === 0, 'server lokal terdaftar otomatis tanpa harga');
  calls = await step(cbUpdate(BUYER, 'b'));
  assert(/Belum ada server/.test(texts(calls)), 'server tanpa harga tidak boleh dijual');
  calls = await step(cbUpdate(BUYER, `b:s:${local.id}`));
  assert(/tidak tersedia/.test(texts(calls)), 'callback rakitan ke server tanpa harga harus ditolak');

  await step(cbUpdate(ADMIN, `a:se:${local.id}:price_day`));
  await step(textUpdate(ADMIN, '1.000'));
  assert.strictEqual(Number((await bot.get('SELECT price_day FROM servers WHERE id = ?', [local.id])).price_day), 1000);
  await step(cbUpdate(ADMIN, `a:se:${local.id}:quota_gb`));
  await step(textUpdate(ADMIN, '50'));

  // ── Payment gateway & top up ────────────────────────────────────────────
  calls = await step(cbUpdate(ADMIN, 'a:pt:gopay'));
  assert(/Isi key GoPay/.test(alerts(calls)), 'gateway tanpa key tidak boleh diaktifkan');
  await step(cbUpdate(ADMIN, 'a:pe:gopay_key'));
  calls = await step(textUpdate(ADMIN, 'gopaykey-ABCDEFGH1234'));
  assert(calls.some((c) => c.method === 'deleteMessage'), 'pesan berisi key harus dihapus');
  await step(cbUpdate(ADMIN, 'a:pt:gopay'));
  assert.strictEqual(bot.setting('gopay_enable'), '1');

  calls = await step(cbUpdate(BUYER, 'tu:a:500'));
  assert(/Nominal top up harus antara/.test(alerts(calls) + texts(calls)), 'nominal di bawah minimal ditolak');

  let gopayStatus = 'pending';
  httpHandler = (req) => {
    if (req.url.endsWith('/qris/generate')) {
      assert.strictEqual(req.headers.Authorization, 'Bearer gopaykey-ABCDEFGH1234');
      assert.deepStrictEqual(req.body, { amount: 20000 });
      return { status: 200, json: { success: true, data: { transaction_id: 'GP-1', qr_url: 'https://qr.example/gp1.png' } } };
    }
    if (req.url.endsWith('/qris/status')) {
      assert.deepStrictEqual(req.body, { transaction_id: 'GP-1' });
      return { status: 200, json: { success: true, data: { transaction_status: gopayStatus } } };
    }
    throw new Error(`url tak terduga ${req.url}`);
  };
  calls = await step(cbUpdate(BUYER, 'tu:a:20000'));
  const photo = calls.find((c) => c.method === 'sendPhoto');
  assert(photo && photo.payload.photo === 'https://qr.example/gp1.png', 'QRIS dikirim sebagai URL gambar dari gateway');
  let dep = await bot.get("SELECT * FROM deposits WHERE user_id = ? AND status = 'pending'", [BUYER]);
  assert(dep && dep.message_id, 'top up tersimpan pending beserta message_id QRIS');

  calls = await step(cbUpdate(BUYER, 'tu:a:20000'));
  assert(/Masih ada top up/.test(alerts(calls) + texts(calls)), 'hanya satu top up pending per pengguna');

  bot._state.depositLastCheck.clear();
  assert.strictEqual(await bot.pollDeposits(), true, 'top up belum dibayar tetap ditunggu');
  assert.strictEqual(await saldo(BUYER), 0);

  gopayStatus = 'settlement';
  bot._state.depositLastCheck.clear();
  let mark = tgCalls.length;
  assert.strictEqual(await bot.pollDeposits(), false);
  assert.strictEqual(await saldo(BUYER), 20000, 'top up lunas dikredit');
  assert(/TOP UP BERHASIL/.test(texts(since(mark))) && /TOP UP MASUK/.test(texts(since(mark))), 'pembeli dan admin diberi tahu');
  assert(since(mark).some((c) => c.method === 'deleteMessage'), 'pesan QRIS dihapus setelah lunas');
  assert.strictEqual(await bot.settleDeposit(dep), false, 'settle kedua tidak mengkredit lagi');
  assert.strictEqual(await saldo(BUYER), 20000);
  assert.strictEqual(Number((await bot.get("SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND kind = 'topup'", [BUYER])).n), 1);

  // ── Pembelian ──────────────────────────────────────────────────────────
  const vmess = fixture.cases.find((c) => c.name === 'vmess-create-multipath').data;
  httpHandler = (req) => {
    assert.strictEqual(req.url, 'http://127.0.0.1:5888/vps/vmessall', 'server lokal dipanggil lewat 127.0.0.1');
    assert.strictEqual(req.headers.Authorization, 'localtoken123');
    assert.strictEqual(req.body.username, 'budi01');
    assert.strictEqual(req.body.expired, 7);
    assert.strictEqual(req.body.kuota, 50);
    assert.strictEqual(req.body.telegram_user_id, BUYER);
    return ok({ ...vmess, username: 'budi01' });
  };
  await step(cbUpdate(BUYER, 'b'));
  await step(cbUpdate(BUYER, `b:s:${local.id}`));
  await step(cbUpdate(BUYER, `b:p:${local.id}:vmess`));
  calls = await step(textUpdate(BUYER, 'Budi 01'));
  assert(/Username tidak valid/.test(texts(calls)), 'username tidak valid ditolak');
  await step(textUpdate(BUYER, 'budi01'));
  calls = await step(cbUpdate(BUYER, 'b:d:7'));
  assert(/KONFIRMASI PEMBELIAN/.test(texts(calls)) && /Rp 7\.000/.test(texts(calls)));
  mark = tgCalls.length;
  await step(cbUpdate(BUYER, 'b:y'));
  const accountMsg = since(mark).find((c) => c.method === 'sendMessage' && c.payload.parse_mode === 'Markdown');
  assert(accountMsg && /VMESS ACCOUNT/.test(accountMsg.payload.text), 'detail akun dikirim');
  assert.strictEqual(await saldo(BUYER), 13000, 'saldo terpotong harga x hari');
  const acc = await bot.get("SELECT * FROM accounts WHERE username = 'budi01'");
  assert(acc && Number(acc.user_id) === BUYER && Number(acc.trial) === 0, 'akun tercatat milik pembeli');

  calls = await step(cbUpdate(BUYER, 'b:y'));
  assert(/Sesi pembelian sudah habis/.test(texts(calls)), 'klik ganda konfirmasi tidak membuat pesanan kedua');
  assert.strictEqual(await saldo(BUYER), 13000);

  calls = await step(cbUpdate(BUYER, 'b:d:-5'));
  assert(/tidak valid/.test(texts(calls)), 'durasi rakitan ditolak');

  // Gagal pasti: saldo kembali.
  httpHandler = () => ({ status: 409, json: { meta: { code: 409, message: 'username sudah dipakai' }, message: 'username sudah dipakai' } });
  await step(cbUpdate(BUYER, `b:p:${local.id}:vmess`));
  await step(textUpdate(BUYER, 'budi02'));
  await step(cbUpdate(BUYER, 'b:d:3'));
  calls = await step(cbUpdate(BUYER, 'b:y'));
  assert(/username sudah dipakai/.test(texts(calls)) && /dikembalikan/.test(texts(calls)), 'galat API ditampilkan dan saldo dikembalikan');
  assert.strictEqual(await saldo(BUYER), 13000, 'refund otomatis');
  assert.strictEqual((await bot.get("SELECT status FROM orders WHERE username = 'budi02'")).status, 'refunded');

  // Hasil tidak pasti: saldo tertahan, admin yang memutuskan.
  httpHandler = () => { const err = new Error('timeout'); err.uncertain = true; throw err; };
  await step(cbUpdate(BUYER, `b:p:${local.id}:vmess`));
  await step(textUpdate(BUYER, 'budi03'));
  await step(cbUpdate(BUYER, 'b:d:1'));
  mark = tgCalls.length;
  calls = await step(cbUpdate(BUYER, 'b:y'));
  assert(/diteruskan ke admin/.test(texts(calls)), 'pembeli diberi tahu pesanan dicek admin');
  assert(/PESANAN PERLU DICEK/.test(texts(since(mark))), 'admin diberi tahu');
  assert.strictEqual(await saldo(BUYER), 12000, 'saldo tertahan selama review');
  const review = await bot.get("SELECT * FROM orders WHERE username = 'budi03'");
  assert.strictEqual(review.status, 'review');
  await step(cbUpdate(ADMIN, `a:or:r:${review.id}`));
  assert.strictEqual(await saldo(BUYER), 13000, 'refund admin mengembalikan saldo');
  await step(cbUpdate(ADMIN, `a:or:r:${review.id}`));
  assert.strictEqual(await saldo(BUYER), 13000, 'refund kedua tidak mengkredit lagi');

  // Saldo kurang: tidak ada pesanan.
  await step(cbUpdate(BUYER, `b:p:${local.id}:ssh`));
  await step(textUpdate(BUYER, 'budi04'));
  await step(cbUpdate(BUYER, 'b:rp'));
  calls = await step(cbUpdate(BUYER, 'b:d:90'));
  assert(/Saldo kurang/.test(texts(calls)), 'saldo kurang ditolak sebelum memanggil API');
  assert(!(await bot.get("SELECT id FROM orders WHERE username = 'budi04'")), 'tidak ada pesanan saat saldo kurang');

  // ── Perpanjang ─────────────────────────────────────────────────────────
  httpHandler = (req) => {
    assert.strictEqual(req.url, 'http://127.0.0.1:5888/vps/renewvmess/budi01/7');
    return ok({ username: 'budi01', exp: '2026-12-31 10:00:00' });
  };
  calls = await step(cbUpdate(OTHER, `r:a:${acc.id}`));
  assert(/tidak ditemukan/.test(texts(calls)), 'akun orang lain tidak bisa diperpanjang');
  await step(cbUpdate(BUYER, 'r'));
  await step(cbUpdate(BUYER, `r:a:${acc.id}`));
  calls = await step(cbUpdate(BUYER, `r:d:${acc.id}:999`));
  assert(!/KONFIRMASI/.test(texts(calls)), 'durasi perpanjang rakitan ditolak');
  await step(cbUpdate(BUYER, `r:d:${acc.id}:7`));
  calls = await step(cbUpdate(BUYER, `r:y:${acc.id}:7`));
  assert(/PERPANJANGAN BERHASIL/.test(texts(calls)));
  assert.strictEqual(await saldo(BUYER), 6000);
  assert.strictEqual((await bot.get('SELECT expired FROM accounts WHERE id = ?', [acc.id])).expired, '2026-12-31 10:00:00');
  calls = await step(cbUpdate(BUYER, `r:y:${acc.id}:7`));
  assert(/Sesi perpanjangan sudah habis/.test(texts(calls)), 'klik ganda perpanjang tidak memotong dua kali');
  assert.strictEqual(await saldo(BUYER), 6000);

  // ── Trial ───────────────────────────────────────────────────────────────
  const sshTrial = fixture.cases.find((c) => c.name === 'ssh-trial-udpcustom').data;
  httpHandler = (req) => {
    assert.strictEqual(req.url, 'http://127.0.0.1:5888/vps/trialsshvpn');
    return ok({ ...sshTrial, username: `trial${httpCalls.length}` });
  };
  calls = await step(cbUpdate(OTHER, `t:p:${local.id}:ssh`));
  assert(calls.some((c) => c.method === 'sendMessage' && /TRIAL SSH ACCOUNT/.test(c.payload.text)), 'trial dibuat');
  calls = await step(cbUpdate(OTHER, `t:p:${local.id}:ssh`));
  assert(/Jatah trial hari ini sudah habis/.test(texts(calls)), 'trial dibatasi per hari');

  // ── Tambah server lain lewat domain + token ─────────────────────────────
  httpHandler = (req) => {
    if (req.url === 'https://sg1.example.com/vps/health') return ok({ ok: true, domain: 'sg1.example.com' });
    if (req.url === 'https://sg1.example.com/vps/capacity') {
      return req.headers.Authorization === 'remotetoken123'
        ? ok({ capacity_status: 'OK', can_add_users: 5 })
        : { status: 401, json: { meta: { code: 401, message: 'unauthorized' } } };
    }
    throw new Error(`url tak terduga ${req.url}`);
  };
  await step(cbUpdate(ADMIN, 'a:sva'));
  await step(textUpdate(ADMIN, 'SG Premium'));
  calls = await step(textUpdate(ADMIN, 'vpn.example.com'));
  assert(/sudah terdaftar/.test(texts(calls)), 'domain server ini tidak boleh didaftarkan dua kali');
  await step(textUpdate(ADMIN, 'https://SG1.example.com/'));
  calls = await step(textUpdate(ADMIN, 'salahtoken999'));
  assert(/Token ditolak/.test(texts(calls)), 'token salah ditolak');
  assert(calls.some((c) => c.method === 'deleteMessage'), 'pesan token dihapus');
  calls = await step(textUpdate(ADMIN, 'remotetoken123'));
  assert(/Server terhubung/.test(texts(calls)));
  await step(textUpdate(ADMIN, '2000'));
  const remote = await bot.get("SELECT * FROM servers WHERE domain = 'sg1.example.com'");
  assert(remote && remote.token === 'remotetoken123' && Number(remote.price_day) === 2000 && Number(remote.local) === 0, 'server lain tersimpan');

  httpHandler = (req) => {
    assert.strictEqual(req.url, 'https://sg1.example.com/vps/trojanall', 'server lain dipanggil lewat HTTPS domain');
    assert.strictEqual(req.headers.Authorization, 'remotetoken123');
    return ok({ ...fixture.cases.find((c) => c.name === 'trojan-create').data, username: 'remote01' });
  };
  await step(cbUpdate(BUYER, `b:p:${remote.id}:trojan`));
  await step(textUpdate(BUYER, 'remote01'));
  await step(cbUpdate(BUYER, 'b:d:3'));
  calls = await step(cbUpdate(BUYER, 'b:y'));
  assert(calls.some((c) => c.method === 'sendMessage' && /TROJAN ACCOUNT/.test(c.payload.text)), 'akun di server lain dibuat');
  assert.strictEqual(await saldo(BUYER), 0);

  // ── Top up: batal saat gateway mati, kedaluwarsa dengan masa tenggang ───
  httpHandler = (req) => {
    if (req.url.endsWith('/qris/generate')) return { status: 200, json: { success: true, data: { transaction_id: 'GP-2', qr_url: 'https://qr.example/gp2.png' } } };
    throw new Error('gateway mati');
  };
  await step(cbUpdate(BUYER, 'tu:a:10000'));
  dep = await bot.get("SELECT * FROM deposits WHERE provider_tx = 'GP-2'");
  bot._state.depositLastCheck.clear();
  calls = await step(cbUpdate(BUYER, `tu:x:${dep.id}`));
  assert(/belum bisa dicek/.test(texts(calls) + alerts(calls)), 'pembatalan ditolak saat status tidak bisa dicek');
  assert.strictEqual((await bot.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'pending');
  await bot.write('UPDATE deposits SET expires_at = ? WHERE id = ?', [Date.now() - 60000, dep.id]);
  bot._state.depositLastCheck.clear();
  await bot.pollDeposits();
  assert.strictEqual((await bot.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'pending', 'kedaluwarsa saat gateway mati masih ditunggu');
  await bot.write('UPDATE deposits SET expires_at = ? WHERE id = ?', [Date.now() - 31 * 60000, dep.id]);
  bot._state.depositLastCheck.clear();
  await bot.pollDeposits();
  assert.strictEqual((await bot.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'expired', 'lewat masa tenggang ditutup');
  assert.strictEqual(await saldo(BUYER), 0);

  // ── Saldo manual oleh admin ─────────────────────────────────────────────
  await step(cbUpdate(ADMIN, `a:ua:${BUYER}:+`));
  calls = await step(textUpdate(ADMIN, '15000'));
  assert.strictEqual(await saldo(BUYER), 15000);
  assert(calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === BUYER && /ditambah admin/.test(c.payload.text)), 'pembeli diberi tahu');
  await step(cbUpdate(ADMIN, `a:ua:${BUYER}:-`));
  calls = await step(textUpdate(ADMIN, '999999'));
  assert(/Saldo tidak cukup/.test(texts(calls)), 'saldo tidak boleh minus');
  assert.strictEqual(await saldo(BUYER), 15000);

  // ── Pesanan terputus saat bot restart ───────────────────────────────────
  await bot.write("INSERT INTO orders (user_id, server_id, kind, protocol, username, days, amount, status, created_at, updated_at) VALUES (?, ?, 'create', 'ssh', 'putus01', 1, 1000, 'processing', ?, ?)", [BUYER, local.id, Date.now(), Date.now()]);
  await bot.recoverInterruptedOrders();
  assert.strictEqual((await bot.get("SELECT status FROM orders WHERE username = 'putus01'")).status, 'review');

  // ── Backup dan restore ─────────────────────────────────────────────────
  calls = await step(cbUpdate(ADMIN, 'a:bk'));
  assert(/BACKUP &amp; RESTORE/.test(texts(calls)) && sentDocs.length === 0, 'a:bk membuka menu backup, tidak langsung mengirim');
  await step(cbUpdate(ADMIN, 'a:bks'));
  assert.strictEqual(sentDocs.length, 1, 'backup manual dikirim ke admin');
  assert(!fs.existsSync(sentDocs[0].filePath), 'file backup sementara dihapus');
  const backupFile = path.join(tmp, 'restore-me.db');
  fs.writeFileSync(backupFile, sentDocs[0].copy);

  await bot.tx(() => bot.applyBalance(BUYER, 5000, 'admin', 'test', 'setelah backup'));
  assert.strictEqual(await saldo(BUYER), 20000);
  downloadSource = backupFile;
  calls = await step({ update_id: updateSeq++, message: { message_id: messageSeq++, from: { id: BUYER, first_name: 'B' }, chat: { id: BUYER, type: 'private' }, caption: '/restore', document: { file_id: 'f1', file_size: 1000 } } });
  assert.strictEqual(await saldo(BUYER), 20000, 'pembeli tidak bisa restore');
  calls = await step({ update_id: updateSeq++, message: { message_id: messageSeq++, from: { id: ADMIN, first_name: 'A' }, chat: { id: ADMIN, type: 'private' }, caption: '/restore', document: { file_id: 'f1', file_size: 1000 } } });
  assert(/berhasil dipulihkan/.test(texts(calls)), 'restore berhasil');
  assert.strictEqual(await saldo(BUYER), 15000, 'saldo kembali ke isi backup');
  assert(fs.readdirSync(path.dirname(dbPath)).some((f) => f.includes('.sebelum-restore-')), 'database lama disimpan');

  const junk = path.join(tmp, 'junk.db');
  fs.writeFileSync(junk, 'bukan database');
  downloadSource = junk;
  calls = await step({ update_id: updateSeq++, message: { message_id: messageSeq++, from: { id: ADMIN, first_name: 'A' }, chat: { id: ADMIN, type: 'private' }, caption: '/restore', document: { file_id: 'f2', file_size: 20 } } });
  assert(/bukan database SQLite/.test(texts(calls)), 'file bukan sqlite ditolak');
  assert.strictEqual(await saldo(BUYER), 15000, 'database tetap utuh setelah restore ditolak');

  // Restore lewat menu: kirim file tanpa caption, lihat ringkasan, baru konfirmasi.
  const docUpdate = (userId, fileId) => ({ update_id: updateSeq++, message: { message_id: messageSeq++, from: { id: userId, first_name: 'A' }, chat: { id: userId, type: 'private' }, document: { file_id: fileId, file_size: 1000 } } });
  await bot.tx(() => bot.applyBalance(BUYER, 7000, 'admin', 'test', 'sebelum restore menu'));
  calls = await step(cbUpdate(ADMIN, 'a:rt'));
  assert(/RESTORE DATABASE/.test(texts(calls)));
  calls = await step(textUpdate(ADMIN, 'halo'));
  assert(/sebagai file, bukan teks/.test(texts(calls)), 'teks saat menunggu file restore ditolak');
  downloadSource = junk;
  calls = await step(docUpdate(ADMIN, 'f3'));
  assert(/bukan database SQLite/.test(texts(calls)), 'file rusak ditolak di menu restore');
  downloadSource = backupFile;
  calls = await step(docUpdate(ADMIN, 'f4'));
  assert(/KONFIRMASI RESTORE/.test(texts(calls)) && /Saldo total: Rp/.test(texts(calls)), 'menu restore menampilkan isi backup dulu');
  assert.strictEqual(await saldo(BUYER), 22000, 'database belum diganti sebelum konfirmasi');
  assert(!fs.readdirSync(path.dirname(dbPath)).some((f) => f.startsWith('restore-')), 'file pratinjau tidak tertinggal di disk');
  calls = await step(cbUpdate(BUYER, 'a:rty'));
  assert(/khusus admin/.test(alerts(calls)) && await saldo(BUYER) === 22000, 'pembeli tidak bisa konfirmasi restore');
  calls = await step(cbUpdate(ADMIN, 'a:rty'));
  assert(/berhasil dipulihkan/.test(texts(calls)), 'restore lewat menu berhasil');
  assert.strictEqual(await saldo(BUYER), 15000, 'saldo kembali ke isi backup lewat menu');
  assert(tgCalls.some((c) => c.method === 'getFile' && c.payload.file_id === 'f4'), 'konfirmasi mengunduh file yang dipratinjau');
  calls = await step(cbUpdate(ADMIN, 'a:rty'));
  assert(/Sesi restore sudah habis/.test(texts(calls)), 'konfirmasi restore hanya berlaku sekali');
  // Pengguna yang tidak ada di file backup harus terdaftar lagi untuk test berikutnya.
  await step(textUpdate(OTHER, '/start'));

  // ── Reseller dan paket limit IP ─────────────────────────────────────────
  const localNow = await bot.get('SELECT * FROM servers WHERE local = 1');
  const vmessData = fixture.cases.find((c) => c.name === 'vmess-create-multipath').data;
  let lastApi = null;
  httpHandler = (req) => {
    lastApi = req;
    if (/\/vps\/renewvmess\//.test(req.url)) return ok({ username: req.url.split('/')[5], exp: '2027-01-31 10:00:00' });
    return ok({ ...vmessData, username: req.body.username });
  };
  async function buy(userId, serverId, username, days, packageId) {
    await step(cbUpdate(userId, `b:p:${serverId}:vmess`));
    let out = await step(textUpdate(userId, username));
    if (packageId) out = await step(cbUpdate(userId, `b:k:${packageId}`));
    const confirm = await step(cbUpdate(userId, `b:d:${days}`));
    const done = await step(cbUpdate(userId, 'b:y'));
    return { out, confirm: texts(confirm), done };
  }

  // Harga reseller per server: diisi admin, reseller ditambahkan admin.
  await step(cbUpdate(ADMIN, `a:se:${localNow.id}:reseller_price_day`));
  await step(textUpdate(ADMIN, '600'));
  assert.strictEqual(Number((await bot.get('SELECT reseller_price_day FROM servers WHERE id = ?', [localNow.id])).reseller_price_day), 600);
  await step(cbUpdate(ADMIN, 'a:rs'));
  await step(cbUpdate(ADMIN, 'a:rsa'));
  calls = await step(textUpdate(ADMIN, String(BUYER)));
  assert.strictEqual(Number((await bot.get('SELECT reseller FROM users WHERE id = ?', [BUYER])).reseller), 1, 'admin bisa menambah reseller');
  assert(calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === BUYER && /sekarang <b>reseller<\/b>/.test(c.payload.text)), 'reseller diberi tahu');
  calls = await step(textUpdate(BUYER, '/start'));
  assert(/Status : <b>Reseller<\/b>/.test(texts(calls)), 'menu utama reseller menyebut status reseller');

  let before = await saldo(BUYER);
  let r = await buy(BUYER, localNow.id, 'resel01', 7);
  assert(/Rp 4\.200 \(Rp 600 x 7 hari, harga reseller\)/.test(r.confirm), `konfirmasi reseller memakai harga reseller:\n${r.confirm}`);
  assert.strictEqual(await saldo(BUYER), before - 4200, 'reseller dipotong harga reseller');
  await step(cbUpdate(ADMIN, `a:ua:${OTHER}:+`));
  await step(textUpdate(ADMIN, '50000'));
  before = await saldo(OTHER);
  await buy(OTHER, localNow.id, 'biasa01', 3);
  assert.strictEqual(await saldo(OTHER), before - 3000, 'pembeli biasa tetap harga normal');

  // Paket limit IP: 1 IP Rp300 (reseller Rp200), 2 IP Rp500 (reseller = harga normal).
  for (const [limit, price, resellerPrice] of [['1', '300', '200'], ['2', '500', '0']]) {
    await step(cbUpdate(ADMIN, `a:pka:${localNow.id}`));
    await step(textUpdate(ADMIN, limit));
    await step(textUpdate(ADMIN, price));
    await step(textUpdate(ADMIN, resellerPrice));
  }
  await step(cbUpdate(ADMIN, `a:pka:${localNow.id}`));
  calls = await step(textUpdate(ADMIN, '2'));
  assert(/sudah ada/.test(texts(calls)), 'paket dengan limit IP yang sama ditolak');
  const pkgs = await bot.all('SELECT * FROM server_packages WHERE server_id = ? ORDER BY limit_ip', [localNow.id]);
  assert.deepStrictEqual(pkgs.map((p) => [p.limit_ip, p.price_day, p.reseller_price_day]), [[1, 300, 200], [2, 500, 0]]);

  calls = await step(cbUpdate(OTHER, 'srv'));
  assert(/1 IP: Rp 300 \/ hari/.test(texts(calls)) && /2 IP: Rp 500 \/ hari/.test(texts(calls)), 'daftar server menampilkan paket');
  calls = await step(cbUpdate(BUYER, 'srv'));
  assert(/HARGA RESELLER/.test(texts(calls)) && /1 IP: Rp 200 \/ hari/.test(texts(calls)), 'reseller melihat harga reseller paket');
  calls = await step(cbUpdate(OTHER, 'b'));
  assert(calls.some((c) => (c.payload.reply_markup || { inline_keyboard: [] }).inline_keyboard.flat().some((b) => /mulai Rp 300\/hari/.test(b.text))), 'tombol server menyebut harga termurah');

  // Server dengan paket: pembeli wajib memilih paket sebelum durasi.
  before = await saldo(OTHER);
  r = await buy(OTHER, localNow.id, 'paket02', 3, pkgs[1].id);
  assert(r.out.some((c) => /Pilih masa aktif/.test(c.payload.text || '') && /Paket 2 IP/.test(c.payload.text || '')), 'setelah paket dipilih, durasi ditampilkan');
  assert(/Limit IP : 2/.test(r.confirm) && /Rp 1\.500 \(Rp 500 x 3 hari\)/.test(r.confirm), `konfirmasi memakai harga paket:\n${r.confirm}`);
  assert.strictEqual(lastApi.body.limitip, 2, 'API menerima limit IP dari paket');
  assert.strictEqual(await saldo(OTHER), before - 1500);
  assert.strictEqual(Number((await bot.get("SELECT limit_ip FROM accounts WHERE username = 'paket02'")).limit_ip), 2, 'limit IP paket tersimpan di akun');

  before = await saldo(BUYER);
  await buy(BUYER, localNow.id, 'paket01', 7, pkgs[0].id);
  assert.strictEqual(await saldo(BUYER), before - 1400, 'reseller memakai harga reseller paket');
  assert.strictEqual(lastApi.body.limitip, 1);

  // Pilih paket tanpa melewati langkah paket, atau paket server lain: ditolak.
  await step(cbUpdate(OTHER, `b:p:${localNow.id}:vmess`));
  calls = await step(textUpdate(OTHER, 'paket03'));
  assert(calls.some((c) => /Pilih paket limit IP/.test(c.payload.text || '')), 'server berpaket menanyakan paket dulu');
  calls = await step(cbUpdate(OTHER, 'b:d:3'));
  assert(/Sesi pembelian sudah habis/.test(texts(calls)), 'durasi tidak bisa dipilih sebelum paket');
  calls = await step(cbUpdate(OTHER, 'b:k:999'));
  assert(/Sesi pembelian sudah habis|Paket tidak tersedia/.test(texts(calls)), 'paket rakitan ditolak');
  assert(!(await bot.get("SELECT id FROM orders WHERE username = 'paket03'")), 'tidak ada pesanan dari paket rakitan');

  // Perpanjang mengikuti limit IP akun (paket 2 IP), bukan limit IP server.
  const acc2 = await bot.get("SELECT * FROM accounts WHERE username = 'paket02'");
  before = await saldo(OTHER);
  calls = await step(cbUpdate(OTHER, `r:a:${acc2.id}`));
  assert(/Limit IP : 2/.test(texts(calls)) && /3 hari - Rp 1\.500/.test(JSON.stringify(calls)), 'perpanjang memakai harga paket akun');
  await step(cbUpdate(OTHER, `r:d:${acc2.id}:3`));
  await step(cbUpdate(OTHER, `r:y:${acc2.id}:3`));
  assert.strictEqual(await saldo(OTHER), before - 1500);
  assert.strictEqual(lastApi.body.limitip, 2, 'perpanjang tidak mengubah limit IP akun');

  // Paket dihapus: perpanjang memakai harga dasar server dengan limit akun.
  await step(cbUpdate(ADMIN, `a:pkd:${pkgs[1].id}`));
  await step(cbUpdate(ADMIN, `a:pky:${pkgs[1].id}`));
  assert(!(await bot.get('SELECT id FROM server_packages WHERE id = ?', [pkgs[1].id])), 'paket terhapus');
  before = await saldo(OTHER);
  await step(cbUpdate(OTHER, `r:d:${acc2.id}:1`));
  await step(cbUpdate(OTHER, `r:y:${acc2.id}:1`));
  assert.strictEqual(await saldo(OTHER), before - 1000, 'tanpa paket yang cocok, perpanjang memakai harga dasar server');
  assert.strictEqual(lastApi.body.limitip, 2);

  // ── Menu pengguna: cari (baca saja), edit saldo, edit info terpisah ──────
  calls = await step(cbUpdate(ADMIN, 'a:u'));
  const userMenu = calls.find((c) => /KELOLA PENGGUNA/.test(c.payload.text || ''));
  const userButtons = userMenu.payload.reply_markup.inline_keyboard.flat().map((b) => b.text);
  for (const label of ['Cari Pengguna', 'Edit Saldo', 'Edit Info Pengguna', 'Kelola Reseller']) assert(userButtons.includes(label), `menu pengguna punya ${label}`);
  await step(cbUpdate(ADMIN, 'a:uf'));
  calls = await step(textUpdate(ADMIN, `User${OTHER}`));
  const detail = calls.find((c) => /DETAIL PENGGUNA/.test(c.payload.text || ''));
  assert(detail, 'pencarian nama menemukan pengguna');
  assert(!detail.payload.reply_markup.inline_keyboard.flat().some((b) => /Saldo|Blokir|Reseller/.test(b.text)), 'hasil pencarian hanya menampilkan data');
  await step(cbUpdate(ADMIN, 'a:es'));
  calls = await step(textUpdate(ADMIN, String(OTHER)));
  assert(/EDIT SALDO/.test(texts(calls)) && calls.some((c) => (c.payload.reply_markup || { inline_keyboard: [] }).inline_keyboard.flat().some((b) => b.text === 'Tambah Saldo')), 'Edit Saldo menampilkan tombol tambah/kurangi');
  await step(cbUpdate(ADMIN, 'a:ei'));
  calls = await step(textUpdate(ADMIN, String(BUYER)));
  assert(/EDIT INFO PENGGUNA/.test(texts(calls)) && /Reseller  : YA/.test(texts(calls)));
  await step(cbUpdate(ADMIN, `a:ur:${BUYER}`));
  assert.strictEqual(Number((await bot.get('SELECT reseller FROM users WHERE id = ?', [BUYER])).reseller), 0, 'reseller bisa dicabut dari Edit Info');
  calls = await step(cbUpdate(BUYER, `a:ur:${BUYER}`));
  assert(/khusus admin/.test(alerts(calls)), 'pembeli tidak bisa menjadikan dirinya reseller');

  // ── Reseller otomatis lewat top up dan syarat penjualan ─────────────────
  const AUTO = 7007;
  await step(textUpdate(AUTO, '/start'));
  const depositFor = async (userId, amount, ref) => {
    await bot.write("INSERT INTO deposits (ref, user_id, amount, gateway, provider_tx, chat_id, status, created_at, expires_at) VALUES (?, ?, ?, 'gopay', ?, ?, 'pending', ?, ?)", [ref, userId, amount, `P-${ref}`, userId, Date.now(), Date.now() + 600000]);
    return bot.get('SELECT * FROM deposits WHERE ref = ?', [ref]);
  };
  const isRes = async (id) => Number((await bot.get('SELECT reseller FROM users WHERE id = ?', [id])).reseller) === 1;
  mark = tgCalls.length;
  await bot.settleDeposit(await depositFor(AUTO, 29999, 'AUTO1'));
  assert(!(await isRes(AUTO)), 'top up di bawah minimal tidak jadi reseller');
  await bot.settleDeposit(await depositFor(AUTO, 30000, 'AUTO2'));
  assert(await isRes(AUTO), 'top up 30k sekaligus otomatis jadi reseller');
  assert(since(mark).some((c) => c.payload.chat_id === AUTO && /sekarang reseller/.test(c.payload.text || '')), 'pembeli diberi tahu jadi reseller');
  assert(since(mark).some((c) => c.payload.chat_id === '1001' && /otomatis menjadi <b>reseller<\/b>/.test(c.payload.text || '')), 'admin diberi tahu reseller otomatis');
  calls = await step(textUpdate(AUTO, '/start'));
  assert(/Target : 0\/3 akun sampai/.test(texts(calls)), `reseller melihat target penjualan:\n${texts(calls)}`);

  // Pengaturan reseller di Kelola Reseller.
  calls = await step(cbUpdate(ADMIN, 'a:rs'));
  assert(/top up minimal Rp 30\.000 sekaligus/.test(texts(calls)) && /3 akun per 30 hari/.test(texts(calls)));
  await step(cbUpdate(ADMIN, 'a:rc:reseller_auto_topup'));
  calls = await step(textUpdate(ADMIN, '500'));
  assert(/Minimal top up reseller Rp1\.000/.test(texts(calls)), 'minimal top up terlalu kecil ditolak');
  calls = await step(textUpdate(ADMIN, '50000'));
  assert.strictEqual(bot.setting('reseller_auto_topup'), '50000');
  assert(/top up minimal Rp 50\.000 sekaligus/.test(texts(calls)));
  await step(cbUpdate(ADMIN, 'a:rc:reseller_min_sales'));
  await step(textUpdate(ADMIN, '2'));
  assert.strictEqual(bot.setting('reseller_min_sales'), '2');
  calls = await step(cbUpdate(BUYER, 'a:rc:reseller_min_sales'));
  assert(/khusus admin/.test(alerts(calls)), 'pembeli tidak bisa mengubah syarat reseller');

  // Periode 30 hari: peringatan dulu, lalu diturunkan setelah peringatan berumur penuh.
  const DAY = 86400000;
  const resUser = async (id) => bot.get('SELECT * FROM users WHERE id = ?', [id]);
  await bot.write('UPDATE users SET reseller_period_start = ?, reseller_warned = 0 WHERE id = ?', [Date.now() - 20 * DAY, AUTO]);
  mark = tgCalls.length;
  await bot.checkResellers();
  assert(!since(mark).some((c) => c.payload.chat_id === AUTO), 'belum masuk masa peringatan: diam');
  await bot.write('UPDATE users SET reseller_period_start = ? WHERE id = ?', [Date.now() - 25 * DAY, AUTO]);
  await bot.checkResellers();
  const warning = since(mark).find((c) => c.payload.chat_id === AUTO && /PERINGATAN RESELLER/.test(c.payload.text || ''));
  assert(warning && /<b>0<\/b> dari minimal <b>2<\/b>/.test(warning.payload.text), 'reseller kurang jual diperingatkan');
  mark = tgCalls.length;
  await bot.checkResellers();
  assert(!since(mark).some((c) => c.payload.chat_id === AUTO), 'peringatan hanya dikirim sekali per periode');
  // Periode habis dan peringatan sudah berumur 7 hari: diturunkan.
  await bot.write('UPDATE users SET reseller_period_start = ?, reseller_warned = ? WHERE id = ?', [Date.now() - 31 * DAY, Date.now() - 8 * DAY, AUTO]);
  mark = tgCalls.length;
  await bot.checkResellers();
  assert(!(await isRes(AUTO)), 'reseller yang tidak memenuhi target diturunkan');
  assert(since(mark).some((c) => c.payload.chat_id === AUTO && /STATUS RESELLER DICABUT/.test(c.payload.text) && /Rp 50\.000/.test(c.payload.text)), 'pengguna diberi tahu cara jadi reseller lagi');
  assert(since(mark).some((c) => c.payload.chat_id === '1001' && /RESELLER DITURUNKAN/.test(c.payload.text)), 'admin diberi tahu');

  // Syarat baru dinyalakan untuk reseller lama: tidak pernah turun tanpa peringatan.
  await bot.write('UPDATE users SET reseller = 1, reseller_period_start = ?, reseller_warned = 0 WHERE id = ?', [Date.now() - 45 * DAY, AUTO]);
  mark = tgCalls.length;
  await bot.checkResellers();
  assert(await isRes(AUTO), 'periode lewat tanpa peringatan: belum diturunkan');
  const late = since(mark).find((c) => c.payload.chat_id === AUTO && /PERINGATAN RESELLER/.test(c.payload.text || ''));
  assert(late, 'peringatan dikirim dulu');
  const lateUser = await resUser(AUTO);
  assert(Number(lateUser.reseller_warned) > Date.now() - 60000, 'waktu peringatan dicatat');
  await bot.checkResellers();
  assert(await isRes(AUTO), 'masih diberi waktu sesuai hari peringatan');

  // Target terpenuhi: periode baru, peringatan direset.
  await bot.write("INSERT INTO orders (user_id, server_id, kind, protocol, username, days, amount, status, created_at, updated_at) VALUES (?, 1, 'create', 'vmess', 'jual01', 1, 100, 'done', ?, ?), (?, 1, 'renew', 'vmess', 'jual01', 1, 100, 'done', ?, ?)", [AUTO, Date.now(), Date.now(), AUTO, Date.now(), Date.now()]);
  mark = tgCalls.length;
  await bot.checkResellers();
  assert(await isRes(AUTO), 'target terpenuhi tetap reseller');
  const rolled = await resUser(AUTO);
  assert(Math.abs(Number(rolled.reseller_period_start) - (Date.now() - 15 * DAY)) < 60000 && since(mark).some((c) => c.payload.chat_id === AUTO && /TARGET RESELLER TERPENUHI/.test(c.payload.text)), 'periode baru dimulai setelah target terpenuhi');
  // Admin bot tidak pernah diturunkan; syarat 0 = tanpa syarat.
  await bot.write('UPDATE users SET reseller = 1, reseller_period_start = ?, reseller_warned = ? WHERE id = ?', [Date.now() - 40 * DAY, Date.now() - 20 * DAY, ADMIN]);
  await bot.checkResellers();
  assert(await isRes(ADMIN), 'admin tidak diturunkan');
  await bot.write('UPDATE users SET reseller = 0 WHERE id = ?', [ADMIN]);
  await bot.setSetting('reseller_min_sales', '0');
  await bot.write('UPDATE users SET reseller_period_start = ?, reseller_warned = ? WHERE id = ?', [Date.now() - 40 * DAY, Date.now() - 20 * DAY, AUTO]);
  await bot.checkResellers();
  assert(await isRes(AUTO), 'syarat penjualan 0 = tidak ada penurunan');
  await bot.setSetting('reseller_min_sales', '3');
  await bot.setSetting('reseller_auto_topup', '30000');
  await bot.write('UPDATE users SET reseller = 0 WHERE id = ?', [AUTO]);

  // ── Broadcast ──────────────────────────────────────────────────────────
  const waitBroadcast = async () => {
    for (let i = 0; i < 200 && bot._state.broadcast(); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert(!bot._state.broadcast(), 'broadcast selesai');
  };
  const BANNED = 4004;
  const RESELLER = 5005;
  const BLOCKER = 6006;
  for (const id of [BANNED, RESELLER, BLOCKER]) await step(textUpdate(id, '/start'));
  await bot.write('UPDATE users SET banned = 1 WHERE id = ?', [BANNED]);
  await bot.write('UPDATE users SET reseller = CASE WHEN id = ? THEN 1 ELSE 0 END', [RESELLER]);
  blockedChats.add(BLOCKER);

  calls = await step(cbUpdate(BUYER, 'a:bc'));
  assert(/khusus admin/.test(alerts(calls)), 'pembeli tidak bisa membuka broadcast');
  calls = await step(textUpdate(BUYER, 'promo palsu'));
  assert(!calls.some((c) => /PRATINJAU BROADCAST/.test(c.payload.text || '')), 'pesan pembeli tidak pernah jadi draf broadcast');
  calls = await step(cbUpdate(ADMIN, 'a:bcy'));
  assert(/Sesi broadcast sudah habis/.test(texts(calls)), 'broadcast tidak bisa dimulai tanpa draf');

  await step(cbUpdate(ADMIN, 'a:bc'));
  const photoMsg = { update_id: updateSeq++, message: { message_id: 4242, from: { id: ADMIN, first_name: 'A' }, chat: { id: ADMIN, type: 'private' }, photo: [{ file_id: 'ph1', width: 90, height: 90 }], caption: 'PROMO <b>akhir bulan</b>' } };
  calls = await step(photoMsg);
  const previewText = texts(calls);
  assert(/PRATINJAU BROADCAST/.test(previewText) && /Pesan gambar/.test(previewText), 'gambar diterima sebagai draf broadcast');
  const previewButtons = calls.find((c) => /PRATINJAU/.test(c.payload.text || '')).payload.reply_markup.inline_keyboard.flat().map((b) => b.text);
  const userCount = Number((await bot.get('SELECT COUNT(*) AS n FROM users WHERE banned = 0 AND id <> ?', [ADMIN])).n);
  assert(previewButtons.includes(`Semua Pengguna (${userCount})`) && previewButtons.includes('Reseller (1)'), `jumlah penerima benar: ${previewButtons}`);
  calls = await step(cbUpdate(ADMIN, 'a:bcs:all'));
  assert(/KONFIRMASI BROADCAST/.test(texts(calls)) && new RegExp(`ke ${userCount} semua pengguna`).test(texts(calls)));
  mark = tgCalls.length;
  await step(cbUpdate(ADMIN, 'a:bcy'));
  await waitBroadcast();
  let copies = since(mark).filter((c) => c.method === 'copyMessage');
  const targets = copies.map((c) => Number(c.payload.chat_id)).sort((x, y) => x - y);
  assert(copies.every((c) => c.payload.from_chat_id === ADMIN && c.payload.message_id === 4242), 'pesan admin disalin apa adanya (copyMessage)');
  assert(!targets.includes(BANNED) && !targets.includes(ADMIN), 'pengguna diblokir admin dan pengirim tidak dikirimi');
  assert(targets.includes(BUYER) && targets.includes(RESELLER) && targets.includes(BLOCKER) && targets.length === userCount, `semua pengguna dikirimi: ${targets}`);
  const finalStatus = since(mark).filter((c) => c.method === 'editMessageText').pop();
  assert(/BROADCAST SELESAI/.test(finalStatus.payload.text) && /Terkirim : \d+/.test(finalStatus.payload.text) && /Diblokir : 1 /.test(finalStatus.payload.text), finalStatus.payload.text);
  calls = await step(cbUpdate(ADMIN, 'a:bcy'));
  assert(/Sesi broadcast sudah habis/.test(texts(calls)), 'konfirmasi broadcast hanya berlaku sekali');

  // Teks ke reseller saja: teks ditanya lampiran dulu, lalu "Kirim Teks Saja".
  await step(cbUpdate(ADMIN, 'a:bc'));
  calls = await step(textUpdate(ADMIN, 'Harga reseller turun mulai besok'));
  assert(/LAMPIRAN BROADCAST/.test(texts(calls)) && !/PRATINJAU BROADCAST/.test(texts(calls)), 'teks broadcast ditanya lampiran media dulu');
  calls = await step(cbUpdate(ADMIN, 'a:bct'));
  assert(/PRATINJAU BROADCAST/.test(texts(calls)) && /Pesan teks di atas/.test(texts(calls)), 'Kirim Teks Saja lanjut ke pratinjau');
  await step(cbUpdate(ADMIN, 'a:bcs:reseller'));
  mark = tgCalls.length;
  await step(cbUpdate(ADMIN, 'a:bcy'));
  await waitBroadcast();
  copies = since(mark).filter((c) => c.method === 'copyMessage');
  assert.deepStrictEqual(copies.map((c) => Number(c.payload.chat_id)), [RESELLER], 'broadcast reseller hanya ke reseller');

  // Teks + video: teks jadi caption video, formatnya ikut.
  await step(cbUpdate(ADMIN, 'a:bc'));
  const promoText = { update_id: updateSeq++, message: { message_id: 5100, from: { id: ADMIN, first_name: 'A' }, chat: { id: ADMIN, type: 'private' }, text: 'hallo test pesan', entities: [{ type: 'bold', offset: 0, length: 5 }] } };
  await step(promoText);
  calls = await step(cbUpdate(ADMIN, 'a:bcm'));
  assert(/Kirim 1 gambar, video, GIF, atau stiker/.test(texts(calls)), 'Tambah Media meminta media');
  calls = await step(textUpdate(ADMIN, 'ini bukan media'));
  assert(/Kirim 1 gambar, video, GIF, atau stiker/.test(texts(calls)) && !/PRATINJAU/.test(texts(calls)), 'teks biasa ditolak saat menunggu media');
  mark = tgCalls.length;
  const videoMsg = { update_id: updateSeq++, message: { message_id: 5101, from: { id: ADMIN, first_name: 'A' }, chat: { id: ADMIN, type: 'private' }, video: { file_id: 'vid1' }, caption: 'caption lama' } };
  calls = await step(videoMsg);
  const videoPreview = since(mark).filter((c) => c.method === 'copyMessage');
  assert.deepStrictEqual(videoPreview.map((c) => [Number(c.payload.chat_id), c.payload.message_id, c.payload.caption]), [[ADMIN, 5101, 'hallo test pesan']], 'pratinjau gabungan dikirim ke admin');
  assert.deepStrictEqual(videoPreview[0].payload.caption_entities, [{ type: 'bold', offset: 0, length: 5 }], 'format teks ikut jadi format caption');
  assert(/Pesan video \+ teks di atas/.test(texts(calls)), 'pratinjau menyebut video + teks');
  await step(cbUpdate(ADMIN, 'a:bcs:reseller'));
  mark = tgCalls.length;
  await step(cbUpdate(ADMIN, 'a:bcy'));
  await waitBroadcast();
  copies = since(mark).filter((c) => c.method === 'copyMessage');
  assert.deepStrictEqual(copies.map((c) => [Number(c.payload.chat_id), c.payload.message_id, c.payload.caption]), [[RESELLER, 5101, 'hallo test pesan']], 'video + teks terkirim sebagai satu pesan');

  // Teks + stiker: stiker dulu, lalu teks. Kena 429 di teks -> stiker tidak dikirim ulang.
  await step(cbUpdate(ADMIN, 'a:bc'));
  await step({ update_id: updateSeq++, message: { message_id: 5200, from: { id: ADMIN, first_name: 'A' }, chat: { id: ADMIN, type: 'private' }, text: 'promo stiker' } });
  await step(cbUpdate(ADMIN, 'a:bcm'));
  await step({ update_id: updateSeq++, message: { message_id: 5201, from: { id: ADMIN, first_name: 'A' }, chat: { id: ADMIN, type: 'private' }, sticker: { file_id: 'stk1' } } });
  await step(cbUpdate(ADMIN, 'a:bcs:reseller'));
  let limited = false;
  copyRateLimit = (payload) => {
    if (limited || Number(payload.chat_id) !== RESELLER || payload.message_id !== 5200) return false;
    limited = true;
    return true;
  };
  mark = tgCalls.length;
  await step(cbUpdate(ADMIN, 'a:bcy'));
  await waitBroadcast();
  copyRateLimit = null;
  copies = since(mark).filter((c) => c.method === 'copyMessage');
  assert(limited, '429 tersimulasi');
  assert.deepStrictEqual(copies.map((c) => c.payload.message_id), [5201, 5200, 5200], 'stiker sekali, teks diulang setelah 429');
  assert(copies.every((c) => c.payload.caption === undefined), 'stiker tidak diberi caption');
  assert(/Terkirim : 1/.test(since(mark).filter((c) => c.method === 'editMessageText').pop().payload.text), 'stiker + teks dihitung satu kiriman');

  // /batal saat menunggu pesan broadcast tidak menyebarkan apa pun.
  await step(cbUpdate(ADMIN, 'a:bc'));
  mark = tgCalls.length;
  await step(textUpdate(ADMIN, '/batal'));
  await step(cbUpdate(ADMIN, 'a:bcs:all'));
  assert(!since(mark).some((c) => c.method === 'copyMessage') && /Sesi broadcast sudah habis/.test(texts(since(mark))), '/batal membuang draf broadcast');
  blockedChats.clear();

  // Database lama (sebelum fitur reseller/paket) dimigrasi saat dibuka.
  await bot.closeStore();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec('ALTER TABLE users DROP COLUMN reseller; ALTER TABLE accounts DROP COLUMN limit_ip; DROP TABLE server_packages;');
  legacy.close();
  await bot.openStore();
  assert((await bot.all('PRAGMA table_info(users)')).some((c) => c.name === 'reseller'), 'kolom reseller ditambahkan ke database lama');
  assert((await bot.all('PRAGMA table_info(accounts)')).some((c) => c.name === 'limit_ip'), 'kolom limit_ip ditambahkan ke database lama');
  assert.deepStrictEqual(await bot.all('SELECT * FROM server_packages'), [], 'tabel paket dibuat ulang');

  // Semua kabar toko lewat bot jualan ke chat pribadi admin, tidak pernah ke chat notif.
  assert.strictEqual(bot.CONFIG.token, '654321:JUALANTOKEN');
  assert(!tgCalls.some((c) => String(c.payload && c.payload.chat_id) === '-1009999'), 'bot jualan tidak boleh mengirim ke chat bot notif');
  assert(tgCalls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === '1001' && /TOP UP MASUK/.test(c.payload.text)), 'kabar top up dikirim ke admin');

  await bot.closeStore();

  // ── Integrasi installer ─────────────────────────────────────────────────
  if (!sourceOverride) {
    const unitStart = installer.indexOf('cat > /etc/systemd/system/sc-1forcr-botpanel.service <<EOF');
    assert(unitStart >= 0, 'unit sc-1forcr-botpanel.service tidak ditemukan');
    const unit = installer.slice(unitStart, installer.indexOf('\nEOF\n', unitStart));
    for (const needle of ['MemoryMax=${BOT_PANEL_MEMORY_MAX}', 'Nice=', 'CPUQuota=', 'DynamicUser=yes', 'StateDirectory=sc-1forcr-botpanel',
      'Restart=on-failure', 'EnvironmentFile=${APP_DIR}/.env', '--max-old-space-size=', 'BOT_PANEL_DB=/var/lib/sc-1forcr-botpanel/bot-panel.db']) {
      assert(unit.includes(needle), `unit bot panel wajib memuat ${needle}`);
    }
    assert(/^BOT_PANEL_ENABLE="\$\{BOT_PANEL_ENABLE:-0\}"$/m.test(installer), 'Bot Panel mati secara default');
    const appEnv = installer.slice(installer.indexOf('cat > "${APP_DIR}/.env" <<EOF'), installer.indexOf('chmod 600 "${APP_DIR}/.env"'));
    for (const key of ['BOT_PANEL_ENABLE', 'BOT_PANEL_TOKEN', 'BOT_PANEL_ADMIN_IDS']) {
      const line = `\n${key}=\${${key}}\n`;
      assert(appEnv.includes(line), `${key} wajib ada di .env aplikasi`);
      assert(installer.split(line).length - 1 >= 2, `${key} wajib ada di .env aplikasi dan dump /etc/sc-1forcr.env`);
    }
    const persist = installer.slice(installer.indexOf('persist_pending_install_env() {'), installer.indexOf('persist_pending_install_env() {') + 6000);
    assert(/BOT_PANEL_ENABLE BOT_PANEL_TOKEN BOT_PANEL_ADMIN_IDS/.test(persist), 'variabel Bot Panel wajib ikut persist_pending_install_env');
    assert((installer.match(/^\s+install_bot_panel \|\| true$/gm) || []).length >= 2, 'install_bot_panel dipanggil di jalur install penuh dan update aman');
    assert(/set_bot_panel_menu \|\| true/.test(installer), 'menu Tools punya Mode Bot Panel');
    assert(/"\$\{BOT_PANEL_ENABLE\}" == "1" && -n "\$\{BOT_PANEL_TOKEN:-\}"/.test(installer), 'service hanya jalan kalau token bot jualan ada');
    const notifMenu = installer.slice(installer.indexOf('set_telegram_notif_config() {'), installer.indexOf('\n}\n', installer.indexOf('set_telegram_notif_config() {')));
    assert(!/botpanel|BOT_PANEL/.test(notifMenu), 'setting bot notif tidak boleh menyentuh Bot Panel (bot terpisah)');
    const tokenMenu = installer.slice(installer.indexOf('set_bot_panel_token() {'), installer.indexOf('\n}\n', installer.indexOf('set_bot_panel_token() {')));
    assert(tokenMenu.length > 50 && /== "\$\{TELEGRAM_BOT_TOKEN:-\}"/.test(tokenMenu), 'token bot jualan wajib ditolak kalau sama dengan token bot notif');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('bot panel tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

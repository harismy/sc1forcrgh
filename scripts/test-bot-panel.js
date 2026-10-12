'use strict';

// Regresi Mode Bot Panel (bot Telegram jualan akun di VPS, bot-panel.js hasil
// generate installer):
// - Detail akun sama persis dengan menu CLI dan BotVPN (fixture parity).
// - Uang pembeli: top up hanya dikredit sekali, pembelian gagal dikembalikan,
//   hasil tidak pasti diserahkan ke admin, klik ganda tidak memotong dua kali.
// - Server ini tersembunyi sampai admin mengisi harga; callback rakitan
//   (durasi aneh, menu admin, akun orang lain) ditolak.
// - Restore database lewat file dari admin.
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

// ── Muat modul dengan env tiruan ────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-panel-test-'));
const dbPath = path.join(tmp, 'state', 'bot-panel.db');
Object.assign(process.env, {
  BOT_PANEL_ENABLE: '1',
  TELEGRAM_BOT_TOKEN: '123456:TESTTOKEN',
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
bot.deps.tgRequest = async (method, payload) => {
  tgCalls.push({ method, payload });
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
    [['success', 'success'], ['success', 'success'], ['success', 'success'], ['primary']], 'warna menu utama per baris');
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
  await step(cbUpdate(ADMIN, 'a:bk'));
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
    for (const key of ['BOT_PANEL_ENABLE', 'BOT_PANEL_ADMIN_IDS']) {
      const line = `\n${key}=\${${key}}\n`;
      assert(appEnv.includes(line), `${key} wajib ada di .env aplikasi`);
      assert(installer.split(line).length - 1 >= 2, `${key} wajib ada di .env aplikasi dan dump /etc/sc-1forcr.env`);
    }
    const persist = installer.slice(installer.indexOf('persist_pending_install_env() {'), installer.indexOf('persist_pending_install_env() {') + 6000);
    assert(/BOT_PANEL_ENABLE BOT_PANEL_ADMIN_IDS/.test(persist), 'variabel Bot Panel wajib ikut persist_pending_install_env');
    assert((installer.match(/^\s+install_bot_panel \|\| true$/gm) || []).length >= 2, 'install_bot_panel dipanggil di jalur install penuh dan update aman');
    assert(/set_bot_panel_menu \|\| true/.test(installer), 'menu Tools punya Mode Bot Panel');
    assert(/systemctl restart sc-1forcr-botpanel/.test(installer.slice(installer.indexOf('set_telegram_notif_config() {'), installer.indexOf('set_account_event_webhook_config() {'))),
      'ganti token bot harus me-restart Bot Panel yang aktif');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('bot panel tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

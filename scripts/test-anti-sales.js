'use strict';

// Anti jualan di grup (lib/anti-sales.js + pemasangan di app3.js).
// - Deteksi: pesan jualan/promosi tertangkap, obrolan biasa dan pertanyaan
//   pembeli tidak (salah mute lebih merugikan daripada satu promo lolos).
// - Penindakan: hapus pesan, mute sesuai durasi, satu peringatan per masa
//   mute, admin grup/admin bot/admin anonim tidak pernah ditindak, daftar admin
//   yang tidak terbaca berarti tidak menindak.
// - /antijualan on|off hanya untuk admin grup; tombol Buka Mute hanya admin.
// - app3.js: middleware grup terdaftar sebelum handler lain dan tidak
//   meneruskan update grup ke menu jualan.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const antiSales = require(path.join(repoRoot, 'lib', 'anti-sales.js'));
const { analyzeSalesText, collectMessageText, parseGroupCommand, createAntiSalesGuard } = antiSales;

// --- Deteksi ---------------------------------------------------------------
const SALES = [
  'JUAL VPS MURAH 10K/BULAN, MINAT PM',
  'Open reseller SC, harga mulai 25rb. Hubungi wa.me/6281234567890',
  'Ready stock akun netflix premium, garansi full. order: @tokoku_id',
  'Dijual akun ML sultan, cek bio',
  'Gabung channel kami t.me/infovpngratis',
  't.me/+AbCdEf123xyz',
  'gabung yuk chat.whatsapp.com/AbCdEf123',
  'Sewa VPS 30 hari 15k',
  'jasa install sc, fast respon, wa 081234567890',
  '\u{1d5dd}\u{1d5e8}\u{1d5d4}\u{1d5df} \u{1d5d4}\u{1d5de}\u{1d5e8}\u{1d5e1} \u{1d5e3}\u{1d5e5}\u{1d5d8}\u{1d5e0}\u{1d5dc}\u{1d5e8}\u{1d5e0} \u{1d5e0}\u{1d5e8}\u{1d5e5}\u{1d5d4}\u{1d5db}',
  'PROMO 50% hari ini, order sekarang!',
  'Netflix premium murah bergaransi, minat?',
  'j u a l akun premium murah',
  'j.u.a.l akun premium, pm',
  'Situs slot online maxwin hari ini, daftar sekarang bit.ly/abc123',
  'jual akun, bayar via dana, wa 08123456789',
  'Yang cari vps murah pm aja',
  'Jual akun, yang mau beli pm',
  'Juaaal sc premium murahhh',
  'Harga 10k aja, wa 0812-3456-7890',
  'Jualannya ready stock kak',
  'pri​ce​list vps cek bio'
];
const NORMAL = [
  'ada yang jual vps murah ga?',
  'harga sc nya berapa min?',
  'vps saya 5$/bulan di DO',
  'pm aku kalau error ya',
  'makasih min, sudah jalan',
  'cara open port 443 gimana?',
  'udah ready belum servernya?',
  'IP 103.123.45.6 port 443',
  'sc ini murah banget cuma 25rb sehari',
  'aku mau beli sc 30 hari, transfer kemana?',
  'join grup ini dulu ya buat update',
  'cek t.me/s1forcr',
  'Saya sudah transfer Rp 25.000, wa saya 08123456789',
  'ada promo ga min? harga 25rb masih?',
  'tolong @adminsc1forcr sc saya error',
  'Gue jualan juga sih dulu',
  'garansi berapa hari? harga 25rb',
  'servernya gacor min, mantap',
  'stok vps di DO lagi kosong, slot premium habis',
  'yang jual vps pm aku ya',
  'mau order dimana min?',
  'sewa vps dimana yang bagus?',
  'limit 2 login per hari ya min?',
  'udp custom 1-6000@user:pass ga konek min',
  'order sc gimana caranya?'
];
for (const text of SALES) {
  const r = analyzeSalesText(text);
  assert(r.flagged, `harus terdeteksi jualan: ${JSON.stringify(text)} (skor ${r.score}: ${r.reasons.join(',')})`);
}
for (const text of NORMAL) {
  const r = analyzeSalesText(text);
  assert(!r.flagged, `tidak boleh terdeteksi jualan: ${JSON.stringify(text)} (skor ${r.score}: ${r.reasons.join(',')})`);
}
assert.strictEqual(analyzeSalesText('').flagged, false);

// Link tersembunyi di balik teks, caption, dan tombol ikut diperiksa.
const hidden = collectMessageText({
  text: 'cek ini kak',
  entities: [{ type: 'text_link', offset: 0, length: 3, url: 'https://t.me/+RahasiaGrup1' }]
});
assert(analyzeSalesText(hidden).flagged, 'link undangan di balik teks harus terbaca');
assert(analyzeSalesText(collectMessageText({ caption: 'Dijual akun, cek bio' })).flagged, 'caption foto harus diperiksa');
assert(analyzeSalesText(collectMessageText({
  text: 'info terbaru',
  reply_markup: { inline_keyboard: [[{ text: 'Order', url: 'https://wa.me/6281234567890' }], [{ text: 'Promo murah', url: 'https://x.y' }]] }
})).flagged, 'tombol berlink harus diperiksa');

// Perintah untuk bot lain bukan perintah kita.
assert.deepStrictEqual(parseGroupCommand('/antijualan off', 'TestBot'), { name: 'antijualan', args: 'off' });
assert.deepStrictEqual(parseGroupCommand('/antijualan@testbot on', 'TestBot'), { name: 'antijualan', args: 'on' });
assert.strictEqual(parseGroupCommand('/antijualan@BotLain on', 'TestBot'), null);
assert.strictEqual(parseGroupCommand('halo', 'TestBot'), null);

// --- Penindakan dengan Telegram tiruan ---------------------------------------
const GROUP = { id: -1001, type: 'supergroup', title: 'Grup Uji' };
const ADMIN = { id: 10, first_name: 'Admin' };
const OWNER = { id: 20, first_name: 'Owner' };
const MEMBER = { id: 30, first_name: 'Budi <b>' };
const SALE_TEXT = 'JUAL VPS MURAH 10K/BULAN, MINAT PM';

function makeEnv(opts = {}) {
  const calls = [];
  const store = new Map();
  let clock = 1_700_000_000_000;
  const fail = opts.fail || {};
  const telegram = {
    getChatAdministrators: async (chatId) => {
      calls.push(['getChatAdministrators', chatId]);
      if (fail.admins) throw new Error('timeout');
      return [{ user: { id: ADMIN.id }, status: 'creator' }];
    },
    deleteMessage: async (chatId, messageId) => {
      calls.push(['deleteMessage', chatId, messageId]);
      if (fail.delete) throw new Error('message can\'t be deleted');
      return true;
    },
    restrictChatMember: async (chatId, userId, extra) => {
      calls.push(['restrictChatMember', chatId, userId, extra]);
      if (fail.restrict) throw Object.assign(new Error('400'), { description: 'Bad Request: not enough rights' });
      return true;
    },
    sendMessage: async (chatId, text, extra) => {
      calls.push(['sendMessage', chatId, text, extra]);
      return { message_id: 900 };
    },
    getChat: async (chatId) => ({ id: chatId, permissions: { can_send_messages: true, can_send_photos: false } }),
    getChatMember: async () => ({ status: 'administrator', can_delete_messages: true, can_restrict_members: !fail.restrict }),
    getMe: async () => ({ id: 777, username: 'TestBot' }),
    editMessageText: async (...args) => {
      calls.push(['editMessageText', ...args]);
      return true;
    }
  };
  const logs = [];
  const guard = createAntiSalesGuard({
    isOwner: (id) => Number(id) === OWNER.id,
    loadEnabled: async (chatId) => (store.has(chatId) ? store.get(chatId) : null),
    saveEnabled: async (chatId, enabled) => { store.set(chatId, enabled); },
    log: (line) => logs.push(line),
    now: () => clock,
    muteMinutes: 60
  });
  let messageId = 1;
  const ctxFor = (update) => {
    const source = update.message || update.edited_message || update.callback_query?.message || update.my_chat_member;
    return {
      update,
      chat: source?.chat,
      telegram,
      botInfo: { id: 777, username: 'TestBot' },
      answerCbQuery: async (text, extra) => { calls.push(['answerCbQuery', text, extra]); }
    };
  };
  const say = (from, text, extra = {}) => guard.handleUpdate(ctxFor({
    message: { message_id: messageId++, chat: GROUP, from, text, ...extra }
  }));
  const of = (name) => calls.filter((c) => c[0] === name);
  return {
    calls, logs, store, guard, telegram, ctxFor, say, of,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    reset: () => { calls.length = 0; }
  };
}

(async () => {
  // Anggota jualan: dihapus, dimute 60 menit, satu peringatan dengan tombol.
  {
    const env = makeEnv();
    assert.strictEqual(await env.say(MEMBER, SALE_TEXT), true);
    assert.strictEqual(env.of('deleteMessage').length, 1, 'pesan jualan harus dihapus');
    const [mute] = env.of('restrictChatMember');
    assert(mute, 'pengirim harus dimute');
    assert.strictEqual(mute[2], MEMBER.id);
    assert.strictEqual(mute[3].permissions.can_send_messages, false);
    assert.strictEqual(mute[3].until_date, Math.floor(env.now() / 1000) + 3600, 'mute harus 1 jam');
    const [warn] = env.of('sendMessage');
    assert(warn[2].includes('Dilarang jualan dan promosi'), 'peringatan harus dikirim');
    assert(warn[2].includes('dimute 1 jam'));
    assert(warn[2].includes(`tg://user?id=${MEMBER.id}`), 'peringatan harus menyebut pengirim');
    assert(warn[2].includes('Budi &lt;b&gt;'), 'nama pengirim harus di-escape');
    assert.strictEqual(warn[3].parse_mode, 'HTML');
    assert.deepStrictEqual(warn[3].reply_markup.inline_keyboard, [[{ text: 'Buka Mute', callback_data: `asb_unmute:${MEMBER.id}` }]]);
    assert(env.logs.some((l) => l.startsWith('[anti-jualan] mute')), 'tindakan harus tercatat di log');

    // Pesan susulan selama masa mute: dihapus diam-diam.
    env.reset();
    await env.say(MEMBER, 'Dijual akun ML sultan, cek bio');
    assert.strictEqual(env.of('deleteMessage').length, 1);
    assert.strictEqual(env.of('restrictChatMember').length, 0, 'tidak boleh mute ulang dalam masa mute');
    assert.strictEqual(env.of('sendMessage').length, 0, 'tidak boleh ada peringatan berulang');

    // Setelah masa mute habis, pelanggaran baru ditindak lagi.
    env.advance(3601 * 1000);
    env.reset();
    await env.say(MEMBER, SALE_TEXT);
    assert.strictEqual(env.of('restrictChatMember').length, 1);

    // Obrolan biasa tidak disentuh.
    env.reset();
    await env.say(MEMBER, 'ada yang jual vps murah ga?');
    assert.strictEqual(env.calls.length, 0, 'obrolan biasa tidak boleh memanggil API apa pun');
  }

  // Admin grup, admin bot, admin anonim, channel tertaut, dan bot lain lolos.
  {
    const env = makeEnv();
    await env.say(ADMIN, SALE_TEXT);
    await env.say(OWNER, SALE_TEXT);
    await env.say({ id: 1087968824, is_bot: true, first_name: 'Group' }, SALE_TEXT, { sender_chat: GROUP });
    await env.say({ id: 777000, first_name: 'Telegram' }, SALE_TEXT, { is_automatic_forward: true, sender_chat: { id: -100555, type: 'channel' } });
    await env.say({ id: 99, is_bot: true, first_name: 'BotLain' }, SALE_TEXT);
    assert.strictEqual(env.of('deleteMessage').length + env.of('restrictChatMember').length, 0, 'pengecualian tidak boleh ditindak');
  }

  // Daftar admin tidak terbaca: tidak menindak.
  {
    const env = makeEnv({ fail: { admins: true } });
    await env.say(MEMBER, SALE_TEXT);
    assert.strictEqual(env.of('deleteMessage').length + env.of('restrictChatMember').length, 0, 'tanpa daftar admin tidak boleh menindak');
  }

  // Pesan atas nama channel lain: dihapus tanpa mute.
  {
    const env = makeEnv();
    await env.say({ id: 136817688, is_bot: true, first_name: 'Channel' }, SALE_TEXT, { sender_chat: { id: -100777, type: 'channel', title: 'Toko' } });
    assert.strictEqual(env.of('deleteMessage').length, 1);
    assert.strictEqual(env.of('restrictChatMember').length, 0);
    assert(env.of('sendMessage')[0][2].includes('channel <b>Toko</b>'));
  }

  // Pesan yang diedit jadi promosi juga ditindak.
  {
    const env = makeEnv();
    await env.guard.handleUpdate(env.ctxFor({ edited_message: { message_id: 5, chat: GROUP, from: MEMBER, text: SALE_TEXT } }));
    assert.strictEqual(env.of('restrictChatMember').length, 1, 'edit pesan jadi promosi harus ditindak');
  }

  // Bot tanpa izin mute: pesan tetap dihapus, peringatan menyebut izin, dan
  // catatan izin dibatasi supaya grup tidak dibanjiri.
  {
    const env = makeEnv({ fail: { restrict: true } });
    await env.say(MEMBER, SALE_TEXT);
    const [warn] = env.of('sendMessage');
    assert(warn[2].includes('Blokir Pengguna'), 'peringatan harus menyebut izin yang kurang');
    assert(!warn[3].reply_markup, 'tanpa mute tidak ada tombol Buka Mute');
    env.reset();
    await env.say({ id: 31, first_name: 'Lain' }, SALE_TEXT);
    assert(!env.of('sendMessage')[0][2].includes('Blokir Pengguna'), 'catatan izin tidak boleh diulang tiap pesan');
  }

  // /antijualan: status untuk siapa saja, on/off hanya admin grup.
  {
    const env = makeEnv();
    await env.say(MEMBER, '/antijualan');
    assert(env.of('sendMessage')[0][2].includes('Status: AKTIF'));
    env.reset();
    await env.say(MEMBER, '/antijualan off');
    assert(env.of('sendMessage')[0][2].includes('Hanya admin grup'));
    assert.strictEqual(env.store.size, 0, 'anggota biasa tidak boleh mematikan');
    env.reset();
    await env.say(ADMIN, '/antijualan@TestBot off');
    assert.strictEqual(env.store.get(String(GROUP.id)), false);
    assert(env.of('sendMessage')[0][2].includes('NONAKTIF'));
    env.reset();
    await env.say(MEMBER, SALE_TEXT);
    assert.strictEqual(env.calls.length, 0, 'grup yang dimatikan tidak boleh ditindak');
    await env.say(ADMIN, '/antijualan on');
    env.reset();
    await env.say(MEMBER, SALE_TEXT);
    assert.strictEqual(env.of('restrictChatMember').length, 1, 'setelah on harus menindak lagi');
  }

  // Tombol Buka Mute: anggota biasa ditolak, admin grup membuka mute dengan izin
  // bawaan grup dan peringatan diperbarui.
  {
    const env = makeEnv();
    await env.say(MEMBER, SALE_TEXT);
    const press = (from) => env.guard.handleUpdate(env.ctxFor({
      callback_query: { id: 'q', from, data: `asb_unmute:${MEMBER.id}`, message: { message_id: 900, chat: GROUP, text: 'Dilarang jualan dan promosi di grup ini.' } }
    }));
    env.reset();
    await press(MEMBER);
    assert.strictEqual(env.of('restrictChatMember').length, 0);
    assert(env.of('answerCbQuery')[0][1].includes('Hanya admin grup'));
    env.reset();
    await press(ADMIN);
    const [unmute] = env.of('restrictChatMember');
    assert.strictEqual(unmute[2], MEMBER.id);
    assert.deepStrictEqual(unmute[3].permissions, { can_send_messages: true, can_send_photos: false }, 'harus memakai izin bawaan grup');
    assert(env.of('editMessageText')[0][4].includes('Mute dibuka oleh Admin'));
    // Setelah dibuka, pelanggaran berikutnya ditindak lagi tanpa menunggu.
    env.reset();
    await env.say(MEMBER, SALE_TEXT);
    assert.strictEqual(env.of('restrictChatMember').length, 1);
  }

  // Menu jualan di grup diarahkan ke chat pribadi (dibatasi per menit).
  {
    const env = makeEnv();
    await env.say(MEMBER, '/start');
    await env.say(MEMBER, '/menu');
    const sent = env.of('sendMessage');
    assert.strictEqual(sent.length, 1, 'pemberitahuan chat pribadi dibatasi');
    assert(sent[0][2].includes('chat pribadi'));
    assert.strictEqual(sent[0][3].reply_markup.inline_keyboard[0][0].url, 'https://t.me/TestBot');
  }

  // Bot baru masuk grup: kirim status dan izin yang dibutuhkan.
  {
    const env = makeEnv();
    await env.guard.handleUpdate(env.ctxFor({
      my_chat_member: { chat: GROUP, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } }
    }));
    assert(env.of('sendMessage')[0][2].includes('Anti Jualan'));
  }

  // Chat pribadi tidak ditangani modul ini.
  {
    const env = makeEnv();
    const handled = await env.guard.handleUpdate(env.ctxFor({
      message: { message_id: 1, chat: { id: MEMBER.id, type: 'private' }, from: MEMBER, text: SALE_TEXT }
    }));
    assert.strictEqual(handled, false);
    assert.strictEqual(env.calls.length, 0);
  }

  // --- Pemasangan di app3.js ---------------------------------------------------
  const app = fs.readFileSync(path.join(repoRoot, 'app3.js'), 'utf8').replace(/\r\n/g, '\n');
  assert(app.includes("require('./lib/anti-sales')"), 'app3.js harus memuat lib/anti-sales');
  assert(app.includes('CREATE TABLE IF NOT EXISTS anti_sales_groups'), 'tabel pengaturan grup harus dibuat');
  const useAt = app.indexOf('bot.use(async (ctx, next) => {\n  if (!antiSales.isGroupChat(ctx.chat)) return next();');
  assert(useAt > 0, 'middleware grup harus terpasang');
  const firstHandler = app.search(/\nbot\.(start|command|action|on|hears|help)\(/);
  assert(firstHandler > useAt, 'middleware grup harus terdaftar sebelum handler lain');
  const middleware = app.slice(useAt, app.indexOf('\n});\n', useAt));
  assert.strictEqual((middleware.match(/next\(\)/g) || []).length, 1, 'update grup tidak boleh diteruskan ke menu jualan');

  // Teks bot tanpa emoji (aturan tampilan bot).
  const lib = fs.readFileSync(path.join(repoRoot, 'lib', 'anti-sales.js'), 'utf8');
  assert(!/\p{Extended_Pictographic}/u.test(lib), 'lib/anti-sales.js tidak boleh memakai emoji');

  console.log('anti sales: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

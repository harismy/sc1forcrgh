'use strict';

// Anti jualan di grup (lib/anti-sales.js + pemasangan di app3.js).
// - Deteksi: pesan jualan/promosi tertangkap, obrolan biasa dan pertanyaan
//   pembeli tidak (salah mute lebih merugikan daripada satu promo lolos).
// - Penindakan: hapus pesan, mute sesuai durasi, satu peringatan per masa
//   mute, admin grup/admin bot/admin anonim tidak pernah ditindak, daftar admin
//   yang tidak terbaca berarti tidak menindak.
// - Perintah di grup hanya untuk admin (anggota biasa didiamkan); tombol
//   Buka Mute hanya admin.
// - Promosi jualan VPN (fixture contoh nyata dengan kontak disamarkan dan
//   variasi buatan) tertangkap, obrolan bantuan grup VPN dan detail akun tidak.
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
  'Sewa VPS 30 hari 15k, pm',
  'jasa install sc, fast respon, wa 081234567890',
  '\u{1d5dd}\u{1d5e8}\u{1d5d4}\u{1d5df} \u{1d5d4}\u{1d5de}\u{1d5e8}\u{1d5e1} \u{1d5e3}\u{1d5e5}\u{1d5d8}\u{1d5e0}\u{1d5dc}\u{1d5e8}\u{1d5e0} \u{1d5e0}\u{1d5e8}\u{1d5e5}\u{1d5d4}\u{1d5db}\nminat pm',
  'PROMO 50% hari ini, order sekarang! wa 081234567890',
  'Netflix premium murah bergaransi, minat? japri',
  'j u a l akun premium murah, pm',
  'j.u.a.l akun premium, pm',
  'Situs slot online maxwin hari ini, daftar sekarang bit.ly/abc123',
  'jual akun, bayar via dana, wa 08123456789',
  'Yang cari vps murah pm aja',
  'Jual akun, yang mau beli pm',
  'Juaaal sc premium murahhh, japri',
  'Harga 10k aja, wa 0812-3456-7890',
  'Jualannya ready stock kak, langsung pm',
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
// Pesan pendek tanpa jalur kontak/beli tidak ditindak walau berbau jualan:
// obrolan pendek seperti ini pernah salah kena (laporan grup, pesan pertama).
const SHORT_NO_CONTACT = [
  'Update juga atuh bang fitur di bot  jualan yang premium 30k perbulan itu pass order gak harus top up dlu langsung ada pembayaran menu qris nya juga',
  'Sewa VPS 30 hari 15k',
  'PROMO 50% hari ini, order sekarang!',
  'Netflix premium murah bergaransi, minat?',
  'Juaaal sc premium murahhh',
  '𝗢𝗣𝗘𝗡 𝗥𝗘𝗦𝗘𝗟𝗟𝗘𝗥 SC harga mulai 5k',
  'mode bot panel buat jualan akun udah bisa qris belum min? harga premium 30k/bulan kan'
];
for (const text of SHORT_NO_CONTACT) {
  const r = analyzeSalesText(text);
  assert(!r.flagged, `pesan pendek tanpa kontak tidak boleh kena: ${JSON.stringify(text)} (skor ${r.score}: ${r.reasons.join(',')})`);
}
// "bot jualan" adalah nama fitur, bukan kata jual.
assert(!analyzeSalesText('fitur bot jualan premium').reasons.includes('jual'));
assert(analyzeSalesText('saya jualan akun').reasons.includes('jual'));
for (const text of NORMAL) {
  const r = analyzeSalesText(text);
  assert(!r.flagged, `tidak boleh terdeteksi jualan: ${JSON.stringify(text)} (skor ${r.score}: ${r.reasons.join(',')})`);
}
assert.strictEqual(analyzeSalesText('').flagged, false);

// --- Promosi jualan VPN ------------------------------------------------------
// Contoh nyata dari grup (kontak, username, dan link sudah disamarkan). Gaya
// iklan selalu berganti, jadi deteksi diuji juga dengan variasi buatan dan
// obrolan bantuan khas grup VPN yang memakai kosakata yang sama.
const VPN_PROMOS = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', 'fixtures', 'anti-sales-vpn-promos.json'), 'utf8'));
const VPN_SALES = [
  'OPEN RESELLER VPN\nSSH / VMESS / VLESS 10K/bulan\nminat chat @contoh_store',
  'Jual akun zivpn udp custom 30 hari 8rb, order via bot @contoh_bot',
  'VPS SG DO R2C1 50rb/bulan ready, pm aja',
  '\u{1f525} PROMO SC TUNNELING \u{1f525}\nsewa script 10k/bulan, auto install, garansi\nOrder: t.me/contohstore',
  'Akun vless premium murah server ID/SG, trial gratis, cek bio',
  'Yang mau vpn murah 5rb sebulan langsung ke @contohvpnbot ya',
  'Kuota xl edukasi 15gb 7hari 10rb ready, wa 0812 3456 7890',
  'ᴊᴜᴀʟ ᴠᴘɴ ᴘʀᴇᴍɪᴜᴍ ᴍᴜʀᴀʜ\nᴏʀᴅᴇʀ : @contoh_admin',
  'Numpang promo ya min, config HC xl opok 15rb/bulan, japri',
  'VPN SSH/VMESS/VLESS/TROJAN\n7 hari 3k\n15 hari 6k\n30 hari 10k\n60 hari 18k\nbot: @contohvpn_bot',
  'Big sale akhir bulan! top up saldo dapat bonus 30%, cuma di @contohsaldo_bot',
  'Sedia VPS biznet R1C1 bandwidth unli, harga bersahabat. Admin: @contoh_vps',
  'Bot auto order vpn 24 jam, bayar QRIS langsung jadi: t.me/contohautobot',
  'Mau internetan lancar? pakai VPN premium kami, cuma 5rb sebulan, langsung order di @contoh_bot',
  'NEW SERVER SG READY\nVmess/Vless/Trojan 30 hari 10K\nGaransi full 30 hari\nOwner : @contoh_owner',
  'Ready akun netflix, canva, youtube premium. Harga mulai 5rb. Chat wa.me/6281200000009',
  'Jasa install SC tunneling + domain, fast respon, cek t.me/contohjasa',
  'Info server baru ya guys, langsung meluncur ke bot kita @contohnew_bot harga cuma 7rb/30 hari',
  'Testimoni pelanggan ada di whatsapp.com/channel/ContohKodeChannel09'
];
const VPN_CHAT = [
  'min ssh sg4 ga konek, payload GET / HTTP/1.1[crlf]Host: bug.com[crlf]Upgrade: websocket[crlf][crlf]',
  'harga sc 1forcr berapa min sebulan?',
  'bot @contohvpn_bot lagi error ya min?',
  'saya beli vless 30 hari 10rb di bot, kok sudah expired?',
  'udah top up 25rb tapi saldo belum masuk, wa saya 08123456789',
  'server SG leaseweb sama ID biznet lebih stabil mana?',
  'config HC xl edukasi ada yang punya? bagi dong',
  'Admin: @admin_sc tolong cek akun saya',
  'VPS DO 6$/bulan, vultr 5$, mending mana buat tunneling?',
  'udp custom 1-65535@user:pass ga konek min',
  'makasih min, vmess udah jalan lagi',
  'status server: sg4 normal, id2 maintenance sampai jam 3',
  'renew vps biznet 75rb kemarin, sekarang install ulang sc',
  'reseller saya kok ga bisa tambah saldo?',
  'list server yang ready apa aja min?',
  'promo bulan ini ada ga min?',
  'udah ready vps nya min, tinggal install sc',
  'pakai zivpn sama udp custom bedanya apa? ssh vmess vless juga bisa?',
  'tadi bayar 10.000 terus 20.000 lagi buat perpanjang, kok saldo cuma 10.000?',
  'kalau mau perpanjang sc 30 hari bayar lewat bot kan min?',
  'izin min mau tanya, cara ganti domain gimana?',
  'mulai besok server sg4 dipindah ke vps baru',
  'vpn premium saya error terus dari pagi',
  'harga reseller berapa min?',
  'tolong cek @contoh_member akun dia kena lock',
  'xl edukasi 15gb masih bisa dipakai buat inject?',
  'kenapa vless grpc lemot ya? vmess ws lancar'
];
VPN_PROMOS.forEach((text, i) => {
  const r = analyzeSalesText(text);
  assert(r.flagged, `contoh promosi VPN #${i + 1} harus tertangkap (skor ${r.score}: ${r.reasons.join(',')})`);
});
for (const text of VPN_SALES) {
  const r = analyzeSalesText(text);
  assert(r.flagged, `promosi VPN harus tertangkap: ${JSON.stringify(text)} (skor ${r.score}: ${r.reasons.join(',')})`);
}
for (const text of VPN_CHAT) {
  const r = analyzeSalesText(text);
  assert(!r.flagged, `obrolan grup VPN tidak boleh kena: ${JSON.stringify(text)} (skor ${r.score}: ${r.reasons.join(',')})`);
}
// Detail akun yang sering ditempel member saat minta bantuan.
const accountMessages = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', 'fixtures', 'account-message-parity.json'), 'utf8'));
for (const c of accountMessages.cases) {
  const r = analyzeSalesText(c.expected);
  assert(!r.flagged, `detail akun tidak boleh kena (skor ${r.score}: ${r.reasons.join(',')})`);
}
// Huruf kapital kecil dan huruf Kiril yang mirip Latin terbaca.
assert.strictEqual(antiSales.normalizeText('ᴘʀᴏᴍᴏ јуаl'), 'promo jyal');

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
  const adminIds = [ADMIN.id];
  const telegram = {
    getChatAdministrators: async (chatId) => {
      calls.push(['getChatAdministrators', chatId]);
      if (fail.admins) throw new Error('timeout');
      return adminIds.map((id, i) => ({ user: { id }, status: i === 0 ? 'creator' : 'administrator' }));
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
    calls, logs, store, guard, telegram, ctxFor, say, of, adminIds,
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
    assert(warn[2].includes('dimute 1 jam karena melanggar aturan grup: dilarang jualan dan promosi.'), 'peringatan harus dikirim');
    assert(!/terdeteksi|harga|jual,/i.test(warn[2].replace('dilarang jualan', '')), 'peringatan tidak boleh merinci alasan deteksi');
    assert(env.logs.some((l) => l.includes('alasan=') && l.includes('jual')), 'alasan rinci tetap tercatat di log');
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
    assert(env.of('sendMessage')[0][2].includes('dihapus karena melanggar aturan grup'));
  }

  // Bot tanpa izin hapus maupun mute: tidak boleh menuduh siapa pun di grup,
  // hanya mengingatkan izin sekali, lalu diam.
  {
    const env = makeEnv({ fail: { restrict: true, delete: true } });
    await env.say(MEMBER, SALE_TEXT);
    const [notice] = env.of('sendMessage');
    assert(notice[2].includes('Hapus Pesan dan Blokir Pengguna'), 'harus mengingatkan izin');
    assert(!notice[2].includes('tg://user'), 'tanpa tindakan tidak boleh menyebut pengirim');
    env.reset();
    await env.say({ id: 31, first_name: 'Lain' }, SALE_TEXT);
    assert.strictEqual(env.of('sendMessage').length, 0, 'tanpa izin, bot diam setelah pengingat pertama');
  }

  // Perintah di grup hanya untuk admin: anggota biasa didiamkan tanpa balasan.
  {
    const env = makeEnv();
    for (const cmd of ['/antijualan', '/antijualan off', '/antijualan@TestBot on', '/start', '/menu', '/admin']) {
      await env.say(MEMBER, cmd);
    }
    assert.strictEqual(env.of('sendMessage').length, 0, 'perintah anggota biasa tidak boleh dibalas');
    assert.strictEqual(env.store.size, 0, 'anggota biasa tidak boleh mengubah anti jualan');
    assert.strictEqual(env.of('getChatAdministrators').length, 1, 'spam perintah anggota tidak boleh memanggil API terus');

    // Perintah yang ternyata promosi tetap ditindak.
    await env.say(MEMBER, '/jual akun vpn murah 10k, wa 081234567890');
    assert.strictEqual(env.of('restrictChatMember').length, 1, 'promosi berbentuk perintah tetap ditindak');

    // Admin baru dikenali tanpa menunggu cache 10 menit habis.
    const NEW_ADMIN = { id: 40, first_name: 'Admin Baru' };
    env.adminIds.push(NEW_ADMIN.id);
    env.reset();
    await env.say(NEW_ADMIN, '/antijualan');
    assert.strictEqual(env.of('sendMessage').length, 0, 'jawaban cache masih dipakai di menit pertama');
    env.advance(61 * 1000);
    await env.say(NEW_ADMIN, '/antijualan');
    assert(env.of('sendMessage')[0][2].includes('Status: AKTIF'), 'admin baru dikenali setelah cek ulang');
  }

  // /antijualan: status dan on/off untuk admin grup.
  {
    const env = makeEnv();
    await env.say(ADMIN, '/antijualan');
    assert(env.of('sendMessage')[0][2].includes('Status: AKTIF'));
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

  // Menu jualan di grup diarahkan ke chat pribadi (khusus admin, dibatasi per menit).
  {
    const env = makeEnv();
    await env.say(ADMIN, '/start');
    await env.say(OWNER, '/menu');
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

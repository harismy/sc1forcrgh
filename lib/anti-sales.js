'use strict';

// Anti jualan/promosi di grup Telegram untuk bot app3.js.
//
// Bot dipasang di grup mana saja sebagai admin (izin Hapus Pesan dan Blokir
// Pengguna). Pesan anggota yang terdeteksi jualan atau promosi dihapus,
// pengirimnya dimute (default 60 menit), dan bot menulis peringatan dengan
// tombol "Buka Mute" untuk admin grup. Admin grup dan admin bot tidak pernah
// diperiksa. Admin grup mematikan per grup lewat /antijualan off.
//
// Deteksi sengaja condong menghindari salah mute: satu kata saja ("jual",
// "promo", "harga 25rb") tidak cukup. Pesan baru ditindak kalau sinyal jualan
// bertemu harga, kontak, atau sinyal jualan lain. Pertanyaan pembeli ("ada yang
// jual ...?", "harga berapa?") dan konfirmasi bayar mengurangi skor.

const SCORE_THRESHOLD = 4;
const DEFAULT_MUTE_MINUTES = 60;
const ADMIN_CACHE_MS = 10 * 60 * 1000;
const RIGHTS_NOTICE_MS = 6 * 60 * 60 * 1000;
const PRIVATE_NOTICE_MS = 60 * 1000;
const FAILED_MUTE_QUIET_MS = 10 * 60 * 1000;
const MAX_TEXT = 4000;

// Kata jualan yang jelas (bobot 3).
const STRONG_SALE = [
  ['jual', /\b(?:di|men|pen)?ju[a4@]l(?:an|in|kan)?(?:nya)?\b/],
  ['jual', /\bj[\s._*-]{1,3}u[\s._*-]{1,3}[a4@][\s._*-]{1,3}l\b/],
  ['wts', /\bwts\b/],
  ['open order', /\bopen\s*(?:order|po|pre\s*order|reseller|member|jasa|slot|joki|rekber|lapak|sewa)\b/],
  ['ready stock', /\b(?:ready\s*(?:stock|stok|slot|akun|banyak)|(?:stock|stok)\s*(?:ready|tersedia|terbatas)|restock)\b/],
  ['daftar harga', /\b(?:price\s*list|pricelist|list\s*harga|daftar\s*harga)\b/],
  ['promo', /\bpromo\b/],
  ['diskon', /\b(?:diskon|discount|potongan\s+harga)\b/],
  ['sewa', /\b(?:di|me|men)?sewa(?:in|kan)?\b|\bnyewa(?:in)?\b/],
  ['jasa', /\bjasa\b/],
  ['terima order', /\b(?:terima|menerima|melayani|layani)\s+(?:order|orderan|pesanan|jasa|pembuatan|joki|sewa)\b/],
  ['ajakan order', /\border(?:an)?\s*(?:(?:via|di|ke|langsung|sekarang|aja|disini)\b|[:=])|\b(?:langsung\s+order|order\s+now)\b/],
  ['ajakan beli', /\b(?:yang|yg|siapa)\s+(?:mau|minat|berminat|butuh)\s+(?:beli|order|sewa|langganan)\b|\b(?:yang|yg)\s+(?:minat|berminat|cari|nyari|butuh|perlu)\b/],
  ['fast respon', /\bfast\s*(?:respon|respons|response|resp|rep)\b/],
  ['testimoni', /\btesti(?:moni)?\b/],
  ['cek bio', /\b(?:cek|lihat|liat|link\s*(?:di|in))\s*bio\b/],
  ['nego', /\b(?:nego|bisa\s+cod)\b/],
  ['judi online', /\b(?:togel|judol|casino|kasino|maxwin|slot\s*(?:online|gacor)|sbobet|rtp\s*live|situs\s*(?:judi|slot))\b/]
];

// Kata yang sering ada di iklan, tapi juga di obrolan biasa (bobot 1).
const WEAK_SALE = [
  ['murah', /\b(?:murah|termurah|murmer)\b/],
  ['garansi', /\b(?:ber)?garansi\b/],
  ['minat', /\b(?:minat|berminat)\b/],
  ['terpercaya', /\b(?:trusted|terpercaya|amanah)\b/],
  ['stok', /\b(?:stok|stock|slot)\b/],
  ['premium', /\bpremium\b/]
];

// Ajakan bergabung/mengunjungi (bobot 2).
const PROMO = [
  ['ajakan gabung', /\b(?:join|gabung|follow|ikuti|subscribe|subs|kunjungi|mampir)\b[^\n]{0,30}?\b(?:channel|chanel|ch|grup|group|grub|gc|saluran|ig|instagram|tiktok|youtube|yt|web|website|situs|link|toko)\b/],
  ['klik link', /\bklik\s+(?:link|tautan|disini|di\s+sini)\b/],
  ['ajakan daftar', /\b(?:daftar|register|registrasi)\s+(?:sekarang|disini|di\s+sini|via|lewat|langsung)\b/]
];

// Harga (bobot 2, dihitung sekali). Angka IP (103.123.45.6) tidak dihitung.
const PRICE = [
  /\brp\.?\s?\d/,
  /(?<![\d.,])\d{1,3}(?:[.,]\d{3})+(?![.,]?\d)/,
  /\b\d+\s?(?:k|rb|rbu|ribu|jt|juta)\b/,
  /(?:\/|\bper\s?)(?:bulan|bln|hari|hr|minggu|mgg|month|tahun|thn)\b/,
  /\$\s?\d|\b\d+\s?\$|\b\d+\s?usd\b/
];

// Kontak atau link yang mengarah keluar grup (bobot 3).
const STRONG_CONTACT = [
  ['link whatsapp', /\b(?:wa\.me|api\.whatsapp\.com|whatsapp\.com\/send|wa\.link)\b/],
  ['nomor hp', /(?<!\d)(?:\+?62|0)\s?8\d{2}[\s.-]?\d{3,4}[\s.-]?\d{3,5}(?!\d)/],
  ['link telegram', /\b(?:t|telegram)\.me\/[a-z0-9_]{4,}/],
  ['link toko', /\b(?:bit\.ly|s\.id|linktr\.ee|lynk\.id|tinyurl\.com|cutt\.ly|shope\.ee|shopee\.co\.id|tokopedia\.(?:com|link)|saweria\.co|trakteer\.id|heylink\.me|linkr\.bio)\//]
];

// Ajakan kontak yang juga dipakai di obrolan biasa (bobot 1).
const WEAK_CONTACT = [
  ['ajakan pm', /\b(?:pm|dm|japri|inbox|hubungi|hub|kontak|contact|cp|wa|whatsapp)\b/],
  ['mention', /(?:^|\s)@[a-z0-9_]{5,}\b/]
];

// Link undangan grup lain selalu dianggap promosi (bobot 6).
const INVITE = [
  ['link undangan grup', /\b(?:t|telegram)\.me\/(?:\+|joinchat\/)[\w-]+/],
  ['link undangan grup', /\bchat\.whatsapp\.com\/\w+/],
  ['link undangan grup', /\bdiscord(?:\.gg|(?:app)?\.com\/invite)\/\w+/]
];

// Pembeli yang bertanya (-3), kecuali pesan juga membawa kontak/link keluar.
const BUYER = [
  /\b(?:ada|siapa)\s+(?:yang|yg)\s+(?:jual|sewa|nyewa|punya|jasa|open)\b/,
  /(?:^|[^a-z])(?:yang|yg)\s+(?:jual|sewa|nyewa)\b/,
  /(?<!(?:yang|yg|siapa)\s)\b(?:mau|pengen|pengin|ingin|pingin|niat|rencana)\s+(?:beli|sewa|nyewa|order|langganan|ambil)\b/,
  /\b(?:aku|saya|gw|gue|gua|ane|sy|aq)\s+(?:beli|order|sewa|nyewa)\b/,
  /(?<!(?:yang|yg)\s)\b(?:cari|nyari|mencari|butuh|wtb|request|req)\b/,
  /\b(?:beli|jual|sewa)\s+(?:dimana|di\s+mana|dmn)\b/,
  /\b(?:berapa|brp|brapa)\b/,
  /\bada\s+(?:promo|diskon)\b/
];

// Konfirmasi bayar (-3), hanya kalau tidak ada kata jualan yang jelas.
const PAYMENT = /\b(?:transfer|tf|bayar|dibayar|bayarnya|lunas|saldo|top\s?up|refund|bukti|invoice|struk)\b/;

// Pertanyaan (-2): tanda tanya plus kata tanya.
const QUESTION_WORDS = /\b(?:apa|apakah|gimana|bagaimana|kapan|kenapa|mengapa|kok|masih|dimana|di\s+mana|bisa\s*(?:ga|gak|nggak|tidak)|ada\s*(?:ga|gak|nggak))\b/;

const NO_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false
};

// Dipakai saat izin bawaan grup tidak bisa dibaca.
const FALLBACK_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: true,
  can_pin_messages: false,
  can_manage_topics: false
};

function normalizeText(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/[​-‏⁠﻿­]/g, '')
    .toLowerCase()
    .replace(/([a-z])\1{2,}/g, '$1')
    .slice(0, MAX_TEXT);
}

function matchLabels(text, patterns) {
  const labels = [];
  for (const [label, re] of patterns) {
    if (!labels.includes(label) && re.test(text)) labels.push(label);
  }
  return labels;
}

function analyzeSalesText(raw) {
  const text = normalizeText(raw);
  if (!text.trim()) return { flagged: false, score: 0, reasons: [] };

  const strongSale = matchLabels(text, STRONG_SALE);
  const weakSale = matchLabels(text, WEAK_SALE);
  const promo = matchLabels(text, PROMO);
  const price = PRICE.some((re) => re.test(text));
  const strongContact = matchLabels(text, STRONG_CONTACT);
  const weakContact = matchLabels(text, WEAK_CONTACT);
  const invite = matchLabels(text, INVITE);
  const outbound = strongContact.length > 0 || invite.length > 0;

  let score = strongSale.length * 3 + weakSale.length + promo.length * 2
    + (price ? 2 : 0) + strongContact.length * 3 + weakContact.length + invite.length * 6;
  if (!outbound && BUYER.some((re) => re.test(text))) score -= 3;
  if (!strongSale.length && PAYMENT.test(text)) score -= 3;
  if (!outbound && text.includes('?') && QUESTION_WORDS.test(text)) score -= 2;

  const reasons = [...invite, ...strongSale, ...promo, ...(price ? ['harga'] : []), ...strongContact, ...weakSale, ...weakContact];
  return { flagged: score >= SCORE_THRESHOLD, score, reasons };
}

// Semua teks yang terlihat anggota grup: isi, caption, URL tersembunyi di
// balik teks, tombol, dan polling.
function collectMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [message.text, message.caption];
  for (const ent of [...(message.entities || []), ...(message.caption_entities || [])]) {
    if (ent && ent.type === 'text_link' && ent.url) parts.push(ent.url);
  }
  for (const row of message.reply_markup?.inline_keyboard || []) {
    for (const btn of Array.isArray(row) ? row : []) {
      parts.push(btn?.text, btn?.url);
    }
  }
  if (message.poll) {
    parts.push(message.poll.question, ...(message.poll.options || []).map((o) => o?.text));
  }
  return parts.filter(Boolean).join('\n').slice(0, MAX_TEXT);
}

function isGroupChat(chat) {
  return Boolean(chat) && (chat.type === 'group' || chat.type === 'supergroup');
}

// Perintah untuk bot ini saja. /cmd@BotLain dianggap pesan biasa.
function parseGroupCommand(text, botUsername) {
  const m = String(text || '').match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  if (m[2] && String(m[2]).toLowerCase() !== String(botUsername || '').toLowerCase()) return null;
  return { name: m[1].toLowerCase(), args: String(m[3] || '').trim() };
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function displayName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  return (name || (user?.username ? `@${user.username}` : '') || 'Pengguna').slice(0, 64);
}

function durationText(minutes) {
  return minutes % 60 === 0 ? `${minutes / 60} jam` : `${minutes} menit`;
}

function shortError(err) {
  return String(err?.response?.description || err?.description || err?.message || err || 'error').slice(0, 120);
}

function createAntiSalesGuard(options = {}) {
  const isOwner = typeof options.isOwner === 'function' ? options.isOwner : () => false;
  const loadEnabled = typeof options.loadEnabled === 'function' ? options.loadEnabled : async () => null;
  const saveEnabled = typeof options.saveEnabled === 'function' ? options.saveEnabled : async () => {};
  const buildKeyboard = typeof options.buildKeyboard === 'function'
    ? options.buildKeyboard
    : (rows) => ({ reply_markup: { inline_keyboard: rows } });
  const log = typeof options.log === 'function' ? options.log : (line) => console.log(line);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const defaultEnabled = options.defaultEnabled !== false;
  const muteMinutes = Math.max(1, Math.min(366 * 24 * 60, Math.floor(Number(options.muteMinutes) || DEFAULT_MUTE_MINUTES)));

  const enabledCache = new Map();
  const adminCache = new Map();
  const recentActions = new Map();
  const noticeAt = new Map();

  function noticeAllowed(key, intervalMs) {
    const last = noticeAt.get(key) || 0;
    if (now() - last < intervalMs) return false;
    noticeAt.set(key, now());
    return true;
  }

  function pruneRecent() {
    if (recentActions.size < 500) return;
    const t = now();
    for (const [key, until] of recentActions) {
      if (until <= t) recentActions.delete(key);
    }
  }

  async function isEnabled(chatId) {
    const key = String(chatId);
    if (enabledCache.has(key)) return enabledCache.get(key);
    let value = defaultEnabled;
    try {
      const stored = await loadEnabled(key);
      if (stored === true || stored === false) value = stored;
    } catch (_) {}
    enabledCache.set(key, value);
    return value;
  }

  async function setEnabled(chatId, enabled, title) {
    await saveEnabled(String(chatId), Boolean(enabled), String(title || ''));
    enabledCache.set(String(chatId), Boolean(enabled));
  }

  // true/false, atau null kalau daftar admin tidak bisa dibaca.
  async function isGroupAdmin(telegram, chatId, userId, fresh = false) {
    const key = String(chatId);
    const cached = adminCache.get(key);
    if (!fresh && cached && now() - cached.at < ADMIN_CACHE_MS) return cached.ids.has(Number(userId));
    try {
      const admins = await telegram.getChatAdministrators(chatId);
      const ids = new Set((admins || []).map((a) => Number(a?.user?.id)).filter(Boolean));
      adminCache.set(key, { ids, at: now() });
      return ids.has(Number(userId));
    } catch (_) {
      return null;
    }
  }

  async function botRights(ctx) {
    try {
      const botId = ctx.botInfo?.id || (await ctx.telegram.getMe())?.id;
      const member = await ctx.telegram.getChatMember(ctx.chat.id, botId);
      const isAdmin = member?.status === 'administrator';
      return {
        isAdmin,
        canDelete: isAdmin && member.can_delete_messages === true,
        canRestrict: isAdmin && member.can_restrict_members === true
      };
    } catch (_) {
      return null;
    }
  }

  function threadExtra(message) {
    return message?.is_topic_message && message.message_thread_id
      ? { message_thread_id: message.message_thread_id }
      : {};
  }

  async function send(ctx, text, extra = {}) {
    return ctx.telegram.sendMessage(ctx.chat.id, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra
    }).catch(() => null);
  }

  function statusLines(enabled, rights) {
    const lines = [
      '<b>Anti Jualan</b>',
      `Status: ${enabled ? 'AKTIF' : 'NONAKTIF'}`,
      `Tindakan: hapus pesan jualan/promosi dan mute ${durationText(muteMinutes)}`
    ];
    if (!rights) {
      lines.push('Izin bot: tidak terbaca');
    } else if (!rights.isAdmin) {
      lines.push('Bot belum admin. Jadikan bot admin dengan izin Hapus Pesan dan Blokir Pengguna supaya bot bisa membaca dan menindak pesan.');
    } else {
      lines.push(`Izin bot: Hapus Pesan ${rights.canDelete ? 'ya' : 'TIDAK'}, Blokir Pengguna ${rights.canRestrict ? 'ya' : 'TIDAK'}`);
    }
    lines.push('Admin grup: /antijualan on atau /antijualan off');
    return lines;
  }

  async function onCommand(ctx, message, args) {
    const chat = ctx.chat;
    const arg = String(args || '').split(/\s+/)[0].toLowerCase();
    const reply = { ...threadExtra(message), reply_to_message_id: message.message_id };
    if (arg === 'on' || arg === 'off') {
      const from = message.from || {};
      const allowed = message.sender_chat?.id === chat.id
        || isOwner(from.id)
        || (await isGroupAdmin(ctx.telegram, chat.id, from.id, true)) === true;
      if (!allowed) {
        await send(ctx, 'Hanya admin grup yang bisa mengubah anti jualan.', reply);
        return;
      }
      await setEnabled(chat.id, arg === 'on', chat.title);
      log(`[anti-jualan] ${arg} chat=${chat.id} oleh=${from.id || 'anonim'}`);
      await send(ctx, `Anti jualan ${arg === 'on' ? 'AKTIF' : 'NONAKTIF'} di grup ini.`, reply);
      return;
    }
    const enabled = await isEnabled(chat.id);
    await send(ctx, statusLines(enabled, await botRights(ctx)).join('\n'), reply);
  }

  async function onBotMemberUpdate(ctx, update) {
    const oldStatus = update?.old_chat_member?.status;
    const newStatus = update?.new_chat_member?.status;
    const joined = ['left', 'kicked'].includes(oldStatus) && ['member', 'administrator'].includes(newStatus);
    const promoted = oldStatus === 'member' && newStatus === 'administrator';
    if (!joined && !promoted) return;
    const enabled = await isEnabled(ctx.chat.id);
    await send(ctx, statusLines(enabled, await botRights(ctx)).join('\n'));
  }

  async function onCallback(ctx, query) {
    const m = String(query.data || '').match(/^asb_unmute:(\d+)$/);
    if (!m) {
      await ctx.answerCbQuery('Menu bot hanya bisa dibuka lewat chat pribadi.').catch(() => {});
      return;
    }
    const chat = ctx.chat;
    const actor = query.from || {};
    const allowed = isOwner(actor.id) || (await isGroupAdmin(ctx.telegram, chat.id, actor.id, true)) === true;
    if (!allowed) {
      await ctx.answerCbQuery('Hanya admin grup yang bisa membuka mute.', { show_alert: true }).catch(() => {});
      return;
    }
    const userId = Number(m[1]);
    let permissions = FALLBACK_PERMISSIONS;
    try {
      const info = await ctx.telegram.getChat(chat.id);
      if (info?.permissions) permissions = info.permissions;
    } catch (_) {}
    try {
      await ctx.telegram.restrictChatMember(chat.id, userId, { permissions, use_independent_chat_permissions: true });
    } catch (err) {
      await ctx.answerCbQuery(`Gagal membuka mute: ${shortError(err)}`, { show_alert: true }).catch(() => {});
      return;
    }
    recentActions.delete(`${chat.id}:${userId}`);
    log(`[anti-jualan] unmute chat=${chat.id} user=${userId} oleh=${actor.id}`);
    await ctx.answerCbQuery('Mute dibuka.').catch(() => {});
    const msg = query.message;
    if (msg?.message_id) {
      const base = String(msg.text || '').trim();
      await ctx.telegram.editMessageText(
        chat.id,
        msg.message_id,
        undefined,
        `${base}\n\nMute dibuka oleh ${displayName(actor)}.`.trim()
      ).catch(() => {});
    }
  }

  async function notifyPrivateOnly(ctx, message) {
    if (!noticeAllowed(`private:${ctx.chat.id}`, PRIVATE_NOTICE_MS)) return;
    const username = ctx.botInfo?.username;
    const keyboard = username ? buildKeyboard([[{ text: 'Buka Bot', url: `https://t.me/${username}` }]]) : {};
    await send(ctx, 'Menu bot hanya bisa dibuka lewat chat pribadi.', {
      ...threadExtra(message),
      reply_to_message_id: message.message_id,
      ...keyboard
    });
  }

  async function checkMessage(ctx, message) {
    const chat = ctx.chat;
    if (message.is_automatic_forward) return;
    if (message.sender_chat && message.sender_chat.id === chat.id) return;
    const channel = message.sender_chat || null;
    const from = message.from;
    if (!channel && (!from || from.is_bot)) return;
    if (!(await isEnabled(chat.id))) return;

    const verdict = analyzeSalesText(collectMessageText(message));
    if (!verdict.flagged) return;
    if (!channel) {
      if (isOwner(from.id)) return;
      // Daftar admin tidak terbaca: jangan menindak daripada salah mute.
      if ((await isGroupAdmin(ctx.telegram, chat.id, from.id)) !== false) return;
    }

    const deleted = await ctx.telegram.deleteMessage(chat.id, message.message_id).then(() => true, () => false);
    const actorId = channel ? `c${channel.id}` : String(from.id);
    const key = `${chat.id}:${actorId}`;
    // Pesan susulan dalam masa mute cukup dihapus, tanpa peringatan baru.
    if ((recentActions.get(key) || 0) > now()) return;

    let muted = false;
    let muteError = null;
    if (!channel) {
      const untilSec = Math.floor(now() / 1000) + muteMinutes * 60;
      try {
        await ctx.telegram.restrictChatMember(chat.id, from.id, {
          permissions: NO_PERMISSIONS,
          until_date: untilSec,
          use_independent_chat_permissions: true
        });
        muted = true;
        recentActions.set(key, untilSec * 1000);
      } catch (err) {
        muteError = err;
      }
    }
    if (!muted) recentActions.set(key, now() + FAILED_MUTE_QUIET_MS);
    pruneRecent();

    const reasons = verdict.reasons.slice(0, 4).join(', ');
    log(`[anti-jualan] ${muted ? 'mute' : 'hapus'} chat=${chat.id} pengirim=${actorId} skor=${verdict.score} alasan=${reasons}${muteError ? ` gagal-mute=${shortError(muteError)}` : ''}`);

    const who = channel
      ? `channel <b>${escapeHtml(channel.title || 'tanpa nama')}</b>`
      : `<a href="tg://user?id=${from.id}">${escapeHtml(displayName(from))}</a>`;
    const lines = ['<b>Dilarang jualan dan promosi di grup ini.</b>'];
    if (muted) {
      lines.push(`Pesan ${who} ${deleted ? 'dihapus' : 'terdeteksi jualan'} dan dia dimute ${durationText(muteMinutes)}.`);
    } else {
      lines.push(`Pesan ${who} ${deleted ? 'dihapus' : 'terdeteksi jualan, tapi bot tidak bisa menghapusnya'}.`);
    }
    lines.push(`Terdeteksi: ${escapeHtml(reasons)}.`);
    if (!channel && !muted && noticeAllowed(`rights:${chat.id}`, RIGHTS_NOTICE_MS)) {
      lines.push(chat.type === 'group'
        ? 'Mute hanya bisa di supergroup. Ubah grup ini jadi supergroup (misalnya aktifkan riwayat chat untuk anggota baru).'
        : 'Bot belum bisa mute. Jadikan bot admin dengan izin Hapus Pesan dan Blokir Pengguna.');
    }
    const keyboard = muted
      ? buildKeyboard([[{ text: 'Buka Mute', callback_data: `asb_unmute:${from.id}` }]])
      : {};
    await send(ctx, lines.join('\n'), { ...threadExtra(message), ...keyboard });
  }

  // Kembalikan true kalau update datang dari grup (sudah ditangani di sini dan
  // tidak boleh diteruskan ke menu jualan).
  async function handleUpdate(ctx) {
    if (!isGroupChat(ctx.chat)) return false;
    const update = ctx.update || {};
    if (update.my_chat_member) {
      await onBotMemberUpdate(ctx, update.my_chat_member);
      return true;
    }
    if (update.callback_query) {
      await onCallback(ctx, update.callback_query);
      return true;
    }
    const message = update.message || update.edited_message;
    if (!message) return true;
    const command = update.message ? parseGroupCommand(message.text, ctx.botInfo?.username) : null;
    if (command?.name === 'antijualan') {
      await onCommand(ctx, message, command.args);
      return true;
    }
    if (command && ['start', 'menu', 'admin'].includes(command.name)) {
      await notifyPrivateOnly(ctx, message);
      return true;
    }
    await checkMessage(ctx, message);
    return true;
  }

  return { handleUpdate, isEnabled, setEnabled };
}

module.exports = {
  SCORE_THRESHOLD,
  NO_PERMISSIONS,
  analyzeSalesText,
  collectMessageText,
  createAntiSalesGuard,
  isGroupChat,
  normalizeText,
  parseGroupCommand
};

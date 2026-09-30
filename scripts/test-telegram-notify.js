'use strict';

// Regresi notifikasi Telegram dari VPS (api.js & iplimit-checker.js hasil
// generate installer):
// - Susunan seragam: judul, garis tebal, isi, garis tebal, domain + waktu WIB.
// - Tanpa emoji dan tanpa format lama "SC 1FORCR NOTIF".
// - Tidak over sharing: akun dihapus tidak mengirim password, port OVPN/OHP
//   yang tidak dipasang SC ini tidak ditampilkan, link upgrade kembar tidak diulang.
// - Pesan di atas batas Telegram dipecah, tiap bagian <= 4096 karakter.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function heredoc(startLine) {
  const start = installer.indexOf(`${startLine}\n`);
  assert(start >= 0, `heredoc tidak ditemukan: ${startLine}`);
  const bodyStart = start + startLine.length + 1;
  return installer.slice(bodyStart, installer.indexOf('\nEOF\n', bodyStart) + 1);
}

function slice(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert(a >= 0 && b > a, `blok tidak ditemukan: ${startMarker}`);
  return src.slice(a, b);
}

function fn(src, name) {
  const m = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(src);
  assert(m, `fungsi ${name} tidak ditemukan`);
  const start = m.index + 1;
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
}

const api = heredoc('  cat > "${APP_DIR}/api.js" <<\'EOF\'');
const ipl = heredoc('  cat > "${APP_DIR}/iplimit-checker.js" <<\'EOF\'');

const sent = [];
const httpsStub = {
  request(_opts, onRes) {
    let body = '';
    return {
      on() {},
      setTimeout() {},
      write(chunk) { body += chunk; },
      end() {
        sent.push(decodeURIComponent(/(?:^|&)text=([^&]*)/.exec(body)[1]));
        onRes({ statusCode: 200, on: (ev, cb) => { if (ev === 'end') cb(); } });
      }
    };
  }
};

const common = `
  const DOMAIN = 'sg1.contoh.com';
  const XRAY_LINK_HOST = 'sg1.contoh.com';
  const TELEGRAM_BOT_TOKEN = 'token';
  const TELEGRAM_CHAT_ID = '111';
  const https = __https;
`;

const A = new Function('__https', [
  common,
  fn(api, 'sanitizeInfoText'),
  'async function getVpsLocationInfo() { return { city: "Singapore", isp: "DigitalOcean" }; }',
  'async function filterStillExpiredBatchForNotify(_s, list) { return list; }',
  slice(api, 'const TELEGRAM_TEXT_LIMIT', '\nfunction expiredNotifyTableForService'),
  fn(api, 'notifyDeletedExpiredAccountsBatch'),
  'return { notifyAccountEvent, notifyExpiredAccountsBatchEvent, notifyDeletedExpiredAccountsBatch, splitTelegramText, notifyTimeWib };'
].join('\n'))(httpsStub);

const I = new Function('__https', [
  common,
  'const LOCK_MINUTES = 15; const QUOTA_BYTES_PER_GB = 1024 ** 3;',
  'async function notifyAccountBotMultiLogin() { return false; }',
  'async function get() { return null; } async function run() {}',
  fn(ipl, 'telegramNotifyToResult'),
  fn(ipl, 'telegramNotifyTo'),
  slice(ipl, 'function telegramNotify(text) {', '\nfunction postJsonResult'),
  fn(ipl, 'buildMultiLoginMessage'),
  fn(ipl, 'bytesToGbText'),
  fn(ipl, 'notifyQuotaLock'),
  'return { buildMultiLoginMessage, notifyQuotaLock };'
].join('\n'))(httpsStub);

function ymdPlus(days) {
  const d = new Date(Date.now() + days * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 23:59:59`;
}

function take() {
  return sent.splice(0, sent.length);
}

const RULE = '━━━━━━━━━━━━━━━━━━━━━━';
const EMOJI = /\p{Extended_Pictographic}/u;

function assertLayout(text, title) {
  const lines = text.split('\n');
  assert.strictEqual(lines[0], title, `judul harus di baris pertama:\n${text}`);
  assert.strictEqual(lines[1], RULE, 'garis tebal setelah judul');
  assert.strictEqual(lines[lines.length - 2], 'SC 1FORCR • sg1.contoh.com', 'penutup berisi domain');
  assert(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2} WIB$/.test(lines[lines.length - 1]), 'penutup berisi waktu WIB');
  assert(!EMOJI.test(text), `notifikasi tidak boleh ber-emoji:\n${text}`);
  assert(text.length <= 4096, 'notifikasi harus muat satu pesan Telegram');
}

(async () => {
  assert(!/SC 1FORCR NOTIF|Event {4}:/.test(installer), 'format notifikasi lama masih ada di installer');
  assert.strictEqual(A.notifyTimeWib(Date.UTC(2026, 0, 31, 20, 5)), '01-02-2026 03:05 WIB', 'WIB = UTC+7');

  const owner = { ownerTelegramId: 5566778899, ownerTelegramChatId: 5566778899 };
  const link = (port) => `vmess://${Buffer.from(JSON.stringify({ add: 'sg1.contoh.com', port })).toString('base64')}`;

  await A.notifyAccountEvent('create', 'ssh/zivpn', {
    hostname: 'sg1.contoh.com', username: 'andi', password: 'x7Kp29qa', exp: ymdPlus(30), limitip: '2', quota: '0',
    port: { tls: '443', none: '80', ovpntcp: '1194', ovpnudp: '2200', sshohp: '8181', udpgw: '7300,7200' }
  }, owner);
  let [msg] = take();
  assertLayout(msg, 'AKUN SSH BARU');
  assert(msg.includes('Password : x7Kp29qa') && msg.includes('sg1.contoh.com:80@andi:x7Kp29qa'));
  // notifyExpiry membulatkan ke menit lalu floor ke hari, jadi akun "30 hari"
  // bisa terbaca 29-31 tergantung jam saat test jalan. Cukup pastikan sisa hari
  // yang wajar muncul, bukan angka persis.
  assert(msg.includes('Expired  : ') && /\((29|30|31) hari lagi\)/.test(msg), msg);
  assert(msg.includes('Quota    : Tanpa batas'), 'quota 0 berarti tanpa batas');
  assert(msg.includes('Pembeli  : ID 5566778899'));
  assert(!/1194|2200|8181|OVPN|OHP/.test(msg), 'port OVPN/OHP tidak dipasang SC ini, jangan tampil');

  await A.notifyAccountEvent('create', 'vmess', {
    username: 'budi', uuid: 'uuid-1', exp: ymdPlus(30), limitip: '0', quota: '100',
    port: { tls: '443', none: '80', grpc: '443' }, path: { ws: '/vmess', upgrade: '/upvmess' }, serviceName: 'vmess-grpc',
    link: { tls: link(443), none: link(80), grpc: link('grpc'), uptls: link(443), upntls: link(80) }
  }, {});
  [msg] = take();
  assertLayout(msg, 'AKUN VMESS BARU');
  assert.strictEqual(msg.split(link(443)).length - 1, 1, 'link upgrade yang sama dengan TLS tidak diulang');
  assert(msg.includes('Limit IP : Tanpa batas'));
  assert(!msg.includes('Pembeli'), 'akun tanpa pembeli tidak menampilkan baris Pembeli');
  assert(!msg.includes('XHTTP') && !msg.includes('OneRing'), 'link opsional yang tidak dikirim API tidak tampil');

  // Link httpupgrade asli (beda dari WS), XHTTP, dan OneRing ikut tampil.
  const vlink = (tag) => `vless://uuid-2@sg1.contoh.com:443?type=${tag}#citra`;
  await A.notifyAccountEvent('create', 'vless', {
    username: 'citra', uuid: 'uuid-2', exp: ymdPlus(30), limitip: '1', quota: '50',
    port: { tls: '443', none: '80', grpc: '443' }, path: { ws: '/vless', upgrade: '/upvless', xhttp: '/xhvless' }, serviceName: 'vless-grpc',
    link: {
      tls: vlink('ws'), none: vlink('ws-ntls'), grpc: vlink('grpc'), uptls: vlink('httpupgrade'), upntls: vlink('httpupgrade-ntls'),
      xhttptls: vlink('xhttp'), xhttpntls: vlink('xhttp-ntls'), onering: vlink('onering')
    }
  }, owner);
  [msg] = take();
  assertLayout(msg, 'AKUN VLESS BARU');
  for (const [label, value] of [
    ['Upgrade TLS', 'httpupgrade'], ['Upgrade Non-TLS', 'httpupgrade-ntls'],
    ['XHTTP TLS', 'xhttp'], ['XHTTP Non-TLS', 'xhttp-ntls'], ['OneRing (1FTunnel)', 'onering']
  ]) {
    assert(msg.includes(`${label}:\n${vlink(value)}`), `link ${label} harus tampil:\n${msg}`);
  }
  assert(msg.includes('XHTTP    : /xhvless'), 'path XHTTP tampil di bagian koneksi');

  await A.notifyAccountEvent('delete', 'trojan', { username: 'citra', password: 'rahasia-jangan-tampil', exp: ymdPlus(5) }, owner);
  [msg] = take();
  assertLayout(msg, 'AKUN DIHAPUS');
  assert(!msg.includes('rahasia-jangan-tampil'), 'akun yang dihapus tidak boleh mengirim password');

  await A.notifyAccountEvent('renew', 'ssh/zivpn', {
    username: 'andi', from: ymdPlus(1), to: ymdPlus(31), quota: '10', quota_added: '5', status: 'LOCK_QUOTA', limitip: '2', added_days: 30
  }, owner);
  [msg] = take();
  assertLayout(msg, 'AKUN DIPERPANJANG');
  assert(msg.includes('Tambah   : 30 hari') && msg.includes('Quota    : 10 GB (+5 GB)'));
  assert(msg.includes('Status   : Terkunci (quota habis)'), 'status mentah LOCK_QUOTA harus diterjemahkan');

  await A.notifyExpiredAccountsBatchEvent('vless', Array.from({ length: 35 }, (_, i) => ({ username: `u${i}`, date_exp: ymdPlus(-1) })));
  [msg] = take();
  assertLayout(msg, 'AKUN EXPIRED (35)');
  assert(msg.includes('30. u29') && msg.includes('+5 akun lainnya') && !msg.includes('31. u30'));

  await A.notifyDeletedExpiredAccountsBatch({ ssh: [{ username: 'lama1' }], vmess: [], vless: [], trojan: [] });
  [msg] = take();
  assertLayout(msg, 'AKUN EXPIRED DIHAPUS (1)');
  assert(msg.includes('SSH      : 1 akun') && !msg.includes('VMESS'), 'protokol kosong tidak ditampilkan');

  msg = I.buildMultiLoginMessage({
    service: 'VMESS', username: 'budi', limitip: 2, detected: 3, ips: ['1.2.3.0/24'], unlock_minutes: 15, owner_telegram_id: 5566778899
  });
  assertLayout(msg, 'AKUN DIKUNCI: MULTI LOGIN');
  assert(msg.includes('Deteksi  : 3 jaringan') && msg.includes('otomatis 15 menit lagi') && msg.includes('1. 1.2.3.0/24'));

  await I.notifyQuotaLock('ssh', 'andi', 10 * 1024 ** 3, 10.5 * 1024 ** 3, 5566778899, 5566778899);
  const [adminMsg, ownerMsg] = take();
  assertLayout(adminMsg, 'AKUN DIKUNCI: QUOTA HABIS');
  assertLayout(ownerMsg, 'QUOTA AKUN HABIS');
  assert(adminMsg.includes('Pembeli') && !ownerMsg.includes('Pembeli'), 'pesan ke pemilik akun tanpa ID Telegram');

  const chunks = A.splitTelegramText(Array.from({ length: 400 }, (_, i) => `${i + 1}. user${i} • 2026-09-26`).join('\n'));
  assert(chunks.length >= 2 && chunks.every((c) => c.length <= 4096), 'pesan panjang harus dipecah');

  console.log('telegram notify tests: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

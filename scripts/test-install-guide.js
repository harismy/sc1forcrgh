'use strict';

// Pesan panduan install yang dikirim bot ke pembeli. Pembeli pemula harus bisa
// mengikutinya dari atas ke bawah tanpa menebak: syarat dulu, lalu satu langkah
// satu perintah yang bisa disalin utuh, dan tidak ada link yang terlihat seperti
// harus dibuka padahal bukan.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const bot = fs.readFileSync(path.join(repoRoot, 'app3.js'), 'utf8').replace(/\r\n/g, '\n');

const start = bot.indexOf('function escapeHtml(input) {');
const end = bot.indexOf('\nasync function buildBotScriptUrls() {');
assert(start > 0 && end > start, 'fungsi pesan installer tidak ditemukan di app3.js');
const source = `${bot.slice(start, end)}\nglobalThis.__build = buildInstallerQuickCopyText;\n`;

async function build(domains, options) {
  const context = vm.createContext({
    listActiveApiDomains: async () => domains,
    formatDateYmd: (value) => `TGL-${value}`
  });
  new vm.Script(source, { filename: 'app3-install-guide.js' }).runInContext(context);
  return context.__build(options);
}

const DOMAINS = ['installer.contoh.com', 'cadangan.contoh.net'];
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Perintah harus berupa blok kode Telegram (<pre>): tampil sebagai kotak dengan
// tombol salin. Teks monospace di dalam kalimat (<code> saja) tidak cukup jelas
// untuk pemula.
const BLOCK = /<pre><code class="language-bash">([^<]*)<\/code><\/pre>/g;
const codeBlocks = (text) => [...text.matchAll(BLOCK)].map((m) => unescape(m[1]));

function assertGuide(message, label) {
  assert.strictEqual(message.ok, true, label);
  assert.strictEqual(message.parse_mode, 'HTML');
  const text = message.text;
  assert(text.length < 4096, `${label}: pesan melebihi batas Telegram (${text.length})`);

  // Urutan yang dibaca pemula: syarat, lalu langkah 1 sampai 4, lalu pemulihan.
  const order = ['<b>SEBELUM MULAI</b>', '<b>CARA INSTALL</b>', '<b>Langkah 1</b>', '<b>Langkah 2</b>', '<b>Langkah 3</b>', '<b>Langkah 4</b>', '<b>KALAU KONEKSI TERPUTUS</b>'];
  let at = -1;
  for (const marker of order) {
    const next = text.indexOf(marker);
    assert(next > at, `${label}: "${marker}" tidak ada atau urutannya salah`);
    assert.strictEqual(text.indexOf(marker, next + 1), -1, `${label}: "${marker}" muncul dua kali`);
    at = next;
  }
  for (const phrase of ['IP VPS sudah didaftarkan', 'Debian 12 ke atas atau Ubuntu 20.04 ke atas', 'Domain sudah diarahkan (A record)', 'sebagai <b>root</b>',
    'salin isi kotaknya', 'Salin seluruh isi kotaknya, jangan dipotong.', 'INSTALL SELESAI']) {
    assert(text.includes(phrase), `${label}: keterangan hilang: ${phrase}`);
  }

  // Satu langkah = satu perintah yang bisa disalin utuh.
  const codes = codeBlocks(text);
  assert.strictEqual(codes.length, 5, `${label}: harus ada tepat lima perintah`);
  assert.strictEqual(codes[0], 'apt update');
  assert.strictEqual(codes[1], 'apt install --no-upgrade curl wget screen ca-certificates -y');
  const installCmd = codes[2];
  assert(installCmd.startsWith('rm -f /root/nexus-installer.sh; for u in '), `${label}: perintah installer berubah bentuk`);
  for (const domain of DOMAINS) assert(installCmd.includes(`'https://${domain}/i'`), `${label}: domain ${domain} tidak ada di perintah`);
  assert(installCmd.endsWith('screen -S 1forcr-sc /root/nexus-installer.sh'));
  assert.deepStrictEqual(codes.slice(3), ['screen -r 1forcr-sc', 'screen -d -r 1forcr-sc']);
  // Setiap blok berdiri di barisnya sendiri, dan tidak ada perintah yang
  // tertinggal sebagai teks monospace di luar blok.
  for (const line of text.split('\n').filter((l) => l.includes('<pre>') || l.includes('<code'))) {
    assert(/^<pre><code class="language-bash">[^<]*<\/code><\/pre>$/.test(line), `${label}: perintah harus berupa satu blok di barisnya sendiri:\n${line}`);
  }
  assert.strictEqual((text.match(/<code/g) || []).length, 5, `${label}: semua perintah harus di dalam blok`);

  // Link installer hanya boleh ada di dalam perintah langkah 3. Di luar itu
  // pembeli mengira link tersebut harus dibuka.
  const outsideCode = text.replace(BLOCK, '');
  assert(!/https?:\/\//.test(outsideCode), `${label}: ada link di luar perintah`);
  assert(!/Installer URL|\[\d\/\d\]|INSTALLATION|SESSION RECOVERY/.test(text), `${label}: format lama masih tersisa`);
  return { text, installCmd };
}

(async () => {
  const general = assertGuide(await build(DOMAINS, { general: true }), 'pesan umum');
  assert(general.text.includes('PANDUAN INSTALL SC'));
  assert(!general.installCmd.includes('INSTALL_AUTH_TOKEN'), 'pesan umum tidak membawa key');

  const KEY = 'kunci-vps-0123456789';
  const perVps = assertGuide(await build(DOMAINS, { serverKey: KEY, clientName: 'Toko <Budi>', ip: '203.0.113.10', expiresAt: 7 }), 'pesan per VPS');
  assert(perVps.text.includes('LICENSE STATUS') && perVps.text.includes('VPS Address   : 203.0.113.10'));
  assert(perVps.text.includes('Client        : Toko &lt;Budi&gt;'), 'nama klien harus di-escape');
  assert(perVps.text.includes('Valid Until   : TGL-7'));
  assert(perVps.installCmd.includes(`INSTALL_AUTH_TOKEN='${KEY}' API_AUTH_TOKEN='${KEY}' AUTH_TOKEN='${KEY}' screen -S 1forcr-sc`),
    'key VPS harus ikut di perintah install');
  // Profil server tampil sebelum panduan, supaya pembeli bisa mengecek datanya dulu.
  assert(perVps.text.indexOf('SERVER PROFILE') < perVps.text.indexOf('<b>SEBELUM MULAI</b>'));

  const none = await build([], { general: true });
  assert.strictEqual(none.ok, false, 'tanpa domain installer, pesan panduan tidak dibuat');

  console.log('install guide tests: OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

'use strict';

// Regresi tampilan tombol bot:
// - app3.js tidak memakai emoji (label tombol maupun teks menu).
// - Menu utama satu warna per baris: layanan SC & saldo hijau, alat lain biru,
//   hapus merah.
// - Warna tombol lain hanya dari label: navigasi/batal tanpa warna, hapus &
//   mematikan merah, konfirmasi & pembayaran hijau, sisanya biru.
// Fungsi diambil langsung dari app3.js dengan Markup tiruan.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'app3.js'), 'utf8').replace(/\r\n/g, '\n');

function extractFunction(name) {
  const match = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(source);
  assert(match, `function ${name} not found in app3.js`);
  const start = match.index + 1;
  const end = source.indexOf('\n}\n', start);
  assert(end > start, `end of function ${name} not found`);
  return source.slice(start, end + 2);
}

function extractDeclaration(name) {
  const match = new RegExp(`\\n((?:const|let) ${name} = [^\\n]*;)\\n`).exec(source);
  assert(match, `declaration ${name} not found in app3.js`);
  return match[1];
}

const MENU_FUNCTIONS = ['mainMenu', 'adminMenu', 'adminServerMigrationMenu', 'scRenewPayMethodKeyboard'];

function loadMenus(styleEnabled) {
  const code = [
    `const TELEGRAM_BUTTON_STYLE_ENABLE = ${styleEnabled ? 'true' : 'false'};`,
    extractDeclaration('TELEGRAM_BUTTON_STYLES'),
    `const Markup = {
      button: {
        callback: (text, callback_data) => ({ text, callback_data, hide: false }),
        url: (text, url) => ({ text, url, hide: false })
      }
    };`,
    ...['inferTelegramButtonStyle', 'withTelegramButtonStyle', 'styleTelegramInlineKeyboardRows', 'styleTelegramMarkup', 'coloredButton']
      .map(extractFunction),
    ...MENU_FUNCTIONS.map(extractFunction),
    'Markup.inlineKeyboard = (rows) => styleTelegramMarkup({ reply_markup: { inline_keyboard: rows } });',
    `return { inferTelegramButtonStyle, ${MENU_FUNCTIONS.join(', ')} };`
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

function rowsOf(markup) {
  return markup.reply_markup.inline_keyboard;
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;

// Tanpa emoji di seluruh app3.js.
const emojiLines = source.split('\n')
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => EMOJI_RE.test(line));
assert.deepStrictEqual(
  emojiLines.map(({ number, line }) => `${number}: ${line.trim()}`),
  [],
  'app3.js tidak boleh memakai emoji'
);

const menus = loadMenus(true);

// Menu utama: satu warna per baris.
const mainRows = rowsOf(menus.mainMenu());
assert.deepStrictEqual(
  mainRows.map((row) => row.map((button) => button.style || '')),
  [
    ['success', 'success'],
    ['success', 'success'],
    ['success', 'success'],
    ['primary', 'primary'],
    ['primary', 'danger'],
    ['primary', 'primary'],
    ['primary', 'primary'],
    ['primary']
  ],
  'warna menu utama harus rapi per baris'
);
assert.strictEqual(mainRows[4][1].text, 'Hapus Semua Akun', 'tombol merah menu utama hanya Hapus Semua Akun');

// Menu admin: biru, merah hanya untuk hapus/nonaktifkan, Kembali tanpa warna.
const adminButtons = rowsOf(menus.adminMenu()).flat();
assert.deepStrictEqual(
  adminButtons.filter((button) => button.style === 'danger').map((button) => button.text),
  ['Nonaktifkan Reseller', 'Hapus IP VPS', 'Hapus Domain']
);
assert.deepStrictEqual(adminButtons.filter((button) => !button.style).map((button) => button.text), ['Kembali']);
assert(!adminButtons.some((button) => button.style === 'success'), 'menu admin tidak memakai hijau');

for (const name of MENU_FUNCTIONS) {
  for (const button of rowsOf(menus[name]()).flat()) {
    assert(!EMOJI_RE.test(button.text), `${name}: label "${button.text}" tidak boleh ber-emoji`);
  }
}

// Aturan label untuk tombol di luar menu utama.
const expected = {
  Kembali: '',
  Batal: '',
  Batalkan: '',
  Prev: '',
  Next: '',
  Refresh: '',
  'Pilih Periode': '',
  'Ganti Target': '',
  'Ya, Hapus': 'danger',
  'Ya, Batalkan': 'danger',
  'Ya, rollback migrasi': 'danger',
  'Ya, Bekukan Sekarang': 'danger',
  'Batalkan Campaign': 'danger',
  'Gajadi Migrasi (Rollback)': 'danger',
  'Bekukan Bot di Server Ini': 'danger',
  'Ya, Migrasi': 'success',
  'Ya, Restore Sekarang': 'success',
  'Ya, Update IP Ini': 'success',
  'Bayar pakai Saldo': 'success',
  'Bayar pakai QRIS': 'success',
  'Cek Status': 'success',
  'Jalankan Sekarang': 'success',
  'Hubungi Admin WA': 'success',
  'Cek Status God Mode': 'primary',
  'Set Minimal TopUp': 'primary',
  'Histori TopUp': 'primary',
  'Unlock Akses VPS': 'primary',
  'Tuntaskan Sekarang': 'primary',
  VMESS: 'primary'
};
for (const [text, style] of Object.entries(expected)) {
  assert.strictEqual(menus.inferTelegramButtonStyle({ text, callback_data: 'x' }), style, `warna "${text}"`);
}
assert.strictEqual(
  menus.inferTelegramButtonStyle({ text: 'Batal', callback_data: 'm_delall_confirm_no' }),
  '',
  'warna tidak boleh ditebak dari callback_data'
);

// Style dimatikan lewat TELEGRAM_BUTTON_STYLE_ENABLE=0: warna eksplisit juga hilang.
const plain = loadMenus(false);
assert(
  rowsOf(plain.mainMenu()).flat().every((button) => !('style' in button)),
  'tanpa style, menu utama tidak boleh membawa warna'
);

console.log('button style tests: OK');

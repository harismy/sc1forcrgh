'use strict';

// Regresi laporan pendapatan admin app3.js (lib/revenue-report.js):
// - Uang masuk hanya dari top up QRIS yang lunas (type deposit), penjualan
//   hanya dari SC yang dibayar pembeli (amount negatif). Saldo dari admin dan
//   SC gratis admin tidak dihitung.
// - Batas hari dan bulan dalam WIB, bukan zona waktu server.
// - Menu admin punya tombol dan handler laporan, hanya untuk admin.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let DatabaseSync = null;
const originalEmitWarning = process.emitWarning;
process.emitWarning = function quietSqliteWarning(warning, ...args) {
  if (/SQLite is an experimental feature/i.test(String(warning?.message || warning))) return undefined;
  return originalEmitWarning.call(process, warning, ...args);
};
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  console.log('revenue report tests: SKIP (node:sqlite tidak tersedia, butuh Node >= 22.5)');
  process.exit(0);
} finally {
  process.emitWarning = originalEmitWarning;
}

const repoRoot = path.resolve(__dirname, '..');
const report = require(path.join(repoRoot, 'lib', 'revenue-report.js'));
const app = fs.readFileSync(path.join(repoRoot, 'app3.js'), 'utf8');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount INTEGER, type TEXT, reference_id TEXT, timestamp INTEGER)`);
const dbAll = async (sql, params = []) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
const add = (amount, type, ts) => db.prepare('INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (1, ?, ?, ?, ?)').run(amount, type, `r${ts}${type}`, ts);
// Waktu WIB -> epoch ms.
const wib = (s) => Date.parse(`${s}+07:00`);

(async () => {
  const now = wib('2026-10-29T15:00:00');
  assert.strictEqual(report.wibDayStart(now), wib('2026-10-29T00:00:00'));
  assert.strictEqual(report.wibMonthStart(now), wib('2026-10-01T00:00:00'));
  assert.strictEqual(report.wibMonthStart(now, -1), wib('2026-09-01T00:00:00'));
  assert.strictEqual(report.wibMonthStart(wib('2026-01-15T10:00:00'), -1), wib('2025-12-01T00:00:00'), 'mundur lintas tahun');

  // Hari ini
  add(50000, 'deposit', wib('2026-10-29T08:00:00'));
  add(-30000, 'sc_registration', wib('2026-10-29T08:05:00'));
  add(-15000, 'sc_renewal', wib('2026-10-29T09:00:00'));
  // Tepat setelah tengah malam WIB (masih 28 Okt di UTC): tetap hari ini.
  add(20000, 'deposit', wib('2026-10-29T00:30:00'));
  // Kemarin, tepat sebelum tengah malam WIB.
  add(10000, 'deposit', wib('2026-10-28T23:59:00'));
  add(-100000, 'sc_registration_unlimited', wib('2026-10-28T12:00:00'));
  // Bukan pendapatan
  add(500000, 'admin_credit', wib('2026-10-29T10:00:00'));
  add(5000, 'admin_credit_all', wib('2026-10-29T10:00:00'));
  add(0, 'sc_registration_unlimited_admin', wib('2026-10-29T10:00:00'));
  add(0, 'admin_remove_sc_ip', wib('2026-10-29T10:00:00'));
  // Awal bulan dan bulan lalu
  add(25000, 'deposit', wib('2026-10-01T00:00:00'));
  add(40000, 'deposit', wib('2026-09-30T23:59:59'));
  add(-20000, 'sc_renewal', wib('2026-09-15T12:00:00'));
  // Tahun lalu (di luar 12 bulan)
  add(999000, 'deposit', wib('2025-09-15T12:00:00'));

  const today = await report.sumRange(dbAll, report.wibDayStart(now), report.wibDayStart(now) + 86400000);
  assert.deepStrictEqual(today, { masuk: 70000, masuk_n: 2, jual: 45000, jual_n: 2 }, 'hari ini: saldo admin dan SC gratis tidak dihitung');

  const summary = await report.buildSummary(dbAll, now);
  const s = report.render(summary);
  assert(/^┏━+┓\n┃ LAPORAN PENDAPATAN\n┣━+┫\n/.test(s) && /\n┗━+┛$/.test(s), `bingkai laporan:\n${s}`);
  assert(!s.includes('\u0000'), 'penanda cabang tidak boleh ikut terkirim');
  assert(/• Hari ini \(29 Okt 2026\)\n   ├ Uang masuk : Rp 70\.000 \(2 top up\)\n   ╰ Penjualan  : Rp 45\.000 \(2 transaksi\)/.test(s), s);
  assert(/• Kemarin \(28 Okt 2026\)\n   ├ Uang masuk : Rp 10\.000 \(1 top up\)\n   ╰ Penjualan  : Rp 100\.000 \(1 transaksi\)/.test(s), s);
  assert(/• Bulan ini \(Oktober 2026\)\n   ├ Uang masuk : Rp 105\.000 \(4 top up\)\n   ├ Penjualan  : Rp 145\.000 \(3 transaksi\)\n   ╰ Rata-rata  : Rp 3\.621 uang masuk per hari/.test(s), s);
  assert(/• Bulan lalu \(September 2026\)\n   ├ Uang masuk : Rp 40\.000 \(1 top up\)\n   ╰ Penjualan  : Rp 20\.000 \(1 transaksi\)/.test(s), s);

  const daily = await report.buildDaily(dbAll, now, 0);
  const d = report.render(daily);
  assert.strictEqual(daily.title, 'PENDAPATAN PER HARI - OKTOBER 2026');
  assert(/• Total Oktober 2026:\n   ├ Uang masuk : Rp 105\.000/.test(d), d);
  assert(d.includes('29 Okt: masuk Rp 70.000 | jual Rp 45.000'), d);
  assert(d.includes('28 Okt: masuk Rp 10.000 | jual Rp 100.000'), d);
  assert(d.includes('01 Okt: masuk Rp 25.000 | jual Rp 0'), d);
  assert(d.includes('15 Okt: -'), 'hari kosong ditandai -');
  assert(!d.includes('30 Okt'), 'hari yang belum lewat tidak ditampilkan');
  assert(d.indexOf('29 Okt') < d.indexOf('01 Okt'), 'hari terbaru di atas');

  const lastMonth = await report.buildDaily(dbAll, now, -1);
  const lm = report.render(lastMonth);
  assert.strictEqual(lastMonth.title, 'PENDAPATAN PER HARI - SEPTEMBER 2026');
  assert(lm.includes('• Total September 2026:\n   ├ Uang masuk : Rp 40.000'), lm);
  assert(lm.includes('30 Sep: masuk Rp 40.000 | jual Rp 0') && lm.includes('15 Sep: masuk Rp 0 | jual Rp 20.000'), lm);
  assert.strictEqual((lm.match(/ Sep: /g) || []).length, 30, 'September 30 hari penuh');

  const monthly = await report.buildMonthly(dbAll, now, 12);
  const m = report.render(monthly);
  assert(m.includes('Okt 2026: masuk Rp 105.000 | jual Rp 145.000'), m);
  assert(m.includes('Sep 2026: masuk Rp 40.000 | jual Rp 20.000'), m);
  assert(m.includes('Nov 2025: -') && !m.includes('Sep 2025'), '12 bulan: Nov 2025 sampai Okt 2026');
  assert(/• Total 12 bulan:\n   ├ Uang masuk : Rp 145\.000 \(5 top up\)/.test(m), m);

  // Integrasi app3.js: tombol, handler khusus admin, dan index waktu.
  assert(app.includes("require('./lib/revenue-report')"), 'app3.js memuat lib/revenue-report');
  assert(app.includes("Markup.button.callback('Laporan Pendapatan', 'm_admin_revenue')"), 'menu admin punya tombol Laporan Pendapatan');
  for (const action of ["bot.action('m_admin_revenue',", 'bot.action(/^m_admin_revenue_day_([01])$/,', "bot.action('m_admin_revenue_month',"]) {
    assert(app.includes(action), `handler ${action} ada`);
  }
  const helper = app.slice(app.indexOf('async function replyRevenueReport'), app.indexOf("bot.action('m_admin_revenue',"));
  assert(/if \(!isAdmin\(ctx\.from\.id\)\) return ctx\.reply\('Akses ditolak/.test(helper), 'laporan pendapatan hanya untuk admin');
  assert(app.includes('CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(timestamp)'), 'index waktu transaksi dibuat');
  for (const t of report.SALE_TYPES) assert(app.includes(`'${t}'`), `jenis penjualan ${t} memang dipakai app3.js`);

  console.log('revenue report tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

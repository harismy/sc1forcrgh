'use strict';

// Laporan pendapatan bot untuk menu admin (per hari dan per bulan).
// Sumbernya tabel transactions, jadi angka sama dengan saldo yang benar-benar
// berubah:
// - Uang masuk : type 'deposit', yaitu top up QRIS yang lunas (termasuk QRIS
//                perpanjang SC langsung), dicatat saat saldo dikredit. Nominal
//                yang dihitung adalah nominal top up, tanpa fee unik QRIS.
// - Penjualan  : SC baru, perpanjang SC, dan SC unlimited yang dibayar pembeli
//                (amount negatif = saldo terpotong). Pemberian gratis admin
//                (amount 0, sc_registration_unlimited_admin) tidak dihitung.
// Hari dan bulan dihitung dalam WIB, bukan zona waktu server.

const WIB_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const SALE_TYPES = ['sc_registration', 'sc_renewal', 'sc_registration_unlimited'];
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

const SALE_LIST = SALE_TYPES.map((t) => `'${t}'`).join(', ');
const SUM_COLUMNS = `
  COALESCE(SUM(CASE WHEN type = 'deposit' AND amount > 0 THEN amount ELSE 0 END), 0) AS masuk,
  COALESCE(SUM(CASE WHEN type = 'deposit' AND amount > 0 THEN 1 ELSE 0 END), 0) AS masuk_n,
  COALESCE(SUM(CASE WHEN type IN (${SALE_LIST}) AND amount < 0 THEN -amount ELSE 0 END), 0) AS jual,
  COALESCE(SUM(CASE WHEN type IN (${SALE_LIST}) AND amount < 0 THEN 1 ELSE 0 END), 0) AS jual_n`;
const TYPE_FILTER = `type IN ('deposit', ${SALE_LIST})`;
// Kunci hari/bulan WIB dari timestamp milidetik.
const WIB_SECONDS = `(timestamp + ${WIB_OFFSET_MS}) / 1000`;

function wibParts(ms) {
  const d = new Date(Number(ms) + WIB_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

function wibDayStart(ms) {
  const p = wibParts(ms);
  return Date.UTC(p.y, p.m, p.d) - WIB_OFFSET_MS;
}

function wibMonthStart(ms, addMonths = 0) {
  const p = wibParts(ms);
  return Date.UTC(p.y, p.m + addMonths, 1) - WIB_OFFSET_MS;
}

function rupiah(n) {
  return `Rp ${Math.trunc(Number(n) || 0).toLocaleString('id-ID')}`;
}

function dayLabel(ms) {
  const p = wibParts(ms);
  return `${String(p.d).padStart(2, '0')} ${MONTHS_SHORT[p.m]} ${p.y}`;
}

function monthLabel(ms) {
  const p = wibParts(ms);
  return `${MONTHS[p.m]} ${p.y}`;
}

function emptyTotals() {
  return { masuk: 0, masuk_n: 0, jual: 0, jual_n: 0 };
}

function normTotals(row) {
  const out = emptyTotals();
  for (const k of Object.keys(out)) out[k] = Number(row && row[k]) || 0;
  return out;
}

async function sumRange(dbAll, start, end) {
  const rows = await dbAll(
    `SELECT ${SUM_COLUMNS} FROM transactions WHERE timestamp >= ? AND timestamp < ? AND ${TYPE_FILTER}`,
    [start, end]
  );
  return normTotals(rows && rows[0]);
}

async function groupRange(dbAll, start, end, unit) {
  const fmt = unit === 'month' ? '%Y-%m' : '%Y-%m-%d';
  const rows = await dbAll(
    `SELECT strftime('${fmt}', ${WIB_SECONDS}, 'unixepoch') AS k, ${SUM_COLUMNS}
     FROM transactions
     WHERE timestamp >= ? AND timestamp < ? AND ${TYPE_FILTER}
     GROUP BY k`,
    [start, end]
  );
  const map = new Map();
  for (const r of rows || []) map.set(String(r.k), normTotals(r));
  return map;
}

function keyOf(ms, unit) {
  const p = wibParts(ms);
  const mm = String(p.m + 1).padStart(2, '0');
  return unit === 'month' ? `${p.y}-${mm}` : `${p.y}-${mm}-${String(p.d).padStart(2, '0')}`;
}

function addTotals(a, b) {
  return { masuk: a.masuk + b.masuk, masuk_n: a.masuk_n + b.masuk_n, jual: a.jual + b.jual, jual_n: a.jual_n + b.jual_n };
}

// Baris yang diawali SUB digambar sebagai cabang dari judul di atasnya.
const SUB = '\u0000';

function totalsLines(t, extra) {
  const rows = [
    `Uang masuk : ${rupiah(t.masuk)} (${t.masuk_n} top up)`,
    `Penjualan  : ${rupiah(t.jual)} (${t.jual_n} transaksi)`
  ];
  if (extra) rows.push(extra);
  return rows.map((row) => `${SUB}${row}`);
}

function rowLine(label, t) {
  if (!t.masuk_n && !t.jual_n) return `${label}: -`;
  return `${label}: masuk ${rupiah(t.masuk)} | jual ${rupiah(t.jual)}`;
}

const NOTE = [
  'Uang masuk = top up QRIS yang lunas (termasuk QRIS perpanjang SC).',
  'Penjualan = SC baru, perpanjang, dan unlimited yang dibayar pembeli.',
  'Waktu dalam WIB.'
];

async function buildSummary(dbAll, now = Date.now()) {
  const today = wibDayStart(now);
  const tomorrow = today + DAY_MS;
  const month = wibMonthStart(now);
  const prevMonth = wibMonthStart(now, -1);
  const [t, y, m, pm] = await Promise.all([
    sumRange(dbAll, today, tomorrow),
    sumRange(dbAll, today - DAY_MS, today),
    sumRange(dbAll, month, tomorrow),
    sumRange(dbAll, prevMonth, month)
  ]);
  const daysSoFar = Math.max(1, Math.round((tomorrow - month) / DAY_MS));
  return {
    title: 'LAPORAN PENDAPATAN',
    lines: [
      `Hari ini (${dayLabel(today)})`,
      ...totalsLines(t),
      `Kemarin (${dayLabel(today - DAY_MS)})`,
      ...totalsLines(y),
      `Bulan ini (${monthLabel(month)})`,
      ...totalsLines(m, `Rata-rata  : ${rupiah(Math.round(m.masuk / daysSoFar))} uang masuk per hari`),
      `Bulan lalu (${monthLabel(prevMonth)})`,
      ...totalsLines(pm),
      '',
      ...NOTE
    ]
  };
}

// Per hari untuk satu bulan WIB (offset 0 = bulan ini, -1 = bulan lalu).
async function buildDaily(dbAll, now = Date.now(), monthOffset = 0) {
  const start = wibMonthStart(now, monthOffset);
  const monthEnd = wibMonthStart(now, monthOffset + 1);
  const end = Math.min(monthEnd, wibDayStart(now) + DAY_MS);
  const map = await groupRange(dbAll, start, end, 'day');
  const lines = [];
  let total = emptyTotals();
  for (let day = end - DAY_MS; day >= start; day -= DAY_MS) {
    const t = map.get(keyOf(day, 'day')) || emptyTotals();
    total = addTotals(total, t);
    lines.push(rowLine(dayLabel(day).slice(0, 6), t));
  }
  return {
    title: `PENDAPATAN PER HARI - ${monthLabel(start).toUpperCase()}`,
    lines: [
      `Total ${monthLabel(start)}:`,
      ...totalsLines(total),
      '',
      ...(lines.length ? lines : ['(belum ada data)']),
      '',
      ...NOTE
    ]
  };
}

// Per bulan untuk N bulan terakhir (termasuk bulan ini).
async function buildMonthly(dbAll, now = Date.now(), months = 12) {
  const count = Math.max(1, Math.min(24, Number(months) || 12));
  const start = wibMonthStart(now, -(count - 1));
  const end = wibDayStart(now) + DAY_MS;
  const map = await groupRange(dbAll, start, end, 'month');
  const lines = [];
  let total = emptyTotals();
  for (let i = 0; i < count; i += 1) {
    const monthStart = wibMonthStart(now, -i);
    const t = map.get(keyOf(monthStart, 'month')) || emptyTotals();
    total = addTotals(total, t);
    const p = wibParts(monthStart);
    lines.push(rowLine(`${MONTHS_SHORT[p.m]} ${p.y}`, t));
  }
  return {
    title: `PENDAPATAN PER BULAN (${count} BULAN)`,
    lines: [
      `Total ${count} bulan:`,
      ...totalsLines(total),
      '',
      ...lines,
      '',
      ...NOTE
    ]
  };
}

// Bingkai sama dengan uiBox() di app3.js: judul, garis, lalu baris berbutir.
// Baris cabang (dari totalsLines) memakai ├ dan ╰ supaya terbaca bertingkat.
function render(report) {
  const lines = report.lines || [];
  const out = ['┏━━━━━━━━━━━━━━━━━━━━━━┓', `┃ ${report.title}`, '┣━━━━━━━━━━━━━━━━━━━━━━┫'];
  lines.forEach((line, i) => {
    if (line.startsWith(SUB)) {
      const last = !(lines[i + 1] || '').startsWith(SUB);
      out.push(`   ${last ? '╰' : '├'} ${line.slice(SUB.length)}`);
    } else {
      out.push(line.trim() ? `• ${line}` : '');
    }
  });
  out.push('┗━━━━━━━━━━━━━━━━━━━━━━┛');
  return out.join('\n');
}

module.exports = {
  render,
  SALE_TYPES,
  wibDayStart,
  wibMonthStart,
  sumRange,
  buildSummary,
  buildDaily,
  buildMonthly
};

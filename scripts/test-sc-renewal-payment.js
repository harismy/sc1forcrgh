'use strict';

// Regresi bayar perpanjang SC pakai saldo atau QRIS:
// - QRIS lunas: dana masuk saldo lalu langsung dipakai perpanjang, satu transaksi.
// - Perpanjangan ditolak (IP aktif di owner lain): dana tetap di saldo.
// - Diproses tepat sekali walau poller, "Cek Status", dan "Batalkan" bersamaan.
// - Transaksi paralel diantrekan, tidak gagal "cannot start a transaction".
// Fungsi diambil langsung dari app3.js lalu dijalankan di SQLite in-memory.

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
  console.log('sc renewal payment tests: SKIP (node:sqlite tidak tersedia, butuh Node >= 22.5)');
  process.exit(0);
} finally {
  process.emitWarning = originalEmitWarning;
}

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

function extractBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end > start, `end marker not found after: ${startMarker}`);
  return source.slice(start, end);
}

// Alur UI: durasi tidak lagi langsung memotong saldo, tapi menawarkan pilihan.
const daysStep = extractBlock("if (state.step === 'extend_sc_days') {", "if (state.step === 'extend_sc_paying') {");
assert(!daysStep.includes('extendScRegistration('), 'input durasi tidak boleh langsung memotong saldo');
assert(daysStep.includes('scRenewPayMethodKeyboard()'), 'input durasi harus menampilkan pilihan metode bayar');
for (const action of ['m_extend_pay_saldo', 'm_extend_pay_qris']) {
  const handler = extractBlock(`bot.action('${action}', async (ctx) => {\n`, '\n});\n');
  const firstLine = handler.split('\n')[1].trim();
  assert.strictEqual(firstLine, 'const state = claimScRenewPayState(ctx);',
    `${action} harus mengklaim sesi sebelum await pertama (anti tap ganda)`);
}

const TX_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

// Adapter API callback sqlite3 di atas node:sqlite. Callback ditunda seperti
// driver asli (query jalan di thread lain) supaya alur paralel saling menyela.
function createDb() {
  const raw = new DatabaseSync(':memory:');
  const later = (fn) => setImmediate(fn);
  return {
    run(sql, params, cb) {
      later(() => {
        let info = { changes: 0, lastInsertRowid: 0 };
        try {
          if (TX_CONTROL.test(sql) && !(params && params.length)) raw.exec(sql);
          else info = raw.prepare(sql).run(...(params || []));
        } catch (err) {
          cb.call({}, err);
          return;
        }
        cb.call({ changes: Number(info.changes || 0), lastID: Number(info.lastInsertRowid || 0) }, null);
      });
    },
    get(sql, params, cb) {
      later(() => {
        let row;
        try {
          row = raw.prepare(sql).get(...(params || []));
        } catch (err) {
          cb(err);
          return;
        }
        cb(null, row);
      });
    },
    all(sql, params, cb) {
      later(() => {
        let rows;
        try {
          rows = raw.prepare(sql).all(...(params || []));
        } catch (err) {
          cb(err);
          return;
        }
        cb(null, rows);
      });
    }
  };
}

const pieces = [
  extractFunction('dbRunRaw'),
  extractDeclaration('DB_TX_BEGIN_RE'),
  extractDeclaration('DB_TX_END_RE'),
  extractDeclaration('dbTxQueueTail'),
  extractDeclaration('dbTxRelease'),
  extractFunction('acquireDbTxLock'),
  extractFunction('releaseDbTxLock'),
  extractFunction('dbRun'),
  extractFunction('dbGet'),
  extractFunction('dbAll'),
  extractFunction('ensurePendingDepositSchema'),
  extractFunction('parseErr'),
  extractFunction('cleanNotifyText'),
  extractFunction('normalizeHost'),
  extractFunction('isIpv4'),
  extractFunction('normalizeClientName'),
  extractFunction('ensureUser'),
  extractFunction('getSaldo'),
  extractFunction('addSaldo'),
  extractFunction('deductSaldoAtomic'),
  extractFunction('saveTransaction'),
  extractFunction('markExpiredScRegistrations'),
  extractFunction('getActiveScRegistrationByIp'),
  extractFunction('applyScRenewalInTransaction'),
  extractFunction('extendScRegistration'),
  extractFunction('markPendingPaid'),
  extractDeclaration('SC_RENEWAL_DEPOSIT_PURPOSE'),
  extractFunction('isScRenewalDeposit'),
  extractFunction('parseDepositPayload'),
  extractFunction('settleScRenewalDeposit')
];

const EXPORTS = 'return { dbRun, dbGet, dbAll, DB_TX_END_RE, ensurePendingDepositSchema, getSaldo, addSaldo, ' +
  'extendScRegistration, markPendingPaid, settleScRenewalDeposit };';

function load({ withoutQueue = false } = {}) {
  let body = pieces.join('\n\n');
  if (withoutQueue) {
    body = body.replace(extractFunction('dbRun'), 'function dbRun(sql, params = []) {\n  return dbRunRaw(sql, params);\n}\n');
  }
  return new Function('db', 'DAY_MS', `${body}\n${EXPORTS}`)(createDb(), 24 * 60 * 60 * 1000);
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} menggantung > ${ms}ms (antrean transaksi tidak lepas?)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function setupSchema(api) {
  await api.dbRun('CREATE TABLE users (user_id INTEGER PRIMARY KEY, saldo INTEGER DEFAULT 0)');
  await api.dbRun(`CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount INTEGER, type TEXT, reference_id TEXT, timestamp INTEGER
  )`);
  await api.dbRun(`CREATE TABLE sc_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, vps_ip TEXT NOT NULL, client_name TEXT,
    status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER,
    expires_at INTEGER, UNIQUE(user_id, vps_ip)
  )`);
  await api.dbRun(`CREATE TABLE sc_notify_state (
    user_id INTEGER NOT NULL, vps_ip TEXT NOT NULL, event TEXT NOT NULL, last_sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, vps_ip, event)
  )`);
  // Skema awal seperti instalasi lama; kolom lain ditambah migrasi asli.
  await api.dbRun(`CREATE TABLE pending_deposits_app3 (
    unique_code TEXT PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL,
    provider_tx_id TEXT, qr_url TEXT, reference_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
  await api.ensurePendingDepositSchema();
  await api.ensurePendingDepositSchema();
}

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  assert(extractDeclaration('DB_TX_END_RE'));
  const api = load();
  assert(api.DB_TX_END_RE.test('COMMIT') && api.DB_TX_END_RE.test('ROLLBACK'));
  assert(!api.DB_TX_END_RE.test('ROLLBACK TO SAVEPOINT sc_renewal_qris'), 'ROLLBACK TO SAVEPOINT tidak boleh melepas antrean');
  assert(!api.DB_TX_END_RE.test('RELEASE SAVEPOINT sc_renewal_qris'), 'RELEASE SAVEPOINT tidak boleh melepas antrean');
  await setupSchema(api);

  const cols = (await api.dbAll('PRAGMA table_info(pending_deposits_app3)')).map((c) => c.name);
  for (const col of ['purpose', 'purpose_payload', 'purpose_status', 'purpose_result']) {
    assert(cols.includes(col), `migrasi harus menambah kolom ${col}`);
  }

  const now = Date.now();
  const addRegistration = (userId, ip, expiresAt, status = 'active') => api.dbRun(
    'INSERT INTO sc_registrations (user_id, vps_ip, client_name, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, ip, `client-${userId}`, status, now - DAY, now - DAY, expiresAt]
  );
  const addDeposit = (code, userId, amount, purpose, payload) => api.dbRun(
    `INSERT INTO pending_deposits_app3
     (unique_code, user_id, amount, original_amount, admin_fee, status, reference_id, created_at, expires_at, gateway_provider,
      purpose, purpose_payload, purpose_status)
     VALUES (?, ?, ?, ?, 0, 'pending', ?, ?, ?, 'gopay', ?, ?, ?)`,
    [code, userId, amount, amount, `REF_${code}`, now, now + 15 * 60000, purpose,
      payload ? JSON.stringify(payload) : null, purpose === 'sc_renewal' ? 'pending' : null]
  );
  const getDeposit = (code) => api.dbGet('SELECT * FROM pending_deposits_app3 WHERE unique_code = ?', [code]);
  const getReg = (userId, ip) => api.dbGet('SELECT * FROM sc_registrations WHERE user_id = ? AND vps_ip = ?', [userId, ip]);
  const txTypes = async (userId) => (await api.dbAll(
    'SELECT type, amount FROM transactions WHERE user_id = ? ORDER BY id', [userId]
  )).map((t) => `${t.type}:${t.amount}`);

  // 1) QRIS lunas: dana masuk saldo lalu dipakai perpanjang; saldo netto nol.
  const ipA = '203.0.113.7';
  await addRegistration(1001, ipA, now + 2 * DAY);
  await addDeposit('dep-ok', 1001, 30000, 'sc_renewal', { ip: ipA, targetUserId: 1001, clientName: 'client-a', days: 30 });
  const beforeA = await getReg(1001, ipA);
  const okOutcome = await api.settleScRenewalDeposit(await getDeposit('dep-ok'));
  assert.strictEqual(okOutcome.credited, true);
  assert(okOutcome.renewal && okOutcome.renewal.success, `perpanjangan harus sukses: ${okOutcome.failure}`);
  assert.strictEqual(await api.getSaldo(1001), 0, 'saldo netto harus nol setelah QRIS dipakai perpanjang');
  assert.strictEqual((await getReg(1001, ipA)).expires_at, beforeA.expires_at + 30 * DAY);
  const depOk = await getDeposit('dep-ok');
  assert.strictEqual(depOk.status, 'paid');
  assert.strictEqual(depOk.purpose_status, 'done');
  assert.deepStrictEqual(await txTypes(1001), ['deposit:30000', 'sc_renewal:-30000']);

  // 2) Dipicu ulang (poller/Cek Status): tidak diproses dua kali.
  const again = await api.settleScRenewalDeposit(await getDeposit('dep-ok'));
  assert.strictEqual(again.credited, false);
  assert.strictEqual(await api.getSaldo(1001), 0);
  assert.strictEqual((await getReg(1001, ipA)).expires_at, beforeA.expires_at + 30 * DAY);

  // 3) IP sudah aktif di owner lain: dana tetap masuk saldo, SC tidak berubah.
  const ipB = '198.51.100.9';
  await addRegistration(2002, ipB, now + 5 * DAY);
  await addRegistration(1002, ipB, now - DAY, 'expired');
  await addDeposit('dep-owner', 1002, 15000, 'sc_renewal', { ip: ipB, targetUserId: 1002, days: 15 });
  const beforeB = await getReg(1002, ipB);
  const failOutcome = await api.settleScRenewalDeposit(await getDeposit('dep-owner'));
  assert.strictEqual(failOutcome.credited, true);
  assert.strictEqual(failOutcome.renewal, null);
  assert(/owner lain/.test(failOutcome.failure), failOutcome.failure);
  assert.strictEqual(await api.getSaldo(1002), 15000, 'dana harus tetap di saldo kalau perpanjangan gagal');
  const afterB = await getReg(1002, ipB);
  assert.strictEqual(afterB.status, beforeB.status);
  assert.strictEqual(afterB.expires_at, beforeB.expires_at);
  const depOwner = await getDeposit('dep-owner');
  assert.strictEqual(depOwner.status, 'paid');
  assert.strictEqual(depOwner.purpose_status, 'failed');
  assert(/owner lain/.test(depOwner.purpose_result));
  assert.deepStrictEqual(await txTypes(1002), ['deposit:15000']);

  // 4) Poller, Cek Status, dan Batalkan bersamaan: tepat satu yang memproses.
  const ipC = '192.0.2.44';
  await addRegistration(1003, ipC, now - 3 * DAY, 'expired');
  await addDeposit('dep-race', 1003, 20000, 'sc_renewal', { ip: ipC, targetUserId: 1003, days: 20 });
  const raceRow = await getDeposit('dep-race');
  const race = await withTimeout(Promise.all([
    api.settleScRenewalDeposit(raceRow),
    api.settleScRenewalDeposit(raceRow),
    api.settleScRenewalDeposit(raceRow)
  ]), 5000, 'settle paralel');
  assert.strictEqual(race.filter((r) => r.credited).length, 1, 'pembayaran harus diproses tepat sekali');
  const winner = race.find((r) => r.credited);
  assert(winner.renewal && winner.renewal.reactivatedFromExpired, 'SC expired harus aktif kembali');
  assert.strictEqual(await api.getSaldo(1003), 0);
  const regC = await getReg(1003, ipC);
  assert.strictEqual(regC.status, 'active');
  assert(Math.abs(regC.expires_at - (Date.now() + 20 * DAY)) < 60000, 'SC expired dihitung ulang dari sekarang');
  assert.deepStrictEqual(await txTypes(1003), ['deposit:20000', 'sc_renewal:-20000']);

  // 5) Perpanjang saldo, top up, dan QRIS perpanjang berjalan bersamaan:
  //    tidak ada yang gagal karena BEGIN bertabrakan.
  const ipD = '192.0.2.55';
  const ipE = '192.0.2.66';
  await addRegistration(1004, ipD, now + DAY);
  await api.addSaldo(1004, 10000);
  await addDeposit('dep-topup', 1004, 5000, 'topup', null);
  await addRegistration(1005, ipE, now + DAY);
  await addDeposit('dep-par', 1005, 7000, 'sc_renewal', { ip: ipE, targetUserId: 1005, days: 7 });
  const topupRow = await getDeposit('dep-topup');
  const parRow = await getDeposit('dep-par');
  const [extended, toppedUp, qris] = await withTimeout(Promise.all([
    api.extendScRegistration(1004, 1004, ipD, 'client-d', 10, 10000),
    api.markPendingPaid(topupRow),
    api.settleScRenewalDeposit(parRow)
  ]), 5000, 'transaksi paralel');
  assert(extended.success, 'perpanjang pakai saldo harus sukses walau ada transaksi lain');
  assert.strictEqual(toppedUp, true, 'top up harus sukses walau ada transaksi lain');
  assert(qris.credited && qris.renewal, 'QRIS perpanjang harus sukses walau ada transaksi lain');
  assert.strictEqual(await api.getSaldo(1004), 5000);
  assert.strictEqual(await api.getSaldo(1005), 0);

  // 6) Saldo kurang: ROLLBACK tetap melepas antrean, transaksi berikutnya jalan.
  const short = await api.extendScRegistration(1004, 1004, ipD, 'client-d', 10, 999999);
  assert.strictEqual(short.insufficient, true);
  assert.strictEqual(await api.getSaldo(1004), 5000);
  await addDeposit('dep-after', 1004, 1000, 'topup', null);
  assert.strictEqual(await withTimeout(api.markPendingPaid(await getDeposit('dep-after')), 2000, 'transaksi setelah ROLLBACK'), true);
  // Validasi owner yang melempar error juga harus melepas antrean.
  await assert.rejects(api.extendScRegistration(1004, 1004, '192.0.2.250', 'x', 10, 1000), /tidak ditemukan/);
  await addDeposit('dep-after2', 1004, 1000, 'topup', null);
  assert.strictEqual(await withTimeout(api.markPendingPaid(await getDeposit('dep-after2')), 2000, 'transaksi setelah error'), true);

  // 7) Kontrol: tanpa antrean, skenario paralel yang sama memang gagal. Ini
  //    membuktikan test di atas benar-benar menguji tabrakan BEGIN.
  const bare = load({ withoutQueue: true });
  await setupSchema(bare);
  for (const code of ['x1', 'x2']) {
    await bare.dbRun(
      `INSERT INTO pending_deposits_app3 (unique_code, user_id, amount, original_amount, status, created_at, expires_at)
       VALUES (?, 1, 1000, 1000, 'pending', ?, ?)`,
      [code, now, now + 60000]
    );
  }
  const bareRows = await Promise.all(['x1', 'x2'].map((c) => bare.dbGet('SELECT * FROM pending_deposits_app3 WHERE unique_code = ?', [c])));
  const bareResults = await Promise.allSettled(bareRows.map((row) => bare.markPendingPaid(row)));
  assert(bareResults.some((r) => r.status === 'rejected' && /within a transaction/.test(String(r.reason?.message || ''))),
    'kontrol tanpa antrean seharusnya gagal "cannot start a transaction within a transaction"');

  console.log('sc renewal payment tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

'use strict';

// Payment gateway AutoGoPay (lib/autogopay.js + pemasangan di app3.js).
// - GoPay dan ShopeePay memakai base URL dan API key yang sama, dengan
//   endpoint dan bentuk respons masing-masing sesuai dokumentasi.
// - Mode both: GoPay dulu, ShopeePay hanya kalau GoPay gagal membuat QRIS.
// - Status lunas hanya dari bukti positif gateway; nominal dan order_sn yang
//   tidak cocok ditolak, respons error tidak pernah dianggap lunas.
// - Mode lama dari .vars.json (orderkuota, both) tetap terbaca.
// - OrderKuota sudah hilang dari app3.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const agp = require(path.join(repoRoot, 'lib', 'autogopay.js'));

const KEY = 'agp_TESTKEY123';
const BASE = 'https://v1-gateway.autogopay.site';

function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    request: async (config) => {
      calls.push(config);
      const route = routes[`${config.method.toUpperCase()} ${config.url}`];
      if (!route) return { status: 404, data: { success: false, message: 'Not Found' } };
      const out = typeof route === 'function' ? route(config) : route;
      if (out instanceof Error) throw out;
      return out;
    }
  };
}

const GOPAY_CREATED = {
  status: 200,
  data: {
    success: true,
    message: 'QRIS created successfully',
    data: {
      transaction_id: '53bc6ed2-441d-4bd0-bc39-11fdfff5fedb',
      order_id: 'AUTOGOPAY-1774618440-2411',
      amount: 10000,
      transaction_status: 'pending',
      qr_url: 'https://api.autogopay.site/qris/53bc6ed2-441d-4bd0-bc39-11fdfff5fedb/qr-code'
    }
  }
};
const SHOPEE_CREATED = {
  status: 200,
  data: {
    success: true,
    message: 'QRIS created successfully',
    data: { amount: 10000, order_sn: '162264876479351110', qr_url: 'https://api.autogopay.site/shopeepay/qr/6ff2cd1d04c5e4e7' }
  }
};

(async () => {
  // --- Mode dan URL ------------------------------------------------------------
  assert.strictEqual(agp.normalizeMode('gopay'), 'gopay');
  assert.strictEqual(agp.normalizeMode('SHOPEE'), 'shopee');
  assert.strictEqual(agp.normalizeMode('orderkuota'), 'shopee', 'mode lama OrderKuota digantikan ShopeePay');
  assert.strictEqual(agp.normalizeMode('both'), 'both');
  assert.strictEqual(agp.normalizeMode(''), 'both', 'tanpa pengaturan: GoPay dengan cadangan ShopeePay');
  assert.deepStrictEqual(agp.providerOrder('both'), ['gopay', 'shopee']);
  assert.deepStrictEqual(agp.providerOrder('gopay'), ['gopay']);
  assert.deepStrictEqual(agp.providerOrder('shopee'), ['shopee']);
  assert.strictEqual(agp.normalizeBaseUrl(''), BASE);
  assert.strictEqual(agp.normalizeBaseUrl('v1-gateway.autogopay.site/'), BASE);
  assert.strictEqual(agp.normalizeBaseUrl(`${BASE}/qris/generate`), BASE, 'URL endpoint yang ditempel dipotong ke base URL');
  assert.strictEqual(agp.normalizeBaseUrl(`${BASE}/shopeepay/qris/create`), BASE);
  assert.strictEqual(agp.providerLabel('shopee'), 'ShopeePay');
  assert.strictEqual(agp.providerLabel('orderkuota'), 'ORDERKUOTA');

  // --- Membuat QRIS --------------------------------------------------------------
  {
    const http = fakeHttp({ [`POST ${BASE}/qris/generate`]: GOPAY_CREATED, [`POST ${BASE}/shopeepay/qris/create`]: SHOPEE_CREATED });
    const client = agp.createAutoGoPayClient({ baseUrl: `${BASE}/`, apiKey: KEY, http });
    const gopay = await client.createQris('gopay', 10000);
    assert.deepStrictEqual(gopay, {
      provider: 'gopay',
      providerTxId: '53bc6ed2-441d-4bd0-bc39-11fdfff5fedb',
      qrUrl: GOPAY_CREATED.data.data.qr_url,
      billedAmount: 10000,
      originalAmount: 10000,
      adminFee: 0
    });
    const shopee = await client.createQris('shopee', 10000);
    assert.strictEqual(shopee.provider, 'shopee');
    assert.strictEqual(shopee.providerTxId, '162264876479351110', 'ShopeePay memakai order_sn');
    for (const call of http.calls) {
      assert.strictEqual(call.headers.Authorization, `Bearer ${KEY}`, 'API key yang sama untuk GoPay dan ShopeePay');
      assert.deepStrictEqual(call.data, { amount: 10000 });
    }
  }

  // Respons gagal, key kosong, dan nominal di luar batas.
  {
    const http = fakeHttp({ [`POST ${BASE}/qris/generate`]: { status: 200, data: { success: false, message: 'Saldo merchant kurang' } } });
    const client = agp.createAutoGoPayClient({ apiKey: KEY, http });
    await assert.rejects(client.createQris('gopay', 10000), /GoPay gagal membuat QRIS \(HTTP 200\): Saldo merchant kurang/);
    const noKey = agp.createAutoGoPayClient({ apiKey: '', http });
    await assert.rejects(noKey.createQris('gopay', 10000), /API key AutoGoPay belum diisi/);
    await assert.rejects(client.createQris('gopay', 10000001), /Nominal QRIS/);
    await assert.rejects(client.createQris('orderkuota', 10000), /tidak dikenal/);
    assert.strictEqual(http.calls.length, 1, 'key kosong, nominal salah, dan gateway asing tidak boleh memanggil API');
  }

  // --- Cadangan ShopeePay ------------------------------------------------------------
  {
    const fallbacks = [];
    const onFallback = (provider, err) => fallbacks.push([provider, err.message]);
    const down = fakeHttp({
      [`POST ${BASE}/qris/generate`]: { status: 502, data: '<html>Bad Gateway</html>' },
      [`POST ${BASE}/shopeepay/qris/create`]: SHOPEE_CREATED
    });
    const qr = await agp.createAutoGoPayClient({ apiKey: KEY, http: down }).createQrisByMode('both', 10000, onFallback);
    assert.strictEqual(qr.provider, 'shopee', 'GoPay error harus pindah ke ShopeePay');
    assert.deepStrictEqual(fallbacks.map((f) => f[0]), ['gopay']);
    assert(/HTTP 502/.test(fallbacks[0][1]));

    const offline = fakeHttp({
      [`POST ${BASE}/qris/generate`]: Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }),
      [`POST ${BASE}/shopeepay/qris/create`]: SHOPEE_CREATED
    });
    assert.strictEqual((await agp.createAutoGoPayClient({ apiKey: KEY, http: offline }).createQrisByMode('both', 10000)).provider, 'shopee', 'GoPay tidak terjangkau juga pindah ke ShopeePay');

    const healthy = fakeHttp({ [`POST ${BASE}/qris/generate`]: GOPAY_CREATED, [`POST ${BASE}/shopeepay/qris/create`]: SHOPEE_CREATED });
    assert.strictEqual((await agp.createAutoGoPayClient({ apiKey: KEY, http: healthy }).createQrisByMode('both', 10000)).provider, 'gopay');
    assert.strictEqual(healthy.calls.length, 1, 'GoPay sehat: ShopeePay tidak boleh dipanggil');

    const allDown = fakeHttp({});
    await assert.rejects(
      agp.createAutoGoPayClient({ apiKey: KEY, http: allDown }).createQrisByMode('both', 10000),
      (err) => /GoPay gagal/.test(err.message) && /ShopeePay gagal/.test(err.message)
    );

    const gopayOnly = fakeHttp({ [`POST ${BASE}/qris/generate`]: { status: 500, data: {} }, [`POST ${BASE}/shopeepay/qris/create`]: SHOPEE_CREATED });
    await assert.rejects(agp.createAutoGoPayClient({ apiKey: KEY, http: gopayOnly }).createQrisByMode('gopay', 10000), /GoPay gagal/);
    assert.strictEqual(gopayOnly.calls.length, 1, 'mode GoPay saja tidak memakai cadangan');

    const shopeeOnly = fakeHttp({ [`POST ${BASE}/shopeepay/qris/create`]: SHOPEE_CREATED });
    assert.strictEqual((await agp.createAutoGoPayClient({ apiKey: KEY, http: shopeeOnly }).createQrisByMode('shopee', 10000)).provider, 'shopee');
    assert.strictEqual(shopeeOnly.calls.length, 1);
  }

  // --- Cek status GoPay -----------------------------------------------------------------
  {
    let status = 'pending';
    const http = fakeHttp({
      [`POST ${BASE}/qris/status`]: (config) => {
        assert.deepStrictEqual(config.data, { transaction_id: 'trx-1' });
        return { status: 200, data: { success: true, data: { transaction_status: status, amount: 10000 } } };
      }
    });
    const client = agp.createAutoGoPayClient({ apiKey: KEY, http });
    assert.deepStrictEqual(await client.checkQris('gopay', 'trx-1', 10000), { status: 'pending', settled: false, failed: false, pending: true });
    status = 'settlement';
    assert.strictEqual((await client.checkQris('gopay', 'trx-1', 10000)).settled, true);
    status = 'expire';
    const expired = await client.checkQris('gopay', 'trx-1', 10000);
    assert.strictEqual(expired.settled, false);
    assert.strictEqual(expired.failed, true);
    status = 'settlement';
    await assert.rejects(client.checkQris('gopay', 'trx-1', 20000), /nominal/, 'nominal lunas yang berbeda harus ditolak');
    await assert.rejects(client.checkQris('gopay', '', 10000), /kosong/);
  }
  {
    const failing = fakeHttp({ [`POST ${BASE}/qris/status`]: { status: 200, data: { success: false, message: 'Transaction not found' } } });
    await assert.rejects(agp.createAutoGoPayClient({ apiKey: KEY, http: failing }).checkQris('gopay', 'trx-1'), /Transaction not found/);
    const broken = fakeHttp({ [`POST ${BASE}/qris/status`]: { status: 500, data: { success: true, data: { transaction_status: 'settlement' } } } });
    await assert.rejects(agp.createAutoGoPayClient({ apiKey: KEY, http: broken }).checkQris('gopay', 'trx-1'), /HTTP 500/, 'HTTP error tidak boleh dianggap lunas');
  }

  // --- Cek status ShopeePay --------------------------------------------------------------
  {
    let data = { order_sn: '162264876479351110', status: 'pending', order_status: 2, paid: false, amount: 10000 };
    const http = fakeHttp({
      [`GET ${BASE}/shopeepay/qris/status`]: (config) => {
        assert.deepStrictEqual(config.params, { order_sn: '162264876479351110' }, 'ShopeePay dicek lewat GET ?order_sn=');
        return { status: 200, data: { success: true, message: 'Status retrieved', data } };
      }
    });
    const client = agp.createAutoGoPayClient({ apiKey: KEY, http });
    const pending = await client.checkQris('shopee', '162264876479351110', 10000);
    assert.strictEqual(pending.settled, false);
    assert.strictEqual(pending.pending, true);
    data = { order_sn: '162264876479351110', status: 'success', order_status: 1, paid: true, amount: 10000 };
    const paid = await client.checkQris('shopee', '162264876479351110', 10000);
    assert.strictEqual(paid.settled, true);
    data = { order_sn: '162264876479351110', order_status: 1, amount: 10000 };
    assert.strictEqual((await client.checkQris('shopee', '162264876479351110', 10000)).settled, true, 'order_status 1 berarti dibayar');
    data = { order_sn: '999', paid: true, amount: 10000 };
    await assert.rejects(client.checkQris('shopee', '162264876479351110', 10000), /transaksi lain/);
    data = { order_sn: '162264876479351110', paid: true, amount: 5000 };
    await assert.rejects(client.checkQris('shopee', '162264876479351110', 10000), /nominal/);
  }

  // --- Tes koneksi --------------------------------------------------------------------
  {
    const http = fakeHttp({
      [`GET ${BASE}/transactions`]: { status: 401, data: { success: false, message: 'Invalid API key' } },
      [`GET ${BASE}/shopeepay/status`]: { status: 200, data: { success: true } }
    });
    const lines = await agp.createAutoGoPayClient({ apiKey: KEY, http }).testConnection();
    assert(/GoPay: API key ditolak \(HTTP 401\)/.test(lines[0]));
    assert(/ShopeePay: terhubung \(HTTP 200\)/.test(lines[1]));
    assert.deepStrictEqual(await agp.createAutoGoPayClient({ apiKey: '', http }).testConnection(), ['API key belum diisi.']);
  }

  // --- Pemasangan di app3.js -----------------------------------------------------------
  const app = fs.readFileSync(path.join(repoRoot, 'app3.js'), 'utf8').replace(/\r\n/g, '\n');
  const code = app.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert(!/orderkuota|orkut|rajaserver|DATA_QRIS|cekpayment/i.test(code), 'kode OrderKuota harus sudah hilang dari app3.js');
  assert(!fs.existsSync(path.join(repoRoot, 'api-cekpayment-orkut.js')), 'modul cek mutasi OrderKuota harus dihapus');
  assert(app.includes("require('./lib/autogopay')"));
  assert(!/provider !== 'gopay'/.test(app), 'tidak boleh ada cabang yang hanya mengenal GoPay');
  for (const action of ['m_pg_mode_gopay', 'm_pg_mode_shopee', 'm_pg_mode_both', 'm_pg_test_gateway']) {
    assert(app.includes(`bot.action('${action}'`), `aksi ${action} harus ada`);
  }

  function extractFunction(name) {
    const match = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(app);
    assert(match, `function ${name} not found in app3.js`);
    const start = match.index + 1;
    const end = app.indexOf('\n}\n', start);
    return app.slice(start, end + 2);
  }
  assert(/if \(!isAdmin\(ctx\.from\.id\)\)/.test(extractFunction('setPaymentMode')), 'ganti mode gateway hanya untuk admin');

  // Fungsi app3 dijalankan dengan .vars.json lama dan HTTP tiruan.
  const pieces = ['getPaymentConfig', 'paymentClient', 'createPaymentQrByMode', 'checkDepositGatewayStatus', 'getGatewayMinTopup'].map(extractFunction);
  const build = (vars, http, logs) => new Function(
    'autoGoPay', 'axios', 'loadVars', 'parseErr', 'console',
    `${pieces.join('\n')}\nreturn { getPaymentConfig, createPaymentQrByMode, checkDepositGatewayStatus, getGatewayMinTopup };`
  )(agp, http, () => vars, (e) => e.message, { error: (line) => logs.push(line), log: () => {} });

  {
    const logs = [];
    const http = fakeHttp({ [`POST ${BASE}/qris/generate`]: { status: 503, data: {} }, [`POST ${BASE}/shopeepay/qris/create`]: SHOPEE_CREATED });
    const legacyBoth = { PAYMENT_GATEWAY_MODE: 'both', GOPAY_API_KEY: KEY, RAJASERVER_API_KEY: 'lama', GOPAY_MIN_TOPUP: 5000 };
    const api = build(legacyBoth, http, logs);
    assert.deepStrictEqual(api.getPaymentConfig(), { mode: 'both', baseUrl: BASE, apiKey: KEY }, 'tanpa URL tersimpan dipakai URL AutoGoPay');
    const qr = await api.createPaymentQrByMode(10000);
    assert.strictEqual(qr.provider, 'shopee');
    assert(logs.some((l) => l.startsWith('[payment] GoPay gagal membuat QRIS, pindah ke cadangan')), 'perpindahan ke cadangan harus tercatat di log');
    assert.strictEqual(api.getGatewayMinTopup(), 5000);

    const legacyOrderKuota = build({ PAYMENT_GATEWAY_MODE: 'orderkuota', GOPAY_API_KEY: KEY }, http, logs);
    assert.strictEqual(legacyOrderKuota.getPaymentConfig().mode, 'shopee');

    await assert.rejects(
      api.checkDepositGatewayStatus({ gateway_provider: 'orderkuota', provider_tx_id: 'x', amount: 10000 }),
      /orderkuota sudah tidak dipakai/i,
      'transaksi OrderKuota lama tidak boleh dianggap lunas'
    );
  }

  console.log('autogopay: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

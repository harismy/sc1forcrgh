'use strict';

// Klien payment gateway AutoGoPay (https://autogopay.site/docs) untuk QRIS
// GoPay dan ShopeePay. Keduanya memakai base URL dan API key yang sama
// (header Authorization: Bearer).
//
// - GoPay    : POST /qris/generate {amount} -> data.transaction_id + qr_url
//              POST /qris/status {transaction_id} -> data.transaction_status
//              (pending | settlement | expire | cancel)
// - ShopeePay: POST /shopeepay/qris/create {amount} -> data.order_sn + qr_url
//              GET  /shopeepay/qris/status?order_sn= -> data.paid / order_status
//              (1 = dibayar, 2 = belum) / status (success | pending)
//
// Mode: gopay (GoPay saja), shopee (ShopeePay saja), both (GoPay dulu,
// ShopeePay kalau GoPay gagal membuat QRIS). Status hanya dianggap lunas dengan
// bukti positif dari gateway, dan nominal yang dilaporkan harus sama dengan
// nominal tagihan.

const DEFAULT_BASE_URL = 'https://v1-gateway.autogopay.site';
const MAX_AMOUNT = 10000000;
const PROVIDERS = { gopay: 'GoPay', shopee: 'ShopeePay' };

const GOPAY_PAID = ['settlement', 'paid', 'success', 'capture'];
const GOPAY_FAILED = ['expire', 'expired', 'cancel', 'cancelled', 'canceled', 'deny', 'failure', 'failed'];
const SHOPEE_PAID = ['success', 'settlement', 'paid'];
const SHOPEE_FAILED = ['expire', 'expired', 'cancel', 'cancelled', 'canceled', 'failed'];

function isProvider(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, String(provider || '').toLowerCase());
}

function providerLabel(provider) {
  const p = String(provider || '').toLowerCase();
  return PROVIDERS[p] || (p ? p.toUpperCase() : '-');
}

// OrderKuota sudah dihapus dan digantikan ShopeePay. Nilai lama "both"
// (OrderKuota + GoPay) jadi GoPay dengan cadangan ShopeePay.
function normalizeMode(raw) {
  const m = String(raw || '').trim().toLowerCase();
  if (m === 'gopay' || m === 'shopee' || m === 'both') return m;
  if (m === 'shopeepay' || m === 'orderkuota') return 'shopee';
  return 'both';
}

function modeLabel(mode) {
  const m = normalizeMode(mode);
  if (m === 'gopay') return 'GoPay saja';
  if (m === 'shopee') return 'ShopeePay saja';
  return 'GoPay, cadangan ShopeePay';
}

function providerOrder(mode) {
  const m = normalizeMode(mode);
  if (m === 'gopay') return ['gopay'];
  if (m === 'shopee') return ['shopee'];
  return ['gopay', 'shopee'];
}

// Admin kadang menempel URL endpoint lengkap; yang disimpan cukup base URL.
function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/(?:shopeepay\/qris\/(?:create|status)|shopeepay\/status|shopeepay\/transactions|qris\/(?:generate|status|cancel)|transactions)$/i, '');
  return url.replace(/\/+$/, '');
}

function gatewayMessage(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.replace(/\s+/g, ' ').trim().slice(0, 160);
  return String(body.message || body.error || body.msg || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function createAutoGoPayClient({ baseUrl, apiKey, http } = {}) {
  if (!http || typeof http.request !== 'function') throw new Error('Klien HTTP AutoGoPay tidak tersedia.');
  const base = normalizeBaseUrl(baseUrl);
  const key = String(apiKey || '').trim();

  function requireKey() {
    if (!key) throw new Error('API key AutoGoPay belum diisi (GOPAY_API_KEY di .vars.json).');
  }

  async function request(config) {
    try {
      const res = await http.request({
        ...config,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        validateStatus: () => true
      });
      return { status: Number(res?.status || 0), body: res?.data };
    } catch (err) {
      throw new Error(`gagal terhubung ke AutoGoPay (${err?.code || err?.message || 'error'})`);
    }
  }

  function providerOf(provider) {
    const p = String(provider || '').toLowerCase();
    if (!isProvider(p)) throw new Error(`Gateway ${provider || '-'} tidak dikenal.`);
    return p;
  }

  async function createQris(provider, amount) {
    const p = providerOf(provider);
    requireKey();
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt < 1 || amt > MAX_AMOUNT) {
      throw new Error(`Nominal QRIS harus Rp 1 sampai Rp ${MAX_AMOUNT.toLocaleString('id-ID')}.`);
    }
    const path = p === 'gopay' ? '/qris/generate' : '/shopeepay/qris/create';
    let res;
    try {
      res = await request({ method: 'post', url: `${base}${path}`, data: { amount: amt }, timeout: 15000 });
    } catch (err) {
      throw new Error(`${PROVIDERS[p]} ${err.message}`);
    }
    const body = res.body && typeof res.body === 'object' ? res.body : {};
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const txId = p === 'gopay' ? data.transaction_id : data.order_sn;
    if (res.status >= 400 || body.success !== true || !txId || !data.qr_url) {
      const msg = gatewayMessage(res.body);
      throw new Error(`${PROVIDERS[p]} gagal membuat QRIS (HTTP ${res.status})${msg ? `: ${msg}` : ''}`);
    }
    return {
      provider: p,
      providerTxId: String(txId),
      qrUrl: String(data.qr_url),
      billedAmount: amt,
      originalAmount: amt,
      adminFee: 0
    };
  }

  // Mode both: GoPay dulu, ShopeePay kalau GoPay gagal. onFallback dipanggil
  // untuk setiap gateway yang gagal sebelum gateway berikutnya dicoba.
  async function createQrisByMode(mode, amount, onFallback) {
    const order = providerOrder(mode);
    const errors = [];
    for (let i = 0; i < order.length; i += 1) {
      try {
        return await createQris(order[i], amount);
      } catch (err) {
        errors.push(err);
        if (i < order.length - 1 && typeof onFallback === 'function') onFallback(order[i], err);
      }
    }
    throw new Error(errors.map((e) => e.message).join(' | '));
  }

  // Hasil: { status, settled, failed, pending }. expectedAmount (opsional)
  // membuat status lunas dengan nominal berbeda ditolak.
  async function checkQris(provider, providerTxId, expectedAmount) {
    const p = providerOf(provider);
    requireKey();
    const id = String(providerTxId || '').trim();
    if (!id) throw new Error('ID transaksi gateway kosong.');
    let res;
    try {
      res = p === 'gopay'
        ? await request({ method: 'post', url: `${base}/qris/status`, data: { transaction_id: id }, timeout: 10000 })
        : await request({ method: 'get', url: `${base}/shopeepay/qris/status`, params: { order_sn: id }, timeout: 10000 });
    } catch (err) {
      throw new Error(`${PROVIDERS[p]} ${err.message}`);
    }
    const body = res.body && typeof res.body === 'object' ? res.body : null;
    if (res.status >= 400 || !body || body.success === false) {
      const msg = gatewayMessage(res.body);
      throw new Error(`${PROVIDERS[p]} gagal cek status (HTTP ${res.status})${msg ? `: ${msg}` : ''}`);
    }
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    let status;
    let settled;
    let failed;
    if (p === 'gopay') {
      status = String(data.transaction_status || data.status || '').toLowerCase();
      settled = GOPAY_PAID.includes(status);
      failed = GOPAY_FAILED.includes(status);
    } else {
      if (data.order_sn !== undefined && String(data.order_sn) !== id) {
        throw new Error('ShopeePay mengembalikan status untuk transaksi lain.');
      }
      status = String(data.status || '').toLowerCase();
      settled = data.paid === true || Number(data.order_status) === 1 || SHOPEE_PAID.includes(status);
      failed = !settled && SHOPEE_FAILED.includes(status);
    }
    const expected = Math.floor(Number(expectedAmount || 0));
    const reported = Math.floor(Number(data.amount));
    if (settled && expected > 0 && Number.isFinite(reported) && reported > 0 && reported !== expected) {
      throw new Error(`${PROVIDERS[p]} melaporkan nominal Rp ${reported.toLocaleString('id-ID')}, tagihan Rp ${expected.toLocaleString('id-ID')}.`);
    }
    if (settled) status = status || 'paid';
    return { status: status || 'pending', settled, failed, pending: !settled && !failed };
  }

  // Tes koneksi untuk menu admin: tidak membuat transaksi.
  async function testConnection() {
    if (!key) return ['API key belum diisi.'];
    const checks = [
      ['GoPay', `${base}/transactions`],
      ['ShopeePay', `${base}/shopeepay/status`]
    ];
    const lines = [];
    for (const [label, url] of checks) {
      try {
        const res = await request({ method: 'get', url, timeout: 10000 });
        const msg = gatewayMessage(res.body);
        if (res.status === 401 || res.status === 403) lines.push(`${label}: API key ditolak (HTTP ${res.status})`);
        else if (res.status >= 400) lines.push(`${label}: HTTP ${res.status}${msg ? ` (${msg})` : ''}`);
        else lines.push(`${label}: terhubung (HTTP ${res.status})${res.body?.success === false && msg ? `, ${msg}` : ''}`);
      } catch (err) {
        lines.push(`${label}: ${err.message}`);
      }
    }
    return lines;
  }

  return { baseUrl: base, createQris, createQrisByMode, checkQris, testConnection };
}

module.exports = {
  DEFAULT_BASE_URL,
  MAX_AMOUNT,
  createAutoGoPayClient,
  isProvider,
  modeLabel,
  normalizeBaseUrl,
  normalizeMode,
  providerLabel,
  providerOrder
};

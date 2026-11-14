'use strict';

// Hasil God Mode per komponen (Script SC / Summary API) untuk laporan admin.
//
// VPS melapor lewat ack (main_god_update di installer):
//   running : "God Mode mulai: <paket>"
//   success : dikirim hanya setelah SEMUA komponen campaign selesai
//   failed  : "script gagal: <ujung log>" atau "summary gagal: <ujung log>"
// Pada paket both, script selalu dikerjakan lebih dulu. Jadi "summary gagal"
// berarti script sudah berhasil, dan "script gagal" berarti Summary API belum
// dijalankan sama sekali.

const PART_LABEL = Object.freeze({ script: 'Script SC', summary: 'Summary API' });
const STATE_LABEL = Object.freeze({
  ok: 'OK',
  failed: 'GAGAL',
  not_run: 'belum jalan',
  unknown: 'belum selesai'
});

function normalizeComponents(value) {
  const component = String(value || '').trim().toLowerCase();
  return ['script', 'summary', 'both'].includes(component) ? component : '';
}

function partsOf(componentsInput) {
  const components = normalizeComponents(componentsInput);
  if (components === 'both') return ['script', 'summary'];
  return components ? [components] : [];
}

function cleanText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

// Sebab gagal ada di ujung log, bukan di awalnya.
function tailText(input, max = 160) {
  const text = cleanText(input);
  const limit = Math.max(20, Number(max) || 160);
  return text.length <= limit ? text : `...${text.slice(text.length - limit)}`;
}

// Sebab gagal yang ditampilkan. Installer Summary API mencetak baris
// "GAGAL di langkah <langkah>: <sebab>" saat gagal; kalau ada, itu yang
// diambil (kemunculan terakhir). Selain itu ujung log.
function failureReason(input, max = 200) {
  const text = cleanText(input);
  const marker = 'GAGAL di langkah';
  const at = text.lastIndexOf(marker);
  if (at < 0) return tailText(text, 160);
  const limit = Math.max(40, Number(max) || 200);
  const part = text.slice(at);
  return part.length <= limit ? part : `${part.slice(0, limit)}...`;
}

// Hasil satu target: { status, parts: { script?, summary? }, reason }.
function targetResult(componentsInput, statusInput, messageInput) {
  const parts = partsOf(componentsInput);
  const rawStatus = String(statusInput || '').trim().toLowerCase();
  const status = ['success', 'failed', 'running'].includes(rawStatus) ? rawStatus : 'pending';
  const message = cleanText(messageInput);
  const out = { status, parts: {}, reason: '' };
  for (const part of parts) out.parts[part] = status === 'success' ? 'ok' : 'unknown';
  if (status !== 'failed') return out;

  const match = message.match(/^(script|summary) gagal:\s*(.*)$/i);
  const failedPart = match ? match[1].toLowerCase() : (parts.length === 1 ? parts[0] : '');
  out.reason = match ? match[2] : message;
  if (!failedPart || !parts.includes(failedPart)) {
    // Bagian yang gagal tidak dikenali: jangan menebak mana yang berhasil.
    for (const part of parts) out.parts[part] = 'failed';
    return out;
  }
  out.parts[failedPart] = 'failed';
  if (parts.length === 2) {
    if (failedPart === 'summary') out.parts.script = 'ok';
    else out.parts.summary = 'not_run';
  }
  return out;
}

function resultLabel(result) {
  if (result.status === 'running') return 'sedang berjalan, belum ada laporan hasil';
  if (result.status === 'pending') return 'belum mengambil update';
  return Object.keys(result.parts)
    .map((part) => `${PART_LABEL[part]} ${STATE_LABEL[result.parts[part]] || STATE_LABEL.unknown}`)
    .join(', ');
}

// Baris ringkasan per komponen dari semua target campaign.
function breakdownLines(componentsInput, rows) {
  const parts = partsOf(componentsInput);
  const count = {};
  for (const part of parts) count[part] = { ok: 0, failed: 0, other: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const result = targetResult(componentsInput, row?.status, row?.message);
    for (const part of parts) {
      const state = result.parts[part];
      if (state === 'ok') count[part].ok += 1;
      else if (state === 'failed') count[part].failed += 1;
      else count[part].other += 1;
    }
  }
  return parts.map((part) =>
    `${PART_LABEL[part].padEnd(11)}: OK ${count[part].ok}, gagal ${count[part].failed}, belum selesai ${count[part].other}`
  );
}

// Daftar VPS yang belum berhasil: gagal dulu, lalu berjalan, lalu pending.
function problemLines(componentsInput, rows, limitInput = 10) {
  const limit = Math.max(1, Number(limitInput) || 10);
  const rank = { failed: 0, running: 1, pending: 2 };
  const problems = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ ip: String(row?.vps_ip || '-'), result: targetResult(componentsInput, row?.status, row?.message) }))
    .filter((item) => item.result.status !== 'success')
    .sort((a, b) => rank[a.result.status] - rank[b.result.status]);
  const lines = [];
  for (const item of problems.slice(0, limit)) {
    lines.push(`- ${item.ip}: ${resultLabel(item.result)}`);
    if (item.result.reason) lines.push(`  Sebab: ${failureReason(item.result.reason)}`);
  }
  return { lines, shown: Math.min(problems.length, limit), total: problems.length };
}

// --- Cek versi Summary API langsung ke VPS (GET :8789/health) ---------------
// Tidak bergantung ack God Mode: yang dicek adalah proses yang benar-benar
// menjawab port Summary API di tiap VPS.

// Rumus sama dengan summary_version di license-api.js dan summary_build_id di
// setup-summary-api.sh: 16 hex pertama sha256 isi installer (akhir baris LF).
function summaryBuildId(content) {
  const crypto = require('crypto');
  const text = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `summary-${crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`;
}

// probe: { ok: bool (dapat jawaban /health yang valid), build: string }
function classifySummaryProbe(expected, probe) {
  if (!probe || probe.ok !== true) return 'unreachable';
  const build = String(probe.build || '').trim();
  if (!/^summary-[0-9a-f]{16}$/.test(build)) return 'old';
  return build === String(expected || '').trim() ? 'current' : 'other';
}

const PROBE_LABEL = Object.freeze({
  old: 'versi lama (belum melaporkan build)',
  other: 'build lain',
  unreachable: 'tidak menjawab :8789/health'
});

// results: [{ ip, ok, build }]
function summaryProbeLines(expected, results, limitInput = 15) {
  const limit = Math.max(1, Number(limitInput) || 15);
  const count = { current: 0, old: 0, other: 0, unreachable: 0 };
  const problems = [];
  for (const item of Array.isArray(results) ? results : []) {
    const state = classifySummaryProbe(expected, item);
    count[state] += 1;
    if (state !== 'current') problems.push({ ip: String(item?.ip || '-'), state, build: String(item?.build || '') });
  }
  const rank = { old: 0, other: 1, unreachable: 2 };
  problems.sort((a, b) => rank[a.state] - rank[b.state]);
  const total = count.current + count.old + count.other + count.unreachable;
  const lines = [
    `Versi terbaru : ${expected || '-'}`,
    `Dicek         : ${total} VPS`,
    `Sudah terbaru : ${count.current}`,
    `Versi lama    : ${count.old + count.other}`,
    `Tidak menjawab: ${count.unreachable}`
  ];
  if (problems.length) {
    lines.push('', `Belum terbaru (${Math.min(problems.length, limit)} dari ${problems.length} ditampilkan):`);
    for (const item of problems.slice(0, limit)) {
      const extra = item.state === 'other' ? ` ${item.build}` : '';
      lines.push(`- ${item.ip}: ${PROBE_LABEL[item.state]}${extra}`);
    }
  }
  return { lines, count, problems: problems.length };
}

// Jalankan worker(item) untuk semua item dengan batas paralel.
async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let next = 0;
  const size = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      out[index] = await worker(list[index], index);
    }
  }));
  return out;
}

module.exports = {
  summaryBuildId,
  classifySummaryProbe,
  summaryProbeLines,
  mapWithConcurrency,
  normalizeComponents,
  targetResult,
  resultLabel,
  breakdownLines,
  problemLines,
  failureReason,
  tailText
};

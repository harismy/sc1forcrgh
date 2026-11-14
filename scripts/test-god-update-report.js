'use strict';

// Regresi laporan God Mode per komponen (lib/god-update-report.js):
// - Admin harus bisa melihat bagian mana yang gagal (Script SC / Summary API)
//   dan sebabnya. Pernah jadi keluhan nyata: campaign Script + Summary API
//   selesai, script VPS sudah naik versi, tetapi Summary API-nya masih lama
//   dan laporan bot tidak menyebutnya.
// - Format ack dari VPS harus tetap sama dengan main_god_update di installer.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const report = require(path.join(repoRoot, 'lib', 'god-update-report.js'));
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8');
const bot = fs.readFileSync(path.join(repoRoot, 'app3.js'), 'utf8');
const licenseApi = fs.readFileSync(path.join(repoRoot, 'license-api.js'), 'utf8');

// Awalan pesan gagal yang dibaca laporan harus sama dengan yang dikirim VPS.
assert(installer.includes('failed "script gagal: ${failure_message:-unknown}"'));
assert(installer.includes('failed "summary gagal: ${failure_message:-unknown}"'));
// VPS mengerjakan script dulu, lalu Summary API, dan baru mengirim success
// setelah keduanya selesai.
const godMain = installer.slice(installer.indexOf('main_god_update() {'), installer.indexOf('main_god_update "$@"'));
const scriptStep = godMain.indexOf('menu-sc-1forcr update >>');
const summaryStep = godMain.indexOf('menu-sc-1forcr update-summary >>');
const successAck = godMain.indexOf('success "God Mode selesai');
assert(scriptStep > 0 && summaryStep > scriptStep && successAck > summaryStep);

// Paket both: summary gagal berarti script sudah berhasil.
let r = report.targetResult('both', 'failed', 'summary gagal: apt-get update exit 100');
assert.deepStrictEqual(r.parts, { script: 'ok', summary: 'failed' });
assert.strictEqual(r.reason, 'apt-get update exit 100');
assert.strictEqual(report.resultLabel(r), 'Script SC OK, Summary API GAGAL');

// Paket both: script gagal berarti Summary API belum dijalankan.
r = report.targetResult('both', 'FAILED', 'script gagal: health-check gagal');
assert.deepStrictEqual(r.parts, { script: 'failed', summary: 'not_run' });
assert.strictEqual(report.resultLabel(r), 'Script SC GAGAL, Summary API belum jalan');

r = report.targetResult('both', 'success', 'God Mode selesai: both; script=V.1FSC.132; summary=summary-abc');
assert.strictEqual(report.resultLabel(r), 'Script SC OK, Summary API OK');
assert.strictEqual(r.reason, '');

// Satu komponen: awalan pesan tidak wajib.
r = report.targetResult('summary', 'failed', 'curl: (7) gagal');
assert.deepStrictEqual(r.parts, { summary: 'failed' });
assert.strictEqual(report.resultLabel(r), 'Summary API GAGAL');
assert.strictEqual(report.resultLabel(report.targetResult('script', 'success', '')), 'Script SC OK');

// Pesan gagal tanpa awalan pada paket both: tidak menebak mana yang berhasil.
r = report.targetResult('both', 'failed', 'error tak dikenal');
assert.deepStrictEqual(r.parts, { script: 'failed', summary: 'failed' });
assert.strictEqual(r.reason, 'error tak dikenal');

// Berjalan dan pending tidak boleh terbaca sebagai berhasil.
assert.strictEqual(
  report.resultLabel(report.targetResult('both', 'running', 'God Mode mulai: both')),
  'sedang berjalan, belum ada laporan hasil'
);
assert.strictEqual(report.resultLabel(report.targetResult('both', 'pending', '')), 'belum mengambil update');
assert.strictEqual(report.resultLabel(report.targetResult('both', '', '')), 'belum mengambil update');
assert.strictEqual(report.resultLabel(report.targetResult('both', 'aneh', '')), 'belum mengambil update');

// Sebab diambil dari ujung log, bukan awalnya.
const longLog = 'x'.repeat(500) + ' Update Summary API ditolak: signature/checksum manifest tidak valid.';
const tail = report.tailText(longLog, 80);
assert(tail.startsWith('...') && tail.endsWith('manifest tidak valid.'));
assert.strictEqual(tail.length, 83);
assert.strictEqual(report.tailText('  pendek \n saja ', 80), 'pendek saja');

const rows = [
  { vps_ip: '10.0.0.1', status: 'success', message: 'God Mode selesai: both' },
  { vps_ip: '10.0.0.2', status: 'pending', message: '' },
  { vps_ip: '10.0.0.3', status: 'failed', message: 'summary gagal: ' + longLog },
  { vps_ip: '10.0.0.4', status: 'running', message: 'God Mode mulai: both' },
  { vps_ip: '10.0.0.5', status: 'failed', message: 'script gagal: rollback otomatis' }
];
assert.deepStrictEqual(report.breakdownLines('both', rows), [
  'Script SC  : OK 2, gagal 1, belum selesai 2',
  'Summary API: OK 1, gagal 1, belum selesai 3'
]);
assert.deepStrictEqual(report.breakdownLines('summary', rows.slice(0, 2)), ['Summary API: OK 1, gagal 0, belum selesai 1']);
assert.deepStrictEqual(report.breakdownLines('', rows), []);

const problems = report.problemLines('both', rows, 10);
assert.strictEqual(problems.total, 4);
assert.strictEqual(problems.shown, 4);
// Gagal dulu, lalu berjalan, lalu pending; yang sukses tidak ikut.
assert.strictEqual(problems.lines[0], '- 10.0.0.3: Script SC OK, Summary API GAGAL');
assert(problems.lines[1].startsWith('  Sebab: ...') && problems.lines[1].endsWith('manifest tidak valid.'));
assert.strictEqual(problems.lines[2], '- 10.0.0.5: Script SC GAGAL, Summary API belum jalan');
assert.strictEqual(problems.lines[3], '  Sebab: rollback otomatis');
assert.strictEqual(problems.lines[4], '- 10.0.0.4: sedang berjalan, belum ada laporan hasil');
assert.strictEqual(problems.lines[5], '- 10.0.0.2: belum mengambil update');
assert(!problems.lines.join('\n').includes('10.0.0.1'));

const limited = report.problemLines('both', rows, 1);
assert.strictEqual(limited.shown, 1);
assert.strictEqual(limited.total, 4);
assert.strictEqual(limited.lines.length, 2);
assert.deepStrictEqual(report.problemLines('both', [rows[0]], 10), { lines: [], shown: 0, total: 0 });

// Daftar terpanjang tetap muat di satu pesan Telegram (4096 huruf).
const worst = Array.from({ length: 10 }, (_, i) => ({
  vps_ip: '203.0.113.' + i,
  status: 'failed',
  message: 'summary gagal: ' + 'y'.repeat(700)
}));
assert(report.problemLines('both', worst, 10).lines.join('\n').length < 3000);

// Bot memakai rincian yang sama di layar status dan laporan akhir.
assert(bot.includes("require('./lib/god-update-report')"));
const detailFn = bot.slice(
  bot.indexOf('async function buildGodUpdateDetailLines('),
  bot.indexOf('async function finalizeGodUpdateCampaign(')
);
assert(detailFn.includes('godUpdateReport.breakdownLines(campaign.components, rows)'));
assert(detailFn.includes('godUpdateReport.problemLines(campaign.components, rows, limit)'));
const finalizeFn = bot.slice(
  bot.indexOf('async function finalizeGodUpdateCampaign('),
  bot.indexOf('async function createGodUpdateCampaign(')
);
assert(finalizeFn.includes('buildGodUpdateDetailLines(campaign)'));
const statusFn = bot.slice(
  bot.indexOf("bot.action('m_admin_god_status'"),
  bot.indexOf('bot.action(/^m_admin_god_finish_(god-')
);
assert(statusFn.includes('buildGodUpdateDetailLines(campaign)'));

// License API menyimpan awalan dan ujung pesan gagal yang panjang, bukan
// 700 huruf pertama (sebab gagal ada di akhir log).
const ackFn = licenseApi.slice(
  licenseApi.indexOf('async function recordGodUpdateAck('),
  licenseApi.indexOf("app.post('/sc1forcr/license/activate'")
);
assert(ackFn.includes('cleanMessage.slice(0, 40)') && ackFn.includes('cleanMessage.slice(-650)'));
const compact = (message) => {
  const cleanMessage = String(message || '').replace(/\s+/g, ' ').trim();
  return cleanMessage.length <= 700
    ? cleanMessage
    : cleanMessage.slice(0, 40) + ' ... ' + cleanMessage.slice(-650);
};
const stored = compact('summary gagal: ' + 'z'.repeat(900) + ' Gagal download script summary API.');
assert(stored.length <= 700);
r = report.targetResult('both', 'failed', stored);
assert.deepStrictEqual(r.parts, { script: 'ok', summary: 'failed' });
assert(report.tailText(r.reason, 160).endsWith('Gagal download script summary API.'));

// --- Sebab gagal: baris "GAGAL di langkah" dari installer Summary API -------
const installerFail = 'summary gagal: npm notice ... [setup-summary-api] GAGAL di langkah start service + health-check: ' +
  'port 8789 masih dijawab Summary API lain/versi lama (exit 1) [sc-update] Menyiapkan rollback ... [sc-update] Rollback berhasil: /var/lib/x ' +
  '[setup-summary-api] GAGAL di langkah start service + health-check: port 8789 masih dijawab Summary API lain/versi lama (exit 1)';
r = report.targetResult('both', 'failed', installerFail);
assert(report.failureReason(r.reason).startsWith('GAGAL di langkah start service + health-check: port 8789'));
assert(report.failureReason(r.reason).endsWith('(exit 1)'));
assert(report.problemLines('both', [{ vps_ip: '1.2.3.4', status: 'failed', message: installerFail }]).lines[1]
  .startsWith('  Sebab: GAGAL di langkah start service'));
assert(report.failureReason('GAGAL di langkah x: ' + 'q'.repeat(400)).endsWith('...'));
assert.strictEqual(report.failureReason('tanpa penanda'), 'tanpa penanda');

// --- Build id Summary API ---------------------------------------------------
const summaryPath = path.join(repoRoot, 'scripts', 'setup-summary-api.sh');
const summaryInstaller = fs.readFileSync(summaryPath, 'utf8');
const crypto = require('crypto');
assert(!summaryInstaller.includes('\r'), 'installer Summary API harus LF supaya hash VPS = hash bot');
const expectedBuild = 'summary-' + crypto.createHash('sha256').update(summaryInstaller, 'utf8').digest('hex').slice(0, 16);
assert.strictEqual(report.summaryBuildId(summaryInstaller), expectedBuild);
assert.strictEqual(report.summaryBuildId(summaryInstaller.replace(/\n/g, '\r\n')), expectedBuild);
// license-api memakai rumus yang sama untuk summary_version God Mode.
assert(licenseApi.includes("summaryVersion = `summary-${crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)}`"));
// Summary API melaporkan build di /health dan unit mengisinya.
assert(summaryInstaller.includes("useDbAuth: USE_DB_AUTH, build: SUMMARY_BUILD_ID });"));
assert(summaryInstaller.includes('Environment=SUMMARY_BUILD_ID=${SUMMARY_BUILD_ID}'));

const { spawnSync } = require('child_process');
const os = require('os');
const bashCheck = spawnSync('bash', ['-c', 'command -v sha256sum >/dev/null && echo ok'], { encoding: 'utf8' });
if (bashCheck.status === 0 && String(bashCheck.stdout).trim() === 'ok') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-god-report-'));
  try {
    const fnBody = (name) => {
      const start = summaryInstaller.indexOf(`${name}() {`);
      assert(start >= 0, name);
      const end = summaryInstaller.indexOf('\n}\n', start);
      return summaryInstaller.slice(start, end + 3);
    };
    // Git Bash di Windows tidak mengenali path dengan backslash sebagai file.
    const runBash = (file, env = {}) => spawnSync('bash', [file.split(path.sep).join('/')], {
      encoding: 'utf8',
      env: { ...process.env, ...env }
    });

    // Hash diri sendiri di VPS = rumus bot untuk file yang sama.
    const selfFile = path.join(tmp, 'self.sh');
    fs.writeFileSync(selfFile, `#!/usr/bin/env bash\nset -euo pipefail\n${fnBody('summary_build_id')}summary_build_id\n`);
    const self = runBash(selfFile);
    assert.strictEqual(self.status, 0, self.stderr);
    assert.strictEqual(self.stdout.trim(), report.summaryBuildId(fs.readFileSync(selfFile, 'utf8')));

    // Health-check: lolos hanya kalau build yang menjawab = build installer.
    const healthFile = path.join(tmp, 'health.sh');
    fs.writeFileSync(healthFile, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'log() { echo "[setup-summary-api] $*"; }',
      'systemctl() { return 0; }',
      'sleep() { :; }',
      'ss() { echo "LISTEN 0 511 0.0.0.0:8789 users:((\\"node\\",pid=77,fd=20))"; }',
      'curl() { if [[ -n "${FAKE_BODY:-}" ]]; then printf "%s" "${FAKE_BODY}"; else return 7; fi; }',
      'SUMMARY_PORT=8789',
      'SUMMARY_FAIL_DETAIL=""',
      fnBody('summary_health_check'),
      'if summary_health_check; then echo "RESULT=ok"; else echo "RESULT=fail"; fi',
      'echo "DETAIL=${SUMMARY_FAIL_DETAIL}"',
      ''
    ].join('\n'));
    const want = 'summary-0123456789abcdef';
    let h = runBash(healthFile, { SUMMARY_BUILD_ID: want, FAKE_BODY: `{"ok":true,"service":"tunnel-summary","useDbAuth":true,"build":"${want}"}` });
    assert(h.stdout.includes('RESULT=ok'), h.stdout + h.stderr);
    h = runBash(healthFile, { SUMMARY_BUILD_ID: want, FAKE_BODY: '{"ok":true,"service":"tunnel-summary","useDbAuth":true}' });
    assert(h.stdout.includes('RESULT=fail'), h.stdout + h.stderr);
    assert(h.stdout.includes('masih dijawab Summary API lain/versi lama') && h.stdout.includes('pid=77'), h.stdout);
    h = runBash(healthFile, { SUMMARY_BUILD_ID: want, FAKE_BODY: '{"ok":true,"build":"summary-ffffffffffffffff"}' });
    assert(h.stdout.includes('RESULT=fail'), h.stdout);
    h = runBash(healthFile, { SUMMARY_BUILD_ID: want, FAKE_BODY: '' });
    assert(h.stdout.includes('RESULT=fail') && h.stdout.includes('tidak menjawab /health'), h.stdout);
    // Build tidak diketahui (installer lewat pipe): perilaku lama, cukup sehat.
    h = runBash(healthFile, { SUMMARY_BUILD_ID: 'unknown', FAKE_BODY: '{"ok":true}' });
    assert(h.stdout.includes('RESULT=ok'), h.stdout);

    // Trap: gagal = baris "GAGAL di langkah ..."; sukses = tidak ada baris itu.
    const trapFile = path.join(tmp, 'trap.sh');
    fs.writeFileSync(trapFile, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'log() { echo "[setup-summary-api] $*"; }',
      'SUMMARY_TRANSACTION_SNAPSHOT=""',
      'SUMMARY_TRANSACTION_COMMITTED="0"',
      'SUMMARY_STEP="persiapan"',
      'SUMMARY_FAIL_DETAIL=""',
      fnBody('summary_failure_line'),
      fnBody('rollback_summary_transaction_on_exit'),
      'trap rollback_summary_transaction_on_exit EXIT',
      'SUMMARY_STEP="install dependency (apt/npm)"',
      'if [[ "${MODE}" == "fail" ]]; then SUMMARY_FAIL_DETAIL="npm install gagal"; false; fi',
      'trap - EXIT',
      'echo selesai',
      ''
    ].join('\n'));
    let t = runBash(trapFile, { MODE: 'fail' });
    assert.notStrictEqual(t.status, 0);
    assert(t.stdout.includes('GAGAL di langkah install dependency (apt/npm): npm install gagal (exit 1)'), t.stdout);
    t = runBash(trapFile, { MODE: 'ok' });
    assert.strictEqual(t.status, 0, t.stderr);
    assert(!t.stdout.includes('GAGAL'), t.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else {
  console.log('god update report: uji bash dilewati (bash/sha256sum tidak ada)');
}

// Urutan utama installer Summary API memakai penanda langkah dan trap awal.
const mainSeq = summaryInstaller.slice(summaryInstaller.indexOf('trap rollback_summary_transaction_on_exit EXIT\nlog "Build Summary API'));
assert(mainSeq.includes('SUMMARY_STEP="start service + health-check"; start_systemd_service'));
assert(mainSeq.indexOf('commit_summary_transaction') < mainSeq.indexOf('trap - EXIT\nprint_result'));

// --- Skrip God Mode di VPS ----------------------------------------------------
// Ujung log yang dikirim memuat byte TERAKHIR (dulu cut -c1-1000 membuang 400 byte akhir).
assert(!godMain.includes('cut -c1-1000'));
assert.strictEqual((godMain.match(/failure_message="\$\(tail -c 1000 "\$\{LOG_FILE\}" 2>\/dev\/null \| tr '\\n' ' '\)"/g) || []).length, 2);
assert(installer.includes('summary_running_build() {'));
const verifyAt = godMain.indexOf('summary_running="$(summary_running_build)"');
assert(verifyAt > summaryStep && verifyAt < godMain.indexOf('touch "${summary_done}"'));
assert(godMain.includes('"${summary_running}" != "${summary_version}"'));
assert(godMain.includes('summary_jalan=${summary_running:-skip}'));

// --- Cek versi langsung ke VPS ------------------------------------------------
const exp = 'summary-aaaaaaaaaaaaaaaa';
assert.strictEqual(report.classifySummaryProbe(exp, { ok: true, build: exp }), 'current');
assert.strictEqual(report.classifySummaryProbe(exp, { ok: true, build: '' }), 'old');
assert.strictEqual(report.classifySummaryProbe(exp, { ok: true, build: 'unknown' }), 'old');
assert.strictEqual(report.classifySummaryProbe(exp, { ok: true, build: 'summary-bbbbbbbbbbbbbbbb' }), 'other');
assert.strictEqual(report.classifySummaryProbe(exp, { ok: false, build: exp }), 'unreachable');
assert.strictEqual(report.classifySummaryProbe(exp, null), 'unreachable');
const probe = report.summaryProbeLines(exp, [
  { ip: '10.1.1.1', ok: true, build: exp },
  { ip: '10.1.1.2', ok: false, build: '' },
  { ip: '10.1.1.3', ok: true, build: '' },
  { ip: '10.1.1.4', ok: true, build: 'summary-bbbbbbbbbbbbbbbb' }
], 15);
assert.deepStrictEqual(probe.count, { current: 1, old: 1, other: 1, unreachable: 1 });
assert.strictEqual(probe.problems, 3);
assert(probe.lines.includes('Sudah terbaru : 1'));
assert(probe.lines.includes('Versi lama    : 2'));
assert(probe.lines.includes('- 10.1.1.3: versi lama (belum melaporkan build)'));
assert(probe.lines.includes('- 10.1.1.4: build lain summary-bbbbbbbbbbbbbbbb'));
assert.strictEqual(probe.lines[probe.lines.length - 1], '- 10.1.1.2: tidak menjawab :8789/health');
assert(!probe.lines.join('\n').includes('10.1.1.1'));
assert.strictEqual(report.summaryProbeLines(exp, [], 15).problems, 0);

(async () => {
  let active = 0;
  let peak = 0;
  const out = await report.mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return n * 2;
  });
  assert.deepStrictEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert(peak <= 3);
  assert.deepStrictEqual(await report.mapWithConcurrency([], 5, async () => 1), []);

  // Bot: tombol dan aksi cek versi, probe tanpa key ke /health saja.
  assert(bot.includes("bot.action('m_admin_god_summary_check'"));
  assert(bot.includes("Markup.button.callback('Cek Versi Summary API di VPS', 'm_admin_god_summary_check')"));
  const probeFn = bot.slice(bot.indexOf('async function probeSummaryHealth('), bot.indexOf('async function runSummaryVersionCheck('));
  assert(probeFn.includes('if (!isIpv4(ip))') && probeFn.includes('/health`'));
  assert(!probeFn.includes('x-sync-token'));

  console.log('god update report tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

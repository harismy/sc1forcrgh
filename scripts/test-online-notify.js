'use strict';

// Regresi notif akun online: timer harus memeriksa berkala (bukan sekali per
// interval), cek jadwal harus murah, laporan panjang dipecah, dan kiriman gagal
// dicoba lagi tanpa menunggu satu interval penuh.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
const summaryApi = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-summary-api.sh'), 'utf8').replace(/\r\n/g, '\n');

function resolveBash() {
  const candidates = [
    process.env.BASH,
    process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '',
    'bash'
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('bash not found');
}

function timerBlocks(source) {
  const blocks = [];
  const re = /sc-1forcr-online-notify\.timer['"]?,? *(?:<<[A-Z_]+\n|`)([\s\S]*?)\n(?:EOF|`)/g;
  let match;
  while ((match = re.exec(source)) !== null) blocks.push(match[1]);
  return blocks;
}

// Semua penulis timer (installer, menu, restore backup, Summary API) harus
// memakai cek 15 menit. OnUnitInactiveSec=<interval>h membuat satu kali gagal
// kirim berarti diam satu interval penuh, dan rawan terlewat satu siklus.
const installerTimers = timerBlocks(installer);
assert.strictEqual(installerTimers.length, 3, `expected 3 online-notify timer writers in installer, got ${installerTimers.length}`);
const summaryTimers = timerBlocks(summaryApi);
assert.strictEqual(summaryTimers.length, 1, `expected 1 online-notify timer writer in Summary API, got ${summaryTimers.length}`);
for (const block of [...installerTimers, ...summaryTimers]) {
  assert(/^OnUnitInactiveSec=15min$/m.test(block), `online-notify timer must re-check every 15min:\n${block}`);
  assert(/^OnActiveSec=10min$/m.test(block), `online-notify timer must keep its first run:\n${block}`);
  assert(!/OnUnitInactiveSec=\$\{[a-z_]+\}h/.test(block), `online-notify timer must not wait a full interval:\n${block}`);
}
const serviceStart = installer.indexOf("cat > /etc/systemd/system/sc-1forcr-online-notify.service <<'EOF'\n");
assert(serviceStart >= 0, 'online-notify service writer not found');
const serviceBlock = installer.slice(serviceStart, installer.indexOf('\nEOF\n', serviceStart));
assert(/^TimeoutStartSec=\d+min$/m.test(serviceBlock),
  'online-notify service must cap oneshot runtime so a hung run cannot stop the timer forever');
assert(/^MemoryMax=/m.test(serviceBlock) && /^CPUQuota=/m.test(serviceBlock), 'online-notify service must keep resource limits');

const startMarker = "  cat > /usr/local/sbin/sc-1forcr-online-notify <<'EOF'\n";
const start = installer.indexOf(startMarker);
assert(start >= 0, 'online notify heredoc not found');
const end = installer.indexOf('\nEOF\n  chmod +x /usr/local/sbin/sc-1forcr-online-notify', start);
assert(end >= 0, 'online notify heredoc end not found');
const notifySource = installer.slice(start + startMarker.length, end + 1)
  .split('/etc/sc-1forcr.env').join('./etc/sc-1forcr.env')
  .split('/var/lib/sc-1forcr').join('./varlib')
  .split('/usr/local/sbin/sc-1forcr-ssh-live').join('./sbin/ssh-live')
  .split('/usr/local/sbin/sc-1forcr-xray-live').join('./sbin/xray-live')
  .split('/var/log/xray/access.log').join('./access.log');

const gateIndex = notifySource.indexOf('! should_send_online_report; then\n  exit 0');
const collectIndex = notifySource.indexOf('ssh_users=""');
assert(gateIndex > 0 && collectIndex > gateIndex, 'schedule gate must run before the heavy data collection');

const bash = resolveBash();
const tempDir = fs.mkdtempSync(path.join(repoRoot, '.tmp-online-notify-'));

// Stub sebagai fungsi bash: dipakai script yang di-source tanpa bergantung PATH.
const stubs = `
curl() {
  local text="" prev="" a n
  for a in "$@"; do [[ "$prev" == "--data-urlencode" ]] && text="\${a#text=}"; prev="$a"; done
  n=$(( $(cat ./curl.count 2>/dev/null || echo 0) + 1 )); echo "$n" > ./curl.count
  printf '%s\\n' "\${#text}|$(printf '%s' "$text" | head -n 1)" >> ./curl.log
  if (( \${#text} > 4096 )); then printf '{"ok":false,"error_code":400,"description":"Bad Request: message is too long"}'; return 0; fi
  case "\${CURL_MODE:-ok}" in
    ok) printf '{"ok":true,"result":{"message_id":%s}}' "$n" ;;
    net) echo "curl: (6) Could not resolve host: api.telegram.org" >&2; return 6 ;;
    401) printf '{"ok":false,"error_code":401,"description":"Unauthorized"}' ;;
  esac
}
systemctl() { [[ "$1" == "is-active" ]] && return 3; return 0; }
journalctl() { return 0; }
ss() { return 0; }
sleep() { :; }
`;

function writeFixture(sshUsers) {
  fs.rmSync(path.join(tempDir, 'varlib'), { recursive: true, force: true });
  for (const dir of ['etc', 'varlib', 'sbin']) fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'etc', 'sc-1forcr.env'), [
    'DOMAIN=vpn.example.com',
    'DB_PATH=./missing.db',
    'TELEGRAM_BOT_TOKEN=123:ABC',
    'TELEGRAM_CHAT_ID=-100999',
    'ONLINE_NOTIFY_ENABLE=1',
    'ONLINE_NOTIFY_INTERVAL_HOURS=3'
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(tempDir, 'sbin', 'ssh-live'),
    `#!/usr/bin/env bash\necho called >> ./collect.log\nfor ((i=1;i<=${sshUsers};i++)); do printf 'user%03d(1)\\n' "$i"; done\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tempDir, 'sbin', 'xray-live'),
    '#!/usr/bin/env bash\ncase "$1" in capabilities) echo rows-v3;; rows-v3) echo "vmess|bob|1|1|1|1.2.3.4|SOURCE_IP_ACTIVE";; esac\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tempDir, 'notify.sh'), notifySource);
  fs.writeFileSync(path.join(tempDir, 'stubs.sh'), stubs);
}

function run(env = {}) {
  for (const f of ['curl.count', 'curl.log', 'collect.log']) fs.rmSync(path.join(tempDir, f), { force: true });
  const result = spawnSync(bash, ['-c', 'source ./stubs.sh; source ./notify.sh'], {
    cwd: tempDir,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  const read = (f) => (fs.existsSync(path.join(tempDir, f)) ? fs.readFileSync(path.join(tempDir, f), 'utf8') : '');
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    curlCalls: Number(read('curl.count').trim() || 0),
    curlLog: read('curl.log').trim().split('\n').filter(Boolean),
    collected: read('collect.log') !== '',
    status_file: read('varlib/online-notify.status'),
    stamp: read('varlib/online-notify.last').trim()
  };
}

function statusValue(text, key) {
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : '';
}

const now = () => Math.floor(Date.now() / 1000);

try {
  writeFixture(1);

  // Tanpa stempel: kirim, catat stempel dan status ok.
  let r = run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.curlCalls, 1);
  assert(r.stamp, 'successful send must write the sent stamp');
  assert.strictEqual(statusValue(r.status_file, 'ONLINE_NOTIFY_LAST_RESULT'), 'ok');

  // Belum waktunya: berhenti sebelum koleksi data (siklus 15 menit harus murah).
  r = run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.curlCalls, 0);
  assert.strictEqual(r.collected, false, 'gated run must not collect data');

  // Gangguan jaringan: coba 2x, jangan cap terkirim, jeda retry 10 menit.
  fs.writeFileSync(path.join(tempDir, 'varlib', 'online-notify.last'), `${now() - 3 * 3600 - 60}\n`);
  const stampBefore = fs.readFileSync(path.join(tempDir, 'varlib', 'online-notify.last'), 'utf8');
  r = run({ CURL_MODE: 'net' });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.curlCalls, 2, 'transient failure must be retried once in the same run');
  assert.strictEqual(fs.readFileSync(path.join(tempDir, 'varlib', 'online-notify.last'), 'utf8'), stampBefore);
  let retryAt = Number(statusValue(r.status_file, 'ONLINE_NOTIFY_RETRY_AFTER'));
  assert(retryAt - now() > 500 && retryAt - now() <= 600, `transient backoff must be ~10min, got ${retryAt - now()}s`);
  assert(/Could not resolve host/.test(r.stderr));

  // Masih dalam jeda retry: tidak koleksi, tidak kirim.
  r = run({ CURL_MODE: 'ok' });
  assert.strictEqual(r.curlCalls, 0);
  assert.strictEqual(r.collected, false);

  // Trigger manual menembus jeda retry.
  r = run({ CURL_MODE: 'ok', FORCE_ONLINE_NOTIFY: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.curlCalls, 1);
  assert.strictEqual(statusValue(r.status_file, 'ONLINE_NOTIFY_LAST_RESULT'), 'ok');

  // Token salah: tidak diulang di run yang sama, jeda 1 jam.
  fs.writeFileSync(path.join(tempDir, 'varlib', 'online-notify.last'), `${now() - 3 * 3600 - 60}\n`);
  r = run({ CURL_MODE: '401' });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.curlCalls, 1, 'permanent 4xx must not be retried in the same run');
  retryAt = Number(statusValue(r.status_file, 'ONLINE_NOTIFY_RETRY_AFTER'));
  assert(retryAt - now() > 3500 && retryAt - now() <= 3600, `permanent backoff must be ~1h, got ${retryAt - now()}s`);

  // Stempel di masa depan (jam VPS sempat maju) tidak boleh mengunci notif.
  fs.rmSync(path.join(tempDir, 'varlib', 'online-notify.status'), { force: true });
  fs.writeFileSync(path.join(tempDir, 'varlib', 'online-notify.last'), `${now() + 86400}\n`);
  r = run();
  assert.strictEqual(r.curlCalls, 1, 'future sent-stamp must be ignored');

  // VPS ramai: laporan >4096 karakter dipecah, semua bagian terkirim.
  writeFixture(300);
  r = run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert(r.curlCalls >= 2, 'long report must be split into several messages');
  for (const entry of r.curlLog) {
    const len = Number(entry.split('|')[0]);
    assert(len <= 4096, `chunk too long for Telegram: ${len}`);
  }
  assert(/lanjutan 2\//.test(r.curlLog[1]), 'continuation chunk must be labelled');
  assert(/\(\d+ pesan, 301 akun online\)/.test(r.stdout), r.stdout);

  // Mode STATE_ONLY (capacity analyzer): selalu koleksi, tidak pernah kirim.
  r = run({ ONLINE_NOTIFY_STATE_ONLY: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.curlCalls, 0);
  assert.strictEqual(r.collected, true);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('online notify tests passed');

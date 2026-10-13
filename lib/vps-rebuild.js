'use strict';

// Rebuild VPS (install ulang OS) lewat skrip bin456789/reinstall.
//
// Modul ini dipisah dari app3.js supaya:
// - logika murni (daftar OS, builder perintah, parser os-release, deteksi
//   sidik jari host key) bisa dites tanpa jaringan/SSH, dan
// - `ssh2` di-require secara LAZY di dalam fungsi yang butuh koneksi, jadi
//   bot tetap bisa start walau `ssh2` belum `npm install`. Menu rebuild baru
//   gagal dengan pesan jelas kalau ssh2 belum terpasang.
//
// Alur: bot SSH masuk ke VPS pakai password root yang diketik user, lalu
// menjalankan reinstall.sh. Skrip itu TIDAK reboot sendiri: ia hanya menyiapkan
// entri boot installer lalu keluar ("Reboot to start the reinstallation").
// Jadi setelah skrip keluar dengan kode 0, bot yang memicu reboot. Setelah
// reboot, installer WIPE TOTAL disk lalu memasang OS baru. Setelah OS baru
// nyala, VPS bisa di-SSH lagi dengan password yang sama dan host key-nya berubah.

const crypto = require('crypto');

const REINSTALL_SCRIPT_URL = String(
  process.env.REINSTALL_SCRIPT_URL ||
    'https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh'
).trim();
// Mirror (server China) sebagai cadangan kalau raw.githubusercontent tidak
// terjangkau dari VPS.
const REINSTALL_SCRIPT_MIRROR_URL = String(
  process.env.REINSTALL_SCRIPT_MIRROR_URL ||
    'https://cnb.cool/bin456789/reinstall/-/git/raw/main/reinstall.sh'
).trim();

// Hanya OS yang didukung install SC (lihat unsupported_os_reason di installer:
// Debian 12+ dan Ubuntu 20.04+). Jangan tawarkan versi lain supaya pembeli
// tidak rebuild ke OS yang installer SC-nya langsung menolak.
//
// - args    : argumen persis untuk `bash reinstall.sh <args>`
// - id      : nilai ID= di /etc/os-release OS baru (untuk verifikasi selesai)
// - verId   : VERSION_ID= di /etc/os-release OS baru
const REBUILD_OS_OPTIONS = [
  { key: 'debian12', label: 'Debian 12', family: 'debian', args: ['debian', '12'], id: 'debian', verId: '12' },
  { key: 'debian13', label: 'Debian 13', family: 'debian', args: ['debian', '13'], id: 'debian', verId: '13' },
  { key: 'ubuntu2004', label: 'Ubuntu 20.04', family: 'ubuntu', args: ['ubuntu', '20.04'], id: 'ubuntu', verId: '20.04' },
  { key: 'ubuntu2204', label: 'Ubuntu 22.04', family: 'ubuntu', args: ['ubuntu', '22.04'], id: 'ubuntu', verId: '22.04' },
  { key: 'ubuntu2404', label: 'Ubuntu 24.04', family: 'ubuntu', args: ['ubuntu', '24.04'], id: 'ubuntu', verId: '24.04' }
];

function getOsOption(osKey) {
  return REBUILD_OS_OPTIONS.find((o) => o.key === String(osKey || '').trim()) || null;
}

// Kutip aman untuk shell POSIX (sama pola dengan shellQuote di app3.js).
function shQuote(input) {
  return `'${String(input == null ? '' : input).replace(/'/g, `'\\''`)}'`;
}

// Perintah yang dijalankan di VPS: unduh reinstall.sh (coba curl lalu wget,
// primary lalu mirror), lalu jalankan dengan OS pilihan.
// - --username dan --password wajib: tanpa itu skrip memanggil `read -p`
//   (prompt_username/prompt_password) dan menunggu input selamanya.
// - stdin dari /dev/null: prompt lain yang tak terduga (mis. pilih disk RAID)
//   langsung dapat EOF dan gagal, bukan macet sampai timeout.
// - --ssh-port <port> diberikan kalau port bukan 22, supaya OS baru tetap
//   listen di port yang sama dengan VPS lama. Tanpa ini OS baru default ke 22,
//   lalu poller (yang memakai port lama) tidak pernah bisa connect.
// - Skrip TIDAK reboot sendiri; reboot dipicu terpisah lewat REBOOT_COMMAND.
function buildReinstallCommand({ osKey, password, sshPort } = {}) {
  const opt = getOsOption(osKey);
  if (!opt) throw new Error(`OS rebuild tidak didukung: ${osKey}`);
  const pw = String(password == null ? '' : password);
  if (!pw) throw new Error('password root wajib diisi untuk rebuild unattended');
  const url = shQuote(REINSTALL_SCRIPT_URL);
  const mirror = shQuote(REINSTALL_SCRIPT_MIRROR_URL);
  const args = opt.args.map(shQuote).join(' ');
  const port = Number(sshPort) || 22;
  const portArg = port !== 22 ? ` --ssh-port ${shQuote(String(port))}` : '';
  const download =
    `curl -fsSL -o reinstall.sh ${url} || curl -fsSL -o reinstall.sh ${mirror} ` +
    `|| wget -qO reinstall.sh ${url} || wget -qO reinstall.sh ${mirror}`;
  return (
    `cd /root && { ${download}; } && [ -s reinstall.sh ] && ` +
    `bash reinstall.sh ${args} --username root --password ${shQuote(pw)}${portArg} </dev/null`
  );
}

// Dipicu setelah reinstall.sh keluar 0. Jeda 3 detik supaya channel SSH sempat
// ditutup rapi sebelum mesin mati; nohup + redirect supaya exec langsung kembali.
const REBOOT_COMMAND = "nohup sh -c 'sleep 3; systemctl reboot || reboot' >/dev/null 2>&1 &";

// Batalkan entri boot installer kalau persiapan tidak tuntas (timeout). Tanpa
// ini, reboot berikutnya yang tak terkait (mis. auto-reboot harian 03:00 SC)
// bisa memulai wipe tanpa diminta.
// Pola pkill pakai "[r]" dan "--username root" supaya tidak cocok dengan baris
// perintah shell ini sendiri (yang juga memuat "reinstall.sh reset"); pola polos
// 'reinstall.sh' membunuh shell ini sebelum reset sempat jalan.
const CANCEL_COMMAND =
  "pkill -f '[r]einstall[.]sh .*--username root' >/dev/null 2>&1; sleep 1; " +
  'cd /root && [ -s reinstall.sh ] && bash reinstall.sh reset </dev/null >/dev/null 2>&1; true';

// Sensor password dari teks output sebelum ditampilkan ke user/log
// (reinstall.sh mencetak "Password: ..." di ringkasan akhirnya).
function scrubSecret(text, secret) {
  let out = String(text || '');
  const s = String(secret || '');
  if (s) out = out.split(s).join('***');
  return out.replace(/(Password:\s*)\S+/gi, '$1***');
}

// Perintah preflight: cek downloader ada, dan jenis virtualisasi (reinstall.sh
// menolak container: OpenVZ/LXC). Output dibaca runReinstall.
const PREFLIGHT_COMMAND =
  'echo VIRT=$(systemd-detect-virt 2>/dev/null || echo unknown); ' +
  '[ -d /proc/vz ] && echo VZ=1; ' +
  'command -v curl >/dev/null 2>&1 && echo HAS_CURL=1 || echo HAS_CURL=0; ' +
  'command -v wget >/dev/null 2>&1 && echo HAS_WGET=1 || echo HAS_WGET=0';

function parsePreflight(output) {
  const text = String(output || '');
  const virtMatch = /VIRT=([^\s]+)/.exec(text);
  let virt = virtMatch ? virtMatch[1].toLowerCase() : 'unknown';
  if (/VZ=1/.test(text)) virt = 'openvz';
  const hasCurl = /HAS_CURL=1/.test(text);
  const hasWget = /HAS_WGET=1/.test(text);
  return { virt, hasCurl, hasWget };
}

function preflightProblem(pf) {
  if (!pf) return null;
  if (pf.virt === 'openvz' || pf.virt === 'lxc' || pf.virt === 'lxc-libvirt') {
    return { reason: 'virt-unsupported', detail: pf.virt };
  }
  if (!pf.hasCurl && !pf.hasWget) {
    return { reason: 'no-downloader', detail: null };
  }
  return null;
}

// Parser /etc/os-release -> { id, versionId }.
function parseOsRelease(text) {
  const out = { id: '', versionId: '' };
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === 'ID') out.id = val.toLowerCase();
    else if (key === 'VERSION_ID') out.versionId = val;
  }
  return out;
}

// OS baru cocok dengan pilihan? ID sama persis, VERSION_ID sama (Ubuntu
// "24.04", Debian "12"), atau diawali "<versi>." untuk point release.
function matchesTargetOs(osReleaseText, osKey) {
  const opt = getOsOption(osKey);
  if (!opt) return false;
  const parsed = parseOsRelease(osReleaseText);
  if (parsed.id !== opt.id) return false;
  return parsed.versionId === opt.verId || parsed.versionId.startsWith(`${opt.verId}.`);
}

function fingerprintFromKey(key) {
  try {
    const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ''));
    if (!buf.length) return '';
    return `SHA256:${crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '')}`;
  } catch (_) {
    return '';
  }
}

function fingerprintChanged(oldFp, newFp) {
  const a = String(oldFp || '').trim();
  const b = String(newFp || '').trim();
  return Boolean(b) && Boolean(a) && a !== b;
}

// Lazy-require ssh2. Melempar error berkode NO_SSH2 kalau belum terpasang.
function loadSsh2() {
  try {
    return require('ssh2');
  } catch (err) {
    const e = new Error('ssh2 belum terpasang di server bot (jalankan: npm install ssh2)');
    e.code = 'NO_SSH2';
    e.cause = err;
    throw e;
  }
}

function classifyConnError(err, ready) {
  const level = String(err && err.level ? err.level : '').toLowerCase();
  if (level.includes('authentication')) return 'auth';
  if (!ready) return 'unreachable';
  return 'disconnected';
}

// hostVerifier ssh2: ssh2 memanggil verify(ret) lagi kalau fungsi ini
// mengembalikan nilai, jadi cukup panggil callback dan JANGAN return apa pun.
function makeHostVerifier(onKey, accept) {
  return (key, verify) => {
    onKey(fingerprintFromKey(key));
    if (typeof verify === 'function') {
      verify(accept);
      return undefined;
    }
    return accept;
  };
}

// Jalankan satu perintah di koneksi yang sudah ready.
// Resolusi: { code, signal, out } atau { error }.
function execCollect(conn, command, { timeoutMs = 0, maxBytes = 16000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let out = '';
    let code = null;
    let signal = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    conn.exec(command, (err, stream) => {
      if (err) { finish({ error: err }); return; }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try { stream.close(); } catch (_) {}
          finish({ timeout: true, out });
        }, timeoutMs);
      }
      const add = (d) => { out = (out + d.toString('utf8')).slice(-maxBytes); };
      stream.on('data', add);
      stream.stderr.on('data', add);
      stream.on('exit', (c, s) => { code = c; signal = s || null; });
      stream.on('close', () => finish({ code, signal, out }));
    });
  });
}

// Jalankan reinstall di VPS lalu picu reboot. Resolusi:
//  { ok:true, fingerprint }                         -> skrip sukses, reboot dipicu
//  { ok:false, reason:'auth' }                       -> password root salah
//  { ok:false, reason:'unreachable', detail }        -> tak bisa connect
//  { ok:false, reason:'virt-unsupported', detail }   -> OpenVZ/LXC
//  { ok:false, reason:'no-downloader' }              -> tak ada curl/wget
//  { ok:false, reason:'reinstall-failed', tail }     -> skrip keluar error (VPS belum diubah)
//  { ok:false, reason:'prep-timeout' }               -> skrip tak selesai; entri boot dibatalkan
//  { ok:false, reason:'disconnected' }               -> koneksi putus saat skrip jalan
// `tail` sudah disensor dari password.
function runReinstall(opts = {}) {
  const host = String(opts.host || '').trim();
  const port = Number(opts.port) || 22;
  const username = String(opts.username || 'root').trim() || 'root';
  const password = String(opts.password || '');
  const osKey = String(opts.osKey || '').trim();
  const readyTimeout = Number(opts.readyTimeoutMs) || 25000;
  const runTimeout = Number(opts.runTimeoutMs) || 8 * 60 * 1000;

  let command;
  try {
    command = buildReinstallCommand({ osKey, password, sshPort: port });
  } catch (err) {
    return Promise.reject(err);
  }
  const { Client } = loadSsh2();

  return new Promise((resolve) => {
    const conn = new Client();
    let ready = false;
    let settled = false;
    let fingerprint = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      resolve(result);
    };

    conn.on('ready', async () => {
      ready = true;
      try {
        const pf = await execCollect(conn, PREFLIGHT_COMMAND, { timeoutMs: 20000 });
        if (!pf.error) {
          const problem = preflightProblem(parsePreflight(pf.out));
          if (problem) { finish({ ok: false, reason: problem.reason, detail: problem.detail }); return; }
        }

        const run = await execCollect(conn, command, { timeoutMs: runTimeout });
        if (settled) return;
        if (run.error) { finish({ ok: false, reason: 'disconnected', detail: run.error.message }); return; }
        if (run.timeout) {
          // Jangan tinggalkan entri boot installer setengah jadi.
          await execCollect(conn, CANCEL_COMMAND, { timeoutMs: 30000 }).catch(() => {});
          finish({ ok: false, reason: 'prep-timeout', tail: scrubSecret(run.out, password).slice(-1200) });
          return;
        }
        if (run.code !== 0) {
          finish({
            ok: false,
            reason: 'reinstall-failed',
            detail: run.code === null ? `signal ${run.signal || '-'}` : `exit ${run.code}`,
            tail: scrubSecret(run.out, password).slice(-1200)
          });
          return;
        }

        // Skrip sukses menyiapkan installer. Picu reboot; koneksi akan putus
        // sendiri beberapa detik kemudian, itu normal.
        await execCollect(conn, REBOOT_COMMAND, { timeoutMs: 15000 }).catch(() => {});
        finish({ ok: true, fingerprint });
      } catch (err) {
        finish({ ok: false, reason: 'disconnected', detail: err && err.message });
      }
    });
    conn.on('error', (err) => {
      if (settled) return;
      finish({ ok: false, reason: classifyConnError(err, ready), detail: err && err.message });
    });
    conn.on('close', () => {
      if (settled) return;
      finish({ ok: false, reason: ready ? 'disconnected' : 'unreachable', detail: 'koneksi tertutup' });
    });

    try {
      conn.connect({
        host,
        port,
        username,
        password,
        readyTimeout,
        // OS akan diganti, host key lama tidak perlu dipercaya; sidik jarinya
        // direkam untuk dibandingkan dengan OS baru oleh poller.
        hostVerifier: makeHostVerifier((fp) => { fingerprint = fp; }, true)
      });
    } catch (err) {
      finish({ ok: false, reason: 'unreachable', detail: err.message });
    }
  });
}

// Verifikasi OS baru sudah nyala: login pakai password, baca /etc/os-release,
// dan rekam sidik jari host key. Dipakai poller saat password masih di memori.
// Resolusi: { ok, reason, osRelease, fingerprint, matches }
function verifyRebuiltOs(opts = {}) {
  const host = String(opts.host || '').trim();
  const port = Number(opts.port) || 22;
  const username = String(opts.username || 'root').trim() || 'root';
  const password = String(opts.password || '');
  const osKey = String(opts.osKey || '').trim();
  const readyTimeout = Number(opts.readyTimeoutMs) || 15000;

  let Client;
  try {
    ({ Client } = loadSsh2());
  } catch (err) {
    return Promise.resolve({ ok: false, reason: 'no-ssh2' });
  }
  return new Promise((resolve) => {
    const conn = new Client();
    let ready = false;
    let settled = false;
    let fingerprint = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      resolve(r);
    };
    conn.on('ready', async () => {
      ready = true;
      const r = await execCollect(conn, 'cat /etc/os-release 2>/dev/null', { timeoutMs: 15000 });
      if (r.error || r.timeout) { finish({ ok: false, reason: 'exec-failed', fingerprint }); return; }
      finish({ ok: true, osRelease: r.out, fingerprint, matches: matchesTargetOs(r.out, osKey) });
    });
    conn.on('error', (err) => {
      finish({ ok: false, reason: classifyConnError(err, ready), fingerprint });
    });
    conn.on('close', () => {
      finish({ ok: false, reason: 'closed', fingerprint });
    });
    try {
      conn.connect({
        host,
        port,
        username,
        password,
        readyTimeout,
        hostVerifier: makeHostVerifier((fp) => { fingerprint = fp; }, true)
      });
    } catch (err) {
      finish({ ok: false, reason: 'unreachable', fingerprint });
    }
  });
}

// Ambil sidik jari host key tanpa login (fallback poller setelah bot restart
// dan password tidak ada lagi di memori). Host key ditolak setelah direkam,
// jadi koneksi berhenti sebelum tahap auth. Resolusi: { ok, fingerprint }.
function probeHostKey(opts = {}) {
  const host = String(opts.host || '').trim();
  const port = Number(opts.port) || 22;
  const readyTimeout = Number(opts.readyTimeoutMs) || 12000;

  let Client;
  try {
    ({ Client } = loadSsh2());
  } catch (err) {
    return Promise.resolve({ ok: false, reason: 'no-ssh2' });
  }
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    let fingerprint = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      resolve(r);
    };
    const done = () => finish(fingerprint ? { ok: true, fingerprint } : { ok: false, reason: 'unreachable' });
    conn.on('ready', done);
    conn.on('error', done);
    conn.on('close', done);
    try {
      conn.connect({
        host,
        port,
        username: 'root',
        readyTimeout,
        hostVerifier: makeHostVerifier((fp) => { fingerprint = fp; }, false)
      });
    } catch (err) {
      finish({ ok: false, reason: 'unreachable' });
    }
  });
}

module.exports = {
  REINSTALL_SCRIPT_URL,
  REINSTALL_SCRIPT_MIRROR_URL,
  REBUILD_OS_OPTIONS,
  getOsOption,
  shQuote,
  buildReinstallCommand,
  REBOOT_COMMAND,
  CANCEL_COMMAND,
  scrubSecret,
  PREFLIGHT_COMMAND,
  parsePreflight,
  preflightProblem,
  parseOsRelease,
  matchesTargetOs,
  fingerprintFromKey,
  fingerprintChanged,
  makeHostVerifier,
  runReinstall,
  verifyRebuiltOs,
  probeHostKey
};

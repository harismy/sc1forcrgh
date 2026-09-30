'use strict';

// Tampilan installer (blok "installer-ui"): layar input domain di awal dan
// layar ringkasan di akhir install. Test memastikan:
// - bingkai lurus di semua lebar layar, mode warna, dan locale,
// - teks dilipat, bukan menjebol bingkai, dan mode none tanpa kode warna,
// - input domain divalidasi, dicek ke A record, dan tidak pernah memblokir,
// - animasi progres tidak menggulung layar, berhenti sendiri kalau installer
//   mati, dan install yang gagal menampilkan ujung log,
// - masalah tampilan tidak bisa menggagalkan install yang sudah selesai,
// - token API asli tidak masuk ke log install.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

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

const bash = resolveBash();
const B = (p) => (process.platform === 'win32'
  ? spawnSync(bash, ['-c', `cygpath -u '${p}'`], { encoding: 'utf8' }).stdout.trim()
  : p);

const block = extract(installer, '# >>> installer-ui\n', '# <<< installer-ui\n');
const domainHelpers = extract(installer, 'sanitize_domain_host() {', '\nnormalize_domain_host_list() {');

const syntax = spawnSync(bash, ['-n'], { input: block, encoding: 'utf8' });
assert.strictEqual(syntax.status, 0, `syntax blok installer-ui gagal:\n${syntax.stderr || syntax.stdout}`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-installer-ui-'));
const stubDir = path.join(tmpDir, 'bin');
fs.mkdirSync(stubDir, { recursive: true });
const writeExec = (file, body) => {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
};

// curl tiruan: jawaban api.ipify.org. getent tiruan: A record per host.
writeExec(path.join(stubDir, 'curl'), '#!/usr/bin/env bash\nprintf \'%s\' "${FAKE_PUBLIC_IP:-}"\n');
writeExec(path.join(stubDir, 'getent'), `#!/usr/bin/env bash
echo "getent $*" >> "\${FAKE_LOG}"
case "\${2:-}" in
  vpn.contoh.com) printf '%s STREAM vpn.contoh.com\\n%s DGRAM\\n' 203.0.113.10 203.0.113.10 ;;
  cf.contoh.com) printf '%s STREAM cf.contoh.com\\n' 104.21.5.5 ;;
  *) exit 2 ;;
esac
`);
writeExec(path.join(stubDir, 'systemctl'), `#!/usr/bin/env bash
# is-active --quiet UNIT: haproxy dianggap mati, sisanya aktif.
[[ "\${3:-}" != "haproxy" ]]
`);

const FIXTURE = `
SCRIPT_VERSION=V.1FSC.78
ACTIVE_UDP_BACKEND=zivpn; ZIVPN_SERVICE_NAME=zivpn; UDPCUSTOM_SERVICE_NAME=sc-1forcr-udpcustom
ZIVPN_LISTEN_PORT=5667; ZIVPN_DNAT_RANGE=6000:19999; UDPCUSTOM_LISTEN_PORT=5667
DROPBEAR_PORT=109; DROPBEAR_ALT_PORT=143
tls_cert_domain() { echo "\${DOMAIN}"; }
`;
const TOKEN = '3f9a1c0de7b24a6f8d5e0c1b2a3948576e5d4c3b2a1f0e9d';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const width = (s) => Array.from(stripAnsi(s)).length;

function run(script, env = {}) {
  const file = path.join(tmpDir, 'run.sh');
  fs.writeFileSync(file, `set -euo pipefail\nexport PATH='${B(stubDir)}':"$PATH"\n${script}`);
  return spawnSync(bash, [B(file)], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_LOG: B(path.join(tmpDir, 'calls.log')), NO_COLOR: '', TMUX: '', ...env }
  });
}

function render(cols, mode, locale, extra = '') {
  const r = run(`${FIXTURE}\n${block}\nDOMAIN=vpn.contoh.com\nIUI_PUBLIC_IP=203.0.113.10\n` +
    `IUI_COLS=${cols}\niui_init ${mode}\n${extra}\n` +
    'iui_screen_welcome\necho "@@FINISHED"\n' +
    'IUI_SVC=("SSH|ON" "DROPBEAR|ON" "SSH-WS|ON" "XRAY|ON" "NGINX|ON" "HAPROXY|OFF" "API|ON" "ZIVPN|ON")\n' +
    `IUI_SSL="\${IUI_SSL:-letsencrypt}"\niui_screen_finished ${TOKEN}\n`,
  { LC_ALL: locale, LANG: locale });
  assert.strictEqual(r.status, 0, `render gagal cols=${cols} mode=${mode} locale=${locale}:\n${r.stderr}`);
  return r.stdout;
}

const isFrame = (l) => /^ [╭│├╰▄▀]/.test(stripAnsi(l));
const isBanner = (l) => stripAnsi(l).includes('S C   1 F O R C R   N E X U S');

try {
  // 1. Bingkai lurus di semua lebar, mode warna, dan locale.
  for (const locale of ['C', 'C.UTF-8']) {
    for (const mode of ['truecolor', '256', '16', 'none']) {
      for (const cols of [30, 42, 50, 62, 80, 120]) {
        const out = render(cols, mode, locale);
        const bw = Math.min(78, Math.max(40, cols - 2));
        const lines = out.split('\n').filter((l) => l.length > 0);
        const frames = lines.filter((l) => isFrame(l) || isBanner(l));
        assert(frames.length >= 30, `bingkai terlalu sedikit cols=${cols} mode=${mode}`);
        for (const line of frames) {
          assert.strictEqual(width(line), bw + 1,
            `bingkai tidak lurus cols=${cols} mode=${mode} locale=${locale}:\n${stripAnsi(line)}`);
        }
        // Hanya URL dan token (sengaja di luar kotak agar bisa disalin) yang
        // boleh lebih lebar dari kotak.
        for (const line of lines) {
          if (/^ {2}API (Base|Token)/.test(stripAnsi(line))) continue;
          assert(width(line) <= bw + 1, `baris melebihi kotak cols=${cols} mode=${mode}:\n${stripAnsi(line)}`);
        }
        if (mode === 'none') assert(!out.includes('\x1b['), 'mode none tidak boleh memuat kode warna');
        if (mode === 'truecolor') assert(/\x1b\[38;2;\d+;\d+;\d+m/.test(out), 'truecolor harus memakai warna 24-bit');
        if (mode === '256') assert(/\x1b\[38;5;\d+m/.test(out), 'mode 256 harus memakai warna xterm-256');
        if (mode === '16') assert(!/\x1b\[[34]8;[25];/.test(out), 'mode 16 tidak boleh memakai warna 256/24-bit');
      }
    }
  }

  // 2. Isi layar: info SC, server, petunjuk domain, lalu ringkasan akhir.
  {
    const plain = stripAnsi(render(80, 'truecolor', 'C.UTF-8'));
    const [welcome, finished] = plain.split('@@FINISHED');
    for (const text of ['INSTALLER', 'V.1FSC.78', '[ TENTANG SC ]', 'VMess, VLESS, Trojan', 'ZIVPN, UDP Custom, UDPGW',
      '[ SERVER INI ]', '203.0.113.10', '[ DOMAIN ]', 'Arahkan A record ke IP VPS ini dulu.', 'Contoh: vpn.domainkamu.com']) {
      assert(welcome.includes(text), `layar domain harus memuat: ${text}`);
    }
    for (const text of ['INSTALL SELESAI', '[ SERVER ]', 'vpn.contoh.com', "Aktif (Let's Encrypt)", '[ LAYANAN ]',
      'SSH aktif', 'HAPROXY mati', 'ZIVPN aktif', '[ PORT ]', '443 TLS, 80 non-TLS', 'Dropbear 109 dan 143',
      'ZIVPN 5667 (6000-19999)', '[ LANGKAH BERIKUTNYA ]', 'menu [01] MENU AKUN',
      '  API Base  › https://vpn.contoh.com/vps', `  API Token › ${TOKEN}`]) {
      assert(finished.includes(text), `layar selesai harus memuat: ${text}`);
    }
    // URL dan token harus utuh di satu baris walau layarnya sempit.
    const narrow = stripAnsi(render(30, 'none', 'C'));
    assert(narrow.includes('  API Base  › https://vpn.contoh.com/vps\n'));
    assert(narrow.includes(`  API Token › ${TOKEN}\n`));

    const failed = stripAnsi(render(80, 'none', 'C', 'IUI_SSL=sementara'));
    assert(failed.includes("Let's Encrypt gagal, 443 memakai sertifikat sementara."), 'kegagalan sertifikat harus terlihat');
    assert(!failed.includes("Aktif (Let's Encrypt)"));
  }

  // 3. Teks panjang dilipat dan kata yang terlalu panjang dipotong, bingkai tetap lurus.
  {
    const r = run(`${block}\nIUI_COLS=42\niui_init none\niui_layout\n` +
      'iui_kv "DOMAIN" "sangat-panjang-sekali.subdomain.contoh-domain-panjang.example.com"\n' +
      'iui_text "Satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas duabelas"\n' +
      'iui_kv "KOSONG" ""\niui_text "glob * ? [a] tidak boleh dikembangkan"\n');
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n').filter(Boolean);
    assert(lines.length >= 7, 'teks panjang harus dilipat ke beberapa baris');
    for (const line of lines) assert.strictEqual(width(line), 41, `baris lipatan tidak lurus:\n${line}`);
    assert(r.stdout.includes('glob * ? [a] tidak boleh'), 'karakter glob harus tampil apa adanya');
    assert.strictEqual(r.stdout.replace(/[^a-z.-]/g, '').includes('sangat-panjang-sekali.subdomain.contoh-domain-panjang.example.com'), true,
      'kata yang dipotong tidak boleh kehilangan huruf');
  }

  // 4. Alur input domain. /dev/tty diganti fd 3 (ketikan) dan fd 4 (layar).
  const promptBlock = block.replace(/<\/dev\/tty/g, '<&3').replace(/>\/dev\/tty/g, '>&4');
  assert(promptBlock !== block && !/[<>] ?\/dev\/tty/.test(promptBlock), 'pengganti /dev/tty untuk test tidak lengkap');
  function prompt(typed, env = {}) {
    const inFile = path.join(tmpDir, 'typed.txt');
    const outFile = path.join(tmpDir, 'screen.txt');
    fs.writeFileSync(inFile, typed);
    fs.writeFileSync(path.join(tmpDir, 'calls.log'), '');
    const r = run(`${FIXTURE}\n${domainHelpers}\n${promptBlock}\nDOMAIN=''\nIUI_COLS=80\n` +
      `exec 3<'${B(inFile)}' 4>'${B(outFile)}'\n` +
      'iui_prompt_domain || true\nexec 4>&-\nprintf \'DOMAIN=[%s]\\n\' "${DOMAIN}"\n',
    { FAKE_PUBLIC_IP: '203.0.113.10', TERM: 'xterm-256color', ...env });
    assert.strictEqual(r.status, 0, `prompt gagal:\n${r.stdout}\n${r.stderr}`);
    const m = r.stdout.match(/DOMAIN=\[(.*)\]/);
    assert(m, `keluaran prompt tidak dikenali:\n${r.stdout}\n${r.stderr}`);
    return {
      domain: m[1],
      // Pesan di luar kotak dilipat mengikuti lebar layar; spasi dirapatkan supaya
      // isi pesan bisa dicocokkan tanpa bergantung titik lipatnya.
      screen: stripAnsi(fs.readFileSync(outFile, 'utf8')).replace(/\s+/g, ' '),
      calls: fs.readFileSync(path.join(tmpDir, 'calls.log'), 'utf8')
    };
  }

  {
    // Domain cocok dengan IP VPS: langsung diterima.
    const ok = prompt('vpn.contoh.com\n');
    assert.strictEqual(ok.domain, 'vpn.contoh.com');
    assert(ok.screen.includes('[ TENTANG SC ]') && ok.screen.includes('Domain ›'), 'layar info harus tampil sebelum input');
    assert(ok.screen.includes('Domain vpn.contoh.com sudah mengarah ke IP VPS ini (203.0.113.10).'));
    assert(!ok.screen.includes('Peringatan'));

    // Tempelan URL dibersihkan menjadi nama host.
    assert.strictEqual(prompt('  HTTPS://VPN.Contoh.com/vps  \n').domain, 'vpn.contoh.com');

    // Input salah tidak mematikan installer, hanya diminta ulang.
    const retry = prompt('\nabc\n203.0.113.10\nvpn.contoh.com\n');
    assert.strictEqual(retry.domain, 'vpn.contoh.com');
    assert.strictEqual((retry.screen.match(/Domain tidak valid/g) || []).length, 3);

    // Mengarah ke IP lain (mis. proxy Cloudflare): diperingatkan, Enter = lanjut.
    const cf = prompt('cf.contoh.com\n\n');
    assert.strictEqual(cf.domain, 'cf.contoh.com');
    assert(cf.screen.includes('Peringatan: cf.contoh.com mengarah ke 104.21.5.5, bukan ke IP VPS ini (203.0.113.10).'));
    assert(cf.screen.includes('proxy Cloudflare'));
    assert(cf.screen.includes('Enter = lanjut, atau ketik domain lain'));
    assert.strictEqual(prompt('cf.contoh.com\nya\n').domain, 'cf.contoh.com');

    // Setelah peringatan, mengetik domain lain mengganti pilihan.
    const swap = prompt('cf.contoh.com\nvpn.contoh.com\n');
    assert.strictEqual(swap.domain, 'vpn.contoh.com');
    assert(swap.screen.includes('sudah mengarah ke IP VPS ini'));

    // A record belum terbaca: diperingatkan, tetap bisa lanjut.
    const none = prompt('baru.contoh.com\n\n');
    assert.strictEqual(none.domain, 'baru.contoh.com');
    assert(none.screen.includes('Peringatan: A record baru.contoh.com belum terbaca dari VPS ini.'));

    // IP publik tidak terdeteksi (jaringan/resolver bermasalah): tanpa cek DNS
    // dan tanpa peringatan palsu.
    const offline = prompt('baru.contoh.com\n', { FAKE_PUBLIC_IP: '' });
    assert.strictEqual(offline.domain, 'baru.contoh.com');
    assert(offline.screen.includes('tidak terdeteksi'));
    assert(!offline.screen.includes('Peringatan'));
    assert.strictEqual(offline.calls, '', 'getent tidak boleh dipanggil saat IP publik tidak diketahui');

    // Salah lima kali atau terminal tertutup: DOMAIN kosong, installer berhenti dengan pesan biasa.
    assert.strictEqual(prompt('a\nb\nc\nd\ne\nvpn.contoh.com\n').domain, '');
    assert.strictEqual(prompt('').domain, '');

    // Di dalam GNU screen (cara install dari bot) warna turun ke 256.
    const modeFor = (term) => run(`${block}\niui_init auto\nprintf '%s' "\${IUI_MODE}"\n`, { TERM: term }).stdout;
    assert.strictEqual(modeFor('screen.xterm-256color'), '256');
    assert.strictEqual(modeFor('xterm-256color'), 'truecolor');
    assert.strictEqual(modeFor('linux'), '16');
  }

  // 5. Layar akhir lewat show_install_finished: tanpa terminal tetap polos di
  //    stdout, dan status layanan diambil dari systemctl.
  {
    const showFn = extract(installer, 'show_install_finished() {', '\nopen_menu_after_install() {');
    const r = run(`${FIXTURE}\n${block}\nmask_secret() { echo "\${1:0:4}****\${1: -4}"; }\n${showFn}\n` +
      `DOMAIN=vpn.contoh.com\nAPI_AUTH_TOKEN=${TOKEN}\nSC_ORIG_STDOUT_IS_TTY=0\nshow_install_finished\n`,
    { FAKE_PUBLIC_IP: '203.0.113.10' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert(!r.stdout.includes('\x1b['), 'tanpa terminal, ringkasan harus polos');
    assert(r.stdout.includes('INSTALL SELESAI') && r.stdout.includes('HAPROXY mati') && r.stdout.includes('XRAY aktif'));
    assert(r.stdout.includes('sertifikat sementara'), 'tanpa file sertifikat, SSL harus ditandai belum terbit');
    assert(r.stdout.includes('203.0.113.10'));
  }

  // 6. Animasi progres. /dev/tty diganti fd 4 (file), jadi semua yang dikirim
  //    proses animasi ke terminal bisa diperiksa byte demi byte.
  const logFile = path.join(tmpDir, 'install.log');
  const screenFile = path.join(tmpDir, 'anim-screen.bin');
  const pidFile = path.join(tmpDir, 'anim.pid');
  const displayFns = extract(installer, 'show_install_progress() {', '\n# Ringkasan akhir install.')
    .replace(/\/var\/lib\/sc-1forcr\/install\.log/g, B(logFile));
  assert(displayFns.includes('install_display_start() {') && displayFns.includes(B(logFile)), 'fungsi tampilan progres tidak terambil');
  // Layar digambar ulang penuh tiap 4 tick supaya test tidak perlu menunggu lama.
  const animPrelude = (cols, rows = 40) => `${FIXTURE}\n${promptBlock}\nshow_install_banner() { echo "BANNER-INSTALL"; }\n${displayFns}\n` +
    `SC_ORIG_STDOUT_IS_TTY=1\nIUI_COLS=${cols}\nIUI_ROWS=${rows}\nIUI_ANIM_REPAINT_TICKS=4\n: > '${B(logFile)}'\nexec 4>'${B(screenFile)}'\n`;
  const readScreen = () => fs.readFileSync(screenFile, 'utf8');
  // Kode kursor dibuat terbaca: <ATn> = pindah ke baris n, <EL> = hapus sampai
  // ujung baris, <ED> = hapus sampai ujung layar.
  const decode = (raw) => stripAnsi(raw
    .replace(/\x1b\[H\x1b\[2J/g, '<CLEAR>')
    .replace(/\x1b\[(\d+);1H/g, '<AT$1>').replace(/\x1b\[K/g, '<EL>').replace(/\x1b\[J/g, '<ED>')
    .replace(/\x1b\[\?25l/g, '<HIDE>').replace(/\x1b\[\?25h/g, '<SHOW>'));
  const paintsOf = (screen) => [...screen.matchAll(/<AT(\d+)>([^<]*)<EL>/g)].map((m) => ({ row: Number(m[1]), text: m[2] }));
  const inner = (text) => text.replace(/^ │ /, '').replace(/ │$/, '').trim();
  const pidGone = (pid) => spawnSync(bash, ['-c', `kill -0 ${pid} 2>/dev/null`]).status !== 0;
  const waitGone = (pid) => {
    for (let i = 0; i < 40 && !pidGone(pid); i++) spawnSync(bash, ['-c', 'sleep 0.1']);
    return pidGone(pid);
  };
  const WALL = 'haproxy[61442]: backend bk_sshws_tls has no server available!';
  // Kecepatan tick animasi bergantung beban mesin, jadi skenario menunggu
  // sampai tulisannya benar-benar muncul di layar, bukan tidur selama waktu
  // tertentu lalu berharap animasi sudah sempat menggambar.
  const WAIT_HELPERS = `
wait_for() {
  local i
  for ((i = 0; i < 200; i++)); do
    if grep -qF -- "$1" '${B(screenFile)}' 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  return 0
}
count_repaints() { grep -oF -- "$(printf '\\033[J')" '${B(screenFile)}' 2>/dev/null | wc -l; }
wait_repaint() {
  local base i
  base="$(count_repaints)"
  for ((i = 0; i < 200; i++)); do
    if (( $(count_repaints) > base )); then return 0; fi
    sleep 0.1
  done
  return 0
}`;

  for (const [term, cols] of [['xterm-256color', 80], ['linux', 44]]) {
    const r = run(`${animPrelude(cols)}
${WAIT_HELPERS}
install_display_start
echo "\${IUI_ANIM_PID}" > '${B(pidFile)}'
echo "BARIS-RINCI-LANGKAH-SATU"
show_install_progress 8 "Install paket dasar"
printf 'Setting up nginx-common (1.22.1-9) ...\\r\\n'
wait_for 'Setting up nginx-common'
# Meteran unduhan curl: deretan angka yang ditulis ulang dengan \\r.
printf '  %% Total    %% Received %% Xferd  Average Speed   Time    Time     Time  Current\\n'
printf '  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\\r'
sleep 1.5
# Siaran wall dari journald: ditulis langsung ke terminal, bukan oleh installer.
printf '\\r\\n\\r\\nBroadcast message from systemd-journald@vps (Wed 2026-09-30 19:30:12 WIB):\\r\\n\\r\\n${WALL}\\r\\n\\r\\n' >&4
show_install_progress 60 "Setup ZIVPN"
wait_for 'Setup ZIVPN'
wait_repaint
echo "unduh selesai"
wait_for 'unduh selesai'
show_install_progress 100 "Berhasil keinstall semua."
wait_for '100%'
install_display_finish
false
`, { TERM: term, STY: '' });
    // Setelah install_display_finish trap dilepas: kegagalan berikutnya tidak
    // boleh memunculkan layar gagal.
    assert.strictEqual(r.status, 1, `animasi ${term}:\n${r.stdout}\n${r.stderr}`);
    const raw = readScreen();
    const screen = decode(raw);
    const bw = Math.min(78, Math.max(40, cols - 2));
    assert(screen.startsWith('<HIDE><CLEAR>'), 'animasi harus mulai dari layar bersih dengan kursor tersembunyi');

    // Tidak ada gerak kursor relatif dan tidak ada newline dari animasi:
    // semua baris digambar di posisi tetap, jadi tulisan dari luar tidak bisa
    // menggeser kotak dan animasi sendiri tidak pernah menggulung layar.
    assert(!/\x1b\[\d*[ABCDEF]/.test(raw), 'animasi tidak boleh memakai gerak kursor relatif');
    // Siaran wall ditulis ke terminal bersamaan dengan animasi, jadi di level
    // byte bisa berbaur dengan kode kursor. Cek teksnya setelah kode dibuang.
    assert(stripAnsi(raw).replace(/\s+/g, ' ').includes('backend bk_sshws_tls has no server available!'),
      'siaran wall tiruan tidak ditemukan di tangkapan layar');
    // Animasi memakai posisi mutlak, bukan newline, untuk menggambar (dicek juga
    // lewat larangan gerak kursor relatif di atas). Baris kotak yang digambar
    // ulang penuh kira-kira 5 detik sekali: itu yang memulihkan layar setelah
    // tulisan dari luar. Detailnya diperiksa di bagian pemulihan di bawah.

    const paints = paintsOf(screen);
    const topRow = (paints.find((p) => p.text.includes('[ INSTALASI ]')) || {}).row;
    assert.strictEqual(topRow, 6, 'dengan terminal tinggi, kotak berada di bawah banner');
    const row1 = topRow + 1;
    const park = row1 + 5; // tiga baris isi, garis bawah, satu baris petunjuk
    const isDynamic = (p) => p.row >= row1 && p.row <= row1 + 2;
    for (const text of ['S C   1 F O R C R   N E X U S', 'MEMASANG', 'Jangan tutup terminal ini.']) {
      assert(paints.some((p) => !isDynamic(p) && p.text.includes(text)), `kerangka animasi harus memuat: ${text}`);
    }
    assert(paints.every((p) => p.row >= 1 && p.row < park), 'tidak boleh menggambar di luar kerangka');
    for (const p of paints.filter((q) => isDynamic(q) || isFrame(q.text) || isBanner(q.text))) {
      assert.strictEqual(width(p.text), bw + 1, `baris animasi tidak lurus (${term}, baris ${p.row}):\n${p.text}`);
    }
    // Setiap baris isi diikuti parkir kursor di bawah kotak.
    for (const m of screen.matchAll(/<AT(\d+)>[^<]*<EL><AT(\d+)>/g)) {
      if (Number(m[1]) >= row1 && Number(m[1]) <= row1 + 2) assert.strictEqual(Number(m[2]), park, 'kursor harus diparkir di bawah kotak');
    }

    const at = (n) => paints.filter((p) => p.row === n).map((p) => p.text);
    assert(at(row1).some((l) => l.includes('Install paket dasar')) && at(row1).some((l) => l.includes('Setup ZIVPN')), 'langkah yang sedang jalan harus tampil');
    assert(at(row1).every((l) => /\d\d:\d\d │$/.test(l)), 'waktu berjalan harus tampil di ujung baris');
    assert(new Set(at(row1).map((l) => l.slice(3, 4))).size >= 2, 'spinner harus berganti bentuk');
    const percents = at(row1 + 1).map((l) => Number((l.match(/(\d+)% │$/) || [])[1]));
    assert(percents.length >= 3 && percents.every((p, i) => i === 0 || p >= percents[i - 1]), `bar harus naik: ${percents}`);
    assert.strictEqual(percents[percents.length - 1], 100, 'bar harus penuh sebelum layar diganti');

    const details = at(row1 + 2).map(inner);
    const iNginx = details.indexOf('Setting up nginx-common (1.22.1-9) ...');
    const iDone = details.indexOf('unduh selesai');
    assert(iNginx >= 0 && iDone > iNginx, `baris log terakhir harus tampil: ${JSON.stringify(details)}`);
    assert(details.every((d) => !d.includes('--:--:--') && !d.includes('% Total')), 'meteran unduhan curl tidak ditampilkan');
    assert(details.every((d) => !/\[[=-]+\] +\d+%/.test(d)), 'baris progres installer tidak perlu diulang sebagai rincian');
    assert(details.slice(iNginx + 1, iDone).includes(''), 'rincian langkah lama harus dikosongkan saat langkah berganti');

    // Pulih sendiri: setelah siaran wall, seluruh kerangka digambar ulang di
    // posisi yang sama dan sisa tulisan di bawah kotak dihapus.
    const afterWall = screen.slice(screen.indexOf(WALL) + WALL.length);
    assert(afterWall.includes(`<AT${park}><ED>`), 'tulisan dari luar harus dibersihkan oleh gambar ulang berikutnya');
    const healed = paintsOf(afterWall);
    assert(healed.some((p) => p.row === topRow && p.text.includes('[ INSTALASI ]')), 'garis atas kotak harus digambar ulang di baris yang sama');
    assert(healed.some((p) => p.row === row1 && p.text.includes('Setup ZIVPN')), 'isi kotak tetap di baris yang sama setelah siaran wall');
    assert(healed.every((p) => p.row < park), 'kotak tidak boleh ikut bergeser ke bawah');

    assert(screen.trimEnd().endsWith('<SHOW>'), 'kursor harus dimunculkan lagi');
    assert(!screen.includes('INSTALL GAGAL'));
    if (term === 'linux') assert(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(raw), 'konsol teks memakai spinner ASCII');
    else assert(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(raw), 'terminal modern memakai spinner braille');

    // Keluaran rinci hanya ke log, bukan ke terminal.
    const log = fs.readFileSync(logFile, 'utf8');
    assert(log.includes('BANNER-INSTALL') && log.includes('BARIS-RINCI-LANGKAH-SATU') && /\] +8% \| Install paket dasar/.test(log));
    assert(!r.stdout.includes('BARIS-RINCI-LANGKAH-SATU'), 'keluaran rinci tidak boleh lolos ke stdout');
    assert(waitGone(fs.readFileSync(pidFile, 'utf8').trim()), 'proses animasi harus berhenti');
    assert(!fs.existsSync(path.join(tmpDir, 'install-anim.state')), 'file status animasi harus dibersihkan');
  }

  // Terminal pendek: banner dibuang supaya kotaknya tetap muat. Di dalam GNU
  // screen ada petunjuk untuk menyambung lagi dengan nama sesi yang sedang jalan.
  {
    const r = run(`${animPrelude(80, 9)}
${WAIT_HELPERS}
install_display_start
show_install_progress 8 "Install paket dasar"
wait_for 'Putus? Jalankan'
wait_for 'Install paket dasar'
install_display_finish
`, { TERM: 'xterm-256color', STY: '4242.1forcr-sc' });
    assert.strictEqual(r.status, 0, r.stderr);
    const paints = paintsOf(decode(readScreen()));
    assert.strictEqual((paints.find((p) => p.text.includes('[ INSTALASI ]')) || {}).row, 1, 'di terminal pendek kotak mulai dari baris pertama');
    assert(!paints.some((p) => isBanner(p.text)), 'banner tidak digambar di terminal pendek');
    assert(paints.some((p) => p.row === 7 && p.text.includes('Putus? Jalankan: screen -r 1forcr-sc')), 'petunjuk screen harus memakai nama sesi yang jalan');
    assert(paints.every((p) => p.row <= 7), 'tidak boleh menggambar melewati tinggi terminal');
  }

  // Install gagal di tengah jalan: animasi berhenti dan penyebabnya (ujung
  // log) ditampilkan, karena keluaran rinci tidak pernah sampai ke terminal.
  {
    const r = run(`${animPrelude(80)}
${WAIT_HELPERS}
install_display_start
echo "\${IUI_ANIM_PID}" > '${B(pidFile)}'
show_install_progress 2 "Validasi lisensi"
wait_for 'Validasi lisensi'
echo "Install ditolak: IP VPS belum terdaftar."
exit 7
`, { TERM: 'xterm-256color', STY: '' });
    assert.strictEqual(r.status, 7, 'kode keluar asli harus dipertahankan');
    const screen = decode(readScreen()).replace(/\s+/g, ' ');
    const report = screen.slice(screen.lastIndexOf('<CLEAR>'));
    assert(screen.lastIndexOf('<CLEAR>') > screen.indexOf('[ INSTALASI ]'), 'layar dibersihkan sebelum laporan gagal');
    assert(report.includes('INSTALL GAGAL (kode 7) di langkah: Validasi lisensi'), report.slice(0, 600));
    assert(report.includes('Akhir log:') && report.includes('Install ditolak: IP VPS belum terdaftar.'));
    assert(report.includes(`Log lengkap: ${B(logFile)}`));
    assert(!report.includes('<AT'), 'animasi tidak boleh menggambar lagi setelah laporan gagal');
    assert(screen.lastIndexOf('<SHOW>') < screen.lastIndexOf('<CLEAR>'), 'kursor dimunculkan sebelum laporan gagal');
    assert(waitGone(fs.readFileSync(pidFile, 'utf8').trim()), 'proses animasi harus berhenti saat install gagal');
  }

  // Installer mati mendadak (SIGKILL, trap tidak sempat jalan): proses
  // animasi berhenti sendiri dan mengembalikan kursor.
  {
    run(`${animPrelude(80)}
install_display_start
echo "\${IUI_ANIM_PID}" > '${B(pidFile)}'
sleep 0.8
kill -9 $$
`, { TERM: 'xterm-256color', STY: '' });
    assert(waitGone(fs.readFileSync(pidFile, 'utf8').trim()), 'proses animasi tidak boleh tertinggal setelah installer mati');
    assert(decode(readScreen()).trimEnd().endsWith('<SHOW>'), 'kursor harus dikembalikan walau installer mati mendadak');
  }

  // Tanpa terminal, log dimatikan, terminal bodoh, terminal terlalu pendek,
  // atau INSTALL_ANIMATION=0: tampilan lama (baris progres biasa di stdout),
  // tanpa proses latar.
  for (const setup of ['SC_ORIG_STDOUT_IS_TTY=0', 'INSTALL_ANIMATION=0', 'INSTALL_LOG_DISABLE=1', 'TERM=dumb', 'IUI_ROWS=5']) {
    const r = run(`${animPrelude(80)}${setup}
install_display_start
show_install_progress 8 "Install paket dasar"
echo "pid=[\${IUI_ANIM_PID}]"
install_display_finish
`, { TERM: 'xterm-256color', STY: '' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert(r.stdout.includes('BANNER-INSTALL') && /\] +8% \| Install paket dasar/.test(r.stdout), `progres biasa harus tampil (${setup})`);
    assert(r.stdout.includes('pid=[]'), `animasi tidak boleh jalan (${setup})`);
    assert.strictEqual(readScreen(), '', `terminal tidak boleh disentuh (${setup})`);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Pemasangan di installer.
assert(installer.indexOf('# <<< installer-ui\n') < installer.indexOf('\nDOMAIN="$(sanitize_domain_host "${DOMAIN}")"\n'),
  'layar domain harus jalan sebelum DOMAIN disanitasi');
assert(installer.indexOf('\ncertificate_dns_host_valid() {') < installer.indexOf('# >>> installer-ui\n'),
  'validator domain harus sudah didefinisikan sebelum layar domain');
assert(installer.includes('  if iui_tty_ok; then\n    iui_prompt_domain || true\n  else\n    read -r -p "Masukkan domain server: " DOMAIN || true\n  fi'),
  'tanpa terminal, input domain harus tetap lewat stdin');
assert(!/^\s+read -r -p "Masukkan domain server: " DOMAIN <\/dev\/tty/m.test(installer), 'prompt domain lama harus sudah diganti');

// Ringkasan ditampilkan setelah status pending dibersihkan dan tidak boleh
// menggagalkan install; menu dibuka setelah pengguna menekan Enter.
assert(installer.includes('  clear_pending_operation\n  clear_install_resume_state\n  rm -f "${PENDING_INSTALL_SCRIPT}" >/dev/null 2>&1 || true\n' +
  '  # Setelah status pending dibersihkan, dan dengan \'|| true\': masalah tampilan\n' +
  '  # tidak boleh membuat install yang sudah selesai dianggap terputus.\n' +
  '  show_install_finished || true\n  open_menu_after_install\n}'), 'urutan akhir main() berubah');
const openMenu = extract(installer, 'open_menu_after_install() {', '\nPENDING_OP_FILE=');
assert(openMenu.indexOf('IFS= read -r enter_key </dev/tty || true') > 0 &&
  openMenu.indexOf('IFS= read -r enter_key </dev/tty || true') < openMenu.indexOf('/usr/local/sbin/menu-sc-1forcr </dev/tty'),
  'ringkasan harus ditahan sampai Enter sebelum menu membersihkan layar');

// Animasi dipasang di jalur install penuh saja: mulai setelah status pending
// dicatat, selesai (dan trap dilepas) sebelum ringkasan akhir.
assert(installer.includes('  set_pending_operation "install" "/usr/local/sbin/lanjut-install" "Install SC 1FORCR terputus sebelum selesai"\n' +
  '  install_display_start\n  show_install_progress 0 '), 'animasi harus mulai tepat sebelum langkah pertama');
assert(/show_install_progress 100 "[^"\n]*"\n  install_display_finish\n\n  clear_pending_operation\n/.test(installer),
  'animasi harus dihentikan setelah progres 100%');
const updatePath = extract(installer, '  if [[ "${UPDATE_SAFE_MODE:-0}" == "1" ]]; then\n    install_update_manager', '  # Re-run guard:');
assert(!updatePath.includes('install_display_'), 'jalur update aman tidak memakai animasi install');
assert(extract(installer, 'show_install_progress() {', '\nINSTALL_LOG_START_BYTES=').includes('  iui_anim_update "${pct}" "${msg}"\n}'),
  'setiap langkah harus memperbarui animasi');
assert(/\n    DOMAIN EMAIL [^\n]* INSTALL_ANIMATION\n/.test(extract(installer, 'persist_pending_install_env() {', '\ninstall_pending_resume_helper() {')),
  'INSTALL_ANIMATION harus ikut ke lanjut-install');
assert(installer.includes('\nINSTALL_ANIMATION="${INSTALL_ANIMATION:-1}"\n'));

// HAProxy tidak boleh mengirim log level emerg: journald dan rsyslog
// menyiarkannya ke semua terminal yang login, termasuk layar install. Config
// ditulis di dua tempat (installer dan script menu) dan keduanya harus sama.
const haproxyLogLines = installer.match(/^ {4}log \/dev\/log local0.*$/gm) || [];
assert.deepStrictEqual(haproxyLogLines, ['    log /dev/log local0 notice alert', '    log /dev/log local0 notice alert'],
  'kedua konfigurasi HAProxy harus membatasi level log paling parah ke alert');

// Token asli hanya ke terminal; salinan di log disamarkan.
const showFnText = extract(installer, 'show_install_finished() {', '\nopen_menu_after_install() {');
assert(showFnText.includes('iui_screen_finished "${API_AUTH_TOKEN}"; } >/dev/tty'));
assert(showFnText.includes('iui_screen_finished "$(mask_secret "${API_AUTH_TOKEN}")" >> "${log_file}"'));
assert(!installer.includes('API Token      : ${API_AUTH_TOKEN}'), 'ringkasan lama yang menulis token ke log harus sudah dihapus');

console.log('installer ui tests: OK');

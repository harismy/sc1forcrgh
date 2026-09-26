'use strict';

// Regresi tampilan menu utama: bingkai gradasi harus lurus di semua lebar
// layar (HP sampai desktop) dan semua mode warna, tidak ada baris yang melebihi
// lebar terminal, dan menu utama pindah 3/2/1 kolom sesuai lebar.

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

const menuRuntime = extract(installer, "cat > \"${menu_runtime_tmp}\" <<'MENU_SCRIPT_EOF'\n", '\nMENU_SCRIPT_EOF\n');
const engine = extract(menuRuntime, "MENU_ESC=$'\\033'\n", '\nif [[ "${1:-}" == "update" ]]; then');
const dashboard = extract(menuRuntime, 'dashboard_svc() {', '\ndraw_dashboard() {');

const fixture = `
clear() { :; }
D_CLIENT='DEMO CLIENT'; D_VERSION='V.1FSC.67'; D_EXPIRY='262d 1h 28m'
D_OS='Debian GNU/Linux 12 (bookworm)'; D_KERNEL='6.1.0-42-cloud-amd64'
D_CORES=2; D_LOAD1=0.35; D_LOAD5=0.40; D_LOAD15=0.41
D_RAM_USED=794; D_RAM_TOTAL=1979; D_RAM_PCT=40; D_SWAP_USED=83; D_SWAP_TOTAL=1023
D_DISK_USED=8; D_DISK_TOTAL=40; D_DISK_PCT=22; D_UPTIME='21h 22m'; D_TIME='26 Sep 2026  15:10 CST'
D_IP='203.0.113.10'; D_CITY='Jakarta'; D_ISP='AS64500 Contoh Penyedia Internet Nusantara Sangat Panjang Namanya'
DOMAIN='vpn.example.com'
VNSTAT_DAY_TOTAL='6.7GiB'; VNSTAT_DAY_RX='3.4GiB'; VNSTAT_DAY_TX='3.3GiB'
VNSTAT_MONTH_TOTAL='8.8TiB'; VNSTAT_MONTH_RX='4.5TiB'; VNSTAT_MONTH_TX='4.4TiB'
VNSTAT_RATE='38.02 Mbit/s'; VNSTAT_MONTH_NAME='September'
D_SVC_SSH=ON; D_SVC_DROPBEAR=ON; D_SVC_WS=ON; D_SVC_HAPROXY=ON; D_SVC_NGINX=ON; D_SVC_XRAY=ON
D_SVC_ZIVPN=ON; D_SVC_UDPHC=OFF; D_UDP_BACKEND=zivpn; D_HEALTH=GOOD
D_SPEC='2GB / 2 vCPU / tier 2'; D_CAP_MODE=AUTO; D_CAP_TEXT='~80 user +5'
D_LIVE_STATUS=OK; D_LIVE_ONLINE=39; D_LIVE_RAM=38.9; D_LIVE_CPU=55.8
D_ACC_SSH=63; D_ACC_VMESS=14; D_ACC_VLESS=1; D_ACC_TROJAN=6
`;

const bash = resolveBash();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-menu-ui-'));
const toBashPath = (p) => (process.platform === 'win32'
  ? spawnSync(bash, ['-c', `cygpath -u '${p}'`], { encoding: 'utf8' }).stdout.trim()
  : p);

function render(cols, mode, locale) {
  const colorFile = path.join(tmpDir, `color-${mode}`);
  fs.writeFileSync(colorFile, `${mode}\n`);
  const script = path.join(tmpDir, 'render.sh');
  fs.writeFileSync(script, `set -euo pipefail\n${engine}\n${dashboard}\n${fixture}\n` +
    `MENU_COLOR_FILE='${toBashPath(colorFile)}'\nMENU_COLS=${cols}\nUI_MODE=''\n` +
    'dashboard_render\ndraw_main_options\ndraw_menu_panel "MENU TOOLS" "1) Informasi Key Script" "17) Tema Warna Menu" "0) Kembali"\n' +
    'draw_menu_header "RESOURCE AUTO TUNE"\n');
  const result = spawnSync(bash, [toBashPath(script)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: locale, LANG: locale }
  });
  assert.strictEqual(result.status, 0, `render failed cols=${cols} mode=${mode} locale=${locale}:\n${result.stderr}`);
  return result.stdout;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const width = (s) => Array.from(stripAnsi(s)).length;

try {
  for (const locale of ['C', 'C.UTF-8']) {
    for (const mode of ['truecolor', '256', '16', 'none']) {
      for (const cols of [44, 50, 62, 80, 120]) {
        const out = render(cols, mode, locale);
        const lines = out.split('\n').filter((l) => l.length > 0);
        const bw = Math.min(78, Math.max(40, cols - 2));
        const frame = lines.filter((l) => /^ [╭│├╰▄▀]/.test(stripAnsi(l)) || /^ .*[╮┤╯]$/.test(stripAnsi(l)));
        // Kotak dashboard dan menu utama memakai lebar layout; panel submenu punya lebarnya sendiri.
        const layoutFrames = frame.slice(0, frame.findIndex((l) => stripAnsi(l).includes('[ MENU TOOLS ]')));
        for (const line of layoutFrames) {
          assert.strictEqual(width(line), bw + 1,
            `misaligned frame cols=${cols} mode=${mode} locale=${locale}:\n${stripAnsi(line)}`);
        }
        const menuToolsLine = lines.findIndex((l) => stripAnsi(l).includes("[ MENU TOOLS ]"));
        for (const line of lines.slice(0, menuToolsLine)) {
          assert(width(line) <= Math.max(cols, bw + 1),
            `line wider than terminal cols=${cols} mode=${mode}:\n${stripAnsi(line)}`);
        }
        const panel = frame.slice(frame.findIndex((l) => stripAnsi(l).includes('[ MENU TOOLS ]')));
        const panelWidth = width(panel[0]);
        for (const line of panel.slice(0, 5)) {
          assert.strictEqual(width(line), panelWidth, `submenu panel misaligned mode=${mode}:\n${stripAnsi(line)}`);
        }
        if (mode === 'none') assert(!out.includes('\x1b['), 'mode none must not emit color codes');
        if (mode === 'truecolor') assert(/\x1b\[38;2;\d+;\d+;\d+m/.test(out), 'truecolor mode must emit 24-bit colors');
        if (mode === '256') assert(/\x1b\[38;5;\d+m/.test(out), '256 mode must emit xterm-256 colors');

        const menuRows = lines.map(stripAnsi).filter((l) => l.includes('[01]') || l.includes('[02]') || l.includes('[ X]'));
        const perRow = (menuRows.find((l) => l.includes('[01]')) || '').split('[').length - 1;
        const expected = bw - 4 >= 72 ? 3 : (bw - 4 >= 48 ? 2 : 1);
        assert.strictEqual(perRow, expected, `menu columns cols=${cols}: expected ${expected}, got ${perRow}`);
        assert(lines.some((l) => stripAnsi(l).includes('AS64500 Contoh')), 'long ISP must still be shown (truncated)');
      }
    }
  }
  // Pengumpulan data jalan dengan set -euo pipefail seperti di menu asli.
  // Satu perintah gagal yang tidak ditangani membuat menu tidak bisa dibuka,
  // jadi diuji dalam kondisi terburuk: internet mati, database tidak ada,
  // dan free/df/hostname tidak tersedia.
  const collect = extract(menuRuntime, 'dashboard_net_info() {', '\ndashboard_svc() {');
  const worstCase = `
refresh_license_cache_guard() { :; }
read_license_value_global() { echo ''; }
read_sc_meta_value_global() { echo ''; }
sc_access_state_is_valid() { return 1; }
format_expiry_in() { echo 'Unlimited'; }
detect_udpcustom_service() { echo 'sc-1forcr-udpcustom'; }
onoff_word() { echo 'OFF'; }
account_active_where_expr() { echo '1=1'; }
read_vnstat_stats() { VNSTAT_DAY_TOTAL='-'; VNSTAT_DAY_RX='-'; VNSTAT_DAY_TX='-'; VNSTAT_MONTH_TOTAL='-'; VNSTAT_MONTH_RX='-'; VNSTAT_MONTH_TX='-'; VNSTAT_RATE='-'; VNSTAT_MONTH_NAME='-'; }
get_server_capacity_profile() { echo '1|1|1|30-40'; }
ensure_capacity_state_once() { :; }
read_capacity_state_value() { echo ''; }
menu_bool_01() { echo 1; }
curl() { return 7; }
sqlite3() { return 1; }
free() { return 127; }
df() { return 127; }
hostname() { return 127; }
clear() { :; }
DB_PATH=/tidak/ada.db; ZIVPN_SERVICE=zivpn; DOMAIN=vpn.example.com; SCRIPT_VERSION=V.1FSC.0
`;
  const colorFile = path.join(tmpDir, 'color-256');
  fs.writeFileSync(colorFile, '256\n');
  const script = path.join(tmpDir, 'collect.sh');
  fs.writeFileSync(script, `set -euo pipefail\n${engine}\n${collect}\n${dashboard}\n${worstCase}\n` +
    `MENU_COLOR_FILE='${toBashPath(colorFile)}'\nMENU_COLS=62\nUI_MODE=''\n` +
    'dashboard_collect\ndashboard_render\ndraw_main_options\n' +
    'echo "ACC=${D_ACC_SSH}/${D_ACC_VMESS}/${D_ACC_VLESS}/${D_ACC_TROJAN} LIVE=${D_LIVE_STATUS} IP=${D_IP} EXP=${D_EXPIRY}"\n');
  const worst = spawnSync(bash, [toBashPath(script)], { encoding: 'utf8' });
  assert.strictEqual(worst.status, 0, `dashboard must still open when everything fails:\n${worst.stderr}`);
  assert(/ACC=0\/0\/0\/0 LIVE=WAIT IP=\S+ EXP=Unlimited/.test(worst.stdout), `unexpected degraded values:\n${worst.stdout.slice(-300)}`);
  assert(stripAnsi(worst.stdout).includes('[ MAIN MENU ]'), 'main menu must render after a degraded dashboard');

  // Filter gaya ui_fx dipakai di tabel, detail akun, dan layar info.
  const sample = [
    'USERNAME                 STATUS       LIMIT_IP   SESI_AKTIF    IP_AKTIF',
    '------------------------ ------------ ---------- ------------- ----------',
    'iwhebk0872               AMAN         3          1             1',
    'send4567                 LOCK_TMP     4          3             3',
    'kaze3333                 RECENT       2          0             1',
    '',
    'Total User SSH : 25',
    'Catatan: SOCKET_AKTIF bukan jumlah perangkat/orang.',
    'ONLINE berarti ada socket hidup atau autentikasi akun.',
    '',
    '=============================',
    ' INFO QUOTA AKUN SSH',
    '=============================',
    'Username     : demo',
    'Status       : AKTIF',
    '=============================',
    '=== DIAGNOSA JARINGAN ===',
    '- Default route : default via 10.0.0.1',
    'type    username  unlock_at            remain_sec',
    '------  --------  -------------------  ----------',
    'ssh     demo      2026-09-26 15:10:00  120',
    '[ FRONT/BUG HOSTS ]',
    'Tidak ada user SSH yang sedang online.'
  ].join('\n') + '\n';
  const samplePath = path.join(tmpDir, 'sample.txt');
  fs.writeFileSync(samplePath, sample);
  const runFx = (mode, force) => {
    const cf = path.join(tmpDir, `fx-${mode}`);
    fs.writeFileSync(cf, `${mode}\n`);
    const sh = path.join(tmpDir, 'fx.sh');
    fs.writeFileSync(sh, `set -euo pipefail\n${engine}\nMENU_COLOR_FILE='${toBashPath(cf)}'\nMENU_COLS=80\nUI_MODE=''\n` +
      `${force ? 'UI_FX_FORCE=1 ' : ''}ui_fx < '${toBashPath(samplePath)}'\n`);
    const r = spawnSync(bash, [toBashPath(sh)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `ui_fx failed mode=${mode}:\n${r.stderr}`);
    return r.stdout;
  };
  assert.strictEqual(runFx('truecolor', false), sample, 'ui_fx must pass output through untouched when stdout is not a terminal');
  const fx = runFx('truecolor', true);
  const fxLines = fx.split('\n');
  const inLines = sample.split('\n');
  assert.strictEqual(fxLines.length, inLines.length, 'ui_fx must keep the line count');
  const expectedPlain = inLines.map((l) => {
    if (/^[ \t]*[-=][-= \t]*$/.test(l) && /---|===/.test(l)) return l.replace(/[-=]/g, '─');
    if (/^=== .* ===$/.test(l)) return `◆ ${l.replace(/^=== /, '').replace(/ ===$/, '')}`;
    return l;
  });
  fxLines.forEach((l, i) => assert.strictEqual(stripAnsi(l), expectedPlain[i], `ui_fx changed text on line ${i + 1}`));
  const OK = '\x1b[38;2;0;230;118m';
  const BAD = '\x1b[38;2;255;82;82m';
  const WARN = '\x1b[38;2;255;196;0m';
  const ACC = '\x1b[38;2;0;229;255m';
  const MUT = '\x1b[38;2;88;100;128m';
  assert(fxLines[0].startsWith(ACC), 'table header must use the accent color');
  assert(fxLines[2].includes(`${OK}AMAN`), 'AMAN must be green');
  assert(fxLines[3].includes(`${BAD}LOCK_TMP`), 'LOCK_TMP must be red');
  assert(fxLines[4].includes(`${WARN}RECENT`), 'RECENT must be amber');
  assert(fxLines[8].startsWith(MUT) && !fxLines[8].includes(OK), 'status words inside a note block stay muted');
  assert(fxLines[18].startsWith(ACC), 'lowercase sqlite -column header above a dash rule must be styled as a header');
  assert(fxLines[11].startsWith(ACC), 'block title between two rules must be styled as a header');
  assert(fxLines[14].startsWith('[38;2;128;146;178m'), 'a label/value line right above a closing rule must keep the label style');
  assert(fxLines[16].includes('◆ DIAGNOSA JARINGAN') && fxLines[16].startsWith(ACC), 'a rule must end the muted note block');
  assert(fxLines[22].startsWith(MUT), 'empty-state messages are muted');
  assert(!runFx('none', true).includes('\x1b['), 'mode none must not emit color codes from ui_fx');

  // echo ke layar memakai aturan gaya yang sama, jadi layar setting dan pesan
  // berhasil/gagal ikut seragam. Tanpa terminal (pipe, file, $(...)) echo
  // tetap builtin polos supaya data yang dibaca skrip lain tidak berubah.
  const menuKv = extract(menuRuntime, 'menu_kv() {', '\nmask_secret() {');
  const sayLines = [
    'Status saat ini   : AKTIF',
    'Gagal update quota.',
    'Berhasil update auto reboot:',
    'Peringatan: config haproxy invalid, restart haproxy dilewati.',
    'Cooldown gagal    : 15 menit',
    'Gagal : 0',
    'Jika sync/restart Xray gagal, pakai format: uuid',
    'Install pending belum berhasil dilanjutkan.',
    'Input status tidak valid. Gunakan 1 atau 0.',
    'Update ditolak: signature/checksum manifest installer tidak valid.',
    'ID tersimpan di DB, tapi sync/restart Xray gagal.',
    '1) Update SC aman (backup otomatis)',
    'Nilai saat ini:',
    'Status : NONAKTIF',
    'Cooldown mencegah retry versi gagal terus-menerus yang bisa memutus tunnel.'
  ];
  const sayBody = sayLines.map((l) => `echo '${l}'`).join('\n') + '\n' +
    'menu_kv "TOTAL" "3"\n' +
    'echo "-----------"\n' +
    'echo "baris" "dua"\n' +
    'IFS=$\'\\t\'; echo "a" "b"; IFS=$\' \\t\\n\'\n' +
    'echo -n "tanpa-newline"; echo\n' +
    'echo -e "x\\ty"\n' +
    'printf -v ml \'Label satu : AKTIF\\nGagal kedua.\'; echo "${ml}"\n';
  const expectedSay = [...sayLines, 'TOTAL        : 3', '-----------', 'baris dua', 'a b', 'tanpa-newline', 'x\ty',
    'Label satu : AKTIF', 'Gagal kedua.'].join('\n') + '\n';
  const runSay = (mode, force) => {
    const cf = path.join(tmpDir, `say-${mode}`);
    fs.writeFileSync(cf, `${mode}\n`);
    const sh = path.join(tmpDir, 'say.sh');
    fs.writeFileSync(sh, `set -euo pipefail\n${engine}\n${menuKv}\nMENU_COLOR_FILE='${toBashPath(cf)}'\nMENU_COLS=80\nUI_MODE=''\n` +
      `say_all() {\n${sayBody}}\n${force ? 'UI_SAY_FORCE=1 ' : ''}say_all\n` +
      'captured="$(echo "Status : AKTIF")"\n[[ "${captured}" == "Status : AKTIF" ]] || { builtin echo "CAPTURE_STYLED" >&2; exit 3; }\n');
    const r = spawnSync(bash, [toBashPath(sh)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `styled echo failed mode=${mode}:\n${r.stderr}`);
    return r.stdout;
  };
  assert.strictEqual(runSay('truecolor', false), expectedSay, 'echo must stay plain builtin output when stdout is not a terminal');
  assert.strictEqual(runSay('none', true), expectedSay, 'theme none must keep echo output byte-identical');
  const say = runSay('truecolor', true).split('\n');
  const expectedSayLines = expectedSay.split('\n');
  assert.strictEqual(say.length, expectedSayLines.length, 'styled echo must keep the line count');
  say.forEach((l, i) => assert.strictEqual(stripAnsi(l), expectedSayLines[i].replace(/^-+$/, (d) => '─'.repeat(d.length)),
    `styled echo changed text on line ${i + 1}`));
  const LBL = '\x1b[38;2;128;146;178m';
  assert(say[0].startsWith(LBL) && say[0].includes(`${OK}AKTIF`), 'settings value line must use label style and green status');
  assert(say[1].startsWith(BAD), '"Gagal ..." must be red');
  assert(say[2].startsWith(OK), '"Berhasil ..." must be green');
  assert(say[3].startsWith(WARN), '"Peringatan: ..." must be amber');
  assert(say[4].startsWith(LBL), 'a padded settings label containing "gagal" must stay a label');
  assert(say[5].startsWith(LBL), 'a zero failure counter must not be painted as an error');
  assert(!say[6].startsWith(BAD), 'instructions ("Jika ... gagal") must not be painted as an error');
  assert(say[7].startsWith(WARN), '"belum berhasil" is a warning, not a success');
  assert(say[8].startsWith(BAD), 'validation errors must be red');
  assert(say[9].startsWith(BAD), '"Update ditolak: ..." must be red, not a label');
  assert(say[10].startsWith(WARN), 'partial success ("tersimpan, tapi ... gagal") must be amber');
  assert(say[11].startsWith(ACC), 'numbered options must highlight the number like menu panels');
  assert(say[12].startsWith(ACC), 'section lines ending with a colon must be styled as a heading');
  assert(say[13].includes(`${MUT}NONAKTIF`), 'NONAKTIF must be muted');
  assert(!say[14].startsWith(BAD), 'an explanation mentioning "gagal" late in the sentence is not an error');
  assert(say[15].startsWith(LBL), 'menu_kv lines must use the label style');
  assert(say[16].includes('─'), 'rules printed with echo must become gradient lines');
  assert(!say[19].includes('\x1b[') && !say[20].includes('\x1b['), 'echo -n/-e must pass through untouched');
  assert(say[21].startsWith(LBL) && say[22].startsWith(BAD), 'multi-line echo must be styled line by line');

  // ui_monitor: data diambil sekali saat dibuka (bukan tiap detik), frame
  // tetap berwarna walau ditangkap, dan keluar bersih. Tanpa terminal, tombol
  // terbaca sebagai [q].
  const monCf = path.join(tmpDir, 'mon-truecolor');
  fs.writeFileSync(monCf, 'truecolor\n');
  const monCount = path.join(tmpDir, 'mon-count');
  const mon = path.join(tmpDir, 'mon.sh');
  fs.writeFileSync(mon, `set -euo pipefail\n${engine}\nclear() { :; }\nMENU_COLOR_FILE='${toBashPath(monCf)}'\nMENU_COLS=80\nUI_MODE=''\n` +
    `fake_screen() { echo x >> '${toBashPath(monCount)}'; draw_menu_header "VMESS USER LOGIN"; printf '%-10s %-8s\\n' USERNAME STATUS; printf '%-10s %-8s\\n' ---------- --------; printf '%-10s %-8s\\n' demo ONLINE; return 1; }\n` +
    'ui_monitor fake_screen\necho "EXIT_OK"\n');
  const monOut = spawnSync(bash, [toBashPath(mon)], { encoding: 'utf8' });
  assert.strictEqual(monOut.status, 0, `ui_monitor failed:\n${monOut.stderr}`);
  assert(monOut.stdout.includes('EXIT_OK'), 'ui_monitor must return cleanly');
  assert.strictEqual(fs.readFileSync(monCount, 'utf8').trim().split('\n').length, 1, 'snapshot mode must collect data exactly once');
  assert(monOut.stdout.includes(`${OK}ONLINE`), 'captured monitor frame must still be colored');
  assert(stripAnsi(monOut.stdout).includes('[r] ambil ulang'), 'monitor footer must show the refresh key');

  // Mode warna: default truecolor, konsol teks lama turun ke 16, GNU screen
  // ke 256 (tmux mengonversi sendiri), dan pilihan manual selalu menang.
  const modeSh = path.join(tmpDir, 'mode.sh');
  const forcedFile = path.join(tmpDir, 'mode-forced');
  fs.writeFileSync(forcedFile, '256\n');
  const modeCases = [
    ['xterm-256color', '', '', 'truecolor'],
    ['xterm', '', '', 'truecolor'],
    ['linux', '', '', '16'],
    ['vt100', '', '', '16'],
    ['screen', '', '', '256'],
    ['screen-256color', '/tmp/tmux-0/default,1,0', '', 'truecolor'],
    ['xterm-256color', '', toBashPath(forcedFile), '256']
  ];
  fs.writeFileSync(modeSh, `set -euo pipefail\n${engine}\n` + modeCases.map(([term, tmux, file]) =>
    `MENU_COLOR_FILE='${file || '/tidak/ada'}' TERM='${term}' TMUX='${tmux}' NO_COLOR='' ui_color_mode; builtin echo`).join('\n') + '\n');
  const modeOut = spawnSync(bash, [toBashPath(modeSh)], { encoding: 'utf8' });
  assert.strictEqual(modeOut.status, 0, `ui_color_mode failed:\n${modeOut.stderr}`);
  const modes = modeOut.stdout.trim().split('\n');
  modeCases.forEach(([term, tmux, file, want], i) => assert.strictEqual(modes[i], want,
    `color mode TERM=${term} TMUX=${tmux ? 'set' : 'unset'} forced=${file ? '256' : 'none'}: expected ${want}, got ${modes[i]}`));

  // Menu Tools: nomor di panel, di case, dan rentang prompt harus sama.
  // Setelah menu dihapus/dinomori ulang, satu nomor yang meleset membuat
  // pilihan membuka fungsi yang salah.
  const tools = extract(menuRuntime, 'tools_menu() {', '\n}\n');
  const panelNums = [...tools.matchAll(/^\s*"(\d+)\) [^"]+"/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const caseNums = [...tools.matchAll(/^\s*(\d+)\) /gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const promptMax = Number((tools.match(/Pilih menu \[0-(\d+)\]/) || [])[1]);
  assert.deepStrictEqual(caseNums, panelNums, 'tools menu case numbers must match the panel');
  assert.strictEqual(promptMax, Math.max(...panelNums), 'tools menu prompt range must match the last item');
  panelNums.forEach((n, i) => assert.strictEqual(n, i, `tools menu numbering must be contiguous (missing ${i})`));
  assert(!menuRuntime.includes('set_wildcard_config_menu'), 'wildcard settings menu was removed (set manually in Cloudflare DNS)');

  console.log('menu ui tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

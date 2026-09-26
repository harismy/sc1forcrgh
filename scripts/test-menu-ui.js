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
    'dashboard_render\ndraw_main_options\ndraw_menu_panel "MENU TOOLS" "1) Informasi Key Script" "18) Tema Warna Menu" "0) Kembali"\n' +
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

  console.log('menu ui tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

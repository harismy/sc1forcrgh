'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
function extract(start, end) {
  const a = installer.indexOf(start);
  assert(a >= 0, `missing ${start}`);
  const b = installer.indexOf(end, a + start.length);
  assert(b >= 0, `missing ${end}`);
  return installer.slice(a + start.length, b);
}
const source = extract("cat > \"${work}/xray_payload_shim.go\" <<'XRAY_PAYLOAD_SHIM_GO' || { rm -rf -- \"${work}\"; return 1; }\n", '\nXRAY_PAYLOAD_SHIM_GO\n');
const setup = 'setup_xray_payload_shim() {' + extract('setup_xray_payload_shim() {', '\nsetup_nginx_and_cert() {');
const rollback = '# Snapshot sebelum fitur ini' + extract('  # Snapshot sebelum fitur ini', '\n  snapshot_has_signed_guard="0"');

for (const [route, port] of [['upvmess', 10004], ['upvless', 10005], ['uptrojan', 10006]]) {
  const blocks = [...installer.matchAll(new RegExp(`    location /${route} \\{([\\s\\S]*?)\n    \\}`, 'g'))];
  assert.strictEqual(blocks.length, 2, `${route}: install and domain-change configs`);
  for (const block of blocks) assert(block[1].includes('proxy_pass http://127.0.0.1:10007;'), `${route} must pass through shim`);
  assert(new RegExp(`"/${route}":\\s*"127\\.0\\.0\\.1:${port}"`).test(source), `${route} backend unchanged`);
}
for (const [route, port] of [['vmess', 10001], ['vless', 10002], ['trojan', 10003], ['xhvless', 12002]]) {
  const blocks = [...installer.matchAll(new RegExp(`    location /${route} \\{([\\s\\S]*?)\n    \\}`, 'g'))];
  assert.strictEqual(blocks.length, route === 'xhvless' ? 4 : 2);
  for (const block of blocks) assert(new RegExp(`(?:proxy_pass http|grpc_pass grpc)://127\\.0\\.0\\.1:${port};`).test(block[1]), `${route} remains unchanged`);
}
assert(installer.includes('setup_nginx_and_cert() {\n  setup_xray_payload_shim || return 1\n'), 'shim must be ready before any Nginx change');
assert(installer.includes('run_install_step "13_nginx_httpupgrade"'), 'pending installs must also refresh the shim and Nginx routes');
assert(installer.includes('repair_unit_if_needed sc-1forcr-xray-payload-shim.service 10007 || true'), 'watchdog repairs shim');
assert(installer.includes('systemctl disable --now sc-1forcr-xray-payload-shim'), 'uninstall stops shim');
assert(installer.includes('snapshot_has_xray_payload_shim="0"'), 'rollback handles snapshots predating shim');
assert(installer.includes('sc-1forcr-sshws.service sc-1forcr-xray-payload-shim.service; do'), 'restore restarts shim');

const find = (candidates, args) => candidates.filter(Boolean).find((candidate) => {
  const r = spawnSync(candidate, args, { encoding: 'utf8' });
  return !r.error && r.status === 0;
});
const bash = find([process.env.BASH, process.platform === 'win32' && 'C:\\Program Files\\Git\\bin\\bash.exe', 'bash'], ['--version']);
assert(bash, 'bash is required');
const bashPath = (p) => process.platform === 'win32'
  ? spawnSync(bash, ['-c', 'cygpath -u "$1"', '--', p], { encoding: 'utf8' }).stdout.trim() : p;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-payload-shim-'));
try {
  const mockSetup = setup.replaceAll('/etc/systemd/system/sc-1forcr-xray-payload-shim.service', '${SHIM_TEST_UNIT}');
  // Replace filesystem operations, preserving the archived path comparison.
  const mockRollback = rollback.replaceAll('rm -f /etc/systemd/system/sc-1forcr-xray-payload-shim.service', 'rm -f "${SHIM_TEST_UNIT}"');
  const mock = spawnSync(bash, [], {
    encoding: 'utf8',
    input: `set -euo pipefail
trap 'echo "failed at line $LINENO: $BASH_COMMAND" >&2; cat "$SHIM_TEST_LOG" >&2' ERR
APP_DIR='${bashPath(tmp)}/app'
SHIM_TEST_UNIT='${bashPath(tmp)}/shim.service'
SHIM_TEST_LOG='${bashPath(tmp)}/calls'
mkdir -p "$APP_DIR"
log() { :; }
sleep() { :; }
tcp_listener_present() { [[ "$1" == "10007" ]]; }
systemctl() { echo "$*" >> "$SHIM_TEST_LOG"; }
fail_build=0
go() {
  echo build >> "$SHIM_TEST_LOG"
  [[ "$fail_build" == "0" ]] || return 1
  local out=''
  while (( $# )); do
    if [[ "$1" == "-o" ]]; then out="$2"; break; fi
    shift
  done
  printf '#!/bin/sh\\nexit 0\\n' > "$out"
}
${mockSetup}
setup_xray_payload_shim
[[ "$(grep -c '^build$' "$SHIM_TEST_LOG")" == "1" ]]
grep -q '^restart sc-1forcr-xray-payload-shim$' "$SHIM_TEST_LOG"
cp "$APP_DIR/bin/xray-payload-shim" "$APP_DIR/expected-bin"
cp "$APP_DIR/go/xray_payload_shim.go" "$APP_DIR/expected-source"
: > "$SHIM_TEST_LOG"
setup_xray_payload_shim
[[ "$(grep -c '^build$' "$SHIM_TEST_LOG" || true)" == "0" ]]
[[ "$(grep -c '^restart ' "$SHIM_TEST_LOG" || true)" == "0" ]]
grep -q '^start sc-1forcr-xray-payload-shim$' "$SHIM_TEST_LOG"
# Failed build keeps the old runtime and source; Nginx is not reached.
printf '// older source\\n' >> "$APP_DIR/go/xray_payload_shim.go"
cp "$APP_DIR/go/xray_payload_shim.go" "$APP_DIR/expected-source"
fail_build=1
: > "$SHIM_TEST_LOG"
${'setup_nginx_and_cert() {\n  setup_xray_payload_shim || return 1\n  echo nginx-changed >> "$SHIM_TEST_LOG"\n}'}
if setup_nginx_and_cert; then exit 31; fi
cmp -s "$APP_DIR/bin/xray-payload-shim" "$APP_DIR/expected-bin"
cmp -s "$APP_DIR/go/xray_payload_shim.go" "$APP_DIR/expected-source"
[[ "$(grep -c '^nginx-changed$' "$SHIM_TEST_LOG" || true)" == "0" ]]
[[ "$(grep -c '^restart ' "$SHIM_TEST_LOG" || true)" == "0" ]]
[[ -z "$(find "$APP_DIR/go" -name '.xray-payload-shim.*' -print)" ]]
# An old snapshot disables/removes a newly introduced shim.
snapshot_dir="$APP_DIR/old-snapshot"
mkdir -p "$snapshot_dir"
tar -czf "$snapshot_dir/files.tar.gz" -T /dev/null
: > "$SHIM_TEST_LOG"
${mockRollback}
[[ ! -e "$SHIM_TEST_UNIT" && ! -e "$APP_DIR/bin/xray-payload-shim" && ! -e "$APP_DIR/go/xray_payload_shim.go" ]]
grep -q '^disable sc-1forcr-xray-payload-shim.service$' "$SHIM_TEST_LOG"
# A snapshot with a shim keeps its files for the normal tar restore/restart.
snapshot_dir="$APP_DIR/new-snapshot"
mkdir -p "$snapshot_dir/etc/systemd/system"
printf 'unit\\n' > "$snapshot_dir/etc/systemd/system/sc-1forcr-xray-payload-shim.service"
tar -czf "$snapshot_dir/files.tar.gz" -C "$snapshot_dir" etc/systemd/system/sc-1forcr-xray-payload-shim.service
printf 'unit\\n' > "$SHIM_TEST_UNIT"
cp "$APP_DIR/expected-bin" "$APP_DIR/bin/xray-payload-shim"
cp "$APP_DIR/expected-source" "$APP_DIR/go/xray_payload_shim.go"
: > "$SHIM_TEST_LOG"
${mockRollback}
[[ -e "$SHIM_TEST_UNIT" && -e "$APP_DIR/bin/xray-payload-shim" && -e "$APP_DIR/go/xray_payload_shim.go" ]]
[[ "$(grep -c '^disable ' "$SHIM_TEST_LOG" || true)" == "0" ]]
`,
    timeout: 30000
  });
  assert.strictEqual(mock.status, 0, `installer behavior failed:\n${mock.stdout}${mock.stderr}`);

  const go = find([process.env.GO_BIN, 'go'], ['version']);
  if (!go) {
    console.log('payload shim installer checks passed (set GO_BIN for Go runtime tests)');
  } else {
    fs.writeFileSync(path.join(tmp, 'xray_payload_shim.go'), source + '\n');
    fs.copyFileSync(path.join(__dirname, 'go', 'xray_payload_shim_test.go'), path.join(tmp, 'xray_payload_shim_test.go'));
    const env = { ...process.env, GO111MODULE: 'off', GOFLAGS: '' };
    for (const args of [['vet', '.'], ['test', '-count=1', '-timeout=45s', '.']]) {
      const r = spawnSync(go, args, { cwd: tmp, env, encoding: 'utf8', timeout: 120000 });
      assert.strictEqual(r.status, 0, `${args.join(' ')} failed:\n${r.stdout}${r.stderr}`);
    }
    for (const arch of ['amd64', 'arm64']) {
      const r = spawnSync(go, ['build', '-o', path.join(tmp, `shim-${arch}`), 'xray_payload_shim.go'], {
        cwd: tmp, env: { ...env, GOOS: 'linux', GOARCH: arch }, encoding: 'utf8', timeout: 120000
      });
      assert.strictEqual(r.status, 0, `Linux ${arch} build failed:\n${r.stdout}${r.stderr}`);
    }
    console.log('payload shim installer, runtime, vet, Linux amd64/arm64 build tests passed');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

'use strict';

// Regresi hot-add user Xray: akun baru tidak boleh me-restart Xray (restart
// memutus semua pengguna vmess/vless/trojan), tapi penghapusan, pergantian
// kredensial, dan perubahan struktur tetap harus lewat restart. HandlerService
// hanya boleh aktif kalau port API tertutup untuk pengguna tunnel.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

const apiSource = extract(installer, "cat > \"${APP_DIR}/api.js\" <<'EOF'\n", '\nEOF\n');
const checkerSource = extract(installer, "cat > \"${APP_DIR}/iplimit-checker.js\" <<'EOF'\n", '\nEOF\n');

// Logika murni diuji langsung; bagian yang menjalankan perintah ada setelah
// komentar rule iptables.
const pureHelpers = extract(apiSource, 'function canonicalXrayJson(', '// Rule iptables yang dipasang');
const context = vm.createContext({});
new vm.Script(`${pureHelpers}\nthis.plan = planXrayUserHotAdd; this.parseAdded = parseXrayAddedUserCount;`).runInContext(context);
const plan = (running, next) => JSON.parse(JSON.stringify(context.plan(running, next)));

function config({ services = ['HandlerService', 'StatsService'], vmess = [], vless = [], path: wsPath = '/vmess' } = {}) {
  return JSON.parse(JSON.stringify({
    inbounds: [
      { tag: 'api', listen: '127.0.0.1', port: 10085, protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } },
      {
        tag: 'vmess-ws', port: 10001, listen: '127.0.0.1', protocol: 'vmess',
        settings: { clients: vmess.map(([email, id]) => ({ id, alterId: 0, email })) },
        streamSettings: { network: 'ws', wsSettings: { path: wsPath } }
      },
      {
        tag: 'vless-ws', port: 10002, listen: '127.0.0.1', protocol: 'vless',
        settings: { clients: vless.map(([email, id]) => ({ id, email })), decryption: 'none' },
        streamSettings: { network: 'ws', security: 'none', wsSettings: { path: '/vless' } }
      },
      {
        tag: 'vmess-grpc', port: 11001, listen: '127.0.0.1', protocol: 'vmess',
        settings: { clients: vmess.map(([email, id]) => ({ id, alterId: 0, email })) },
        streamSettings: { network: 'grpc', grpcSettings: { serviceName: 'vmess-grpc' } }
      }
    ],
    api: { tag: 'api', services }
  }));
}

const A = ['alice', '11111111-1111-1111-1111-111111111111'];
const B = ['bob', '22222222-2222-2222-2222-222222222222'];
const C = ['carol', '33333333-3333-3333-3333-333333333333'];

// Akun baru: user dikirim ke setiap inbound protokolnya (ws dan grpc),
// dengan tag dan setting inbound lain tetap ikut.
const added = plan(config({ vmess: [A], vless: [B] }), config({ vmess: [A, C], vless: [B] }));
assert.deepStrictEqual(added.map((inbound) => inbound.tag), ['vmess-ws', 'vmess-grpc']);
assert.deepStrictEqual(added[0].settings.clients, [{ id: C[1], alterId: 0, email: 'carol' }]);
assert.strictEqual(added[0].streamSettings.wsSettings.path, '/vmess');

const vlessAdded = plan(config({ vless: [A] }), config({ vless: [A, B] }));
assert.deepStrictEqual(vlessAdded.map((inbound) => inbound.tag), ['vless-ws']);
assert.strictEqual(vlessAdded[0].settings.decryption, 'none', 'vless inbound needs decryption to be parsed by adu');

// Config lama yang tidak memuat HandlerService harus restart sekali.
assert.strictEqual(context.plan(config({ services: ['StatsService'], vmess: [A] }), config({ vmess: [A, C] })), null);
// Perubahan struktur (misalnya path) tidak bisa diterapkan lewat API user.
assert.strictEqual(context.plan(config({ vmess: [A] }), config({ vmess: [A, C], path: '/baru' })), null);
// Mengaktifkan HandlerService juga perubahan struktur.
assert.strictEqual(context.plan(config({ vmess: [A] }), config({ services: ['StatsService'], vmess: [A, C] })), null);
// User dicabut: sesi lamanya hanya putus lewat restart.
assert.strictEqual(context.plan(config({ vmess: [A, C] }), config({ vmess: [A] })), null);
// Kredensial berganti: kredensial lama harus berhenti bekerja.
assert.strictEqual(context.plan(config({ vmess: [A] }), config({ vmess: [['alice', '99999999-9999-9999-9999-999999999999']] })), null);
// Email ganda atau kosong tidak bisa dipetakan ke operasi per user.
assert.strictEqual(context.plan(config({ vmess: [A] }), config({ vmess: [A, A] })), null);
assert.strictEqual(context.plan(config({ vmess: [A] }), config({ vmess: [A, ['', C[1]]] })), null);

// Inbound tanpa tag tidak bisa disasar HandlerService.
const untaggedRunning = config({ vmess: [A] });
const untaggedNext = config({ vmess: [A, C] });
delete untaggedRunning.inbounds[1].tag;
delete untaggedNext.inbounds[1].tag;
assert.strictEqual(context.plan(untaggedRunning, untaggedNext), null);

// Urutan key berbeda (misalnya config ditulis Summary API) bukan perubahan.
const reordered = config({ vmess: [A] });
reordered.inbounds[1].settings.clients = [{ email: 'alice', alterId: 0, id: A[1] }];
assert.deepStrictEqual(plan(reordered, config({ vmess: [A] })), []);

// adu tetap exit 0 walau sebagian user gagal; hanya ringkasan yang dipercaya.
assert.strictEqual(context.parseAdded('processing inbound: vmess-ws\nadd user: carol\nresult: ok\nAdded 1 user(s) in total.\n'), 1);
assert.strictEqual(context.parseAdded('add user: carol\nrpc error: code = Unknown desc = User carol already exists.\nAdded 0 user(s) in total.\n'), 0);
assert.strictEqual(context.parseAdded('unknown command "adu"'), -1);

// Rencana harus dihitung dari config yang sedang berjalan, sebelum file
// ditimpa; restart paksa (lock/unlock manual) tidak boleh lewat hot-add.
const writer = extract(apiSource, 'function writeXrayConfigAndReload(', '\nfunction run(sql');
const planIndex = writer.indexOf('const hotAdd = forceRestart ? null : prepareXrayUserHotAdd(cfgPath, cfg);');
assert(planIndex > 0, 'hot-add plan must be skipped for forced restarts');
assert(planIndex < writer.indexOf('fs.renameSync(tmpPath, cfgPath)'), 'hot-add plan must be computed before the config file is replaced');
const setStatus = extract(apiSource, 'async function setStatusXray(', '\n}\n');
assert(/writeXrayConfigAndReload\(cfg, true\)/.test(setStatus), 'manual lock/unlock must keep restarting Xray to drop old sessions');

// API dan checker harus menulis config dengan struktur yang sama; selisih
// sekecil apa pun membuat penambahan user berikutnya jatuh ke restart.
const builder = (source) => extract(source, 'function buildXrayRuntimeConfig(', '\n}\n');
assert.strictEqual(builder(apiSource), builder(checkerSource), 'API and checker must build identical Xray configs');
for (const tag of ['vmess-ws', 'vless-ws', 'trojan-ws', 'vmess-grpc', 'vless-grpc', 'trojan-grpc']) {
  assert(builder(apiSource).includes(`tag: '${tag}'`), `inbound tag ${tag} missing`);
}
const serviceLists = (source) => extract(source, 'function xrayApiServices() {', '\n}\n')
  .match(/\['[A-Za-z]+Service'(?:, '[A-Za-z]+Service')*\]/g);
assert.deepStrictEqual(serviceLists(apiSource), ["['HandlerService', 'StatsService']", "['StatsService']"]);
assert.deepStrictEqual(serviceLists(checkerSource), serviceLists(apiSource), 'API and checker must enable the same Xray API services');

// HandlerService bisa menambah user, jadi API dan checker hanya
// mengaktifkannya kalau rule iptables yang sama persis terpasang.
const guard = extract(installer, 'apply_tunnel_outbound_guard_rules() {', '\n}\n');
const ruleMatch = guard.match(/iptables -w 10 -I (OUTPUT -o lo -p tcp -d 127\.0\.0\.1 --dport 10085 [^>]+?) >\/dev\/null/);
assert(ruleMatch, 'installer must block non-root access to the Xray API port');
const installerRule = ruleMatch[1].trim();
const jsRule = (source, startMarker, endMarker) => extract(source, startMarker, endMarker)
  .match(/'([^']*)'/g).map((token) => token.slice(1, -1)).filter((token) => token !== '-w' && token !== '5' && token !== '-C' && token !== 'iptables');
assert.strictEqual(jsRule(apiSource, 'const XRAY_API_GUARD_RULE = [', '];').join(' '), installerRule, 'API guard check must match the installer rule');
assert.strictEqual(jsRule(checkerSource, "const ruleOk = safeExec('iptables'", ');').join(' '), installerRule, 'checker guard check must match the installer rule');

console.log('xray hot-add tests passed');

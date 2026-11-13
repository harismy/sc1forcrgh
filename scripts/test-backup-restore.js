// Local HTTP E2E: bot handlers -> Summary API -> core API -> generated Python/SQLite.
// Linux service/user commands are simulated by test-backup-restore.py, never run on the host.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repo, 'scripts/setup-autoscript-compat.sh'), 'utf8');
const summary = fs.readFileSync(path.join(repo, 'scripts/setup-summary-api.sh'), 'utf8');
const bot = fs.readFileSync(path.join(repo, 'app3.js'), 'utf8');
const extract = (source, start, end, includeEnd = false) => {
  const a = source.indexOf(start);
  assert(a >= 0, start);
  const b = source.indexOf(end, a + start.length);
  assert(b > a, end);
  return source.slice(a, b + (includeEnd ? end.length : 0));
};
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pyTest = path.join(__dirname, 'test-backup-restore.py');
const sourceNotifyToken = '123456789:source_notify_token_for_tests_only';
const sourceNotifyChat = '-1001234567890';
const sourceBannerHtml = '<h1>Banner sumber</h1><p>Selamat datang — uji</p>';
const sourceBannerTxt = 'Banner sumber\nAkun premium\n';

function engine(mode, root, input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [pyTest, 'engine', mode, root, input || '-', output || '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (data) => { err += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve('') : reject(new Error(err || 'engine failed')));
  });
}

function seed(root, role) {
  for (const name of ['etc/sc-1forcr/slowdns', 'opt/sc-1forcr']) fs.mkdirSync(path.join(root, name), { recursive: true });
  const fromSource = role === 'source';
  const notification = `TELEGRAM_BOT_TOKEN=${fromSource ? sourceNotifyToken : '987654321:destination_notify_token_for_tests_only'}\nTELEGRAM_CHAT_ID=${fromSource ? sourceNotifyChat : '778899'}\nONLINE_NOTIFY_ENABLE=${fromSource ? '1' : '0'}\nONLINE_NOTIFY_INTERVAL_HOURS=${fromSource ? '9' : '3'}\nBOT_PANEL_TOKEN=${role}-seller-token\nBOT_PANEL_ADMIN_IDS=${fromSource ? '112233' : '998877'}\n`;
  const auth = fromSource ? 'source-api-token' : 'target-token';
  fs.writeFileSync(path.join(root, 'etc/sc-1forcr.env'), `DOMAIN=old.example.com\nSLOWDNS_ENABLE=1\nSLOWDNS_NS_DOMAIN=ns-old.example.com\nAUTH_TOKEN=${auth}\nVPS_PUBLIC_IP=203.0.113.9\n${notification}`);
  fs.writeFileSync(path.join(root, 'opt/sc-1forcr/.env'), `DOMAIN=old.example.com\nAUTH_TOKEN=${auth}\n${notification}`);
  fs.writeFileSync(path.join(root, 'etc/sc-1forcr/banner.html'), fromSource ? sourceBannerHtml : '<p>Destination old banner</p>');
  fs.writeFileSync(path.join(root, 'etc/sc-1forcr/banner.txt'), fromSource ? sourceBannerTxt : 'Destination old text banner');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  fs.writeFileSync(path.join(root, 'etc/sc-1forcr/slowdns/server.key'), privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex') + '\n');
  fs.writeFileSync(path.join(root, 'etc/sc-1forcr/slowdns/server.pub'), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') + '\n');
  const schema = extract(installer, "sqlite3 \"${DB_PATH}\" <<'SQL'\nCREATE TABLE IF NOT EXISTS account_sshs", '\nSQL\n').split("<<'SQL'\n")[1];
  const db = new DatabaseSync(path.join(root, 'accounts.db'));
  db.exec(schema);
  db.exec("CREATE TABLE IF NOT EXISTS servers (key TEXT); INSERT INTO servers VALUES('server-token');");
  db.prepare('INSERT INTO account_sshs(username,password,date_exp,status,quota,limitip) VALUES(?,?,?,?,?,?)').run('e2euser', 'password1', '2099-12-31 20:00:00', 'AKTIF', 50, 2);
  db.close();
}

function readEnv(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.includes('=') && !line.startsWith('#')).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1).replace(/^(['"])(.*)\1$/, '$2')];
  }));
}

function assertNotificationRestored(root, token, chat) {
  for (const file of ['etc/sc-1forcr.env', 'opt/sc-1forcr/.env']) {
    const env = readEnv(path.join(root, file));
    assert.strictEqual(env.TELEGRAM_BOT_TOKEN, token);
    assert.strictEqual(env.TELEGRAM_CHAT_ID, chat);
    assert.strictEqual(env.BOT_PANEL_TOKEN, 'destination-seller-token');
    assert.strictEqual(env.BOT_PANEL_ADMIN_IDS, '998877');
    assert.strictEqual(env.AUTH_TOKEN, 'target-token');
  }
}

function assertBannerRuntime(root, enabled, compactExpected = true) {
  const sshd = fs.readFileSync(path.join(root, 'etc/ssh/sshd_config'), 'utf8');
  assert(sshd.includes('Port 2222') && sshd.includes('PermitRootLogin yes') && sshd.includes('AllowTcpForwarding local'));
  assert(enabled ? /^\s*Banner\s+(?!none\s*$)\S+/m.test(sshd) : /^\s*Banner\s+none\s*$/m.test(sshd));
  const override = fs.readFileSync(path.join(root, 'etc/systemd/system/dropbear.service.d/override.conf'), 'utf8');
  const defaults = readEnv(path.join(root, 'etc/default/dropbear'));
  assert.strictEqual(defaults.DROPBEAR_PORT, '109');
  assert(override.includes('-p 109') && override.includes('-p 143') && /(?:^|\s)-w(?:\s|$)/m.test(override) && /(?:^|\s)-k(?:\s|$)/m.test(override));
  assert(/(?:^|\s)-w(?:\s|$)/.test(defaults.DROPBEAR_EXTRA_ARGS) && /(?:^|\s)-k(?:\s|$)/.test(defaults.DROPBEAR_EXTRA_ARGS));
  const bannerArg = (text) => {
    const match = text.match(/(?:^|\s)-b\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/m);
    return match ? (match[1] || match[2] || match[3]) : '';
  };
  const overrideTarget = bannerArg(override);
  const defaultTargets = [bannerArg(defaults.DROPBEAR_EXTRA_ARGS), defaults.DROPBEAR_BANNER || ''].filter(Boolean);
  if (enabled && compactExpected) {
    assert(overrideTarget && defaultTargets.length, 'small restored banner is enabled in override and defaults');
  } else {
    assert(!overrideTarget && !defaultTargets.length, 'empty/oversize banner cannot become a Dropbear -b target');
  }
  for (let target of [overrideTarget, ...defaultTargets].filter(Boolean)) {
      if (!fs.existsSync(target) && target.startsWith('/etc/')) target = path.join(root, target.slice(1));
      assert.strictEqual(path.basename(target), 'banner.html');
      assert(fs.statSync(target).size <= 1990, 'Dropbear banner stays within its runtime limit');
  }
}

async function listen(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function core(root) {
  const app = express();
  app.use((req, res, next) => req.headers.authorization === 'target-token' ? next() : res.status(401).json({ message: 'unauthorized' }));
  const jsonBodyParser = express.json({ limit: '1mb' });
  vm.runInNewContext(extract(installer, 'app.use((req, res, next) => {\n  if ([\'/vps/backup/restore\'', "\n\nprocess.on('unhandledRejection'"), { app, jsonBodyParser });
  const context = {
    app, fs, crypto, require, express, BACKUP_WEB_ENABLE: true,
    ok: (res, data) => res.json({ meta: { code: 200 }, data }),
    fail: (res, code, message) => res.status(code).json({ meta: { code }, message }),
    backupFileFullPath: (name) => /^[a-z0-9._-]+\.json$/i.test(name) ? path.join(root, name) : '',
    runScriptAsync: (cmd, args) => cmd.endsWith('auto-backup')
      ? engine('export', root, '-', args[1]) : engine('import', root, args[0]),
  };
  vm.createContext(context);
  vm.runInContext(extract(installer, 'function restoreBodyParser(req, res, next) {', '\n\nconst BACKUP_WEB_PAGE'), context);
  vm.runInContext(extract(installer, "app.post('/vps/backup/export'", "app.post('/vps/backup/import', restoreBodyParser, restoreAccountBackup);", true), context);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));
  return { ...(await listen(app)), context };
}

async function bridge(root, coreUrl) {
  const app = express();
  const context = {
    app, express, fs, fetch, AbortController, setTimeout, clearTimeout,
    USE_DB_AUTH: true, STATIC_TOKEN: '',
    openDatabase: () => {
      const db = new DatabaseSync(path.join(root, 'accounts.db'));
      return {
        get: (sql, args, cb) => { try { cb(null, db.prepare(sql).get(...args)); } catch (err) { cb(err); } },
        close: () => db.close()
      };
    },
    readCoreApiRuntimeConfig: () => ({ ok: true, port: Number(new URL(coreUrl).port), token: 'target-token' }),
  };
  vm.createContext(context);
  vm.runInContext(extract(summary, 'const summaryJsonParser =', '\nconst PORT ='), context);
  vm.runInContext(extract(summary, 'async function postCoreApi(endpoint,', '\nasync function renewXrayAccount'), context);
  vm.runInContext(extract(summary, 'function authorizeAndRun(req, res, runHandler) {', "\napp.get('/health'"), context);
  vm.runInContext(extract(summary, 'for (const [route, endpoint] of [', "\napp.get('/internal/export-accounts'"), context);
  return listen(app);
}

async function post(url, body, token = 'server-token') {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-token': token }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.ok === false) { const error = new Error(data.message || 'request failed'); error.response = { status: response.status }; throw error; }
  return data;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-backup-http-'));
  const source = path.join(tmp, 'source'); const destination = path.join(tmp, 'destination');
  const servers = [];
  try {
    seed(source, 'source'); seed(destination, 'destination');
    const coreSource = await core(source); servers.push(coreSource.server);
    const coreDest = await core(destination); servers.push(coreDest.server);
    const sourceBridge = await bridge(source, coreSource.url); servers.push(sourceBridge.server);
    const destBridge = await bridge(destination, coreDest.url); servers.push(destBridge.server);
    await assert.rejects(post(`${sourceBridge.url}/internal/export-backup`, {}, 'wrong'), (e) => e.response.status === 401);
    await assert.rejects(post(`${destBridge.url}/internal/restore-backup`, { data: {} }, 'wrong'), (e) => e.response.status === 401);
    const apiPost = (host, key, endpoint, body) => post((host === 'source' ? sourceBridge.url : destBridge.url) + endpoint, body, key);
    const replies = []; let document;
    const ctx = { chat: { id: 1 }, from: { id: 1 }, reply: async (text) => replies.push(text), replyWithDocument: async (doc) => { document = doc; } };
    const userState = new Map([[1, {}]]);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const backupBranch = extract(bot, "      try {\n        const full = await apiPost(state.host, key, '/internal/export-backup'", '\n      const [ssh, vmess, vless, trojan]');
    await new AsyncFunction('ctx', 'state', 'key', 'apiPost', 'userState', 'dbRun', backupBranch)(ctx, { host: 'source' }, 'server-token', apiPost, userState, async () => {});
    assert(document?.source && Buffer.isBuffer(document.source));
    const backup = JSON.parse(document.source.toString('utf8'));
    assert.strictEqual(backup.data.identity.slowdns.public_key, fs.readFileSync(path.join(source, 'etc/sc-1forcr/slowdns/server.pub'), 'utf8').trim());
    assert.strictEqual(backup.data.ssh[0].date_exp, '2099-12-31 20:00:00');
    assert.strictEqual(backup.data.settings.TELEGRAM_BOT_TOKEN, sourceNotifyToken);
    assert.strictEqual(backup.data.settings.TELEGRAM_CHAT_ID, sourceNotifyChat);
    assert.strictEqual(backup.data.settings.ONLINE_NOTIFY_INTERVAL_HOURS, '9');
    assert.strictEqual(backup.data.banner_html, sourceBannerHtml);
    assert.strictEqual(backup.data.banner_txt, sourceBannerTxt);
    for (const key of ['AUTH_TOKEN', 'BOT_PANEL_TOKEN', 'BOT_PANEL_ADMIN_IDS']) assert(!Object.hasOwn(backup.data.settings, key));
    assert(!document.source.toString('utf8').includes('source-seller-token'));
    // Unrecognized credentials cannot be smuggled in through the runtime settings map.
    Object.assign(backup.data.settings, { AUTH_TOKEN: 'must-not-import', BOT_PANEL_TOKEN: 'must-not-import', BOT_PANEL_ADMIN_IDS: '1111' });
    const restoreBranch = extract(bot, '    if (isJsonBackup) {\n      try {\n        const restored =', "\n    const types = ['ssh', 'vmess', 'vless', 'trojan'];");
    const restoreFn = new AsyncFunction('ctx', 'state', 'parsed', 'backupData', 'isJsonBackup', 'apiPost', 'userState', 'mainMenu', 'dbRun', restoreBranch);
    const restoreBot = (...args) => restoreFn(...args, async () => {});
    await restoreBot(ctx, { host: 'destination', key: 'server-token' }, backup, backup.data, true, apiPost, userState, () => ({}));
    assert(replies.some((r) => r.startsWith('Restore lengkap selesai.')));
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/slowdns/server.pub'), 'utf8').trim(), backup.data.identity.slowdns.public_key);
    assertNotificationRestored(destination, sourceNotifyToken, sourceNotifyChat);
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/banner.html'), 'utf8'), sourceBannerHtml);
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/banner.txt'), 'utf8'), sourceBannerTxt);
    assertBannerRuntime(destination, true);
    coreDest.context.BACKUP_WEB_ENABLE = false;
    const disabledWeb = await fetch(`${coreDest.url}/vps/backup/restore`, { method: 'POST', headers: { authorization: 'target-token', 'content-type': 'text/plain' }, body: JSON.stringify(backup) });
    assert.strictEqual(disabledWeb.status, 404);
    await post(`${destBridge.url}/internal/restore-backup`, backup); // Bot restore is independent of the web toggle.
    coreDest.context.BACKUP_WEB_ENABLE = true;

    // Web upload passes >1 MB through the actual Express middleware and importer.
    backup.data.banner_html = '<p>' + 'a'.repeat(2 * 1024 * 1024) + '</p>';
    backup.data.banner_txt = 'Web restore text banner';
    const web = await fetch(`${coreDest.url}/vps/backup/restore`, { method: 'POST', headers: { authorization: 'target-token', 'content-type': 'text/plain' }, body: JSON.stringify(backup) });
    assert.strictEqual(web.status, 200, await web.text());
    const db = new DatabaseSync(path.join(destination, 'accounts.db'));
    assert.strictEqual(db.prepare("SELECT status FROM account_sshs WHERE username='e2euser'").get().status, 'AKTIF');
    db.close();
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/banner.html'), 'utf8').length, backup.data.banner_html.length);
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/banner.txt'), 'utf8'), backup.data.banner_txt);
    assertNotificationRestored(destination, sourceNotifyToken, sourceNotifyChat);
    assertBannerRuntime(destination, true, false);
    await post(`${destBridge.url}/internal/restore-backup`, backup); // >2 MB through Summary API.

    const cleared = structuredClone(backup);
    Object.assign(cleared.data.settings, { TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
    cleared.data.banner_html = '';
    cleared.data.banner_txt = '';
    await restoreBot(ctx, { host: 'destination', key: 'server-token' }, cleared, cleared.data, true, apiPost, userState, () => ({}));
    assertNotificationRestored(destination, '', '');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/banner.html'), 'utf8'), '');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/banner.txt'), 'utf8'), '');
    assertBannerRuntime(destination, false);

    // An older file that omitted these fields must preserve the destination state.
    fs.appendFileSync(path.join(destination, 'etc/sc-1forcr.env'), `TELEGRAM_BOT_TOKEN=${sourceNotifyToken}\nTELEGRAM_CHAT_ID=${sourceNotifyChat}\n`);
    fs.appendFileSync(path.join(destination, 'opt/sc-1forcr/.env'), `TELEGRAM_BOT_TOKEN=${sourceNotifyToken}\nTELEGRAM_CHAT_ID=${sourceNotifyChat}\n`);
    fs.writeFileSync(path.join(destination, 'etc/sc-1forcr/banner.html'), '<p>Keep current banner</p>');
    fs.writeFileSync(path.join(destination, 'etc/sc-1forcr/banner.txt'), 'Keep current text banner');
    const bannerConfigs = ['etc/ssh/sshd_config', 'etc/default/dropbear', 'etc/systemd/system/dropbear.service.d/override.conf'];
    const beforeLegacy = bannerConfigs.map((file) => fs.readFileSync(path.join(destination, file), 'utf8'));
    const legacy = { meta: { format: 'sc1forcr-accounts-backup-v2' }, data: { ssh: backup.data.ssh, settings: { ONLINE_NOTIFY_INTERVAL_HOURS: '4' } } };
    await post(`${destBridge.url}/internal/restore-backup`, legacy);
    assertNotificationRestored(destination, sourceNotifyToken, sourceNotifyChat);
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/banner.html'), 'utf8'), '<p>Keep current banner</p>');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/banner.txt'), 'utf8'), 'Keep current text banner');
    assert.deepStrictEqual(bannerConfigs.map((file) => fs.readFileSync(path.join(destination, file), 'utf8')), beforeLegacy);

    const keyBefore = fs.readFileSync(path.join(destination, 'etc/sc-1forcr/slowdns/server.key'), 'utf8');
    const broken = structuredClone(backup); broken.data.identity.slowdns.public_key = '00'.repeat(32);
    await assert.rejects(post(`${destBridge.url}/internal/restore-backup`, broken));
    assert.strictEqual(fs.readFileSync(path.join(destination, 'etc/sc-1forcr/slowdns/server.key'), 'utf8'), keyBefore);
    await assert.rejects(restoreBot(ctx, { host: 'destination', key: 'server-token' }, backup, backup.data, true,
      async () => { const error = new Error('missing'); error.response = { status: 404 }; throw error; }, userState, () => ({})), /Update AutoSC/);
    console.log('backup HTTP E2E passed (bot/web, notification credentials, banner activation/clearing, isolation, legacy omissions, auth, large uploads, real SQLite, invalid keys, old target)');
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const test = spawnSync(python, [pyTest], { encoding: 'utf8', timeout: 180000 });
  assert.strictEqual(test.status, 0, test.stderr || test.stdout);
  process.stdout.write(test.stdout || '');
  process.stdout.write(test.stderr || '');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });

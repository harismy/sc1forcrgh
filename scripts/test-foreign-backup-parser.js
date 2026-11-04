const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseForeignBackupArchive } = require('../lib/foreign-backup-parser');

function buildStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const zip = buildStoredZip({
  'backup/.ssh.db': '& plughin Account\n#ssh# budi pass123 150 2 19 Jul, 2099\n',
  'backup/.vmess.db': '& plughin Account\n### vm1 2099-05-14 9c7d263d-d84a-49f5-8789-088a72d43cbd 150 2\n',
  'backup/.vless.db': '& plughin Account\n### vl1 2099-05-14 48b57336-a206-489b-9c9b-27cdbacb2228 200 5\n',
  'backup/.trojan.db': '& plughin Account\n### tr1 2099-05-14 7bd9ec7a-1bd5-4d4f-bc60-2be3cb61c79b 150 1\n'
});

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-foreign-test-')), 'backup.zip');
fs.writeFileSync(tmp, zip);
try {
  const { data, summary } = parseForeignBackupArchive(tmp);
  assert.strictEqual(data.ssh.length, 1, 'ssh');
  assert.strictEqual(data.ssh[0].password, 'pass123');
  assert.strictEqual(data.ssh[0].date_exp, '2099-07-19');
  assert.strictEqual(data.vmess.length, 1, 'vmess');
  assert.strictEqual(data.vmess[0].uuid, '9c7d263d-d84a-49f5-8789-088a72d43cbd');
  assert.strictEqual(data.vless.length, 1, 'vless memakai penanda ### harus tetap terbaca');
  assert.strictEqual(data.vless[0].uuid, '48b57336-a206-489b-9c9b-27cdbacb2228');
  assert.strictEqual(data.vless[0].limitip, 5);
  assert.strictEqual(data.trojan.length, 1, 'trojan memakai penanda ### harus tetap terbaca');
  assert.strictEqual(data.trojan[0].password, '7bd9ec7a-1bd5-4d4f-bc60-2be3cb61c79b');
  assert.strictEqual(summary.vless, 1);
  assert.strictEqual(summary.trojan, 1);
  console.log('test-foreign-backup-parser: OK');
} finally {
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}

// Format MakhlukTunnel/Noobz (v4.x): .db hanya "### user tanggal jam", credential di JSON per-akun.
const mtZip = buildStoredZip({
  'backup/config.json': JSON.stringify({ version: 'v4.1', data: { domain: 'x.my.id' } }),
  'backup/ssh/.ssh.db': '### tess 2026-11-06 06:36:56\n',
  'backup/ssh/tess.json': JSON.stringify({ username: 'tess', pass: 'rahasia123', quota: 50, iplim: 2, status: 'unlocked', exp_date: '2026-11-06 06:36:56' }),
  'backup/vless/.vless.db': '### Adfal 2026-11-10 10:53:18\n### Dewi 2026-11-21 10:53:20\n',
  'backup/vless/Adfal.json': JSON.stringify({ username: 'Adfal', uuid: 'c4be398c-bf21-4f2a-b4eb-724ef7599625', quota: 50, iplim: 2, types: 'ws', status: 'unlocked', exp_date: '2026-11-10 10:53:18' }),
  'backup/vless/Dewi.json': JSON.stringify({ username: 'Dewi', uuid: '3e5e7e9a-f8e2-406e-98c7-d655a7c0b185', quota: 100, iplim: 3, types: 'ws', status: 'unlocked', exp_date: '2026-11-21 10:53:20' }),
  'backup/vless/archived/abbas.json': JSON.stringify({ username: 'abbas', uuid: '8cd49119-5c37-4db0-922c-b0523980cd8d', quota: 40, iplim: 2, status: 'unlocked', exp_date: '2027-11-02 10:53:18' }),
  'backup/trojan/.trojan.db': '### imam 2026-12-01 10:53:36\n',
  'backup/trojan/imam.json': JSON.stringify({ username: 'imam', uuid: 'ac1d3c08-6e85-42db-87b5-a33ed4d42617', quota: 100, iplim: 2, types: 'ws', status: 'unlocked', exp_date: '2026-12-01 10:53:36' }),
  'backup/vmess/.vmess.db': ''
});

const mtTmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-foreign-mt-')), 'backup.zip');
fs.writeFileSync(mtTmp, mtZip);
try {
  const { data, summary } = parseForeignBackupArchive(mtTmp);

  assert.strictEqual(data.ssh.length, 1, 'MT ssh: 1 akun');
  assert.strictEqual(data.ssh[0].username, 'tess');
  assert.strictEqual(data.ssh[0].password, 'rahasia123', 'MT ssh: password asli dari JSON, bukan default');
  assert.strictEqual(data.ssh[0].quota, 50);
  assert.strictEqual(data.ssh[0].limitip, 2);
  assert.strictEqual(data.ssh[0].date_exp, '2026-11-06');

  assert.strictEqual(data.vless.length, 2, 'MT vless: 2 live (archived dilewati)');
  const adfal = data.vless.find((r) => r.username === 'Adfal');
  assert.strictEqual(adfal.uuid, 'c4be398c-bf21-4f2a-b4eb-724ef7599625', 'MT vless: uuid asli dari JSON, bukan jam');
  assert.strictEqual(adfal.quota, 50);
  assert.strictEqual(adfal.limitip, 2);
  assert.strictEqual(data.vless.find((r) => r.username === 'Dewi').limitip, 3);
  assert.ok(!data.vless.some((r) => r.username === 'abbas'), 'MT: akun archived tidak diimpor');

  assert.strictEqual(data.trojan.length, 1, 'MT trojan: 1 akun');
  assert.strictEqual(data.trojan[0].password, 'ac1d3c08-6e85-42db-87b5-a33ed4d42617', 'MT trojan: secret dari uuid JSON');

  // Tidak ada warning konversi uuid palsu (jam tidak salah dibaca sebagai uuid).
  assert.ok(!summary.warnings.some((w) => /ID pendek dikonversi/i.test(w)), 'MT: tidak ada konversi uuid palsu');
  assert.ok(summary.warnings.some((w) => /archived/i.test(w)), 'MT: ada info akun archived dilewati');

  console.log('test-foreign-backup-parser (MakhlukTunnel v4.x): OK');
} finally {
  fs.rmSync(path.dirname(mtTmp), { recursive: true, force: true });
}

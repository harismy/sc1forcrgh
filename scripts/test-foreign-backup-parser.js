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

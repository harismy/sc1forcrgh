const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const util = require('util');
const crypto = require('crypto');

// Backup & restore server bot (app3 + license-api) untuk pindah server.
// Isi file .sc1bak: magic + salt + iv + auth tag, lalu ciphertext AES-256-GCM
// dari [panjang manifest 4 byte][manifest JSON][blob gzip tiap file].

const SERVER_BACKUP_FORMAT = 'sc1forcr-server-backup';
const SERVER_BACKUP_VERSION = 1;
const SERVER_BACKUP_EXTENSION = '.sc1bak';
const SERVER_BACKUP_PASSWORD_MIN = 8;
const ARCHIVE_MAGIC = Buffer.from('SC1FSRV1', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = ARCHIVE_MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const RESTORE_ATTACH_NAME = 'sc_restore_src';

// Nilai .env yang terikat ke susunan folder server. Saat restore dipakai nilai
// server baru; kalau server baru tidak mengisinya, baris dari backup dibuang
// supaya default relatif ke folder bot yang baru yang berlaku.
const ENV_SERVER_PATH_KEYS = [
  'DB_PATH',
  'SC_INSTALLER_LOCAL_PATH',
  'SUMMARY_API_LOCAL_PATH',
  'LICENSE_SIGNING_PRIVATE_KEY_FILE',
  'LICENSE_SIGNING_PUBLIC_KEY_FILE'
];
// Token bot yang sedang dipakai admin untuk restore dipertahankan, supaya bot
// tetap bisa dihubungi setelah restart.
const ENV_KEEP_CURRENT_KEYS = ['BOT_TOKEN'];
const ENV_UNION_LIST_KEYS = ['ADMIN_IDS'];

const scryptAsync = util.promisify(crypto.scrypt);
const gzipAsync = util.promisify(zlib.gzip);
const gunzipAsync = util.promisify(zlib.gunzip);

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function readFileIfExists(file) {
  if (!file) return null;
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function fileMode(file, fallback) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch (_) {
    return fallback;
  }
}

function writeFileAtomic(filePath, data, mode) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    try { fs.chmodSync(tmp, mode); } catch (_) {}
    fs.renameSync(tmp, filePath);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

function assertBackupPassword(password) {
  if (String(password || '').length < SERVER_BACKUP_PASSWORD_MIN) {
    throw codedError('WEAK_PASSWORD', `Password backup minimal ${SERVER_BACKUP_PASSWORD_MIN} karakter.`);
  }
}

function isSafeDomain(domain) {
  return /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(String(domain || ''));
}

// ---------------------------------------------------------------------------
// Versi script dan key lisensi

function extractScriptVersion(text) {
  const match = /^SCRIPT_VERSION="?(?:\$\{[A-Za-z_][A-Za-z0-9_]*:-)?([A-Za-z0-9._-]+)/m.exec(String(text || ''));
  return match ? match[1] : '';
}

// -1 kalau a lebih lama dari b, 1 kalau lebih baru, 0 kalau sama atau tidak
// bisa dibandingkan (format berbeda).
function compareScriptVersions(a, b) {
  const parse = (value) => {
    const match = /^(.*?)(\d+)$/.exec(String(value || '').trim());
    return match ? { prefix: match[1], num: Number(match[2]) } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y || x.prefix !== y.prefix) return 0;
  if (x.num === y.num) return 0;
  return x.num < y.num ? -1 : 1;
}

// Sama persis dengan cara license-api.js menentukan lokasi key.
function resolveLicenseKeyPaths(env, appDir) {
  const base = path.resolve(appDir || process.cwd());
  const source = env || {};
  const dbPath = path.resolve(base, String(source.DB_PATH || path.join(base, 'sc1forcrnexus.db')).trim());
  const privateKeyFile = path.resolve(
    base,
    String(source.LICENSE_SIGNING_PRIVATE_KEY_FILE || path.join(path.dirname(dbPath), '.sc1forcr-license-ed25519-private.pem')).trim()
  );
  const publicKeyFile = path.resolve(
    base,
    String(source.LICENSE_SIGNING_PUBLIC_KEY_FILE || path.join(path.dirname(privateKeyFile), '.sc1forcr-license-ed25519-public.pem')).trim()
  );
  return { privateKeyFile, publicKeyFile };
}

function licenseKeyInfo(privatePem) {
  const privateKey = crypto.createPrivateKey(String(privatePem || ''));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('signing key lisensi di backup bukan Ed25519');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    publicPem: `${String(publicKey.export({ type: 'spki', format: 'pem' })).trim()}\n`,
    fingerprint: sha256Hex(publicKey.export({ type: 'spki', format: 'der' }))
  };
}

function licenseKeyFingerprintOfFile(file) {
  try {
    const pem = readFileIfExists(file);
    return pem ? licenseKeyInfo(pem.toString('utf8')).fingerprint : '';
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// .env

const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquoteEnvValue(raw) {
  let value = String(raw || '').trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  const comment = value.search(/\s#/);
  if (comment >= 0) value = value.slice(0, comment).trim();
  return value;
}

function parseEnvLines(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map((raw) => {
    const match = /^\s*#/.test(raw) ? null : ENV_LINE_RE.exec(raw);
    return match ? { raw, key: match[1], value: unquoteEnvValue(match[2]) } : { raw, key: '' };
  });
}

// Seperti dotenv: kunci yang muncul dua kali memakai nilai terakhir.
function parseEnvText(text) {
  const out = {};
  for (const line of parseEnvLines(text)) {
    if (line.key) out[line.key] = line.value;
  }
  return out;
}

function mergeListValues(...values) {
  const seen = new Set();
  for (const value of values) {
    for (const item of String(value || '').split(',')) {
      const trimmed = item.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return Array.from(seen).join(',');
}

function mergeEnvForRestore(backupText, currentText) {
  const backupLines = parseEnvLines(backupText);
  const backupEnv = parseEnvText(backupText);
  const currentByKey = new Map();
  for (const line of parseEnvLines(currentText)) {
    if (line.key) currentByKey.set(line.key, line);
  }
  const lastIndex = new Map();
  backupLines.forEach((line, index) => {
    if (line.key) lastIndex.set(line.key, index);
  });

  const notes = [];
  const out = [];
  const written = new Set();
  backupLines.forEach((line, index) => {
    if (!line.key) {
      out.push(line.raw);
      return;
    }
    const { key } = line;
    if (lastIndex.get(key) !== index) return;
    written.add(key);
    const current = currentByKey.get(key);
    if (ENV_SERVER_PATH_KEYS.includes(key)) {
      if (current) out.push(current.raw);
      return;
    }
    if (ENV_KEEP_CURRENT_KEYS.includes(key)) {
      if (current && current.value) {
        out.push(current.raw);
        if (current.value !== line.value) notes.push(`${key} di backup berbeda; dipakai milik server ini.`);
      } else {
        out.push(line.raw);
      }
      return;
    }
    if (ENV_UNION_LIST_KEYS.includes(key)) {
      const merged = mergeListValues(line.value, current?.value);
      if (merged !== mergeListValues(line.value)) notes.push(`${key} digabung dengan milik server ini: ${merged}`);
      out.push(`${key}=${merged}`);
      return;
    }
    out.push(line.raw);
  });

  const extras = [];
  for (const [key, line] of currentByKey) {
    if (!written.has(key)) extras.push(line.raw);
  }
  if (extras.length) out.push('', '# Dipertahankan dari server ini saat restore', ...extras);

  const text = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  if (!Object.keys(backupEnv).length) notes.push('.env di backup kosong.');
  return { text, env: parseEnvText(text), notes };
}

// ---------------------------------------------------------------------------
// Pohon direktori (sertifikat Let's Encrypt, termasuk symlink live -> archive)

function isSafeRelPath(rel) {
  const value = String(rel || '');
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function isSafeSymlinkTarget(rel, target) {
  const value = String(target || '');
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), value));
  return !(resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/'));
}

function collectTreeEntries(rootDir, relPaths) {
  const entries = [];
  const seen = new Set();
  const absOf = (rel) => path.join(rootDir, ...rel.split('/'));
  const pushDirOnly = (rel) => {
    if (seen.has(rel)) return;
    let st;
    try { st = fs.lstatSync(absOf(rel)); } catch (_) { return; }
    if (!st.isDirectory()) return;
    seen.add(rel);
    entries.push({ type: 'dir', rel, mode: st.mode & 0o777 });
  };
  const walk = (rel) => {
    if (seen.has(rel)) return;
    const abs = absOf(rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    seen.add(rel);
    const mode = st.mode & 0o777;
    if (st.isSymbolicLink()) {
      entries.push({ type: 'symlink', rel, mode, target: fs.readlinkSync(abs) });
    } else if (st.isDirectory()) {
      entries.push({ type: 'dir', rel, mode });
      for (const name of fs.readdirSync(abs).sort()) walk(`${rel}/${name}`);
    } else if (st.isFile()) {
      entries.push({ type: 'file', rel, mode, data: fs.readFileSync(abs) });
    }
  };
  for (const rel of relPaths) {
    if (!isSafeRelPath(rel)) continue;
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) pushDirOnly(parts.slice(0, i).join('/'));
    walk(rel);
  }
  return entries;
}

function assertSafeTreeEntries(entries) {
  for (const entry of entries) {
    if (!isSafeRelPath(entry.name)) throw new Error(`path tidak aman di backup: ${entry.name}`);
    if (entry.type === 'symlink' && !isSafeSymlinkTarget(entry.name, entry.target)) {
      throw new Error(`symlink tidak aman di backup: ${entry.name}`);
    }
  }
}

function restoreTreeEntries(rootDir, entries) {
  assertSafeTreeEntries(entries);
  for (const entry of entries) {
    const abs = path.join(rootDir, ...entry.name.split('/'));
    if (entry.type === 'dir') {
      fs.mkdirSync(abs, { recursive: true, mode: entry.mode || 0o755 });
      try { fs.chmodSync(abs, entry.mode || 0o755); } catch (_) {}
    } else if (entry.type === 'symlink') {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.rmSync(abs, { force: true });
      fs.symlinkSync(entry.target, abs);
    } else if (entry.type === 'file') {
      writeFileAtomic(abs, entry.data, entry.mode || 0o600);
    }
  }
}

function letsencryptDomainOf(rel) {
  const match = /^(?:live|archive)\/([^/]+)(?:\/|$)/.exec(rel) || /^renewal\/(.+)\.conf$/.exec(rel);
  return match ? match[1] : '';
}

// ---------------------------------------------------------------------------
// SQLite. openDb(file) mengembalikan adapter { run, all, close } (async), supaya
// modul ini bisa dipakai dengan sqlite3 (bot) maupun node:sqlite (test).

async function withDb(openDb, file, fn) {
  const db = await openDb(file);
  try {
    return await fn(db);
  } finally {
    await db.close().catch(() => {});
  }
}

async function quickCheckOk(db, schema = 'main') {
  const rows = await db.all(`PRAGMA ${schema}.quick_check`);
  return String(Object.values(rows[0] || {})[0] || '').toLowerCase() === 'ok';
}

// VACUUM INTO menghasilkan salinan yang konsisten walau license-api dan expiry
// job sedang menulis ke database yang sama.
async function snapshotDatabase(openDb, dbPath, outPath) {
  await withDb(openDb, dbPath, (db) => db.run(`VACUUM INTO ${quoteSqlString(outPath)}`));
  const ok = await withDb(openDb, outPath, (db) => quickCheckOk(db));
  if (!ok) throw new Error('snapshot database gagal quick_check');
}

async function summarizeDatabase(openDb, dbFile) {
  return withDb(openDb, dbFile, async (db) => {
    const first = async (sql, params = []) => {
      try {
        return (await db.all(sql, params))[0] || {};
      } catch (_) {
        return {};
      }
    };
    const users = await first('SELECT COUNT(*) AS n, COALESCE(SUM(saldo), 0) AS saldo FROM users');
    const regs = await first(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'active' AND (expires_at IS NULL OR expires_at = 0 OR expires_at > ?) THEN 1 ELSE 0 END), 0) AS active
       FROM sc_registrations`,
      [Date.now()]
    );
    const keys = await first('SELECT COUNT(*) AS n FROM sc_server_keys');
    const txs = await first('SELECT COUNT(*) AS n FROM transactions');
    const pending = await first("SELECT COUNT(*) AS n FROM pending_deposits_app3 WHERE status = 'pending'");
    let domains = [];
    try {
      const rows = await db.all('SELECT domain FROM api_domains WHERE is_active = 1 ORDER BY updated_at DESC, id DESC');
      domains = Array.from(new Set(rows.map((row) => String(row?.domain || '').trim().toLowerCase()).filter(Boolean)));
    } catch (_) {}
    return {
      users: Number(users.n || 0),
      saldo_total: Number(users.saldo || 0),
      registrations_total: Number(regs.total || 0),
      registrations_active: Number(regs.active || 0),
      server_keys: Number(keys.n || 0),
      transactions: Number(txs.n || 0),
      pending_topups: Number(pending.n || 0),
      domains
    };
  });
}

async function tableColumns(db, schema, table) {
  const rows = await db.all(`PRAGMA ${schema}.table_info(${quoteIdent(table)})`);
  return rows.map((row) => String(row.name));
}

// Isi database hidup diganti isi backup dalam satu transaksi, tanpa mengganti
// file. Proses lain (license-api, expiry job) tetap memegang koneksi yang sah
// dan langsung melihat data baru. Kolom dicocokkan per nama karena urutan kolom
// bisa berbeda antara database lama dan baru (kolom hasil ALTER TABLE).
async function restoreSqliteInPlace(openDb, targetPath, sourcePath) {
  return withDb(openDb, targetPath, async (db) => {
    const src = RESTORE_ATTACH_NAME;
    await db.run(`ATTACH DATABASE ? AS ${src}`, [sourcePath]);
    let inTransaction = false;
    try {
      if (!(await quickCheckOk(db, src))) throw new Error('database di file backup rusak (quick_check gagal)');
      const srcTables = await db.all(
        `SELECT name, sql FROM ${src}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      );
      const dstTables = new Set(
        (await db.all("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"))
          .map((row) => String(row.name))
      );
      const result = { tables: [], created: [], rows: 0 };
      await db.run('BEGIN IMMEDIATE');
      inTransaction = true;
      for (const table of srcTables) {
        const name = String(table.name);
        const quoted = quoteIdent(name);
        if (!dstTables.has(name)) {
          if (!/^\s*CREATE\s+TABLE\b/i.test(String(table.sql || ''))) {
            throw new Error(`skema tabel ${name} di backup tidak valid`);
          }
          await db.run(String(table.sql));
          result.created.push(name);
        } else {
          await db.run(`DELETE FROM main.${quoted}`);
        }
        const dstCols = new Set(await tableColumns(db, 'main', name));
        const cols = (await tableColumns(db, src, name)).filter((col) => dstCols.has(col));
        let rows = 0;
        if (cols.length) {
          const colList = cols.map(quoteIdent).join(', ');
          await db.run(`INSERT INTO main.${quoted} (${colList}) SELECT ${colList} FROM ${src}.${quoted}`);
          rows = Number((await db.all(`SELECT COUNT(*) AS n FROM main.${quoted}`))[0]?.n || 0);
        }
        result.tables.push({ name, rows });
        result.rows += rows;
      }
      const hasSequence = async (schema) => (await db.all(
        `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`
      )).length > 0;
      if (await hasSequence(src) && await hasSequence('main')) {
        await db.run(`DELETE FROM main.sqlite_sequence WHERE name IN (SELECT name FROM ${src}.sqlite_sequence)`);
        await db.run(`INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM ${src}.sqlite_sequence`);
      }
      await db.run('COMMIT');
      inTransaction = false;
      return result;
    } catch (err) {
      if (inTransaction) await db.run('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await db.run(`DETACH DATABASE ${src}`).catch(() => {});
    }
  });
}

// Path installer yang tersimpan di app_settings berasal dari server lama.
async function repointInstallerPathSetting(openDb, dbPath, installerFile) {
  if (!installerFile) return false;
  return withDb(openDb, dbPath, async (db) => {
    try {
      const rows = await db.all("SELECT value FROM app_settings WHERE key = 'SC_INSTALLER_LOCAL_PATH'");
      const stored = String(rows[0]?.value || '').trim();
      if (!stored || stored === installerFile || fs.existsSync(stored)) return false;
      await db.run(
        "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'SC_INSTALLER_LOCAL_PATH'",
        [installerFile, Date.now()]
      );
      return true;
    } catch (_) {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Arsip terenkripsi

async function deriveKey(password, salt) {
  return scryptAsync(String(password || ''), salt, 32, SCRYPT_OPTIONS);
}

async function encodeServerBackup({ manifest, entries, password }) {
  assertBackupPassword(password);
  const blobs = [];
  let offset = 0;
  const files = [];
  for (const entry of entries) {
    const item = { role: entry.role, name: entry.name, type: entry.type || 'file', mode: entry.mode };
    if (item.type === 'file') {
      const raw = Buffer.from(entry.data || '');
      const packed = await gzipAsync(raw);
      Object.assign(item, { size: raw.length, sha256: sha256Hex(raw), offset, length: packed.length });
      blobs.push(packed);
      offset += packed.length;
    } else if (item.type === 'symlink') {
      item.target = entry.target;
    }
    files.push(item);
  }
  const manifestBuf = Buffer.from(JSON.stringify({ ...manifest, files }), 'utf8');
  if (manifestBuf.length > MANIFEST_MAX_BYTES) throw new Error('manifest backup terlalu besar');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(manifestBuf.length, 0);
  const plain = Buffer.concat([lengthBuf, manifestBuf, ...blobs]);

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(ARCHIVE_MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ARCHIVE_MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function looksLikeServerBackup(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  return buf.length > HEADER_BYTES && buf.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC);
}

async function decodeServerBackup(buffer, password) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!looksLikeServerBackup(buf)) {
    throw codedError('BAD_FORMAT', `File ini bukan backup server SC 1FORCR (${SERVER_BACKUP_EXTENSION}).`);
  }
  let pos = ARCHIVE_MAGIC.length;
  const salt = buf.subarray(pos, pos + SALT_BYTES);
  pos += SALT_BYTES;
  const iv = buf.subarray(pos, pos + IV_BYTES);
  pos += IV_BYTES;
  const tag = buf.subarray(pos, pos + TAG_BYTES);
  pos += TAG_BYTES;

  const key = await deriveKey(password, salt);
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(ARCHIVE_MAGIC);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(buf.subarray(pos)), decipher.final()]);
  } catch (_) {
    throw codedError('BAD_PASSWORD', 'Password salah atau file backup rusak.');
  }

  const manifestLength = plain.length >= 4 ? plain.readUInt32BE(0) : 0;
  if (!manifestLength || manifestLength > MANIFEST_MAX_BYTES || 4 + manifestLength > plain.length) {
    throw codedError('BAD_FORMAT', 'Isi backup rusak (manifest tidak valid).');
  }
  let manifest;
  try {
    manifest = JSON.parse(plain.subarray(4, 4 + manifestLength).toString('utf8'));
  } catch (_) {
    throw codedError('BAD_FORMAT', 'Isi backup rusak (manifest bukan JSON).');
  }
  if (manifest?.format !== SERVER_BACKUP_FORMAT) {
    throw codedError('BAD_FORMAT', 'Format backup tidak dikenali.');
  }
  if (Number(manifest.version || 0) > SERVER_BACKUP_VERSION) {
    throw codedError('BAD_FORMAT', 'Backup dibuat oleh versi bot yang lebih baru. Update kode bot di server ini dulu.');
  }

  const blobArea = plain.subarray(4 + manifestLength);
  const entries = [];
  for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
    const entry = { role: String(file.role || ''), name: String(file.name || ''), type: String(file.type || 'file'), mode: Number(file.mode) || 0 };
    if (entry.type === 'file') {
      const offset = Number(file.offset);
      const length = Number(file.length);
      const size = Number(file.size);
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > blobArea.length) {
        throw codedError('BAD_FORMAT', `Isi backup rusak (${entry.name}).`);
      }
      const raw = await gunzipAsync(blobArea.subarray(offset, offset + length), { maxOutputLength: Math.max(1, size + 1) })
        .catch(() => null);
      if (!raw || raw.length !== size || sha256Hex(raw) !== String(file.sha256 || '')) {
        throw codedError('BAD_FORMAT', `Checksum ${entry.name} tidak cocok. File backup rusak.`);
      }
      entry.data = raw;
    } else if (entry.type === 'symlink') {
      entry.target = String(file.target || '');
    }
    entries.push(entry);
  }
  return { manifest, entries };
}

// ---------------------------------------------------------------------------
// Backup & restore lengkap

async function createServerBackup(options) {
  const {
    password,
    openDb,
    dbPath,
    appDir,
    env = {},
    envFile,
    varsFile,
    scInstallerFile,
    summaryApiFile,
    letsencryptDir = null,
    hostname = os.hostname(),
    label = ''
  } = options;
  assertBackupPassword(password);

  const warnings = [];
  const entries = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc1forcr-srvbak-'));
  try {
    const snapshotPath = path.join(tempDir, 'database.sqlite');
    await snapshotDatabase(openDb, dbPath, snapshotPath);
    const summary = await summarizeDatabase(openDb, snapshotPath);
    entries.push({ role: 'database', name: path.basename(dbPath), type: 'file', mode: 0o600, data: fs.readFileSync(snapshotPath) });

    const addFile = (role, file, missingWarning = '') => {
      const data = readFileIfExists(file);
      if (!data) {
        if (missingWarning) warnings.push(missingWarning);
        return null;
      }
      entries.push({ role, name: path.basename(file), type: 'file', mode: fileMode(file, 0o600), data });
      return data;
    };

    addFile('env', envFile, 'File .env tidak ditemukan: token dan konfigurasi harus diisi manual di server baru.');
    addFile('vars', varsFile, 'File .vars.json tidak ditemukan: setting payment gateway tidak ikut.');
    const keyPaths = resolveLicenseKeyPaths({ ...env, DB_PATH: env.DB_PATH || dbPath }, appDir);
    const privatePem = addFile(
      'license_private_key',
      keyPaths.privateKeyFile,
      'PRIVATE KEY LISENSI TIDAK DITEMUKAN. Tanpa key ini, semua VPS pelanggan akan menolak lisensi dari server baru.'
    );
    let fingerprint = '';
    if (privatePem) {
      try {
        fingerprint = licenseKeyInfo(privatePem.toString('utf8')).fingerprint;
      } catch (err) {
        warnings.push(`Private key lisensi tidak valid: ${err.message}`);
      }
      addFile('license_public_key', keyPaths.publicKeyFile);
    }
    const installer = addFile('sc_installer', scInstallerFile, 'Script installer SC tidak ditemukan di server ini.');
    addFile('summary_api', summaryApiFile);

    let sslDomains = [];
    const domains = summary.domains.filter(isSafeDomain);
    if (letsencryptDir && domains.length) {
      const rels = ['accounts'];
      for (const domain of domains) rels.push(`live/${domain}`, `archive/${domain}`, `renewal/${domain}.conf`);
      try {
        const treeEntries = collectTreeEntries(letsencryptDir, rels);
        for (const entry of treeEntries) {
          entries.push({ role: 'letsencrypt', name: entry.rel, type: entry.type, mode: entry.mode, data: entry.data, target: entry.target });
        }
        sslDomains = domains.filter((domain) => treeEntries.some((entry) => entry.rel === `live/${domain}`));
      } catch (err) {
        warnings.push(`Sertifikat SSL tidak bisa dibaca: ${err.message}`);
      }
    }
    const withoutSsl = domains.filter((domain) => !sslDomains.includes(domain));
    if (withoutSsl.length) {
      warnings.push(`SSL tidak ikut untuk: ${withoutSsl.join(', ')}. Buat ulang lewat Tambah Domain setelah DNS pindah.`);
    }
    if (!domains.length) {
      warnings.push('Belum ada domain API aktif. VPS pelanggan menghubungi bot lewat domain, jadi tambahkan domain sebelum pindah.');
    }
    // VPS menyimpan URL lisensi saat install. URL berbasis IP ikut mati saat IP server berganti.
    try {
      const publicHost = new URL(String(env.LICENSE_PUBLIC_BASE_URL || '')).hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(publicHost)) {
        warnings.push(
          `LICENSE_PUBLIC_BASE_URL memakai IP ${publicHost}. VPS yang hanya mengenal URL ini tidak bisa menghubungi server baru; pakai domain.`
        );
      }
    } catch (_) {}

    const createdAt = Date.now();
    const manifest = {
      format: SERVER_BACKUP_FORMAT,
      version: SERVER_BACKUP_VERSION,
      created_at: new Date(createdAt).toISOString(),
      created_at_ms: createdAt,
      label: String(label || ''),
      source: {
        hostname: String(hostname || ''),
        app_dir: String(appDir || ''),
        db_path: String(dbPath || ''),
        node: process.version,
        platform: process.platform
      },
      summary: { ...summary, ssl_domains: sslDomains },
      license_key_fingerprint: fingerprint,
      sc_installer_version: installer ? extractScriptVersion(installer.toString('utf8')) : '',
      warnings
    };
    const buffer = await encodeServerBackup({ manifest, entries, password });
    return { buffer, manifest };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function restoreServerBackup(options) {
  const {
    archive,
    openDb,
    dbPath,
    appDir,
    envFile,
    varsFile,
    scInstallerFile,
    summaryApiFile,
    letsencryptDir = null
  } = options;
  const manifest = archive?.manifest || {};
  const entries = Array.isArray(archive?.entries) ? archive.entries : [];
  const fileOf = (role) => entries.find((entry) => entry.role === role && entry.type === 'file');

  // Validasi semua isi dulu, sebelum ada yang ditimpa.
  const dbEntry = fileOf('database');
  if (!dbEntry) throw new Error('Backup tidak berisi database.');
  const privateEntry = fileOf('license_private_key');
  const licenseInfo = privateEntry ? licenseKeyInfo(privateEntry.data.toString('utf8')) : null;
  if (licenseInfo && manifest.license_key_fingerprint && licenseInfo.fingerprint !== manifest.license_key_fingerprint) {
    throw new Error('Fingerprint key lisensi tidak cocok dengan manifest backup.');
  }
  const varsEntry = fileOf('vars');
  let backupVars = null;
  if (varsEntry) {
    try {
      backupVars = JSON.parse(varsEntry.data.toString('utf8'));
    } catch (_) {
      backupVars = null;
    }
  }
  const sslEntries = entries.filter((entry) => entry.role === 'letsencrypt');
  assertSafeTreeEntries(sslEntries);

  const report = {
    database: null,
    env: null,
    vars: 'tidak ada di backup',
    license: null,
    scripts: [],
    ssl: { restored: [], skipped: [], note: '' },
    installerPathRepointed: false,
    domains: Array.isArray(manifest.summary?.domains) ? manifest.summary.domains.filter(isSafeDomain) : [],
    licenseApiPort: 8099,
    warnings: []
  };

  // 1. Database. Transaksional: kalau gagal, belum ada yang berubah.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc1forcr-srvrestore-'));
  try {
    const sourcePath = path.join(tempDir, 'restore.sqlite');
    fs.writeFileSync(sourcePath, dbEntry.data, { mode: 0o600 });
    report.database = await restoreSqliteInPlace(openDb, dbPath, sourcePath);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }

  // 2. .env
  const currentEnvText = (readFileIfExists(envFile) || Buffer.alloc(0)).toString('utf8');
  let mergedEnv = parseEnvText(currentEnvText);
  const envEntry = fileOf('env');
  if (envEntry) {
    const merged = mergeEnvForRestore(envEntry.data.toString('utf8'), currentEnvText);
    writeFileAtomic(envFile, merged.text, 0o600);
    mergedEnv = merged.env;
    report.env = { keys: Object.keys(merged.env).length, notes: merged.notes };
  } else {
    report.warnings.push('Backup tidak berisi .env; .env server ini tidak diubah.');
  }
  report.licenseApiPort = Math.max(1, Number(mergedEnv.LICENSE_API_PORT || 8099) || 8099);

  // 3. .vars.json (payment gateway)
  if (varsEntry) {
    if (backupVars && typeof backupVars === 'object') {
      let currentVars = {};
      try {
        currentVars = JSON.parse((readFileIfExists(varsFile) || Buffer.from('{}')).toString('utf8')) || {};
      } catch (_) {
        currentVars = {};
      }
      writeFileAtomic(varsFile, `${JSON.stringify({ ...currentVars, ...backupVars }, null, 2)}\n`, 0o600);
      report.vars = 'dipulihkan';
    } else {
      report.vars = 'dilewati (isi .vars.json di backup tidak valid)';
      report.warnings.push('.vars.json di backup tidak valid; setting payment gateway perlu diisi ulang.');
    }
  }

  // 4. Signing key lisensi. Public key diturunkan dari private key.
  if (privateEntry && licenseInfo) {
    const keyPaths = resolveLicenseKeyPaths({ ...mergedEnv, DB_PATH: mergedEnv.DB_PATH || dbPath }, appDir);
    const previousFingerprint = licenseKeyFingerprintOfFile(keyPaths.privateKeyFile);
    writeFileAtomic(keyPaths.privateKeyFile, privateEntry.data, 0o600);
    writeFileAtomic(keyPaths.publicKeyFile, licenseInfo.publicPem, 0o644);
    report.license = {
      fingerprint: licenseInfo.fingerprint,
      replaced: Boolean(previousFingerprint && previousFingerprint !== licenseInfo.fingerprint),
      privateKeyFile: keyPaths.privateKeyFile
    };
  } else {
    report.warnings.push('Backup tidak berisi private key lisensi. VPS pelanggan akan menolak key server ini.');
  }

  // 5. Script yang disajikan ke VPS. Installer SC tidak diturunkan versinya.
  for (const [role, file, label] of [
    ['sc_installer', scInstallerFile, 'Script SC'],
    ['summary_api', summaryApiFile, 'Script Summary API']
  ]) {
    const entry = fileOf(role);
    if (!entry || !file) continue;
    const current = readFileIfExists(file);
    const backupVersion = role === 'sc_installer' ? extractScriptVersion(entry.data.toString('utf8')) : '';
    const currentVersion = role === 'sc_installer' && current ? extractScriptVersion(current.toString('utf8')) : '';
    if (current && current.equals(entry.data)) {
      report.scripts.push({ role, label, action: 'same', backupVersion, currentVersion });
      continue;
    }
    if (role === 'sc_installer' && current && compareScriptVersions(backupVersion, currentVersion) < 0) {
      report.scripts.push({ role, label, action: 'kept', backupVersion, currentVersion });
      continue;
    }
    writeFileAtomic(file, entry.data, 0o755);
    report.scripts.push({ role, label, action: 'restored', backupVersion, currentVersion });
  }
  report.installerPathRepointed = await repointInstallerPathSetting(openDb, dbPath, scInstallerFile);

  // 6. Sertifikat SSL. Domain yang sudah punya sertifikat di server ini dilewati.
  if (sslEntries.length) {
    if (!letsencryptDir) {
      report.ssl.note = 'dilewati (bot tidak jalan sebagai root)';
    } else {
      const sslDomains = Array.isArray(manifest.summary?.ssl_domains) ? manifest.summary.ssl_domains : [];
      const skip = new Set(sslDomains.filter((domain) => (
        fs.existsSync(path.join(letsencryptDir, 'live', domain, 'fullchain.pem'))
      )));
      const selected = sslEntries.filter((entry) => !skip.has(letsencryptDomainOf(entry.name)));
      try {
        restoreTreeEntries(letsencryptDir, selected);
        report.ssl.restored = sslDomains.filter((domain) => !skip.has(domain));
        report.ssl.skipped = Array.from(skip);
      } catch (err) {
        report.ssl.note = `gagal: ${err.message}`;
        report.warnings.push(`Sertifikat SSL gagal dipulihkan: ${err.message}`);
      }
    }
  }

  return report;
}

module.exports = {
  SERVER_BACKUP_EXTENSION,
  SERVER_BACKUP_PASSWORD_MIN,
  assertBackupPassword,
  compareScriptVersions,
  createServerBackup,
  decodeServerBackup,
  encodeServerBackup,
  extractScriptVersion,
  licenseKeyInfo,
  licenseKeyFingerprintOfFile,
  looksLikeServerBackup,
  mergeEnvForRestore,
  parseEnvText,
  resolveLicenseKeyPaths,
  restoreServerBackup,
  restoreSqliteInPlace
};

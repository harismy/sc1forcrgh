const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TEXT_MAX_BYTES = 8 * 1024 * 1024;
const ARCHIVE_LIST_MAX_BYTES = 4 * 1024 * 1024;
const PROTOCOLS = ['ssh', 'vmess', 'vless', 'trojan'];
const ZIP_CACHE = new Map();

function runArchiveCommand(cmd, args, maxBuffer = TEXT_MAX_BYTES) {
  return execFileSync(cmd, args, {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    maxBuffer
  });
}

function normalizeArchiveName(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function isSafeArchiveName(name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized || normalized.includes('\0')) return false;
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) return false;
  return normalized.split('/').every((part) => part && part !== '.' && part !== '..');
}

function safeLocalFileName(name) {
  const base = path.basename(String(name || 'backup.zip')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'backup.zip';
}

function findZipEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function parseZipArchive(archivePath) {
  const buffer = fs.readFileSync(archivePath);
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('bukan ZIP standar');
  }
  const eocd = findZipEocd(buffer);
  if (eocd < 0) throw new Error('central directory ZIP tidak ditemukan');

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralDirSize = buffer.readUInt32LE(eocd + 12);
  const centralDirOffset = buffer.readUInt32LE(eocd + 16);
  if (centralDirOffset < 0 || centralDirOffset + centralDirSize > buffer.length) {
    throw new Error('central directory ZIP rusak');
  }

  const records = [];
  let ptr = centralDirOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (ptr + 46 > buffer.length || buffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('entry central directory ZIP rusak');
    }
    const flags = buffer.readUInt16LE(ptr + 8);
    const method = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const uncompressedSize = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const nameStart = ptr + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buffer.length) throw new Error('nama entry ZIP rusak');

    const rawName = buffer.subarray(nameStart, nameEnd).toString('utf8');
    const name = normalizeArchiveName(rawName);
    if (name && !name.endsWith('/')) {
      if (!isSafeArchiveName(name)) throw new Error(`path arsip tidak aman: ${name}`);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('ZIP64 belum didukung');
      }
      records.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    }
    ptr = nameEnd + extraLen + commentLen;
  }

  const byLower = new Map(records.map((entry) => [entry.name.toLowerCase(), entry]));
  return {
    entries: records.map((entry) => entry.name),
    readEntry(entryName) {
      const entry = byLower.get(normalizeArchiveName(entryName).toLowerCase());
      if (!entry) return '';
      if (entry.flags & 1) throw new Error(`entry terenkripsi tidak didukung: ${entry.name}`);
      if (entry.uncompressedSize > TEXT_MAX_BYTES) throw new Error(`entry terlalu besar: ${entry.name}`);
      const local = entry.localOffset;
      if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
        throw new Error(`local header ZIP rusak: ${entry.name}`);
      }
      const nameLen = buffer.readUInt16LE(local + 26);
      const extraLen = buffer.readUInt16LE(local + 28);
      const dataStart = local + 30 + nameLen + extraLen;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataStart < 0 || dataEnd > buffer.length) throw new Error(`data ZIP rusak: ${entry.name}`);
      const raw = buffer.subarray(dataStart, dataEnd);
      let out;
      if (entry.method === 0) {
        out = raw;
      } else if (entry.method === 8) {
        out = zlib.inflateRawSync(raw, { maxOutputLength: TEXT_MAX_BYTES });
      } else {
        throw new Error(`metode kompresi ZIP tidak didukung (${entry.method}): ${entry.name}`);
      }
      return out.toString('utf8');
    }
  };
}

function getZipArchive(archivePath) {
  const key = path.resolve(String(archivePath || ''));
  if (ZIP_CACHE.has(key)) return ZIP_CACHE.get(key);
  const parsed = parseZipArchive(key);
  ZIP_CACHE.set(key, parsed);
  return parsed;
}

function clearZipArchive(archivePath) {
  try { ZIP_CACHE.delete(path.resolve(String(archivePath || ''))); } catch (_) {}
}

function listArchiveEntries(archivePath) {
  const errors = [];
  try {
    return getZipArchive(archivePath).entries;
  } catch (err) {
    errors.push(`zip: ${err.message}`);
  }
  for (const spec of [
    { cmd: 'unzip', args: ['-Z1', archivePath] },
    { cmd: 'tar', args: ['-tf', archivePath] }
  ]) {
    try {
      const out = runArchiveCommand(spec.cmd, spec.args, ARCHIVE_LIST_MAX_BYTES).toString('utf8');
      const entries = out
        .split(/\r?\n/)
        .map(normalizeArchiveName)
        .filter(Boolean)
        .filter((entry) => !entry.endsWith('/'));
      const unsafe = entries.find((entry) => !isSafeArchiveName(entry));
      if (unsafe) throw new Error(`path arsip tidak aman: ${unsafe}`);
      return entries;
    } catch (err) {
      errors.push(`${spec.cmd}: ${err.message}`);
    }
  }
  throw new Error(`gagal membaca daftar file ZIP (${errors.join('; ')})`);
}

function readArchiveEntry(archivePath, entry) {
  const safeEntry = normalizeArchiveName(entry);
  if (!isSafeArchiveName(safeEntry)) return '';

  try {
    return getZipArchive(archivePath).readEntry(safeEntry);
  } catch (_) {
    // try external archive readers below
  }

  for (const spec of [
    { cmd: 'unzip', args: ['-p', archivePath, safeEntry] },
    { cmd: 'tar', args: ['-xOf', archivePath, safeEntry] }
  ]) {
    try {
      return runArchiveCommand(spec.cmd, spec.args, TEXT_MAX_BYTES).toString('utf8');
    } catch (_) {
      // try next archive reader
    }
  }
  return '';
}

function stripAnsi(input) {
  return String(input || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

function findEntry(entries, candidates) {
  const byLower = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
  for (const candidate of candidates) {
    const hit = byLower.get(normalizeArchiveName(candidate).toLowerCase());
    if (hit) return hit;
  }
  for (const candidate of candidates) {
    const suffix = `/${normalizeArchiveName(candidate).toLowerCase()}`;
    const hit = entries.find((entry) => entry.toLowerCase().endsWith(suffix));
    if (hit) return hit;
  }
  return '';
}

function readFirstEntryText(archivePath, entries, candidates) {
  const entry = findEntry(entries, candidates);
  return entry ? readArchiveEntry(archivePath, entry) : '';
}

function parseNumber(input, fallback = 0) {
  const n = Number(String(input ?? '').replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function bytesToQuotaGb(input) {
  const n = parseNumber(input, 0);
  if (n <= 0) return 0;
  if (n < 1024 * 1024) return n;
  return Math.max(1, Math.ceil(n / (1024 * 1024 * 1024)));
}

function isUuidLike(input) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(input || '').trim());
}

function deterministicUuid(seed) {
  const chars = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = (8 + (parseInt(chars[16] || '0', 16) % 4)).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeUsername(input) {
  const username = String(input || '').trim();
  if (!username || /\s/.test(username) || username.length > 80) return '';
  if (/^[#{}[\]'",:]+$/.test(username)) return '';
  return username;
}

function normalizeDateYmd(input) {
  const raw = String(input || '').trim();
  const ymd = raw.match(/\b(20\d{2}|19\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (ymd) {
    const y = ymd[1];
    const m = String(Number(ymd[2])).padStart(2, '0');
    const d = String(Number(ymd[3])).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const monthMap = {
    jan: '01', january: '01', januari: '01',
    feb: '02', february: '02', februari: '02',
    mar: '03', march: '03', maret: '03',
    apr: '04', april: '04',
    may: '05', mei: '05',
    jun: '06', june: '06', juni: '06',
    jul: '07', july: '07', juli: '07',
    aug: '08', august: '08', agustus: '08',
    sep: '09', sept: '09', september: '09',
    oct: '10', october: '10', oktober: '10',
    nov: '11', november: '11',
    dec: '12', december: '12', desember: '12'
  };
  const named = raw.replace(',', '').match(/\b(\d{1,2})\s+([a-zA-Z]+)\s+(20\d{2}|19\d{2})\b/);
  if (named) {
    const day = String(Number(named[1])).padStart(2, '0');
    const month = monthMap[String(named[2] || '').toLowerCase()];
    const year = named[3];
    if (month) return `${year}-${month}-${day}`;
  }
  return '';
}

function todayYmdJakarta() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isExpiredDateYmd(input) {
  const ymd = normalizeDateYmd(input);
  if (!ymd) return false;
  return ymd <= todayYmdJakarta();
}

function normalizeBackupStatus(statusInput, dateExp) {
  const s = String(statusInput || '').trim().toUpperCase();
  if (isExpiredDateYmd(dateExp)) return 'EXPIRED';
  if (['EXPIRED', 'KADALUARSA', 'EXPIRE'].includes(s)) return 'EXPIRED';
  if (['LOCK', 'LOCKED', 'LOCK_TMP', 'LOCK_QUOTA', 'BANNED', 'BAN'].includes(s)) return 'LOCK';
  return 'AKTIF';
}

function dateScore(dateExp) {
  const ymd = normalizeDateYmd(dateExp);
  if (!ymd) return 0;
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(t) ? t : 0;
}

function makeEmptyData() {
  return {
    ssh: [],
    vmess: [],
    vless: [],
    trojan: [],
    zivpn_auth: []
  };
}

function mergeAccount(map, row, secretField) {
  const username = normalizeUsername(row?.username);
  if (!username) return;
  const key = username.toLowerCase();
  const dateExp = normalizeDateYmd(row?.date_exp) || normalizeDateYmd(row?.exp) || normalizeDateYmd(row?.expired);
  const incoming = {
    username,
    date_exp: dateExp,
    status: normalizeBackupStatus(row?.status, dateExp),
    quota: parseNumber(row?.quota, 0),
    limitip: parseNumber(row?.limitip ?? row?.limit_ip, 0)
  };
  const secret = String(row?.[secretField] || row?.uuid || row?.password || row?.id || row?.secret || '').trim();
  if (secret) incoming[secretField] = secret;

  const existing = map.get(key);
  if (!existing) {
    map.set(key, incoming);
    return;
  }

  const oldScore = dateScore(existing.date_exp);
  const newScore = dateScore(incoming.date_exp);
  const base = newScore >= oldScore ? { ...existing, ...incoming } : { ...incoming, ...existing };
  if (!String(base[secretField] || '').trim()) {
    base[secretField] = String(existing[secretField] || incoming[secretField] || '').trim();
  }
  base.quota = Number(base.quota || 0) || Number(existing.quota || incoming.quota || 0) || 0;
  base.limitip = Number(base.limitip || 0) || Number(existing.limitip || incoming.limitip || 0) || 0;
  map.set(key, base);
}

function markerType(marker) {
  const m = String(marker || '').trim();
  if (m.startsWith('#!')) return 'trojan';
  if (m.includes('&')) return 'vless';
  if (m.startsWith('#ssh#')) return 'ssh';
  if (m.startsWith('###')) return 'vmess';
  return '';
}

function parseUserAllDb(text) {
  const creds = { vmess: new Map(), vless: new Map(), trojan: new Map() };
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(###|##&|#&|#!+)\s+(\S+)\s+(\S+)/);
    if (!match) continue;
    const type = markerType(match[1]);
    const username = normalizeUsername(match[2]);
    const secret = String(match[3] || '').trim();
    if (type && username && secret) creds[type].set(username.toLowerCase(), secret);
  }
  return creds;
}

function parseSshDb(text, sshMap) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(?:###|#ssh#)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/i);
    if (!match) continue;
    mergeAccount(sshMap, {
      username: match[1],
      password: match[2],
      quota: match[3],
      limitip: match[4],
      date_exp: normalizeDateYmd(match[5])
    }, 'password');
  }
}

function parseProtocolDb(type, text, accountMap, credentialMaps) {
  const secretField = type === 'trojan' ? 'password' : 'uuid';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const marker = line.match(/^(###|##&|#&|#!+)\s+(\S+)\s+(\d{4}-\d{1,2}-\d{1,2})(?:\s+(\S+))?(?:\s+(\d+))?(?:\s+(\d+))?/);
    if (marker) {
      const markedType = markerType(marker[1]);
      if (markedType && markedType !== type) continue;
      const username = normalizeUsername(marker[2]);
      const fallbackSecret = username ? credentialMaps[type]?.get(username.toLowerCase()) : '';
      mergeAccount(accountMap, {
        username,
        date_exp: marker[3],
        [secretField]: marker[4] || fallbackSecret || '',
        quota: marker[5],
        limitip: marker[6]
      }, secretField);
      continue;
    }

    const plain = line.match(/^(\S+)\s+(\d{4}-\d{1,2}-\d{1,2})(?:\s+\d{1,2}:\d{2}:\d{2})?/);
    if (!plain) continue;
    const username = normalizeUsername(plain[1]);
    const fallbackSecret = username ? credentialMaps[type]?.get(username.toLowerCase()) : '';
    mergeAccount(accountMap, {
      username,
      date_exp: plain[2],
      [secretField]: fallbackSecret || ''
    }, secretField);
  }
}

function updateCredentialMap(credentialMaps, type, username, secret) {
  const t = String(type || '').trim().toLowerCase();
  const u = normalizeUsername(username);
  const s = String(secret || '').trim();
  if (!credentialMaps[t] || !u || !s) return;
  credentialMaps[t].set(u.toLowerCase(), s);
}

function parseLooseXrayConfig(text, credentialMaps) {
  let currentProtocol = '';
  const clean = String(text || '');
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    const proto = line.match(/"protocol"\s*:\s*"([^"]+)"/i);
    if (proto) {
      const p = String(proto[1] || '').toLowerCase();
      currentProtocol = PROTOCOLS.includes(p) && p !== 'ssh' ? p : '';
    }
    if (!currentProtocol) continue;
    const email = line.match(/"email"\s*:\s*"([^"]+)"/i);
    if (!email) continue;
    const cred = currentProtocol === 'trojan'
      ? line.match(/"password"\s*:\s*"([^"]+)"/i)
      : line.match(/"id"\s*:\s*"([^"]+)"/i);
    if (cred) updateCredentialMap(credentialMaps, currentProtocol, email[1], cred[1]);
  }
}

function detectTypeFromPath(input) {
  const s = String(input || '').toLowerCase();
  if (s.includes('trojan')) return 'trojan';
  if (s.includes('vless')) return 'vless';
  if (s.includes('vmess')) return 'vmess';
  return '';
}

function parseXrayJsonFile(text, credentialMaps) {
  try {
    const obj = JSON.parse(String(text || '').trim());
    const username = normalizeUsername(obj.ps || obj.email || obj.remark || obj.username);
    const secret = String(obj.id || obj.password || obj.uuid || '').trim();
    const type = detectTypeFromPath(obj.path || obj.serviceName || obj.net || '') || detectTypeFromPath(obj.protocol || '');
    if (type && username && secret) updateCredentialMap(credentialMaps, type, username, secret);
  } catch (_) {
    // ignore non-JSON account files
  }
}

function readLogValue(text, label) {
  const re = new RegExp(`${label}\\s*:\\s*([^\\n]+)`, 'i');
  const hit = String(text || '').match(re);
  return hit ? String(hit[1] || '').trim() : '';
}

function parseXrayLog(text, maps, credentialMaps) {
  const clean = stripAnsi(text);
  const username = normalizeUsername(readLogValue(clean, 'Remarks'));
  if (!username) return;
  const type = detectTypeFromPath(clean);
  if (!type || type === 'ssh') return;
  const secretField = type === 'trojan' ? 'password' : 'uuid';
  const secret = readLogValue(clean, 'User ID');
  const quota = parseNumber(readLogValue(clean, 'User Quota'), 0);
  const limitip = parseNumber(readLogValue(clean, 'User Ip'), 0);
  const dateExp = normalizeDateYmd(readLogValue(clean, 'Expires date'));
  if (secret) updateCredentialMap(credentialMaps, type, username, secret);
  mergeAccount(maps[type], {
    username,
    date_exp: dateExp,
    [secretField]: secret,
    quota,
    limitip
  }, secretField);
}

function parseClashText(text, credentialMaps) {
  const clean = stripAnsi(text);
  const typeMatch = clean.match(/\btype\s*:\s*(vmess|vless|trojan)\b/i) || clean.match(/\b(vmess|vless|trojan):\/\//i);
  const type = typeMatch ? String(typeMatch[1] || '').toLowerCase() : '';
  if (!type || !credentialMaps[type]) return;

  const nameMatch = clean.match(/\bname\s*:\s*["']?(?:vmess|vless|trojan)-?([^\s"']+)/i);
  const hashMatch = clean.match(new RegExp(`${type}://[^\\s#]+#([^\\s]+)`, 'i'));
  const username = normalizeUsername(nameMatch?.[1] || hashMatch?.[1] || '');
  if (!username) return;

  const secretMatch = type === 'trojan'
    ? (clean.match(/\buuid\s*:\s*([^\s"'#]+)/i) || clean.match(/trojan:\/\/([^@\s]+)/i))
    : (clean.match(/\buuid\s*:\s*([^\s"'#]+)/i) || clean.match(/\bid\s*:\s*([^\s"'#]+)/i));
  if (secretMatch) updateCredentialMap(credentialMaps, type, username, secretMatch[1]);
}

function parseZivpnUsers(text) {
  try {
    const parsed = JSON.parse(String(text || '').trim());
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.users) ? parsed.users : [];
    return list
      .map((row) => ({
        username: normalizeUsername(row?.username),
        password: String(row?.password || '').trim(),
        expiry_timestamp: Number(row?.expiry_timestamp || 0)
      }))
      .filter((row) => row.username && row.password);
  } catch (_) {
    return [];
  }
}

function fillMissingSecrets(maps, credentialMaps) {
  for (const type of ['vmess', 'vless', 'trojan']) {
    const secretField = type === 'trojan' ? 'password' : 'uuid';
    for (const [key, row] of maps[type].entries()) {
      if (String(row[secretField] || '').trim()) continue;
      const secret = credentialMaps[type]?.get(key);
      if (secret) {
        maps[type].set(key, { ...row, [secretField]: secret });
      }
    }
  }
}

function applyLimitFile(maps, type, kind, username, rawValue) {
  const t = String(type || '').trim().toLowerCase();
  const map = maps[t];
  if (!map) return;
  const u = normalizeUsername(username);
  if (!u) return;
  const key = u.toLowerCase();
  const row = map.get(key);
  if (!row) return;
  const value = kind === 'quota' ? bytesToQuotaGb(rawValue) : parseNumber(rawValue, 0);
  if (value <= 0) return;
  if (kind === 'quota') {
    map.set(key, { ...row, quota: Number(row.quota || 0) > 0 ? Number(row.quota || 0) : value });
  } else {
    map.set(key, { ...row, limitip: Number(row.limitip || 0) > 0 ? Number(row.limitip || 0) : value });
  }
}

function applyLimitFiles(archivePath, entries, maps) {
  for (const entry of entries) {
    const match = entry.match(/(?:^|\/)backup\/limit\/(ssh|vmess|vless|trojan)\/(ip|quota)\/([^/]+)$/i);
    if (!match) continue;
    const rawValue = readArchiveEntry(archivePath, entry).trim();
    applyLimitFile(maps, match[1], match[2], match[3], rawValue);
  }
}

function countExpiredAccounts(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const status = String(row?.status || '').trim().toUpperCase();
    return status === 'EXPIRED' || isExpiredDateYmd(row?.date_exp);
  }).length;
}

function buildSummary(data, warnings) {
  const expired = {
    ssh: countExpiredAccounts(data.ssh),
    vmess: countExpiredAccounts(data.vmess),
    vless: countExpiredAccounts(data.vless),
    trojan: countExpiredAccounts(data.trojan)
  };
  const active = {
    ssh: Math.max(0, data.ssh.length - expired.ssh),
    vmess: Math.max(0, data.vmess.length - expired.vmess),
    vless: Math.max(0, data.vless.length - expired.vless),
    trojan: Math.max(0, data.trojan.length - expired.trojan)
  };
  return {
    format: 'foreign-autoscript-zip',
    ssh: data.ssh.length,
    vmess: data.vmess.length,
    vless: data.vless.length,
    trojan: data.trojan.length,
    zivpn_auth: data.zivpn_auth.length,
    active,
    expired,
    warnings: Array.isArray(warnings) ? warnings : []
  };
}

function parseForeignBackupArchiveInner(archivePath) {
  const entries = listArchiveEntries(archivePath);
  const data = makeEmptyData();
  const maps = {
    ssh: new Map(),
    vmess: new Map(),
    vless: new Map(),
    trojan: new Map()
  };
  const warnings = [];

  const userAllText = readFirstEntryText(archivePath, entries, ['backup/xray/.userall.db', 'xray/.userall.db', '.userall.db']);
  const credentialMaps = parseUserAllDb(userAllText);

  const xrayConfigText = readFirstEntryText(archivePath, entries, ['backup/xray/config.json', 'xray/config.json']);
  if (xrayConfigText) parseLooseXrayConfig(xrayConfigText, credentialMaps);

  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (/\/xray\/[^/]+\.json$/.test(lower) && !/\/xray\/config\.json(?:\.tmp)?$/.test(lower)) {
      parseXrayJsonFile(readArchiveEntry(archivePath, entry), credentialMaps);
    }
  }

  parseSshDb(readFirstEntryText(archivePath, entries, ['backup/.ssh.db', 'backup/ssh/.ssh.db', 'ssh/.ssh.db', '.ssh.db']), maps.ssh);
  parseProtocolDb('vmess', readFirstEntryText(archivePath, entries, ['backup/.vmess.db', 'backup/vmess/.vmess.db', 'vmess/.vmess.db', '.vmess.db']), maps.vmess, credentialMaps);
  parseProtocolDb('vless', readFirstEntryText(archivePath, entries, ['backup/.vless.db', 'backup/vless/.vless.db', 'vless/.vless.db', '.vless.db']), maps.vless, credentialMaps);
  parseProtocolDb('trojan', readFirstEntryText(archivePath, entries, ['backup/.trojan.db', 'backup/trojan/.trojan.db', 'trojan/.trojan.db', '.trojan.db']), maps.trojan, credentialMaps);

  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (/\/xray\/log-create-[^/]+\.log$/.test(lower)) {
      parseXrayLog(readArchiveEntry(archivePath, entry), maps, credentialMaps);
    }
    if (/\/html\/.*\.(?:txt|yaml|yml)$/.test(lower)) {
      parseClashText(readArchiveEntry(archivePath, entry), credentialMaps);
    }
  }

  applyLimitFiles(archivePath, entries, maps);
  fillMissingSecrets(maps, credentialMaps);

  for (const type of PROTOCOLS) {
    data[type] = Array.from(maps[type].values())
      .map((row) => ({ ...row, status: String(row.status || 'AKTIF') }))
      .sort((a, b) => String(a.username).localeCompare(String(b.username), 'en', { sensitivity: 'base' }));
  }

  for (const type of ['vmess', 'vless']) {
    let converted = 0;
    for (const row of data[type]) {
      const current = String(row.uuid || '').trim();
      if (!current || isUuidLike(current)) continue;
      row.original_uuid = current;
      row.uuid = deterministicUuid(`${type}:${row.username}:${current}`);
      converted += 1;
    }
    if (converted) {
      warnings.push(`${type.toUpperCase()}: ${converted} ID pendek dikonversi ke UUID baru; link lama perlu dibuat ulang dari SC target`);
    }
  }

  for (const type of ['vmess', 'vless', 'trojan']) {
    const secretField = type === 'trojan' ? 'password' : 'uuid';
    const missing = data[type].filter((row) => !String(row[secretField] || '').trim()).length;
    if (missing) warnings.push(`${type.toUpperCase()}: ${missing} akun tanpa credential, kemungkinan akan diskip/gagal saat sync`);
  }

  const zivpnText = readFirstEntryText(archivePath, entries, ['backup/zivpn/users.db.json', 'zivpn/users.db.json']);
  data.zivpn_auth = parseZivpnUsers(zivpnText);

  return {
    meta: {
      format: 'foreign-autoscript-zip',
      source_entries: entries.length,
      parsed_at: new Date().toISOString()
    },
    data,
    summary: buildSummary(data, warnings),
    warnings
  };
}

function parseForeignBackupArchive(archivePath) {
  try {
    return parseForeignBackupArchiveInner(archivePath);
  } finally {
    clearZipArchive(archivePath);
  }
}

function parseForeignBackupBuffer(buffer, fileName = 'backup.zip') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-foreign-backup-'));
  const archivePath = path.join(tempDir, safeLocalFileName(fileName));
  try {
    fs.writeFileSync(archivePath, Buffer.from(buffer || ''));
    return parseForeignBackupArchive(archivePath);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  parseForeignBackupArchive,
  parseForeignBackupBuffer
};

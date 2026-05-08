const qs = require('qs');
const fs = require('fs');
const path = require('path');

function loadVars() {
  try {
    const varsPath = path.join(__dirname, '.vars.json');
    return JSON.parse(fs.readFileSync(varsPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function buildPayload() {
  const vars = loadVars();
  return qs.stringify({
    username: vars.ORKUT_USERNAME || 'AKUN_DEFAULT',
    token: vars.ORKUT_TOKEN || 'TOKEN_DEFAULT',
    jenis: 'masuk'
  });
}

const headers = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept-Encoding': 'gzip',
  'User-Agent': 'okhttp/4.12.0'
};

const API_URL = 'https://orkutapi.andyyuda41.workers.dev/api/qris-history';

module.exports = { buildPayload, headers, API_URL };

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installerPath = path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh');

function extractGuardSource() {
  const source = fs.readFileSync(installerPath, 'utf8').replace(/\r\n/g, '\n');
  const startMarker = "<<'LICENSE_GUARD_JS_EOF'\n";
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error('start marker license guard tidak ditemukan');
  const bodyStart = start + startMarker.length;
  const end = source.indexOf('\nLICENSE_GUARD_JS_EOF\n', bodyStart);
  if (end < 0) throw new Error('end marker license guard tidak ditemukan');
  return `${source.slice(bodyStart, end)}\n`;
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signPayload(privateKey, payload) {
  const segment = b64urlJson(payload);
  const signature = crypto.sign(null, Buffer.from(segment, 'ascii'), privateKey);
  return `${segment}.${signature.toString('base64url')}`;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function runGuard(guardPath, args, env) {
  return spawnSync(process.execPath, [guardPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function assertExit(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(`${label}: exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-license-test-'));
  try {
    const guardPath = path.join(tmp, 'license-guard.js');
    const publicKeyPath = path.join(tmp, 'public.pem');
    const leasePath = path.join(tmp, 'lease.token');
    const markerPath = path.join(tmp, 'required');
    const statePath = path.join(tmp, 'state.json');
    const machineIdPath = path.join(tmp, 'machine-id');
    const updatePath = path.join(tmp, 'update.sh');
    fs.writeFileSync(guardPath, extractGuardSource(), { mode: 0o700 });

    const pair = crypto.generateKeyPairSync('ed25519');
    const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(publicKeyPath, publicPem);
    fs.writeFileSync(markerPath, 'required=1\n');
    const machineId = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(machineIdPath, `${machineId}\n`);
    const serverKey = crypto.randomBytes(24).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const baseEnv = {
      LICENSE_LEASE_FILE: leasePath,
      LICENSE_PUBLIC_KEY_FILE: publicKeyPath,
      LICENSE_REQUIRED_MARKER: markerPath,
      SC_UPDATE_KEY: serverKey,
      LICENSE_API_URL: '',
      LICENSE_LEASE_REFRESH_MINUTES: '15',
      SCRIPT_VERSION: 'V.TEST',
      // Guard state default berada di /var; status test tidak memerlukan file tersebut.
      LICENSE_GUARD_STATE_FILE: statePath,
      LICENSE_MACHINE_ID_FILE: machineIdPath
    };
    const activePayload = {
      v: 1,
      iss: 'sc1forcr-license-api',
      aud: 'sc1forcr-runtime',
      sub: '1:127.0.0.1',
      status: 'active',
      reason: 'test-active',
      user_id: 1,
      bound_ip: '127.0.0.1',
      machine_id_hash: sha256Hex(machineId),
      key_id: sha256Hex(serverKey).slice(0, 32),
      issued_at: now,
      refresh_after: now + 300,
      lease_until: now + 600,
      grace_until: now + 1200,
      registration_expires_at: now + 3600,
      script_version: 'V.TEST'
    };

    const activeToken = signPayload(pair.privateKey, activePayload);
    fs.writeFileSync(leasePath, `${activeToken}\n`);
    assertExit(runGuard(guardPath, ['check', '--json'], baseEnv), 0, 'active lease harus diterima');

    assertExit(
      runGuard(guardPath, ['check', '--json'], { ...baseEnv, SC_UPDATE_KEY: crypto.randomBytes(24).toString('hex') }),
      1,
      'lease dari key VPS lain harus ditolak'
    );
    assertExit(
      runGuard(guardPath, ['check', '--json'], { ...baseEnv, LICENSE_MACHINE_ID_FILE: path.join(tmp, 'missing-machine-id') }),
      1,
      'machine-id yang hilang harus ditolak'
    );
    const otherMachineIdPath = path.join(tmp, 'other-machine-id');
    fs.writeFileSync(otherMachineIdPath, `${crypto.randomBytes(16).toString('hex')}\n`);
    assertExit(
      runGuard(guardPath, ['check', '--json'], { ...baseEnv, LICENSE_MACHINE_ID_FILE: otherMachineIdPath }),
      1,
      'lease dari machine-id lain harus ditolak'
    );

    const tampered = `${activeToken.slice(0, -1)}${activeToken.endsWith('a') ? 'b' : 'a'}`;
    fs.writeFileSync(leasePath, `${tampered}\n`);
    assertExit(runGuard(guardPath, ['check', '--json'], baseEnv), 1, 'tampered lease harus ditolak');

    const expiredToken = signPayload(pair.privateKey, {
      ...activePayload,
      issued_at: now - 3600,
      refresh_after: now - 3500,
      lease_until: now - 1800,
      grace_until: now - 60,
      registration_expires_at: now + 3600
    });
    fs.writeFileSync(leasePath, `${expiredToken}\n`);
    assertExit(runGuard(guardPath, ['check', '--json'], baseEnv), 1, 'expired lease harus ditolak');

    const registrationExpiredToken = signPayload(pair.privateKey, {
      ...activePayload,
      registration_expires_at: now - 1,
      lease_until: now + 600,
      grace_until: now + 1200
    });
    fs.writeFileSync(leasePath, `${registrationExpiredToken}\n`);
    assertExit(runGuard(guardPath, ['check', '--json'], baseEnv), 1, 'masa sewa server yang habis harus ditolak');

    const blockedToken = signPayload(pair.privateKey, {
      ...activePayload,
      status: 'blocked',
      reason: 'test-blocked'
    });
    fs.writeFileSync(leasePath, `${blockedToken}\n`);
    assertExit(runGuard(guardPath, ['check', '--json'], baseEnv), 1, 'lease blocked bertanda tangan harus ditolak');

    const updateBytes = Buffer.from('#!/usr/bin/env bash\necho update\n', 'utf8');
    fs.writeFileSync(updatePath, updateBytes);
    const manifestToken = signPayload(pair.privateKey, {
      v: 1,
      iss: 'sc1forcr-license-api',
      aud: 'sc1forcr-update',
      bound_ip: '127.0.0.1',
      user_id: 1,
      key_id: sha256Hex(serverKey).slice(0, 32),
      file: 'scripts/setup-autoscript-compat.sh',
      version: 'V.TEST',
      sha256: crypto.createHash('sha256').update(updateBytes).digest('hex'),
      size: updateBytes.length,
      issued_at: now,
      valid_until: now + 600
    });
    assertExit(runGuard(guardPath, ['verify-update', updatePath, manifestToken, '--json'], baseEnv), 0, 'manifest valid harus diterima');
    fs.appendFileSync(updatePath, '# changed\n');
    assertExit(runGuard(guardPath, ['verify-update', updatePath, manifestToken, '--json'], baseEnv), 1, 'file update berubah harus ditolak');

    console.log('license lease tests: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();

'use strict';

// Chain penghitung kuota SSH (SC_1FORCR_QUOTA_OUT, iplimit-checker.js), V.1FSC.136.
// Yang dijaga:
// - satu rule per UID akun aktif; rule akun yang sudah tidak ada dibuang. Di
//   id2 (V.1FSC.135) ada 92 rule untuk ~68 UID, dan rule akun lama berada di
//   atas rule akun baru yang memakai ulang UID-nya;
// - pembangunan ulang lewat satu iptables-restore --noflush --counters, counter
//   rule yang tetap (UID + akun sama) dibawa;
// - akun baru saja = rule ditambah (-A), tanpa membangun ulang;
// - jump kuota di bawah gerbang ON/OFF dan ACCEPT balasan dnstt, dengan
//   rentang UID akun (nobody/root/dnstt tidak menelusuri rule owner);
// - daftar akun kosong (database gagal dibaca) tidak menyentuh rule;
// - iptables-restore gagal = rule basi dibuang satu per satu.
// Uji di kernel Linux asli (nf_tables, netns) tercatat di docs/slowdns-cpu-v136.md.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const installer = fs.readFileSync(path.join(__dirname, 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');
const checker = installer.split("cat > \"${APP_DIR}/iplimit-checker.js\" <<'EOF'\n")[1].split('\nEOF\n')[0];
const pick = (a, b) => {
  const i = checker.indexOf(a);
  const j = checker.indexOf(b, i);
  assert(i >= 0 && j > i, `blok tidak ditemukan: ${a}`);
  return checker.slice(i, j);
};
const source = [
  pick('function safeExec(', '\n// Kumpulkan PID'),
  pick('function readExec(', '\nlet xrayOnlineStatsSupportCache'),
  pick('// Penghitung kuota SSH berbasis owner', '\nfunction parseXrayStatsOutput(')
].join('\n');
assert(checker.includes('const sshCounters = setupSshQuotaAccounting(sshRows);'), 'enforceQuotaLimits memakai setupSshQuotaAccounting');

// iptables tiruan: chain -> [{spec, pkts, bytes}], format -L/-S seperti nf_tables.
function fakeNet() {
  const chains = new Map([['OUTPUT', []]]);
  const ops = [];
  const st = { failRestore: false, failRange: false, passwd: '' };
  const fmtL = (r) => {
    const m = r.spec.match(/--uid-owner (\S+) .*--comment (\S+) -j (\S+)/);
    const tail = m ? `owner UID match ${m[1]} /* ${m[2]} */` : r.spec;
    const target = m ? m[3] : (r.spec.match(/-j (\S+)/) || [])[1];
    return `${String(r.pkts).padStart(8)} ${String(r.bytes).padStart(8)} ${target.padEnd(10)} 0    --  *      *       0.0.0.0/0            0.0.0.0/0            ${tail}`;
  };
  const execFileSync = (cmd, args, opts = {}) => {
    const a = args.filter((x, i) => !(x === '-w' || args[i - 1] === '-w'));
    if (cmd === 'id') {
      const m = st.passwd.split('\n').find((l) => l.startsWith(`${a[1]}:`));
      if (!m) throw Error('no such user');
      return `${m.split(':')[2]}\n`;
    }
    if (cmd === 'iptables-restore') {
      ops.push('restore');
      if (st.failRestore) throw Error('restore failed');
      assert.strictEqual(a.join(' '), '--noflush --counters');
      for (const line of String(opts.input).split('\n')) {
        let m;
        if ((m = line.match(/^:(\S+) - \[0:0\]$/))) chains.set(m[1], []);
        else if ((m = line.match(/^(?:\[(\d+):(\d+)\] )?-A (\S+) (.*)$/))) chains.get(m[3]).push({ spec: m[4], pkts: Number(m[1] || 0), bytes: Number(m[2] || 0) });
      }
      return '';
    }
    assert.strictEqual(cmd, 'iptables');
    const [op, chain, ...rest] = a;
    const rules = chains.get(chain);
    if (op === '-L') {
      if (!rules) throw Error('no chain');
      return [`Chain ${chain} (1 references)`, '    pkts      bytes target     prot opt in     out     source               destination', ...rules.map(fmtL)].join('\n') + '\n';
    }
    if (op === '-S') {
      if (!rules) throw Error('no chain');
      return [chain === 'OUTPUT' ? '-P OUTPUT ACCEPT' : `-N ${chain}`, ...rules.map((r) => `-A ${chain} ${r.spec}`)].join('\n') + '\n';
    }
    if (op === '-N') { ops.push(`-N ${chain}`); if (rules) throw Error('exists'); chains.set(chain, []); return ''; }
    if (!rules) throw Error('no chain');
    let pos = 0;
    let spec = rest;
    if (op === '-I' && /^\d+$/.test(rest[0])) { pos = Number(rest[0]) - 1; spec = rest.slice(1); }
    const text = spec.join(' ');
    if (op === '-C') { if (!rules.some((r) => r.spec === text)) throw Error('missing'); return ''; }
    ops.push(`${op} ${chain} ${text}`);
    if (op === '-A') { rules.push({ spec: text, pkts: 0, bytes: 0 }); return ''; }
    if (op === '-I') {
      if (st.failRange && /--uid-owner \d+-\d+/.test(text)) throw Error('range not supported');
      rules.splice(pos, 0, { spec: text, pkts: 0, bytes: 0 });
      return '';
    }
    if (op === '-D') {
      if (/^\d+$/.test(text)) {
        if (Number(text) < 1 || Number(text) > rules.length) throw Error('bad rule number');
        rules.splice(Number(text) - 1, 1);
        return '';
      }
      // iptables asli: -D spec menghapus salinan PERTAMA yang cocok.
      const i = rules.findIndex((r) => r.spec === text);
      if (i < 0) throw Error('missing');
      rules.splice(i, 1);
      return '';
    }
    throw Error(`op ${op}`);
  };
  const ctx = vm.createContext({
    console, execFileSync,
    fs: { readFileSync: (p) => { assert.strictEqual(p, '/etc/passwd'); return st.passwd; } }
  });
  vm.runInContext(`${source}\nthis.setup = setupSshQuotaAccounting;`, ctx);
  return { chains, ops, st, setup: ctx.setup };
}

const quotaRule = (uid, user, pkts = 0, bytes = 0) => ({ spec: `-m owner --uid-owner ${uid} -m comment --comment scquota:${user} -j RETURN`, pkts, bytes });
const ACCEPT = '-p udp -m udp --sport 5300 -m comment --comment sc-slowdns -j ACCEPT';
const GATE = '-j SC1FORCR_SVC_OUT';
const passwd = ['root:x:0:0::/root:/bin/bash', 'anjaytes:x:1000:995::/x:/bin/false', 'budi:x:1003:995::/x:/bin/false',
  'nobody:x:65534:65534::/x:/usr/sbin/nologin'].join('\n') + '\n';

// 1. Keadaan id2: rule akun lama di atas rule akun baru ber-UID sama + duplikat.
{
  const n = fakeNet();
  n.st.passwd = passwd;
  n.chains.set('SC_1FORCR_QUOTA_OUT', [quotaRule(1000, 'slowdnstest'), quotaRule(1001, 'slowdnstestbang'),
    quotaRule(1000, 'anjaytes', 7, 7000), quotaRule(1001, 'trial2377', 3, 300), quotaRule(1000, 'anjaytes', 5, 500)]);
  n.chains.set('OUTPUT', [{ spec: GATE, pkts: 0, bytes: 0 }, { spec: '-j SC_1FORCR_QUOTA_OUT', pkts: 0, bytes: 0 },
    { spec: ACCEPT, pkts: 0, bytes: 0 }, { spec: '-m conntrack --ctstate NEW -m owner --uid-owner 65534 -j SC1FORCR_TUN_OUT', pkts: 0, bytes: 0 }]);
  const map = n.setup([{ username: 'anjaytes' }, { username: 'budi' }, { username: 'hilang' }, { username: 'root' }]);
  assert.deepStrictEqual(n.chains.get('SC_1FORCR_QUOTA_OUT').map((r) => [r.spec, r.bytes]),
    [[quotaRule(1000, 'anjaytes').spec, 7000], [quotaRule(1003, 'budi').spec, 0]], 'satu rule per UID aktif, counter rule yang tetap dibawa');
  assert.strictEqual(n.ops.filter((o) => o === 'restore').length, 1, 'rule basi dibuang dalam satu commit iptables-restore');
  assert.deepStrictEqual(n.chains.get('OUTPUT').map((r) => r.spec).slice(0, 3),
    [GATE, ACCEPT, '-m owner --uid-owner 1000-1999 -j SC_1FORCR_QUOTA_OUT'], 'jump kuota di bawah gerbang dan ACCEPT dnstt, dengan rentang UID');
  assert.strictEqual(map.get('anjaytes'), 7000);
  assert.strictEqual(map.get('budi'), 0);
  assert(!map.has('slowdnstest') && !map.has('hilang') && !map.has('root'), 'akun tanpa UID atau UID 0 tidak dihitung');

  // 2. Siklus berikutnya tanpa perubahan: tidak menulis apa pun.
  n.ops.length = 0;
  n.chains.get('SC_1FORCR_QUOTA_OUT')[0].bytes = 9000;
  const again = n.setup([{ username: 'anjaytes' }, { username: 'budi' }]);
  assert.deepStrictEqual(n.ops, [], `tanpa perubahan: tidak ada penulisan (${n.ops.join(' | ')})`);
  assert.strictEqual(again.get('anjaytes'), 9000);

  // 3. Akun baru dalam rentang: cukup -A, counter lain tidak tersentuh.
  n.st.passwd += 'citra:x:1004:995::/x:/bin/false\n';
  n.setup([{ username: 'anjaytes' }, { username: 'budi' }, { username: 'citra' }]);
  assert.deepStrictEqual(n.ops, [`-A SC_1FORCR_QUOTA_OUT ${quotaRule(1004, 'citra').spec}`], n.ops.join(' | '));
  assert.strictEqual(n.chains.get('SC_1FORCR_QUOTA_OUT')[0].bytes, 9000);

  // 4. Akun di luar rentang: jump diganti, posisi tetap di bawah rule yang dipin.
  n.ops.length = 0;
  n.st.passwd += 'besar:x:2500:995::/x:/bin/false\n';
  n.setup([{ username: 'anjaytes' }, { username: 'besar' }]);
  assert.deepStrictEqual(n.chains.get('OUTPUT').map((r) => r.spec).slice(0, 3),
    [GATE, ACCEPT, '-m owner --uid-owner 1000-2999 -j SC_1FORCR_QUOTA_OUT']);
  assert.strictEqual(n.chains.get('OUTPUT').filter((r) => r.spec.endsWith('SC_1FORCR_QUOTA_OUT')).length, 1, 'jump tidak dobel');
  assert.strictEqual(n.chains.get('SC_1FORCR_QUOTA_OUT')[0].bytes, 9000, 'rebuild membawa counter akun yang tetap');
}

// 5. Daftar akun kosong (DB gagal dibaca): rule yang ada tidak disentuh.
{
  const n = fakeNet();
  n.st.passwd = passwd;
  n.chains.set('SC_1FORCR_QUOTA_OUT', [quotaRule(1000, 'anjaytes', 1, 100)]);
  assert.strictEqual(n.setup([]).size, 0);
  assert.deepStrictEqual(n.ops, []);
}

// 6. Chain belum ada, satu UID dipakai dua akun, rentang dekat nobody.
{
  const n = fakeNet();
  n.st.passwd = passwd + 'kembar:x:1000:995::/x:/bin/false\ntinggi:x:65000:995::/x:/bin/false\n';
  n.setup([{ username: 'anjaytes' }, { username: 'kembar' }, { username: 'tinggi' }]);
  assert.deepStrictEqual(n.chains.get('SC_1FORCR_QUOTA_OUT').map((r) => r.spec), [quotaRule(1000, 'anjaytes').spec, quotaRule(65000, 'tinggi').spec],
    'satu rule per UID');
  assert(n.chains.get('OUTPUT').some((r) => r.spec === '-m owner --uid-owner 1000-65533 -j SC_1FORCR_QUOTA_OUT'),
    'nobody (65534, Xray) tidak ikut rentang');
}

// 7. iptables-restore gagal: rule basi dibuang satu per satu; kernel menolak
//    rentang UID: jump polos lama.
{
  const n = fakeNet();
  n.st.passwd = passwd;
  n.st.failRestore = true;
  n.st.failRange = true;
  n.chains.set('SC_1FORCR_QUOTA_OUT', [quotaRule(1000, 'slowdnstest'), quotaRule(1000, 'anjaytes', 4, 400),
    { spec: '-p tcp -j RETURN', pkts: 0, bytes: 0 }, quotaRule(1000, 'anjaytes', 1, 10)]);
  const map = n.setup([{ username: 'anjaytes' }]);
  // Salinan pertama (counter terbesar, yang dipakai iptables) yang dipertahankan.
  assert.deepStrictEqual(n.chains.get('SC_1FORCR_QUOTA_OUT').map((r) => [r.spec, r.bytes]),
    [[quotaRule(1000, 'anjaytes').spec, 400], ['-p tcp -j RETURN', 0]], 'fallback: hapus per nomor rule dari bawah, rule asing dibiarkan');
  assert(n.chains.get('OUTPUT').some((r) => r.spec === '-j SC_1FORCR_QUOTA_OUT'), 'fallback jump polos');
  assert.strictEqual(map.get('anjaytes'), 400);
}

console.log('ssh quota chain tests passed');

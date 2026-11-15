'use strict';

// SlowDNS (sc-1forcr-slowdns, dnstt-server). Yang dijaga:
// - mati secara default dan watchdog tidak menyentuh iptables sama sekali;
// - setup memasang kunci, unit (MemoryMax, user sendiri), REDIRECT UDP 53 ->
//   port dnstt dengan jump di depan semua rule non-TCP (DNAT 1:65535 UDP
//   Custom ikut menelan port 53), lalu idempoten: tanpa perubahan tidak ada
//   daemon-reload, restart, atau penulisan iptables;
// - apply (watchdog) tidak pernah memanggil systemctl untuk mengubah apa pun;
// - enable dengan input salah atau setup gagal mengembalikan pengaturan lama;
// - disable melepas aturan tapi menyimpan kunci (pubkey pengguna tetap);
// - API hanya mengirim data.slowdns saat aktif dan layanan SSH ON;
// - SSH OFF di gerbang ON/OFF ikut menutup port SlowDNS;
// - urutan di install/update/watchdog: SlowDNS sebelum gerbang ON/OFF.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-autoscript-compat.sh'), 'utf8').replace(/\r\n/g, '\n');

function extract(source, startMarker, endMarker, keepStart = false) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  return source.slice(keepStart ? start : start + startMarker.length, end);
}

function resolveBash() {
  const candidates = [
    process.env.BASH,
    process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '',
    'bash'
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('bash not found');
}

const bash = resolveBash();
const toBashPath = (p) => (process.platform === 'win32'
  ? spawnSync(bash, ['-c', `cygpath -u '${p}'`], { encoding: 'utf8' }).stdout.trim()
  : p);

const helper = extract(installer, "cat > /usr/local/sbin/sc-1forcr-slowdns <<'SLOWDNS_EOF'\n", '\nSLOWDNS_EOF\n');
const DNSTT_VERSION = (helper.match(/^DNSTT_VERSION="([^"]+)"/m) || [])[1];
const DNSTT_PATCH_ID = (helper.match(/^DNSTT_PATCH_ID="([^"]+)"/m) || [])[1];
const DNSTT_ZIP_SHA256 = (helper.match(/^DNSTT_ZIP_SHA256="([0-9a-f]{64})"/m) || [])[1];
assert(DNSTT_VERSION && DNSTT_PATCH_ID && DNSTT_ZIP_SHA256, 'DNSTT_VERSION, DNSTT_PATCH_ID, dan DNSTT_ZIP_SHA256 dipin di helper');

// ── Isi statis ──────────────────────────────────────────────────────────────
assert(/^GO_SHA256_AMD64="[0-9a-f]{64}"$/m.test(helper) && /^GO_SHA256_ARM64="[0-9a-f]{64}"$/m.test(helper),
  'checksum toolchain Go dipin untuk amd64 dan arm64');
assert(helper.includes('GOTOOLCHAIN=local') && helper.includes('GOSUMDB=sum.golang.org'),
  'build tidak boleh mengunduh toolchain lain diam-diam dan wajib verifikasi sumdb');
assert(helper.includes('GOFLAGS="-modcacherw -p=1" GOMAXPROCS=1') && helper.includes('nice -n 10'),
  'build menahan RAM/CPU supaya tunnel tetap lancar di VPS 1 vCPU');
assert(helper.includes('BUILD_ROOT="${SLOWDNS_BUILD_ROOT:-/var/tmp}"'),
  'build di /var/tmp (disk), bukan /tmp yang bisa tmpfs di VPS 1 GB');
assert(/rm -rf "\$\{work\}"\n  return "\$\{rc\}"/.test(helper), 'folder build selalu dihapus');
assert(helper.includes('SLOWDNS_BIN_SHA256 (64 hex) wajib diisi'), 'binary dari URL wajib checksum');

// ── Build dari source yang di-patch (bukan go install upstream) ──────────────
const buildFn = extract(helper, '\nbuild_binary() {', '\n  return "${rc}"\n}\n');
assert(buildFn.includes('${DNSTT_MODULE}/@v/${DNSTT_VERSION}.zip') && buildFn.includes('${DNSTT_ZIP_SHA256}'),
  'build mengunduh zip source yang dipin dan memverifikasi checksum-nya');
{
  // V.1FSC.128: VPS Linode mendapat 404 dari ketiga sumber Google; mirror
  // non-Google wajib dicoba setelahnya, tetap dengan checksum yang dipin.
  const goUrls = (buildFn.match(/"https:\/\/[^"]*\$\{GO_VERSION\}\.linux-\$\{arch\}\.tar\.gz"/g) || []);
  const nonGoogle = goUrls.filter((u) => !/go\.dev|google/.test(u));
  assert(goUrls.length >= 5 && /go\.dev/.test(goUrls[0]) && nonGoogle.length >= 2 &&
    goUrls.indexOf(nonGoogle[0]) > goUrls.findIndex((u) => /golang\.google\.cn/.test(u)),
    `toolchain Go: sumber resmi dulu, lalu minimal 2 mirror non-Google (${goUrls.join(' ')})`);
  assert(/sha256sum "\$\{work\}\/go\.tgz"[^\n]*!= "\$\{sha\}"/.test(buildFn) && /continue/.test(buildFn),
    'tarball toolchain dari sumber mana pun wajib cocok dengan checksum yang dipin');
}
assert(!buildFn.includes('go install') && /go_bin.*build -trimpath.*dnstt-server|build -trimpath[\s\S]*\.\/dnstt-server/.test(buildFn),
  'build memakai go build atas source yang sudah dipatch, bukan go install upstream');
assert(buildFn.includes('${DNSTT_VERSION}+${DNSTT_PATCH_ID}'), 'identitas binary menyertakan penanda patch');
const patchPy = extract(buildFn, "<<'SLOWDNS_PATCH_PY'\n", '\nSLOWDNS_PATCH_PY\n');
assert(patchPy.includes('rrTypeNULL = 10') && patchPy.includes('question.Type != rrTypeNULL'),
  'patch menambah dukungan record NULL');
assert(patchPy.includes('maxPayloadForResponse') && patchPy.includes('requesterPayloadSize') && patchPy.includes('_ = payloadSize'),
  'patch: ukuran jawaban per-query + buang FORMERR minimum');
assert(patchPy.includes('nodelay on (fast flush)') && patchPy.includes("const QueueSize = 8192"),
  'patch: KCP mode cepat + window besar');
assert(patchPy.includes('clientEdnsRecord') && patchPy.includes('func kcpWindow()') &&
  patchPy.includes('session %08x edns %d mtu %d win %d') && patchPy.includes('mtuCeil'),
  'patch sc-fast2: MTU KCP per sesi (sesuai buffer EDNS tiap klien)');
assert(patchPy.includes('os.Getenv') && patchPy.includes('SLOWDNS_KCP_WINDOW'),
  'patch sc-fast2: window KCP tunable lewat env SLOWDNS_KCP_WINDOW');
assert(patchPy.includes('avail := sizeCap - len(buf)') && patchPy.includes('l+(l+254)/255'),
  'patch sc-fast3: maxPayloadForResponse aritmatika (ganti binary-search per respons)');
assert(patchPy.includes('NewName length anchor not found') && patchPy.includes('length <= 255'),
  'patch sc-fast6: validasi panjang nama tanpa serializer/cache sementara');
assert(patchPy.includes("'\\tvar buf [4096]byte\\n\\tfor {"),
  'patch sc-fast6: buffer baca dipakai ulang');
assert(patchPy.includes('\npatch_kcp_tuning(mod)\n') &&
  patchPy.includes('kcpTuning := scLoadKCPTuning()') &&
  patchPy.includes('kcpTuning.interval, // SLOWDNS_KCP_INTERVAL, default 10 ms') &&
  patchPy.includes('conn.SetACKNoDelay(kcpTuning.ackNoDelay)') &&
  patchPy.includes('os.Getenv("SLOWDNS_KCP_INTERVAL")') && patchPy.includes('os.Getenv("SLOWDNS_KCP_ACK_NODELAY")') &&
  patchPy.includes('scKCPIntervalDefault = 10') && patchPy.includes('scKCPIntervalMax     = 50'),
  'patch sc-fast8: interval KCP + ACK langsung dari env (default 10 ms, ACK biasa) dan VPS lama rebuild');
const guardPy = patchPy.split('\npatch_kcp_tuning(mod)\n')[1] || '';
assert(guardPy.includes('\npatch_session_guard(mod)\n') &&
  guardPy.includes('conn.SetReadDeadline(handshakeDeadline)') && guardPy.includes('conn.SetReadDeadline(time.Time{})') &&
  guardPy.includes('return scHandshakeError(err, handshakeDeadline)') &&
  guardPy.includes('!errors.Is(err, errSCHandshakeTimeout)') &&
  guardPy.includes('scHandshakeTimeoutDefault = 30 * time.Second') &&
  guardPy.includes('\\tclientEdnsMu.Lock()\\n\\tscEdnsSweepIfFull(cid)\\n') &&
  guardPy.includes('\\tscEdnsMarkSeen(cid)\\n\\tclientEdnsMu.Unlock()') &&
  guardPy.includes('delete(clientSeen, cid)') && guardPy.includes('scEdnsTTL = int64(idleTimeout / time.Second)') &&
  guardPy.includes('unstash, outgoing, wake := ttConn.PeekQueues(rec.ClientID)') &&
  guardPy.includes('case <-wake:') && guardPy.includes('ensureSendQueue()') &&
  guardPy.includes('if record.SendQueue != nil {') && guardPy.includes('Wake:      make(chan struct{}, 1)') &&
  guardPy.includes('\\t\\tscSetUDPReadBuffer(dnsConn)\\n') && guardPy.includes('scUDPRcvbufDefault = 2 << 20'),
  'patch sc-fast9 setelah sc-fast8: handshake bertenggat, entri EDNS basi dibuang, antrean kirim malas (banjir sesi palsu sg4)');
assert(guardPy.includes('OutgoingQueue tetap selalu membuat antrean') &&
  guardPy.includes("rreplace('\\t\\t\\tSendQueue: make(chan []byte, QueueSize),"),
  'sc-fast9: hanya Peek yang malas; OutgoingQueue milik dnstt-client tetap selalu membuat antrean');
const bytesPy = guardPy.split('\npatch_session_guard(mod)\n')[1] || '';
assert(bytesPy.includes('\npatch_session_bytes(mod)\n') &&
  bytesPy.includes('SC_SLOWDNS_SESSIONS_V2|%d|%d') && bytesPy.includes('E|%d|%s|%d|%d|%d|%d') &&
  bytesPy.includes('scEndedKeepNanos = int64(30 * time.Minute)') && bytesPy.includes('scEndedMax = 4096') &&
  bytesPy.includes('io.Copy(scStreamWriter(stream, tracked), upstreamTCPConn)') &&
  bytesPy.includes('atomic.AddUint64(&w.session.down, uint64(n))'),
  'patch sc-fast10 setelah sc-fast9: byte download per stream + stream putus disimpan 30 menit untuk kuota SSH');
{
  // V.1FSC.134 (sg4 14-11-2026): lewat 8.8.8.8/1.1.1.1/9.9.9.9 EDNS di query
  // milik resolver; app ber-buffer 512/1024/tanpa EDNS menerima TC=1 dan tidak
  // pernah konek. Respons dibatasi ukuran yang terbukti sampai, lalu diprobe.
  const sizePy = bytesPy.split('\npatch_session_bytes(mod)\n')[1] || '';
  assert(sizePy.includes('\npatch_response_size(mod)\n') &&
    sizePy.includes("'sc_size.go'") && sizePy.includes('scSizeFloor    = 512') &&
    sizePy.includes('plan := scSizeCaps(rec)') && sizePy.includes('maxPayloadForResponse(rec.Resp, plan.base)') &&
    sizePy.includes('!scSizeExtend(&limit, &probeExtra, &probing, p, plan.fresh)') &&
    sizePy.includes('scSizePad(&payload, probeLimit)') &&
    // Probe dini di respons data pertama: MTU naik sebelum unduhan besar,
    // supaya window tidak penuh segmen 191 byte (RAM ~3 MB per sesi).
    sizePy.includes('if !probing && probeLimit > 0 && scPayloadHasFreshPush(payload.Bytes(), plan.fresh) {') &&
    // Dicatat sebelum WriteTo: ACK klien tidak boleh mendahului catatan probe.
    /scSizeSent\(rec\.ClientID, scPayload, len\(buf\), scProbe\)\\n\\t\\t\}\\n'\s+'\\t\\t\/\/ Now we actually send the message/.test(sizePy) &&
    sizePy.includes('scSizeCheckClient(clientID, p)') && sizePy.includes('scSizeAttach(conn, permtu)') &&
    sizePy.includes('int32(una-st.sn[i]) > 0') && sizePy.includes('int32(sn-st.freshSn) >= 0') &&
    sizePy.includes('delete(clientSize, cid)') && sizePy.includes("'\\t\\t\\tdelete(clientSeen, k)\\n'"),
    'patch sc-fast11 setelah sc-fast10: ukuran respons terbukti per klien (probe + bukti una/ACK, dicatat sebelum kirim)');
  // MTU awal tidak lagi diambil dari EDNS query (bisa milik resolver).
  assert(sizePy.includes("'\\t\\t\\t\\tif cand := computeMaxEncodedPayload(edns) - 2; cand > permtu {\\n'") &&
    sizePy.includes('TXT/NULL tetap kapasitas respons 512 byte'),
    'sc-fast11: MTU awal TXT/NULL = kapasitas respons 512 byte, naik hanya lewat bukti');
  // V.1FSC.135: SlowDNS Xray lewat domain NS kedua (satu proses, satu kunci).
  const routePy = sizePy.split('\npatch_response_size(mod)\n')[1] || '';
  assert(routePy.includes('\npatch_xray_route(mod)\n') &&
    routePy.includes("'sc_route.go'") && routePy.includes('scRouteFlags()') &&
    routePy.includes('scTrimTunnelDomain(question.Name, domain)') &&
    routePy.includes('route := scQueryRoute(&query, domain)') &&
    routePy.includes('scHandleStream(conn, stream, upstream, clientID)') &&
    routePy.includes('tujuan wajib alamat loopback') && routePy.includes('ip.IsLoopback()') &&
    routePy.includes('X|%d|%s|%d|%d|%d') && routePy.includes('delete(clientRoute, cid)') &&
    routePy.includes("'\\t\\t\\tdelete(clientRoute, k)\\n'") &&
    routePy.includes('scRouteSSHOff  atomic.Bool') && routePy.includes('ROUTE_XRAY=0'),
    'patch sc-fast12 setelah sc-fast11: domain NS Xray, rute path WS loopback, ON/OFF dari file state');
  // Nilai nol = ON: jalur yang belum disetel tidak pernah mati diam-diam.
  assert(!/scRoute(SSH|Xray)On\b/.test(routePy), 'sc-fast12: saklar jalur memakai nilai nol = ON');
  // V.1FSC.136: hemat CPU per query (sc-fast13) setelah sc-fast12.
  const cpuPy = routePy.split('\npatch_xray_route(mod)\n')[1] || '';
  assert(helper.includes('DNSTT_PATCH_ID="sc-fast13"') && cpuPy.includes('\npatch_cpu_saver(mod)\n') &&
    cpuPy.includes("'sc_cpu.go'") && cpuPy.includes("'sc_batch_linux.go'") && cpuPy.includes("'sc_batch_other.go'") &&
    cpuPy.includes('case ch <- &record{resp, addr, clientID, size, dnsConn}:') && cpuPy.includes('scRecordDropped()') &&
    cpuPy.includes('rd := scNewPacketReader(dnsConn)') && cpuPy.includes('w := scNewPacketWriter()') &&
    cpuPy.includes('timer.Reset(maxResponseDelay)') && cpuPy.includes('waiting, first := false, true') &&
    cpuPy.includes('scListenUDP(udpAddr)') && cpuPy.includes('comma-separated') &&
    cpuPy.includes('encoded, payload := scJoinUpperDecodeBuf(prefix)') &&
    cpuPy.includes('SLOWDNS_UDP_BATCH') && cpuPy.includes('ipv6.NewPacketConn(uc)') &&
    cpuPy.includes('se.Syscall == "recvmmsg" || se.Syscall == "sendmmsg"'),
    'patch sc-fast13 setelah sc-fast12: satu timer sendLoop, -udp beberapa alamat, batch UDP opsional, query dibuang dihitung');
  // Anchor build uji (scripts/go/slowdns-bench) tetap ada setelah sc-fast13.
  assert(cpuPy.includes("'\\t\\t\\t\\tpayload.Write(p)\\n\\t\\t\\t}\\n'") && !cpuPy.includes('ttConn.Stash('),
    'sc-fast13 tidak mengubah baris Stash/payload.Write yang dikait build uji');
  // Log per query dibatasi (banjir scanner ke UDP 53).
  for (const fmt of ['NXDOMAIN: not authoritative for %s', 'cannot parse DNS query: %v', 'WriteTo error: %v']) {
    assert(cpuPy.includes(fmt), `log per query dibatasi: ${fmt}`);
  }
}
assert(helper.includes('XRAY_ROUTE="/vmess=127.0.0.1:10001,/vless=127.0.0.1:10002,/trojan=127.0.0.1:10003"') &&
  /bin_has_routes\(\) \{\n  bin_help\n  \[\[ "\$\{REPLY\}" == \*"-routes-file"\* \]\]/.test(helper) &&
  /BIN_HELP="\$\("\$\{BIN\}" -h 2>&1 \|\| true\)"/.test(helper) && /\n  BIN_HELP_DONE=0\n\}/.test(helper) &&
  helper.includes('-mtu ${MTU}${args} ${NS} 127.0.0.1:${TARGET_PORT}') &&
  helper.includes('ROUTE_SSH=${ROUTE_SSH}\nROUTE_XRAY=${xray_route}\nDIRECT=${DIRECT_IPS}"'),
  'helper: flag jalur hanya dipasang kalau binary mendukung, ON/OFF jalur lewat file state');
assert(helper.includes('  sessions) cmd_sessions "${2:-1}" ;;') &&
  helper.includes("printf 'SC_SLOWDNS_USERS_V2|%s|%s\\n'") && helper.includes("printf 'SC_SLOWDNS_USERS_V1|%s\\n'"),
  'helper: sessions (V1, limit tunnel) tetap ada, sessions 2 (V2) untuk kuota SSH');
assert(patchPy.includes('conn.SetWindowSize(win, win)') && !/SetWindowSize\(512|MaxReceiveBuffer|MaxStreamBuffer/.test(patchPy),
  'sc-fast8 tidak menyalin window 512 atau buffer smux Potato; window tetap kcpWindow()');
assert(!/^[^#\n]*\.write_text\([^)]*newline=/m.test(patchPy),
  'patch tidak memakai Path.write_text(newline=) (Python 3.10+; Ubuntu 20.04 = 3.8, Debian 11 = 3.9)');
assert(/^kcp_interval_val\(\) \{/m.test(helper) && /^kcp_ack_nodelay_val\(\) \{/m.test(helper) &&
  helper.includes('Environment=SLOWDNS_KCP_INTERVAL=$(kcp_interval)') &&
  helper.includes('Environment=SLOWDNS_KCP_ACK_NODELAY=$(kcp_ack_nodelay)'),
  'unit SlowDNS menyetel interval KCP dan ACK langsung lewat helper tervalidasi');
assert(/if \(\( MTU == 512 \)\); then MTU=1232; fi/.test(helper),
  'helper menaikkan SLOWDNS_MTU lama 512 ke 1232 (hindari choke app buffer besar)');
assert(/^kcp_window\(\) \{/m.test(helper) && helper.includes('Environment=SLOWDNS_KCP_WINDOW=$(kcp_window)'),
  'unit SlowDNS menyetel SLOWDNS_KCP_WINDOW per tier lewat kcp_window()');
assert(/^go_maxprocs\(\) \{/m.test(helper) && /^go_gc\(\) \{/m.test(helper) &&
  helper.includes('Environment=GOMAXPROCS=$(go_maxprocs)') && helper.includes('Environment=GOGC=$(go_gc)'),
  'unit SlowDNS menyetel GOMAXPROCS (min core,2) + GOGC (hemat CPU, env-only)');
assert(/wanted_binary_id\(\)[\s\S]*\$\{DNSTT_VERSION\}\+%s|printf '%s\+%s' "\$\{DNSTT_VERSION\}" "\$\{DNSTT_PATCH_ID\}"/.test(helper),
  'wanted_binary_id memakai versi+patch sehingga VPS lama rebuild');
const applyFn = extract(helper, '\ncmd_apply() {', '\n}\n');
assert(!/systemctl\s+(restart|start|stop|enable|disable|daemon-reload)/.test(applyFn) &&
  !/cmd_setup|ensure_binary/.test(applyFn), 'apply (watchdog) tidak boleh mengubah systemd atau build');

// ── Lingkungan tiruan ───────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slowdns-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const scriptPath = path.join(tmp, 'sc-1forcr-slowdns');
fs.writeFileSync(scriptPath, `${helper}\n`);

// Tiruan ditulis dengan builtin bash saja: di Git Bash Windows setiap proses
// eksternal (grep/sed/mv) mahal, dan helper memanggil iptables puluhan kali.
const fakeIptables = `#!/usr/bin/env bash
case "\${0##*/}" in ip6tables) fam=6 ;; *) fam=4 ;; esac
printf '%s\\n' "\${fam} $*" >> "\${FAKE_DIR}/ipt-calls"
table=filter
args=()
while (( $# )); do
  case "$1" in
    -w) shift 2 ;;
    -t) table="$2"; shift 2 ;;
    -n|-v|-x) shift ;;
    *) args+=("$1"); shift ;;
  esac
done
st="\${FAKE_DIR}/rules\${fam}.\${table}"
lines=()
if [[ -f "\${st}" ]]; then mapfile -t lines < "\${st}"; fi
op="\${args[0]}"; chain="\${args[1]:-}"; rest=("\${args[@]:2}")
pos=1
if [[ "\${op}" == "-I" && "\${rest[0]:-}" =~ ^[0-9]+$ ]]; then pos="\${rest[0]}"; rest=("\${rest[@]:1}"); fi
spec="\${rest[*]}"
[[ "\${table}" == "nat" && -f "\${FAKE_DIR}/no-nat\${fam}" ]] && exit 1
if [[ -f "\${FAKE_DIR}/no-addrtype" && " \${spec} " == *" addrtype "* ]]; then exit 1; fi
builtin_chain() { [[ "$1" == PREROUTING || "$1" == INPUT || "$1" == OUTPUT ]]; }
has_chain() { local l; for l in "\${lines[@]}"; do [[ "\${l}" == "N $1" ]] && return 0; done; return 1; }
save() { if (( \${#lines[@]} )); then printf '%s\\n' "\${lines[@]}" > "\${st}"; else : > "\${st}"; fi; }
case "\${op}" in -A|-I|-F|-N|-X) printf '%s\\n' "\${fam} \${table} \${op} \${chain} \${spec}" >> "\${FAKE_DIR}/writes" ;; esac
case "\${op}" in
  -S)
    if builtin_chain "\${chain}"; then echo "-P \${chain} ACCEPT"; else has_chain "\${chain}" || exit 1; echo "-N \${chain}"; fi
    for l in "\${lines[@]}"; do [[ "\${l}" == "\${chain} "* ]] && echo "-A \${l}"; done
    ;;
  -L)
    has_chain "\${chain}" || exit 1
    echo "Chain \${chain} (1 references)"
    echo "    pkts      bytes target     prot opt in     out     source               destination"
    c=0
    [[ -f "\${FAKE_DIR}/counter" ]] && read -r c < "\${FAKE_DIR}/counter"
    for l in "\${lines[@]}"; do
      [[ "\${l}" == "\${chain} "* ]] || continue
      t="\${l##*-j }"; t="\${t%% *}"
      echo "       \${c}        0 \${t}   udp  --  *      *       0.0.0.0/0            0.0.0.0/0"
    done
    ;;
  -N) has_chain "\${chain}" && exit 1; lines+=("N \${chain}"); save ;;
  -F) new=(); for l in "\${lines[@]}"; do [[ "\${l}" == "\${chain} "* ]] || new+=("\${l}"); done; lines=("\${new[@]}"); save ;;
  -X)
    new=()
    for l in "\${lines[@]}"; do
      [[ "\${l}" == *"-j \${chain}" ]] && exit 1
      [[ "\${l}" == "N \${chain}" ]] || new+=("\${l}")
    done
    lines=("\${new[@]}"); save ;;
  -A) builtin_chain "\${chain}" || has_chain "\${chain}" || exit 1; lines+=("\${chain} \${spec}"); save ;;
  -I)
    # Sisip sebelum rule ke-pos milik chain ini (iptables asli: nomor rule per chain).
    # Chain tanpa rule (atau posisi melewati akhir): di awal file / setelah
    # rule terakhir chain itu, seperti tiruan lama yang selalu menyisip di atas.
    new=(); n=0; done=0; last=-1
    for l in "\${lines[@]}"; do
      if [[ "\${l}" == "\${chain} "* ]]; then
        n=$((n + 1))
        if (( !done && n == pos )); then new+=("\${chain} \${spec}"); done=1; fi
        new+=("\${l}"); last=$(( \${#new[@]} - 1 ))
        continue
      fi
      new+=("\${l}")
    done
    if (( !done )); then
      if (( last < 0 )); then new=("\${chain} \${spec}" "\${new[@]}")
      else new=("\${new[@]:0:last+1}" "\${chain} \${spec}" "\${new[@]:last+1}"); fi
    fi
    lines=("\${new[@]}"); save ;;
  -C) for l in "\${lines[@]}"; do [[ "\${l}" == "\${chain} \${spec}" ]] && exit 0; done; exit 1 ;;
  -D)
    new=(); found=0
    for l in "\${lines[@]}"; do
      if (( ! found )) && [[ "\${l}" == "\${chain} \${spec}" ]]; then found=1; continue; fi
      new+=("\${l}")
    done
    (( found )) || exit 1
    printf '%s\\n' "\${fam} \${table} -D \${chain} \${spec}" >> "\${FAKE_DIR}/writes"
    lines=("\${new[@]}"); save ;;
esac
exit 0
`;

const fakes = {
  iptables: fakeIptables,
  ip6tables: fakeIptables,
  // systemctl tiruan: status di file, setiap panggilan dicatat.
  systemctl: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_DIR}/systemctl.log"
args=()
for a in "$@"; do [[ "\${a}" == --* ]] || args+=("\${a}"); done
case "\${args[0]:-}" in
  is-active) [[ -f "\${FAKE_DIR}/active" ]] ;;
  is-enabled) [[ -f "\${FAKE_DIR}/enabled" ]] ;;
  restart|start) [[ -f "\${FAKE_DIR}/fail-start" ]] && { rm -f "\${FAKE_DIR}/active"; exit 1; }; : > "\${FAKE_DIR}/active" ;;
  enable) : > "\${FAKE_DIR}/enabled" ;;
  disable) rm -f "\${FAKE_DIR}/enabled"; [[ " $* " == *" --now "* ]] && rm -f "\${FAKE_DIR}/active"; exit 0 ;;
  *) exit 0 ;;
esac
`,
  ss: `#!/usr/bin/env bash
if [[ -f "\${FAKE_DIR}/udp" ]]; then while IFS= read -r l; do echo "\${l}"; done < "\${FAKE_DIR}/udp"; fi
if [[ -f "\${FAKE_DIR}/active" ]]; then
  echo 'UNCONN 0 0 *:5300 *:* users:(("dnstt-server",pid=99,fd=3))'
fi
`,
  curl: `#!/usr/bin/env bash
out=""; url=""
while (( $# )); do
  case "$1" in -o) out="$2"; shift 2 ;; -H) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
echo "\${url}" >> "\${FAKE_DIR}/curl.log"
case "\${url}" in
  *ipify*|*ifconfig.me*|*ipinfo.io*) [[ -f "\${FAKE_DIR}/offline" ]] && exit 6; echo "203.0.113.7" ;;
  *dns.google*|*cloudflare-dns.com*)
    if [[ -f "\${FAKE_DIR}/delegated" ]]; then
      c="$(cat "\${FAKE_DIR}/counter" 2>/dev/null || echo 0)"; echo $((c + 1)) > "\${FAKE_DIR}/counter"
    fi
    echo '{"Status":3}' ;;
  *dnstt-bin*) [[ -n "\${out}" ]] && cp "\${FAKE_DIR}/dnstt-download" "\${out}" ;;
  *) exit 22 ;;
esac
`,
  getent: '#!/usr/bin/env bash\n[[ "$1" == group && -f "${FAKE_DIR}/group-$2" ]]\n',
  groupadd: '#!/usr/bin/env bash\ntouch "${FAKE_DIR}/group-${!#}"\n',
  useradd: '#!/usr/bin/env bash\ntouch "${FAKE_DIR}/user-${!#}"\n',
  userdel: '#!/usr/bin/env bash\nrm -f "${FAKE_DIR}/user-$1"\n',
  groupdel: '#!/usr/bin/env bash\nrm -f "${FAKE_DIR}/group-$1"\n',
  id: '#!/usr/bin/env bash\n[[ "$1" == -u && -f "${FAKE_DIR}/user-$2" ]] && echo 990\n',
  chown: '#!/usr/bin/env bash\nexit 0\n',
  nproc: '#!/usr/bin/env bash\necho 1\n',
  ip: `#!/usr/bin/env bash
case "$*" in
  *"route show default"*) echo "default via 203.0.113.1 dev eth0 onlink" ;;
  *"addr show dev eth0"*) echo "2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0" ;;
  *) [[ -f "\${FAKE_DIR}/has-ipv6" ]] && echo "    inet6 2001:db8::7/64 scope global" ;;
esac
exit 0
`,
  'netfilter-persistent': '#!/usr/bin/env bash\necho save >> "${FAKE_DIR}/persist"\n',
  'service-gate': '#!/usr/bin/env bash\necho "$*" >> "${FAKE_DIR}/gate.log"\n'
};
for (const [name, body] of Object.entries(fakes)) {
  fs.writeFileSync(path.join(bin, name), body);
  fs.chmodSync(path.join(bin, name), 0o755);
}

// dnstt-server tiruan: -gen-key menulis pasangan kunci 64 hex berurutan.
const fakeDnstt = `#!/usr/bin/env bash
if [[ "$1" == "-gen-key" ]]; then
  priv=""; pub=""
  while (( $# )); do case "$1" in -privkey-file) priv="$2"; shift 2 ;; -pubkey-file) pub="$2"; shift 2 ;; *) shift ;; esac; done
  n="$(cat "\${FAKE_DIR}/keyseq" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "\${n}" > "\${FAKE_DIR}/keyseq"
  printf '%064x\\n' "\${n}" > "\${priv}"
  printf '%064x\\n' "$((n + 4096))" > "\${pub}"
  exit 0
fi
exit 1
`;

const envFile = path.join(tmp, 'sc.env');
const stateFile = path.join(tmp, 'slowdns.state');
const keyDir = path.join(tmp, 'keys');
const dnsttBin = path.join(tmp, 'lib', 'dnstt-server');
const unitFile = path.join(tmp, 'sc-1forcr-slowdns.service');
const buildRoot = path.join(tmp, 'build');
fs.mkdirSync(buildRoot);
const F = (name) => path.join(tmp, name);
const read = (name) => (fs.existsSync(F(name)) ? fs.readFileSync(F(name), 'utf8') : '');
const rules = (fam, table) => read(`rules${fam}.${table}`).split('\n').filter(Boolean);

function installFakeDnstt() {
  fs.mkdirSync(path.dirname(dnsttBin), { recursive: true });
  fs.writeFileSync(dnsttBin, fakeDnstt);
  fs.chmodSync(dnsttBin, 0o755);
  fs.writeFileSync(`${dnsttBin}.version`, `${DNSTT_VERSION}+${DNSTT_PATCH_ID}\n`);
}

function setEnv(values) {
  const base = { DOMAIN: 'sg1.contoh.net', DROPBEAR_PORT: '109' };
  fs.writeFileSync(envFile, Object.entries({ ...base, ...values }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
const envValue = (key) => ((fs.readFileSync(envFile, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]);
const state = () => Object.fromEntries(read('slowdns.state').split('\n').filter(Boolean).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));

// PATH tiruan dipasang di dalam shell: bash Git for Windows menaruh /usr/bin di
// depan PATH dari luar, sehingga nproc/curl/id asli akan menang.
function run(...args) {
  for (const f of ['writes', 'persist', 'systemctl.log', 'gate.log', 'curl.log']) fs.rmSync(F(f), { force: true });
  const started = Date.now();
  const r = spawnSync(bash, ['-c', 'export PATH="${FAKE_BIN}:${PATH}"; exec bash "$0" "$@"', toBashPath(scriptPath), ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      FAKE_BIN: toBashPath(bin),
      FAKE_DIR: toBashPath(tmp),
      SC_ENV_FILE: toBashPath(envFile),
      SLOWDNS_STATE_FILE: toBashPath(stateFile),
      SLOWDNS_KEY_DIR: toBashPath(keyDir),
      SLOWDNS_BIN_PATH: toBashPath(dnsttBin),
      SLOWDNS_UNIT_FILE: toBashPath(unitFile),
      SLOWDNS_LOCK_FILE: toBashPath(F('lock')),
      SLOWDNS_BUILD_ROOT: toBashPath(buildRoot),
      SLOWDNS_WAIT_SECONDS: '1',
      SLOWDNS_SERVICE_GATE_BIN: toBashPath(path.join(bin, 'service-gate'))
    }
  });
  if (process.env.SLOWDNS_TEST_DEBUG) console.error(`[${Date.now() - started} ms] ${args.join(' ')} -> ${r.status}`);
  assert(!r.error, `sc-1forcr-slowdns ${args.join(' ')} macet: ${r.error && r.error.message}\n${r.stdout}${r.stderr}`);
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const systemctlCalls = () => read('systemctl.log').split('\n').filter(Boolean);
const mutatingSystemctl = () => systemctlCalls().filter((c) => !/^(is-active|is-enabled)\b/.test(c.replace(/^--\S+ /, '')));

try {
  // ── 1. Default mati: watchdog tidak menyentuh iptables ───────────────────
  setEnv({});
  let r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(state().ENABLED, '0');
  assert.strictEqual(state().RULES, '0');
  assert.strictEqual(read('writes'), '', 'mati: tidak ada aturan yang ditulis');
  fs.rmSync(F('ipt-calls'), { force: true });
  r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(read('ipt-calls'), '', 'mati + state mati: watchdog tidak memanggil iptables sama sekali');
  assert.deepStrictEqual(systemctlCalls(), [], 'mati + state mati: watchdog tidak memanggil systemctl sama sekali');
  r = run('setup');
  assert.strictEqual(r.status, 0, `setup saat mati tidak boleh gagal:\n${r.out}`);
  assert(!fs.existsSync(unitFile) && !fs.existsSync(dnsttBin), 'mati: tidak ada build maupun unit');

  // ── 2. Aktif: kunci, unit, aturan, state ─────────────────────────────────
  installFakeDnstt();
  // Rule yang sudah ada sebelumnya: jump port tambahan (TCP) dan DNAT UDP Custom.
  fs.writeFileSync(F('rules4.nat'), [
    'PREROUTING -p tcp -m addrtype --dst-type LOCAL -j SC1FORCR_PORTS',
    'PREROUTING -i eth0 -p udp -m udp --dport 1:65535 -j DNAT --to-destination :5667',
    'N SC1FORCR_PORTS'
  ].join('\n') + '\n');
  setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'NS-SG1.Contoh.NET.' });
  r = run('setup');
  assert.strictEqual(r.status, 0, r.out);
  const unit = fs.readFileSync(unitFile, 'utf8');
  for (const want of [
    'User=sc-1forcr-slowdns', 'Group=sc-1forcr-slowdns', 'MemoryMax=128M', 'Environment=GOMEMLIMIT=96MiB',
    'NoNewPrivileges=yes', 'ProtectSystem=strict', 'Restart=always', 'TasksMax=64',
    ' -udp :5300 -privkey-file ', ' -mtu 1232 ns-sg1.contoh.net 127.0.0.1:109'
  ]) assert(unit.includes(want), `unit wajib memuat ${want}:\n${unit}`);
  assert(/Environment=SLOWDNS_KCP_WINDOW=\d+/.test(unit), `unit menyetel window KCP per tier:\n${unit}`);
  assert(/Environment=GOMAXPROCS=\d+/.test(unit) && /Environment=GOGC=\d+/.test(unit), `unit menyetel GOMAXPROCS + GOGC:\n${unit}`);
  assert(!/^User=root|Group=sc-1forcr-tunnel/m.test(unit), 'dnstt tidak jalan sebagai root atau grup tunnel');
  assert(/^0{63}1$/.test(fs.readFileSync(path.join(keyDir, 'server.key'), 'utf8').trim()), 'kunci server dibuat');
  let s = state();
  assert.strictEqual(s.ENABLED, '1');
  assert.strictEqual(s.ACTIVE, '1');
  assert.strictEqual(s.RULES, '1');
  assert.strictEqual(s.NS, 'ns-sg1.contoh.net', 'NS dinormalkan (huruf kecil, tanpa titik di ujung)');
  assert.strictEqual(s.PUBKEY, (4097).toString(16).padStart(64, '0'));
  assert.strictEqual(s.PUBLIC_IP, '203.0.113.7');
  assert.strictEqual(s.TARGET, '127.0.0.1:109');
  const calls = mutatingSystemctl();
  assert.strictEqual(calls.filter((c) => c === 'daemon-reload').length, 1, `satu daemon-reload: ${calls}`);
  assert(calls.includes('enable --no-reload sc-1forcr-slowdns.service'), `enable tanpa reload: ${calls}`);
  assert(calls.includes('restart sc-1forcr-slowdns.service'), `service dinyalakan: ${calls}`);
  let nat = rules(4, 'nat');
  assert.strictEqual(nat[0], 'PREROUTING -p udp -m addrtype --dst-type LOCAL -j SC1FORCR_SLOWDNS',
    `jump SlowDNS di depan DNAT 1:65535 UDP Custom:\n${nat.join('\n')}`);
  assert(nat.includes('SC1FORCR_SLOWDNS -p udp -m udp --dport 53 -m comment --comment sc-slowdns -j REDIRECT --to-ports 5300'));
  assert(rules(4, 'filter').includes('INPUT -p udp -m udp --dport 5300 -m comment --comment sc-slowdns -j ACCEPT'));
  // Balasan dnstt harus lolos di OUTPUT (service non-root bisa kena chain lain).
  assert(rules(4, 'filter').includes('OUTPUT -p udp -m udp --sport 5300 -m comment --comment sc-slowdns -j ACCEPT'),
    `OUTPUT ACCEPT balasan dnstt:\n${rules(4, 'filter').join('\n')}`);
  assert.strictEqual(rules(6, 'nat').length, 0, 'tanpa IPv6 global: ip6tables tidak disentuh');
  assert(read('persist').includes('save'), 'aturan baru disimpan netfilter-persistent');

  // ── 3. Idempoten: setup dan apply kedua tidak mengubah apa pun ───────────
  r = run('setup');
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(mutatingSystemctl(), [], `setup tanpa perubahan: tanpa reload/restart (${systemctlCalls()})`);
  assert.strictEqual(read('writes'), '', 'setup tanpa perubahan: iptables tidak ditulis');
  r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(read('writes'), '', 'apply tanpa perubahan: iptables tidak ditulis');
  assert.strictEqual(read('persist'), '', 'apply tanpa perubahan: tidak menyimpan ulang');

  // ── 3b. Uji CPU KCP: interval/ACK lewat env, default = sc-fast7 ─────────
  const kcpUnit = () => {
    const u = fs.readFileSync(unitFile, 'utf8');
    return {
      interval: (u.match(/^Environment=SLOWDNS_KCP_INTERVAL=(.*)$/m) || [])[1],
      ack: (u.match(/^Environment=SLOWDNS_KCP_ACK_NODELAY=(.*)$/m) || [])[1],
      window: (u.match(/^Environment=SLOWDNS_KCP_WINDOW=(.*)$/m) || [])[1]
    };
  };
  const kcpEnv = () => [envValue('SLOWDNS_KCP_INTERVAL'), envValue('SLOWDNS_KCP_ACK_NODELAY')];
  const window0 = kcpUnit().window;
  assert.deepStrictEqual(kcpUnit(), { interval: '10', ack: '0', window: window0 }, 'default: interval 10 ms, ACK biasa');
  for (const [interval, ack] of [['20', '0'], ['10', '1'], ['20', '1']]) {
    r = run('set-kcp', interval, ack);
    assert.strictEqual(r.status, 0, r.out);
    assert(new RegExp(`Berhasil: KCP interval ${interval} ms, ACK langsung ${ack}\\. Window tetap ${window0}`).test(r.out), r.out);
    assert.deepStrictEqual(kcpEnv(), [interval, ack], 'nilai disimpan di env (ikut update)');
    assert.deepStrictEqual(kcpUnit(), { interval, ack, window: window0 }, 'window tidak ikut berubah');
    assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'nilai baru langsung dipakai service');
  }
  r = run('setup');
  assert.deepStrictEqual(mutatingSystemctl(), [], 'setup ulang tanpa perubahan KCP: tanpa restart');
  r = run('status');
  assert(new RegExp(`KCP\\s+: interval 20 ms, ACK langsung, window ${window0}`).test(r.out), r.out);
  for (const bad of [['9', '0'], ['51', '0'], ['20', '2'], ['abc', '1'], ['20', ''], ['', '']]) {
    r = run('set-kcp', ...bad);
    assert.notStrictEqual(r.status, 0, `set-kcp ${bad} harus ditolak`);
    assert.deepStrictEqual(kcpEnv(), ['20', '1'], `input salah ${bad} tidak menyentuh env`);
  }
  fs.writeFileSync(F('fail-start'), '');
  r = run('set-kcp', '10', '0');
  assert.notStrictEqual(r.status, 0, 'service gagal start: set-kcp gagal');
  assert(/pengaturan KCP gagal diterapkan; pengaturan dikembalikan/.test(r.out), r.out);
  assert.deepStrictEqual(kcpEnv(), ['20', '1'], 'nilai lama dikembalikan');
  fs.rmSync(F('fail-start'));
  run('setup');
  assert.deepStrictEqual(kcpUnit(), { interval: '20', ack: '1', window: window0 });
  // Env rusak/di luar batas (diedit manual) jatuh ke default yang aman.
  for (const [interval, ack, want] of [['abc', 'mungkin', ['10', '0']], ['5', '2', ['10', '0']], ['500', 'yes', ['10', '1']],
    ['20ms', 'on', ['20', '1']], ['"30"', 'TRUE', ['30', '1']], ['', '', ['10', '0']]]) {
    setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'NS-SG1.Contoh.NET.', SLOWDNS_KCP_INTERVAL: interval, SLOWDNS_KCP_ACK_NODELAY: ack });
    r = run('setup');
    assert.strictEqual(r.status, 0, r.out);
    assert.deepStrictEqual([kcpUnit().interval, kcpUnit().ack], want, `env ${interval}/${ack}`);
  }
  r = run('set-kcp', 'default');
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(kcpEnv(), ['10', '0']);
  assert.deepStrictEqual(kcpUnit(), { interval: '10', ack: '0', window: window0 }, 'default dipulihkan');
  setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'NS-SG1.Contoh.NET.' });
  run('setup');
  assert.deepStrictEqual(mutatingSystemctl(), [], 'env tanpa kunci KCP = unit default yang sama');

  // ── 4. Jump tergeser DNAT UDP Custom: dikembalikan ke depan oleh watchdog ─
  fs.writeFileSync(F('rules4.nat'), ['PREROUTING -i eth0 -p udp -m udp --dport 1:65535 -j DNAT --to-destination :36712', read('rules4.nat')].join('\n'));
  r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  nat = rules(4, 'nat');
  assert.strictEqual(nat[0], 'PREROUTING -p udp -m addrtype --dst-type LOCAL -j SC1FORCR_SLOWDNS', nat.join('\n'));
  assert.strictEqual(nat.filter((l) => l.endsWith('-j SC1FORCR_SLOWDNS')).length, 1, 'jump tidak dobel');
  assert.deepStrictEqual(mutatingSystemctl(), [], 'apply tetap tidak mengubah systemd');
  // Jump TCP (port tambahan) di atasnya tidak dianggap tergeser.
  fs.writeFileSync(F('rules4.nat'), ['PREROUTING -p tcp -m addrtype --dst-type LOCAL -j SC1FORCR_PORTS', read('rules4.nat')].join('\n'));
  r = run('apply');
  assert.strictEqual(read('writes'), '', 'rule TCP di atas jump SlowDNS dibiarkan');
  // Aturan hilang (reboot tanpa netfilter-persistent) dipasang ulang.
  fs.writeFileSync(F('rules4.nat'), '');
  fs.writeFileSync(F('rules4.filter'), '');
  r = run('apply');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(state().RULES, '1');
  assert(rules(4, 'nat').includes('SC1FORCR_SLOWDNS -p udp -m udp --dport 53 -m comment --comment sc-slowdns -j REDIRECT --to-ports 5300'));
  // Tanpa modul addrtype: tetap dialihkan.
  fs.writeFileSync(F('rules4.nat'), '');
  fs.writeFileSync(F('no-addrtype'), '');
  r = run('apply');
  assert.strictEqual(rules(4, 'nat')[0], 'PREROUTING -p udp -j SC1FORCR_SLOWDNS');
  fs.rmSync(F('no-addrtype'));
  fs.writeFileSync(F('rules4.nat'), '');
  run('apply');

  // ── 5. IPv6 hanya kalau VPS punya alamat global ──────────────────────────
  fs.writeFileSync(F('has-ipv6'), '');
  r = run('apply');
  assert(rules(6, 'nat').includes('PREROUTING -p udp -m addrtype --dst-type LOCAL -j SC1FORCR_SLOWDNS'), 'IPv6 dipasang');
  fs.rmSync(F('has-ipv6'));

  // ── 6. Port listen dipakai program lain: setup gagal tanpa merusak ───────
  fs.rmSync(F('active'));
  fs.writeFileSync(F('udp'), 'UNCONN 0 0 0.0.0.0:5300 0.0.0.0:* users:(("dnsmasq",pid=7,fd=4))\n');
  r = run('setup');
  assert.notStrictEqual(r.status, 0, 'port bentrok harus gagal');
  assert(/port UDP 5300 sudah dipakai/.test(r.out), r.out);
  fs.rmSync(F('udp'));
  r = run('setup');
  assert.strictEqual(r.status, 0, r.out);
  assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'service mati dinyalakan lagi oleh setup');

  // ── 7. enable/set-ns: validasi dan rollback ──────────────────────────────
  r = run('enable', 'sg1.contoh.net');
  assert.notStrictEqual(r.status, 0);
  assert(/tidak boleh sama dengan domain utama/.test(r.out), r.out);
  r = run('enable', 'bukan domain');
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(envValue('SLOWDNS_NS_DOMAIN'), 'NS-SG1.Contoh.NET.', 'input salah tidak menyentuh env');
  r = run('set-ns', 'dns.contoh.net');
  assert.strictEqual(r.status, 0, r.out);
  assert(fs.readFileSync(unitFile, 'utf8').includes(' -mtu 1232 dns.contoh.net 127.0.0.1:109'));
  assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'NS baru me-restart service');
  assert(/NS  dns\.contoh\.net  ->  sg1\.contoh\.net/.test(r.out), `record NS ditampilkan:\n${r.out}`);
  // Setup gagal (service tidak mau start) saat set-ns: NS lama dipulihkan.
  fs.writeFileSync(F('fail-start'), '');
  r = run('set-ns', 'dns2.contoh.net');
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(envValue('SLOWDNS_NS_DOMAIN'), 'dns.contoh.net', 'NS lama dipulihkan');
  fs.rmSync(F('fail-start'));
  run('setup');
  // enable dari keadaan mati, lalu gagal start: kembali mati.
  setEnv({ SLOWDNS_ENABLE: '0', SLOWDNS_NS_DOMAIN: '' });
  run('setup');
  fs.writeFileSync(F('fail-start'), '');
  r = run('enable', 'ns-sg1.contoh.net');
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(envValue('SLOWDNS_ENABLE'), '0', 'enable gagal: SLOWDNS_ENABLE dikembalikan');
  assert.strictEqual(envValue('SLOWDNS_NS_DOMAIN'), '', 'enable gagal: NS dikembalikan');
  assert.strictEqual(state().ENABLED, '0');
  assert.strictEqual(state().RULES, '0', 'enable gagal: aturan dilepas lagi');
  fs.rmSync(F('fail-start'));
  r = run('enable', 'ns-sg1.contoh.net');
  assert.strictEqual(r.status, 0, r.out);
  assert(/Berhasil: SlowDNS aktif/.test(r.out) && /Pubkey: [0-9a-f]{64}/.test(r.out), r.out);
  assert(read('gate.log').includes('apply'), 'gerbang ON/OFF diterapkan ulang setelah enable');
  assert.strictEqual(fs.readFileSync(path.join(keyDir, 'server.key'), 'utf8').trim(), '1'.padStart(64, '0'),
    'kunci lama tetap dipakai saat diaktifkan ulang');
  assert.strictEqual(run('suggest').out.trim(), 'ns-sg1.contoh.net');

  // ── 8. check: penghitung rule naik = delegasi benar ──────────────────────
  r = run('check');
  assert.notStrictEqual(r.status, 0, 'tanpa delegasi: gagal');
  assert(/belum sampai ke VPS ini/.test(r.out), r.out);
  fs.writeFileSync(F('delegated'), '');
  r = run('check');
  assert.strictEqual(r.status, 0, r.out);
  assert(/Delegasi NS sudah benar/.test(r.out), r.out);
  assert(/dns\.google\/resolve\?name=cek\d+a\.ns-sg1\.contoh\.net&type=TXT/.test(read('curl.log')), read('curl.log'));

  // ── 8b. SlowDNS Xray (sc-fast12): domain NS kedua, ON/OFF tanpa restart ──
  {
    const routeDnstt = fakeDnstt.replace('\nexit 1\n', '\nif [[ "$1" == "-h" ]]; then echo "  -routes-file string" >&2; exit 0; fi\nexit 1\n');
    fs.writeFileSync(dnsttBin, routeDnstt);
    const xrayEnv = { SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'ns-sg1.contoh.net', SLOWDNS_XRAY_ENABLE: '1', SLOWDNS_XRAY_NS_DOMAIN: 'NSX-SG1.contoh.net.' };
    setEnv(xrayEnv);
    r = run('setup');
    assert.strictEqual(r.status, 0, r.out);
    const unitX = fs.readFileSync(unitFile, 'utf8');
    assert(unitX.includes(` -mtu 1232 -routes-file ${toBashPath(stateFile)} -xray-domain nsx-sg1.contoh.net ` +
      '-xray-route /vmess=127.0.0.1:10001,/vless=127.0.0.1:10002,/trojan=127.0.0.1:10003 ns-sg1.contoh.net 127.0.0.1:109'), unitX);
    assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'unit berubah (domain Xray baru): restart sekali');
    assert.deepStrictEqual([state().XRAY_ENABLED, state().XRAY_NS, state().ROUTE_SSH, state().ROUTE_XRAY],
      ['1', 'nsx-sg1.contoh.net', '1', '1'], JSON.stringify(state()));
    // Layanan SSH OFF (menu ON/OFF): jalur SSH OFF lewat file state, tanpa restart.
    setEnv({ ...xrayEnv, SERVICE_SSH_ENABLE: '0' });
    r = run('apply');
    assert.strictEqual(r.status, 0, r.out);
    assert.deepStrictEqual([state().ROUTE_SSH, state().ROUTE_XRAY], ['0', '1']);
    assert.deepStrictEqual(mutatingSystemctl(), [], 'ON/OFF jalur tidak menyentuh systemd');
    // VMess/VLESS/Trojan semua OFF: jalur Xray OFF.
    setEnv({ ...xrayEnv, SERVICE_VMESS_ENABLE: '0', SERVICE_VLESS_ENABLE: 'off', SERVICE_TROJAN_ENABLE: 'no' });
    run('apply');
    assert.deepStrictEqual([state().ROUTE_SSH, state().ROUTE_XRAY], ['1', '0']);
    setEnv({ ...xrayEnv, SERVICE_VMESS_ENABLE: '0', SERVICE_VLESS_ENABLE: '0' });
    run('apply');
    assert.strictEqual(state().ROUTE_XRAY, '1', 'satu protokol Xray ON cukup');
    setEnv(xrayEnv);
    run('setup');
    // xray-disable / xray-enable: tanpa restart, SSH tidak terganggu.
    r = run('xray-disable');
    assert.strictEqual(r.status, 0, r.out);
    assert.deepStrictEqual([envValue('SLOWDNS_XRAY_ENABLE'), state().ROUTE_XRAY, state().ROUTE_SSH], ['0', '0', '1']);
    assert(!mutatingSystemctl().some((c) => /^(restart|stop|disable) /.test(c)), mutatingSystemctl().join('\n'));
    assert(read('gate.log').includes('apply'), 'gerbang diterapkan ulang setelah jalur berubah');
    r = run('xray-enable');
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(state().ROUTE_XRAY, '1');
    assert(!mutatingSystemctl().some((c) => /^restart /.test(c)), 'domain Xray sama: tanpa restart');
    assert(/NS  nsx-sg1\.contoh\.net  ->  sg1\.contoh\.net   \(SlowDNS Xray\)/.test(r.out), r.out);
    for (const [bad, why] of [['ns-sg1.contoh.net', /berbeda dari domain NS SSH/], ['sg1.contoh.net', /domain utama/], ['bukan domain', /tidak valid/]]) {
      r = run('xray-enable', bad);
      assert(r.status !== 0 && why.test(r.out), `${bad}: ${r.out}`);
      assert.strictEqual(envValue('SLOWDNS_XRAY_NS_DOMAIN'), 'nsx-sg1.contoh.net', 'input salah tidak menyentuh env');
    }
    r = run('set-ns', 'nsx-sg1.contoh.net');
    assert(r.status !== 0 && /domain NS Xray/.test(r.out), `NS SSH tidak boleh sama dengan NS Xray: ${r.out}`);
    // ssh-route off/on: jalur SSH saja, Xray tetap.
    r = run('ssh-route', 'off');
    assert.strictEqual(r.status, 0, r.out);
    assert.deepStrictEqual([envValue('SLOWDNS_SSH_ENABLE'), state().ROUTE_SSH, state().ROUTE_XRAY], ['0', '0', '1']);
    assert(!mutatingSystemctl().some((c) => /^restart /.test(c)));
    r = run('ssh-route', 'on');
    assert.deepStrictEqual([state().ROUTE_SSH, state().ROUTE_XRAY], ['1', '1']);
    assert.notStrictEqual(run('ssh-route', 'mungkin').status, 0);
    // check memeriksa kedua domain NS.
    r = run('check');
    assert.strictEqual(r.status, 0, r.out);
    assert(/name=cek\d+a\.ns-sg1\.contoh\.net/.test(read('curl.log')) && /name=cek\d+a\.nsx-sg1\.contoh\.net/.test(read('curl.log')), read('curl.log'));
    assert.strictEqual(run('suggest', 'xray').out.trim(), 'nsx-sg1.contoh.net');
    // Binary lama (tanpa sc-fast12): unit tanpa flag baru, Xray tidak diiklankan,
    // xray-enable ditolak dan env dikembalikan.
    installFakeDnstt();
    r = run('setup');
    assert.strictEqual(r.status, 0, r.out);
    assert(!fs.readFileSync(unitFile, 'utf8').includes('-routes-file'), 'binary lama: unit tanpa flag yang belum dikenal');
    assert.strictEqual(state().ROUTE_XRAY, '0', 'binary lama: jalur Xray tidak diiklankan');
    run('xray-disable');
    r = run('xray-enable');
    assert(r.status !== 0 && /belum bisa diaktifkan/.test(r.out), r.out);
    assert.strictEqual(envValue('SLOWDNS_XRAY_ENABLE'), '0', 'xray-enable gagal: saklar dikembalikan');
    setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'ns-sg1.contoh.net' });
    r = run('setup');
    assert.strictEqual(r.status, 0, r.out);
  }

  // ── 8c. Hemat CPU V.1FSC.136: urutan OUTPUT, bind langsung, batch ───────
  {
    const multiDnstt = fakeDnstt.replace('\nexit 1\n', '\nif [[ "$1" == "-h" ]]; then echo "  -routes-file string" >&2; ' +
      'echo "  -udp string  UDP address(es) to listen on, comma-separated (required)" >&2; exit 0; fi\nexit 1\n');
    fs.writeFileSync(dnsttBin, multiDnstt);
    const base = { SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'ns-sg1.contoh.net' };
    const dnsttOn53 = 'UNCONN 0 0 203.0.113.7:53 0.0.0.0:* users:(("dnstt-server",pid=99,fd=4))\n';
    const out5300 = 'OUTPUT -p udp -m udp --sport 5300 -m comment --comment sc-slowdns -j ACCEPT';
    const out53 = 'OUTPUT -p udp -m udp --sport 53 -m comment --comment sc-slowdns -j ACCEPT';
    const in53 = 'INPUT -p udp -m udp --dport 53 -m comment --comment sc-slowdns -j ACCEPT';
    const outRules = () => rules(4, 'filter').filter((l) => l.startsWith('OUTPUT '));
    const unitNow = () => fs.readFileSync(unitFile, 'utf8');
    setEnv(base);
    r = run('setup');
    assert.strictEqual(r.status, 0, r.out);
    // Binary sc-fast13 tanpa fitur opsional: unit sama persis dengan versi lama.
    assert(unitNow().includes(' -udp :5300 -privkey-file ') && !/Ambient|Capability|SLOWDNS_UDP_BATCH/.test(unitNow()), unitNow());

    // id2 (V.1FSC.135): jump kuota (92 rule owner) di posisi 1 di atas ACCEPT dnstt.
    fs.writeFileSync(F('rules4.filter'), ['OUTPUT -j SC_1FORCR_QUOTA_OUT', ...rules(4, 'filter')].join('\n') + '\n');
    r = run('apply');
    assert.strictEqual(r.status, 0, r.out);
    assert.deepStrictEqual(outRules().slice(0, 2), [out5300, 'OUTPUT -j SC_1FORCR_QUOTA_OUT'], outRules().join('\n'));
    assert(read('persist').includes('save'), 'urutan baru disimpan');
    r = run('apply');
    assert.strictEqual(read('writes'), '', 'posisi sudah benar: apply berikutnya tidak menulis');
    // Gerbang ON/OFF boleh di atasnya (gerbang memaksa dirinya pertama).
    fs.writeFileSync(F('rules4.filter'), ['OUTPUT -j SC1FORCR_SVC_OUT', ...rules(4, 'filter')].join('\n') + '\n');
    r = run('apply');
    assert.strictEqual(read('writes'), '', 'jump gerbang di atas ACCEPT dnstt tidak dianggap menggeser');
    // Rule lain disisip di puncak (di atas gerbang juga): ACCEPT dnstt naik ke
    // puncak; apply gerbang berikutnya memindah jump gerbang ke atasnya lagi,
    // dan posisi itu stabil (tidak saling geser tiap siklus watchdog).
    fs.writeFileSync(F('rules4.filter'), ['OUTPUT -p tcp -m tcp --dport 25 -j REJECT', ...rules(4, 'filter')].join('\n') + '\n');
    r = run('apply');
    assert.deepStrictEqual(outRules().slice(0, 2), [out5300, 'OUTPUT -p tcp -m tcp --dport 25 -j REJECT'], outRules().join('\n'));
    assert.strictEqual(outRules().filter((l) => l.includes('sc-slowdns')).length, 1, 'tidak dobel');
    fs.writeFileSync(F('rules4.filter'), ['OUTPUT -j SC1FORCR_SVC_OUT',
      ...rules(4, 'filter').filter((l) => l !== 'OUTPUT -j SC1FORCR_SVC_OUT')].join('\n') + '\n');
    r = run('apply');
    assert.strictEqual(read('writes'), '', 'gerbang kembali pertama: ACCEPT dnstt di bawahnya sudah benar');
    assert.deepStrictEqual(outRules().slice(0, 3), ['OUTPUT -j SC1FORCR_SVC_OUT', out5300, 'OUTPUT -p tcp -m tcp --dport 25 -j REJECT']);

    // Bind langsung: unit IP:53 + port cadangan, CAP_NET_BIND_SERVICE (tetap non-root).
    setEnv({ ...base, SLOWDNS_DIRECT_BIND: '1' });
    r = run('setup');
    assert.strictEqual(r.status, 0, r.out);
    assert(unitNow().includes(' -udp 203.0.113.7:53,:5300 -privkey-file ') && unitNow().includes('AmbientCapabilities=CAP_NET_BIND_SERVICE') &&
      unitNow().includes('CapabilityBoundingSet=CAP_NET_BIND_SERVICE') && unitNow().includes('User=sc-1forcr-slowdns'), unitNow());
    assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'unit berubah: restart sekali');
    assert.strictEqual(state().DIRECT, '', 'soket IP:53 belum terlihat milik dnstt: belum NOTRACK');
    assert(!rules(4, 'raw').some((l) => l.includes('SDNS')));
    fs.writeFileSync(F('udp'), dnsttOn53);
    r = run('apply');
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(state().DIRECT, '203.0.113.7');
    const raw = rules(4, 'raw');
    for (const want of ['PREROUTING -p udp -j SC1FORCR_SDNS_PRE', 'OUTPUT -p udp -j SC1FORCR_SDNS_OUT',
      'SC1FORCR_SDNS_PRE -d 203.0.113.7/32 -p udp -m udp --dport 53 -m socket -m comment --comment sc-slowdns -j CT --notrack',
      'SC1FORCR_SDNS_OUT -s 203.0.113.7/32 -p udp -m udp --sport 53 -m comment --comment sc-slowdns -j CT --notrack']) {
      assert(raw.includes(want), `raw wajib memuat ${want}:\n${raw.join('\n')}`);
    }
    assert(rules(4, 'filter').includes(in53), 'INPUT menerima query port 53 yang tidak lewat REDIRECT');
    assert.deepStrictEqual(outRules().slice(0, 3), ['OUTPUT -j SC1FORCR_SVC_OUT', out5300, out53], outRules().join('\n'));
    assert(rules(4, 'nat').includes('SC1FORCR_SLOWDNS -p udp -m udp --dport 53 -m comment --comment sc-slowdns -j REDIRECT --to-ports 5300'),
      'REDIRECT tetap ada sebagai jalur cadangan (IPv6, IP lain, soket IP:53 hilang)');
    r = run('apply');
    assert.strictEqual(read('writes'), '', 'bind langsung: apply berikutnya tidak menulis');
    r = run('status');
    assert(/Bind langsung : AKTIF 203\.0\.113\.7:53/.test(r.out), r.out);
    // IP:53 direbut program lain: NOTRACK dilepas, query kembali lewat REDIRECT.
    fs.writeFileSync(F('udp'), 'UNCONN 0 0 203.0.113.7:53 0.0.0.0:* users:(("named",pid=7,fd=4))\n');
    r = run('apply');
    assert.strictEqual(state().DIRECT, '');
    assert(!rules(4, 'raw').some((l) => l.includes('SDNS')) && !rules(4, 'filter').includes(in53) && !outRules().includes(out53));
    // Setup saat port 53 dipakai program lain (alamat itu atau wildcard): unit tanpa IP:53.
    for (const busy of ['UNCONN 0 0 203.0.113.7:53 0.0.0.0:* users:(("named",pid=7,fd=4))\n',
      'UNCONN 0 0 0.0.0.0:53 0.0.0.0:* users:(("dnsmasq",pid=7,fd=4))\n', 'UNCONN 0 0 *:53 *:* users:(("unbound",pid=7,fd=4))\n']) {
      fs.writeFileSync(F('udp'), busy);
      r = run('setup');
      assert.strictEqual(r.status, 0, r.out);
      assert(unitNow().includes(' -udp :5300 ') && !unitNow().includes('Ambient'), `port 53 sibuk (${busy.trim()}): ${unitNow()}`);
    }
    // systemd-resolved (127.0.0.53) tidak bentrok dengan IP publik.
    fs.writeFileSync(F('udp'), 'UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=5,fd=13))\n' + dnsttOn53);
    r = run('setup');
    assert(unitNow().includes(' -udp 203.0.113.7:53,:5300 '), unitNow());
    run('apply');
    assert.strictEqual(state().DIRECT, '203.0.113.7');
    // Rollback: set-direct off melepas NOTRACK dan unit kembali seperti semula.
    r = run('set-direct', 'off');
    assert.strictEqual(r.status, 0, r.out);
    assert(/Berhasil: bind langsung OFF/.test(r.out), r.out);
    assert.strictEqual(envValue('SLOWDNS_DIRECT_BIND'), '0');
    assert(unitNow().includes(' -udp :5300 -privkey-file ') && !/Ambient|Capability/.test(unitNow()), unitNow());
    assert(!rules(4, 'raw').some((l) => l.includes('SDNS')) && !rules(4, 'filter').includes(in53), 'raw dan rule port 53 dilepas');
    assert.strictEqual(state().DIRECT, '');
    assert(read('gate.log').includes('apply'), 'gerbang diterapkan ulang');
    assert.notStrictEqual(run('set-direct', 'mungkin').status, 0);
    r = run('set-direct', 'on');
    assert.strictEqual(r.status, 0, r.out);
    assert(/Berhasil: bind langsung AKTIF di 203\.0\.113\.7/.test(r.out), r.out);
    // Ringkasan untuk layar menu SlowDNS (KEY=VALUE).
    r = run('brief');
    assert.strictEqual(r.status, 0, r.out);
    for (const want of ['ENABLED=1', 'SERVICE=active', 'NS=ns-sg1.contoh.net', 'SSH_STATE=ON', 'XRAY_STATE=OFF',
      'DNS=203.0.113.7:53', 'DIRECT=ON', 'BATCH=0', 'AUTOLOCK=ON']) {
      assert(r.out.split('\n').includes(want), `brief wajib memuat ${want}:\n${r.out}`);
    }
    assert(/^PUBKEY=[0-9a-f]{64}$/m.test(r.out) && /^BINARY=v1\.20260501\.0\+sc-fast13$/m.test(r.out), r.out);
    // Binary lama (tanpa -udp beberapa alamat): unit tidak berubah, status menjelaskan.
    installFakeDnstt();
    r = run('setup');
    assert(unitNow().includes(' -udp :5300 ') && !unitNow().includes('Ambient'), unitNow());
    r = run('apply');
    assert.strictEqual(state().DIRECT, '', 'binary lama: tidak ada NOTRACK');
    assert(/Bind langsung : BELUM AKTIF \(binary dnstt sc-fast13/.test(run('status').out));
    // Batch UDP: hanya baris env, opt-in, rollback lewat set-batch off.
    fs.writeFileSync(dnsttBin, multiDnstt);
    setEnv(base);
    run('setup');
    for (const [arg, want] of [['on', '16'], ['8', '8'], ['off', '0']]) {
      r = run('set-batch', arg);
      assert.strictEqual(r.status, 0, r.out);
      assert.strictEqual(envValue('SLOWDNS_UDP_BATCH'), want);
      const line = (unitNow().match(/^Environment=SLOWDNS_UDP_BATCH=(.*)$/m) || [])[1];
      assert.strictEqual(line, want === '0' ? undefined : want, unitNow());
    }
    for (const bad of ['1x', '99', '', 'nyala']) {
      assert.notStrictEqual(run('set-batch', bad).status, 0, `set-batch ${bad} harus ditolak`);
      assert.strictEqual(envValue('SLOWDNS_UDP_BATCH'), '0', 'input salah tidak menyentuh env');
    }
    r = run('cpu-stat', 'x');
    assert(r.status !== 0 && /cpu-stat \[DETIK\] \[JENDELA\]/.test(r.out), r.out);
    fs.rmSync(F('udp'), { force: true });
    installFakeDnstt();
    setEnv(base);
    r = run('setup');
    assert.strictEqual(r.status, 0, r.out);
  }

  // ── 9. regen-key: pubkey baru, service di-restart ────────────────────────
  const oldPub = state().PUBKEY;
  r = run('regen-key');
  assert.strictEqual(r.status, 0, r.out);
  assert.notStrictEqual(state().PUBKEY, oldPub, 'pubkey berganti');
  assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'));

  // ── 9b. set-key: kunci sendiri (pindah dari VPS lain tanpa restore) ──────
  // Kunci X25519 asli; pubkey dihitung helper lewat openssl, sama dengan dnstt.
  const x25519Pair = () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    return {
      priv: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex'),
      pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
    };
  };
  const setKey = (input) => {
    for (const f of ['writes', 'persist', 'systemctl.log', 'gate.log', 'curl.log']) fs.rmSync(F(f), { force: true });
    const r = spawnSync(bash, ['-c', 'export PATH="${FAKE_BIN}:${PATH}"; exec bash "$0" set-key', toBashPath(scriptPath)], {
      encoding: 'utf8',
      input,
      timeout: 120000,
      env: {
        ...process.env,
        FAKE_BIN: toBashPath(bin),
        FAKE_DIR: toBashPath(tmp),
        SC_ENV_FILE: toBashPath(envFile),
        SLOWDNS_STATE_FILE: toBashPath(stateFile),
        SLOWDNS_KEY_DIR: toBashPath(keyDir),
        SLOWDNS_BIN_PATH: toBashPath(dnsttBin),
        SLOWDNS_UNIT_FILE: toBashPath(unitFile),
        SLOWDNS_LOCK_FILE: toBashPath(F('lock')),
        SLOWDNS_BUILD_ROOT: toBashPath(buildRoot),
        SLOWDNS_WAIT_SECONDS: '1',
        SLOWDNS_SERVICE_GATE_BIN: toBashPath(path.join(bin, 'service-gate'))
      }
    });
    assert(!r.error, `set-key macet: ${r.error && r.error.message}`);
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const keyFile = (name) => fs.readFileSync(path.join(keyDir, name), 'utf8').trim();
  const opensslOk = spawnSync(bash, ['-c', 'command -v openssl >/dev/null && command -v od >/dev/null'], { encoding: 'utf8' }).status === 0;
  if (opensslOk) {
    const manual = x25519Pair();
    const before = { priv: keyFile('server.key'), pub: keyFile('server.pub') };
    // Pubkey salah: ditolak, kunci lama utuh, service tidak disentuh.
    let k = setKey(`${manual.priv}\n${x25519Pair().pub}\n`);
    assert.notStrictEqual(k.status, 0, k.out);
    assert(/tidak cocok/.test(k.out) && k.out.includes(manual.pub), k.out);
    assert.deepStrictEqual({ priv: keyFile('server.key'), pub: keyFile('server.pub') }, before);
    assert(!mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'));
    k = setKey('bukan-hex\n\n');
    assert.notStrictEqual(k.status, 0, k.out);
    assert(/64 karakter hex/.test(k.out), k.out);
    // Pasangan benar saat SlowDNS aktif: kunci terpasang dan service di-restart.
    k = setKey(`${manual.priv.toUpperCase()}\n${manual.pub}\n`);
    assert.strictEqual(k.status, 0, k.out);
    assert(k.out.includes(`Pubkey: ${manual.pub}`), k.out);
    assert.strictEqual(keyFile('server.key'), manual.priv);
    assert.strictEqual(keyFile('server.pub'), manual.pub);
    assert.strictEqual(state().PUBKEY, manual.pub);
    assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'kunci baru wajib me-restart dnstt');
    assert(!read('systemctl.log').includes(manual.priv), 'private key tidak boleh lewat argumen');
    // Kunci yang sama lagi: tidak ada perubahan, tidak ada restart.
    k = setKey(`${manual.priv}\n\n`);
    assert.strictEqual(k.status, 0, k.out);
    assert(/tidak ada yang diubah/.test(k.out), k.out);
    assert(!mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'));
  } else {
    console.log('test slowdns: uji set-key dilewati (openssl/od tidak ada)');
  }

  // ── 10. disable: aturan dilepas, kunci disimpan ─────────────────────────
  const pubBefore = state().PUBKEY;
  r = run('disable');
  assert.strictEqual(r.status, 0, r.out);
  assert(mutatingSystemctl().includes('disable --no-reload --now sc-1forcr-slowdns.service'), systemctlCalls().join('\n'));
  assert(!rules(4, 'nat').some((l) => l.includes('SLOWDNS')), 'aturan nat dilepas');
  assert(!rules(4, 'filter').some((l) => l.includes('sc-slowdns')), 'aturan INPUT dilepas');
  assert.strictEqual(state().ENABLED, '0');
  assert.strictEqual(state().PUBKEY, pubBefore, 'kunci tetap disimpan');

  // ── 10b. set-key saat SlowDNS mati: kunci dipasang, service tetap mati ───
  if (opensslOk) {
    const off = x25519Pair();
    const k = setKey(`${off.priv}\n${off.pub}\n`);
    assert.strictEqual(k.status, 0, k.out);
    assert.strictEqual(keyFile('server.key'), off.priv);
    assert.strictEqual(state().PUBKEY, off.pub, 'state ikut pubkey baru walau SlowDNS mati');
    assert.strictEqual(state().ENABLED, '0');
    assert(!mutatingSystemctl().some((c) => /^(restart|start|enable) /.test(c)), mutatingSystemctl().join('\n'));
  }

  // ── 11. Binary dari URL wajib checksum; binary lama dipakai kalau gagal ──
  fs.writeFileSync(F('dnstt-download'), fakeDnstt);
  const sha = crypto.createHash('sha256').update(fakeDnstt).digest('hex');
  setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'ns-sg1.contoh.net', SLOWDNS_BIN_URL: 'https://contoh.net/dnstt-bin', SLOWDNS_BIN_SHA256: sha });
  r = run('setup');
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(fs.readFileSync(`${dnsttBin}.version`, 'utf8').trim(), `sha256:${sha}`);
  assert(mutatingSystemctl().includes('restart sc-1forcr-slowdns.service'), 'binary baru me-restart service');
  setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'ns-sg1.contoh.net', SLOWDNS_BIN_URL: 'https://contoh.net/dnstt-bin', SLOWDNS_BIN_SHA256: 'f'.repeat(64) });
  r = run('setup');
  assert.strictEqual(r.status, 0, `checksum salah tapi binary lama ada: tetap jalan\n${r.out}`);
  assert(/Checksum binary dnstt tidak cocok/.test(r.out) && /binary lama tetap dipakai/.test(r.out), r.out);
  fs.rmSync(dnsttBin);
  r = run('setup');
  assert.notStrictEqual(r.status, 0, 'tanpa binary dan checksum salah: gagal');

  // ── 12. clear (uninstall) ───────────────────────────────────────────────
  installFakeDnstt();
  setEnv({ SLOWDNS_ENABLE: '1', SLOWDNS_NS_DOMAIN: 'ns-sg1.contoh.net' });
  run('setup');
  r = run('clear');
  assert.strictEqual(r.status, 0, r.out);
  assert(!fs.existsSync(unitFile) && !fs.existsSync(dnsttBin) && !fs.existsSync(stateFile));
  assert(!rules(4, 'nat').some((l) => l.includes('SLOWDNS')) && !rules(4, 'filter').some((l) => l.includes('sc-slowdns')));
  assert(fs.existsSync(path.join(keyDir, 'server.key')), 'uninstall menyimpan kunci');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── API: data.slowdns hanya saat aktif dan SSH ON ───────────────────────────
const api = extract(installer, 'cat > "${APP_DIR}/api.js" <<\'EOF\'\n', '\nEOF\n');
const slowdnsSrc = extract(api, '\nconst SLOWDNS_STATE_FILE', '\n// ovpntcp/ovpnudp/sshohp', true);
const sshPayloadSrc = extract(api, '\nfunction sshPayload(', '\n}\n', true);
function payload(stateText, toggles = {}) {
  const ctx = vm.createContext({
    fs: { readFileSync: () => { if (stateText === null) throw new Error('ENOENT'); return stateText; } },
    readServiceToggles: () => toggles,
    Date,
    DOMAIN: 'sg1.contoh.net',
    SSHWS_UDPGW_PORTS: ['7300'],
    udpcustomPublicPort: () => '',
    publicPorts: (extra) => ({ tls: '443', none: '80', ...extra }),
    nowTime: () => '10:00:00',
    sanitizeInfoText: (t) => t
  });
  new vm.Script(`${slowdnsSrc}\n${sshPayloadSrc}\n}\nthis.out = sshPayload('budi', 'rahasia', '2026-12-01', 1);`).runInContext(ctx);
  return ctx.out;
}
const goodState = ['ENABLED=1', 'ACTIVE=1', 'RULES=1', 'NS=ns-sg1.contoh.net', `PUBKEY=${'ab'.repeat(32)}`, 'PUBLIC_IP=203.0.113.7'].join('\n');
let p = payload(goodState);
assert.strictEqual(JSON.stringify(p.slowdns), JSON.stringify({ ns: 'ns-sg1.contoh.net', pubkey: 'ab'.repeat(32), dns: '203.0.113.7:53' }));
assert.strictEqual(p.port.slowdns, '53');
assert.strictEqual(payload(goodState, { SERVICE_SSH_ENABLE: '0' }).slowdns, undefined, 'SSH OFF: SlowDNS tidak diiklankan');
for (const bad of [goodState.replace('ACTIVE=1', 'ACTIVE=0'), goodState.replace('RULES=1', 'RULES=0'),
  goodState.replace('ENABLED=1', 'ENABLED=0'), goodState.replace(/PUBKEY=.*/, 'PUBKEY=xyz'), null]) {
  p = payload(bad);
  assert(!('slowdns' in p) && !('slowdns' in p.port), `state tidak sehat tidak boleh mengiklankan SlowDNS: ${bad}`);
}
assert.strictEqual(payload(goodState.replace('PUBLIC_IP=203.0.113.7', 'PUBLIC_IP=')).slowdns.dns, '', 'IP tidak diketahui: DNS kosong');

// ── API: SlowDNS Xray (V.1FSC.135) per protokol + link 1FTunnel ─────────────
{
  const xrayInfo = (stateText, protocol, toggles = {}) => {
    const ctx = vm.createContext({
      fs: { readFileSync: () => { if (stateText === null) throw new Error('ENOENT'); return stateText; } },
      readServiceToggles: () => toggles, Date
    });
    new vm.Script(`${slowdnsSrc}\nthis.x = slowdnsXrayInfo(${JSON.stringify(protocol)}); this.s = slowdnsInfo();`).runInContext(ctx);
    return { xray: ctx.x, ssh: ctx.s };
  };
  const xState = goodState + '\nXRAY_NS=nsx-sg1.contoh.net\nROUTE_SSH=1\nROUTE_XRAY=1';
  const pub = 'ab'.repeat(32);
  assert.strictEqual(JSON.stringify(xrayInfo(xState, 'vless').xray), JSON.stringify({ ns: 'nsx-sg1.contoh.net', pubkey: pub, dns: '203.0.113.7:53' }));
  assert.strictEqual(xrayInfo(xState, 'vless', { SERVICE_VLESS_ENABLE: '0' }).xray, null, 'VLESS OFF: SlowDNS Xray VLESS tidak diiklankan');
  assert(xrayInfo(xState, 'vmess', { SERVICE_VLESS_ENABLE: '0' }).xray, 'protokol lain tetap');
  assert.strictEqual(xrayInfo(xState.replace('ROUTE_XRAY=1', 'ROUTE_XRAY=0'), 'vless').xray, null, 'jalur Xray mati');
  assert.strictEqual(xrayInfo(goodState, 'vless').xray, null, 'state lama tanpa XRAY_NS');
  assert.strictEqual(xrayInfo(xState.replace('XRAY_NS=nsx-sg1.contoh.net', 'XRAY_NS=ns-sg1.contoh.net'), 'vless').xray, null, 'NS Xray sama dengan NS SSH ditolak');
  assert.strictEqual(xrayInfo(xState, 'ssh').xray, null);
  const sshOff = xrayInfo(xState.replace('ROUTE_SSH=1', 'ROUTE_SSH=0'), 'trojan');
  assert(sshOff.ssh === null && sshOff.xray, 'SlowDNS SSH OFF tidak mematikan SlowDNS Xray');
  assert(xrayInfo(goodState, 'vless').ssh, 'state lama tanpa ROUTE_SSH: SSH tetap ON');

  const linkSrc = extract(api, '\nfunction slowdnsLinkQuery(', '\nfunction addFrontBugLink(', true);
  const lctx = vm.createContext({ Buffer, XRAY_PATH_VMESS: '/vmess', XRAY_PATH_VLESS: '/vless', XRAY_PATH_TROJAN: '/trojan' });
  new vm.Script(`${linkSrc}\nthis.f = { vmessSlowdnsLink, vlessSlowdnsLink, trojanSlowdnsLink };`).runInContext(lctx);
  const info = { ns: 'nsx-sg1.contoh.net', pubkey: pub, dns: '203.0.113.7:53' };
  assert.strictEqual(lctx.f.vlessSlowdnsLink('sg1.contoh.net', 'uuid-1', info, 'budi'),
    `vless://uuid-1@sg1.contoh.net:80?type=ws&path=%2Fvless&security=none&host=sg1.contoh.net&encryption=none&slowdns=nsx-sg1.contoh.net&slowdnskey=${pub}#budi-slowdns`);
  assert.strictEqual(lctx.f.trojanSlowdnsLink('sg1.contoh.net', 'pass-1', info, 'budi'),
    `trojan://pass-1@sg1.contoh.net:80?type=ws&path=%2Ftrojan&security=none&host=sg1.contoh.net&slowdns=nsx-sg1.contoh.net&slowdnskey=${pub}#budi-slowdns`);
  const vm1 = JSON.parse(Buffer.from(lctx.f.vmessSlowdnsLink('sg1.contoh.net', 'uuid-2', info, 'budi').slice(8), 'base64').toString());
  assert.deepStrictEqual([vm1.add, vm1.port, vm1.net, vm1.path, vm1.tls, vm1.host, vm1.slowdns, vm1.slowdnskey, vm1.ps],
    ['sg1.contoh.net', '80', 'ws', '/vmess', 'none', 'sg1.contoh.net', 'nsx-sg1.contoh.net', pub, 'budi-slowdns']);
  // Path link = path inbound WS yang dipetakan dnstt (-xray-route).
  for (const p of ['/vmess', '/vless', '/trojan']) assert(helper.includes(`${p}=127.0.0.1:1000`), `rute dnstt memuat ${p}`);
  const create = extract(api, '\nasync function createXray(', '\n}\n');
  assert.strictEqual((create.match(/\.\.\.slowdnsPort \}\)/g) || []).length, 3, 'port.slowdns di ketiga protokol');
  assert.strictEqual((create.match(/\.\.\.slowdnsData\n/g) || []).length, 3, 'data.slowdns di ketiga protokol');
  for (const fn of ['vmessSlowdnsLink', 'vlessSlowdnsLink', 'trojanSlowdnsLink']) assert(create.includes(`...(slowdns ? { slowdns: ${fn}(`), `${fn} dipakai createXray`);
  assert(extract(api, '\nasync function renewXray(', '\n}\n').includes('slowdnsXrayInfo(meta.protocol)'), 'renew Xray ikut membawa SlowDNS');
}

// ── Gerbang ON/OFF: SSH OFF ikut menutup port SlowDNS ───────────────────────
const gate = extract(installer, "cat > /usr/local/sbin/sc-1forcr-service-gate <<'SERVICE_GATE_EOF'\n", '\nSERVICE_GATE_EOF\n');
const buildRules = extract(gate, '\nbuild_rules() {', '\n}\n');
const sshBlock = buildRules.slice(0, buildRules.indexOf('service_enabled vmess'));
assert(sshBlock.includes('ports="$(slowdns_port)"') &&
  sshBlock.includes('! -i lo -p udp -m multiport --dports ${ports} -m comment --comment sc-svc-ssh -j DROP'),
  'SSH OFF wajib menolak port listen SlowDNS');
assert(sshBlock.includes('if slowdns_direct_active; then') &&
  sshBlock.includes('! -i lo -p udp -m udp --dport 53 -m conntrack --ctstate UNTRACKED -m comment --comment sc-svc-ssh -j DROP'),
  'SSH OFF juga menolak query bind langsung (UNTRACKED), bukan DNS lain di VPS');
const gateFns = extract(gate, '\njoin_ports() {', '\n}\n', true) + '\n}\n' + extract(gate, '\nslowdns_port() {', '\n}\n', true) + '\n}\n' +
  extract(gate, '\nslowdns_direct_active() {', '\n}\n', true) + '\n}\n';
const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slowdns-gate-'));
try {
  const st = path.join(gateTmp, 'state');
  const port = (text) => {
    if (text === null) fs.rmSync(st, { force: true }); else fs.writeFileSync(st, text);
    const r = spawnSync(bash, ['-c', `${gateFns}\nslowdns_port`], { encoding: 'utf8', env: { ...process.env, SLOWDNS_STATE_FILE: toBashPath(st) } });
    return r.stdout.trim();
  };
  assert.strictEqual(port('ENABLED=1\nLISTEN=5300\n'), '5300');
  assert.strictEqual(port('ENABLED=0\nLISTEN=5300\n'), '', 'SlowDNS mati: tidak ada rule');
  assert.strictEqual(port(null), '', 'tanpa state: tidak ada rule');
  assert.strictEqual(port('ENABLED=1\nLISTEN=53\n'), '', 'port 53 tidak pernah ditolak gerbang');
  // SlowDNS Xray aktif: port dipakai bersama, SSH OFF ditangani dnstt (ROUTE_SSH=0).
  assert.strictEqual(port('ENABLED=1\nLISTEN=5300\nROUTE_SSH=0\nROUTE_XRAY=1\n'), '', 'jalur Xray aktif: port SlowDNS tidak ditutup');
  assert.strictEqual(port('ENABLED=1\nLISTEN=5300\nROUTE_SSH=0\nROUTE_XRAY=0\n'), '5300', 'tanpa jalur Xray: perilaku lama');
  const direct = (text) => {
    fs.writeFileSync(st, text);
    return spawnSync(bash, ['-c', `${gateFns}\nif slowdns_direct_active; then echo ya; else echo tidak; fi`],
      { encoding: 'utf8', env: { ...process.env, SLOWDNS_STATE_FILE: toBashPath(st) } }).stdout.trim();
  };
  assert.strictEqual(direct('ENABLED=1\nLISTEN=5300\nDIRECT=203.0.113.7\n'), 'ya');
  assert.strictEqual(direct('ENABLED=1\nLISTEN=5300\nDIRECT=\n'), 'tidak', 'tanpa bind langsung: tidak ada rule tambahan');
  assert.strictEqual(direct('ENABLED=1\nLISTEN=5300\nDIRECT=203.0.113.7\nROUTE_XRAY=1\n'), 'tidak', 'jalur Xray aktif: port dipakai bersama');
  assert.strictEqual(direct('ENABLED=0\nDIRECT=203.0.113.7\n'), 'tidak');
  const setFn = extract(gate, '\ncmd_set() {', '\n}\n');
  assert(setFn.indexOf('slowdns_routes_apply') > 0 && setFn.indexOf('slowdns_routes_apply') < setFn.indexOf('if ! cmd_apply; then'),
    'gerbang: jalur SlowDNS diperbarui sebelum rule disusun');
  assert(/slowdns_routes_apply\(\) \{[\s\S]*?"\$\{bin\}" apply >\/dev\/null 2>&1 \|\| true/.test(gate),
    'gerbang memanggil helper apply (tanpa restart, gagal tidak menggagalkan ON/OFF)');
} finally {
  fs.rmSync(gateTmp, { recursive: true, force: true });
}

// ── Urutan install/update/watchdog dan persistensi env ─────────────────────
const health = extract(installer, "cat > /usr/local/sbin/sc-1forcr-postboot-health <<'POSTBOOT_HEALTH_EOF'\n", '\nPOSTBOOT_HEALTH_EOF\n');
assert(health.indexOf('sc-1forcr-slowdns apply') > 0 &&
  health.indexOf('sc-1forcr-slowdns apply') < health.indexOf('sc-1forcr-service-gate apply'),
  'watchdog: SlowDNS sebelum gerbang ON/OFF');
assert(health.includes('repair_unit_if_needed sc-1forcr-slowdns.service'), 'watchdog memulihkan service SlowDNS');
const mainFn = installer.slice(installer.lastIndexOf('\nmain() {'));
const safePath = mainFn.slice(0, mainFn.indexOf('Re-run guard'));
const fullPath = mainFn.slice(mainFn.indexOf('Re-run guard'));
for (const [name, body, gateCall] of [['update aman', safePath, '\n    apply_service_gates'], ['install penuh', fullPath, '"38b_service_gate"']]) {
  assert(body.includes('setup_slowdns') && body.indexOf('setup_slowdns') < body.indexOf(gateCall),
    `${name}: setup_slowdns dipanggil sebelum gerbang ON/OFF`);
}
assert(/^setup_slowdns\(\) \{\n  install_slowdns_manager \|\| return 0\n[\s\S]*?\n  return 0\n\}/m.test(installer),
  'setup_slowdns tidak boleh menggagalkan install/update');
const envKeys = ['SLOWDNS_ENABLE', 'SLOWDNS_NS_DOMAIN', 'SLOWDNS_LISTEN_PORT', 'SLOWDNS_MTU', 'SLOWDNS_MEMORY_MAX',
  'SLOWDNS_KCP_WINDOW', 'SLOWDNS_KCP_INTERVAL', 'SLOWDNS_KCP_ACK_NODELAY', 'SLOWDNS_DIRECT_BIND', 'SLOWDNS_UDP_BATCH',
  'SLOWDNS_BIN_URL', 'SLOWDNS_BIN_SHA256',
  'SLOWDNS_SSH_ENABLE', 'SLOWDNS_XRAY_ENABLE', 'SLOWDNS_XRAY_NS_DOMAIN'];
const envDump = extract(installer, '\n  cat > /etc/sc-1forcr.env <<EOF\n', '\nEOF\n');
const pending = extract(installer, '\npersist_pending_install_env() {', '\n}\n');
const menuUpdate = extract(installer, 'echo "Menjalankan update installer..."', 'bash "${tmp}" 2>&1 | tee "${update_log}"');
for (const key of envKeys) {
  assert(envDump.includes(`\n${key}=\${${key}}`), `${key} wajib ada di /etc/sc-1forcr.env`);
  assert(new RegExp(`\\b${key}\\b`).test(pending), `${key} wajib ada di persist_pending_install_env`);
  assert(menuUpdate.includes(`${key}="\${${key}:-`), `${key} wajib diteruskan update dari menu`);
}
for (const [key, def] of [['SLOWDNS_KCP_INTERVAL', '10'], ['SLOWDNS_KCP_ACK_NODELAY', '0'], ['SLOWDNS_DIRECT_BIND', '0'], ['SLOWDNS_UDP_BATCH', '0']]) {
  assert(installer.includes(`\n${key}="\${${key}:-${def}}"\n`), `${key} default ${def} di installer`);
  assert(menuUpdate.includes(`${key}="\${${key}:-${def}}"`), `${key} default ${def} saat update dari menu`);
}
const kcpMenu = extract(installer, '\nslowdns_kcp_menu() {', '\n}\n');
for (const pair of ['1) interval=10; ack=0', '2) interval=20; ack=0', '3) interval=10; ack=1', '4) interval=20; ack=1']) {
  assert(kcpMenu.includes(pair), `menu uji KCP memuat kombinasi ${pair}`);
}
assert(kcpMenu.includes('"${bin}" set-kcp "${interval}" "${ack}"') && installer.includes('    9) slowdns_kcp_menu "${bin}" ;;'),
  'menu Tools > SlowDNS [9] memanggil set-kcp');
const perfMenu = extract(installer, '\nslowdns_perf_menu() {', '\n}\n');
assert(perfMenu.includes('"${bin}" set-direct off') && perfMenu.includes('"${bin}" set-direct on') &&
  perfMenu.includes('"${bin}" set-batch on') && perfMenu.includes('"${bin}" set-batch off') && perfMenu.includes('"${bin}" cpu-stat 60 10') &&
  installer.includes('    13) slowdns_perf_menu "${bin}" ;;'), 'menu Tools > SlowDNS [13]: bind langsung, batch UDP, ukur CPU (dengan rollback)');
const uninstall = extract(installer, '\n/usr/local/sbin/sc-1forcr-extra-ports clear', '\necho "Uninstall SC 1FORCR selesai');
assert(uninstall.includes('/usr/local/sbin/sc-1forcr-slowdns clear') && uninstall.includes('rm -f /usr/local/sbin/sc-1forcr-slowdns'),
  'uninstall melepas SlowDNS');

console.log('slowdns tests passed');

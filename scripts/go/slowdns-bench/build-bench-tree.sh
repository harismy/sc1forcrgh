#!/usr/bin/env bash
# Build UJI dnstt-server berinstrumen (tag scbench) untuk
# `node scripts/bench-slowdns-kcp.js --instr 1`. Tidak dipakai installer.
#
#   bash scripts/go/slowdns-bench/build-bench-tree.sh SRC OUT
#
# SRC: tree dnstt lengkap (dengan dnstt-client) yang sudah dipatch
#      SLOWDNS_PATCH_PY, mis. hasil `python3 -I patch.py dnstt.zip SRC v1.20260501.0`.
# OUT: folder hasil (dibuat ulang): OUT/tree, OUT/bin/dnstt-server[.exe],
#      OUT/bin/dnstt-client[.exe]. Arahkan DNSTT_NATIVE_DIR ke OUT/bin.
#
# Butuh go (>=1.21) dan python3 di PATH. SRC tidak diubah.
set -euo pipefail
SRC="${1:?SRC (tree dnstt hasil patch)}"
OUT="${2:?OUT}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python)"
EXE=""
case "$(go env GOOS)" in windows) EXE=".exe" ;; esac

[[ -f "${SRC}/dnstt-server/main.go" && -d "${SRC}/dnstt-client" ]] || {
  echo "SRC harus tree dnstt lengkap (dnstt-server + dnstt-client)" >&2
  exit 1
}
mkdir -p "${OUT}/bin"
OUT="$(cd "${OUT}" && pwd)"
rm -rf "${OUT}/tree"
cp -r "${SRC}" "${OUT}/tree"
cp "${HERE}"/sc_bench.go "${HERE}"/sc_bench_off.go "${HERE}"/sc_dedup.go "${OUT}/tree/dnstt-server/"

# Kait instrumen di main.go. Anchor tidak cocok = gagal, bukan build tanpa kait.
"${PY}" -I - "${OUT}/tree/dnstt-server/main.go" <<'PY'
import io
import sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
def rep(a, b):
    global s
    if s.count(a) != 1:
        sys.exit('anchor tidak ditemukan tepat satu kali: %r' % a)
    s = s.replace(a, b)
a = "\t\tif rc := conn.SetMtu(permtu); !rc {\n\t\t\tpanic(rc)\n\t\t}\n"
rep(a, a + "\t\tscBenchTune(conn)\n")
b = "\tttConn := turbotunnel.NewQueuePacketConn(turbotunnel.DummyAddr{}, idleTimeout*2)\n"
rep(b, b + "\tscBenchSetTT(ttConn)\n")
rep("\tln, err := kcp.ServeConn(nil, 0, 0, ttConn)\n",
    "\tvar kcpConn net.PacketConn = ttConn\n\tif scDedupEnabled() {\n\t\tkcpConn = newSCDedupConn(ttConn)\n\t}\n\tln, err := kcp.ServeConn(nil, 0, 0, kcpConn)\n")
rep("\t\t\t\t\tttConn.Stash(p, rec.ClientID)\n",
    "\t\t\t\t\tif !ttConn.Stash(p, rec.ClientID) {\n\t\t\t\t\t\tscDedupSent(rec.ClientID, p)\n\t\t\t\t\t}\n")
rep("\t\t\t\tpayload.Write(p)\n", "\t\t\t\tpayload.Write(p)\n\t\t\t\tscDedupSent(rec.ClientID, p)\n")
rep("\t\t\t\t\tclientEdnsForget(cid)\n", "\t\t\t\t\tclientEdnsForget(cid)\n\t\t\t\t\tscDedupForget(cid)\n")
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
PY

cd "${OUT}/tree"
go vet -tags scbench ./dnstt-server
go build -tags scbench -trimpath -o "${OUT}/bin/dnstt-server${EXE}" ./dnstt-server
go build -trimpath -o "${OUT}/bin/dnstt-client${EXE}" ./dnstt-client
echo "build uji OK: ${OUT}/bin"

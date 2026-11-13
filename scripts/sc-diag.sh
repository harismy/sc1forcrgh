#!/usr/bin/env bash
# sc-diag.sh - Perekam diagnostik SC 1FORCR untuk VPS produksi.
#
# HANYA MEMBACA: /proc, cgroup, counter iptables (tanpa -Z), socket monitor
# SlowDNS, dan journal. Tidak me-restart service, tidak mengubah iptables,
# tidak menulis env, dan tidak memanggil daemon-reload.
#
# Yang direkam: CPU/RAM seluruh service yang jalan, beban VPS (steal, iowait,
# swap, tekanan PSI), dan detail SlowDNS (CPU per query, sesi, drop, keadaan
# macet). Tidak merekam username, IP klien, token, key, maupun domain.
#
# Pemakaian (sebagai root):
#   bash sc-diag.sh cek             ukur 10 detik, hasil langsung di layar
#   bash sc-diag.sh start [MENIT]   mulai rekam di latar (default 60, maks 1440)
#   bash sc-diag.sh status          lihat progres
#   bash sc-diag.sh stop            berhenti sekarang, susun ringkasan, kirim
#   bash sc-diag.sh kirim [DIR]     kirim ulang hasil ke bot notif
#
# Selesai merekam, ringkasan + arsip data dikirim ke bot notif VPS
# (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID milik SC). Hasil juga disimpan di
# /root/sc-diag/<waktu>/.
set -uo pipefail
export LC_ALL=C

UNIT_NAME="sc-1forcr-diag"
BASE_DIR="${DIAG_BASE_DIR:-/root/sc-diag}"
SLOWDNS_UNIT="sc-1forcr-slowdns.service"
SLOWDNS_BIN="${SLOWDNS_BIN_PATH:-/usr/local/lib/sc-1forcr/dnstt-server}"
SLOWDNS_SOCK="${SLOWDNS_SESSION_SOCKET:-/run/sc-1forcr-slowdns/sessions.sock}"
MAX_UNITS=45
MAX_EVENTS=10
# Tanda macet: CPU dnstt >= 60% satu core selama >= 30 detik dengan biaya
# >= 2 ms per jawaban (normalnya 70-180 mikrodetik). Jawaban dihitung dari
# counter OUTPUT sport SlowDNS; counter nat hanya menghitung flow baru, jadi
# dipakai kalau counter OUTPUT tidak ada.
STUCK_CPU_PCT=60
STUCK_USEC_PER_QUERY=2000

env_value() {
  local key="$1" file line value=""
  for file in /etc/sc-1forcr.env /opt/sc-1forcr/.env; do
    [[ -r "${file}" ]] || continue
    while IFS= read -r line || [[ -n "${line}" ]]; do
      [[ "${line}" == "${key}="* ]] || continue
      line="${line#*=}"
      line="${line%$'\r'}"
      line="${line#\"}"; line="${line%\"}"
      line="${line#\'}"; line="${line%\'}"
      [[ -n "${line}" ]] && value="${line}"
    done < "${file}"
  done
  printf '%s' "${value}"
}

now_epoch() { printf -v NOW '%(%s)T' -1; }

need_root() {
  [[ "${DIAG_ALLOW_NONROOT:-0}" == "1" ]] && return 0
  if [[ "$(id -u 2>/dev/null || echo 1)" != "0" ]]; then
    echo "Gagal: jalankan sebagai root."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Perekam
# ---------------------------------------------------------------------------

NAP_FD=""
STOP=0
nap() {
  local want="$1" before
  if [[ -z "${NAP_FD}" ]]; then
    sleep "${want}" 2>/dev/null || true
    return 0
  fi
  now_epoch; before="${NOW}"
  read -rt "${want}" -u "${NAP_FD}" _ 2>/dev/null || true
  (( STOP == 0 )) || return 0
  now_epoch
  if (( NOW - before < want )); then
    # read kembali terlalu cepat (fd tidak menahan): jangan pernah berputar
    # tanpa jeda di VPS produksi. Pindah ke sleep untuk seterusnya.
    NAP_FD=""
    sleep "$(( want - (NOW - before) ))" 2>/dev/null || true
  fi
  return 0
}

# pid_ticks PID -> T (utime+stime dalam tick), 0 kalau proses sudah hilang.
pid_ticks() {
  local l=""
  T=0
  { read -r l < "/proc/$1/stat"; } 2>/dev/null || return 0
  [[ -n "${l}" ]] || return 0
  l="${l##*) }"
  # shellcheck disable=SC2086
  set -- ${l}
  T=$(( ${12:-0} + ${13:-0} ))
}

CG_MODE="none"; CG_ROOT=""; CG1_CPU=""; CG1_MEM=""; CG1_PROCS=""
detect_cgroup() {
  if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
    CG_MODE="v2"; CG_ROOT="/sys/fs/cgroup"
    return 0
  fi
  local d
  for d in /sys/fs/cgroup/cpu,cpuacct /sys/fs/cgroup/cpuacct; do
    [[ -d "${d}" ]] && { CG1_CPU="${d}"; break; }
  done
  [[ -d /sys/fs/cgroup/memory ]] && CG1_MEM="/sys/fs/cgroup/memory"
  for d in /sys/fs/cgroup/unified /sys/fs/cgroup/systemd; do
    [[ -d "${d}" ]] && { CG1_PROCS="${d}"; break; }
  done
  [[ -n "${CG1_PROCS}" ]] && CG_MODE="v1"
  return 0
}

declare -a UNITS=() UNIT_CG=() UNIT_CPU_MODE=() UNIT_CPU_FILE=() UNIT_MEM_FILE=() UNIT_PROCS_FILE=()
DROPBEAR_PROCS_FILE=""
discover_units() {
  local u cg i=0
  command -v systemctl >/dev/null 2>&1 || return 0
  while read -r u _; do
    [[ "${u}" == *.service ]] || continue
    case "${u}" in
      "${UNIT_NAME}"*|user@*|getty@*|serial-getty@*|systemd-udevd*|systemd-logind*|systemd-timesyncd*|dbus*|polkit*|run-*) continue ;;
    esac
    (( i < MAX_UNITS )) || break
    cg="$(systemctl show -p ControlGroup --value "${u}" 2>/dev/null)" || cg=""
    [[ -n "${cg}" && "${cg}" != "/" ]] || continue
    UNITS[i]="${u%.service}"
    UNIT_CG[i]="${cg}"
    UNIT_CPU_MODE[i]="none"; UNIT_CPU_FILE[i]=""; UNIT_MEM_FILE[i]=""; UNIT_PROCS_FILE[i]=""
    if [[ "${CG_MODE}" == "v2" ]]; then
      UNIT_PROCS_FILE[i]="${CG_ROOT}${cg}/cgroup.procs"
      if [[ -r "${CG_ROOT}${cg}/cpu.stat" ]]; then
        UNIT_CPU_MODE[i]="v2"; UNIT_CPU_FILE[i]="${CG_ROOT}${cg}/cpu.stat"
      else
        UNIT_CPU_MODE[i]="procs"
      fi
      [[ -r "${CG_ROOT}${cg}/memory.current" ]] && UNIT_MEM_FILE[i]="${CG_ROOT}${cg}/memory.current"
    elif [[ "${CG_MODE}" == "v1" ]]; then
      UNIT_PROCS_FILE[i]="${CG1_PROCS}${cg}/cgroup.procs"
      if [[ -n "${CG1_CPU}" && -r "${CG1_CPU}${cg}/cpuacct.usage" ]]; then
        UNIT_CPU_MODE[i]="v1"; UNIT_CPU_FILE[i]="${CG1_CPU}${cg}/cpuacct.usage"
      else
        UNIT_CPU_MODE[i]="procs"
      fi
      [[ -n "${CG1_MEM}" && -r "${CG1_MEM}${cg}/memory.usage_in_bytes" ]] && UNIT_MEM_FILE[i]="${CG1_MEM}${cg}/memory.usage_in_bytes"
    fi
    [[ "${u}" == "dropbear.service" ]] && DROPBEAR_PROCS_FILE="${UNIT_PROCS_FILE[i]}"
    i=$(( i + 1 ))
  done < <(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null)
  return 0
}

# sample_unit IDX -> U_CPU (mikrodetik kumulatif), U_MEM (byte)
sample_unit() {
  local k="" v="" p sum=0
  U_CPU=""; U_MEM=""
  case "${UNIT_CPU_MODE[$1]}" in
    v2)
      { read -r k v < "${UNIT_CPU_FILE[$1]}"; } 2>/dev/null || true
      [[ "${k}" == "usage_usec" && "${v}" =~ ^[0-9]+$ ]] && U_CPU="${v}"
      ;;
    v1)
      { read -r v < "${UNIT_CPU_FILE[$1]}"; } 2>/dev/null || true
      [[ "${v}" =~ ^[0-9]+$ ]] && U_CPU=$(( v / 1000 ))
      ;;
    procs)
      if [[ -r "${UNIT_PROCS_FILE[$1]}" ]]; then
        while read -r p; do
          [[ "${p}" =~ ^[0-9]+$ ]] || continue
          pid_ticks "${p}"
          sum=$(( sum + T ))
        done < "${UNIT_PROCS_FILE[$1]}" 2>/dev/null
        U_CPU=$(( sum * USEC_PER_TICK ))
      fi
      ;;
  esac
  if [[ -n "${UNIT_MEM_FILE[$1]}" ]]; then
    { read -r v < "${UNIT_MEM_FILE[$1]}"; } 2>/dev/null || v=""
    [[ "${v}" =~ ^[0-9]+$ ]] && U_MEM="${v}"
  fi
  return 0
}

HAS_SLOWDNS=0; DNSTT_PID=0; DNSTT_PID_CHECKED=0; DNSTT_CG=""; LISTEN=5300
Q_P=0; Q_B=0; A_P=0; A_B=0
S_COUNT=0; S_CLIENTS=0; S_UP=0; S_RAW=""

refresh_dnstt_pid() {
  if (( DNSTT_PID > 0 )) && [[ -d "/proc/${DNSTT_PID}" ]]; then
    return 0
  fi
  DNSTT_PID=0
  (( NOW - DNSTT_PID_CHECKED >= 15 )) || return 0
  DNSTT_PID_CHECKED="${NOW}"
  local p
  p="$(systemctl show -p MainPID --value "${SLOWDNS_UNIT}" 2>/dev/null)" || p=""
  [[ "${p}" =~ ^[0-9]+$ ]] && DNSTT_PID="${p}"
  return 0
}

sample_slowdns_counters() {
  local p b tgt rest found=0 qp=0 qb=0
  while read -r p b tgt _; do
    if [[ "${tgt}" == "REDIRECT" && "${p}" =~ ^[0-9]+$ && "${b}" =~ ^[0-9]+$ ]]; then
      qp=$(( qp + p )); qb=$(( qb + b )); found=1
    fi
  done < <(iptables -w 2 -t nat -nvxL SC1FORCR_SLOWDNS 2>/dev/null)
  if (( found )); then Q_P="${qp}"; Q_B="${qb}"; fi
  while read -r p b rest; do
    if [[ "${rest}" == ACCEPT* && "${rest}" == *"spt:${LISTEN}"* && "${p}" =~ ^[0-9]+$ ]]; then
      A_P="${p}"; A_B="${b}"
      break
    fi
  done < <(iptables -w 2 -nvxL OUTPUT 2>/dev/null)
  return 0
}

read_sessions() {
  local a b c d
  local -A cids=()
  S_COUNT=0; S_CLIENTS=0; S_UP=0; S_RAW=""
  [[ -x "${SLOWDNS_BIN}" && -S "${SLOWDNS_SOCK}" ]] || return 0
  S_RAW="$(timeout 3 "${SLOWDNS_BIN}" -sc-online "${SLOWDNS_SOCK}" 2>/dev/null)" || S_RAW=""
  [[ -n "${S_RAW}" ]] || return 0
  while IFS='|' read -r a b c d; do
    [[ "${a}" =~ ^[0-9]+$ && "${b}" =~ ^[0-9a-f]{16}$ && "${c}" =~ ^[0-9]+$ ]] || continue
    S_COUNT=$(( S_COUNT + 1 ))
    S_UP=$(( S_UP + c ))
    cids["${b}"]=1
  done < <(printf '%s\n' "${S_RAW}")
  S_CLIENTS="${#cids[@]}"
  return 0
}

declare -a HIST_T=() HIST_K=() HIST_Q=()
SAMPLE_N=0; STUCK=0; EVENT_COUNT=0; LAST_EVENT=0
CUR_CPU_PCT=0; CUR_QPS=0

dnstt_thread_ticks() {
  local f l
  for f in "/proc/${DNSTT_PID}/task"/*/stat; do
    { read -r l < "${f}"; } 2>/dev/null || continue
    l="${l##*) }"
    # shellcheck disable=SC2086
    set -- ${l}
    f="${f%/stat}"
    printf '%s %s\n' "${f##*/}" "$(( ${12:-0} + ${13:-0} ))"
  done
}

dump_event() {
  local out="${DIR}/kejadian-macet.log" k v
  {
    echo "=================================================================="
    echo "MACET epoch=${NOW} waktu=$(TZ=Asia/Jakarta date '+%F %T WIB' 2>/dev/null) pid=${DNSTT_PID}"
    echo "cpu_dnstt=${CUR_CPU_PCT}% (satu core, 30 detik terakhir) jawaban_per_detik=${CUR_QPS}"
    echo "--- status proses"
    while read -r k v _; do
      case "${k}" in VmRSS:|VmSwap:|VmHWM:|Threads:|voluntary_ctxt_switches:|nonvoluntary_ctxt_switches:) echo "${k} ${v}" ;; esac
    done < "/proc/${DNSTT_PID}/status"
    echo "--- io (dua kali, jeda 2 detik; syscr/syscw = jumlah syscall baca/tulis)"
    grep -E '^(syscr|syscw)' "/proc/${DNSTT_PID}/io"
    echo "--- tick per thread (dua kali, jeda 2 detik)"
    dnstt_thread_ticks > "${DIR}/.thr1"
    sleep 2
    dnstt_thread_ticks > "${DIR}/.thr2"
    grep -E '^(syscr|syscw)' "/proc/${DNSTT_PID}/io"
    awk 'NR==FNR {a[$1]=$2; next} { d=$2-a[$1]; if (d>0) printf "thread %s +%d tick\n", $1, d; n++ } END { printf "jumlah thread %d\n", n }' \
      "${DIR}/.thr1" "${DIR}/.thr2"
    rm -f "${DIR}/.thr1" "${DIR}/.thr2"
    if [[ -n "${DNSTT_CG}" ]]; then
      echo "--- memory.events"
      cat "${DNSTT_CG}/memory.events"
      echo "--- memory.stat (sebagian)"
      grep -E '^(anon|file|kernel_stack|slab|sock|pgfault|pgmajfault|swapcached) ' "${DNSTT_CG}/memory.stat"
      echo "--- memory.current / swap"
      cat "${DNSTT_CG}/memory.current" "${DNSTT_CG}/memory.swap.current"
    fi
    echo "--- socket UDP dnstt (skmem: rb=buffer, d=drop)"
    ss -Hlunm "sport = :${LISTEN}"
    read_sessions
    echo "--- sesi (port|clientid|byte_upload|mulai_ns): ${S_COUNT} stream, ${S_CLIENTS} klien"
    printf '%s\n' "${S_RAW}"
    echo "--- koneksi loopback milik dnstt ke Dropbear"
    ss -Htnp state established 2>/dev/null | grep -c "pid=${DNSTT_PID}," || true
    # Fungsi yang makan CPU saat macet. Hanya kalau perf terpasang; perf
    # report yang kehabisan memori hanya membunuh perf (OOMPolicy=continue).
    if command -v perf >/dev/null 2>&1; then
      echo "--- perf 10 detik (fungsi pemakan CPU dnstt, 1% ke atas)"
      rm -f "${DIR}/.perf.data" "${DIR}/.perf.data.old"
      if timeout 30 perf record -q -N -F 49 -p "${DNSTT_PID}" -o "${DIR}/.perf.data" -- sleep 10 >/dev/null 2>&1 \
          && [[ -s "${DIR}/.perf.data" ]]; then
        timeout 120 perf report -i "${DIR}/.perf.data" --stdio --no-children --sort symbol --percent-limit 1 2>/dev/null \
          | grep -vE '^(#|[[:space:]]*$)' | head -40
      else
        echo "perf record gagal"
      fi
      rm -f "${DIR}/.perf.data" "${DIR}/.perf.data.old"
    fi
  } >> "${out}" 2>&1
  return 0
}

check_stuck() {
  local idx w old dt dk dq qv="${Q_P}"
  STUCK=0; CUR_CPU_PCT=0; CUR_QPS=0
  (( A_P > 0 )) && qv="${A_P}"
  idx="${SAMPLE_N}"
  HIST_T[idx]="${NOW}"; HIST_K[idx]="${D_TICKS}"; HIST_Q[idx]="${qv}"
  w=$(( (30 + INTERVAL - 1) / INTERVAL ))
  old=$(( idx - w ))
  if (( old >= 0 )) && (( DNSTT_PID > 0 )); then
    dt=$(( NOW - HIST_T[old] ))
    dk=$(( D_TICKS - HIST_K[old] ))
    dq=$(( qv - HIST_Q[old] ))
    if (( dt > 0 && dk >= 0 && dq >= 0 )); then
      CUR_CPU_PCT=$(( dk * 100 / CLK_TCK / dt ))
      CUR_QPS=$(( dq / dt ))
      if (( CUR_CPU_PCT >= STUCK_CPU_PCT )); then
        if (( dq == 0 )) || (( dk * USEC_PER_TICK / dq >= STUCK_USEC_PER_QUERY )); then
          STUCK=1
        fi
      fi
    fi
    unset "HIST_T[old]" "HIST_K[old]" "HIST_Q[old]"
  fi
  if (( STUCK )) && (( EVENT_COUNT < MAX_EVENTS )) && (( NOW - LAST_EVENT >= 120 )); then
    EVENT_COUNT=$(( EVENT_COUNT + 1 )); LAST_EVENT="${NOW}"
    dump_event
  fi
  return 0
}

take_sample() {
  local line k v a b c d e f g h rest i
  local cu=0 cn=0 cs=0 ci=0 cw=0 cq=0 csq=0 cst=0
  local load1="" memavail="" swapfree="" pswpin="" pswpout=""
  local psi_cpu="" psi_mem="" psi_memfull="" psi_io=""
  local rx=0 tx=0 udp_in="" udp_err="" udp_rcvbuf="" tcp_inuse="" conntrack=""

  { read -r _ cu cn cs ci cw cq csq cst _ < /proc/stat; } 2>/dev/null || true
  { read -r load1 _ < /proc/loadavg; } 2>/dev/null || true
  while read -r k v _; do
    case "${k}" in
      MemAvailable:) memavail="${v}" ;;
      SwapFree:) swapfree="${v}"; break ;;
    esac
  done 2>/dev/null < /proc/meminfo
  while read -r k v; do
    case "${k}" in
      pswpin) pswpin="${v}" ;;
      pswpout) pswpout="${v}"; break ;;
    esac
  done 2>/dev/null < /proc/vmstat
  if [[ -r /proc/pressure/cpu ]]; then
    { read -r _ _ _ _ v < /proc/pressure/cpu; } 2>/dev/null && psi_cpu="${v#total=}"
    { read -r _ _ _ _ v < /proc/pressure/io; } 2>/dev/null && psi_io="${v#total=}"
    while read -r k _ _ _ v; do
      case "${k}" in
        some) psi_mem="${v#total=}" ;;
        full) psi_memfull="${v#total=}" ;;
      esac
    done 2>/dev/null < /proc/pressure/memory
  fi
  while IFS= read -r line; do
    [[ "${line}" == *:* ]] || continue
    line="${line/:/ }"
    # shellcheck disable=SC2086
    set -- ${line}
    [[ "${1:-}" == "lo" || -z "${10:-}" ]] && continue
    rx=$(( rx + ${2:-0} )); tx=$(( tx + ${10:-0} ))
  done 2>/dev/null < /proc/net/dev
  while read -r a b c d e f _; do
    if [[ "${a}" == "Udp:" && "${b}" =~ ^[0-9]+$ ]]; then
      udp_in="${b}"; udp_err="${d}"; udp_rcvbuf="${f}"
      break
    fi
  done 2>/dev/null < /proc/net/snmp
  while read -r a b c _; do
    if [[ "${a}" == "TCP:" ]]; then tcp_inuse="${c}"; break; fi
  done 2>/dev/null < /proc/net/sockstat
  { read -r conntrack < /proc/sys/net/netfilter/nf_conntrack_count; } 2>/dev/null || conntrack=""

  D_TICKS=0; D_RSS=0; D_SWAP=0; D_THR=0
  local d_cgmem="" d_cgswap="" d_evmax="" d_evoom=""
  if (( HAS_SLOWDNS )); then
    refresh_dnstt_pid
    if (( DNSTT_PID > 0 )); then
      pid_ticks "${DNSTT_PID}"; D_TICKS="${T}"
      {
        while read -r k v _; do
          case "${k}" in
            VmRSS:) D_RSS="${v}" ;;
            VmSwap:) D_SWAP="${v}" ;;
            Threads:) D_THR="${v}"; break ;;
          esac
        done < "/proc/${DNSTT_PID}/status"
      } 2>/dev/null
      if [[ -n "${DNSTT_CG}" ]]; then
        { read -r d_cgmem < "${DNSTT_CG}/memory.current"; } 2>/dev/null || true
        { read -r d_cgswap < "${DNSTT_CG}/memory.swap.current"; } 2>/dev/null || true
        {
          while read -r k v; do
            case "${k}" in max) d_evmax="${v}" ;; oom_kill) d_evoom="${v}" ;; esac
          done < "${DNSTT_CG}/memory.events"
        } 2>/dev/null
      fi
    fi
    sample_slowdns_counters
    check_stuck
  fi

  line="${NOW},${cu},${cn},${cs},${ci},${cw},${cq},${csq},${cst},${load1},${memavail},${swapfree},${pswpin},${pswpout}"
  line+=",${psi_cpu},${psi_mem},${psi_memfull},${psi_io},${rx},${tx},${udp_in},${udp_err},${udp_rcvbuf},${tcp_inuse},${conntrack}"
  line+=",${DNSTT_PID},${D_TICKS},${D_RSS},${D_SWAP},${D_THR},${d_cgmem},${d_cgswap},${d_evmax},${d_evoom}"
  line+=",${Q_P},${Q_B},${A_P},${A_B},${STUCK}"
  for (( i = 0; i < ${#UNITS[@]}; i++ )); do
    sample_unit "${i}"
    line+=",${U_CPU},${U_MEM}"
  done
  pid_ticks "$$"
  line+=",${T}"
  printf '%s\n' "${line}" >> "${DIR}/sampel.csv"
  SAMPLE_N=$(( SAMPLE_N + 1 ))
  return 0
}

MINUTE_N=0
take_minute() {
  local syscr="" syscw="" ctx=0 dprocs="" drops="" fds="" k v f n out
  local -a arr=()
  if (( HAS_SLOWDNS )) && (( DNSTT_PID > 0 )); then
    read_sessions
    {
      while read -r k v; do
        case "${k}" in syscr:) syscr="${v}" ;; syscw:) syscw="${v}" ;; esac
      done < "/proc/${DNSTT_PID}/io"
    } 2>/dev/null
    for f in "/proc/${DNSTT_PID}/task"/*/schedstat; do
      { read -r _ _ n < "${f}"; } 2>/dev/null || continue
      [[ "${n}" =~ ^[0-9]+$ ]] && ctx=$(( ctx + n ))
    done
    arr=( "/proc/${DNSTT_PID}/fd"/* )
    fds="${#arr[@]}"
    out="$(ss -Hlunm "sport = :${LISTEN}" 2>/dev/null)" || out=""
    if [[ "${out}" =~ ,d([0-9]+)\) ]]; then drops="${BASH_REMATCH[1]}"; fi
    if (( MINUTE_N % 5 == 0 )) && [[ -n "${S_RAW}" ]]; then
      { echo "# epoch=${NOW}"; printf '%s\n' "${S_RAW}"; } >> "${DIR}/sesi.log"
    fi
  fi
  if [[ -n "${DROPBEAR_PROCS_FILE}" && -r "${DROPBEAR_PROCS_FILE}" ]]; then
    mapfile -t arr < "${DROPBEAR_PROCS_FILE}" 2>/dev/null || arr=()
    dprocs="${#arr[@]}"
  fi
  printf '%s\n' "${NOW},${S_COUNT},${S_CLIENTS},${S_UP},${syscr},${syscw},${ctx},${dprocs},${drops},${fds},${Q_P}" >> "${DIR}/menit.csv"
  MINUTE_N=$(( MINUTE_N + 1 ))
  return 0
}

write_info() {
  local label="$1"
  {
    echo "===== ${label}: $(TZ=Asia/Jakarta date '+%F %T WIB' 2>/dev/null) ====="
    echo "kernel: $(uname -r 2>/dev/null)"
    grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null
    echo "core: $(nproc 2>/dev/null)  clk_tck: ${CLK_TCK}  cgroup: ${CG_MODE}  interval: ${INTERVAL}s"
    echo "uptime: $(uptime 2>/dev/null)"
    echo "--- memori"
    grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
    echo "--- disk"
    df -h / /var /tmp 2>/dev/null
    echo "--- setelan SC (tanpa token/key/domain)"
    grep -hE '^(SCRIPT_VERSION|SC_VERSION|SLOWDNS_[A-Z0-9_]*|UDP_BACKEND|SERVICE_[A-Z]*_ENABLE|XRAY_[A-Z_]*_ENABLE|RESOURCE_[A-Z_]*|SSHWS_[A-Z_]*|HAPROXY_MAXCONN|HAPROXY_NBTHREAD|NGINX_WORKER_CONNECTIONS|SC_API_MEMORY_MAX|IPLIMIT_[A-Z_]*|AUTO_REBOOT[A-Z_]*)=' \
      /etc/sc-1forcr.env 2>/dev/null | grep -vE 'TOKEN|KEY|SECRET|PASS|DOMAIN|_NS=|URL|HOST|SHA' | sort -u
    echo "--- unit SlowDNS"
    systemctl show "${SLOWDNS_UNIT}" -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp -p MemoryMax -p MemoryCurrent -p TasksCurrent -p Environment 2>/dev/null \
      | sed -E 's/(SOCKET|KEY|TOKEN)=[^ ]*/\1=***/g'
    echo "--- socket UDP dnstt"
    ss -Hlunm "sport = :${LISTEN}" 2>/dev/null
    echo "--- ringkasan socket"
    ss -s 2>/dev/null
    echo "--- sysctl"
    sysctl net.core.rmem_max net.core.rmem_default net.core.wmem_max net.core.netdev_max_backlog vm.swappiness net.netfilter.nf_conntrack_max 2>/dev/null
    echo "--- conntrack (hex per CPU; kolom drop/early_drop/insert_failed naik = tabel penuh)"
    echo "count=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null) max=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null) hashsize=$(cat /sys/module/nf_conntrack/parameters/hashsize 2>/dev/null)"
    sysctl net.netfilter.nf_conntrack_udp_timeout net.netfilter.nf_conntrack_udp_timeout_stream net.netfilter.nf_conntrack_tcp_timeout_established 2>/dev/null
    cat /proc/net/stat/nf_conntrack 2>/dev/null
    echo "--- jumlah rule iptables"
    echo "filter+nat+mangle: $(iptables-save 2>/dev/null | grep -c '^-A')"
    echo "--- 20 proses RSS terbesar (pid rss_kb cpu% umur nama)"
    ps -eo pid,rss,pcpu,etime,comm --sort=-rss 2>/dev/null | head -21
    echo "--- jumlah proses per nama (10 teratas)"
    ps -eo comm= 2>/dev/null | sort | uniq -c | sort -rn | head -10
    echo "--- timer"
    systemctl list-timers --all --no-pager 2>/dev/null | head -40
    echo "--- unit gagal"
    systemctl --failed --no-legend --no-pager 2>/dev/null
    echo
  } >> "${DIR}/info.txt" 2>&1
  return 0
}

write_journal_summary() {
  local since="@${START_AT}"
  {
    echo "===== Journal sejak rekam dimulai ====="
    echo "--- pesan SlowDNS terbanyak (angka disamarkan jadi #)"
    journalctl -u "${SLOWDNS_UNIT}" --since "${since}" --no-pager -o cat 2>/dev/null \
      | sed -E 's/[0-9a-f]{8,}/#/g; s/[0-9]+/#/g' | cut -c1-140 | sort | uniq -c | sort -rn | head -15
    echo "--- restart/kill service (systemd)"
    journalctl --since "${since}" --no-pager -o short-iso _PID=1 2>/dev/null \
      | grep -E 'Main process exited|Failed with result|Scheduled restart job|oom-kill|Out of memory' | sed -E 's/^([^ ]+) [^ ]+ /\1 /' | tail -40
    echo "--- OOM kernel"
    journalctl -k --since "${since}" --no-pager -o short-iso 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' | tail -10
    echo "--- conntrack penuh (kernel)"
    echo "baris 'table full, dropping packet': $(journalctl -k --since "${since}" --no-pager -o cat 2>/dev/null | grep -c 'table full')"
    echo "--- watchdog SC"
    journalctl -t sc-1forcr-postboot --since "${since}" --no-pager -o short-iso 2>/dev/null | sed -E 's/^([^ ]+) [^ ]+ /\1 /' | tail -20
  } > "${DIR}/journal.txt" 2>&1
  # CPU yang dipakai job berkala (oneshot), dari baris "Consumed ... CPU time".
  journalctl --since "${since}" --no-pager -o cat _PID=1 2>/dev/null \
    | awk '
      / Consumed .* CPU time/ {
        unit=$1; sub(/:$/, "", unit)
        sec=0
        for (i=3; i<=NF; i++) {
          v=$i
          if (v == "CPU") break
          if (v ~ /^[0-9.]+ms$/) { sub(/ms$/, "", v); sec += v/1000 }
          else if (v ~ /^[0-9.]+min$/) { sub(/min$/, "", v); sec += v*60 }
          else if (v ~ /^[0-9.]+h$/) { sub(/h$/, "", v); sec += v*3600 }
          else if (v ~ /^[0-9.]+s$/) { sub(/s$/, "", v); sec += v }
        }
        total[unit] += sec; runs[unit]++
      }
      END { for (u in total) printf "%.1f|%d|%s\n", total[u], runs[u], u }
    ' | sort -t'|' -k1,1 -rn | head -12 > "${DIR}/job-berkala.txt" 2>/dev/null
  return 0
}

# ---------------------------------------------------------------------------
# Ringkasan
# ---------------------------------------------------------------------------

summarize() {
  local dir="$1" clk ncpu
  clk="$(sed -n 's/^clk_tck=//p' "${dir}/meta" 2>/dev/null | head -n1)"
  ncpu="$(sed -n 's/^ncpu=//p' "${dir}/meta" 2>/dev/null | head -n1)"
  [[ "${clk}" =~ ^[0-9]+$ ]] || clk=100
  [[ "${ncpu}" =~ ^[0-9]+$ ]] || ncpu=1
  local ctlimit
  ctlimit="$(sed -n 's/^ctmax=//p' "${dir}/meta" 2>/dev/null | head -n1)"
  [[ "${ctlimit}" =~ ^[0-9]+$ ]] || ctlimit=0
  {
    echo "DIAGNOSTIK SC 1FORCR"
    sed -n 's/^label=//p' "${dir}/meta" 2>/dev/null | head -n1
    [[ -s "${dir}/sampel.csv" ]] && awk -F, -v CLK="${clk}" -v NCPU="${ncpu}" -v CTLIMIT="${ctlimit}" '
      function col(name) { return (name in c) ? $(c[name]) : "" }
      NR == 1 {
        for (i = 1; i <= NF; i++) c[$i] = i
        for (i = 1; i <= NF; i++) if ($i ~ /^cpu:/) { nu++; uname[nu] = substr($i, 5); ucpu[nu] = i; umem[nu] = c["mem:" substr($i, 5)] }
        next
      }
      {
        n++
        t = col("epoch") + 0
        tot = col("cpu_user") + col("cpu_nice") + col("cpu_sys") + col("cpu_idle") + col("cpu_iowait") + col("cpu_irq") + col("cpu_softirq") + col("cpu_steal")
        idle = col("cpu_idle") + col("cpu_iowait")
        if (n == 1) {
          t0 = t; tot0 = tot; idle0 = idle; steal0 = col("cpu_steal"); iow0 = col("cpu_iowait"); sirq0 = col("cpu_softirq")
          swin0 = col("pswpin"); swout0 = col("pswpout"); rx0 = col("net_rx"); tx0 = col("net_tx")
          pc0 = col("psi_cpu"); pm0 = col("psi_mem"); pmf0 = col("psi_memfull"); pio0 = col("psi_io")
          uerr0 = col("udp_inerr"); urb0 = col("udp_rcvbuf"); ev0 = col("dnstt_evmax"); self0 = col("self_ticks")
          memmin = col("mem_avail_kb") + 0; swapmin = col("swap_free_kb") + 0
          rssmin = col("dnstt_rss_kb") + 0
        } else {
          dt = t - pt
          if (dt > 0) {
            dtot = tot - ptot
            if (dtot > 0) {
              busy = 100 * (1 - (idle - pidle) / dtot)
              if (busy > busymax) busymax = busy
              if (busy >= 85) hot += dt
            }
            pid = col("dnstt_pid") + 0
            if (pid > 0 && ppid > 0 && pid != ppid) restarts++
            dk = col("dnstt_ticks") - pk; dq = col("q_pkts") - pq
            if (pid > 0 && pid == ppid && dk >= 0 && dq >= 0) {
              sdt += dt; sdk += dk; sdq += dq
              dqb = col("q_bytes") - pqb; dap = col("a_pkts") - pap; dab = col("a_bytes") - pab
              if (dqb > 0) sqb += dqb
              if (dap > 0) sap += dap
              if (dab > 0) sab += dab
              pct = dk * 100 / CLK / dt; qps = dq / dt
              if (pct > dmax) dmax = pct
              if (qps > qmax) qmax = qps
              if (pct >= 60) dhot += dt
              b = (qps < 20) ? 1 : (qps < 200) ? 2 : (qps < 1000) ? 3 : 4
              bt[b] += dt; bk[b] += dk; bq[b] += dq
            }
            if (col("stuck") + 0 == 1) stuck += dt
            for (u = 1; u <= nu; u++) {
              v = $(ucpu[u])
              if (v != "") {
                if (uhas[u]) { d = v - uprev[u]; if (d > 0) { usum[u] += d; p = d / 10000 / dt; if (p > umax[u]) umax[u] = p } }
                uprev[u] = v; uhas[u] = 1
              }
            }
          }
        }
        for (u = 1; u <= nu; u++) {
          if (umem[u] != "") { m = $(umem[u]); if (m != "") { mn[u]++; ms[u] += m; if (m > mm[u]) mm[u] = m } }
        }
        v = col("mem_avail_kb") + 0; if (v < memmin) memmin = v
        v = col("swap_free_kb") + 0; if (v < swapmin) swapmin = v
        v = col("dnstt_rss_kb") + 0; if (v > rssmax) rssmax = v; if (v > 0 && (rssmin == 0 || v < rssmin)) rssmin = v
        v = col("dnstt_swap_kb") + 0; if (v > dswapmax) dswapmax = v
        v = col("load1") + 0; if (v > loadmax) loadmax = v; loadsum += v
        v = col("tcp_inuse") + 0; if (v > tcpmax) tcpmax = v; tcpsum += v
        v = col("conntrack") + 0; if (v > ctmax) ctmax = v
        if (CTLIMIT > 0 && v >= CTLIMIT * 0.98) ctfull++
        pt = t; ptot = tot; pidle = idle; ppid = col("dnstt_pid") + 0
        pk = col("dnstt_ticks"); pq = col("q_pkts"); pqb = col("q_bytes"); pap = col("a_pkts"); pab = col("a_bytes")
        steal1 = col("cpu_steal"); iow1 = col("cpu_iowait"); sirq1 = col("cpu_softirq")
        swin1 = col("pswpin"); swout1 = col("pswpout"); rx1 = col("net_rx"); tx1 = col("net_tx")
        pc1 = col("psi_cpu"); pm1 = col("psi_mem"); pmf1 = col("psi_memfull"); pio1 = col("psi_io")
        uerr1 = col("udp_inerr"); urb1 = col("udp_rcvbuf"); ev1 = col("dnstt_evmax"); self1 = col("self_ticks")
      }
      END {
        dur = pt - t0
        if (n < 2 || dur <= 0) { print "Data sampel belum cukup."; exit }
        dtot = ptot - tot0
        printf "Durasi %d menit, %d sampel, %d core\n\n", dur / 60, n, NCPU
        print "[VPS]"
        if (dtot > 0) {
          printf "CPU rata %.1f%% maks %.0f%% (dari semua core), waktu >=85%%: %.1f%%\n", 100 * (1 - (pidle - idle0) / dtot), busymax, 100 * hot / dur
          printf "steal %.1f%%  iowait %.1f%%  softirq %.1f%%\n", 100 * (steal1 - steal0) / dtot, 100 * (iow1 - iow0) / dtot, 100 * (sirq1 - sirq0) / dtot
        }
        printf "load rata %.2f maks %.2f\n", loadsum / n, loadmax
        printf "RAM tersedia min %d MiB, swap bebas min %d MiB\n", memmin / 1024, swapmin / 1024
        printf "swap masuk %d hal, keluar %d hal\n", swin1 - swin0, swout1 - swout0
        if (pc1 != "") printf "tekanan (PSI, %% waktu tertahan): cpu %.1f  mem %.2f (penuh %.2f)  io %.2f\n", (pc1 - pc0) / 10000 / dur, (pm1 - pm0) / 10000 / dur, (pmf1 - pmf0) / 10000 / dur, (pio1 - pio0) / 10000 / dur
        printf "trafik rata: masuk %.2f Mbps, keluar %.2f Mbps\n", (rx1 - rx0) * 8 / dur / 1e6, (tx1 - tx0) * 8 / dur / 1e6
        printf "socket TCP rata %d maks %d, conntrack maks %d\n", tcpsum / n, tcpmax, ctmax
        if (CTLIMIT > 0) printf "CONNTRACK PENUH (>=98%% dari %d): %.1f%% waktu\n", CTLIMIT, 100 * ctfull / n
        printf "drop UDP seluruh VPS: %d (buffer penuh %d)\n", uerr1 - uerr0, urb1 - urb0
        printf "biaya perekam ini: %.2f%% satu core\n", (self1 - self0) * 100 / CLK / dur
        print ""
        print "[SERVICE] CPU% satu core (rata/maks), RAM MiB (rata/maks)"
        for (k = 1; k <= 14 && k <= nu; k++) {
          best = 0
          for (u = 1; u <= nu; u++) if (!done[u] && (best == 0 || usum[u] > usum[best])) best = u
          if (best == 0) break
          done[best] = 1
          if (usum[best] <= 0 && mm[best] < 8 * 1048576) continue
          printf "%-22s %5.1f /%4.0f   %4d /%4d\n", substr(uname[best], 1, 22), usum[best] / 10000 / dur, umax[best], (mn[best] ? ms[best] / mn[best] / 1048576 : 0), mm[best] / 1048576
          known += usum[best]
        }
        for (u = 1; u <= nu; u++) allu += usum[u]
        if (dtot > 0) printf "semua service %.1f%%, di luar service (kernel/job/lainnya) %.1f%% satu core\n", allu / 10000 / dur, ((ptot - tot0) - (pidle - idle0)) * 100 / CLK / dur - allu / 10000 / dur
        if (sdt > 0) {
          print ""
          print "[SLOWDNS]"
          printf "CPU rata %.1f%% maks %.0f%% satu core, waktu >=60%%: %.1f%%\n", sdk * 100 / CLK / sdt, dmax, 100 * dhot / sdt
          printf "flow query baru rata %.0f/dtk maks %.0f/dtk, jawaban terkirim rata %.0f/dtk\n", sdq / sdt, qmax, sap / sdt
          if (sap > 0) printf "biaya %.0f mikrodetik per jawaban (angka per query di bawah dihitung dari flow baru, jadi terlalu tinggi)\n", sdk * 1e6 / CLK / sap
          if (sdq > 0) printf "biaya %.0f mikrodetik/query, query rata %d B, jawaban rata %d B\n", sdk * 1e6 / CLK / sdq, sqb / sdq, (sap > 0 ? sab / sap : 0)
          printf "RSS %d..%d MiB, swap maks %d MiB, mentok MemoryMax +%d kali, restart %d kali\n", rssmin / 1024, rssmax / 1024, dswapmax / 1024, ev1 - ev0, restarts
          printf "KEADAAN MACET: %d detik (%.1f%% waktu)\n", stuck, 100 * stuck / dur
          print "per tingkat beban (query/dtk): %waktu | CPU% | mikrodetik/query"
          split("<20|20-200|200-1000|>=1000", bn, "|")
          for (b = 1; b <= 4; b++) if (bt[b] > 0) printf "  %-9s %5.1f%% | %5.1f%% | %s\n", bn[b], 100 * bt[b] / sdt, bk[b] * 100 / CLK / bt[b], (bq[b] > 0 ? sprintf("%.0f", bk[b] * 1e6 / CLK / bq[b]) : "-")
        }
      }
    ' "${dir}/sampel.csv"
    [[ -s "${dir}/menit.csv" ]] && awk -F, '
      NR == 1 { next }
      {
        n++
        if ($2 + 0 > smax) smax = $2 + 0; ssum += $2
        if ($3 + 0 > cmax) cmax = $3 + 0; csum += $3
        if ($8 + 0 > dmax) dmax = $8 + 0; dsum += $8
        if ($5 != "" && $11 != "") {
          if (has && $5 >= pr && $6 >= pw && $11 >= pq && $7 >= pc) { sys += ($5 - pr) + ($6 - pw); q += $11 - pq; ctx += $7 - pc }
          pr = $5; pw = $6; pq = $11; pc = $7; has = 1
        }
        if ($9 != "") { if (!hasd) { d0 = $9; hasd = 1 } d1 = $9 }
        if ($10 + 0 > fmax) fmax = $10 + 0
      }
      END {
        if (n == 0) exit
        if (smax > 0 || q > 0) {
          printf "stream rata %d maks %d, klien (ClientID) rata %d maks %d\n", ssum / n, smax, csum / n, cmax
          if (q > 0) printf "syscall baca+tulis %.1f per query, ganti konteks %.1f per query\n", sys / q, ctx / q
          if (hasd) printf "drop di socket dnstt: %d, fd maks %d\n", d1 - d0, fmax
        }
        if (dmax > 0) printf "\n[SSH] proses Dropbear rata %d maks %d\n", dsum / n, dmax
      }
    ' "${dir}/menit.csv"
    if [[ -s "${dir}/kejadian-macet.log" ]]; then
      echo "kejadian macet terekam: $(grep -c '^MACET ' "${dir}/kejadian-macet.log") (detail di arsip)"
    fi
    if [[ -s "${dir}/job-berkala.txt" ]]; then
      echo
      echo "[JOB BERKALA] detik CPU | jumlah jalan"
      awk -F'|' '{ printf "%-30s %7.1f | %d\n", substr($3, 1, 30), $1, $2 }' "${dir}/job-berkala.txt" | head -8
    fi
  } > "${dir}/ringkasan.txt" 2>&1
  return 0
}

send_telegram() {
  local dir="$1" token chat api resp code opt ok=0 archive
  archive="${dir}.tar.gz"
  token="$(env_value TELEGRAM_BOT_TOKEN)"; token="${token//[[:space:]]/}"
  chat="$(env_value TELEGRAM_CHAT_ID)"; chat="${chat//[[:space:]]/}"
  if [[ -z "${token}" || -z "${chat}" ]]; then
    echo "Peringatan: bot notif belum diatur (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID). Hasil ada di ${dir}"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "Peringatan: curl tidak ada. Hasil ada di ${dir}"
    return 1
  fi
  api="https://api.telegram.org/bot${token}"
  resp="$(mktemp)"
  head -c 3900 "${dir}/ringkasan.txt" > "${dir}/.pesan" 2>/dev/null || true
  for opt in "" "-4"; do
    # shellcheck disable=SC2086
    code="$(curl ${opt} --http1.1 -sS --connect-timeout 10 --max-time 60 -o "${resp}" -w '%{http_code}' \
      -X POST "${api}/sendMessage" --data-urlencode "chat_id=${chat}" \
      --data-urlencode "text@${dir}/.pesan" 2>/dev/null)" || true
    if [[ "${code}" == "200" ]]; then ok=1; break; fi
  done
  rm -f "${dir}/.pesan"
  if (( ok == 0 )); then
    echo "Gagal kirim ringkasan ke Telegram (HTTP ${code:-000}). Hasil ada di ${dir}"
    rm -f "${resp}"
    return 1
  fi
  ok=0
  if [[ -s "${archive}" ]]; then
    for opt in "" "-4"; do
      # shellcheck disable=SC2086
      code="$(curl ${opt} --http1.1 -sS --connect-timeout 10 --max-time 240 -o "${resp}" -w '%{http_code}' \
        -X POST "${api}/sendDocument" -F "chat_id=${chat}" \
        -F "caption=Data diagnostik SC 1FORCR (kirim file ini ke Claude untuk dianalisis)" \
        -F "document=@${archive}" 2>/dev/null)" || true
      if [[ "${code}" == "200" ]]; then ok=1; break; fi
    done
  fi
  rm -f "${resp}"
  if (( ok == 0 )); then
    echo "Peringatan: ringkasan terkirim, arsip gagal dikirim (HTTP ${code:-000}). Arsip: ${archive}"
    return 1
  fi
  echo "Berhasil: ringkasan dan arsip terkirim ke bot notif."
  return 0
}

FINALIZED=0
finalize() {
  (( FINALIZED == 0 )) || return 0
  FINALIZED=1
  now_epoch
  write_info "AKHIR"
  write_journal_summary
  summarize "${DIR}"
  rm -f "${BASE_DIR}/berjalan"
  tar -czf "${DIR}.tar.gz" -C "${BASE_DIR}" "${DIR##*/}" 2>/dev/null || true
  send_telegram "${DIR}" >> "${DIR}/kirim.log" 2>&1 || true
  return 0
}

STOP=0
cmd_run() {
  local minutes="$1" header i next wait last_minute=0
  need_root
  mkdir -p "${BASE_DIR}"
  now_epoch
  START_AT="${NOW}"
  END_AT=$(( NOW + minutes * 60 ))
  INTERVAL="${DIAG_INTERVAL:-}"
  if [[ ! "${INTERVAL}" =~ ^[0-9]+$ ]] || (( INTERVAL < 2 || INTERVAL > 60 )); then
    if (( minutes > 180 )); then INTERVAL=10; else INTERVAL=5; fi
  fi
  DIR="${BASE_DIR}/$(TZ=Asia/Jakarta date '+%Y%m%d-%H%M%S')"
  mkdir -p "${DIR}"
  chmod 700 "${BASE_DIR}" "${DIR}" 2>/dev/null || true
  printf '%s\n' "${DIR}" > "${BASE_DIR}/berjalan"

  CLK_TCK="$(getconf CLK_TCK 2>/dev/null || echo 100)"
  [[ "${CLK_TCK}" =~ ^[0-9]+$ ]] && (( CLK_TCK > 0 )) || CLK_TCK=100
  USEC_PER_TICK=$(( 1000000 / CLK_TCK ))
  {
    echo "clk_tck=${CLK_TCK}"
    echo "ncpu=$(nproc 2>/dev/null || echo 1)"
    echo "start=${START_AT}"
    echo "minutes=${minutes}"
    echo "interval=${INTERVAL}"
    echo "ctmax=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null)"
    echo "label=Mulai $(TZ=Asia/Jakarta date '+%d-%m-%Y %H:%M WIB'), rencana ${minutes} menit"
  } > "${DIR}/meta"

  detect_cgroup
  discover_units
  LISTEN="$(env_value SLOWDNS_LISTEN_PORT)"
  [[ "${LISTEN}" =~ ^[0-9]+$ ]] || LISTEN=5300
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "${SLOWDNS_UNIT}" 2>/dev/null; then
    HAS_SLOWDNS=1
    refresh_dnstt_pid
    if [[ "${CG_MODE}" == "v2" ]]; then
      local cg
      cg="$(systemctl show -p ControlGroup --value "${SLOWDNS_UNIT}" 2>/dev/null)" || cg=""
      [[ -n "${cg}" && -d "${CG_ROOT}${cg}" ]] && DNSTT_CG="${CG_ROOT}${cg}"
    fi
  fi

  header="epoch,cpu_user,cpu_nice,cpu_sys,cpu_idle,cpu_iowait,cpu_irq,cpu_softirq,cpu_steal,load1,mem_avail_kb,swap_free_kb,pswpin,pswpout"
  header+=",psi_cpu,psi_mem,psi_memfull,psi_io,net_rx,net_tx,udp_in,udp_inerr,udp_rcvbuf,tcp_inuse,conntrack"
  header+=",dnstt_pid,dnstt_ticks,dnstt_rss_kb,dnstt_swap_kb,dnstt_threads,dnstt_cgmem,dnstt_cgswap,dnstt_evmax,dnstt_evoom"
  header+=",q_pkts,q_bytes,a_pkts,a_bytes,stuck"
  for (( i = 0; i < ${#UNITS[@]}; i++ )); do
    header+=",cpu:${UNITS[i]},mem:${UNITS[i]}"
  done
  header+=",self_ticks"
  printf '%s\n' "${header}" > "${DIR}/sampel.csv"
  printf '%s\n' "epoch,stream,klien,byte_upload,syscr,syscw,ctxsw,proses_dropbear,drop_socket,fd,q_pkts" > "${DIR}/menit.csv"

  write_info "AWAL"
  trap 'STOP=1' TERM INT HUP
  # Jeda tanpa membuat proses baru; kalau gagal dipakai sleep biasa.
  { exec {NAP_FD}<> <(:); } 2>/dev/null || NAP_FD=""

  now_epoch
  next="${NOW}"
  while (( STOP == 0 )); do
    now_epoch
    (( NOW >= END_AT )) && break
    take_sample
    if (( NOW - last_minute >= 60 )); then
      take_minute
      last_minute="${NOW}"
    fi
    next=$(( next + INTERVAL ))
    now_epoch
    wait=$(( next - NOW ))
    if (( wait < 1 )); then wait=1; next=$(( NOW + 1 )); fi
    nap "${wait}"
  done
  finalize
}

# ---------------------------------------------------------------------------
# Perintah
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Cek cepat: 10 detik, hasil langsung di layar. Baca saja.
# ---------------------------------------------------------------------------

# Pembanding dari rekaman 3 jam VPS 2 GB / 2 vCPU (11-11-2026), nilai tengah.
CEK_REF="VPS 2 GB/2 vCPU, 11-17 klien: 39% satu core, 4600 jawaban/dtk, 350 byte/jawaban, 80 mikrodetik/jawaban"

# Satu baris per proses: "TAG pid tick nama". Proses yang hilang dilewati.
proc_ticks_dump() {
  local tag="$1" f l pid name rest
  for f in /proc/[0-9]*/stat; do
    { read -r l < "${f}"; } 2>/dev/null || continue
    [[ -n "${l}" ]] || continue
    pid="${l%% *}"
    name="${l#*(}"; name="${name%) *}"
    rest="${l##*) }"
    # shellcheck disable=SC2086
    set -- ${rest}
    printf '%s %s %s %s\n' "${tag}" "${pid}" "$(( ${12:-0} + ${13:-0} ))" "${name// /_}"
  done
}

# Detik sejak boot dalam centidetik -> UP_CS.
uptime_cs() {
  local u=""
  { read -r u _ < /proc/uptime; } 2>/dev/null || u=""
  if [[ "${u}" =~ ^([0-9]+)\.([0-9]{2}) ]]; then
    UP_CS=$(( 10#${BASH_REMATCH[1]} * 100 + 10#${BASH_REMATCH[2]} ))
  else
    UP_CS=0
  fi
}

cpu_total_ticks() {
  local _c u=0 n=0 s=0 i=0 w=0 q=0 sq=0 st=0
  { read -r _c u n s i w q sq st _ < /proc/stat; } 2>/dev/null || true
  CPU_BUSY=$(( u + n + s + q + sq ))
  CPU_STEAL=$(( st ))
  CPU_ALL=$(( u + n + s + i + w + q + sq + st ))
}

socket_drops() {
  local l re_d=',d([0-9]+)\)' re_rb='rb([0-9]+)'
  SOCK_DROP=""; SOCK_RB=""
  l="$(ss -Hlunm "sport = :${LISTEN}" 2>/dev/null | tr -d '\n')"
  [[ "${l}" =~ ${re_d} ]] && SOCK_DROP="${BASH_REMATCH[1]}"
  [[ "${l}" =~ ${re_rb} ]] && SOCK_RB="${BASH_REMATCH[1]}"
  return 0
}

# "TAG clientid jumlah_stream byte_upload" per klien dari snapshot sesi.
sessions_by_client() {
  printf '%s\n' "$2" | awk -F'|' -v t="$1" '
    length($2) == 16 && $2 ~ /^[0-9a-f]+$/ && $1 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { n[$2]++; u[$2] += $3 }
    END { for (k in n) print t, k, n[k], u[k] }'
}

unit_of_pid() {
  local l c u="-"
  if [[ -r "/proc/$1/cgroup" ]]; then
    while IFS= read -r l; do
      c="${l##*/}"
      case "${c}" in *.service|*.scope) u="${c}" ;; esac
    done < "/proc/$1/cgroup"
  fi
  printf '%s' "${u%.service}"
}

fmt_age() {
  local s="$1"
  if (( s >= 86400 )); then printf '%d hari %d jam' $(( s / 86400 )) $(( s % 86400 / 3600 ))
  elif (( s >= 3600 )); then printf '%d jam %d menit' $(( s / 3600 )) $(( s % 3600 / 60 ))
  else printf '%d menit' $(( s / 60 )); fi
}

cmd_cek() {
  local dur=10 pid=0 cg="" p d n ncpu dt
  local s1 s2 top top_pid="" top_name="" top_pct=0
  local a1p a1b q1 a2p a2b q2 d1 d2 r1="" r2="" busy1 all1 st1 up1 t1=0 t2=0
  local pf="" perf_ok=0
  need_root
  CLK_TCK="$(getconf CLK_TCK 2>/dev/null || echo 100)"
  [[ "${CLK_TCK}" =~ ^[0-9]+$ ]] && (( CLK_TCK > 0 )) || CLK_TCK=100
  USEC_PER_TICK=$(( 1000000 / CLK_TCK ))
  ncpu="$(nproc 2>/dev/null || echo 1)"
  LISTEN="$(env_value SLOWDNS_LISTEN_PORT)"
  [[ "${LISTEN}" =~ ^[0-9]+$ ]] || LISTEN=5300
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "${SLOWDNS_UNIT}" 2>/dev/null; then
    p="$(systemctl show -p MainPID --value "${SLOWDNS_UNIT}" 2>/dev/null)" || p=""
    [[ "${p}" =~ ^[0-9]+$ ]] && (( p > 0 )) && pid="${p}"
    cg="$(systemctl show -p ControlGroup --value "${SLOWDNS_UNIT}" 2>/dev/null)" || cg=""
  fi
  echo "Mengukur ${dur} detik (baca saja, tidak mengubah apa pun)..."

  A_P=-1; A_B=0; Q_P=-1; Q_B=0
  sample_slowdns_counters; a1p="${A_P}"; a1b="${A_B}"; q1="${Q_P}"
  socket_drops; d1="${SOCK_DROP}"
  if (( pid > 0 )); then read_sessions; r1="${S_RAW}"; pid_ticks "${pid}"; t1="${T}"; fi
  cpu_total_ticks; busy1="${CPU_BUSY}"; all1="${CPU_ALL}"; st1="${CPU_STEAL}"
  s1="$(proc_ticks_dump A)"
  uptime_cs; up1="${UP_CS}"

  # perf (kalau terpasang) merekam fungsi yang dipakai dnstt selama jeda ukur.
  if (( pid > 0 )) && command -v perf >/dev/null 2>&1; then
    mkdir -p "${BASE_DIR}" && chmod 700 "${BASE_DIR}" 2>/dev/null
    pf="${BASE_DIR}/.cek-perf.data"
    rm -f "${pf}" "${pf}.old"
    if perf record -q -N -F 49 -p "${pid}" -o "${pf}" -- sleep "${dur}" >/dev/null 2>&1 && [[ -s "${pf}" ]]; then
      perf_ok=1
    fi
  fi
  uptime_cs
  if (( UP_CS - up1 < dur * 100 )); then
    sleep "$(( (dur * 100 - (UP_CS - up1) + 99) / 100 ))"
  fi

  s2="$(proc_ticks_dump B)"
  cpu_total_ticks
  uptime_cs
  dt=$(( UP_CS - up1 )); (( dt > 0 )) || dt=1
  A_P=-1; A_B=0; Q_P=-1; Q_B=0
  sample_slowdns_counters; a2p="${A_P}"; a2b="${A_B}"; q2="${Q_P}"
  socket_drops; d2="${SOCK_DROP}"
  if (( pid > 0 )); then pid_ticks "${pid}"; t2="${T}"; read_sessions; r2="${S_RAW}"; fi

  local cbusy=$(( CPU_BUSY - busy1 )) call=$(( CPU_ALL - all1 )) cst=$(( CPU_STEAL - st1 ))
  (( call > 0 )) || call=1
  local steal_pct=$(( cst * 100 / call ))
  echo
  echo "=== CPU VPS (${ncpu} core, ${dur} detik) ==="
  printf 'Total terpakai : %d%% dari semua core (di kolom %%CPU top setara %d%%)\n' \
    $(( cbusy * 100 / call )) $(( cbusy * 100 * ncpu / call ))
  printf 'Steal          : %d%%\n' "${steal_pct}"
  printf 'Load           : %s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"

  top="$(printf '%s\n%s\n' "${s1}" "${s2}" | awk '
      $1 == "A" { a[$2] = $3; next }
      $1 == "B" && ($2 in a) { d = $3 - a[$2]; if (d > 0) print d, $2, $4 }' | sort -rn | head -8)"
  echo
  echo "=== 8 proses CPU terbesar (100% = satu core penuh, sama dengan top) ==="
  while read -r d p n; do
    [[ "${d}" =~ ^[0-9]+$ ]] || continue
    if [[ -z "${top_pid}" ]]; then
      top_pid="${p}"; top_name="${n}"; top_pct=$(( d * 10000 / CLK_TCK / dt ))
    fi
    printf '%5d%%  %-7s %-18s %s\n' $(( d * 10000 / CLK_TCK / dt )) "${p}" "${n}" "$(unit_of_pid "${p}")"
  done < <(printf '%s\n' "${top}")

  local cpu_dn=0 an=-1 ab=0 fl=-1 aps=0 bpa=0 usa=0 down10=0 up10=0 dropd="" age=0
  local nx=0 wr=0 sup=0 mem_cur="" mem_max="" ev_max="" ev_oom="" jr cl l rest
  if (( pid > 0 )); then
    cpu_dn=$(( (t2 - t1) * 10000 / CLK_TCK / dt ))
    if (( a1p >= 0 && a2p >= a1p )); then an=$(( a2p - a1p )); ab=$(( a2b - a1b )); fi
    if (( q1 >= 0 && q2 >= q1 )); then fl=$(( q2 - q1 )); fi
    if (( an > 0 )); then
      aps=$(( an * 100 / dt ))
      bpa=$(( ab / an ))
      usa=$(( (t2 - t1) * USEC_PER_TICK / an ))
      down10=$(( ab * 8 * 100 * 10 / dt / 1000000 ))
    fi
    if [[ "${d1}" =~ ^[0-9]+$ && "${d2}" =~ ^[0-9]+$ ]] && (( d2 >= d1 )); then dropd=$(( d2 - d1 )); fi
    { read -r l < "/proc/${pid}/stat"; } 2>/dev/null || l=""
    if [[ -n "${l}" ]]; then
      rest="${l##*) }"
      # shellcheck disable=SC2086
      set -- ${rest}
      age=$(( UP_CS / 100 - ${20:-0} / CLK_TCK ))
    fi
    cl="$( { sessions_by_client A "${r1}"; sessions_by_client B "${r2}"; } | awk '
        $1 == "A" { u[$2] = $4; next }
        $1 == "B" { d = $4 - (($2 in u) ? u[$2] : 0); if (d < 0) d = 0; print d, $2, $3 }' | sort -rn)"
    up10="$(printf '%s\n' "${cl}" | awk -v dt="${dt}" '{ s += $1 } END { printf "%d", s * 8 * 100 * 10 / dt / 1000000 }')"
    if [[ -n "${cg}" && -d "/sys/fs/cgroup${cg}" ]]; then
      { read -r mem_cur < "/sys/fs/cgroup${cg}/memory.current"; } 2>/dev/null || mem_cur=""
      { read -r mem_max < "/sys/fs/cgroup${cg}/memory.max"; } 2>/dev/null || mem_max=""
      while read -r p n; do
        case "${p}" in max) ev_max="${n}" ;; oom_kill) ev_oom="${n}" ;; esac
      done < <(cat "/sys/fs/cgroup${cg}/memory.events" 2>/dev/null)
    fi
    jr="$(journalctl -u "${SLOWDNS_UNIT}" --since "-10min" --no-pager -o cat 2>/dev/null)"
    nx="$(printf '%s\n' "${jr}" | grep -c 'NXDOMAIN')"
    wr="$(printf '%s\n' "${jr}" | grep -c 'WriteTo')"
    sup="$(printf '%s\n' "${jr}" | awk '{ for (i = 1; i < NF; i++) if ($i == "Suppressed" && $(i + 1) ~ /^[0-9]+$/) s += $(i + 1) } END { print s + 0 }')"

    echo
    echo "=== SlowDNS (dnstt) ==="
    printf 'PID / umur     : %s / %s (restart terakhir), restart otomatis %s kali\n' "${pid}" "$(fmt_age "${age}")" \
      "$(systemctl show -p NRestarts --value "${SLOWDNS_UNIT}" 2>/dev/null)"
    printf 'CPU            : %d%% satu core\n' "${cpu_dn}"
    if (( an >= 0 )); then
      printf 'Jawaban        : %d/dtk, rata %d byte/jawaban\n' "${aps}" "${bpa}"
      (( an > 0 )) && printf 'Biaya          : %d mikrodetik per jawaban (normal 70-180)\n' "${usa}"
    else
      echo "Jawaban        : counter OUTPUT SlowDNS tidak ditemukan"
    fi
    (( fl >= 0 )) && printf 'Flow baru      : %d/dtk\n' $(( fl * 100 / dt ))
    printf 'Trafik         : turun %d.%d Mbps, naik %d.%d Mbps\n' $(( down10 / 10 )) $(( down10 % 10 )) $(( up10 / 10 )) $(( up10 % 10 ))
    printf 'Sesi           : %d klien, %d stream\n' "${S_CLIENTS}" "${S_COUNT}"
    if [[ -n "${cl}" ]]; then
      echo "Upload terbesar per klien (ClientID acak, bukan username):"
      printf '%s\n' "${cl}" | head -3 | awk -v dt="${dt}" '{ printf "  %s...  %d kbps naik, %d stream\n", substr($2, 1, 4), $1 * 8 * 100 / dt / 1000, $3 }'
    fi
    printf 'Thread / RSS   : %s / %s\n' "$(awk '/^Threads:/ { print $2 }' "/proc/${pid}/status" 2>/dev/null)" \
      "$(awk '/^VmRSS:/ { printf "%d MiB", $2 / 1024 }' "/proc/${pid}/status" 2>/dev/null)"
    if [[ "${mem_cur}" =~ ^[0-9]+$ ]]; then
      printf 'Memori cgroup  : %d MiB dari %s, kena batas %s kali, oom %s\n' $(( mem_cur / 1048576 )) \
        "$( [[ "${mem_max}" =~ ^[0-9]+$ ]] && printf '%d MiB' $(( mem_max / 1048576 )) || printf '%s' "${mem_max:-?}")" \
        "${ev_max:-?}" "${ev_oom:-?}"
    fi
    printf 'Setelan Go/KCP : %s\n' "$(systemctl show -p Environment --value "${SLOWDNS_UNIT}" 2>/dev/null | tr ' ' '\n' \
      | grep -E '^(GOMAXPROCS|GOGC|GOMEMLIMIT|SLOWDNS_KCP_[A-Z_]+)=' | sed 's/^SLOWDNS_KCP_/KCP_/' | tr '\n' ' ')"
    printf 'Socket         : buffer %s byte, buang %s paket dalam %d detik\n' "${SOCK_RB:-?}" "${dropd:-?}" "${dur}"
    printf 'Conntrack      : %s dari %s\n' "$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo '?')" \
      "$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo '?')"
    printf 'Log 10 menit   : NXDOMAIN %d baris, WriteTo error %d baris, ditekan journald %d baris\n' "${nx}" "${wr}" "${sup}"
    echo "Pembanding     : ${CEK_REF}"
  else
    echo
    echo "=== SlowDNS: tidak aktif ==="
  fi

  if (( perf_ok )); then
    echo
    echo "=== Fungsi yang makan CPU dnstt (perf ${dur} detik, 2% ke atas) ==="
    perf report -i "${pf}" --stdio --no-children --sort symbol --percent-limit 2 2>/dev/null \
      | grep -vE '^(#|[[:space:]]*$)' | head -20
  elif (( pid > 0 )); then
    echo
    echo "(perf tidak terpasang. Untuk melihat fungsi pemakan CPU: apt install linux-perf"
    echo " di Debian, atau apt install linux-tools-\$(uname -r) di Ubuntu, lalu cek ulang.)"
  fi
  [[ -n "${pf}" ]] && rm -f "${pf}" "${pf}.old"

  echo
  echo "=== Kesimpulan sementara ==="
  local said=0
  if [[ -n "${top_pid}" && "${top_pid}" != "${pid}" ]] && (( top_pct > cpu_dn && top_pct >= 30 )); then
    echo "- Pemakai CPU terbesar: ${top_name} ($(unit_of_pid "${top_pid}")) ${top_pct}% satu core, bukan SlowDNS."
    said=1
  fi
  if (( pid > 0 && cpu_dn >= 50 )); then
    if (( an == 0 || usa >= 1000 )); then
      echo "- SlowDNS MACET: ${usa} mikrodetik per jawaban (normal 70-180). CPU habis bukan untuk"
      echo "  melayani pengguna. Jangan restart dulu: jalankan 'bash ${BASE_DIR}/sc-diag.sh start 30'"
      echo "  supaya kejadiannya terekam. Setelah rekaman selesai: systemctl restart sc-1forcr-slowdns"
    elif (( usa >= 300 )); then
      echo "- Tiap jawaban mahal: ${usa} mikrodetik, sekitar $(( usa / 80 )) kali VPS 2 GB (80). Belum macet"
      echo "  penuh, tapi CPU habis lebih cepat dari seharusnya untuk ${aps} jawaban/dtk."
    elif (( an > 0 )); then
      echo "- Biaya per jawaban wajar (${usa} mikrodetik). CPU tinggi karena jumlah jawaban"
      echo "  (${aps}/dtk untuk ${S_CLIENTS} klien), bukan macet."
      (( bpa > 0 && bpa < 400 )) && echo "  Sebagian besar jawaban kecil (${bpa} byte): banyak polling/ACK, data sedikit."
    fi
    said=1
  fi
  if (( nx >= 100 || sup >= 1000 )); then
    echo "- Banyak log NXDOMAIN/ditekan: ada query asing ke port 53 (scanner/serangan) ikut makan CPU."
    said=1
  fi
  if [[ "${dropd}" =~ ^[0-9]+$ ]] && (( dropd > 0 )); then
    echo "- Socket SlowDNS membuang ${dropd} paket dalam ${dur} detik (buffer penuh)."
    said=1
  fi
  if (( steal_pct >= 10 )); then
    echo "- Steal ${steal_pct}%: CPU fisik VPS sedang direbut VM lain di host yang sama."
    said=1
  fi
  (( said )) || echo "- Tidak ada tanda masalah dalam ${dur} detik ini."
  return 0
}

running_dir() {
  local d=""
  [[ -r "${BASE_DIR}/berjalan" ]] && { read -r d < "${BASE_DIR}/berjalan"; } 2>/dev/null
  printf '%s' "${d}"
}

is_running() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "${UNIT_NAME}.service" 2>/dev/null; then
    return 0
  fi
  local p=""
  [[ -r "${BASE_DIR}/pid" ]] && { read -r p < "${BASE_DIR}/pid"; } 2>/dev/null
  [[ "${p}" =~ ^[0-9]+$ ]] && kill -0 "${p}" 2>/dev/null
}

cmd_start() {
  local minutes="${1:-60}" self copy
  need_root
  if [[ ! "${minutes}" =~ ^[0-9]+$ ]] || (( minutes < 1 || minutes > 1440 )); then
    echo "Gagal: MENIT harus 1 sampai 1440."
    exit 1
  fi
  if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 2) )); then
    echo "Gagal: butuh bash 4.2 ke atas."
    exit 1
  fi
  if is_running; then
    echo "Perekam sudah berjalan. Lihat: bash $0 status"
    exit 0
  fi
  mkdir -p "${BASE_DIR}"
  chmod 700 "${BASE_DIR}" 2>/dev/null || true
  self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  copy="${BASE_DIR}/sc-diag.sh"
  if [[ "${self}" != "${copy}" ]]; then
    cp -f "${self}" "${copy}" || { echo "Gagal menyalin script ke ${copy}"; exit 1; }
  fi
  chmod 700 "${copy}"
  rm -f "${BASE_DIR}/pid"
  if command -v systemd-run >/dev/null 2>&1; then
    systemctl reset-failed "${UNIT_NAME}.service" >/dev/null 2>&1 || true
    if systemd-run --quiet --unit="${UNIT_NAME}" --description="SC 1FORCR perekam diagnostik (baca saja)" \
        -p Nice=19 -p IOSchedulingClass=idle -p CPUQuota=15% -p MemoryMax=96M \
        -p KillMode=mixed -p TimeoutStopSec=330 -p OOMPolicy=continue \
        /bin/bash "${copy}" run "${minutes}"; then
      echo "Berhasil: perekam berjalan ${minutes} menit di latar (boleh tutup SSH)."
      echo "Hasil dikirim ke bot notif saat selesai. Status: bash ${copy} status"
      return 0
    fi
    echo "Peringatan: systemd-run gagal, memakai nohup."
  fi
  nohup nice -n 19 /bin/bash "${copy}" run "${minutes}" >/dev/null 2>&1 &
  printf '%s\n' "$!" > "${BASE_DIR}/pid"
  echo "Berhasil: perekam berjalan ${minutes} menit di latar (boleh tutup SSH)."
}

cmd_status() {
  local d rows
  d="$(running_dir)"
  if is_running && [[ -n "${d}" ]]; then
    rows="$(wc -l < "${d}/sampel.csv" 2>/dev/null || echo 0)"
    echo "Status  : berjalan"
    echo "Folder  : ${d}"
    sed -n 's/^label=/Rencana : /p' "${d}/meta" 2>/dev/null
    echo "Sampel  : $(( rows > 0 ? rows - 1 : 0 ))"
    [[ -s "${d}/kejadian-macet.log" ]] && echo "Macet   : $(grep -c '^MACET ' "${d}/kejadian-macet.log") kejadian terekam"
    return 0
  fi
  echo "Status  : tidak berjalan"
  d="$(ls -1d "${BASE_DIR}"/20*/ 2>/dev/null | tail -n1)"
  if [[ -n "${d}" ]]; then
    d="${d%/}"
    echo "Terakhir: ${d}"
    [[ -s "${d}/kirim.log" ]] && tail -n2 "${d}/kirim.log"
  fi
}

cmd_stop() {
  need_root
  if ! is_running; then
    echo "Perekam tidak sedang berjalan."
    return 0
  fi
  echo "Menghentikan perekam dan menyusun ringkasan (bisa sampai beberapa menit)..."
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "${UNIT_NAME}.service" 2>/dev/null; then
    systemctl stop "${UNIT_NAME}.service" >/dev/null 2>&1 || true
  else
    local p="" i
    { read -r p < "${BASE_DIR}/pid"; } 2>/dev/null || true
    if [[ "${p}" =~ ^[0-9]+$ ]]; then
      kill -TERM "${p}" 2>/dev/null || true
      for i in {1..300}; do kill -0 "${p}" 2>/dev/null || break; sleep 1; done
    fi
  fi
  cmd_status
}

cmd_send() {
  local d="${1:-}"
  need_root
  if [[ -z "${d}" ]]; then
    d="$(ls -1d "${BASE_DIR}"/20*/ 2>/dev/null | tail -n1)"
  fi
  d="${d%/}"
  if [[ -z "${d}" || ! -s "${d}/sampel.csv" ]]; then
    echo "Gagal: folder hasil tidak ditemukan."
    exit 1
  fi
  summarize "${d}"
  tar -czf "${d}.tar.gz" -C "${d%/*}" "${d##*/}" 2>/dev/null || true
  send_telegram "${d}"
}

case "${1:-}" in
  start) cmd_start "${2:-60}" ;;
  run) cmd_run "${2:-60}" ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  kirim) cmd_send "${2:-}" ;;
  ringkas) summarize "${2:?folder hasil}"; cat "${2}/ringkasan.txt" ;;
  cek) cmd_cek ;;
  *)
    echo "Pemakaian: bash $0 cek | start [MENIT] | status | stop | kirim [DIR]"
    exit 1
    ;;
esac

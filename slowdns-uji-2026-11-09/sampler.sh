#!/bin/bash
# Sampler SlowDNS: hanya membaca /proc, cgroup, dan counter iptables (tanpa -Z). Interval 2 detik.
OUT="${1:-/root/slowdns-uji-2026-11-09/sampler.csv}"
CG=/sys/fs/cgroup/system.slice/sc-1forcr-slowdns.service
PORT=5300
[[ -s "$OUT" ]] || echo "epoch,pid,dnstt_ticks,rss_kb,swap_kb,cg_cur,cg_swap,ev_high,ev_max,ev_oomkill,q_pkts,q_bytes,ans_pkts,ans_bytes,udp_inerr,udp_rcvbuf,cpu_total,cpu_softirq,cpu_steal,dropbear_ticks" > "$OUT"
ticks() { local l; { read -r l < "/proc/$1/stat"; } 2>/dev/null || { echo 0; return; }; l="${l##*) }"; set -- $l; echo $(( ${12} + ${13} )); }
while :; do
  E=$(date +%s)
  PID=$(head -1 $CG/cgroup.procs 2>/dev/null); PID=${PID:-0}
  T=$(ticks $PID)
  RSS=$(awk '/^VmRSS/{print $2}' /proc/$PID/status 2>/dev/null); SW=$(awk '/^VmSwap/{print $2}' /proc/$PID/status 2>/dev/null)
  CUR=$(cat $CG/memory.current 2>/dev/null); CSW=$(cat $CG/memory.swap.current 2>/dev/null)
  read -r EH EM EK < <(awk '$1=="high"{h=$2}$1=="max"{m=$2}$1=="oom_kill"{k=$2}END{print h+0,m+0,k+0}' $CG/memory.events 2>/dev/null)
  read -r QP QB < <(iptables -w 2 -t nat -L SC1FORCR_SLOWDNS -v -n -x 2>/dev/null | awk '/REDIRECT/ && /dpt:53/{print $1,$2; exit}')
  read -r AP AB < <(iptables -w 2 -L OUTPUT -v -n -x 2>/dev/null | awk -v p="spt:$PORT" '$0 ~ p {print $1,$2; exit}')
  read -r IE RB < <(awk '/^Udp: [0-9]/{print $4,$6; exit}' /proc/net/snmp)
  read -r _c u n s i w q sq st _ < /proc/stat; TOT=$((u+n+s+i+w+q+sq+st))
  DB=0; for p in $(pgrep '^dropbear'); do DB=$((DB + $(ticks $p))); done
  echo "$E,$PID,$T,${RSS:-0},${SW:-0},$CUR,$CSW,$EH,$EM,$EK,${QP:-0},${QB:-0},${AP:-0},${AB:-0},$IE,$RB,$TOT,$sq,$st,$DB" >> "$OUT"
  sleep 2
done

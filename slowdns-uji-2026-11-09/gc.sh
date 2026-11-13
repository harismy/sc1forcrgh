#!/bin/bash
# Pemakaian: gc.sh <epoch_mulai> <epoch_selesai> <label>   (baca journal, simpan potongan gctrace)
journalctl -u sc-1forcr-slowdns -o short-unix --since @$1 --until @$2 --no-pager | grep -E ' gc [0-9]+ @' > /root/slowdns-uji-2026-11-09/gctrace-$3.log
awk -v L="$3" -v a="$1" -v b="$2" '{
  for(i=1;i<=NF;i++){ if($i ~ /^@[0-9.]+s$/){t=substr($i,2)+0; p=$(i+1); sub("%:","",p); p+=0}
    if($i ~ /^[0-9]+->[0-9]+->[0-9]+$/){split($i,h,"->"); live=h[3]+0; if(live>lmax)lmax=live; lsum+=live}
    if($i=="goal,"){g=$(i-2)+0; if(g>gmax)gmax=g; if(gmin==""||g<gmin)gmin=g} }
  n++; if(n==1){t1=t;p1=p}; t2=t;p2=p; if($0 ~ /forced/)f++
} END { if(n<2){print L": siklus GC = " n+0; exit}
  printf "%s: siklus GC %d (%.2f/detik), heap hidup rata %.1f MB maks %d MB, goal %d..%d MB, porsi CPU GC fase %.1f%% (P%% kumulatif %d%%->%d%%)%s\n",
  L,n,n/(b-a),lsum/n,lmax,gmin,gmax,(p2*t2-p1*t1)/(t2-t1),p1,p2,(f?", forced "f:"") }' /root/slowdns-uji-2026-11-09/gctrace-$3.log

#!/bin/bash
# Pemakaian: fase.sh <csv> <epoch_mulai> <epoch_selesai> <label>
awk -F, -v a="$2" -v b="$3" -v L="$4" 'NR>1 && $1>=a && $1<=b {
  if(!s){s=1; for(i=1;i<=NF;i++) f[i]=$i}
  for(i=1;i<=NF;i++) l[i]=$i
  if($4>rss)rss=$4; if($5>sw)sw=$5; if($6>cg)cg=$6; if($7>cs)cs=$7
  if(p && $11-pq > pk*2) pk=($11-pq)/2; pq=$11; p=1
} END {
  dt=l[1]-f[1]; if(dt<=0){print L": data kurang"; exit}
  cpu=(l[3]-f[3])/(l[17]-f[17])*100; q=l[11]-f[11]; ab=l[14]-f[14]; ap=l[13]-f[13]
  printf "%s|%d s|CPU dnstt %.1f%%|q/s %.0f (puncak %.0f)|CPU/query %s µs|jawab %.1f KB/s, rata %s B|drop %d|RSS max %.1f MiB|swap dnstt max %.1f MiB|cg max %.1f MiB, cgswap max %.1f MiB|events high+%d max+%d oomkill+%d|softirq %.1f%% steal %.1f%%|dropbear %.1f%%\n",
   L,dt,cpu,q/dt,pk,(q>0?sprintf("%.0f",(l[3]-f[3])*10000/q):"-"),ab/dt/1024,(ap>0?sprintf("%.0f",ab/ap):"-"),l[16]-f[16],rss/1024,sw/1024,cg/1048576,cs/1048576,
   l[8]-f[8],l[9]-f[9],l[10]-f[10],(l[18]-f[18])/(l[17]-f[17])*100,(l[19]-f[19])/(l[17]-f[17])*100,(l[20]-f[20])/(l[17]-f[17])*100 }' "$1" | tr '|' '\n'

# Laporan uji CPU SlowDNS (dnstt-server) — 2026-11-09

VPS: 1 vCPU, RAM 973 MB, swap 1 GB, kernel 6.1.0-50, systemd 252, cgroup v2.
SC V.1FSC.125, binary v1.20260501.0+sc-fast8, MTU 1232, port 5300.
Unit nyata: MemoryMax=128M, GOMEMLIMIT=96MiB, GOGC=300, GOMAXPROCS=1, KCP window 2048 / interval 10,
LogRateLimit 60 s / 120, MemorySwapMax=infinity, MemoryHigh=infinity.
Klien: 1 pengguna (akun `anjaytes`), 1FTunnel. Data mentah ada di `sampler.csv` (interval 2 s), `fase.txt`
(timestamp fase), dan `gctrace-*.log`.

## Kondisi awal (proses lama, PID 1256770, umur ±16,5 jam)

| Item | Nilai |
|---|---|
| VmRSS / VmHWM / VmSwap | 96 / 129 / **36,5 MiB** |
| memory.current / memory.peak | 101 / **128,07 MiB** (menyentuh MemoryMax) |
| memory.swap.current | 37,3 MiB |
| memory.events | **max 2901**, oom 0, oom_kill 0; swap.events fail 18 |
| memory.stat | anon 94,7 MiB, pgmajfault 35221, workingset_refault_anon 117597 |
| RSS + swap | ±133 MiB, **di atas GOMEMLIMIT 96 MiB dan MemoryMax 128M** |

Catatan: di cgroup v2, `memory.max` tidak menghitung swap. Karena MemorySwapMax tidak dibatasi, kelebihan memori
dnstt didorong ke swap, bukan di-OOM.

## Uji A: kondisi sekarang, tanpa restart (proses lama)

| Fase | Durasi | CPU dnstt | q/s (puncak) | CPU/query | Jawaban/s, rata | Drop UDP | RSS max | Swap max | events high/max/oom_kill |
|---|---|---|---|---|---|---|---|---|---|
| A1 idle (total) | 171 s | 68,1% | 68 (1021) | ~10 ms | 30 KB, 456 B | 74 | 107,9 MiB | 41,0 MiB | +0/+0/+0 |
| · A1 sebelum lonjakan | 37 s | 4,5% | 24 | 1,9 ms | 6 KB, 234 B | – | 91 MiB | 41 MiB | – |
| · **A1 jendela CPU tinggi** | 207 s* | **83,8%** | 60 | **14 ms** | 26 KB, 441 B | – | 105–111 MiB | 25 MiB | +0 |
| A2 download | 69 s | 10,6% | 578 (1500) | 178 µs | 594 KB, 968 B | 0 | 71,8 MiB | 25,3 MiB | +0/+0/+0 |
| A3 upload | 74 s | 29,4% | 4035 (8438) | 71 µs | 1282 KB, 324 B | 8956 | 73,5 MiB | 25,3 MiB | +0/+0/+0 |
| A4 speed test | 83 s | 16,0% | 1762 (10576) | 89 µs | 658 KB, 394 B | 7092 | 86,6 MiB | 25,3 MiB | +0/+0/+0 |

\* Jendela CPU tinggi: epoch 1794223026–1794223234, melewati akhir fase A1. Pada sampel 1794223239,
RSS turun **111 → 71 MiB** dan CPU langsung jatuh ke 4–9%. Pengukuran per thread saat lonjakan: dua thread
Go masing-masing ±25%, majflt dalam 5 detik = 0.

Speed test A4 menurut aplikasi: download 5,3 Mbps, upload 15 Mbps, ping 52 ms tanpa beban dan 246 ms dimuat.

| memory.* | Sebelum A | Sesudah A |
|---|---|---|
| events max | 2901 | 2901 |
| anon | 94,7 MiB | 71,3 MiB |
| pgmajfault | 35221 | 35839 (+618) |
| workingset_refault_anon | 117597 | 121205 |

## Uji B: gctrace (setelah restart, PID 2065509)

Kolom GC CPU dihitung dari jumlah "ms cpu" per siklus, karena kolom `P%` dibulatkan ke 0% sehingga rumus
(P2·T2−P1·T1)/(T2−T1) menghasilkan 0.

| Fase | Durasi | CPU dnstt | q/s (puncak) | CPU/query | Jawaban/s, rata | Drop | RSS max | Swap | GC (per s) | Heap hidup maks | Goal | GC CPU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B1 idle | 82 s | 2,0% | 13 (65) | 1,5 ms | 3 KB, 255 B | 0 | 23,1 MiB | 0 | 0 (0) | 4 MB | 12–14 MB | 0,00% |
| B2 download | 78 s | 5,0% | 283 (1741) | 176 µs | 243 KB, 831 B | 43 | 37,6 MiB | 0 | 7 (0,09) | 7 MB | 23–29 MB | 0,11% |
| B3 upload | 66 s | 30,9% | 4178 (9686) | 72 µs | 1364 KB, 323 B | 5342 | 49,3 MiB | 0 | 49 (0,72) | 10 MB | 25–42 MB | 0,48% |
| B4 speed test | 67 s | 12,2% | 1027 (2770) | 117 µs | 513 KB, 470 B | 34 | 42,2 MiB | 0 | 14 (0,21) | 8 MB | 24–33 MB | 0,14% |

memory.events tidak naik di Uji B. Heap hidup tidak pernah mendekati goal ataupun GOMEMLIMIT.
Speed test B4 menurut aplikasi: download 4,1 Mbps, upload "120 Mbps", ping 49 ms tanpa beban dan 442 ms dimuat.
**Angka upload tidak valid:** puncak query masuk yang terlihat di server hanya 6,56 Mbps mentah.

## Uji C: tidak dijalankan

Syarat Uji C tidak terpenuhi. Di Uji B, GC CPU < 0,5%, goal jauh dari batas, dan memory.events tidak naik.
Pemulihan diminta sebelum fase pemancingan (B5) sempat dijalankan.

## Kesimpulan

1. **CPU tinggi muncul karena proses masuk keadaan rusak, bukan karena trafik.**
   - Pada proses berumur 16 jam, CPU 84% dengan hanya ~60 q/s (14 ms per query) dan RSS 105–111 MiB.
   - Begitu ~40 MiB dilepas (diduga sesi lama ditutup atau reconnect), CPU kembali normal.
   - Dalam keadaan sehat, biaya per query sama dengan lab: 71–178 µs saat ada beban (A2–A4, B2–B4).
   - Angka 81,5% / 304 µs pada pengukuran sebelumnya kemungkinan besar tercampur keadaan rusak ini.
2. **Peran memori/GC: terlihat kuat tapi belum terbukti.**
   - Pendukung: keadaan rusak hanya muncul saat RSS di atas GOMEMLIMIT. Pola dua thread × 25% cocok dengan
     batas CPU GC Go (~50%). CPU turun persis saat memori dilepas.
   - Belum terbukti: gctrace belum sempat merekam keadaan rusak itu. Pada proses segar, GC hanya 0,1–0,5% CPU.
   - Swap dan reclaim cgroup **bukan** penyebab langsung saat pengukuran: memory.events +0, majflt 0 saat
     lonjakan, pgmajfault hanya +618. Tetapi selama 16 jam sebelumnya, cgroup 2901 kali menabrak max dan
     ±37 MiB anon dnstt didorong ke swap.
   - Kemungkinan lain yang belum disingkirkan: sesi KCP yatim yang menahan ±40 MiB buffer dan berputar terus
     (window 2048, interval 10 ms) sampai ditutup. Dalam skenario ini memori dan CPU sama-sama gejala dari
     sesi yang sama.
3. **Efek 192M: belum diketahui** karena Uji C tidak dijalankan. Kalau penyebabnya GC karena heap
   di atas GOMEMLIMIT, menaikkan batas hanya menunda masalah selama ada sesi yang terus menumpuk memori.
4. **Drop UDP terpisah dari masalah memori.** Drop 5–9 ribu terjadi pada lonjakan 8–10 ribu q/s, padahal CPU
   rata-rata hanya 30–39% dan heap kecil. Penyebabnya kemungkinan burst yang melebihi buffer socket
   (RcvbufErrors), bukan kekurangan CPU.
5. **Trafik asing:** dnstt menerima query untuk domain lain (`*.ns-id5.iotukri.online`) dan menulis NXDOMAIN
   ke log untuk tiap query. Query ini ikut masuk counter REDIRECT, jadi angka q/s sedikit lebih tinggi
   dari trafik pengguna sebenarnya.

## Langkah lanjut yang disarankan

- Pancing keadaan rusak dengan gctrace aktif (drop-in yang sama, satu kali restart). Lakukan transfer berat,
  lalu putus kasar dengan mode pesawat dan sambung lagi, ulangi 3×. Pantau heap hidup ("A->B->C MB"),
  goal, dan GC CPU. Kalau heap hidup ≥ 90 MB dan GC ≥ 25% CPU, hipotesis GC terbukti.
- Kalau ingin mencoba batas memori baru secara permanen, **jangan pakai drop-in**. Cara resminya (dijalankan
  sendiri oleh pemilik VPS):
  1. Ubah `SLOWDNS_MEMORY_MAX=auto` menjadi `SLOWDNS_MEMORY_MAX=192M` di `/etc/sc-1forcr.env`.
  2. Jalankan `sc-1forcr-slowdns setup`.
- Untuk dev: periksa pembersihan sesi KCP/turbotunnel yang yatim, misalnya timeout idle dan batas buffer
  per sesi dengan window 2048. Pertimbangkan juga agar log NXDOMAIN untuk domain asing tidak ditulis.

## Keterbatasan

- Aplikasi 1FTunnel memakai resolver 1.1.1.1 lewat jaringan seluler. Throughput dan ping bervariasi antar
  fase karena jaringan, bukan server. Angka upload dari aplikasi tidak bisa dipercaya (120 Mbps vs 6,6 Mbps
  yang terlihat di server).
- Setiap fase berlangsung 60–85 detik dengan sampling 2 detik, sehingga lonjakan di bawah 2 detik ikut
  tergerus rata-rata.
- Keadaan rusak hanya teramati sekali, tanpa gctrace.
- **Claude Code sendiri (proses `claude`) memakai RSS 306–342 MB dan rata-rata ±5% CPU** selama sesi.
  Itu sepertiga RAM VPS. RAM tersedia saat uji 300–369 MB. Tekanan memori global ini bisa ikut mendorong
  dnstt ke swap. Sampler sendiri ringan: bash, interval 2 detik, membaca /proc dan dua panggilan iptables.

## Status pemulihan (terverifikasi)

- Sampler dihentikan.
- Drop-in `99-sc-uji.conf` dan direktori `.d` dihapus, daemon-reload sudah jalan.
- slowdns di-restart dengan izin pada epoch 1794224574. PID baru 2088866, tanpa GODEBUG.
- Environment, MemoryMax 128M, LogRateLimit 60 s / 120 sama dengan kondisi awal.
- `sc-1forcr-slowdns status` AKTIF. Rule REDIRECT udp dpt:53 → 5300 dan OUTPUT udp spt:5300 masih ada.
  dnstt listen di :5300.
- iptables tidak di-reset (-Z tidak dipakai). env, unit utama, dan script SC tidak diubah.
  Tidak ada service lain yang disentuh.

## RINGKASAN UNTUK DEV

```
VPS 1vCPU/973MB, cgroup v2, SC V.1FSC.125, dnstt v1.20260501.0+sc-fast8, MTU1232, KCP win2048 int10
Unit: MemoryMax=128M GOMEMLIMIT=96MiB GOGC=300 GOMAXPROCS=1 MemorySwapMax=inf
Proses lama 16.5j: RSS 96MiB + VmSwap 36.5MiB, HWM 129MiB, memory.peak 128.07MiB, events.max=2901, oom=0, pgmajfault 35221
KEADAAN RUSAK (proses lama): CPU 83.8% @60 q/s = 14 ms/query, RSS 105-111MiB, 2 thread x ~25%, majflt 0, events +0
  -> RSS turun 111->71MiB tiba-tiba (dugaan sesi lama ditutup) -> CPU langsung 4-9%
Proses lama setelah memori dilepas:
  A2 download: 10.6% CPU, 578 q/s, 178 us/q, jawaban 968 B, drop 0
  A3 upload : 29.4% CPU, 4035 q/s, 71 us/q, jawaban 324 B, drop 8956
  A4 speedtest: 16.0% CPU, 1762 q/s, 89 us/q, drop 7092
Proses segar + gctrace:
  B1 idle    : 2.0% CPU, 13 q/s, GC 0 siklus, heap hidup 4MB
  B2 download: 5.0% CPU, 283 q/s, 176 us/q, GC 0.09/s, heap hidup max 7MB, goal 23-29MB, GC CPU 0.11%
  B3 upload  : 30.9% CPU, 4178 q/s, 72 us/q, GC 0.72/s, heap hidup max 10MB, goal 25-42MB, GC CPU 0.48%, drop 5342
  B4 speedtest: 12.2% CPU, 1027 q/s, 117 us/q, GC 0.21/s, heap hidup max 8MB, GC CPU 0.14%
Kesimpulan: biaya/query sehat = lab (71-178 us). CPU tinggi = keadaan rusak terkait RSS > GOMEMLIMIT.
  GC belum terbukti (gctrace tidak menangkap keadaan rusak); alternatif: sesi KCP yatim berputar + tahan ~40MiB.
Drop UDP muncul saat burst 8-10k q/s, CPU rata hanya 30-39% -> buffer socket, bukan CPU/GC.
Trafik asing: NXDOMAIN *.ns-id5.iotukri.online di-log per query.
App speedtest: dl 5.3/4.1 Mbps; ping idle 52/49ms, dimuat 246/442ms; upload app (15/120) TIDAK valid (server max 6.56 Mbps).
Uji C (192M) tidak dijalankan. Claude Code pakai RSS ~330MB selama uji.
Saran: reproduksi dengan gctrace (putus kasar mode pesawat x3), cek cleanup sesi KCP/turbotunnel yatim.
```

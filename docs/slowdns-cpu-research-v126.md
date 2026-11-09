# Riset CPU SlowDNS saat speed test (V.1FSC.126)

Riset ini mencari penyebab CPU dnstt tinggi saat satu pengguna menjalankan
speed test, lalu menguji apakah window KCP, mode nodelay, atau pembuangan
retransmisi ganda bisa menurunkan CPU per MiB tanpa mengurangi speed atau
menaikkan ping. **Hasilnya: tidak ada opsi yang lolos.** Patch DNSTT tetap
`sc-fast8`, default tidak berubah, dan tidak ada opsi env baru.

Uji lanjutan di VPS yang sama (bagian [Uji di VPS](#uji-di-vps-9-november-2026))
menunjukkan CPU tinggi di lapangan berasal dari **keadaan macet pada proses
dnstt yang sudah lama jalan**, bukan dari beban speed test. Dalam keadaan sehat
speed test hanya memakai 12–16% satu core.

## Data lapangan

Dari VPS 1 GB / 1 vCPU, satu pengguna (pemilik) menjalankan speed test lewat
1FTunnel (record NULL, resolver 1.1.1.1), sambil `cek-cpu-slowdns.sh` mencatat
CPU:

| Ukuran | Nilai |
|---|---|
| Hasil speed test di aplikasi | download 2,5 Mbps, upload "190 Mbps" |
| CPU `dnstt-server` | rata-rata 81,5% satu core, puncak 95,5%, total 63,2 detik CPU |
| CPU Dropbear (semua proses) | rata-rata 1,6%, puncak 3,7% |
| CPU VPS | 89,3% (softirq 3,6, steal 3,8) |
| Query DNS | rata-rata 2680/detik, puncak 18134/detik |
| Jawaban DNS | 39,9 MB, rata-rata 4,1 Mbps, puncak 11,9 Mbps |
| Interface | rx 74 MB, tx 44 MB |
| Drop UDP kernel | 90206 |
| RSS dnstt puncak | 128 MB (sama dengan `MemoryMax` tier 1 GB, `GOMEMLIMIT` 96 MiB) |
| Turunan skrip | 1584 ms CPU per MB jawaban, 304 µs CPU per query |

Yang bisa disimpulkan:

1. **Yang berat dnstt, bukan Dropbear.** Enkripsi SSH hanya 1,6%. Mengganti
   atau menyetel Dropbear tidak akan menolong.
2. **dnstt mentok satu core.** 63,2 detik CPU / 304 µs ≈ 208 ribu query dalam
   sekitar 78 detik. 90 ribu paket UDP dibuang kernel (sekitar 43% query),
   tanda socket tidak sempat dibaca. Query yang hilang membuat klien mengirim
   ulang, jadi beban query ikut naik.
3. **Sebagian besar jawaban hampir kosong.** 39,9 MB / 208 ribu ≈ 192 byte per
   jawaban, padahal jawaban yang penuh data download sekitar 1 KB (MTU sesi
   ~932 untuk aplikasi yang mengiklankan EDNS 1232). Jadi beban terbesar datang dari jumlah query (poll, ACK, upload),
   bukan dari byte download. Angka "ms per MB" lapangan karena itu tidak bisa
   langsung dibandingkan dengan CPU per MiB payload di lab.
4. **Upload 190 Mbps tidak mungkin.** Seluruh rx interface 74 MB dalam
   ~78 detik ≈ 7,6 Mbps, sudah termasuk query DNS dan data download dari
   internet. Aplikasi menghitung data yang masuk buffer-nya sendiri.
5. **Biaya per query 304 µs ternyata tercampur keadaan macet.** Uji VPS
   berikutnya mengukur 71–178 µs per query dalam keadaan sehat, sekitar
   1,5–2,5× lab (71–107 µs download, 29–45 µs upload). Lihat bagian berikut.

## Uji di VPS (9 November 2026)

VPS yang sama (1 vCPU, RAM 973 MB, kernel 6.1, cgroup v2, SC V.1FSC.125,
`sc-fast8`), satu pengguna 1FTunnel. Sampler tiap 2 detik membaca CPU proses
dnstt, RSS/swap, counter REDIRECT/OUTPUT, dan drop UDP; gctrace diaktifkan
setelah restart. Data mentah tidak disimpan di repo.

Sebelum uji, proses dnstt sudah jalan ±16,5 jam: RSS 96 MiB + swap 36,5 MiB,
`memory.peak` 128 MiB, dan `memory.events max` 2901 (cgroup 2901 kali menabrak
`MemoryMax` lalu mendorong memori dnstt ke swap), tanpa OOM.

| Fase | CPU dnstt | Query/detik | CPU per query | RSS maks |
|---|---:|---:|---:|---:|
| Proses lama, idle sebelum lonjakan | 3,3% | 9 | – | 96 MiB (+ swap 41) |
| **Proses lama, keadaan macet (209 detik)** | **84%** | 58 | **14,6 ms** | 111 MiB |
| Proses lama, download | 10,6% | 578 | 178 µs | 72 MiB |
| Proses lama, upload | 29,4% | 4035 | 71 µs | 74 MiB |
| Proses lama, speed test | 16,0% | 1762 | 89 µs | 87 MiB |
| Proses baru, idle | 2,0% | 13 | – | 23 MiB |
| Proses baru, download | 5,0% | 283 | 176 µs | 38 MiB |
| Proses baru, upload | 30,9% | 4178 | 72 µs | 49 MiB |
| Proses baru, speed test | 12,2% | 1027 | 117 µs | 42 MiB |

1. **Dalam keadaan sehat SlowDNS ringan.** Speed test memakai 12–16% satu
   core, upload paling berat sekitar 30%.
2. **CPU tinggi berasal dari keadaan macet, bukan beban.** Selama 209 detik
   dnstt memakai rata-rata 84% satu core (kebanyakan sampel 90–100%) dengan
   hanya ~58 query/detik, sekitar 100× lebih mahal per query daripada normal.
   Angka lapangan sebelumnya (81,5%, 304 µs per query) hampir pasti tercampur
   keadaan ini.
   - Didahului swap-in ~16 MiB dalam 10 detik (memori lama disentuh lagi),
     lalu CPU melonjak tanpa perubahan trafik.
   - Selama macet RSS naik 89 → 111 MiB walau trafik hampir nol, jadi ada yang
     terus mengalokasi. Jawaban DNS ke aplikasi rata-rata hanya 200–500 byte:
     antrean ClientID yang sedang di-poll aplikasi kosong.
   - Berhenti mendadak bersamaan dengan aktivitas baru dari aplikasi: RSS turun
     111 → 71 MiB dalam ±5 detik dan CPU langsung 4–5%.
3. **Memori di atas `GOMEMLIMIT` saja tidak membuat CPU tinggi.** Sebelum
   lonjakan, proses yang sama sudah memakai ±131 MiB (RSS + swap) dengan CPU
   3%. Pada proses baru, heap hidup maksimum 10 MB, goal 12–42 MB, GC ≤0,5%
   CPU, dan `memory.events` tidak naik. Menaikkan `SLOWDNS_MEMORY_MAX` tidak
   didukung data.
4. **Penyebab keadaan macet belum diketahui.** Dua kandidat:
   - sesi KCP/smux lama (ClientID yang sudah tidak di-poll aplikasi) yang
     menahan buffer besar dan terus memproses retransmisi/antrean sampai sesi
     itu ditutup;
   - GC beruntun karena objek sesi itu membuat heap hidup melewati batas.

   gctrace belum aktif saat macet, jadi keduanya belum bisa dibedakan. Pola
   memori (naik selama macet, 40 MiB lepas saat berhenti) menunjuk ke objek
   milik sesi tertentu, bukan ke ukuran batas memori.
5. **Drop UDP terpisah dari masalah ini.** Drop 5–9 ribu per fase terjadi pada
   lonjakan 8–10 ribu query/detik saat upload, sementara CPU rata-rata 30%.
   Lonjakan melebihi buffer socket; kandidat perbaikan tersendiri.
6. Query untuk domain lain (`*.ns-id5.iotukri.online`) masuk ke port 53 VPS
   dan dijawab NXDOMAIN dengan satu baris log per query (perilaku dnstt
   upstream). Volumenya kecil saat uji.
7. Claude Code yang menjalankan uji memakai RSS 306–342 MB dan ±5% CPU, kira-kira
   sepertiga RAM VPS.

## Metode

Sama dengan [uji V.1FSC.125](slowdns-kcp-tuning-v125.md) (laptop Windows 11,
i5-1035G7, Go 1.26.6, `GOMAXPROCS=1`, `GOGC=300`, `GOMEMLIMIT=96MiB`,
`-mtu 1232`, `dnstt-client` upstream TXT, resolver tiruan, backend TCP lokal),
dengan perubahan:

- **Matriks bebas** `--configs 'label=KUNCI=NILAI,...;...'` di
  `scripts/bench-slowdns-kcp.js`. Setiap matriks punya **pasangan A/A**
  (`w2048-A`, `w2048-B`, isi sama) untuk mengukur noise. Kunci `BIN=<dir>`
  memakai binary lain.
- **Build berinstrumen** (tag `scbench`, hanya untuk uji, tidak pernah masuk
  installer): [`scripts/go/slowdns-bench/`](../scripts/go/slowdns-bench/).
  `--instr 1` membaca `kcp.DefaultSnmp` (RTO/fast/early retransmit), kedalaman
  antrean keluar dnstt (sampel 20 ms), dan srtt/rto per sesi di tiap fase.
  `--profile-dir` merekam pprof CPU selama fase download. Binary produksi
  tanpa instrumen (`prod-A`) ikut diuji di profil seluler. Hasilnya sama
  dengan build uji, jadi instrumen tidak menggeser angka.
- **Batas laju resolver** `--resolver-qps N`: token bucket per klien, burst
  N/10, kelebihan dibuang, untuk meniru resolver publik yang membatasi laju.
- Beban per putaran: 30 ping, download 4 MiB sambil ping di stream lain,
  upload 0,5 MiB, download paralel 4 × 1 MiB, ditambah 4 klien idle. 6 putaran
  per profil, urutan konfigurasi diputar, proses server dan klien baru per
  putaran.
- Konfigurasi: window 2048 (A dan B, default tier 1 GB), 1024, 512;
  `nodelay0` (`SetNoDelay(0, …)`: RTO minimum 100 ms dan backoff ×2); `dedup`
  (prototipe yang membuang segmen PUSH yang salinan pertamanya masih antre);
  `dedup+nodelay0`.

Kriteria lolos dari pemilik: CPU-s/MiB turun **melebihi** selisih A/A, **dan**
download serta download paralel tidak turun, **dan** ping p50/p95 (sepi dan
saat download) tidak naik. CPU yang turun karena speed ikut turun tidak
dihitung sebagai penghematan.

## Mekanisme retransmisi saat download

Data instrumen (profil seluler, per MiB yang dikirim, median):

| Konfigurasi | Retransmisi/MiB (RTO / fast / early) | Antrean keluar rata-rata / maks | srtt / rto akhir download |
|---|---|---|---|
| w2048-A | 870 (833 / 39 / 1) | 933 / 2427 | 299 / 546 ms |
| w2048-B | 769 (733 / 45 / 0) | 880 / 2284 | 458 / 826 ms |
| w512 | 689 (668 / 16 / 0) | 377 / 1062 | 265 / 518 ms |
| dedup | 1100 (1079 / 20 / 2), 932 dibuang | 614 / 1593 | 446 / 954 ms |

- Hampir semua retransmisi adalah **RTO**, bukan fast/early retransmit. Varian
  fast resend karena itu tidak diuji: tuasnya hampir tidak dipakai.
- Pada RTT 300 ms **tanpa loss sama sekali**, 24–25% segmen download tetap
  dikirim ulang (508/MiB, semuanya RTO). Ini bukan loss jaringan.
- Sebabnya antrean: KCP menganggap segmen terkirim saat masuk antrean keluar
  dnstt, padahal segmen baru keluar saat ada query untuk dijawab. Dengan window
  2048, antrean rata-rata ~900 paket (maksimum melebihi window karena salinan
  ikut antre). Segmen menunggu lebih lama dari RTO, lalu salinannya ikut antre
  di belakang. Ping saat download ~1 detik pada RTT 60 ms juga berasal dari
  antrean ini.

## Hasil

Median dengan rentang min–maks untuk CPU. Ping dalam ms. "Ping DL" adalah ping
di stream lain saat download berjalan. Ping sepi tidak berbeda antar
konfigurasi di profil mana pun (selisih median ≤ 13 ms, di dalam rentang).

### Seluler: RTT 60 ms, loss 1% per arah (6 putaran)

| Konfigurasi | CPU-s/MiB semua transfer | Down Mbps | Paralel Mbps | Up Mbps | Ping DL p50 | Ping DL p95 | Retransmisi down % |
|---|---:|---:|---:|---:|---:|---:|---:|
| w2048-A (default) | 0,259 (0,215–0,296) | 4,90 | 9,71 | 5,10 | 1001 | 2055 | 34,2 |
| w2048-B (default) | 0,236 (0,200–0,278) | 5,20 | 10,65 | 5,54 | 1035 | 1767 | 31,0 |
| prod-A (tanpa instrumen) | 0,263 (0,197–0,279) | 4,99 | 9,31 | 5,14 | 1029 | 1872 | 34,4 |
| w1024 | 0,233 (0,217–0,324) | 4,63 | 9,21 | 4,54 | 913 | 1747 | 34,5 |
| w512 | 0,272 (0,250–0,285) | 3,81 | 7,44 | 2,42 | 627 | 1178 | 29,7 |
| nodelay0 | 0,249 (0,217–0,316) | 5,12 | 9,93 | 5,70 | 1041 | 1750 | 32,0 |
| dedup | 0,199 (0,175–0,257) | 4,76 | 8,07 | 5,33 | 1514 | 2180 | 8,6 |
| dedup+nodelay0 | 0,206 (0,164–0,261) | 4,98 | 6,14 | 5,73 | 1369 | 1943 | 8,3 |

### RTT 150 ms, loss 1% (6 putaran)

| Konfigurasi | CPU-s/MiB semua transfer | Down Mbps | Paralel Mbps | Up Mbps | Ping DL p50 | Ping DL p95 | Retransmisi down % |
|---|---:|---:|---:|---:|---:|---:|---:|
| w2048-A (default) | 0,188 (0,153–0,318) | 2,68 | 5,02 | 3,36 | 2212 | 3698 | 32,4 |
| w2048-B (default) | 0,232 (0,165–0,338) | 2,95 | 3,40 | 3,27 | 2087 | 3468 | 32,8 |
| w1024 | 0,230 (0,164–0,270) | 2,80 | 4,74 | 2,11 | 1734 | 3267 | 37,0 |
| w512 | 0,245 (0,176–0,309) | 1,93 | 3,30 | 1,21 | 1548 | 2780 | 32,6 |
| nodelay0 | 0,225 (0,167–0,279) | 2,33 | 4,95 | 3,45 | 2230 | 4998 | 30,5 |
| dedup | 0,190 (0,147–0,311) | 2,28 | 3,95 | 3,33 | 2897 | 5334 | 9,0 |
| dedup+nodelay0 | 0,195 (0,164–0,272) | 1,95 | 3,13 | 3,21 | 3125 | 5094 | 9,2 |

### RTT 300 ms, tanpa loss (6 putaran)

| Konfigurasi | CPU-s/MiB semua transfer | Down Mbps | Paralel Mbps | Up Mbps | Ping DL p50 | Ping DL p95 | Retransmisi down % |
|---|---:|---:|---:|---:|---:|---:|---:|
| w2048-A (default) | 0,217 (0,199–0,263) | 3,14 | 2,84 | 2,75 | 2096 | 3130 | 24,0 |
| w2048-B (default) | 0,191 (0,165–0,270) | 3,14 | 3,01 | 2,89 | 2039 | 3286 | 25,0 |
| w1024 | 0,209 (0,189–0,257) | 2,86 | 2,45 | 2,07 | 795 | 3848 | 23,8 |
| w512 | 0,196 (0,176–0,300) | 3,31 | 2,94 | 1,17 | 487 | 2830 | 14,6 |
| nodelay0 | 0,229 (0,178–0,241) | 3,03 | 2,79 | 2,50 | 2182 | 3508 | 22,8 |
| dedup | 0,199 (0,129–0,250) | 3,11 | 3,09 | 2,86 | 1700 | 3229 | 3,7 |
| dedup+nodelay0 | 0,193 (0,176–0,239) | 3,16 | 2,93 | 2,56 | 1795 | 3130 | 3,1 |

### Resolver dibatasi 1000 query/detik per klien, RTT 60 ms, loss 1% (6 putaran)

Upload mentok ~0,8 Mbps di semua konfigurasi karena batas laju query.

| Konfigurasi | CPU-s/MiB semua transfer | Down Mbps | Paralel Mbps | Up Mbps | Ping DL p50 | Ping DL p95 | Retransmisi down % |
|---|---:|---:|---:|---:|---:|---:|---:|
| w2048-A (default) | 0,229 (0,156–0,333) | 3,43 | 6,43 | 0,79 | 1720 | 2349 | 35,9 |
| w2048-B (default) | 0,218 (0,156–0,292) | 3,48 | 8,41 | 0,79 | 1662 | 2202 | 39,6 |
| w1024 | 0,193 (0,140–0,248) | 3,24 | 6,72 | 0,78 | 1291 | 2792 | 39,3 |
| w512 | 0,193 (0,178–0,263) | 3,51 | 6,07 | 0,76 | 804 | 1501 | 30,8 |
| nodelay0 | 0,170 (0,160–0,298) | 3,53 | 7,66 | 0,80 | 1658 | 2339 | 37,5 |
| dedup | 0,213 (0,171–0,254) | 3,17 | 5,74 | 0,80 | 1779 | 3596 | 23,6 |
| dedup+nodelay0 | 0,216 (0,186–0,267) | 3,79 | 7,06 | 0,80 | 1543 | 3025 | 21,1 |

### Profil CPU: seluler, download 8 MiB, pprof aktif (3 putaran)

| Konfigurasi | CPU-s/MiB semua transfer | Down Mbps | Paralel Mbps | Up Mbps | Ping DL p50 | Ping DL p95 | Retransmisi down % |
|---|---:|---:|---:|---:|---:|---:|---:|
| base (w2048) | 0,172 (0,130–0,175) | 4,93 | 12,21 | 5,44 | 1238 | 2151 | 29,2 |
| dedup | 0,155 (0,155–0,174) | 4,81 | 6,52 | 5,88 | 1423 | 2792 | 8,0 |

## Penilaian per opsi

| Opsi | CPU turun melebihi A/A? | Download/paralel tetap? | Ping tidak naik? | Hasil |
|---|---|---|---|---|
| Buang duplikat (`dedup`) | Hanya seluler (−16 s/d −24%) dan profil CPU (−10%). RTT 150, RTT 300, resolver: di dalam noise | Tidak. Paralel −17 s/d −24% (seluler), −47% (profil CPU). Download −15 s/d −23% (RTT 150) | Tidak. Ping DL p50 +46 s/d +51% (seluler), +31 s/d +39% (RTT 150), p95 +53% (resolver) | **Gagal** |
| `nodelay0` | Hanya resolver (0,170 vs 0,218–0,229). RTT 300 malah di atas A/A | Download RTT 150 turun (2,33 vs 2,68–2,95) | p95 RTT 150 naik (4998 vs 3468–3698) | **Gagal** |
| Window 1024 | Tidak, kecuali resolver (−12 s/d −16%, tipis di luar A/A) | Download −6 s/d −11% (seluler, RTT 300, resolver), paralel −14 s/d −19% (RTT 300), upload −11 s/d −37% | p50 turun, tetapi p95 naik di RTT 300 dan resolver | **Gagal** |
| Window 512 | Tidak (seluler malah 0,272) | Download −22 s/d −35% (seluler, RTT 150), upload −53 s/d −63% | p50 turun banyak | **Gagal** |

Catatan per opsi:

- **Buang duplikat.** Retransmisi di jaringan turun dari ~33% ke ~8% dan query
  per MiB download turun ~22%, tetapi pemulihan loss jadi lambat. kcp-go
  memperbarui `ts` segmen setiap kali retransmisi dijadwalkan, termasuk yang
  dibuang prototipe ini. `parse_fastack` hanya menghitung segmen dengan
  `ts` lebih tua dari ACK yang datang, jadi segmen itu tidak lagi bisa
  di-fast-resend, dan loss sungguhan menunggu RTO berikutnya yang sudah
  di-backoff. Salinan ganda yang terlihat boros ternyata ikut berfungsi sebagai
  pemulihan cepat. Memperbaikinya kemungkinan butuh mengubah kcp-go (ts hanya
  diperbarui saat segmen benar-benar keluar), dan itu di luar patch dnstt. Prototipe tetap
  ada di `scripts/go/slowdns-bench/sc_dedup.go` untuk mengulang uji. Jangan
  pindahkan ke installer.
- **nodelay0.** Saat download, srtt sudah 300–1000 ms, jauh di atas RTO
  minimum 30 atau 100 ms, jadi beda nodelay hanya di backoff. Tidak ada
  mekanisme yang menjelaskan penghematan di profil resolver, dan arahnya
  berbalik di RTT 300. Itu noise.
- **Window lebih kecil** memendekkan antrean (ping saat download turun, RAM
  puncak turun dari 64–76 MiB ke 58–65 MiB pada 1024 dan 44–46 MiB pada 512),
  tetapi tidak menurunkan CPU per MiB, dan upload ikut turun karena window
  terima juga mengecil. Bukan alat penghemat CPU.

Selisih A/A sendiri besar: 5% (resolver), 10–11% (seluler), 13% (RTT 300),
sampai 23% (RTT 150) pada median CPU, dan sampai 48% pada median download
paralel (RTT 150). Selisih di bawah angka itu tidak boleh diklaim.

## Ke mana CPU pergi

pprof CPU fase download (base, 3 putaran, Windows):

| Bagian | Porsi sampel |
|---|---:|
| Kirim UDP (`UDPConn.WriteTo`, syscall) | 16,7% |
| Terima UDP (`UDPConn.ReadFrom`) | 3,3% |
| Scheduler Go, netpoll, timer (bangun/tidur goroutine) | ±25% |
| `TimedSched` KCP di luar logika KCP (select, reset timer, heap) | ±19% |
| Logika KCP (`update`/`flush`, `Input`) | ±9% |
| Parse dan susun DNS | ±5% |
| smux + Noise (ChaCha20-Poly1305 <1%) | ±3% |
| Sampler instrumen (bukan produksi) | 3,6% |
| GC | <0,5% (di bawah ambang tampil) |

Sebagian besar CPU adalah **overhead per paket**: syscall UDP satu paket per
panggilan, serah-terima antar goroutine lewat channel, dan timer yang
dibangunkan per jawaban/sesi. Logika protokol dan kriptografi kecil. Karena
itu CPU mengikuti **jumlah query**, bukan jumlah byte, dan setelan KCP hanya
menggeser sedikit:

| Fase (median, A/A gabungan, profil tanpa batas laju) | Query per MiB | CPU per query |
|---|---:|---:|
| Download satu stream | 1800–2150 | 71–107 µs |
| Download paralel | 2200–2700 | 60–85 µs |
| Upload | 10.800–12.400 | 29–45 µs |

Upload memakan query 5–6× lebih banyak per MiB karena satu query hanya membawa
sekitar 100–140 byte data, sedangkan satu jawaban membawa sampai MTU sesi. Di
lab, CPU per MiB upload sekitar 2–3× download. Ini sejalan dengan data lapangan yang
jawabannya rata-rata hanya 192 byte.

Porsi syscall dan scheduler di Linux berbeda dari Windows (syscall Windows
lewat `cgocall`). Polanya, yaitu overhead per paket lebih besar daripada kerja
protokol, kemungkinan sama, tetapi angka persennya hanya indikasi.

## Memori

Delapan sesi sibuk sekaligus (download paralel 8 × 2 MiB, 8 klien idle,
RTT 60 ms, loss 1%, window 2048, 4 putaran) dengan `GOMEMLIMIT` berbeda:

| GOMEMLIMIT | CPU-s/MiB semua transfer | Paralel Mbps | Ping DL p50 | RAM puncak MiB |
|---|---:|---:|---:|---:|
| 96 MiB, A (tier 1 GB) | 0,176 (0,156–0,188) | 19,3 | 1203 | 97,4 |
| 96 MiB, B (tier 1 GB) | 0,168 (0,156–0,183) | 20,5 | 1057 | 95,0 |
| 48 MiB | 0,161 (0,148–0,183) | 21,1 | 953 | 52,9 |
| 512 MiB | 0,160 (0,155–0,171) | 21,0 | 1097 | 122,9 |

- Tanpa batas ketat, delapan sesi sibuk naik ke ~123 MiB karena `GOGC=300`
  membiarkan heap tumbuh. `GOMEMLIMIT` menahannya di batas tanpa menaikkan CPU
  per MiB, bahkan di 48 MiB. Heap yang benar-benar dipakai di lab berada di
  bawah 48 MiB, jadi GC tambahan murah.
- **Dibantah sebagian oleh uji VPS:** memori di atas batas tidak membuat CPU
  tinggi dengan sendirinya (lihat [Uji di VPS](#uji-di-vps-9-november-2026)).
  Dugaan awal sebelum uji itu:
  di lapangan RSS mencapai 128 MB, jauh di atas `GOMEMLIMIT` 96 MiB. Selisih
  sebesar itu biasanya berarti memori Go yang masih dipakai memang lebih besar
  dari batas, karena runtime mengembalikan memori bebas ke OS saat mendekati
  `GOMEMLIMIT`. Dalam keadaan itu GC berjalan hampir terus (runtime
  membatasinya sekitar 50% CPU), dan cgroup menekan sisanya ke swap. Ini
  kandidat kuat penyebab biaya per query lapangan 3–10× lab, **tetapi belum
  terbukti**: belum ada data GC dari VPS, dan lab dengan klien upstream belum
  bisa membuat heap sebesar itu. Aplikasi yang membuka banyak sesi (terlihat 7
  koneksi SSH) dan antrean keluar yang lebih panjang bisa menjelaskannya.
- Kalau cek di VPS membuktikan tekanan memori, langkah untuk VPS itu adalah
  menaikkan `SLOWDNS_MEMORY_MAX` (`GOMEMLIMIT` ikut 75%-nya), lalu mengukur
  ulang. Default tier 1 GB tidak diubah tanpa data itu, karena RAM 1 GB juga
  dipakai layanan lain.

## Apa artinya untuk VPS 1 vCPU

- Dalam keadaan sehat biaya per query di VPS 71–178 µs, jadi satu vCPU
  melayani kira-kira 5.000–14.000 query/detik. Speed test satu pengguna hanya
  memakai 12–16% satu core. dnstt 80–95% satu core dengan trafik kecil adalah
  keadaan macet, bukan batas kapasitas.
- Penggunaan normal (browsing, chat, streaming yang menyesuaikan bitrate)
  memakai jauh lebih sedikit query daripada speed test. Upload besar adalah
  beban paling mahal per MiB.
- Kandidat riset berikutnya yang menyasar overhead per paket, dan **harus
  diukur di VPS Linux** (tidak bisa diukur di Windows):
  1. Batch syscall `recvmmsg`/`sendmmsg` lewat `golang.org/x/net/ipv4`
     (`ReadBatch`/`WriteBatch`). Modul itu sudah jadi dependensi kcp-go, jadi
     tidak perlu dependensi baru.
  2. Mengurangi serah-terima goroutine dan timer per jawaban di `sendLoop`
     (sekarang satu `time.NewTimer` per query).
  3. Batas laju query per klien di server sebagai perlindungan pengguna lain
     saat satu orang speed test. Ini menukar speed puncak dengan keadilan,
     jadi butuh keputusan pemilik.

## Rekomendasi

1. **Default tidak diubah.** Window tetap `kcp_window()` per tier (2048 di
   1 GB), interval 10 ms, ACK biasa. Tidak ada nilai `SLOWDNS_KCP_WINDOW`
   yang direkomendasikan untuk penghematan CPU. Window 1024 hanya relevan kalau
   pemilik VPS lebih mementingkan ping saat download daripada speed, dan tetap
   harus diuji di VPS itu.
2. Tidak ada opsi env baru, `DNSTT_PATCH_ID` tetap `sc-fast8`, dan VPS tidak
   membangun ulang binary karena update ini.
3. **Langkah berikutnya: tangkap keadaan macet saat terjadi lagi.** Aktifkan
   gctrace, pantau tanda macet (CPU ≥60% satu core selama ≥60 detik dengan
   CPU per query ≥2 ms), lalu ambil snapshot sesi (`sc-1forcr-slowdns
   sessions`), memori, gctrace terakhir, dan dump goroutine (`SIGQUIT`, yang
   sekaligus me-restart dnstt). Dari situ baru diputuskan perbaikannya
   (penutupan sesi lama di patch dnstt, atau pengawas yang me-restart dnstt).
   Menaikkan batas memori tidak disarankan.

## Cek di VPS

Memori service (cgroup v2), sebelum dan sesudah speed test:

```bash
CG=/sys/fs/cgroup$(systemctl show sc-1forcr-slowdns -p ControlGroup --value)
systemctl show sc-1forcr-slowdns -p MemoryCurrent -p MemoryMax
cat "$CG/memory.events"        # high/max/oom yang naik = mentok batas
cat "$CG/memory.peak" 2>/dev/null
cat "$CG/memory.swap.current" 2>/dev/null
grep -E '^(anon|file|pgmajfault) ' "$CG/memory.stat"
```

Frekuensi GC (sementara, memutus sesi SlowDNS saat restart, lakukan di luar
jam ramai):

```bash
D=/etc/systemd/system/sc-1forcr-slowdns.service.d
mkdir -p "$D" && printf '[Service]\nEnvironment=GODEBUG=gctrace=1\n' > "$D/99-gctrace.conf"
systemctl daemon-reload && systemctl restart sc-1forcr-slowdns
# jalankan speed test, lalu hitung siklus GC 2 menit terakhir:
journalctl -u sc-1forcr-slowdns --since "-2 min" | grep -c ' gc '
# kembalikan:
rm -f "$D/99-gctrace.conf" && systemctl daemon-reload && systemctl restart sc-1forcr-slowdns
```

Setiap baris gctrace diawali `gc N @DETIKs P%:`. `P%` adalah porsi CPU yang
sudah dipakai GC sejak service start. Kalau `P%` naik tajam selama speed test,
atau siklus GC muncul puluhan kali per detik, heap menempel ke `GOMEMLIMIT`.
Uji kenaikan batas untuk VPS itu saja:

```bash
sed -i 's/^SLOWDNS_MEMORY_MAX=.*/SLOWDNS_MEMORY_MAX=192M/' /etc/sc-1forcr.env
grep -q '^SLOWDNS_MEMORY_MAX=' /etc/sc-1forcr.env || echo 'SLOWDNS_MEMORY_MAX=192M' >> /etc/sc-1forcr.env
sc-1forcr-slowdns setup     # menulis unit baru dan me-restart SlowDNS
# kembalikan: ganti 192M dengan auto, lalu setup lagi
```

Bandingkan CPU per query, speed, dan `memory.events` sebelum dan sesudahnya. Jumlah sesi dan stream per akun: `sc-1forcr-slowdns online`.
Untuk memisahkan download dan upload, jalankan `cek-cpu-slowdns.sh` dua kali:
satu saat hanya mengunduh file besar, satu saat hanya upload.

## Batas verifikasi

- Semua angka berasal dari laptop Windows, bukan VPS Linux. Syscall, timer, dan
  akuntansi CPU (`Get-Process`, granularitas ±15,6 ms) berbeda dari VM 1 vCPU.
- Klien adalah `dnstt-client` upstream dengan TXT dan EDNS 4096. 1FTunnel dan
  HTTP Custom memakai NULL, laju query, dan setelan KCP sendiri. Data lapangan
  (jawaban rata-rata 192 byte) menunjukkan pola query aplikasi berbeda dari
  klien upstream.
- Resolver tiruan hanya meniru delay tetap, loss acak, dan batas laju
  sederhana. Resolver publik bisa menahan, menggabungkan, atau mengulang query.
- Noise A/A besar (lihat di atas). 6 putaran cukup untuk menolak opsi yang
  memperburuk ping/speed secara konsisten, tidak cukup untuk membuktikan
  penghematan di bawah ~10–20%.
- pprof Windows hanya indikasi porsi. Persentase syscall/scheduler di Linux
  bisa berbeda.

## Mengulang

Bangun binary uji dari zip resmi `DNSTT_VERSION` (cocokkan sha256 dengan
`DNSTT_ZIP_SHA256`) yang dipatch `SLOWDNS_PATCH_PY` dari installer. Butuh
Go ≥1.21 dan Python 3.8+:

```bash
V=v1.20260501.0
curl -fsSLo /tmp/dnstt.zip "https://proxy.golang.org/www.bamsoftware.com/git/dnstt.git/@v/$V.zip"
sha256sum /tmp/dnstt.zip   # harus sama dengan DNSTT_ZIP_SHA256
sed -n "/<<'SLOWDNS_PATCH_PY'$/,/^SLOWDNS_PATCH_PY$/p" scripts/setup-autoscript-compat.sh   | sed '1d;$d' > /tmp/sc-patch.py
python3 -I /tmp/sc-patch.py /tmp/dnstt.zip /tmp/dnstt-src "$V"
bash scripts/go/slowdns-bench/build-bench-tree.sh   "/tmp/dnstt-src/www.bamsoftware.com/git/dnstt.git@$V" /tmp/sdbench
DNSTT_NATIVE_DIR=/tmp/sdbench/bin node scripts/bench-slowdns-kcp.js \
  --rounds 6 --rtt 60 --loss 1 --down-mib 4 --up-mib 0.5 --parallel 4 --par-mib 1 \
  --idle-clients 4 --pings 30 --phases ping,download,upload,parallel --instr 1 \
  --configs 'w2048-A=SLOWDNS_KCP_WINDOW=2048;w2048-B=SLOWDNS_KCP_WINDOW=2048;w1024=SLOWDNS_KCP_WINDOW=1024;nodelay0=SC_BENCH_NODELAY=0;dedup=SC_BENCH_DEDUP=1' \
  --json /tmp/sdbench/hasil.json
```

Tambahkan `--rtt 150`, `--rtt 300 --loss 0`, atau `--resolver-qps 1000` untuk
profil lain, dan `--profile-dir DIR` untuk pprof. Kunci `SC_BENCH_*` hanya
dibaca build uji. Binary produksi mengabaikannya, jadi pembanding `BIN=<dir>`
tanpa instrumen hanya bisa memakai `SLOWDNS_KCP_*` dan `GO*`.

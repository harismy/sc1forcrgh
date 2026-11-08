# Uji CPU KCP SlowDNS V.1FSC.125 (patch sc-fast8)

Pembanding Potato memakai KCP `SetNoDelay(1,20,2,1)` dan `SetACKNoDelay(true)`
(lihat [perbandingan](perbandingan-slowdns-potato-vs-sc.md)). Temuan itu belum
membuktikan CPU lebih hemat pada throughput yang sama. V.1FSC.125 membuat dua
pengaturan itu bisa dicoba terpisah tanpa rebuild, lalu mengukurnya.

## Perubahan

- `sc_kcp.go` membaca `SLOWDNS_KCP_INTERVAL` (10-50 ms) dan
  `SLOWDNS_KCP_ACK_NODELAY` (0/1) sekali saat service start. Nilai kosong,
  rusak, atau di luar batas kembali ke default 10 ms dan ACK biasa, sama
  dengan `sc-fast7`. Log start mencatat nilai yang dipakai:
  `KCP interval 10 ms ack-nodelay false window 2048`.
- Window tetap mengikuti `kcp_window()` per tier. Window 512 dan buffer smux
  Potato tidak disalin. MTU per sesi, EDNS, semua tipe record, kunci/pubkey,
  GOMAXPROCS, GOGC, batas memori, monitor akun online, auto-lock, dan
  notifikasi tidak berubah.
- Helper `sc-1forcr-slowdns` menulis kedua nilai ke unit lewat
  `kcp_interval`/`kcp_ack_nodelay`. Perintah `set-kcp INTERVAL ACK` atau
  `set-kcp default`, serta menu Tools > SlowDNS > 9, menyimpan nilai ke
  `/etc/sc-1forcr.env` lalu menjalankan setup. Jika service gagal start,
  nilai lama dipulihkan.
- Kedua kunci ikut dump `/etc/sc-1forcr.env`, `persist_pending_install_env`,
  dan daftar env update dari menu, sehingga bertahan pada install penuh dan
  update aman.
- `DNSTT_PATCH_ID` naik ke `sc-fast8`, jadi VPS dengan SlowDNS aktif membangun
  ulang binary saat update. Build gagal tetap memakai binary lama.
- Patch Python `sc-fast7` memakai `Path.write_text(newline=)`, yang baru ada di
  Python 3.10. Ubuntu 20.04 (3.8) dan Debian 11 (3.9) akan gagal membangun
  binary. V.125 menggantinya dengan `io.open`, dengan isi file yang sama.

## Cara uji

9 November 2026, laptop Windows 11 amd64 (Intel Core i5-1035G7, 4 core/8
thread), Go 1.26.6, binary `dnstt-server` dan `dnstt-client` hasil build lokal
dari source yang dipatch installer. Pengukuran memakai
`scripts/bench-slowdns-kcp.js` (`npm run bench:slowdns-kcp`):

- Server: `-mtu 1232`, `SLOWDNS_KCP_WINDOW=2048` (tier 1 GB) untuk semua
  konfigurasi, `GOMAXPROCS=1` (meniru 1 vCPU), `GOGC=300`, `GOMEMLIMIT=96MiB`.
- Klien: `dnstt-client` upstream (record TXT, EDNS 4096), sama untuk semua
  konfigurasi. Aplikasi HTTP Custom dan sejenisnya bisa memakai setelan KCP
  berbeda.
- Resolver tiruan di antara klien dan server: delay satu arah tetap, loss acak
  dengan seed sama, satu socket per klien. Resolver juga membaca segmen KCP
  yang lewat untuk menghitung retransmisi (segmen PUSH dengan `conv:sn` yang
  sudah pernah lewat) dan query yang tidak pernah dijawab server.
- Backend TCP lokal menggantikan Dropbear. CPU yang dihitung hanya milik proses
  `dnstt-server`, dibaca lewat `Get-Process` sebelum dan sesudah tiap fase.
- Fase per putaran: idle 9 klien, 30 ping 64 byte, download 4 MiB dari satu
  klien sambil ping di stream lain, upload 1 MiB, lalu download paralel 4 x 1
  MiB. Tiap putaran memakai proses server dan klien baru, dengan urutan
  konfigurasi diputar. Binary lama `sc-fast7` ikut diuji sebagai pembanding
  A/A: perilakunya identik dengan default `sc-fast8`, jadi selisih keduanya
  menunjukkan besar noise.

Nilai di tabel adalah median, dengan rentang min–maks di dalam kurung.

## Hasil

### Profil seluler: RTT 60 ms, loss 1% per arah (9 putaran)

| Konfigurasi | Semua transfer CPU-s/MiB | Download Mbps | Paralel Mbps | Upload CPU-s/MiB | Ping sepi p50 ms | Ping sepi p95 ms | Retransmisi download % |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10 ms, ACK biasa (default) | 0,191 (0,160–0,227) | 4,71 (3,91–5,63) | 10,0 (5,8–15,3) | 0,422 (0,297–0,516) | 78 (64–131) | 171 (127–351) | 34,6 (25,3–37,1) |
| 20 ms, ACK biasa | 0,184 (0,153–0,219) | 5,05 (4,65–5,85) | 8,4 (6,5–11,0) | 0,391 (0,344–0,547) | 74 (65–127) | 290 (146–590) | 28,7 (26,3–38,2) |
| 10 ms, ACK langsung | 0,179 (0,156–0,226) | 5,35 (3,50–7,03) | 8,6 (4,5–13,0) | 0,438 (0,313–0,578) | 130 (77–134) | 290 (147–465) | 29,7 (24,2–39,5) |
| 20 ms, ACK langsung | 0,189 (0,151–0,222) | 4,84 (3,61–5,66) | 11,4 (7,4–14,7) | 0,500 (0,391–0,688) | 129 (83–140) | 233 (141–482) | 34,0 (29,0–49,3) |
| Pembanding `sc-fast7` | 0,186 (0,161–0,236) | 5,11 (3,79–7,15) | 9,4 (7,1–13,3) | 0,375 (0,281–0,531) | 68 (65–78) | 151 (141–200) | 31,4 (20,9–45,2) |

Ping saat download (stream lain, klien sama) berada di kisaran 0,9–1,4 detik
(median per konfigurasi) untuk semua konfigurasi. RAM puncak 57–71 MiB tanpa
pola yang konsisten.

### Profil lokal: tanpa delay dan loss, CPU menjadi batas (3 putaran)

| Konfigurasi | Download Mbps | Download CPU-s/MiB | Paralel Mbps | Paralel CPU-s/MiB | Upload CPU-s/MiB | Semua transfer CPU-s/MiB | RAM puncak MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10 ms, ACK biasa (default) | 31,0 (29,9–33,4) | 0,082 (0,064–0,096) | 54,6 (37,6–54,7) | 0,072 (0,070–0,080) | 0,313 (0,281–0,375) | 0,103 (0,091–0,120) | 76,1 |
| 20 ms, ACK biasa | 32,0 (28,0–35,2) | 0,084 (0,066–0,092) | 57,6 (50,8–60,8) | 0,061 (0,061–0,070) | 0,297 (0,297–0,367) | 0,101 (0,097–0,102) | 71,4 |
| 10 ms, ACK langsung | 32,5 (27,3–32,8) | 0,084 (0,072–0,090) | 54,4 (49,7–62,7) | 0,076 (0,061–0,080) | 0,367 (0,328–0,391) | 0,105 (0,104–0,117) | 81,8 |
| 20 ms, ACK langsung | 34,3 (32,0–38,5) | 0,084 (0,082–0,098) | 48,7 (46,4–48,8) | 0,070 (0,068–0,086) | 0,406 (0,367–0,461) | 0,120 (0,115–0,120) | 71,6 |
| Pembanding `sc-fast7` | 35,8 (30,9–36,6) | 0,082 (0,070–0,086) | 55,5 (52,6–56,3) | 0,068 (0,055–0,080) | 0,359 (0,266–0,367) | 0,107 (0,092–0,108) | 69,5 |

### Idle: 41 klien tersambung tanpa transfer, RTT 60 ms, loss 1% (4 putaran)

| Konfigurasi | CPU % satu core | CPU-ms per detik | Query/detik | RAM puncak MiB |
|---|---:|---:|---:|---:|
| 10 ms, ACK biasa (default) | 2,42 (2,24–2,81) | 24,2 | 38,2 | 40,1 |
| 20 ms, ACK biasa | 1,95 (1,77–2,24) | 19,5 | 39,8 | 44,2 |
| 10 ms, ACK langsung | 2,68 (2,45–3,18) | 26,8 | 36,2 | 38,5 |
| 20 ms, ACK langsung | 1,80 (1,46–1,98) | 18,0 | 36,8 | 39,7 |

## Kesimpulan

1. **CPU per MiB saat transfer tidak berubah secara terukur.** Di profil seluler
   semua konfigurasi berada di 0,179–0,191 CPU-s/MiB, sedangkan pembanding A/A
   `sc-fast7` 0,186. Selisih paling besar sekitar 4%, jauh di dalam rentang
   antar-putaran (0,15–0,24). Profil lokal yang dibatasi CPU memberi hasil
   serupa (0,101–0,120). Throughput juga tidak berubah konsisten. Jadi tidak ada
   dasar menyebut interval 20 ms atau ACK langsung lebih hemat CPU per data.
2. **Interval 20 ms menghemat CPU saat idle.** Dengan 41 sesi tersambung tanpa
   transfer, CPU turun dari median 2,42% menjadi 1,95% satu core (sekitar 19%),
   dengan laju query yang sama. Ini sesuai dengan timer KCP per sesi yang
   berjalan 50 kali per detik alih-alih 100. Nilai absolutnya kecil, sekitar
   0,5% satu core per 41 sesi idle.
3. **ACK langsung memperburuk latensi.** Ping sepi naik dari median 68–78 ms
   menjadi 129–130 ms, sekitar satu RTT tambahan, konsisten di hampir semua
   putaran. Jawaban DNS hanya bisa dikirim saat ada query. Dengan ACK langsung,
   ACK kosong memakai query yang sedang menunggu, sehingga data balasan harus
   menunggu query berikutnya. ACK langsung juga cenderung menaikkan CPU upload
   per MiB (0,438–0,500 vs 0,375–0,422 di seluler; 0,367–0,406 vs 0,297–0,359
   di lokal) dan tidak memberi penghematan idle tambahan.
4. **Interval 20 ms mungkin memperpanjang ekor latensi saat ada loss.** Ping
   sepi p95 di profil seluler 290 ms vs 171 ms (default) dan 151 ms
   (pembanding), tetapi rentangnya tumpang tindih. Dengan 30 ping per putaran,
   p95 bergantung pada satu atau dua ping yang terkena loss. Ini belum pasti
   dan harus diperhatikan saat uji di VPS.

Rekomendasi: pertahankan default 10 ms dan ACK biasa. Satu-satunya kandidat
yang layak diuji di VPS adalah `set-kcp 20 0`, untuk VPS dengan banyak sesi
SlowDNS yang tersambung tetapi jarang transfer. Bandingkan CPU proses
`dnstt-server`, speed test, dan ping di jam ramai yang sama sebelum memakainya
permanen. `set-kcp 10 1` dan `set-kcp 20 1` tidak direkomendasikan.

## Temuan lain: retransmisi palsu saat download

Pada semua konfigurasi, termasuk binary lama, sekitar 29–35% segmen PUSH KCP
yang dikirim server saat download di profil seluler adalah retransmisi. Di
profil lokal tanpa loss angkanya 12–16%. Loss acak 1% hanya menjelaskan
sekitar 1–2%. Ping saat download sekitar 1 detik menunjukkan antrean keluar
yang panjang. Dengan window 2048, segmen dapat menunggu query lebih lama dari
RTO KCP, lalu dikirim ulang walau salinan pertama belum hilang. Salinan ganda
memakan kapasitas jawaban DNS dan CPU encoding.

Ini kemungkinan pengungkit CPU dan speed yang lebih besar daripada interval
atau ACK, tetapi menyangkut window atau RTO. Window sengaja tidak diubah di
V.1FSC.125. Uji terpisah yang disarankan: window 512/1024, atau batas RTO
minimum, dengan syarat throughput dan ping tidak turun. Temuan ini berasal dari
emulasi dengan klien upstream, jadi perlu dikonfirmasi dengan aplikasi
sungguhan.

## Batas verifikasi

- Belum ada pengukuran di VPS Linux. Semua angka berasal dari Windows,
  termasuk socket UDP, timer Go, dan akuntansi CPU (`Get-Process`, granularitas
  sekitar 15,6 ms). Skrip mendukung Linux (`/proc`, termasuk drop socket UDP),
  tetapi belum dijalankan di sana. Drop socket UDP tidak bisa dibaca di Windows
  dan tercatat `n/a`.
- Klien yang dipakai adalah `dnstt-client` upstream dengan TXT. Aplikasi
  injector (NULL, setelan KCP sendiri, resolver operator) bisa berperilaku
  berbeda.
- Resolver tiruan tidak membatasi laju query. Upload 1 MiB menghasilkan sekitar
  9000 query/detik dari satu klien, sehingga antrean 100 query di server penuh
  dan 2000–3700 query per putaran tidak dijawab. Polanya sama di semua
  konfigurasi termasuk pembanding, jadi ini artefak beban uji, bukan efek
  interval atau ACK.
- Binary Potato tidak diuji. Perbandingan hanya antar-konfigurasi SC.
- Tidak ada persentase penghematan CPU VPS yang bisa diklaim dari uji ini,
  kecuali penurunan CPU idle relatif pada kondisi uji di atas.

## Mengulang di VPS

Bangun `dnstt-server` dan `dnstt-client` dari [source ekspor](slowdns-source/README.md)
untuk Linux. Jalankan di VPS uji atau di luar jam ramai, karena benchmark
memakai CPU:

```bash
DNSTT_NATIVE_DIR=/root/dnstt-bin node scripts/bench-slowdns-kcp.js \
  --rounds 6 --rtt 60 --loss 1 --json /root/kcp-bench.json
DNSTT_NATIVE_DIR=/root/dnstt-bin node scripts/bench-slowdns-kcp.js \
  --rounds 4 --phases idle --idle-clients 40 --idle-sec 30
```

Hasil di VPS produksi tetap perlu dibandingkan lewat `set-kcp` pada jam ramai
yang sama, karena beban pengguna nyata tidak bisa ditiru sepenuhnya.

## Pengujian

- `go test ./...` pada source hasil patch, termasuk
  `slowdns_kcp_tuning_test.go` (parse interval/ACK, nilai rusak, env).
- Cross-build `GOOS=linux` amd64 dan arm64.
- `npm run test:slowdns`: helper (default unit 10/0, `set-kcp`, rollback saat
  service gagal start, env rusak, status), persistensi env, menu.
- `npm run test:slowdns-native` dengan `DNSTT_NATIVE_DIR`: transport
  DNS/Noise/KCP/smux TXT+NULL untuk lima konfigurasi (empat kombinasi + env
  rusak). Log start server dicek agar nilai yang dipakai binary sesuai.

# Perbandingan SlowDNS PotatoNC dan SC 1FORCR

Tanggal pemeriksaan lokal: 8 November 2026.

## Hasil utama

Ada perbedaan pengaturan yang masuk akal untuk menjelaskan mengapa Potato
terlihat lebih ringan saat trafik aktif: binary yang diperiksa mengatur KCP
dengan interval 20 ms dan window 512 paket. SC 1FORCR memakai interval 10 ms
dan window 2048–4096 paket sesuai tier VPS.

Ini membuktikan perbedaan konfigurasi, belum membuktikan persentase penghematan
CPU. Belum dilakukan pengujian kedua binary pada mesin, klien, resolver,
throughput, RTT, dan packet loss yang sama. Memperkecil window juga bisa
menurunkan kecepatan. Potato justru menyediakan batas buffer smux lebih besar.

## Bahan yang benar-benar tersedia

Potato diperiksa dari `C:\ALL Project\potatoooooo`:

- `dns-server`: binary Linux amd64, bukan source Go.
- `slowdns-universal-kit/.../docs/DOKUMENTASI-SLOWDNS.md`: catatan instalasi
  Potato bertanggal 3 November 2026, bukan kondisi VPS saat pemeriksaan ini.
- README, panduan universal, dan skrip installer/helper Bash.

Tidak ada source Go binary Potato di folder maupun ZIP tersebut. Installer
universal mempunyai dua jalur: memakai binary melalui `BIN_SOURCE`, atau
meng-clone dan membangun DNSTT upstream. Hasil build upstream itu tidak boleh
dianggap identik dengan binary Potato yang dimodifikasi.

SC dibandingkan dengan installer saat ini, V.1FSC.124 / patch `sc-fast7`, dan
source hasil ekspornya di [slowdns-source](slowdns-source/README.md).
Seluruh 22 checksum source dalam manifest cocok; checksum patch embedded juga
cocok dengan manifest setelah diekstrak tanpa menambahkan newline.

## Arsitektur dan fitur

Kedua implementasi memakai susunan transport yang sama:

```text
HP / klien
  → resolver DNS
  → VPS UDP 53
  → redirect kernel ke UDP 5300
  → decode DNS / ClientID
  → KCP: menyusun paket dan retransmisi
  → Noise: kanal terenkripsi
  → smux: stream TCP di dalam satu sesi
  → Dropbear lokal: autentikasi SSH dan forwarding
  → internet
```

Urutan penerimaan di server adalah KCP sebelum Noise. Noise membutuhkan aliran
reliabel yang disediakan KCP. SSH memberikan lapisan enkripsi dan autentikasi
akun tersendiri di atas tunnel tersebut pada kedua SC.

| Aspek | Potato yang diperiksa | SC 1FORCR saat ini |
|---|---|---|
| Backend sesuai dokumentasi/config | Dropbear `127.0.0.1:90` | Dropbear `127.0.0.1:109` |
| Pengguna unit | `root` | User sistem khusus SlowDNS |
| Proses server pada jalur utama | `dns-server` | `dnstt-server` |
| Client DNSTT di VPS | Dokumentasi menyatakan disabled | Tidak dibutuhkan pada jalur produksi |
| Batas respons DNS | Default terdokumentasi 1232 byte | Default 1232 byte |
| Record | Dokumentasi menyebut mode numerik 1–6/auto; pemetaan codec belum diverifikasi | TXT, NULL, NS, CNAME, MX, SRV, A, AAAA |
| Status akun dan lock khusus SlowDNS | Tidak disediakan oleh helper dalam paket yang diperiksa | Snapshot socket + tracker SSH + checker akun |
| Batas memori service | Tidak dicantumkan pada unit Potato dalam dokumentasi | `MemoryMax` 128/192/256M, `GOMEMLIMIT` 75% darinya |
| GC dan core | Unit terdokumentasi tidak menetapkan `GOGC`/`GOMAXPROCS`; perilaku runtime binary belum dipastikan | `GOGC=300`, `GOMAXPROCS` mengikuti `nproc` kecuali override |

Perbedaan port backend 90 dan 109 tidak menyediakan penghematan CPU dengan
sendirinya. Menjalankan DNSTT sebagai root juga tidak membuktikan CPU lebih
rendah. Pada SC, rule OUTPUT untuk jawaban SlowDNS sudah disediakan agar user
non-root tetap bisa mengirim respons.

## Pengaturan yang terbaca langsung dari binary Potato

Pemeriksaan dilakukan secara statis. Binary server tidak dijalankan. UPX resmi
5.3.0 dipakai untuk membuka salinan di direktori audit lokal; file asli tetap
utuh. Tabel fungsi Go dan instruksi amd64 kemudian diperiksa, termasuk
pemanggil fungsi konfigurasi pada jalur `AcceptKCP`.

Identitas file:

```text
SHA256 Potato asli:
a9d19e39ae23261628e8f21dac79548b31dceb45f959017bc50300e7ebfcad7d

Ukuran asli:             1.573.712 byte
Ukuran setelah unpack:  5.210.238 byte
```

Ukuran tersebut menjelaskan perbedaan file di disk. Angka itu bukan hasil
pengukuran RAM aktif atau CPU pemrosesan paket.

### KCP

Pada `main.aBfGkdy`, alamat `0x61ee40`, urutan panggilan yang terdeteksi setara
dengan konfigurasi berikut. Ini ringkasan instruksi, bukan source Go asli
Potato yang dipulihkan:

```go
conn.SetStreamMode(true)
conn.SetNoDelay(1, 20, 2, 1)
conn.SetACKNoDelay(true)
conn.SetWriteDelay(false)
conn.SetWindowSize(512, 512)
conn.SetMtu(mtuDariPemanggil)
```

Dasar pembacaan: sebelum `SetNoDelay` pada `0x61ee80`, argumen register berisi
1, `0x14`, 2, 1. Sebelum `SetWindowSize` pada `0x61eeb2`, kedua argumen window
berisi `0x200`. Fungsi ini dipanggil dari `main.xtSadIPoOC` pada `0x62b762`;
fungsi pemanggil juga memanggil `(*Listener).AcceptKCP`.

| Parameter | Potato | SC 1FORCR |
|---|---:|---:|
| Stream mode | Aktif | Aktif |
| NoDelay / fast resend / nc | 1 / 2 / 1 | 1 / 2 / 1 |
| Interval KCP | 20 ms | 10 ms |
| Window kirim dan terima | 512 / 512 | 2048 / 2048 sampai 4096 / 4096 |
| ACK segera | Diaktifkan eksplisit | Tidak diaktifkan; default false pada dependency v5.6.8 |
| Write delay | false eksplisit | Default false pada dependency v5.6.8 |

Interval 20 ms menyediakan interval pembaruan terjadwal yang lebih jarang
daripada 10 ms. Ini kandidat pengurangan pekerjaan timer/scheduler, bukan
rumus bahwa CPU pasti turun separuh: flush saat write/input, ACK segera,
retransmisi, dan beban DNS tetap berpengaruh.

Window 512 membatasi banyaknya paket yang bisa berada dalam aliran KCP.
SC menyediakan window 4–8 kali lebih besar. Jika window kecil mulai membatasi
data yang sedang dikirim tetapi belum diakui, CPU bisa terlihat turun bersama
throughput. Hasil itu perlu dibedakan dari efisiensi pada kecepatan yang sama.
Window besar adalah kapasitas, bukan bukti semua slot selalu terpakai.

### smux

Pembuatan config sebelum `smux.Server` pada `main.hxMYELbk1u`, khususnya
`0x62a637` sampai `0x62a66a`, menetapkan nilai berikut. Offset field sudah
dicocokkan dengan metadata tipe `smux.Config` di binary tersebut.

| Parameter smux | Potato | SC 1FORCR |
|---|---:|---:|
| Version | 2 | 2 |
| KeepAliveInterval | 10 detik | 10 detik |
| KeepAliveTimeout | 120 detik | 120 detik |
| MaxFrameSize | 32 KiB | 32 KiB |
| MaxReceiveBuffer | 16 MiB | 4 MiB |
| MaxStreamBuffer | 4 MiB | 1 MiB |

Nilai buffer adalah batas kapasitas, bukan alokasi RAM yang pasti langsung
terjadi pada setiap sesi. Potato memberi ruang antrean lebih besar pada lapisan
smux, meskipun window KCP-nya lebih kecil. Jadi tidak tepat menyebut seluruh
arsitektur Potato memakai buffer lebih kecil atau pasti lebih hemat RAM.

Binary Potato juga mempunyai jalur `time.NewTimer(1 detik)` pada fungsi yang
menulis paket respons (`main.dL0gaarSYJS`, call `0x6272c0`), berikut operasi
stop/reset dan `encoding/binary.Write`. SC masih mempunyai pola serupa dalam
`sendLoop`. Durasi ini bukan penundaan tetap satu detik untuk setiap respons.
Adanya timer ini tidak boleh diklaim sebagai overhead yang hanya ada pada SC.

## CPU SC: bagian tambahan dan hasil pemeriksaan lokal

SC menyimpan ClientID/EDNS/tipe per sesi dan mempunyai penghitung byte upload
untuk verifikasi tunnel aktif. Snapshot metadata baru diserialisasi saat socket
monitor dibaca. Tidak ada penulisan file atau query database per paket pada
binary DNSTT.

Collector akun dan checker lock berada di luar binary. Pekerjaan `ss`, proses,
tracker autentikasi, dan database bisa menambah CPU total VPS saat dijalankan,
tetapi perlu diukur terpisah dari CPU proses DNSTT. Menonaktifkan penghitungan
online tidak otomatis menghilangkan biaya DNS/KCP pada speed test.

Microbenchmark diulang pada source SC saat ini, Windows amd64, Intel
i5-1035G7, Go 1.27.3, `GOMAXPROCS=2`, `GOGC=300`, tiga pengulangan satu detik:

| Pengujian | Median | Alokasi |
|---|---:|---:|
| `BenchmarkSCRecvLoop` | 2495 ns/query | 840 B/query, 44 alokasi/query |
| `BenchmarkSCClientByteCounter`, write 16 KiB ke `io.Discard` | 17,27 ns/write | 0 B/write, 0 alokasi/write |

Receive benchmark memakai PacketConn tiruan. Counter benchmark hanya mengukur
wrapper penghitung, bukan seluruh monitor/collector. Keduanya tidak mengukur
CPU VPS, syscall UDP, seluruh KCP/Noise/SSH, atau CPU Potato. Angka kecil pada
counter tidak menjamin seluruh fitur monitoring tanpa biaya.

Audit VPS lama pada 6 November mengukur SC V.121/sc-fast5, empat akun dan lima
tunnel, bukan V.124/sc-fast7. Pada fase speed test tercatat sekitar 2977
query/detik dan CPU DNSTT 29,35% dari satu core. Data itu belum menjadi
perbandingan dengan Potato atau hasil setelah optimasi receive V.122.

## Prioritas eksperimen tanpa mengorbankan kecepatan

1. Ukur kedua binary pada VPS/uji terisolasi yang sama, dengan beban payload,
   tipe record, ukuran query, EDNS, resolver, RTT, loss, dan jumlah tunnel sama.
   Pastikan versi executable yang berjalan benar-benar cocok dengan file uji.
2. Pada source SC, uji interval 20 ms dengan window tetap seperti sekarang
   terlebih dahulu. Pisahkan pengujian ACK segera agar penyebab perubahan bisa
   dinilai. Pertahankan MTU, kunci, codec dan pengaturan klien.
3. Window 512 diuji tersendiri. Jika throughput turun atau latensi memburuk,
   angka CPU lebih rendah belum memenuhi tujuan pengguna.
4. Profilkan jalur parse DNS/Base32, bundling respons, timer, copy buffer,
   lock metadata, GC, dan syscall. Pilih optimasi alokasi/kode yang dapat
   menjaga format paket, kepemilikan buffer, dan waktu pengiriman.
5. Nilai buffer UDP per socket dan drop saat beban tinggi. Audit lama menemukan
   riwayat drop SlowDNS dan receive buffer efektif 208 KiB, tetapi probe ulang
   10 detik tidak mengalami drop baru. Jangan menaikkan buffer hanya berdasarkan
   penghitung kumulatif lama atau menganggap Potato mengaturnya berbeda.

Metrik penentu adalah CPU-seconds per MiB payload berhasil, query/detik,
payload per query, throughput, latensi p50/p95, retransmisi, socket drop, dan
RAM puncak. Bedakan CPU DNSTT, Dropbear, collector/checker, serta kernel.
Gunakan basis CPU yang sama: 100% satu core berbeda dari 100% kapasitas VPS.
Ulangi beberapa kali dengan urutan A/B bergantian untuk mengurangi bias beban.

Mengencangkan batas memori dapat menambah kerja GC; itu perlu dibuktikan lewat
profil, bukan ditebak dari adanya `MemoryMax`. Mekanisme dan pertukaran CPU/RAM
dijelaskan dalam [panduan GC resmi Go](https://go.dev/doc/gc-guide).
Pada audit lama RAM service berada jauh di bawah soft limit, sehingga audit
itu belum membuktikan tekanan GC akibat limit sebagai masalah utama.

## Hal yang belum dapat disimpulkan

- Belum ada persentase CPU/RAM Potato pada beban sebanding.
- Versi persis dependency dan toolchain Potato tidak terbaca dari build info.
  Kesamaan nama library tidak membuktikan semua versi/kode identik.
- Klaim calibration/bonding dalam README belum diverifikasi jalur protokolnya.
- Simbol `ReadBatch`/`WriteBatch` memang ada dari library, tetapi keberadaannya
  tidak membuktikan paket DNS Potato diproses dengan batch UDP.
- Dukungan online/lock di seluruh instalasi Potato di luar paket ini tidak
  diaudit. Tidak ada dasar menyatakan semua versi Potato tidak memilikinya.

Hasil ini adalah pemeriksaan lokal source, dokumen, binary, dan microbenchmark.
Tidak ada penggantian binary, perubahan tuning, atau restart pada VPS.

## Rujukan pemeriksaan

- [Source server SC](slowdns-source/dnstt-server/main.go): `acceptSessions`,
  `acceptStreams`, `recvLoop`, dan `sendLoop`.
- [Penghitung dan IPC sesi SC](slowdns-source/dnstt-server/sc_sessions.go).
- [Dependency dan versi SC](slowdns-source/go.mod).
- [Installer SC](../scripts/setup-autoscript-compat.sh): `kcp_window`,
  `go_mem_limit`, `go_maxprocs`, `go_gc`, `unit_content`, `SLOWDNS_PATCH_PY`.
- Potato: dokumentasi dan installer pada folder yang diberikan pengguna.
- [UPX resmi 5.3.0](https://github.com/upx/upx/releases/tag/v5.3.0) untuk unpack
  salinan; arsip tool diverifikasi terhadap digest asset resmi GitHub.

Bukti kerja lokal yang tidak untuk dibagikan sebagai paket binary:
`.codex-tmp/potato-comparison/calls.json`, `functions.json`, `call-inventory.json`,
`inspect_go.py`, dan `sc-fast7-microbench.txt`. Salinan binary Potato hasil unpack
tetap berada pada direktori audit lokal yang diabaikan Git.

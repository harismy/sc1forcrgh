# Hemat CPU SlowDNS per query (V.1FSC.136, patch sc-fast13)

Tujuan: CPU per query `dnstt-server` turun tanpa menurunkan speed, menaikkan
ping, mengubah format DNS yang dilihat klien, atau melemahkan keamanan (service
tetap non-root). Semua angka di bawah diukur di **Linux** (id2: Debian 12,
kernel 6.1, iptables 1.8.9 nf_tables, 2 vCPU, RAM 2 GB) kecuali yang ditandai
Windows. Uji di id2 dilakukan dengan izin pemilik per tindakan: pengukuran
read-only, A/B urutan rule OUTPUT, dan sandbox network namespace yang tidak
menyentuh aturan, service, atau file host.

## Ringkasan

| Langkah | Status default | Hasil terukur (Linux) |
|---|---|---|
| 1. Urutan OUTPUT (ACCEPT dnstt di atas jump kuota) | **aktif** lewat update | waktu kernel dnstt per jawaban −16 s/d −20 µs (≈ −30%) di trafik produksi id2 |
| 2. Chain kuota dibangun ulang dari akun aktif | **aktif** lewat update | fungsi teruji di nf_tables asli; CPU tidak diukur terpisah |
| 3. Alat ukur `cpu-stat` + bench user/sys | tersedia | baseline id2 di bawah |
| 4. Bind langsung UDP 53 tanpa conntrack | **mati** (`set-direct on`) | sandbox: sys per jawaban ≈ −5 s/d −8 µs, conntrack tidak naik per query |
| 5. sc-fast13: satu timer, log dibatasi, query dibuang dihitung | **aktif** (rebuild binary) | speed/ping tidak turun; CPU −11% median tetapi di batas noise A/A |
| 5b. Batch recvmmsg/sendmmsg | **mati** (`set-batch on`) | sandbox: user per jawaban turun di jalur langsung; loopback: tidak terlihat |
| 6. Batas query/detik per klien | tidak dikerjakan | butuh keputusan pemilik |

## Baseline id2 (V.1FSC.135, sc-fast12)

`cpu-stat` versi awal (sampler read-only) selama 2 menit, jendela 10 detik:

| Ukuran | Nilai |
|---|---|
| Jawaban DNS | 2.900–8.200 per detik |
| CPU dnstt | user 13–30%, sys 20–39% satu core |
| CPU per jawaban | user 31–45 µs, sys 47–70 µs |
| Conntrack | ±120 ribu entri |
| softirq / steal | 7–10% / <1,5% dari total CPU |

Waktu kernel lebih besar dari waktu user, sesuai pengukuran pemilik.

## 1. Urutan OUTPUT

**Masalah.** `apply_tool` hanya memeriksa keberadaan rule ACCEPT balasan dnstt
(`-C`), bukan posisinya. `setupSshQuotaAccounting` menyisipkan jump
`SC_1FORCR_QUOTA_OUT` di posisi 1 saat jump itu hilang. Di id2 jump kuota
berada di atas ACCEPT, jadi setiap jawaban DNS menelusuri 92 rule `-m owner`
yang tidak pernah cocok.

**Perubahan.**
- Helper: rule bertanda `sc-slowdns` wajib tepat di puncak OUTPUT; hanya jump
  gerbang `SC1FORCR_SVC_OUT` yang boleh di atasnya (gerbang memaksa dirinya
  pertama, jadi keduanya tidak saling geser tiap siklus). Pemeriksaan memakai
  TAG + `-C`, bukan teks `iptables -S` persis. Dijalankan di setup, update aman,
  dan setiap siklus watchdog (`apply`), dan rule disimpan `netfilter-persistent`
  hanya bila berubah, jadi urutan benar juga setelah reboot.
- Checker kuota menyisipkan jump di bawah rule yang dipin, bukan posisi 1.

**Uji A/B di id2** (trafik produksi, isi rule sama, hanya posisi; urutan blok
A B B A A B, 150 detik per fase, jendela 10 detik, 45 jendela per lengan):

| Blok | Urutan | Jawaban/s | sys µs/jawaban | user µs/jawaban |
|---|---|---:|---:|---:|
| 1 | A: kuota di atas (lama) | 4.405 | 55,8 | 41,4 |
| 2 | B: dnstt di atas (baru) | 4.973 | 40,5 | 57,0 |
| 3 | A | 4.260 | 61,7 | 53,0 |
| 4 | B | 4.472 | 43,8 | 51,3 |

Selisih sys antar-lengan (12–21 µs) lebih besar dari selisih blok dalam lengan
yang sama (A: 5,9 µs, B: 3,3 µs). Waktu user berubah mengikuti campuran trafik
dan tidak dipengaruhi urutan rule, jadi total per jawaban berubah di dalam noise
(A 97–115 µs, B 95–98 µs). Yang diklaim hanya penurunan waktu kernel.

Setelah uji, id2 dibiarkan di urutan B (runtime, belum disimpan
`netfilter-persistent`); update V.1FSC.136 akan menyimpannya.

**Risiko**: rendah. Isi rule tidak berubah; balasan tetap diterima di kedua
urutan (policy OUTPUT ACCEPT). **Rollback**: tidak perlu; versi lama hanya
tidak memindahkan rule.

## 2. Chain kuota basi

**Masalah.** Rule `scquota:<akun>` tidak pernah dibuang. id2: 92 rule untuk
±68 UID; `slowdnstest` (UID 1000) di atas `anjaytes` (UID 1000 sekarang), dan
`trial2377` (akun sudah tidak ada) masih memegang UID 1001. iptables berhenti
di RETURN pertama, jadi trafik akun baru masuk penghitung akun lama.

**Perubahan** (`setupSshQuotaAccounting`, iplimit-checker.js):
- Satu rule per UID dan per username dari akun AKTIF; UID 0 dan akun tanpa UID
  dilewati; UID dibaca dari `/etc/passwd` sekali per siklus (dulu satu `id -u`
  per akun tiap 5 menit).
- Ada rule basi/duplikat/asing = chain dibangun ulang dalam satu commit
  `iptables-restore -w 10 --noflush --counters`. Counter rule yang UID dan
  akunnya sama dibawa. Hanya akun baru = `-A` biasa tanpa rebuild.
- Restore gagal = rule basi dihapus per nomor rule dari bawah (`-D spec`
  menghapus salinan pertama, yaitu salinan yang dipertahankan; ditemukan oleh
  test baru dan diperbaiki sebelum rilis).
- Daftar akun kosong (DB gagal dibaca) tidak menyentuh rule.
- Jump kuota memakai rentang UID akun, dibulatkan per 1000
  (`-m owner --uid-owner 1000-1999`; `nobody` 65534 tidak ikut kecuali ada akun
  di atasnya). Paket Xray (nobody), root, dnstt, dan user sistem tidak lagi
  menelusuri semua rule owner. Efek CPU-nya tidak diukur terpisah.

**Dampak ke data kuota.** Counter owner disimpan di
`account_quota_usage.last_counter_bytes`, bukan di
`account_quota_session_counters` (tabel itu hanya untuk sesi `proc:`, `sshws:`,
`slowdns:` dan tidak disentuh). Rule yang tetap membawa counter-nya, jadi delta
berikutnya normal. Rule baru mulai 0 dan langsung dibaca di siklus yang sama;
logika lama (`counter < last_counter` = counter direset) membuat delta 0 lalu
normal di siklus berikutnya, tanpa hitung ganda. Yang tidak terhitung hanya
trafik owner di antara pembacaan counter dan commit (milidetik), dan hanya saat
chain memang dibangun ulang. Bagi akun yang dulu "tertutup" rule akun lama,
byte yang dulu masuk ke rule lama tidak dipindahkan (tidak bisa dipisahkan
mana milik akun lama), tetapi akun itu sudah dihitung lewat
`max(owner, proc, sshws)`.

**Uji Linux** (netns di id2, nf_tables asli, `quota_test.js`): keadaan id2
ditiru (rule akun lama di atas akun baru ber-UID sama, duplikat, akun terhapus)
→ 2 rule, counter `anjaytes` 7000 dibawa, jump `--uid-owner 1000-1999` di bawah
ACCEPT dnstt; trafik UDP sungguhan sebagai UID 1000 (`setpriv`) masuk ke
`anjaytes` (7000 → 7340); siklus kedua tidak menulis rule; akun UID 2500
memperluas jump ke `1000-2999` tanpa kehilangan counter. Test portabel:
`npm run test:quota-chain`.

**Rollback**: versi lama hanya menambah rule; tidak ada data yang perlu
dikembalikan.

## 3. Alat ukur

- `sc-1forcr-slowdns cpu-stat [DETIK] [JENDELA]` (menu SlowDNS [13] > 3,
  read-only): per jendela CPU user/sys dnstt (`/proc/PID/stat`), query (counter
  INPUT `sc-slowdns`) dan jawaban (counter OUTPUT) per detik, µs user/sys per
  jawaban, `Udp:` In/Out dan `RcvbufErrors` dari `/proc/net/snmp`,
  `nf_conntrack_count`, softirq dan steal dari `/proc/stat`, RSS.
- `bench-slowdns-kcp.js` sekarang memisah CPU user/sys dan mencetak µs/query
  per fase (download, upload, paralel).

## 4. Bind langsung UDP 53 (opt-in)

**Perubahan.** `SLOWDNS_DIRECT_BIND=1` (`sc-1forcr-slowdns set-direct on|off`,
menu SlowDNS [13]):
- Unit: `-udp IP:53,...,:5300` + `AmbientCapabilities` dan
  `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`; tetap user
  `sc-1forcr-slowdns`, `NoNewPrivileges=yes`.
- IP: alamat IPv4 global di interface rute default (maks 4). IP dilewati kalau
  port 53 di IP itu atau wildcard (`0.0.0.0`, `::`, `*`) dipakai program lain.
  `systemd-resolved` (127.0.0.53) tidak bentrok.
- Tabel raw: `SC1FORCR_SDNS_PRE` (`-d IP --dport 53 -m socket -j CT --notrack`)
  dan `SC1FORCR_SDNS_OUT` (`-s IP --sport 53 -j CT --notrack`), ACCEPT INPUT
  `--dport 53` dan OUTPUT `--sport 53`. NOTRACK juga melewati DNAT 1:65535 UDP
  Custom dan DNAT 553/6000–19999 ZIVPN (keduanya di tabel nat).
- `-m socket`: NOTRACK hanya berlaku selama soket IP:53 ada. dnstt restart atau
  bind gagal = paket otomatis tertangkap REDIRECT ke port 5300 (port cadangan
  di proses yang sama). REDIRECT tetap dipasang untuk IPv6 dan IP lain.
- NOTRACK hanya untuk IP yang ada di unit **dan** soketnya milik
  `dnstt-server` menurut `ss`.
- Gerbang ON/OFF: SSH OFF menambah
  `--dport 53 -m conntrack --ctstate UNTRACKED -j DROP` (hanya query bind
  langsung).
- `check` dan `status` menjumlah counter REDIRECT + NOTRACK.
- Rollback: `set-direct off` (NOTRACK dilepas sebelum restart, unit kembali
  persis seperti lama).

**Uji fungsional Linux** (dua netns + veth di id2, helper asli dengan stub
systemctl/netfilter-persistent, binary sc-fast13 build installer):
- setup menulis unit `-udp 10.250.0.2:53,:5300` + caps; `apply` memasang raw,
  ACCEPT 53/5300 di puncak OUTPUT di atas rule lain; `apply` kedua tidak
  menulis apa pun;
- end-to-end lewat resolver tiruan (port sumber baru per query, seperti resolver
  publik): jalur langsung counter raw naik, REDIRECT 0, conntrack tetap 3; jalur
  REDIRECT (IP kedua) conntrack +4.656 entri untuk satu sesi uji;
- batch 0 dan 16 di kedua jalur (termasuk soket dual-stack `[::]:5300`
  melayani klien IPv4);
- rule gerbang UNTRACKED menolak jalur langsung tetapi tidak jalur REDIRECT;
- soket IP:53 tidak ada → jatuh ke REDIRECT tanpa helper;
- `set-direct off` mengembalikan unit dan melepas raw.

**Perf sandbox Linux** (id2, netns, server `GOMAXPROCS=1`, upload 1 MiB +
download 2 MiB lewat resolver tiruan, 3 putaran, urutan diputar; median dengan
rentang min–maks; µs CPU dnstt per jawaban):

| Konfigurasi | user | sys | total | upload s | download s |
|---|---:|---:|---:|---:|---:|
| sc-fast12, REDIRECT | 41,8 (41,3–47,7) | 32,9 (31,3–34,0) | 75,4 (73,1–80,6) | 2,98 | 1,03 |
| sc-fast13, REDIRECT | 34,5 (32,4–43,8) | 29,8 (28,9–34,5) | 69,0 (61,3–73,7) | 2,64 | 1,08 |
| sc-fast13, langsung | 40,8 (36,4–42,8) | 25,1 (24,9–29,7) | 65,9 (61,4–72,5) | 2,76 | 0,84 |
| sc-fast13, langsung + batch 16 | 30,6 (30,5–35,8) | 25,3 (23,6–29,2) | 55,9 (54,2–65,0) | 1,83 | 0,63 |
| sc-fast13, REDIRECT + batch 16 | 37,4 (35,2–40,0) | 32,3 (29,7–36,3) | 69,7 (67,5–73,7) | 2,94 | 0,93 |

Rentang dalam satu konfigurasi 7–12 µs (total), jadi selisih di bawah itu tidak
diklaim. Yang lolos: langsung + batch vs sc-fast12 REDIRECT (−19,5 µs median,
rentang tidak tumpang tindih). Sys jalur langsung vs REDIRECT turun ±5–8 µs,
tetapi rentangnya bersinggungan; arah konsisten dengan conntrack yang tidak
naik. Speed tidak lebih lambat dari sc-fast12 di konfigurasi mana pun (median
upload 1,8–3,0 s per MiB, download 0,6–1,1 s per 2 MiB; sc-fast12 2,98 s dan
1,03 s). Ping tidak diukur di sandbox ini (lihat bench loopback di bagian 5).

**Risiko.** Jalur jaringan baru (kapabilitas, tabel raw, modul `xt_socket` dan
`xt_CT`). Kernel tanpa modul itu = raw gagal dipasang, NOTRACK tidak aktif,
query tetap lewat REDIRECT. Karena itu **mati default** sampai diuji di VPS
produksi dengan aplikasi sungguhan.

## 5. Patch sc-fast13

**Perubahan** (`sc_cpu.go`, `sc_batch_linux.go`, `sc_batch_other.go`):
- `sendLoop`: satu timer untuk semua query (dulu `time.NewTimer` per query);
  paket kedua dst. diambil tanpa blok (dulu `timer.Reset(0)` per respons).
  Semantik sama: satu jawaban per query, paket pertama ditunggu sampai
  `maxResponseDelay` (1 detik) atau sampai query baru datang. Toolchain
  installer (Go 1.27) sudah tanpa `asynctimerchan`; pola Stop/drain yang dipakai
  aman di kedua semantik.
- Query yang dibuang karena antrean `record` (100) penuh dihitung dan dicatat
  per menit. Di sandbox (GOMAXPROCS=1) upload memicu
  `antrean jawaban penuh: 256 query dibuang dalam 1 menit`. Kapasitas tidak
  diubah sampai ada data dari VPS produksi.
- Log per query (`NXDOMAIN: not authoritative`, parse gagal, `WriteTo error`,
  dll.) dibatasi 5 baris per menit per jenis; sisanya diringkas.
- `responseFor`: satu alokasi untuk gabungan label + buffer decode; panjang
  paket tanpa `binary.Write`.
- `-udp` beberapa alamat dan `record.Conn` (lihat bagian 4).
- Batch `recvmmsg`/`sendmmsg` lewat x/net (sudah dipakai kcp-go), `SLOWDNS_UDP_BATCH`
  2..64, mati default. Batch dikirim sebelum `sendLoop` menunggu, jadi jawaban
  tidak tertahan. `ENOSYS`/seccomp = kembali ke satu paket per syscall.

**Micro-benchmark (Windows, hanya user-space)**: `responseFor` 12 → 10
alokasi, 864 → 688 B, ±1,9 → ±1,65 µs; `recvLoop` 44 → 42 alokasi per query.
Kecil, sesuai riset v126 (GC <0,5% CPU).

**Linux**: sc-fast12 vs sc-fast13 di jalur REDIRECT (tabel bagian 4) berbeda
−6,4 µs median, di dalam noise. Hasil bench loopback (ping, speed, A/A) di
bawah.

**Bench loopback Linux** (`bench-slowdns-kcp.js` di netns terisolasi id2,
`GOMAXPROCS=1`, RTT 60 ms, loss 1%, 4 putaran, urutan diputar; `base-A` dan
`base-B` = sc-fast12 yang sama sebagai pembanding A/A; `new` = sc-fast13;
`new-batch` = sc-fast13 + `SLOWDNS_UDP_BATCH=16`):

| Konfigurasi | CPU-s/MiB semua | Down Mbps | Paralel Mbps | Up Mbps | Ping sepi p50/p95 | Ping saat download p50/p95 | RAM puncak MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| base-A | 0,234 (0,205–0,264) | 7,00 | 6,19 | 2,30 | 93 / 124 | 658 / 842 | 42,3 |
| base-B | 0,234 (0,216–0,238) | 6,89 | 7,11 | 2,67 | 63 / 125 | 634 / 818 | 39,2 |
| new | 0,209 (0,181–0,209) | 7,32 | 7,23 | 2,84 | 93 / 124 | 607 / 768 | 34,1 |
| new-batch | 0,206 (0,193–0,256) | 6,97 | 7,40 | 2,72 | 63 / 143 | 532 / 910 | 36,1 |

µs CPU per query, user/sys (median):

| Konfigurasi | Download | Upload | Paralel |
|---|---:|---:|---:|
| base-A | 49,9 / 34,3 | 38,5 / 22,3 | 42,9 / 33,2 |
| base-B | 48,2 / 43,1 | 33,2 / 22,3 | 40,9 / 26,9 |
| new | 46,1 / 35,5 | 32,4 / 22,1 | 39,8 / 26,0 |
| new-batch | 53,5 / 36,2 | 35,3 / 23,2 | 47,3 / 24,2 |

- Speed dan ping tidak turun: semua nilai sc-fast13 berada di dalam atau di
  atas rentang A/A sc-fast12. Ping sepi p50 bimodal 62/123 ms di semua
  konfigurasi (siklus KCP), bukan efek patch; p95 new-batch 143 ms karena satu
  putaran 393 ms (rentang A/A 124–137).
- CPU per MiB sc-fast13 −11% (median), tetapi rentangnya tumpang tindih dengan
  base-A, jadi **tidak diklaim** sebagai penghematan terbukti. µs per query
  berbeda di dalam noise A/A (sys download A/A sendiri 34,3 vs 43,1).
- Batch tidak memberi hasil terlihat di loopback (satu resolver tiruan per
  klien, paket datang satu per satu). Di sandbox veth + resolver port acak
  (bagian 4) batch menurunkan waktu user di jalur langsung. Batch tetap mati
  default sampai diuji dengan trafik produksi.

## 6. Batas query per klien

Tidak dikerjakan. Menukar speed puncak satu pengguna dengan keadilan
antarpengguna; butuh keputusan pemilik.

## Batas verifikasi

- Sandbox memakai `dnstt-client` upstream (TXT) dan resolver tiruan Python di
  VPS yang sama, bukan HTTP Custom/1FTunnel lewat resolver publik.
- Sandbox dan bench berjalan berbarengan dengan trafik produksi id2 (2 vCPU),
  jadi noise lebih besar dari VPS kosong.
- Bind langsung dan batch belum diuji di service produksi (unit asli,
  `CAP_NET_BIND_SERVICE` dari systemd, aplikasi sungguhan). Fungsi kernel yang
  dipakai (raw NOTRACK, `-m socket`, `recvmmsg`/`sendmmsg` di soket dual-stack)
  sudah diuji di kernel id2 (6.1).
- Efek CPU jump kuota berentang UID terhadap trafik Xray tidak diukur.

## Mengulang

```bash
# Lapangan (read-only)
sc-1forcr-slowdns cpu-stat 120 10

# Uji A/B bind langsung / batch di VPS (restart SlowDNS sekali per perubahan)
sc-1forcr-slowdns set-direct on    # rollback: set-direct off
sc-1forcr-slowdns set-batch on     # rollback: set-batch off
```

Bench loopback Linux (butuh binary `dnstt-server`/`dnstt-client` hasil patch
installer, lihat [riset v126](slowdns-cpu-research-v126.md#mengulang)):

```bash
DNSTT_NATIVE_DIR=/root/sc-test/new node scripts/bench-slowdns-kcp.js --rounds 4 \
  --rtt 60 --loss 1 --down-mib 2 --up-mib 0.25 --parallel 4 --par-mib 0.5 \
  --idle-clients 4 --pings 30 --phases ping,download,upload,parallel \
  --configs 'base-A=BIN=/root/sc-test/base;base-B=BIN=/root/sc-test/base;new=BIN=/root/sc-test/new;new-batch=BIN=/root/sc-test/new,SLOWDNS_UDP_BATCH=16'
```

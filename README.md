# SC 1FORCR GitHub Installer

Repository installer:

```text
https://github.com/harismy/sc1forcrgh.git
```

Raw installer:

```text
https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh
https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh
```

## Install AutoSC

Jalankan sebagai `root` di VPS Debian/Ubuntu:

```bash
apt-get update -y && apt-get install -y --no-upgrade curl ca-certificates htop && TMP_SC=/tmp/setup-autoscript-compat.sh && curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh -o "$TMP_SC" && chmod +x "$TMP_SC" && bash "$TMP_SC"
```

## Install Summary API

Jalankan jika hanya ingin memasang/update Summary API:

```bash
apt-get update -y && apt-get install -y --no-upgrade curl ca-certificates && TMP_SUMMARY=/tmp/setup-summary-api.sh && curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh -o "$TMP_SUMMARY" && chmod +x "$TMP_SUMMARY" && bash "$TMP_SUMMARY"
```

## Install AutoSC + Summary API

AutoSC default sudah bisa menjalankan instalasi Summary API jika fitur `AUTO_INSTALL_SUMMARY_API=1` aktif:

```bash
apt-get update -y && apt-get install -y --no-upgrade curl ca-certificates htop && TMP_SC=/tmp/setup-autoscript-compat.sh && curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh -o "$TMP_SC" && chmod +x "$TMP_SC" && AUTO_INSTALL_SUMMARY_API=1 SUMMARY_API_SETUP_URL=https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh bash "$TMP_SC"
```

## Update AutoSC

Jika SC sudah terpasang, update bisa dijalankan dari menu VPS atau langsung:

```bash
UPDATE_SCRIPT_URL=https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh menu-sc-1forcr update
```

## Update Summary API

```bash
SUMMARY_API_SETUP_URL=https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh menu-sc-1forcr update-summary
```

## Akun Online SlowDNS

Sesudah memperbarui AutoSC, buka **Tools > SlowDNS > 7) Lihat Akun Online SlowDNS**,
atau jalankan sebagai root:

```bash
sc-1forcr-slowdns online
```

Layar menampilkan jumlah akun SSH unik yang terverifikasi, jumlah koneksi SSH
melalui SlowDNS, dan rincian koneksi per akun. Koneksi yang belum login atau belum
terpetakan ditampilkan terpisah. Satu akun bisa dipakai beberapa perangkat, jadi
jumlah akun bukan jumlah orang. Koneksi SSHWS dan IP resolver tidak ikut dihitung.
Gunakan `r` untuk memperbarui data, `l` untuk mode live, dan `q` untuk kembali.
Pengambilan data berjalan saat layar dibuka/refresh, tanpa daemon tambahan.

### Auto-lock SlowDNS

Versi `V.1FSC.120` menambahkan batas tunnel SlowDNS yang mengikuti `limitip` akun
SSH: limit 1 mengizinkan satu tunnel, limit 2 mengizinkan dua, dan limit 0 tidak
dibatasi. Banyak koneksi SSH dalam satu ClientID DNSTT tetap dihitung satu tunnel.
ClientID adalah identitas tunnel, bukan identitas HP; satu aplikasi yang membuka
beberapa tunnel terpisah tetap dapat mencapai batas ini.

Checker mengunci akun setelah identitas tunnel yang sama melewati batas dalam
dua pemeriksaan berturut-turut. Tunnel harus berumur minimal 90 detik dan mengirim
trafik klien baru sejak sampel sebelumnya; sampel pertama membentuk baseline.
Pemeriksaan mengikuti timer IP-limit (default 3 menit), sehingga bukan lock instan.
Metadata hilang, binary lama, atau data yang gagal dibaca tidak menjadi alasan lock.

Lock berlaku **15 menit**, lalu akun dipulihkan pada siklus checker berikutnya.
Karena yang dikunci adalah akun SSH, akses lain yang memakai akun tersebut juga
ikut terkunci. Riwayat lock mencatat layanan `slowdns` dan jumlah tunnel, bukan IP
resolver. Saklar auto-lock global tetap berlaku.

Auto-lock aktif secara default ketika SlowDNS aktif. Ubah melalui Tools > SlowDNS
> 8, atau:

```bash
sc-1forcr-slowdns set-lock 0 # nonaktifkan
sc-1forcr-slowdns set-lock 1 # aktifkan
```

Fitur membutuhkan binary DNSTT patch `sc-fast4` atau lebih baru. Update membangunnya dengan kunci
server yang sama dan mengaktifkannya melalui restart service SlowDNS. Monitor
sesi memakai Unix socket lokal berizin 0600 di direktori runtime berizin 0700;
tidak membuka port publik atau menulis data per paket ke disk.

### Efisiensi SlowDNS V.1FSC.121

Patch `sc-fast5` menghitung ukuran dan mengenkode respons normal TXT/NULL tanpa
serializer sementara, dengan hasil byte yang sama. Bentuk respons lain memakai
serializer upstream. MTU, window/interval KCP, GOMAXPROCS, dan GOGC dipertahankan.
Monitor dan tracker SSH memakai satu snapshot socket segar per pemeriksaan;
keputusan auto-lock tidak memakai cache tampilan.

Helper `sc-1forcr-udp-firewall cleanup` merapikan salinan ACCEPT UDP polos yang
identik dan bersebelahan pada port listen backend SC. Dijalankan saat update,
setelah backend start, dan oleh watchdog; tanpa daemon baru. Rule yang diselingi
gate/DROP/rule lain, NAT, dan rule dengan pembatas tambahan dipertahankan. Chain
bersih tidak ditulis ulang. Pengukuran lokal dan batas interpretasinya ada di
[catatan benchmark](docs/slowdns-efficiency-v121.md).

### Penerimaan query lebih ringan V.1FSC.122

Patch `sc-fast6` memakai ulang satu buffer baca 4096 byte sepanjang receive-loop
dan memvalidasi panjang nama DNS tanpa membentuk paket/cache sementara.
Parser tetap memiliki salinan label dan payload sendiri, sehingga paket yang
menunggu diproses tidak berubah ketika buffer baca dipakai untuk query berikutnya.
MTU, KCP, interval, jumlah core, GC, dan ukuran buffer socket UDP tetap sama.

Pada simulasi receive-loop lokal, alokasi turun dari 6105 menjadi 840 B/query
dan waktu pemrosesan sekitar 2,3 kali lebih cepat. Ini belum menyatakan penurunan
CPU total VPS; pengukuran setelah update tetap diperlukan. Lihat
[benchmark penerimaan query](docs/slowdns-receive-v122.md).

## DNS Resolver Guard

SC memeriksa resolusi beberapa domain sebelum instalasi dan secara berkala melalui
`sc-1forcr-dns-guard.timer`. Selama DNS VPS sehat, konfigurasi resolver tidak
diubah. Jika seluruh tes DNS gagal dua kali, konfigurasi lama dicadangkan ke
`/var/backups/sc-1forcr/dns`, lalu resolver dipulihkan menggunakan `8.8.8.8` dan
`1.1.1.1`.

Fitur aktif secara default dan dapat disesuaikan melalui:

```bash
DNS_GUARD_ENABLE=1
DNS_GUARD_INTERVAL_MINUTES=10
```

## HAProxy Backend Readiness

Konfigurasi HAProxy memberi toleransi pada restart singkat Nginx dan SSHWS agar
backend tidak langsung ditandai `DOWN`. Instalasi penuh menunggu seluruh port
backend lokal siap sebelum HAProxy dinyalakan kembali, sedangkan safe update
memvalidasi listener backend dan menjalankan rollback jika layanan tidak pulih.

## Catatan Penting

Jangan menjalankan installer besar dengan format ini:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh)"
```

Format tersebut bisa gagal dengan error:

```text
/usr/bin/bash: Argument list too long
```

Gunakan command yang men-download file dulu ke `/tmp`, lalu jalankan dengan `bash "$TMP_SC"`.

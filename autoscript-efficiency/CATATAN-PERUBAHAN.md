# Perubahan efisiensi autoscript — 7 November 2026

Status: **source sudah diubah dan diuji secara terisolasi; belum diterapkan ke server produksi atau endpoint distribusi.** Sesi ini hanya memiliki akses tulis ke `/root` dan `/tmp`.

Basis pekerjaan adalah installer lengkap V.1FSC.124 yang tersimpan di `/var/lib/sc-1forcr/setup-autoscript-compat.lQgSVq.sh` dari update pukul 18:40 UTC. Ini salinan installer hasil distribusi, bukan checkout repository pengembang. Hash basis dan hasil ada di `review/manifest.json`. Nomor versi rilis resmi dan URL update tidak diganti.

## File untuk diperiksa

- `src/setup-autoscript-compat.sh`: installer lengkap dengan perubahan.
- `review/efficiency.patch`: diff terhadap installer basis.
- `original/setup-autoscript-compat.sh`: cadangan basis, tidak dimodifikasi.
- `review/sc-1forcr-udpgw-drain`: preview skrip runtime drain yang dihasilkan installer.
- `review/sc-1forcr-postboot-health`: preview watchdog yang dihasilkan installer.
- `review/test-results.txt`: keluaran pengujian.
- `tests/`: pengujian dengan systemctl/ss tiruan.
- `tools/modify.py`: transformasi yang dapat diulang terhadap basis; `tools/systemd-batch.sh` adalah sumber helper yang ditanam langsung ke installer. Installer hasil tidak memerlukan folder tools saat dijalankan.

## Apa yang diubah

### 1. Penulisan unit dan reload per kelompok setup

Empat jalur setup diperbaiki: DNS resolver guard, postboot health guard, online notification, dan auto-update (script, summary, God Mode).

- Isi unit dibandingkan sebelum penggantian. File yang sama tidak diganti, sehingga mtime tetap.
- File yang berubah disiapkan melalui file sementara dan dipindahkan secara atomik.
- Status enable diperiksa; perubahan enable/disable menggunakan `--no-reload`, kemudian satu reload dilakukan setelah seluruh unit dalam kelompok selesai.
- Eksekusi ulang dengan konfigurasi dan status manager yang sama melewati reload.
- `NeedDaemonReload` dan `LoadState` diperiksa ketika file sama, untuk menangani percobaan sebelumnya yang terputus setelah menulis file.
- Kegagalan penulisan, perubahan enable, atau reload dikembalikan sebagai kegagalan setup. Aktivasi tidak dilanjutkan setelah reload gagal.
- Unit berbentuk symlink ditolak dengan pesan yang jelas agar override/mask administrator tidak tertimpa.

Ini batching **per fungsi setup**, bukan satu reload untuk seluruh installer. Jalur setup lain masih mempunyai reload dan memerlukan audit lanjutan.

### 2. Mengurangi restart timer yang tidak diperlukan

- Timer yang definisinya berubah direstart setelah reload.
- Timer dengan definisi sama menggunakan `start`, yang tidak mengulang aktivasi timer yang sudah aktif.
- Jalur akhir safe-update pada installer, menu CLI hasil installer, dan shim `restart_update_safe_services` tidak lagi me-restart timer online-notify, pull-update, pull-summary-update, dan god-update secara paksa.
- Enable God Mode pada jalur akhir hanya dilakukan jika belum enabled.
- Penghapusan stamp persisten lama dan restart paksa setiap setup God Mode dihapus. Timer ini sudah `Persistent=false`; definisi jadwalnya dipertahankan. Perubahan jadwal dan pemulihan manager yang belum memuat unit tetap memicu restart melalui helper.

Jalur installer lain masih dapat me-reload systemd. Karena itu, patch ini tidak mengklaim seluruh jadwal timer kebal terhadap efek reload dari luar empat fungsi tersebut.

### 3. Drain UDPGW memakai satu snapshot koneksi

- `ss` diambil sekali secara lazy ketika ada alias aktif, lalu koneksi per port dihitung dalam satu pemindaian awk.
- Jika seluruh alias sudah inactive, tidak ada pemindaian socket.
- `reset-failed` untuk alias inactive hanya dilakukan bila status benar-benar failed.
- **Perbaikan penting:** kegagalan `ss` menghentikan pemeriksaan drain dengan error, sambil mempertahankan proses aktif. Sebelumnya kegagalan snapshot bisa menghasilkan hitungan nol dan menghentikan alias yang masih dipakai.

Snapshot tetap merupakan pengamatan sesaat, sehingga tidak menghilangkan seluruh race antara pengamatan koneksi dan keputusan drain.

### 4. Watchdog menghindari snapshot listener per port

Satu percobaan `unit_healthy` mengambil satu snapshot listener untuk seluruh port unit tersebut. Percobaan berikutnya setelah sleep/restart membaca snapshot baru, sehingga tidak memakai data lama untuk menyatakan layanan sudah pulih. Unit tanpa pemeriksaan port tidak memanggil `ss`.

## Bukti pemeriksaan

**17 pengujian lulus**, termasuk:

- Syntax installer dan skrip runtime yang diekstrak.
- Instalasi pertama dan setup berulang tanpa perubahan.
- Perubahan interval hanya me-restart timer yang terkait.
- Menonaktifkan update opsional tetap mempertahankan God Mode.
- Reload gagal tidak dilanjutkan dengan start/restart; percobaan berikutnya dapat pulih.
- File symlink tidak tertimpa, termasuk ketika setup dipanggil melalui kondisi `if` yang menonaktifkan errexit Bash.
- Drain mempertahankan alias yang masih memiliki koneksi, mendukung format endpoint IPv4/IPv6, dan tidak menghentikan proses bila `ss` gagal.
- Snapshot health-check digunakan sekali per percobaan dan diperbarui pada percobaan berikutnya.
- Jalur akhir update tidak membatalkan pengurangan restart pada empat timer terkait.

Perbandingan terukur di simulator untuk **setup auto-update saja**, konfigurasi update opsional aktif:

| Skenario | Installer basis | Hasil patch |
|---|---:|---:|
| Pemasangan pertama | 4 reload | 1 reload |
| Setup ulang tanpa perubahan | 4 reload | 0 reload |

Jumlah mencakup reload implisit dari enable. Simulator memeriksa urutan operasi dan state sederhana; ia bukan pengganti systemd asli atau pengujian penjadwalan waktu nyata.

Jalankan ulang pemeriksaan tanpa mengubah service host:

```sh
python3 /root/autoscript-efficiency/tests/test_efficiency.py
bash -n /root/autoscript-efficiency/src/setup-autoscript-compat.sh
```

Patch juga telah diperiksa dengan `patch --dry-run` terhadap salinan basis.

## Batas hasil dan pekerjaan berikutnya

- Belum ada benchmark CPU, Mbps, latency, atau 30 pengguna pada server nyata. Pengurangan jumlah operasi tidak boleh dianggap sebagai persentase penurunan CPU yang sudah terbukti.
- KCP, MTU, window, buffer, GOGC, batas RAM, protokol DNSTT, enkripsi, autentikasi, dan aturan firewall tidak dituning dalam patch ini. Tujuannya mengurangi overhead pengelolaan tanpa mengubah parameter kecepatan tunnel.
- Banjir log NXDOMAIN, error balasan UDP, dan conntrack penuh belum diperbaiki. Memperbaikinya memerlukan pemeriksaan jalur paket host dan source DNSTT yang dapat dibangun serta diuji. Pengunduhan source DNSTT melalui shell sesi ini gagal karena DNS/network dibatasi.
- Lock, cooldown retry updater, lisensi, kuota, dan interval monitoring yang sudah ada dipertahankan. Beberapa optimasi yang dibahas sebelumnya ternyata sudah ada di basis terbaru.
- Sebelum distribusi luas, gabungkan diff ke sumber generator yang sebenarnya. Jika repository memisahkan template dan installer hasil build, ubah template terkait dan regenerate installer.
- Gunakan proses versi, checksum, dan penandatanganan distribusi yang sudah berlaku. Menyalin installer ini ke server saja tidak memperbarui endpoint autoscript; updater lama dapat menimpa perubahan lokal pada pembaruan berikutnya.
- Uji pada VPS staging dengan systemd asli: install baru, safe-update berulang, perubahan interval, reboot, kegagalan update, dan pemulihan timer. Setelah itu bandingkan workload 5/10/20/30 pengguna melalui resolver yang digunakan pelanggan.

## Rollback

Untuk rollback **source**, gunakan cadangan di `original/` atau reverse patch pada basis yang cocok. Tidak ada rollback runtime yang perlu dijalankan saat ini karena service produksi belum diubah. Jika versi ini nantinya dipasang, gunakan snapshot dan mekanisme rollback autoscript yang sudah tersedia; menyalin file source lama saja tidak mengembalikan seluruh konfigurasi runtime.

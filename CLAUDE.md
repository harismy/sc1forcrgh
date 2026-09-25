# CLAUDE.md — SC 1FORCR NEXUS

Panduan kerja untuk Claude Code dan developer di repo ini. Baca ini dulu sebelum mengubah apa pun.

## Prinsip utama (jangan dilanggar)

Auto script ini dipakai di VPS produksi milik pelanggan. Urutan prioritasnya:

1. **Stabilitas jaringan di atas segalanya.** Layanan tunnel (SSH, SSH-WS, Xray/VMess/VLESS/Trojan, UDP) harus tetap jalan. Perubahan yang berisiko memutus koneksi pengguna aktif tidak boleh masuk tanpa jalur pemulihan otomatis.
2. **Hemat RAM dan CPU.** Target minimum adalah **VPS 1 GB RAM / 1 vCPU**. Semua fitur baru harus tetap muat dan tetap stabil di spesifikasi itu. Kalau sebuah fitur hanya masuk akal di VPS besar, buat dia opsional dan mati secara default.
3. **Efisien, bukan sekadar irit.** Hemat resource tidak boleh dibayar dengan koneksi yang sering putus. Idle harus murah; beban puncak harus tetap tertangani.
4. **Selalu bisa pulih sendiri.** Setiap komponen yang bisa macet wajib punya pengawas yang berkala, bukan sekali jalan.

## Baseline VPS 1 GB

`auto_tune_resource_vars()` di [scripts/setup-autoscript-compat.sh](scripts/setup-autoscript-compat.sh) memilih preset berdasarkan tier RAM/CPU (tier = min(RAM GB, jumlah core)). Preset dasar inilah yang dipakai VPS 1 GB, dan ini anggaran yang harus dihormati fitur baru:

| Parameter | Nilai di tier 1 GB |
|---|---|
| `NGINX_WORKER_CONNECTIONS` | 2048 |
| `LimitNOFILE` (nginx/haproxy) | 65536 |
| `HAPROXY_MAXCONN` / `HAPROXY_NBTHREAD` | 4096 / 1 |
| `SC_API_MEMORY_MAX` | 320M |
| `SSHWS_SERVICE_MEMORY_MAX` | 192M |
| `SSHWS_READER_BUFFER_KB` | 8 |
| `SSHWS_ACCOUNT_SESSION_HARD_LIMIT` | 8 |
| UDPGW clients / conn per client / memory | 64 / 16 / 128M |

Dukungan hemat resource lain yang sudah ada dan tidak boleh dihapus tanpa pengganti:

- Swapfile 1 GB dibuat otomatis kalau VPS belum punya swap, dengan `vm.swappiness=10`.
- `MemoryMax=` pada semua service Node/Go, plus `Nice=10` dan `CPUQuota=50%` untuk job periodik berat seperti IP-limit checker.
- Journald dibatasi `SystemMaxUse=100M`, plus logrotate untuk log service.
- `RESOURCE_TARGET_USAGE_PERCENT` default 85 sebagai batas atas pemakaian yang dianggap sehat.

Kalau menambah service baru: **wajib** ada `MemoryMax=`, dan `Nice=`/`CPUQuota=` kalau sifatnya batch/periodik.

## Susunan repo

| Path | Isi |
|---|---|
| [scripts/setup-autoscript-compat.sh](scripts/setup-autoscript-compat.sh) | Installer VPS, ~29 ribu baris. Inti dari semuanya. |
| [app3.js](app3.js) | Bot Telegram: penjualan, registrasi VPS, campaign God Mode. |
| [license-api.js](license-api.js) | API lisensi dan endpoint update yang dipanggil VPS. |
| [scripts/test-*.js](scripts/) | Test suite. |
| `backupSC/` | Salinan versi lama. **Bukan** file aktif; jangan diedit untuk perbaikan. |

## Alur trafik yang harus dijaga

```
Klien -> HAProxy :443 (TLS, deteksi payload)
           |-- CONNECT / banner "SSH-"  -> sshws mux :2082 -> dropbear :109/:143 atau ssh :22
           |-- HTTP/2 preface           -> nginx gRPC :8081 -> Xray
           |-- WS vmess/vless/trojan    -> nginx :8083     -> Xray
```

Kalau menyentuh HAProxy, nginx, atau sshws: perubahan harus lolos `haproxy -c -f` dan `nginx -t` **sebelum** reload. Pola ini sudah ada di `setup_haproxy_tls_mux()`; ikuti, jangan dilewati.

### Config Xray dan hot-add user

Xray tidak punya reload, jadi restart memutus **semua** pengguna vmess/vless/trojan. Aturannya:

- Akun baru, trial, dan perpanjangan akun expired ditambahkan tanpa restart lewat `HandlerService` (`xray api adu`), lihat `writeXrayConfigAndReload()` di api.js. Penghapusan, pergantian kredensial, dan lock/unlock tetap restart, karena hanya restart yang memutus sesi lama user yang dicabut.
- `buildXrayRuntimeConfig()` ada di api.js **dan** iplimit-checker.js, dan isinya harus identik termasuk tag inbound. Config yang strukturnya berbeda selalu jatuh ke restart. `npm run test:xray-hot-add` menjaga ini.
- `HandlerService` bisa membuat akun, jadi hanya aktif kalau rule iptables "hanya root ke 127.0.0.1:10085" dari `apply_tunnel_outbound_guard_rules()` terpasang dan Xray tidak jalan sebagai root. Jangan hapus rule itu.

Timeout HAProxy sengaja panjang (`timeout client/server 12h`) supaya tunnel WS tidak putus sendiri. Yang menjaga socket mati tidak menumpuk adalah `option clitcpka`/`srvtcpka` plus sysctl keepalive agresif (`tcp_keepalive_time=60`, `intvl=15`, `probes=4`). Ketiganya satu paket. Jangan hapus salah satu tanpa mengganti mekanisme penggantinya.

## Aturan systemd timer (penting, pernah jadi bug nyata)

**Setiap timer berulang wajib punya trigger pengulangan**, yaitu `OnUnitInactiveSec=`, `OnUnitActiveSec=`, atau `OnCalendar=`. Timer yang hanya punya `OnActiveSec=` atau `OnBootSec=` akan jalan **sekali saja** lalu diam selamanya.

Ini pernah terjadi sungguhan: `sc-1forcr-postboot-health.timer` hanya punya `OnActiveSec=90s`, sehingga watchdog service inti cuma jalan 90 detik setelah boot. Saat SSH macet di tengah hari, tidak ada yang memulihkan dan pengguna harus restart manual. Sudah diperbaiki, tapi polanya mudah terulang.

Pola yang benar, seperti dipakai auto-backup dan IP-limit:

```ini
[Timer]
OnActiveSec=90s
OnUnitInactiveSec=5min
```

**`OnActiveSec=` direset setiap `daemon-reload`, dan `OnUnitInactiveSec=` belum punya acuan sampai service jalan sekali di boot itu.** Jadi setelah reboot, timer yang langkah pertamanya hanya `OnActiveSec=` bisa tertunda selamanya kalau ada reload yang lebih sering dari jedanya. Ini juga pernah terjadi sungguhan: `sc-1forcr-udpgw-drain` (tiap 2 menit) memanggil `systemctl disable` yang diam-diam ikut `daemon-reload`, sehingga notif online, auto-backup, dan pull-update tidak jalan sama sekali setelah auto-reboot harian. Aturannya:

- Script berkala **tidak boleh** memicu reload. Pakai `systemctl enable/disable --no-reload`, dan panggil hanya kalau statusnya memang perlu diubah.
- Timer yang wajib jalan setelah reboot diberi `OnBootSec=` juga. Catatan: `OnBootSec=` yang sudah lewat langsung terpicu saat timer di-restart, jadi jangan dipakai untuk job berat yang tidak punya penjaga jadwal sendiri (misalnya backup).

Watchdog `/usr/local/sbin/sc-1forcr-postboot-health` memeriksa `ssh`, `dropbear`, `xray`, `sc-1forcr-api`, `sc-1forcr-sshws`, `nginx`, dan `haproxy` — bukan cuma status aktif, tapi juga port benar-benar listen. Restart ulang unit yang sama dibatasi `SERVICE_HEALTH_REPAIR_COOLDOWN_MINUTES` (default 15 menit) supaya unit yang rusak permanen tidak di-restart tiap siklus dan membebani VPS kecil.

## Aturan mengedit installer

- **Idempoten.** Script dijalankan ulang saat update. Setiap fungsi harus aman dijalankan berkali-kali.
- **Dua jalur eksekusi.** Install penuh, dan `UPDATE_SAFE_MODE=1` (dipakai God Mode update) yang mempertahankan service aktif. Fitur baru biasanya perlu dipanggil di kedua jalur, di dalam `main()`.
- **Jangan matikan service tanpa rencana pulih.** Jalur update aman punya snapshot dan rollback otomatis lewat `sc-1forcr-update-manager`. Kegagalan langkah penting harus `return 1` supaya rollback jalan, bukan diserap diam-diam.
- **Hati-hati dengan heredoc.** Sebagian besar isi script adalah heredoc yang menulis script lain. `<<'EOF'` menulis literal; `<<EOF` melakukan ekspansi variabel. Salah pilih akan merusak file hasil generate, dan `bash -n` pada file induk tidak akan menangkapnya.
- **Naikkan `SCRIPT_VERSION`** setiap kali mengirim perbaikan, supaya jalur auto-update dan God Mode mengenali versi baru.
- **`set -euo pipefail` aktif.** Perintah yang boleh gagal harus diakhiri `|| true`.

### Wajib sebelum selesai

```bash
bash -n scripts/setup-autoscript-compat.sh     # syntax file induk
node -c app3.js && node -c license-api.js      # syntax sisi bot
npm test                                        # test suite
```

Untuk heredoc yang menghasilkan script, ekstrak dan cek terpisah, karena `bash -n` di file induk tidak memeriksanya:

```bash
awk '/^  cat > \/usr\/local\/sbin\/NAMA <</{f=1;next} /^DELIMITER$/{f=0} f' \
  scripts/setup-autoscript-compat.sh > /tmp/gen.sh && bash -n /tmp/gen.sh
```

### Dua test yang memang sudah merah

`npm test` punya dua kegagalan lama yang **bukan** akibat perubahan baru:

- `test:update-compat` — potongan kode yang diuji memanggil `timer_substate_ok` yang tidak ikut disalin ke snippet uji.
- `test:cli-output` — memeriksa string versi lama `V.1FSC.43` yang tidak ikut dinaikkan saat versi naik.

Jangan buang waktu mengejar dua ini saat mengerjakan hal lain. Kalau memperbaikinya, kerjakan sebagai tugas tersendiri.

## Sisi bot

- Campaign God Mode bersifat **pull**: VPS yang memanggil `/sc1forcr/god-update/check` secara berkala. Bot tidak punya akses SSH ke VPS dan tidak bisa mendorong perintah.
- Karena itu campaign bisa menggantung kalau ada VPS yang tidak pernah lapor lagi. Penanganannya: auto-timeout saat tidak ada progres (`GOD_UPDATE_STALL_TIMEOUT_MINUTES`, default 180) plus tombol admin "Tuntaskan Sekarang".
- Konfigurasi VPS disimpan di `/etc/sc-1forcr.env` dan dibaca ulang saat update. Variabel baru yang perlu bertahan lintas update harus ditambahkan ke dump env di `write_cli_menu()` dan ke daftar di `persist_pending_install_env()`.
- `app3.js` memakai satu koneksi SQLite, dan `dbRun` mengantrekan blok `BEGIN` sampai `COMMIT`/`ROLLBACK`. Setiap `BEGIN` **wajib** diakhiri `COMMIT` atau `ROLLBACK` di semua jalur, dan jangan memanggil jaringan (Telegram, axios, API VPS) di dalam transaksi: antrean menahan semua transaksi lain sampai blok itu selesai.
- Pindah server bot lewat menu admin "Pindah Server Bot" ([lib/server-migration.js](lib/server-migration.js)). File `.sc1bak` dienkripsi password (AES-256-GCM) dan berisi snapshot database (`VACUUM INTO`), `.env`, `.vars.json`, signing key lisensi, script yang disajikan ke VPS, dan SSL domain API. Restore mengganti isi database di tempat (`ATTACH` + satu transaksi, kolom dicocokkan per nama). Saat restore, `BOT_TOKEN` dan path folder milik server baru dipertahankan. **Kalau menambah file state baru di server bot, masukkan ke `createServerBackup`/`restoreServerBackup`**; kalau tidak, file itu hilang saat pindah server. Signing key wajib ikut, karena VPS mem-pin public key dan menolak key baru. Test: `npm run test:server-migration`.
- Server lama dibekukan dengan file `.server-migrated-away`: bot tidak polling Telegram dan expiry job berhenti, walau server reboot. License API tetap jalan sampai DNS pindah. CLI cadangan untuk file di atas 20MB: `node app3.js --server-backup` / `--server-restore FILE`.
- Pembayaran QRIS memakai tabel `pending_deposits_app3`. Kolom `purpose` membedakan top up saldo (`topup`) dari perpanjang SC langsung (`sc_renewal`). QRIS perpanjang dikreditkan lalu langsung dipakai perpanjang dalam satu transaksi (`settleScRenewalDeposit`); kalau perpanjangan ditolak, dana tetap di saldo pembeli. Test: `npm run test:sc-renewal-payment`.

## Bahasa

Komentar, log, dan teks menu memakai bahasa Indonesia. Ikuti gaya yang sudah ada.

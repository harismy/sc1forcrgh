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
- Journald dibatasi `SystemMaxUse=100M`, plus logrotate untuk log service. Log Xray punya `maxsize 50M` dan `logrotate.timer` dibuat per jam supaya batas itu berlaku. Jangan cantumkan log nginx di `/etc/logrotate.d/sc-1forcr`: paket nginx sudah punya config sendiri, dan file yang tercantum di dua config membuat logrotate menolak bloknya.
- ZIVPN dan UDP Custom berbagi port. Drop-in `20-sc-udp-exclusive.conf` (`ExecCondition`) menolak start satu backend selama lawannya aktif, supaya tidak ada crash-loop tiap 2 detik. Capacity analyzer jalan tiap 15 menit dengan batas `Nice`/`CPUQuota`/`MemoryMax`. `npm run test:resource-guards` menjaga keduanya.
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
- Link akun (`createXray` di api.js): WS, gRPC, HTTPUpgrade (`uptls`/`upntls`, path `/up<protokol>`), OneRing untuk aplikasi 1FTunnel (WS TLS dengan SNI `onering:<domain>:<domain>`), dan XHTTP VLESS (`xhttptls`/`xhttpntls`) hanya saat `XRAY_XHTTP_ENABLE=1`. Path link wajib sama dengan inbound di `buildXrayRuntimeConfig()` dan location nginx (`/xhvless` ada di blok 80/8083 lewat HTTP/1.1 dan di blok 8081 lewat h2). `npm run test:xray-links` menjaga ini.

### IP-limit (auto lock multi-login)

Lock yang salah langsung merugikan pembeli, jadi aturannya condong menghindari false positive:

- Semua protokol memakai `countEffectiveDevices()` di iplimit-checker.js: IPv4 per `XRAY_IP_GROUP_MASK` (default `/16`, pool CGNAT operator), IPv6 per `/64`, dan IPv4+IPv6 yang aktif bersamaan dihitung satu perangkat. Jangan menghitung IP mentah untuk keputusan lock.
- Lock butuh dua pengecekan berturut-turut dengan sidik jari kelompok IP yang sama (`sampleSshDeviceLimit`, `sampleXrayIpLimit`). Tidak boleh ada jalur lock dari satu sampel.
- Sesi SSH-WS hanya dihitung kalau klien masih mengirim data sejak pengecekan sebelumnya (kolom `ClientToSSH` di `sshws-quota.tsv`), supaya sesi lama yang mati setelah HP ganti IP tidak terbaca sebagai perangkat kedua.
- Toleransi ZIVPN limit 1 (maksimal 2 IP dihitung 1) sengaja dipertahankan. Jangan diperketat tanpa data dari `iplimit_lock_history`.
- Test: `npm run test:iplimit-devices` dan `npm run test:xray-iplimit`.

### ON/OFF layanan (menu [08])

`/usr/local/sbin/sc-1forcr-service-gate` (heredoc `SERVICE_GATE_EOF`) mematikan layanan dengan menolak trafiknya di iptables, **bukan** dengan stop/mask service. Watchdog, update, dan restart chain me-restart service yang mati, jadi service systemd harus tetap jalan.

- Status disimpan di `SERVICE_{SSH,VMESS,VLESS,TROJAN,UDP}_ENABLE` (default 1) plus `XRAY_XHTTP_ENABLE`. Chain `SC1FORCR_SVC_OUT` (port lokal: sshws 2082, inbound Xray per protokol) dan `SC1FORCR_SVC_IN` (Dropbear publik, port listen UDP). Semua ON = tidak ada chain sama sekali.
- Jump ke chain harus rule **pertama** di INPUT/OUTPUT, supaya sesi yang sudah tersambung juga putus dan rule ACCEPT 80/443/109/143 tidak mendahuluinya. `apply` memeriksa posisinya dan dipanggil di akhir install/update, di heal SSHWS, dan tiap siklus watchdog.
- Port sshd tidak pernah ikut ditutup (akses admin). Menutup VMess/VLESS/Trojan tidak me-restart Xray. XHTTP satu-satunya yang me-restart Xray (lewat restart API), dan status lamanya dipulihkan kalau Xray tidak memuat inbound baru.
- API menolak akun baru (503) untuk layanan yang OFF. Akun SSH baru hanya ditolak kalau SSH **dan** UDP OFF, karena akun SSH juga dipakai login ZIVPN/UDP Custom.
- Port inbound Xray baru wajib ditambahkan ke `VMESS_PORTS`/`VLESS_PORTS`/`TROJAN_PORTS` di script ini, atau layanan itu tidak ikut tertutup. Test: `npm run test:service-gate`.

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

### Debian 11 (bullseye) sudah habis masa dukungnya

Debian 11 masih didukung installer, tapi repo keamanannya rusak di sisi Debian: file `.deb` `bullseye-security` dihapus dari mirror awal September 2026 sementara indeksnya dibiarkan. Akibatnya `apt-get install` berujung 404, dan `apt-get update` tidak menolong karena indeksnya memang tidak berubah.

- `ensure_bullseye_security_repo` (blok bertanda `bullseye-security-repo`) memindahkan repo itu ke snapshot.debian.org `20260831T211327Z`. Indeks snapshot itu identik dengan indeks terakhir di mirror, jadi versi paket tidak berubah. Baris lama dijadikan komentar, dan sumber apt tidak disentuh kalau snapshot tidak terjangkau.
- Blok itu ada di [scripts/setup-autoscript-compat.sh](scripts/setup-autoscript-compat.sh) **dan** [scripts/setup-summary-api.sh](scripts/setup-summary-api.sh), dan isinya harus identik.
- Mode `probe` dipanggil `apt_get_safe` sebelum setiap `install`: pindah hanya kalau file yang akan diunduh terbukti 404, jadi mirror provider yang masih lengkap dibiarkan. Mode `force` dipakai setelah `apt-get install` sungguhan gagal. Pasang paket lewat `apt_get_safe`, jangan `apt-get install` langsung.
- Perintah yang diketik pembeli sebelum installer jalan (langkah [2/3] di bot dan README) memakai `--no-upgrade` dan hanya memasang yang dibutuhkan untuk mengunduh installer. Tanpa itu apt ikut meng-upgrade paket dari repo security dan gagal 404 sebelum installer sempat memperbaiki repo. Jangan tambahkan `jq` atau `build-essential` ke sana; keduanya dipasang installer.
- Test: `npm run test:bullseye-repo`.

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
- **Key VPS di database bot harus sama dengan key di VPS.** License API mencari registrasi lewat `X-SC-Key` di `sc_server_keys`. Key yang salah di bot tidak langsung terasa, tapi saat lease habis (6 jam + grace 24 jam) VPS terkunci dengan reason `api-rejected:server-key-unknown`. Aturannya:
  - Key ketikan pengguna disimpan hanya lewat `acceptServerKeyFromUser`, yang mengecek key ke Summary API VPS (`verifyServerKeyOnHost`). Jangan memanggil `saveServerKeyForHost` langsung dengan input pengguna.
  - Key salah dipulihkan lewat menu admin "Pulihkan Key VPS": cek ke VPS, simpan untuk semua owner, lalu unlock. "Reset Binding VPS" merotasi key dan membuat VPS terkunci sampai installer dijalankan ulang, jadi bukan alat untuk kasus ini.
  - License guard VPS (`refreshLease`) mencatat penyebab asli di lock (`api-rejected:*`, `refresh-failed:*`, `license-<status>:<alasan>`), bukan `lease-grace-expired`. `menu_lock_reason_text` menerjemahkannya di layar kunci menu, dan `licenseDenyHint` di bot.
  - Unlock di Summary API memperbarui lisensi dulu dan menjawab 409 plus `license_reason` kalau masih ditolak. License API mencatat setiap penolakan ke log pm2 dengan awalan hash key saja (`[license] tolak ...`).
  - Jangan pernah menulis key asli ke log atau pesan. Test: `npm run test:license-recovery`.
- Konfigurasi VPS disimpan di `/etc/sc-1forcr.env` dan dibaca ulang saat update. Variabel baru yang perlu bertahan lintas update harus ditambahkan ke dump env di `write_cli_menu()` dan ke daftar di `persist_pending_install_env()`.
- `app3.js` memakai satu koneksi SQLite, dan `dbRun` mengantrekan blok `BEGIN` sampai `COMMIT`/`ROLLBACK`. Setiap `BEGIN` **wajib** diakhiri `COMMIT` atau `ROLLBACK` di semua jalur, dan jangan memanggil jaringan (Telegram, axios, API VPS) di dalam transaksi: antrean menahan semua transaksi lain sampai blok itu selesai.
- Pindah server bot lewat menu admin "Pindah Server Bot" ([lib/server-migration.js](lib/server-migration.js)). File `.sc1bak` dienkripsi password (AES-256-GCM) dan berisi snapshot database (`VACUUM INTO`), `.env`, `.vars.json`, signing key lisensi, script yang disajikan ke VPS, dan SSL domain API. Restore mengganti isi database di tempat (`ATTACH` + satu transaksi, kolom dicocokkan per nama). Saat restore, `BOT_TOKEN` dan path folder milik server baru dipertahankan. **Kalau menambah file state baru di server bot, masukkan ke `createServerBackup`/`restoreServerBackup`**; kalau tidak, file itu hilang saat pindah server. Signing key wajib ikut, karena VPS mem-pin public key dan menolak key baru. Test: `npm run test:server-migration`.
- Server lama dibekukan dengan file `.server-migrated-away`: bot tidak polling Telegram dan expiry job berhenti, walau server reboot. License API tetap jalan sampai DNS pindah. CLI cadangan untuk file di atas 20MB: `node app3.js --server-backup` / `--server-restore FILE`.
- Pembayaran QRIS memakai tabel `pending_deposits_app3`. Kolom `purpose` membedakan top up saldo (`topup`) dari perpanjang SC langsung (`sc_renewal`). QRIS perpanjang dikreditkan lalu langsung dipakai perpanjang dalam satu transaksi (`settleScRenewalDeposit`); kalau perpanjangan ditolak, dana tetap di saldo pembeli. Test: `npm run test:sc-renewal-payment`.

## Tampilan menu CLI

Menu (`menu-sc-1forcr`, heredoc `MENU_SCRIPT_EOF`) memakai mesin tampilan `ui_*`: bingkai dan banner bergradasi, lebar mengikuti terminal (`ui_layout`, 40–78 kolom), dan empat mode warna (truecolor, 256, 16, none). Mode otomatis memakai truecolor (keputusan pemilik; beban CPU/RAM sama dengan 256 warna, hanya ±9 KB lebih banyak per layar lewat SSH), kecuali konsol teks lama (`TERM=linux`/`vt100`/...) ke 16 warna dan GNU screen ke 256. Pilihan manual di Tools > Tema Warna Menu disimpan di `/etc/sc-1forcr/menu-color` dan selalu menang atas mode otomatis.

- Baris kotak digambar lewat `ui_row`/`ui_kv`/`ui_kv_parts`, yang mengukur lebar tanpa kode warna dan tanpa bergantung locale VPS. Teks bebas dari luar (OS, ISP, kota, nama klien) lewat `ui_fit` supaya dipotong dengan aman.
- Baris dengan beberapa info memakai `ui_kv_parts`: potongan yang tidak muat di layar HP dilewati, bukan dibiarkan menjebol bingkai.
- Fungsi di menu jalan dengan `set -euo pipefail`: jangan akhiri fungsi dengan `[[ ... ]] && ...`, pakai `if` atau `return 0`.
- Satu mesin gaya, `ui_style_line`, dipakai dua jalur. Blok teks lama (tabel, detail akun, layar info) lewat `... | ui_fx`. Semua `echo` yang menuju terminal juga ikut bergaya, karena `menu_styled_echo_enable` mengganti `echo` dengan fungsi. Isi teks tidak berubah, hanya diwarnai: label, status, pesan `Gagal`/`tidak valid` merah, `Peringatan`/`belum tersedia` kuning, `Berhasil` hijau. Echo ke file, pipe, atau `$(...)` tetap builtin polos, begitu juga `echo -n`/`-e` dan tema `none`, jadi data yang dibaca skrip lain tidak tersentuh. Tulis pesan baru dengan `echo` biasa; kata depannya menentukan warnanya.
- Jangan pakai `ui_fx` pada fungsi yang meminta input; bungkus bagian tabelnya saja. Pemilih akun menulis tabelnya ke stderr (`| ui_fx >&2`) karena stdout-nya membawa username yang dipilih. Untuk jeda pakai `menu_pause`, untuk baris `printf "%-12s : %s"` pakai `menu_kv`.
- `ui_style_line` murni bash dan jalan per baris, termasuk di tabel ratusan akun. Setiap aturan regex baru wajib dijaga glob murah dulu (`[[ $s == *kata* && $s =~ ... ]]`), karena bash mengompilasi ulang regex di tiap baris. Baris tabel (spasi kolom ganda, tanpa `": "`) lewat jalur pendek yang hanya mewarnai status.
- Layar monitor memakai `ui_monitor NAMA_FUNGSI`: data diambil sekali, `[r]` ambil ulang, `[l]` live tiap 5 detik, dan redraw tanpa `clear`. Jangan kembali ke loop `clear` + kumpulkan data tiap 1 detik; itu membuat layar berkedip dan membebani VPS kecil.
- Data monitor online diambil lewat collector bersama (`collect_ssh_online_rows`, `collect_xray_online_rows`, `collect_udphc_online_pairs`, `zivpn_online_sql`). Layar per layanan dan layar SEMUA AKUN ONLINE (menu monitor [7]) memakai collector yang sama, jadi perubahan aturan status cukup di satu tempat. Layar SEMUA AKUN mengambil tracker dan log Xray sekali untuk tiga protokol, dan live-nya tiap 10 detik. Test: `npm run test:online-monitor`.
- `trap ... RETURN` yang dipasang fungsi yang dipanggil **menimpa** trap RETURN pemanggilnya. Fungsi yang memanggil collector (yang punya trap sendiri) wajib memasang trap cleanup-nya **setelah** pemanggilan itu; kalau tidak, file temp-nya bocor tiap refresh.
- Test: `npm run test:menu-ui` menggambar dashboard dan menu di 5 lebar layar, 4 mode warna, dan 2 locale, lalu memastikan semua bingkai lurus. Test yang sama memeriksa warna pesan `echo` (termasuk kasus yang tidak boleh salah warna, seperti "Cooldown gagal : 15 menit" dan "Jika ... gagal") dan bahwa echo tanpa terminal tetap polos.

## Bahasa

Komentar, log, dan teks menu memakai bahasa Indonesia. Ikuti gaya yang sudah ada.

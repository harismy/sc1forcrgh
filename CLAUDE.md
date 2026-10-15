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
- UDP Custom (HTTP Custom `host:1-65535@user:pass`) butuh DNAT semua port UDP ke port listen, karena klien mengirim ke port acak di rentang itu. Binary udp-custom memasang DNAT 1:65535 miliknya sendiri saat start (dan memverifikasi `user:pass` lewat PAM, yaitu akun SSH sistem). SC menambah rule bertanda `sc-udpcustom-range` lewat `udpcustom_port_range_rule`, yang ada di installer, `sc-1forcr-udp-bootfix`, dan menu dengan isi identik. **Jangan hapus semua DNAT yang menuju port UDP Custom.** Dulu itu ikut menghapus rule binary di setiap update, boot, dan pindah backend, sehingga akun hanya bisa konek lewat port listen persis (diperbaiki V.1FSC.103). Binary tidak membuang rule-nya saat mati, jadi saat pindah ke ZIVPN `udpcustom_port_range_rule del` membuang rule SC dan rule sisa binary (bentuk persis `-i X -p udp --dport 1:65535 -j DNAT`). DNAT range dan port tambahan ZIVPN tidak pernah disentuh. Test: `npm run test:udpcustom-port-range`.
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
- `HandlerService` bisa membuat akun, jadi hanya aktif kalau rule iptables "hanya root ke 127.0.0.1:10085" dari `apply_tunnel_outbound_guard_rules()` terpasang dan Xray tidak jalan sebagai root. Jangan hapus rule itu. Rule itu tidak menahan Dropbear, ZIVPN, dan UDP Custom, karena forwarding mereka dibuka proses root. Yang menahan mereka adalah pembatas trafik tunnel (lihat "Keamanan trafik tunnel dan sshd").
- Link akun (`createXray` di api.js): WS, gRPC, HTTPUpgrade (`uptls`/`upntls`, path `/up<protokol>`), OneRing untuk aplikasi 1FTunnel (WS TLS dengan SNI `onering:<domain>:<domain>`), dan XHTTP VLESS (`xhttptls`/`xhttpntls`) hanya saat `XRAY_XHTTP_ENABLE=1`. Path link wajib sama dengan inbound di `buildXrayRuntimeConfig()` dan location nginx (`/xhvless` ada di blok 80/8083 lewat HTTP/1.1 dan di blok 8081 lewat h2). `npm run test:xray-links` menjaga ini.

### IP-limit (auto lock multi-login)

Lock yang salah langsung merugikan pembeli, jadi aturannya condong menghindari false positive:

- Semua protokol memakai `countEffectiveDevices()` di iplimit-checker.js: IPv4 per `XRAY_IP_GROUP_MASK` (default `/16`, pool CGNAT operator), IPv6 per `/64`, dan IPv4+IPv6 yang aktif bersamaan dihitung satu perangkat. Jangan menghitung IP mentah untuk keputusan lock.
- Lock butuh dua pengecekan berturut-turut dengan sidik jari kelompok IP yang sama (`sampleSshDeviceLimit`, `sampleXrayIpLimit`). Tidak boleh ada jalur lock dari satu sampel.
- Sesi SSH-WS hanya dihitung kalau klien masih mengirim data sejak pengecekan sebelumnya (kolom `ClientToSSH` di `sshws-quota.tsv`), supaya sesi lama yang mati setelah HP ganti IP tidak terbaca sebagai perangkat kedua.
- Toleransi ZIVPN limit 1 (maksimal 2 IP dihitung 1) sengaja dipertahankan. Jangan diperketat tanpa data dari `iplimit_lock_history`.
- **UDP dan Xray memakai ambang lock = limit × 2, dihitung per kelompok subnet `/16`; SSH tetap di limit.** Keputusan pemilik, dari dua kasus nyata yang membuktikan operator seluler (XL) memecah satu HP ke banyak IP: `seharr1234` (1 HP XL di 3 subnet `/16` berbeda) dan `vpn444` (15 IP XL di satu `/24` yang sama). Karena itu, jumlah IP tidak bisa dipakai membedakan 1 HP dari banyak HP untuk operator seperti XL.
  - Ambang: limit 1 → aman sampai 2 jaringan, lock di 3+. Limit 2 → aman sampai 4, lock di 5+. Di checker: `udpDeviceLimit`/`xrayDeviceLimit = lim * 2`.
  - Hanya UDP (ZIVPN/UDP Custom) dan Xray (VMess/VLESS/Trojan) yang dapat ×2. SSH langsung dan SSH-WS tetap di `lim` (biasanya jaringan tetap). Di jalur SSH, evidence dikumpulkan per sumber dengan ambang masing-masing (`[count, ips, threshold]`).
  - `countEffectiveDevices(ipSet, mask)` dan `ipGroupFingerprint(ipSet)` murni per subnet — tidak ada lagi argumen operator. **Dulu pernah ada penggabungan per-ASN lewat DNS (`IPLIMIT_MERGE_ASNS`, `primeOperatorGroups`, tabel `ip_operator_cache`); itu dibuang seluruhnya karena justru menyebabkan false lock `vpn444` (15 IP → 8 perangkat pada aturan "2 IP = 1 perangkat").** Jangan hidupkan kembali pendekatan hitung-per-IP untuk operator.
- Test: `npm run test:iplimit-devices` dan `npm run test:xray-iplimit`.

### ON/OFF layanan (menu [08])

`/usr/local/sbin/sc-1forcr-service-gate` (heredoc `SERVICE_GATE_EOF`) mematikan layanan dengan menolak trafiknya di iptables, **bukan** dengan stop/mask service. Watchdog, update, dan restart chain me-restart service yang mati, jadi service systemd harus tetap jalan.

- Status disimpan di `SERVICE_{SSH,VMESS,VLESS,TROJAN,UDP}_ENABLE` (default 1) plus `XRAY_XHTTP_ENABLE`. Chain `SC1FORCR_SVC_OUT` (port lokal: sshws 2082, inbound Xray per protokol) dan `SC1FORCR_SVC_IN` (Dropbear publik, port listen UDP). Semua ON = tidak ada chain sama sekali.
- Jump ke chain harus rule **pertama** di INPUT/OUTPUT, supaya sesi yang sudah tersambung juga putus dan rule ACCEPT 80/443/109/143 tidak mendahuluinya. `apply` memeriksa posisinya dan dipanggil di akhir install/update, di heal SSHWS, dan tiap siklus watchdog.
- Port sshd tidak pernah ikut ditutup (akses admin). Menutup VMess/VLESS/Trojan tidak me-restart Xray. XHTTP satu-satunya yang me-restart Xray (lewat restart API), dan status lamanya dipulihkan kalau Xray tidak memuat inbound baru.
- API menolak akun baru (503) untuk layanan yang OFF. Akun SSH baru hanya ditolak kalau SSH **dan** UDP OFF, karena akun SSH juga dipakai login ZIVPN/UDP Custom.
- Port inbound Xray baru wajib ditambahkan ke `VMESS_PORTS`/`VLESS_PORTS`/`TROJAN_PORTS` di script ini, atau layanan itu tidak ikut tertutup. Test: `npm run test:service-gate`.

### Keamanan trafik tunnel dan sshd

Akun VPN tidak boleh bisa dipakai menyerang VPS ini atau server lain.

- **Dropbear 2019.78 (default) tidak menurunkan hak akses setelah login**, jadi koneksi forwarding pengguna SSH-WS/Dropbear dibuka proses root. ZIVPN dan UDP Custom juga jalan sebagai root. Akibatnya semua rule `! --uid-owner 0` (port penyalahgunaan, penjaga 10085) **tidak berlaku** untuk mereka.
- Solusinya grup `sc-1forcr-tunnel`:
  - Dropbear, ZIVPN, dan UDP Custom mendapat `Group=sc-1forcr-tunnel` lewat drop-in `40-sc-1forcr-tunnel-group.conf`. User tetap root, jadi akses file tidak berubah.
  - Akun SSH memakai grup itu sebagai grup utama: `useradd -g` di api.js, dan akun lama dipindah otomatis oleh pembatas (akun dikenali dari shell tunnel).
  - Xray dikenali lewat UID `nobody`.
  - Group= baru aktif saat service itu restart berikutnya. Update aman sengaja tidak me-restart, supaya pengguna tidak putus.
- **Mode longgar (keputusan pemilik, V.1FSC.102).** Akun VPN sengaja dibuat bebas nge-ping dan konek ke mana saja (ke VPS ini maupun ke luar) supaya segala jenis tunneling/bug untuk ubah kuota dan "calculating ping" lancar. Pernah jadi penyebab nyata: hardening V.96–98 menolak ICMP dan TCP non-whitelist dari akun VPN ke IP VPS sendiri (banyak app injector mengukur "ping" dengan nge-ping server/host bug = IP VPS), jadi app stuck di "calculating ping". Yang penting: ini **bukan** satu-satunya penyebab "calculating ping" — lapisan lain adalah mux memakan identitas SSH sebelum tunnel naik (lihat "Multi path WS", V.99/V.100). Host bug WC bertingkat (mis. `api.quipper.com.id1-1forcr.zivpn.site`) **tidak** perlu perubahan validator: `certificate_dns_host_valid`/`sanitize_domain_host`/`isDomainLike` sudah menerima host multi-label, nginx `*.base` cocok sampai kedalaman berapa pun dan blok tunnel satu-satunya di port 80 jadi default server (melayani Host apa pun), dan HAProxy memilih backend dari payload bukan allowlist SNI. Yang bikin host bug benar-benar jalan itu DNS wildcard + klien skip verifikasi TLS, bukan gerbang di SC.
- `/usr/local/sbin/sc-1forcr-tunnel-guard` (heredoc `TUNNEL_GUARD_EOF`) memeriksa paket NEW milik grup/UID itu. Dalam mode longgar yang tetap ditutup cuma yang fatal dan tak dipakai tunneling:
  - **ICMP echo (ping) selalu lolos** ke mana saja (RETURN di awal `SC1FORCR_TUN_OUT`).
  - Ke alamat VPS sendiri (`addrtype LOCAL`): semua lolos **kecuali** API Xray `10085` (bikin akun Xray gratis). sshd tetap dibatasi 4 koneksi baru/menit untuk semua akun VPN sekaligus; Dropbear, mux 2082, dan nginx internal **tidak lagi** ditolak (yang 127.0.0.1-only tetap aman karena tidak ada listener di IP publik).
  - sshd sengaja dibuka (`TUNNEL_ADMIN_SSH_ALLOW`, default 1). Pernah jadi keluhan nyata: setelah V.1FSC.96 pemilik VPS tidak bisa SSH ke VPS-nya sambil konek VPN (SSH maupun Xray) lewat VPS yang sama, karena koneksi itu keluar dari Xray/Dropbear lalu masuk lewat `lo`, jadi kena pembatas ini dan tidak pernah melewati batas brute force per IP di INPUT. Batas 4/menit itu yang menggantikan batas per IP untuk jalur ini; jangan dibuka tanpa batas. `TUNNEL_ADMIN_SSH_ALLOW=0` menutup lagi sshd (REJECT).
  - Ke metadata cloud `169.254.169.254` (IPv6 `fd00:ec2::254`): ditolak penuh (TCP/UDP), karena pencurian kredensial VPS fatal dan tidak dipakai tunneling. Jaringan privat lain (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, fe80::/10) **dibiarkan lolos**.
  - Port penyalahgunaan (`TUNNEL_ABUSE_BLOCK_TCP_PORTS`: SMTP/RDP/VNC/SMB), plus port SSH kalau `SSH_TUNNEL_BLOCK_OUTBOUND_SSH=1`. Ini dipertahankan untuk menjaga reputasi IP VPS (spam/scan) dan tidak memengaruhi tunneling kuota; matikan dengan `TUNNEL_ABUSE_GUARD_ENABLE=0`.
  - Koneksi baru ke sshd dibatasi per IP: 15/menit, burst 30, per /64 untuk IPv6. Port milik SC dan Dropbear tidak pernah ikut.
  - Dipanggil install/update dan tiap siklus watchdog, sebelum gerbang ON/OFF. iptables hanya ditulis ulang kalau aturan berubah atau hilang. Script ini **tidak boleh** memanggil systemctl.
  - Bisa dimatikan lewat `TUNNEL_LOCAL_GUARD_ENABLE` dan `SSH_BRUTE_GUARD_ENABLE`. `TUNNEL_ADMIN_SSH_ALLOW=0` menutup lagi sshd untuk trafik tunnel.
- Kalau menambah layanan lokal yang **memang** perlu dijangkau dari tunnel, tambahkan port-nya ke `LOCAL_ALLOW` di script itu. Kalau tidak, pengguna VPN tidak bisa memakainya.
- Dropbear jalan dengan `-w` (root hanya lewat sshd) dan `-k` (tanpa remote forwarding) di ketiga salinan `dropbear_runtime_args`. VPS lama disisipi flag ini oleh `ensure_dropbear_hardening_flags`, tanpa me-restart Dropbear yang sedang jalan.
- sshd (`apply_sshd_hardening`):
  - Isinya `AllowTcpForwarding local`, `AllowStreamLocalForwarding no`, `GatewayPorts no`, `PermitTunnel no`, `X11Forwarding no`, dan `LoginGraceTime 30`.
  - Ditulis sebagai drop-in `00-sc-1forcr.conf`. Kalau tidak efektif, dipakai blok bertanda di baris teratas sshd_config.
  - Divalidasi `sshd -t`, dipulihkan kalau gagal, lalu `reload` (bukan restart).
  - **`PermitRootLogin` dan `PasswordAuthentication` sengaja tidak disentuh**, supaya pemilik VPS tidak terkunci.
- Test: `npm run test:tunnel-security`.

### Port TLS/NTLS tambahan

`/usr/local/sbin/sc-1forcr-extra-ports` (heredoc `EXTRA_PORTS_EOF`) membuka port selain 443/80 dengan mengalihkannya di kernel: chain nat `SC1FORCR_PORTS` berisi `REDIRECT` ke 443 (TLS, HAProxy) atau 80 (NTLS, nginx). Tidak ada service atau listener baru, jadi path, multi path, real IP, limit, dan ON/OFF layanan otomatis sama dengan 443/80.

- Daftar port ada di `EXTRA_TLS_PORTS` (default `8443,2053,2083,2087,2096`) dan `EXTRA_NTLS_PORTS` (default `8080,8880,2052,2082,2086,2095`). `off` mematikan. Bisa diubah di menu Tools > Port TLS/NTLS Tambahan.
- Port publik SC (22, 80, 443, Dropbear), port sshd, dan port yang sedang dipakai program lain di alamat publik (`ss -tlnp`) dilewati dan dicatat di `SKIPPED`. Listener 127.0.0.1 (mux SSH-WS di 2082, nginx 8080 mode real IP) **tidak** bentrok, karena REDIRECT di PREROUTING hanya berlaku untuk paket dari luar. Jangan ganti cara ini dengan `listen`/`bind` publik di nginx/HAProxy: port 2082 dan 8080 akan bentrok dengan listener loopback itu.
- Jump ke chain memakai `-m addrtype --dst-type LOCAL`, supaya trafik yang diteruskan VPS (docker, VPN milik pemilik) tidak ikut berbelok. IPv6 hanya dipasang untuk target yang memang listen di IPv6 (HAProxy 443 saat ini IPv4 saja).
- `apply` dipanggil di akhir install/update, dari menu, dan tiap siklus watchdog. Aturan dan `netfilter-persistent save` hanya ditulis kalau berbeda, jadi siklus watchdog tanpa perubahan tidak menyentuh iptables.
- Hasilnya ditulis ke `/var/lib/sc-1forcr/extra-ports.state`. api.js membacanya untuk `port.tls_all`/`port.none_all`. Kunci `port.tls`/`port.none` tetap satu port (443/80), karena bot jualan lain membacanya sebagai satu angka. Test: `npm run test:extra-ports`.

### Mode Bot Panel (bot jualan akun di VPS)

`${APP_DIR}/bot-panel.js` (heredoc `BOT_PANEL_EOF` di `install_bot_panel`) adalah bot Telegram jualan akun: buat, trial, perpanjang, top up saldo, dan multi server. `BOT_PANEL_ENABLE=0` (default) = service `sc-1forcr-botpanel` mati. Dinyalakan dari menu Tools > Mode Bot Panel.

- **Bot jualan terpisah dari bot notif** (keputusan pemilik). Bot jualan hanya memakai `BOT_PANEL_TOKEN` dan `BOT_PANEL_ADMIN_IDS`, dan tidak pernah membaca `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`. Bot notif tetap mengirim notif api.js, backup, dan notif online seperti biasa, apa pun status Bot Panel, dan menu Setting BOT Telegram tidak menyentuh Bot Panel. Kabar toko (top up masuk, penjualan, pesanan bermasalah, bentrok token) dikirim bot jualan ke chat pribadi admin. Menu menolak token bot jualan yang sama dengan token bot notif, dan mengecek token ke Telegram (`getMe`) sebelum disimpan. `TELEGRAM_CHAT_ID` pribadi hanya dipakai sebagai usulan saat mengisi admin, lalu disimpan eksplisit ke `BOT_PANEL_ADMIN_IDS`.
- Menu hanya dilayani di chat pribadi; pesan dan tombol dari grup diabaikan.
- **Satu token bot jualan = satu Bot Panel.** Telegram menolak `getUpdates` ganda (409); bot memberi tahu admin maksimal tiap 6 jam. VPS lain didaftarkan di Menu Admin > Kelola Server lewat domain + Auth Token SC-nya, lalu dipanggil lewat `https://DOMAIN/vps/*`. Server ini sendiri dipanggil lewat `127.0.0.1:PORT` dengan `API_AUTH_TOKEN` dari env, dan baru tampil ke pembeli setelah harganya diisi (supaya tidak pernah terjual gratis karena lupa diatur).
- Detail akun memakai formatter yang sama dengan menu dan BotVPN (disalin dari BotVPN `modules/accountMessages.js`), dicek terhadap `scripts/fixtures/account-message-parity.json`.
- **Aturan uang** (saldo = uang pembeli):
  - Saldo hanya berubah di dalam `tx()` lewat `applyBalance()`, yang menolak saldo minus dan mencatat `ledger`. Jangan memanggil jaringan di dalam `tx()`.
  - Beli/perpanjang: saldo dipotong dulu, lalu API dipanggil. Gagal pasti (jawaban error API, gagal sambung) = refund otomatis. Hasil tidak pasti (timeout, koneksi putus, 502/504, 5xx tanpa JSON API) = pesanan `review`, saldo tertahan, admin memilih Refund atau Selesai. Pesanan yang masih `processing` saat bot start juga jadi `review`.
  - Tombol konfirmasi hanya berlaku sekali (state `pending` per pengguna), dan update tiap pengguna diproses berurutan, jadi klik ganda tidak memotong dua kali.
  - Top up dikredit dengan `UPDATE ... WHERE status='pending'` di dalam transaksi yang sama dengan kredit saldo, jadi tidak pernah dobel. Batal ditolak kalau status gateway tidak bisa dicek; QRIS kedaluwarsa saat gateway tidak bisa dihubungi tetap ditunggu 30 menit.
- Payment gateway AutoGoPay sama dengan BotVPN: GoPay `POST /qris/generate` + `POST /qris/status`, ShopeePay `POST /shopeepay/qris/create` + `GET /shopeepay/qris/status`, header `Bearer`. QRIS dikirim sebagai URL gambar dari gateway, dan pengecekan status (tiap 10 detik) hanya berjalan selama ada top up yang menunggu.
- Hemat resource: tanpa dependensi baru (modul bawaan Node + `sqlite3` milik api.js), long polling 50 detik. Unit memakai `DynamicUser=yes` + `StateDirectory=sc-1forcr-botpanel` (bot menerima input publik, jadi bukan root), `MemoryMax=${BOT_PANEL_MEMORY_MAX}` (128M), `Nice=5`, `CPUQuota=40%`, dan `--max-old-space-size=64`. Terukur sekitar 42 MB RSS setelah 600 update. Menu menampilkan perkiraan dampak dan meminta konfirmasi di VPS di bawah 2 GB / 2 vCPU.
- Pulih sendiri: `Restart=on-failure`, dan bot keluar dengan kode 1 kalau polling Telegram macet 15 menit. Bot keluar dengan kode 0 (tetap mati) kalau mode OFF, `BOT_PANEL_TOKEN` kosong, atau token itu ditolak Telegram. Installer hanya menyalakan service kalau `BOT_PANEL_ENABLE=1` dan `BOT_PANEL_TOKEN` terisi.
- Database `/var/lib/sc-1forcr-botpanel/bot-panel.db` (fisiknya di `/var/lib/private/`) **tidak** ikut auto-backup SC. Bot mengirim backup harian dan manual ke admin; restore dengan mengirim file itu ke bot dengan caption `/restore` (database lama disimpan, maksimal 3). Uninstall tidak menghapus database ini.
- `install_bot_panel || true` dipanggil di jalur install penuh dan update aman; gagal di sini tidak boleh membuat install gagal atau memicu rollback. Saat aktif, service di-restart supaya kode baru dipakai (tidak menyentuh layanan tunnel). `BOT_PANEL_*` ada di `.env` aplikasi, dump `/etc/sc-1forcr.env`, `persist_pending_install_env`, dan daftar env update dari menu.
- Test: `npm run test:bot-panel` (butuh Node 22.5+ untuk `node:sqlite`; dilewati kalau tidak ada). Untuk mengembangkan file lepas: `BOT_PANEL_SOURCE=path/bot-panel.js`.

### Multi path WS (path bebas)

SSH-WS sudah menerima path apa saja lewat nginx `location /` ke mux 2082. Untuk VMess/VLESS/Trojan WS dengan path bebas, mux Go (`handleRealWebSocket` di `ssh_mux.go`) yang memilih inbound:

- Hanya klien WebSocket asli (mengirim `Sec-WebSocket-Key`) yang masuk jalur ini. Payload SSH-WS tanpa key tetap memakai jalur lama.
- Mux menjawab 101 sendiri (dengan `Sec-WebSocket-Accept`), lalu membaca frame pertama tanpa memakannya. Trojan = 56 hex + CRLF. VLESS = byte versi 0 + UUID yang terdaftar di config Xray (dibaca ulang kalau file berubah); kalau config tidak terbaca, versi 0 saja sudah cukup. Selain itu VMess. Early data (`Sec-WebSocket-Protocol`) diklasifikasi langsung dari header.
- Data `SSH-` setelah 101, data yang bukan frame klien, atau klien yang diam 3 detik (menunggu banner server) diteruskan ke SSH seperti biasa.
- Koneksi diteruskan langsung ke inbound Xray (10001–10003) dengan path standar, bukan lewat nginx, supaya tidak ada putaran nginx ↔ mux. `X-Forwarded-For` diperlakukan sama dengan location nginx (diganti IP asli + `X-SC-Real-IP-Proxy` saat `XRAY_REAL_IP_ENABLE=1`), dan header internal `X-SC-SSHWS-IP` tidak pernah diteruskan. Tracker IP-limit Xray dan service gate tetap bekerja karena koneksi masuk ke port inbound yang sama.
- Klien WebSocket asli dikecualikan dari limit SSH-WS nginx (`$sc_sshws_limit_scope` kosong), sama seperti `/vmess` yang tidak dibatasi. Kalau tidak, satu HP Xray tanpa mux bisa kena 429.
- Path yang diawali `/vmess`, `/vless`, `/trojan`, `/yourbug`, `/up*`, `/xhvless`, `/vps/`, `/docs` tetap milik location nginx-nya. gRPC, HTTPUpgrade, dan XHTTP tidak ikut multi path.
- Update aman tidak me-restart mux (supaya SSH-WS tidak putus), jadi binary baru aktif setelah restart `sc-1forcr-sshws` atau reboot. Mux menulis `/run/sc-1forcr/sshws-multipath` saat start. api.js (`xrayMultipathActive`, yang mengisi `path.any` dan "atau path bebas" di detail akun) dan menu hanya menyebut path bebas kalau penanda itu ada.
- Teks HTTP palsu dari payload `[split]` (misalnya `HTTP/enhanced 200 OK\r\n\n`, `\n` literal, request PATCH/GET kedua, atau potongan kecil) dibuang oleh `sshClientSide`/`sshJunkSkipConn` di semua jalur SSH setelah 101, sebelum identitas `SSH-` klien. Pernah jadi bug nyata: cara lama membaca sampai `\r\n\r\n`, sehingga payload ber-penutup lain membuat mux memakan identitas SSH klien dan HTTP Custom/1FTunnel macet setelah `101` (penutup `[crlf][crlf]` lolos, `[crlf]\n` macet). V.1FSC.99 memperbaiki penutup itu tapi masih punya celah: ia menyerah menyaring begitu potongan pertama tidak tampak seperti HTTP (`\n` literal sendirian, awalan method `PAT` yang terpotong) lalu menempel ke identitas, dan memotong di `SSH-` **pertama** walau itu bagian sampah (mis. `User-Agent: SSH-Client`). Penyaring sekarang berbasis teks, bukan tebak-HTTP: **`isTextJunk` menahan semua byte selama masih teks ASCII yang bisa dicetak (≤16 KB) sampai identitas muncul**, dan **`sshIdentIndex` hanya menerima `SSH-2.0`/`SSH-1.` di mana saja atau `SSH-` polos di awal baris** supaya token mirip identitas di tengah teks sampah tidak salah potong. Byte biner pertama (atau lewat batas) → sisanya diteruskan apa adanya; SSH mentah dan protokol non-teks tidak terganggu. Jangan kembali ke pembacaan header yang menunggu penutup, atau ke `bytes.Index("SSH-")` polos. Kalau identitas tak kunjung datang (lewat 16 KB), mux menulis satu baris `[sshws]` ke stderr/journald, dibatasi sekali per 30 detik (`logSSHWSAnomaly`, cuplikan di-escape). Test `TestSplitJunk*`, `TestFragment*`, `TestSplitJunkFakeSSHToken`, `TestSSHIdentIndex`.
- `readHttpHeader` berhenti di `\r\n\r\n` **atau** `\n\n` (sebagian klien menutup header dengan LF saja; `\r\n\r\n` tidak ikut cocok ke cabang `\n\n` karena dua byte terakhirnya `\r\n`). Setelah `CONNECT ... 200`, klien SSH-over-CONNECT bisa langsung mengirim `SSH-` atau diam menunggu banner server; dua-duanya dulu macet di `readHttpHeader` sampai deadline 10 detik. Sekarang mux mengintip dulu dengan deadline pendek (`firstFrameWait`): `SSH-` atau klien diam → langsung tunnel SSH, selain itu lanjut parse request HTTP berikutnya (jalur injektor `[split]` yang menunggu `101` tetap utuh). Test `TestConnectThen*`, `TestBareLFHeaderUpgrade`.
- Satu-satunya hal yang memang tidak bisa dibetulkan di mux: payload dengan **header `Host` ganda** (mis. 1FTunnel `Host: a\r\nHost: b`) ditolak nginx dengan `400 client sent duplicate host header` yang hardcoded, sebelum sampai ke `location /`. Tidak ada directive nginx untuk mengizinkannya tanpa melonggarkan parsing untuk Xray dan `/vps/`, jadi dibiarkan apa adanya; lewat proxy/CF yang menggabungkan Host, payload itu tetap jalan. Kalau satu akun saja yang gagal sementara payload yang sama jalan di akun lain, periksa status akun (quota/expired/lock/batas sesi), bukan mux atau nginx. Mux juga **tidak** perlu membalas request `[split]` kedua: teks `HTTP/... 200 OK` di dalam payload itu ditulis klien sendiri untuk mengelabui proxy hulu, bukan ditunggu dari server; menjawabnya malah merusak urutan aliran SSH.
- **Perbaikan mux hanya aktif setelah binary-nya di-restart.** Update aman tidak me-restart `sc-1forcr-sshws`, jadi VPS yang baru di-update masih memakai mux lama sampai `systemctl restart sc-1forcr-sshws` atau auto-reboot harian 03:00. Ini sering jadi sebab "masih stuck" padahal versi script sudah naik.
- Go di VPS berasal dari paket distro (Ubuntu 20.04 = Go 1.13). Kode mux tidak boleh memakai API Go 1.14 ke atas; `npm run test:mux-multipath` memeriksanya, dan menjalankan uji perilaku `scripts/go/ssh_mux_multipath_test.go` kalau `GO_BIN` atau `go` tersedia. `XRAY_MULTIPATH_ENABLE=0` mematikan jalur ini (perlu restart `sc-1forcr-sshws`).

Timeout HAProxy sengaja panjang (`timeout client/server 12h`) supaya tunnel WS tidak putus sendiri. Yang menjaga socket mati tidak menumpuk adalah `option clitcpka`/`srvtcpka` plus sysctl keepalive agresif (`tcp_keepalive_time=60`, `intvl=15`, `probes=4`). Ketiganya satu paket. Jangan hapus salah satu tanpa mengganti mekanisme penggantinya.

Log HAProxy memakai `log /dev/log local0 notice alert`. Kata `alert` di ujung membatasi level paling parah: tanpa itu, "backend ... has no server available!" dikirim sebagai `emerg` dan disiarkan ke semua terminal yang sedang login, termasuk layar menu dan layar install. Pesan itu pasti muncul di setiap install baru, karena HAProxy dipasang sebelum layanan SSH-WS hidup. Konfigurasi ditulis di dua tempat (`setup_haproxy_tls_mux` dan salinannya di script menu); keduanya harus sama.

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

### OS yang didukung

Install **baru** hanya diterima di Debian 12 ke atas dan Ubuntu 20.04 ke atas (keputusan pemilik). Debian 10 sudah dicabut dari mirror utama dan Debian 11 habis masa dukungnya 31 Agustus 2026.

- Batasnya ada di `unsupported_os_reason()` (blok bertanda `os-support`). Install baru di OS yang tidak didukung ditolak di level atas script, **sebelum** input domain dan validasi lisensi.
- `check_supported_os` juga jalan di jalur update. VPS yang sudah terpasang (`sc_is_installed`: `UPDATE_SAFE_MODE=1`, atau `/etc/sc-1forcr.env` dan menu sudah ada) tidak boleh ditolak walau OS-nya lama; ia hanya mencatat peringatan. Kalau ikut ditolak, update VPS Debian 10/11 yang sudah ada gagal selamanya.
- Teks bot (panduan install dan daftar fitur di app3.js) harus menyebut batas yang sama. Test: `npm run test:os-support`.

### Debian 11 (bullseye) sudah habis masa dukungnya

Debian 11 tidak lagi diterima untuk install baru, tapi VPS Debian 11 yang sudah terpasang tetap di-update dan tetap butuh `apt`. Repo keamanannya rusak di sisi Debian: file `.deb` `bullseye-security` dihapus dari mirror awal September 2026 sementara indeksnya dibiarkan. Akibatnya `apt-get install` berujung 404, dan `apt-get update` tidak menolong karena indeksnya memang tidak berubah. Perbaikan di bawah ini dipertahankan untuk VPS lama itu.

- `ensure_bullseye_security_repo` (blok bertanda `bullseye-security-repo`) memindahkan repo itu ke snapshot.debian.org `20260831T211327Z`. Indeks snapshot itu identik dengan indeks terakhir di mirror, jadi versi paket tidak berubah. Baris lama dijadikan komentar, dan sumber apt tidak disentuh kalau snapshot tidak terjangkau.
- Blok itu ada di [scripts/setup-autoscript-compat.sh](scripts/setup-autoscript-compat.sh) **dan** [scripts/setup-summary-api.sh](scripts/setup-summary-api.sh), dan isinya harus identik.
- Mode `probe` dipanggil `apt_get_safe` sebelum setiap `install`: pindah hanya kalau file yang akan diunduh terbukti 404, jadi mirror provider yang masih lengkap dibiarkan. Mode `force` dipakai setelah `apt-get install` sungguhan gagal. Pasang paket lewat `apt_get_safe`, jangan `apt-get install` langsung.
- Perintah yang diketik pembeli sebelum installer jalan (langkah 2 di panduan install bot, dan README) memakai `--no-upgrade` dan hanya memasang yang dibutuhkan untuk mengunduh installer. Tanpa itu apt ikut meng-upgrade paket dari repo security dan gagal 404 sebelum installer sempat memperbaiki repo. Jangan tambahkan `jq` atau `build-essential` ke sana; keduanya dipasang installer.
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

- Pesan panduan install untuk pembeli (`buildInstallGuideLines` di app3.js) ditulis untuk pemula: syarat dulu, lalu satu langkah satu perintah, dengan keterangan apa yang dilakukan. Tiap perintah dikirim sebagai blok kode Telegram lewat `installCommandBlock()` (`<pre><code class="language-bash">`), supaya tampil sebagai kotak dengan tombol salin; jangan kembali ke `<code>` di dalam kalimat. Link installer tidak ditampilkan di luar perintah langkah 3, karena pembeli mengira itu link yang harus dibuka. Pesan umum dan pesan per VPS memakai panduan yang sama. Test: `npm run test:install-guide`.
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
- Payment gateway bot hanya AutoGoPay ([lib/autogopay.js](lib/autogopay.js)): GoPay dan ShopeePay memakai **satu** base URL dan **satu** API key (`GOPAY_API_BASE_URL`, `GOPAY_API_KEY`; nama lama dipertahankan supaya `.vars.json` lama tetap terbaca). OrderKuota sudah dihapus.
  - Mode `PAYMENT_GATEWAY_MODE`: `gopay`, `shopee`, atau `both` (GoPay dulu, ShopeePay kalau GoPay gagal **membuat** QRIS). Nilai lama `orderkuota` dibaca sebagai `shopee`, dan nilai kosong sebagai `both`.
  - `gateway_provider` di `pending_deposits_app3` menentukan gateway yang dicek. Status lunas hanya dari bukti positif gateway (GoPay `settlement`, ShopeePay `paid`/`order_status` 1). Nominal atau `order_sn` yang tidak cocok ditolak, dan respons error tidak pernah dianggap lunas. Transaksi `orderkuota` lama tidak bisa dicek lagi dan dibiarkan kedaluwarsa.
  - Test: `npm run test:autogopay`.
- **Rebuild VPS** (menu utama, tombol merah) memasang ulang Debian 12/13 atau Ubuntu 20.04/22.04/24.04 lewat [bin456789/reinstall](https://github.com/bin456789/reinstall). Ini **satu-satunya jalur SSH dari bot ke VPS**: bot login root dengan password yang diketik pembeli ([lib/vps-rebuild.js](lib/vps-rebuild.js), dependensi `ssh2`, di-require lazy supaya bot tetap start tanpa modul itu). Bisa dipakai semua pembeli (keputusan pemilik), jadi:
  - Target hanya IP yang terdaftar aktif atas nama user itu (`getRegistrationStateByIp`), dicek di awal dan lagi sebelum eksekusi. Jangan buka input IP bebas: bot akan jadi alat SSH ke host orang lain.
  - Konfirmasi dengan mengetik ulang IP, dan hanya satu job `running` per user.
  - Password root hanya di memori (`userState` lalu `rebuildSecrets`), tidak pernah ke `vps_rebuild_jobs` atau log. Output skrip disensor `scrubSecret` sebelum ditampilkan, karena reinstall.sh mencetak `Password: ...`.
  - **reinstall.sh tidak reboot sendiri**: ia menyiapkan entri boot lalu keluar. Bot memicu `REBOOT_COMMAND` hanya setelah exit 0. Skrip wajib diberi `--username` dan `--password` plus stdin `/dev/null`; tanpa itu ia menunggu `read -p` selamanya. `--ssh-port` dioper kalau port bukan 22, supaya OS baru tetap di port yang sama (kalau tidak, OS baru default ke 22 dan poller yang memakai port lama tak pernah connect). Kalau persiapan timeout, `CANCEL_COMMAND` menjalankan `reinstall.sh reset` supaya auto-reboot 03:00 tidak memulai wipe tanpa diminta. Pola `pkill` di sana sengaja tidak cocok dengan shell-nya sendiri.
  - Selesai dideteksi `pollRebuildJobs` → `evaluateRebuildJob` (tiap 60 detik), **dua sinyal** supaya tidak menggantung: (1) login OS baru + `/etc/os-release` cocok + host key berubah, 2x berturut = pasti; (2) kalau login gagal (OS baru menolak login root password, beda port, atau password hilang dari memori karena bot restart) tetap pakai perubahan host key saja, 3x berturut = "kemungkinan". Keduanya minimal 7 menit sejak mulai. **Jangan kembali ke jalur login-saja**: dulu pernah bikin job menggantung tanpa notif saat login OS baru gagal. Setiap poll menulis satu baris log `[rebuild] poll ...` (tanpa password) untuk diagnosa. Notif selesai menyertakan panduan install SC; machine-id berubah, jadi bisa perlu "Reset Binding VPS".
  - Pembeli punya kontrol manual saat job berjalan (tombol di pesan status): "Cek Status Sekarang" (`evaluateRebuildJob` sekali jalan), "Sudah Selesai, Kirim Panduan Install" (tandai `done` + kirim panduan tanpa menunggu poller), dan "Stop Pantau" (`cancelled`).
  - Test: `npm run test:vps-rebuild` (logika murni, tanpa SSH).
- **Anti jualan di grup** ([lib/anti-sales.js](lib/anti-sales.js)). Bot bisa dipasang di grup mana saja sebagai admin dengan izin Hapus Pesan dan Blokir Pengguna. Pesan jualan/promosi anggota dihapus, pengirimnya dimute `ANTI_SALES_MUTE_MINUTES` (default 60), dan bot memberi peringatan dengan tombol "Buka Mute" yang hanya bisa dipakai admin grup. Aktif secara default; admin grup mematikan dengan `/antijualan off`, dan pengaturannya disimpan di tabel `anti_sales_groups`.
  - **Grup hanya dilayani anti jualan.** Middleware `bot.use` di app3.js terdaftar sebelum semua handler dan tidak meneruskan update grup. Menu jualan dan `userState` (per `chat.id`) khusus chat pribadi, karena di grup teks anggota lain bisa terbaca sebagai input alur orang lain, termasuk input admin. `/start`/`/menu`/`/admin` di grup hanya dijawab "buka lewat chat pribadi".
  - Deteksi condong menghindari salah mute: skor dari kata jualan, harga, kontak/link keluar, dan link undangan grup, dikurangi untuk pertanyaan pembeli dan konfirmasi bayar. Satu kata saja tidak cukup. Admin grup, admin bot, admin anonim, dan channel tertaut tidak pernah ditindak. Kalau daftar admin tidak terbaca, bot tidak menindak.
  - Kalau menambah pola deteksi, tambahkan contoh positif **dan** negatif di `scripts/test-anti-sales.js`. Test: `npm run test:anti-sales`.

## Tampilan menu CLI

Menu (`menu-sc-1forcr`, heredoc `MENU_SCRIPT_EOF`) memakai mesin tampilan `ui_*`: bingkai dan banner bergradasi, lebar mengikuti terminal (`ui_layout`, 40–78 kolom), dan empat mode warna (truecolor, 256, 16, none). Mode otomatis memakai truecolor (keputusan pemilik; beban CPU/RAM sama dengan 256 warna, hanya ±9 KB lebih banyak per layar lewat SSH), kecuali konsol teks lama (`TERM=linux`/`vt100`/...) ke 16 warna dan GNU screen ke 256. Pilihan manual di Tools > Tema Warna Menu disimpan di `/etc/sc-1forcr/menu-color` dan selalu menang atas mode otomatis.

- Baris kotak digambar lewat `ui_row`/`ui_kv`/`ui_kv_parts`, yang mengukur lebar tanpa kode warna dan tanpa bergantung locale VPS. Teks bebas dari luar (OS, ISP, kota, nama klien) lewat `ui_fit` supaya dipotong dengan aman.
- Baris dengan beberapa info memakai `ui_kv_parts`: potongan yang tidak muat di layar HP dilewati, bukan dibiarkan menjebol bingkai.
- Fungsi di menu jalan dengan `set -euo pipefail`: jangan akhiri fungsi dengan `[[ ... ]] && ...`, pakai `if` atau `return 0`.
- Satu mesin gaya, `ui_style_line`, dipakai dua jalur. Blok teks lama (tabel, detail akun, layar info) lewat `... | ui_fx`. Semua `echo` yang menuju terminal juga ikut bergaya, karena `menu_styled_echo_enable` mengganti `echo` dengan fungsi. Isi teks tidak berubah, hanya diwarnai: label, status, pesan `Gagal`/`tidak valid` merah, `Peringatan`/`belum tersedia` kuning, `Berhasil` hijau. Echo ke file, pipe, atau `$(...)` tetap builtin polos, begitu juga `echo -n`/`-e` dan tema `none`, jadi data yang dibaca skrip lain tidak tersentuh. Tulis pesan baru dengan `echo` biasa; kata depannya menentukan warnanya.
- Jangan pakai `ui_fx` pada fungsi yang meminta input; bungkus bagian tabelnya saja. Pemilih akun menulis tabelnya ke stderr (`| ui_fx >&2`) karena stdout-nya membawa username yang dipilih. Untuk jeda pakai `menu_pause`, untuk baris `printf "%-12s : %s"` pakai `menu_kv`.
- `ui_style_line` murni bash dan jalan per baris, termasuk di tabel ratusan akun. Setiap aturan regex baru wajib dijaga glob murah dulu (`[[ $s == *kata* && $s =~ ... ]]`), karena bash mengompilasi ulang regex di tiap baris. Baris tabel (spasi kolom ganda, tanpa `": "`) lewat jalur pendek yang hanya mewarnai status.
- Layar monitor memakai `ui_monitor NAMA_FUNGSI`: data diambil sekali, `[r]` ambil ulang, `[l]` live tiap 5 detik, dan redraw tanpa `clear`. Jangan kembali ke loop `clear` + kumpulkan data tiap 1 detik; itu membuat layar berkedip dan membebani VPS kecil.
- Dashboard menu utama live: selama prompt menunggu (`menu_read_choice_live`), baris CPU, RAM, UPTIME (swap), dan TIME diperbarui tiap `DASHBOARD_LIVE_SECONDS` (default 2, `0` = mati). Datanya dibaca `dashboard_live_sample` dari /proc dengan builtin bash, tanpa proses baru; **jangan tambahkan perintah eksternal** (systemctl, sqlite3, vnstat, `$(...)`) ke siklus live. CPU% sudah dikurangi CPU menu sendiri.
  - Baris CAPACITY dan ANALYZER (status, online, rata-rata RAM/CPU) adalah hasil capacity analyzer 15 menit, **bukan** realtime. Menghitung online butuh socket, journal, dan log Xray yang berat, dan interval analyzer 5 menit memang sengaja dipaksa kembali ke 15. `dashboard_cap_read` membaca ulang file state dengan builtin bash tiap 30 detik, jadi hasil analyzer baru langsung tampil. Umur datanya ("7m lalu") diambil dari `CAPACITY_UPDATED_EPOCH`.
  - Hanya baris yang nilainya berubah yang digambar ulang, di posisi baris tetap (`D_ROW_*`), dalam satu kali tulis di antara ESC 7/ESC 8, tanpa newline. Posisi dihitung dari `UI_ROWS`, jadi fungsi yang mencetak baris di layar utama wajib menambah `UI_ROWS` (seperti `ui_row`, `ui_line`, `ui_banner`).
  - Live hanya jalan kalau seluruh layar muat di terminal tanpa tergulung, bukan tema `none` atau `TERM=dumb`. Live berhenti saat ukuran terminal berubah (keyboard HP muncul) dan setelah `DASHBOARD_LIVE_IDLE_MINUTES` (10) tanpa input.
  - Teks yang sedang diketik aman, karena terminal mode kanonik menahan baris sampai Enter, sehingga `read -t` yang habis waktunya tidak memakan input.
- Data monitor online diambil lewat collector bersama (`collect_ssh_online_rows`, `collect_xray_online_rows`, `collect_udphc_online_pairs`, `zivpn_online_sql`). Layar per layanan dan layar SEMUA AKUN ONLINE (menu monitor [7]) memakai collector yang sama, jadi perubahan aturan status cukup di satu tempat. Layar SEMUA AKUN mengambil tracker dan log Xray sekali untuk tiga protokol, dan live-nya tiap 10 detik. Test: `npm run test:online-monitor`.
- `trap ... RETURN` yang dipasang fungsi yang dipanggil **menimpa** trap RETURN pemanggilnya. Fungsi yang memanggil collector (yang punya trap sendiri) wajib memasang trap cleanup-nya **setelah** pemanggilan itu; kalau tidak, file temp-nya bocor tiap refresh.
- Test: `npm run test:menu-ui` menggambar dashboard dan menu di 5 lebar layar, 4 mode warna, dan 2 locale, lalu memastikan semua bingkai lurus. Test yang sama memeriksa warna pesan `echo` (termasuk kasus yang tidak boleh salah warna, seperti "Cooldown gagal : 15 menit" dan "Jika ... gagal") dan bahwa echo tanpa terminal tetap polos.

### Detail akun: menu = BotVPN

Detail akun SSH dan Xray (buat dan trial) di menu (`print_created_account`) harus sama persis dengan pesan bot penjualan BotVPN (`modules/accountMessages.js` di repo BotVPN). Bot hanya menambah tanda Markdown (`*`, `` ` ``) dan baris footer toko.

- Teks yang diharapkan ada di [scripts/fixtures/account-message-parity.json](scripts/fixtures/account-message-parity.json), dengan salinan identik di BotVPN `test/fixtures/sc1forcr-account-messages.json`. Kalau tampilan diubah, jalankan `node scripts/test-account-message-parity.js --update`, salin fixture ke BotVPN, dan samakan formatter bot. Test: `npm run test:account-parity` di sini dan `test/accountMessages.test.js` di BotVPN.
- Hanya tampilkan layanan yang dipasang SC. OpenVPN, SSH OHP, SlowDNS, dan web config port 81 tidak ada. API tetap mengirim kunci `ovpntcp`/`ovpnudp`/`sshohp`, karena bot lain membacanya tanpa nilai cadangan. BotVPN mengenali server SC dari respons (`isSc1forcrPayload`) lalu menyembunyikannya; server script lain tetap mendapat baris lama.
- `port.udpcustom` hanya dikirim saat backend UDP Custom aktif (`udpcustomPublicPort`). Backend dibaca dari `.env` API, karena menu menggantinya tanpa restart API.
- Parser `app.js` BotVPN membaca ulang pesan akun (`extractAccountLinksFromMessage`, `getCreateMessageField`) untuk menyimpan link dan membuat config otomatis. Urutan link TLS, Non-TLS, gRPC, Up TLS, Up Non-TLS harus tetap, dan label lain di pesan bot harus tetap tebal.

### Tampilan installer

Layar input domain di awal dan layar ringkasan di akhir install digambar mesin `iui_*` (blok bertanda `installer-ui` di installer). Mesin `ui_*` milik menu hidup di dalam script menu hasil generate dan belum ada saat installer jalan, jadi `iui_*` adalah versi ringkasnya dengan palet, bingkai, lebar (40–78 kolom), dan aturan mode warna yang sama.

- Blok itu harus berada setelah `certificate_dns_host_valid` dan sebelum `DOMAIN` disanitasi, karena input domain jalan di level atas script, sebelum `main()`.
- Input domain divalidasi formatnya (salah = diminta ulang, bukan installer mati) lalu A record-nya dibandingkan dengan IP publik VPS. Hasilnya hanya peringatan dengan Enter untuk lanjut, tidak pernah memblokir: domain di balik proxy Cloudflare memang mengarah ke IP lain. Kalau IP publik tidak terdeteksi, pengecekan dilewati supaya resolver VPS yang rusak tidak memunculkan peringatan palsu.
- Teks di dalam kotak lewat `iui_text`/`iui_kv`, yang melipat per kata. Jaga teks tetap pendek supaya di layar 40 kolom tidak terlipat panjang. URL API dan token dicetak di luar kotak supaya bisa disalin utuh.
- Setelah `exec > >(tee ...)` di `main()`, stdout adalah pipe ke log. Layar berwarna ditulis langsung ke `/dev/tty`, dan salinan polos dengan token disamarkan ditambahkan ke `install.log`. Jangan cetak token asli lewat stdout di jalur interaktif.
- `show_install_finished` dipanggil setelah status pending dibersihkan dan dengan `|| true`: masalah tampilan tidak boleh membuat install yang sudah selesai dianggap terputus. Menu baru dibuka setelah Enter, karena menu langsung membersihkan layar.
- Selama install penuh di terminal interaktif, progres ditampilkan sebagai animasi (`install_display_start` sampai `install_display_finish`): spinner, langkah yang sedang jalan, bar, waktu, dan baris log terakhir. Sejak animasi mulai, stdout/stderr installer **hanya** menuju `install.log`. Jalur update aman tidak memakainya. `INSTALL_ANIMATION=0`, tanpa terminal, `TERM=dumb`, atau `INSTALL_LOG_DISABLE=1` kembali ke baris progres biasa.
- Yang menggambar adalah satu proses latar (`iui_anim_loop`) yang membaca file status `persen|pesan`; installer sendiri tidak pernah menulis ke terminal, jadi terminal yang macet tidak menahan install. Proses itu hanya menggambar ulang baris yang berubah, membaca log kira-kira sedetik sekali, tidak pernah mengirim newline (layar tidak boleh tergulung), dan berhenti sendiri kalau installer mati. Jangan tambahkan efek yang menggambar ulang bar di setiap tick; itu melipatgandakan data yang dikirim lewat SSH.
- **Semua baris animasi digambar di posisi layar yang tetap** (`\033[baris;1H`), bukan "sekian baris di atas kursor", dan seluruh kerangka digambar ulang kira-kira 5 detik sekali sambil menghapus apa pun di bawah kotak. Ini pernah jadi bug nyata: terminal bisa ditulisi pihak lain kapan saja (journald dan rsyslog menyiarkan pesan level `emerg` ke semua terminal yang login), tulisan itu menggeser kursor, dan kotak tergambar ulang di tempat yang salah. Jangan kembali ke gerak kursor relatif.
- Karena keluaran rinci tersembunyi, dua hal wajib dijaga: trap `install_display_on_exit` menampilkan ujung log saat install berhenti sebelum selesai, dan layar akhir menyebut jumlah peringatan yang tercatat di log. Langkah install baru tidak boleh meminta input lewat terminal selama animasi jalan.
- Test: `npm run test:installer-ui` menggambar kedua layar di 6 lebar, 4 mode warna, dan 2 locale, menjalankan alur input domain dengan terminal tiruan, dan menjalankan animasi sungguhan (selesai normal, install gagal, installer mati mendadak).

## Bahasa

Komentar, log, dan teks menu memakai bahasa Indonesia. Ikuti gaya yang sudah ada.

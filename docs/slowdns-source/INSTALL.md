# Memasang binary SlowDNS pada SC lain

Panduan ini ditujukan kepada pemilik atau developer auto script tunneling lain. Paket berisi source **DNSTT `v1.20260501.0` + patch `sc-fast8`**, dengan dukungan TXT, NULL, NS, CNAME, MX, SRV, A, dan AAAA. Paket dapat dibangun tanpa installer, lisensi API, bot, menu, atau database SC 1FORCR.

Contoh pemasangan memakai Linux dengan **systemd dan iptables**, seperti lingkungan Debian/Ubuntu. Untuk SC yang mengelola firewall melalui nftables native atau firewalld, terapkan aturan ekuivalen melalui pengelola firewall SC tersebut. Jangan memasang helper iptables sekaligus menganggap aturan native yang menimpanya akan mengikuti secara otomatis.

## Yang tersedia dan yang perlu diadaptasi

| Fitur | Dukungan paket |
|---|---|
| Tunnel DNS → KCP → Noise → smux → TCP | Sudah ada dalam binary. |
| Record TXT/NULL dan enam tipe tambahan | Sudah ada; klien dan resolver tetap harus kompatibel. |
| Kunci privat/pubkey DNSTT | Dibuat dengan binary, disimpan oleh pemilik SC. |
| Login akun | Menggunakan server SSH milik SC tujuan. |
| Sumber metadata stream | Unix socket monitor sudah ada dalam binary. |
| Username online dan jumlah tunnel per akun | Perlu adapter autentikasi/socket SC tujuan. |
| Auto-lock, auto-unlock, notifikasi bot | Perlu adapter database dan pengelolaan akun SC tujuan. |
| Menu, API penjualan, backup, saklar ON/OFF | Perlu dihubungkan ke lifecycle SC tujuan. |

Binary tidak membaca database akun dan tidak menilai password SSH. Ia meneruskan stream ke backend TCP yang ditentukan. Login, kedaluwarsa akun, dan izin forwarding mengikuti backend SSH tersebut.

## 1. Tentukan backend dan domain

Siapkan nilai berikut sebelum menjalankan pemasangan:

| Pengaturan | Contoh | Arti |
|---|---|---|
| Domain tunnel | `tunnel.example.net` | Nama yang didelegasikan melalui record NS. |
| Host tujuan delegasi | `dns-origin.example.net` | Host dengan A record ke IP VPS. |
| Backend SSH | `127.0.0.1:109` | Port SSH murni milik SC tujuan. Bisa port OpenSSH atau Dropbear lain. |
| Port publik | UDP 53 | Port yang dihubungi resolver. |
| Port internal binary | UDP 5300 | Bisa diganti jika sudah dipakai. |
| Nama unit/user | `dnstt-portable` | Nama mandiri untuk contoh integrasi ini. |

Backend harus menerima protokol SSH yang dikirim klien dan mengizinkan jenis forwarding yang dibutuhkan aplikasi. Port HTTP/WebSocket atau TLS pada SC belum tentu menerima stream SSH murni. Contoh ini tidak mengubah konfigurasi sshd, password admin, atau layanan SSH yang sudah berjalan.

Periksa listener terlebih dahulu:

```bash
ss -ltnp
ss -lnup
```

Pastikan port internal yang dipilih belum dipakai. Pengalihan UDP 53 juga harus disepakati dengan pemilik firewall: jika IP yang sama melayani DNS publik lain, tentukan IP/alur layanan yang akan dipakai sebelum menambahkan REDIRECT. Listener resolver lokal pada alamat loopback tidak sama dengan layanan DNS publik pada IP VPS.

## 2. Build source

Ekstrak seluruh paket, lalu masuk ke folder yang memuat `go.mod`. Diperlukan Go 1.21 atau lebih baru; petunjuk toolchain tersedia pada [dokumentasi instalasi Go](https://go.dev/doc/install).

```bash
go version
go mod download
go test ./...

CGO_ENABLED=0 GOMAXPROCS=1 go build -p=1 -trimpath -ldflags="-s -w" \
  -o build/dnstt-server ./dnstt-server
```

Build tersebut menghasilkan binary untuk platform mesin build. Untuk cross-build Linux, gunakan `GOOS=linux GOARCH=amd64` atau `GOARCH=arm64`. Contoh PowerShell ada di [README](README.md). Binary amd64 dan arm64 berbeda; distribusikan hasil yang sesuai arsitektur VPS (`uname -m`).

Tidak perlu menjalankan installer SC asal untuk membangun paket ini. Dependency Go tetap diambil berdasarkan `go.mod`/`go.sum`, sehingga build memerlukan akses ke sumber dependency atau cache Go yang sudah tersedia.

## 3. Pasang binary dan user service

Perintah berikut dijalankan sebagai root dari folder source hasil ekstraksi:

```bash
getent group dnstt-portable >/dev/null || groupadd -r dnstt-portable
id -u dnstt-portable >/dev/null 2>&1 || \
  useradd -r -g dnstt-portable -M -d /nonexistent -s /usr/sbin/nologin dnstt-portable

install -d -m 0755 /usr/local/lib/dnstt-portable
install -m 0755 build/dnstt-server /usr/local/lib/dnstt-portable/dnstt-server.new
mv -f /usr/local/lib/dnstt-portable/dnstt-server.new \
  /usr/local/lib/dnstt-portable/dnstt-server

install -d -o root -g dnstt-portable -m 0750 /etc/dnstt-portable
if [ ! -e /etc/dnstt-portable/server.env ]; then
  install -o root -g dnstt-portable -m 0640 \
    integration/server.env.example /etc/dnstt-portable/server.env
fi
```

Edit `/etc/dnstt-portable/server.env` untuk mengisi domain tunnel dan backend SSH sebenarnya. File ini berisi penugasan `KEY=VALUE`; jangan menambahkan perintah shell. Contohnya:

```ini
TUNNEL_DOMAIN=tunnel.example.net
SSH_UPSTREAM=127.0.0.1:109
DNS_UDP_PORT=5300
DNS_MTU=1232
SLOWDNS_KCP_WINDOW=2048
SLOWDNS_KCP_INTERVAL=10
SLOWDNS_KCP_ACK_NODELAY=0
GOMEMLIMIT=96MiB
GOGC=300
DNS_ENABLE_IPV6=0
```

`SLOWDNS_KCP_INTERVAL` (10-50 ms) dan `SLOWDNS_KCP_ACK_NODELAY` (0/1) hanya untuk uji CPU. Nilai default 10 dan 0 sama dengan perilaku `sc-fast7`. Nilai kosong atau di luar batas kembali ke default, dan binary mencatat nilai yang dipakai pada log start: `KCP interval 10 ms ack-nodelay false window 2048`. Ubah satu nilai per percobaan dan bandingkan CPU per MiB sekaligus throughput; lihat [hasil uji V.1FSC.125](../slowdns-kcp-tuning-v125.md).

## 4. Buat kunci sekali

Pertahankan pasangan kunci yang sudah ada saat melakukan update. Blok berikut menolak menimpa pasangan yang tidak lengkap:

```bash
(
  set -euo pipefail
  if [[ -e /etc/dnstt-portable/server.key || -e /etc/dnstt-portable/server.pub ]]; then
    [[ -s /etc/dnstt-portable/server.key && -s /etc/dnstt-portable/server.pub ]] || {
      echo 'Pasangan kunci tidak lengkap; pulihkan pasangan yang benar sebelum melanjutkan.' >&2
      exit 1
    }
  else
    umask 077
    /usr/local/lib/dnstt-portable/dnstt-server -gen-key \
      -privkey-file /etc/dnstt-portable/server.key \
      -pubkey-file /etc/dnstt-portable/server.pub
  fi
  chown root:dnstt-portable /etc/dnstt-portable/server.key /etc/dnstt-portable/server.pub
  chmod 0640 /etc/dnstt-portable/server.key
  chmod 0644 /etc/dnstt-portable/server.pub
)
```

Pubkey yang dibagikan ke pengguna:

```bash
cat /etc/dnstt-portable/server.pub
```

Kunci privat tetap berada pada server. Membuat pasangan baru menyebabkan pengguna perlu mengganti pubkey pada aplikasinya.

Untuk memigrasikan layanan lama dengan pubkey tetap, pulihkan pasangan `server.key` dan `server.pub` milik layanan tersebut ke lokasi ini sebelum tahap pembuatan kunci. Paket source tidak menyertakan pasangan kunci server mana pun.

## 5. Pasang service systemd

```bash
install -m 0644 integration/dnstt-portable.service \
  /etc/systemd/system/dnstt-portable.service

systemd-analyze verify /etc/systemd/system/dnstt-portable.service
systemctl daemon-reload
```

Template membaca `/etc/dnstt-portable/server.env` dan menjalankan:

```text
dnstt-server -udp :PORT_INTERNAL -privkey-file FILE_KUNCI -mtu MTU DOMAIN_TUNNEL BACKEND_SSH
```

Unit tidak bergantung pada nama `dropbear.service` tertentu. Integrator boleh menambahkan urutan `After=` sesuai nama unit SSH SC tujuan. Akun service `dnstt-portable` harus diizinkan membuka koneksi TCP ke backend; periksa juga aturan OUTPUT milik SC yang membatasi akses loopback berdasarkan UID/grup.

Preset contoh memakai `MemoryMax=128M`, `GOMEMLIMIT=96MiB`, window KCP 2048, interval KCP 10 ms, ACK biasa, dan GOGC 300. `GOMEMLIMIT` merupakan sasaran lunak runtime Go; `MemoryMax` adalah batas cgroup. Untuk kapasitas lain, ubah keduanya secara konsisten beserta window sesuai hasil pengukuran. Unit ini tidak menambahkan CPUQuota pada jalur trafik dan tidak memaksa nilai GOMAXPROCS.

## 6. Integrasikan firewall UDP

Paket menyediakan [contoh helper iptables](integration/iptables.sh). Helper memakai komentar `dnstt-portable` pada rule miliknya dan tidak melakukan flush seluruh firewall. Perintah `apply` memastikan rule sendiri berada di depan pada chain terkait:

```text
NAT PREROUTING: UDP 53 tujuan lokal → REDIRECT ke DNS_UDP_PORT
INPUT:         izinkan UDP tujuan DNS_UDP_PORT
OUTPUT:        izinkan balasan UDP dari DNS_UDP_PORT
```

Pemasangan awal pada SC berbasis iptables:

```bash
install -m 0700 integration/iptables.sh /usr/local/sbin/dnstt-portable-iptables
/usr/local/sbin/dnstt-portable-iptables apply
```

Posisi NAT harus mendahului DNAT rentang UDP milik backend lain. SC yang memasang DNAT `1:65535` dapat mengambil UDP 53 jika rule SlowDNS berada di bawahnya. ACCEPT OUTPUT diperlukan bila SC membatasi balasan proses non-root.

Helper berjalan sebagai root secara terpisah; jangan menjalankannya sebagai `ExecStartPre` biasa pada unit yang memakai `User=dnstt-portable`. Hook pemasangannya perlu masuk ke jalur **install, boot, dan penulisan ulang firewall** SC tujuan. Gunakan mekanisme persist/firewall manager yang sudah dimiliki SC. Menjalankan helper sekali tidak membuat rule otomatis bertahan setelah reboot atau flush oleh SC lain.

Urutan hook yang sesuai adalah: terapkan aturan SlowDNS, lalu terapkan kembali gerbang ON/OFF dan kebijakan akses SC. Helper menaruh ACCEPT miliknya di depan, sehingga integrator wajib menyesuaikannya jika bertentangan dengan gerbang layanan SC. Saat SSH atau SlowDNS dinonaktifkan dari menu, SC juga perlu menutup jalur SlowDNS sesuai kebijakannya; kode Go tidak membaca saklar menu tersebut.

IPv4 dipakai secara bawaan. Aktifkan `DNS_ENABLE_IPV6=1` hanya setelah NAT IPv6 dan aturan IPv6 VPS siap. Jika SC memakai mekanisme firewall lain, ganti helper dengan aturan ekuivalen melalui mekanisme itu.

## 7. Buat record DNS dan nyalakan service

Contoh record pada penyedia DNS domain `example.net`:

| Tipe | Nama | Tujuan |
|---|---|---|
| A | `dns-origin` | IPv4 publik VPS, mode DNS only. |
| NS | `tunnel` | `dns-origin.example.net`. |

Domain pada `TUNNEL_DOMAIN` menjadi `tunnel.example.net`. Record NS adalah delegasi zona tunnel, bukan daftar resolver publik seperti `1.1.1.1`. Tambahkan AAAA hanya jika jalur IPv6 yang sesuai sudah aktif.

```bash
systemctl enable --now dnstt-portable.service
systemctl status dnstt-portable.service --no-pager
journalctl -u dnstt-portable.service -n 50 --no-pager
```

Di aplikasi klien, isi resolver yang dapat dijangkau, domain tunnel, pubkey server, dan akun SSH dari SC tujuan. TXT memakai format DNSTT standar. NULL memerlukan dukungan NULL pada klien. NS/CNAME/MX/SRV/A/AAAA memerlukan klien yang mendukung codec ekstensi dalam paket ini; menambah server saja tidak menambah kemampuan aplikasi klien.

Mode DoH/DoT/TCP resolver berada pada ruas klien → resolver. Service contoh di VPS hanya membuka listener DNS UDP. Pilihan AUTO berada pada klien, bukan tipe record baru yang dipilih server.

## 8. Verifikasi end-to-end dan diagnosis

Periksa berurutan: binary listen, rule NAT terpasang, delegasi mengarah ke VPS, handshake DNSTT selesai, login SSH diterima, lalu trafik aplikasi benar-benar berjalan. Jawaban `dig` saja tidak membuktikan semua tahap tersebut.

```bash
ss -lnup
ss -tnp state established
iptables -t nat -L PREROUTING -n -v --line-numbers
systemctl show dnstt-portable.service -p MainPID -p MemoryCurrent -p MemoryMax
journalctl -u dnstt-portable.service -n 80 --no-pager
```

| Gejala | Bagian yang perlu diperiksa |
|---|---|
| Binary tidak listen | Arsitektur binary, file konfigurasi, permission kunci, domain, dan konflik port. |
| Tidak ada query sampai VPS | Delegasi NS/A, resolver klien, firewall provider, serta rule DNAT UDP SC. |
| `WriteTo error` / `operation not permitted` | Aturan OUTPUT untuk balasan UDP binary non-root. |
| Tidak dapat membuka upstream | Backend SSH/port sebenarnya serta izin OUTPUT TCP service ke backend. |
| Handshake luar berhasil tetapi SSH gagal | Kredensial, status akun, format backend, atau kebijakan autentikasi/forwarding SSH. |
| TXT berhasil, tipe tambahan gagal | Codec klien atau penyaringan tipe/kapasitas EDNS pada resolver. |

## 9. Adapter akun online dan auto-lock

IPC dapat dibaca sebagai root dengan:

```bash
/usr/local/lib/dnstt-portable/dnstt-server \
  -sc-online /run/dnstt-portable/sessions.sock
```

Formatnya tetap mempertahankan nama protokol dari patch asal:

```text
SC_SLOWDNS_SESSIONS_V1|PID_PROSES|WAKTU_MULAI_MONITOR_NANO
PORT_SUMBER_BACKEND|CLIENT_ID_HEX|BYTE_KLIEN_KE_BACKEND|WAKTU_MULAI_STREAM_NANO
END
```

Tidak ada username pada baris itu. Adapter SC tujuan perlu mencocokkan socket TCP aktif milik proses DNSTT dengan socket backend SSH, lalu menghubungkan **port dan PID backend yang sama** ke username yang benar-benar terautentikasi. Bukti autentikasi bisa berasal dari tracker atau log backend SSH milik SC tujuan. Gunakan snapshot segar; riwayat login atau IP resolver tidak cukup untuk menamai akun yang sedang online.

Untuk jumlah tunnel, deduplikasi ClientID per akun. Satu ClientID dapat membawa beberapa stream, dan jumlahnya tidak membuktikan jumlah HP secara pasti. Jika backend tetap berjalan sebagai root, `pkill -u USER` saja tidak memutus sesi tersebut. Pemutusan memerlukan PID sesi yang sudah diverifikasi; listener bersama dan sesi administrator harus tetap dikecualikan.

Auto-lock perlu membaca limit/status dari database atau API SC tujuan dan mempunyai penyimpanan expiry serta jalur unlock sendiri. Untuk meniru aturan asal, gunakan umur stream minimal 90 detik, pertambahan byte klien dibanding baseline, fingerprint tunnel yang stabil pada dua pemeriksaan, lalu lock khusus SlowDNS 900 detik. Durasi dan kebijakan lain dapat dipilih pemilik SC. Kegagalan metadata tidak boleh diperlakukan sebagai bukti pelanggaran.

Paket ini menyediakan transport dan metadata, **belum menyediakan adapter username, auto-lock, auto-unlock, atau notifikasi untuk database SC lain**. Pubkey adalah identitas server bersama; respons DNS atau handshake luar yang berhasil belum berarti akun SSH berhasil login. Terapkan penolakan login serta pemutusan sesi melalui backend/panel yang dipakai SC tujuan.

## 10. Update dan pemulihan

Build dan uji kandidat baru sebelum mengganti file yang dipakai service. Simpan binary lama beserta konfigurasi, kemudian ganti binary secara atomik dan restart **hanya unit SlowDNS** saat siap mengaktifkan kandidat. Restart menutup tunnel aktif; Dropbear/OpenSSH bersama tidak perlu di-restart hanya untuk mengganti binary DNSTT. Kunci privat/pubkey yang sama dipertahankan.

Untuk mengubah port internal atau status IPv6, lepaskan rule lama sebelum mengedit nilai yang dipakai helper:

```bash
/usr/local/sbin/dnstt-portable-iptables remove
# Edit /etc/dnstt-portable/server.env dan sesuaikan kebijakan firewall SC.
/usr/local/sbin/dnstt-portable-iptables apply
systemctl restart dnstt-portable.service
```

Untuk menghentikan pemasangan contoh:

```bash
systemctl disable --now dnstt-portable.service
/usr/local/sbin/dnstt-portable-iptables remove
```

Jika NAT/policy firewall sudah diadaptasi ke pengelola SC sendiri, pemulihannya juga memakai mekanisme SC tersebut. Simpan pasangan kunci dan backup konfigurasi untuk pemasangan ulang.

## Status pengujian paket

Source hasil ekspor lolos `go test ./...` pada host pengujian dan berhasil di-cross-build untuk Linux amd64 serta arm64. Template firewall diperiksa syntax-nya. Pemasangan template systemd/firewall pada SC tujuan tetap perlu diuji di lingkungan SC itu; paket tidak mengklaim semua pengelola firewall atau database akun mempunyai integrasi yang sama.

Source utama ada pada [`dnstt-server/main.go`](dnstt-server/main.go). Penjelasan file lainnya tersedia pada [README](README.md); provenance/hash source pada [`source-manifest.json`](source-manifest.json), dan lisensi upstream pada [`COPYING`](COPYING).

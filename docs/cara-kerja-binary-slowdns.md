# Binary SlowDNS untuk dipasang pada SC lain

Dokumentasi ini untuk pemilik atau developer auto script tunneling yang ingin menambahkan SlowDNS ke SC miliknya sendiri. Paket berisi source DNSTT `v1.20260501.0` + patch `sc-fast8`, template konfigurasi, unit systemd, contoh firewall, serta pengujian.

**Panduan pemasangan lengkap dan perintahnya ada di [slowdns-source/INSTALL.md](slowdns-source/INSTALL.md).** Seluruh folder `slowdns-source` dapat dibagikan sebagai satu paket. Penerima tidak perlu menyalin installer utama, bot, lisensi API, atau database SC 1FORCR.

## Source dan berkas integrasi

| Berkas | Fungsi |
|---|---|
| [README source](slowdns-source/README.md) | Peta kode dan cara build. |
| [Panduan pemasangan](slowdns-source/INSTALL.md) | Langkah build, service, kunci, firewall, DNS, pengujian, dan pemulihan pada SC lain. |
| [dnstt-server/main.go](slowdns-source/dnstt-server/main.go) | Kode utama binary: DNS, KCP, Noise, smux, dan forwarding TCP. |
| [sc_sessions.go](slowdns-source/dnstt-server/sc_sessions.go) | Metadata ClientID, port backend, counter upload, dan Unix socket monitor. |
| [sc_wire.go](slowdns-source/dnstt-server/sc_wire.go) | Encoder cepat respons DNS. |
| [dns/sc_records.go](slowdns-source/dns/sc_records.go) | Kapasitas, encoding, dan decoding record multi tipe. |
| [server.env.example](slowdns-source/integration/server.env.example) | Konfigurasi domain, backend SSH, port, dan resource yang dapat diganti. |
| [dnstt-portable.service](slowdns-source/integration/dnstt-portable.service) | Unit systemd generik yang tidak mengharuskan nama service SSH tertentu. |
| [iptables.sh](slowdns-source/integration/iptables.sh) | Contoh rule milik SlowDNS untuk SC berbasis iptables. |

## Alur kerja

```mermaid
flowchart LR
    C["Klien SlowDNS"] <-->|"Query/respons DNS"| R["Resolver DNS"]
    R <-->|"UDP 53"| F["Firewall SC tujuan: redirect ke port internal"]
    F <--> D["dnstt-server: KCP + Noise + smux"]
    D <-->|"TCP ke backend yang dikonfigurasi"| S["Dropbear/OpenSSH milik SC tujuan"]
    S <--> I["Forwarding trafik"]
```

Binary mendekode payload Base32 dalam query, mengelompokkan paket memakai ClientID, membentuk koneksi andal dengan KCP, mengenkripsinya dengan Noise, dan membuka stream smux. Setiap stream diteruskan ke backend TCP. Backend SSH SC tujuan yang memverifikasi akun serta mengerjakan forwarding.

Data download kembali sebagai payload respons DNS. Format TXT dan NULL mempertahankan kompatibilitas yang sudah ada; NS, CNAME, MX, SRV, A, dan AAAA memerlukan klien dengan codec ekstensi yang sesuai. Mode AUTO diputuskan klien, sedangkan server merespons tipe query yang diterimanya.

Pubkey DNSTT adalah identitas server. Username/password SSH merupakan kredensial akun pada SC tujuan. Handshake luar DNSTT yang berhasil belum berarti akun SSH berhasil login.

## Pengaturan yang disesuaikan oleh SC tujuan

| Bagian | Contoh paket |
|---|---|
| Domain tunnel | `tunnel.example.net` |
| Delegasi | A `dns-origin` ke IP VPS; NS `tunnel` ke `dns-origin.example.net`. |
| Backend SSH | `127.0.0.1:109`; ganti ke port SSH murni SC tujuan. |
| Port DNS publik/internal | UDP 53 diteruskan ke UDP 5300. |
| Binary | `/usr/local/lib/dnstt-portable/dnstt-server` |
| Kunci dan environment | `/etc/dnstt-portable/` |
| Service | `dnstt-portable.service` |
| Monitor IPC | `/run/dnstt-portable/sessions.sock` |

Contoh memakai Linux, systemd, dan iptables. Pengelola firewall lain perlu aturan ekuivalen melalui mekanisme yang dipakai SC tujuan. Hook firewall harus masuk jalur install, boot, dan penulisan ulang firewall SC. Saklar ON/OFF serta backup juga mengikuti lifecycle SC tujuan.

Preset contoh service adalah `MemoryMax=128M`, `GOMEMLIMIT=96MiB`, window KCP 2048, interval KCP 10 ms, ACK biasa, dan GOGC 300. Nilainya dapat disesuaikan dengan resource dan beban nyata. Tidak ada speed limit Mbps di preset ini.

## Akun online dan auto-lock

Transport serta metadata stream sudah tersedia dalam binary. Integrasi username online dan auto-lock perlu adapter sesuai tracker autentikasi, database, dan pengelolaan akun pada SC tujuan.

Snapshot monitor berisi PID proses, port sumber TCP backend, ClientID, byte klien ke backend, dan waktu mulai stream. Snapshot tidak berisi username. Integrator perlu mencocokkan port dan PID backend pada socket aktif dengan bukti autentikasi SSH, lalu menghitung ClientID unik per akun.

Untuk memutus akun, gunakan PID sesi yang sudah diverifikasi. Dropbear forwarding-only dapat tetap berjalan sebagai root sehingga pemutusan berdasarkan UID akun saja tidak cukup. Auto-lock juga memerlukan expiry, auto-unlock, dan notifikasi milik SC tujuan; menyalin binary tidak otomatis membawa fitur-fitur panel tersebut.

Kontrak metadata dan contoh kebijakan lock dijelaskan pada bagian adapter di [INSTALL.md](slowdns-source/INSTALL.md).

## Provenance dan validasi

Source berasal dari patch SC V.1FSC.125, tetapi nomor versi SC itu bukan persyaratan SC penerima. Versi core adalah DNSTT `v1.20260501.0` + `sc-fast8`. Hash source dicatat dalam [source-manifest.json](slowdns-source/source-manifest.json), dan lisensi upstream disertakan dalam [COPYING](slowdns-source/COPYING).

Source hasil ekspor lolos `go test ./...` dan berhasil dibangun untuk Linux amd64/arm64. Template integrasi tetap perlu diuji terhadap firewall, backend SSH, dan lifecycle SC penerima. Paket ini berisi source dan template; tidak membawa kunci privat atau kredensial VPS asal.

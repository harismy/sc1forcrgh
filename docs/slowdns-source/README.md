# Source Go binary SlowDNS

Folder ini berisi **kode server DNSTT setelah seluruh patch SC diterapkan**, termasuk dukungan TXT/NULL/NS/CNAME/MX/SRV/A/AAAA, monitor stream, serta optimisasi encoder dan receiver. Source diekstrak dari installer SC V.1FSC.125, DNSTT `v1.20260501.0`, patch `sc-fast8`.

Paket ini dapat dibangun dan dipasang pada **SC lain**. Panduan lengkapnya ada di **[INSTALL.md](INSTALL.md)**, dengan contoh environment, unit systemd, firewall, delegasi DNS, dan kontrak adapter akun. Binary tidak memerlukan menu, lisensi API, bot, atau database SC asal.

Pada repo asal, source dihasilkan oleh `SLOWDNS_PATCH_PY` dalam `scripts/setup-autoscript-compat.sh`. Integrator SC lain dapat membangun langsung dari folder ini dan mengelola lifecycle-nya sendiri. Jika perubahan juga akan dipakai installer SC asal, sinkronkan perubahan itu ke patch installer asal.

## Mulai membaca kode

| File | Isi |
|---|---|
| [`dnstt-server/main.go`](dnstt-server/main.go) | Entry point, konfigurasi CLI, penerimaan DNS, sesi KCP, handshake Noise, smux, forwarding TCP, serta pengiriman respons DNS. |
| [`dnstt-server/sc_sessions.go`](dnstt-server/sc_sessions.go) | Pemetaan ClientID ke stream/port TCP, counter upload atomik, dan Unix socket monitor. |
| [`dnstt-server/sc_wire.go`](dnstt-server/sc_wire.go) | Encoder cepat respons DNS TXT/NULL dan fallback serializer. |
| [`dnstt-server/sc_kcp.go`](dnstt-server/sc_kcp.go) | Interval KCP dan ACK langsung dari `SLOWDNS_KCP_INTERVAL`/`SLOWDNS_KCP_ACK_NODELAY`, dengan validasi dan default 10 ms/ACK biasa. |
| [`dns/sc_records.go`](dns/sc_records.go) | Daftar tipe yang didukung, perhitungan kapasitas, encoding dan decoding record multi tipe. |
| [`dns/dns.go`](dns/dns.go) | Parser/serializer DNS, nama DNS, question, dan resource record. |
| [`noise/noise.go`](noise/noise.go) | Handshake dan pembungkus saluran Noise. |
| [`turbotunnel/queuepacketconn.go`](turbotunnel/queuepacketconn.go) | Antrean paket yang menghubungkan DNS dan KCP. |
| [`turbotunnel/remotemap.go`](turbotunnel/remotemap.go) | Antrean keluaran dan pengelolaan alamat virtual klien. |
| [`turbotunnel/clientid.go`](turbotunnel/clientid.go) | ClientID 8 byte dan representasi alamat virtualnya. |
| [`turbotunnel/consts.go`](turbotunnel/consts.go) | Konstanta kedalaman antrean transport. |
| [`go.mod`](go.mod), [`go.sum`](go.sum) | Dependency Go dan checksum-nya. Dependency eksternal diambil oleh Go saat diperlukan. |

Urutan fungsi yang menjelaskan satu koneksi:

```text
main()
  └─ run()
      ├─ recvLoop()
      │   ├─ dns.MessageFromWireFormat()
      │   ├─ responseFor()
      │   └─ QueueIncoming() → KCP
      ├─ acceptSessions()
      │   └─ acceptStreams()
      │       ├─ noise.NewServer()
      │       ├─ smux.Server()
      │       └─ handleStream() → TCP backend Dropbear
      └─ sendLoop()
          ├─ dns.TunnelAnswers()
          ├─ scResponseWireFormat()
          └─ UDP WriteTo() → resolver
```

Beberapa komentar bawaan upstream masih menggambarkan format TXT awal. Untuk tipe yang benar-benar diterima setelah patch, lihat `dns.TunnelType()` dan `dns.TunnelAnswers()`. Kode Go dipertahankan sesuai hasil patch installer, tanpa penulisan ulang manual pada snapshot ini.

## Build dan pengujian

Jalankan dari folder ini dengan Go 1.21 atau lebih baru:

```bash
go test ./...
```

Untuk membangun pada VPS Linux:

```bash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
  -o build/dnstt-server ./dnstt-server
```

Contoh cross-build Linux amd64 dari PowerShell Windows:

```powershell
$env:GOOS = 'linux'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
go build -trimpath '-ldflags=-s -w' -o build/dnstt-server-linux-amd64 ./dnstt-server
```

Ganti `amd64` menjadi `arm64` untuk target Linux ARM64. Build menghasilkan file binary di folder `build`; perintah ini tidak memasang atau me-restart service VPS.

Tujuh file pengujian SC dari `scripts/go/slowdns_*_test.go` disertakan pada paket server/DNS yang sesuai, bersama pengujian upstream yang tersedia. Pengujian lokal tidak memakai kredensial atau kunci privat VPS.

[`source-manifest.json`](source-manifest.json) mencatat versi, checksum arsip upstream, checksum patch installer, dan hash file source/test hasil ekspor. Lisensi upstream disertakan dalam [`COPYING`](COPYING). Folder ini hanya mengekspor server serta paket lokal pendukungnya; binary klien APK berada pada proyek aplikasi yang terpisah.

Contoh pemasangan mandiri dan batas integrasi akun tersedia pada **[INSTALL.md](INSTALL.md)**. Paket sengaja mempertahankan nama `SLOWDNS_*` dan header monitor `SC_SLOWDNS_SESSIONS_V1` agar format metadata tetap kompatibel; nama tersebut tidak mewajibkan penggunaan SC 1FORCR.

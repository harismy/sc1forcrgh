# Payload injector HTTPUpgrade

Mulai `V.1FSC.140`, autoscript memasang shim Go khusus HTTPUpgrade untuk membersihkan satu marker
`HTTP/ 69\r\n\r\n` di awal stream setelah handshake HTTP. Marker boleh terpecah
antar paket. Koneksi HTTPUpgrade biasa tanpa marker tetap diteruskan apa adanya.

| Path | Protokol | Alur lokal |
| --- | --- | --- |
| `/upvmess` | VMess | Nginx → `127.0.0.1:10007` → Xray `10004` |
| `/upvless` | VLESS | Nginx → `127.0.0.1:10007` → Xray `10005` |
| `/uptrojan` | Trojan | Nginx → `127.0.0.1:10007` → Xray `10006` |

TLS tetap melalui HAProxy port 443; non-TLS melalui Nginx port 80. Port tambahan
mengikuti pengaturan autoscript. Link akun, autentikasi, kuota, dan gerbang
ON/OFF protokol tetap memakai inbound Xray yang sama. WS, gRPC, dan XHTTP
memakai jalur sebelumnya.

Contoh susunan payload aplikasi injector untuk VMess:

```text
GET /upvmess HTTP/1.1[crlf]
Host: DOMAIN_VPS[crlf]
Connection: Upgrade[crlf]
Upgrade: websocket[crlf][crlf]
HTTP/ 69[crlf][crlf]
```

`[crlf]` berarti byte CRLF. Setelah itu aplikasi mengirim stream protokol
HTTPUpgrade asli, bukan frame WebSocket. Untuk VLESS/Trojan, sesuaikan path
dan protokol aplikasi. Marker hanya dibuang sekali pada awal stream, sehingga
data yang sama di tengah stream tetap utuh. Header WebSocket handshake dan
header IP asli tepercaya dari Nginx diteruskan ke Xray.
Handshake disesuaikan dengan implementasi [HTTPUpgrade Xray-core](https://github.com/XTLS/Xray-core/blob/main/transport/internet/httpupgrade/hub.go).

Perubahan aktif saat instalasi atau update aman autoscript dijalankan di VPS.
Shim dibangun dengan Go yang sudah dipakai autoscript, tanpa modul tambahan.
Service baru siap sebelum konfigurasi Nginx dialihkan; build yang gagal
membiarkan konfigurasi Nginx sebelumnya. Update dengan source shim yang sama
tidak me-restart shim. Perubahan source shim memerlukan restart service shim
dan sesi HTTPUpgrade yang melewatinya akan reconnect.

Pemeriksaan di VPS:

```bash
systemctl status sc-1forcr-xray-payload-shim --no-pager
journalctl -u sc-1forcr-xray-payload-shim -n 30 --no-pager
ss -lntp | grep ':10007'
nginx -t
```

Port 10007 hanya listen pada loopback, maksimal 256 koneksi bersamaan. Watchdog
memeriksa shim; uninstall menghentikannya. Rollback update ke snapshot lama
yang belum memiliki shim turut menonaktifkan service tersebut.

Uji lokal: `npm run test:xray-payload-shim`. Set `GO_BIN` ke executable Go untuk
menjalankan simulasi koneksi dan build Linux amd64/arm64, selain uji installer.

# SlowDNS multi tipe — V.1FSC.123

Patch `sc-fast7` menambah NS, CNAME, MX, SRV, A, dan AAAA untuk klien 1FTunnel 0.7.0/build 126. TXT dan NULL tetap memakai format lama. Kode ini belum dipasang otomatis ke VPS.

Tidak ada service, port, daemon, timer, aturan firewall, atau perubahan speed limit baru. Alur tetap UDP 53 → REDIRECT 5300 → DNSTT → Dropbear 127.0.0.1:109. Kunci dan konfigurasi resolver server tetap menggunakan pengaturan yang sudah ada. Safe update/full install membangun ulang binary karena patch ID berubah; restart saat update tetap mengikuti jalur pemulihan SlowDNS yang sudah ada.

## Format respons

TXT memakai character-string DNSTT; NULL memakai payload biner langsung. NS/CNAME menaruh payload Base32 dalam nama dengan suffix `dnstt.invalid`; MX menambahkan preference dan SRV menambahkan priority/weight/port sebelum nama. Nama maksimal 255 byte dan label maksimal 63 byte. Respons nama berisi satu RR agar pengurutan RRset tidak mengubah payload.

A/AAAA memecah buffer `uint16 panjang payload + payload` menjadi potongan 3/15 byte. Byte pertama setiap RDATA menjadi indeks potongan. Klien menyusun ulang indeks, memeriksa potongan hilang/duplikat bertentangan, lalu membuang padding berdasarkan panjang. Wire tetap berupa RR A/AAAA yang valid, tetapi beberapa resolver dapat menyaring alamat hasilnya.

MTU KCP dihitung per ClientID berdasarkan tipe respons. Tipe berbasis nama dan AAAA memakai kapasitas konservatif EDNS 512; A memakai EDNS 1232 dan menolak query dengan kapasitas kurang dari 52 byte. TXT/NULL tetap memakai perhitungan MTU dan encoder cepat yang sudah ada. Tidak ada perubahan MTU global yang memperlambat klien lama. Tipe sebuah ClientID dicatat sekali dalam map yang dibatasi 8192 entri dan dihapus bersama metadata sesi.

Klien otomatis mencoba TXT lalu NULL sebelum handshake. Pemeriksaan awal memakai ClientID yang kemudian digunakan sesi sehingga tidak meninggalkan entri probe tambahan pada koneksi berhasil. Tipe tidak diganti di tengah sesi KCP.

## Pengujian

`scripts/go/slowdns_records_test.go` adalah paket `dns`, salin ke folder `dns` pada source yang telah dipatch. Test sesi/wire/receive tetap di `dnstt-server`; test nama tetap di `dns`. Jalankan `go test ./...`, build Linux amd64/arm64, `npm run test:slowdns`, dan `npm run test:slowdns-native` dengan binary pasangan yang dipin. Fixture proxy NULL mengodekan respons kosong menjadi character-string TXT panjang nol yang valid.

Uji lokal pasangan Android core/server mencakup AUTO, TXT, NULL, NS, CNAME, MX, SRV, A, AAAA dengan echo biner melalui DNS/KCP/Noise/smux. Test codec juga mencakup pengurutan RRset, fragmen hilang, respons terpotong, dan compression pointer RDATA dari resolver rekursif. Tidak menjamin semua resolver publik/operator melewatkan semua tipe. Klien DNSTT standar hanya menggunakan TXT; tipe tambahan membutuhkan klien yang mendukung codec ini.

Codec `dns/sc_records.go` dihasilkan langsung dari heredoc installer. Saat mengubah codec Android `native/slowdns/records.go` atau fungsi `patch_server` pada `patch_records.py`, sinkronkan salinan embedded installer dan jalankan test pasangan lagi. Installer tetap mandiri, tidak mengunduh file dari repo APK.

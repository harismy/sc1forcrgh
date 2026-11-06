# Efisiensi penerimaan query SlowDNS V.1FSC.122

V.121 mengurangi biaya encoding respons. Jalur masuk masih mengalokasikan
buffer baca 4096 byte pada setiap iterasi dan membentuk nama/cache sementara
di `dns.NewName` untuk memeriksa batas panjang nama. Kerja ini bertambah sesuai
jumlah query, termasuk ketika hanya satu akun menjalankan speed test.

## Perubahan sc-fast6

- Buffer baca 4096 byte dialokasikan sekali untuk umur `recvLoop`.
  `MessageFromWireFormat` tetap menyalin label/RDATA, dan `nextPacket` tetap
  menyalin paket KCP. Record yang menunggu kirim tidak meminjam buffer baca.
- `NewName` tetap memvalidasi seluruh label terlebih dahulu. Panjang wire
  dihitung dari byte root dan jumlah byte label/prefiks, dengan akumulator
  terbatas. Prioritas error label, batas 255 byte, dan alias label tetap sama.
- MTU, KCP/window/queue/interval, GOMAXPROCS, GOGC, batas RAM, buffer socket UDP,
  pubkey, pemetaan akun, dan aturan auto-lock tetap sama. Tidak ada daemon baru.

## Benchmark lokal

6 November 2026, Windows amd64, Intel Core i5-1035G7, Go 1.27.3,
GOMAXPROCS=2, GOGC=300. Kedua versi diuji bergantian pada host yang sama,
tiga pengulangan satu detik. Fixture poll memakai ClientID + padding 12 byte,
QTYPE NULL, domain tiga label, dan EDNS 1232. Benchmark memasukkan pembacaan
dari PacketConn tiruan, parse DNS, responseFor, dan pencatatan EDNS; tidak
memasukkan syscall UDP sebenarnya, SSH, enkripsi, atau seluruh pemrosesan KCP.

| Metrik per query | V.121 / sc-fast5 | V.122 / sc-fast6 |
|---|---:|---:|
| Median waktu | 6160 ns | 2714 ns |
| Heap dialokasikan | 6105 B | 840 B |
| Jumlah alokasi | 79 | 44 |

Waktu pada simulasi sekitar 2,3 kali lebih cepat, dengan byte alokasi turun
86,2%. Ini **bukan** klaim CPU total VPS turun 86% atau throughput jaringan
naik 2,3 kali. Total CPU dipengaruhi laju query, kernel, KCP, SSH, dan layanan
lain. Perlu audit setelah aktivasi pada beban sebanding.

## Pengujian

- `slowdns_name_test.go` di paket `dns`: dibandingkan dengan validator upstream,
  batas 255/256 byte, label biner, prioritas error, alias, 12.000 kasus acak
  deterministik, dan validasi nama tanpa alokasi.
- `slowdns_recv_test.go` di paket `dnstt-server`: TXT/NULL, query kedua lebih
  pendek menimpa buffer pertama, nama/ClientID/EDNS record tetap utuh, dan
  payload KCP yang sudah mengantre tetap identik. Anggaran poll <=2048 B/query
  menjaga buffer 4096 byte tidak kembali dialokasikan per paket.
- `go test ./...` lulus pada source yang dipatch dari ZIP ber-checksum tetap.
- Integrasi memakai server sc-fast6 dan klien V.121: TXT dan NULL melalui
  DNS/Noise/KCP/smux sungguhan, bulk echo dua arah, dua klien/tiga stream,
  penghitung upload, dan cleanup disconnect lulus.
- Build server Linux amd64 dan arm64 berhasil. Syntax installer dan helper
  hasil generate diperiksa terpisah.
- `npm test` lulus sampai kegagalan lama `test:update-compat`
  (`timer_substate_ok` tidak ikut snippet). `test:cli-output` terpisah tetap
  gagal pada versi hardcode V.1FSC.43. Keduanya tidak diubah oleh patch ini.

Aktivasi memerlukan update dan satu restart SlowDNS melalui jalur yang sudah
ada. Build gagal tetap memakai binary lama. Ukuran socket buffer tidak
diperbesar pada patch ini; riwayat drop UDP perlu dinilai lagi saat trafik
tinggi setelah biaya penerimaan berkurang.

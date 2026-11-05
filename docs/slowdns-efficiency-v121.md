# Efisiensi SlowDNS V.1FSC.121

Perubahan ini mempertahankan format paket dan tuning jaringan yang dipakai
sebelumnya. Tidak mengubah MTU, KCP window/nodelay/queue, GOMAXPROCS, GOGC,
MemoryMax, GOMEMLIMIT, kunci server, atau identitas tunnel auto-lock.

## Encoder sc-fast5

Respons normal dari `responseFor` memiliki satu question dan satu answer TXT/NULL
dengan nama identik, tanpa authority, serta paling banyak satu OPT bernama root.
Ukuran overhead dapat dihitung dari panjang label, header, pointer nama, dan OPT.
Encoder langsung menulis bentuk ini dalam satu buffer berukuran tepat. Bentuk
lain dan error overflow tetap memakai serializer upstream. Tidak ada pool buffer
atau cache yang menahan RAM setelah trafik turun.

Benchmark lokal 6 November 2026: Windows amd64, Intel Core i5-1035G7,
Go 1.27.3, GOMAXPROCS default 8. Satu operasi menghitung kapasitas payload respons
1232 byte lalu mengenkode respons dengan payload 1024 byte, nama panjang, dan OPT.
Median tiga pengulangan `BenchmarkSCResponse`, dibandingkan jalur sc-fast4 dari
V.120 pada host dan input yang sama:

| Format | Sebelum | Sesudah | Alokasi sebelum → sesudah | Byte alokasi sebelum → sesudah |
|---|---:|---:|---:|---:|
| TXT | 15.757 ns/op | 869,5 ns/op | 145 → 1 | 7.824 → 1.280 B/op |
| NULL | 13.569 ns/op | 894,7 ns/op | 145 → 1 | 7.824 → 1.280 B/op |

Ini benchmark ukuran/encoding, **bukan penurunan CPU total VPS**. Biaya kernel,
scheduler, KCP, kriptografi, SSH, dan trafik resolver tetap ada. Penghematan
produksi perlu dibandingkan pada query/paket per detik yang setara, sambil
mengukur throughput payload, latensi, dan packet loss.

## Firewall dan monitor

`sc-1forcr-udp-firewall cleanup` hanya merapikan run pertama ACCEPT UDP polos
yang identik dan bersebelahan pada port listen backend SC. Salinan dengan rule
lain di antaranya dibiarkan agar ACCEPT tidak bergeser melewati gate atau DROP.
Tidak mengubah NAT, tidak flush/reorder chain, dan tidak menambah ACCEPT baru.
Cleanup dipanggil saat install/update, setelah backend start, dan oleh watchdog;
tidak ada daemon baru. Maksimal 32 penghapusan per siklus, lock nonblocking,
persist hanya bila ada perubahan. Besarnya penghematan CPU firewall belum diukur.

Monitor SlowDNS dan tracker SSH berbagi satu snapshot socket segar lewat stdin
`refresh-snapshot`. Tracker tetap memeriksa journal autentikasi. Tidak ada cache
lintas siklus yang dapat mengubah keputusan lock.

## Validasi yang dapat diulang

- `npm run test:slowdns`: helper, online, auto-lock, firewall, dan snapshot tracker.
- Terapkan `SLOWDNS_PATCH_PY` dari installer ke ZIP DNSTT yang checksum-nya dipin,
  lalu salin dua file `scripts/go/slowdns_*_test.go` ke paket `dnstt-server`.
- `go test ./...` dan
  `go test ./dnstt-server -run '^TestSC' -bench '^BenchmarkSCResponse' -benchmem -count=3`.
  Paritas wire meliputi TXT/NULL, root/nama maksimum/label biner, EDNS/TTL/flags,
  overflow, bentuk nonstandar, dan 2.500 pesan acak deterministik. Perhitungan
  kapasitas dibandingkan dengan serializer lama pada 81.960 kombinasi.
- Build server target Linux; bangun juga server/client lokal dan arahkan
  `DNSTT_NATIVE_DIR` ke direktorinya, lalu `npm run test:slowdns-native`.
  Transport TXT serta NULL melewati DNS/Noise/KCP/smux sungguhan, bulk echo
  dua arah 64/128 KiB, dua ClientID, tiga stream, dan cleanup disconnect.

Aktivasi patch membutuhkan build dan restart SlowDNS melalui jalur update yang
sudah ada. Jika build gagal, binary lama tetap dipakai. Restart dapat membuat
klien perlu menyambung ulang; tuning dan pubkey klien tetap sama.

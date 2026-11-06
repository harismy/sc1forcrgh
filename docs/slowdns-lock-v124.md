# V.1FSC.124 - Pemutusan sesi SlowDNS saat auto-lock

Sesi Dropbear untuk forwarding SSH/SlowDNS dapat tetap berjalan sebagai root dan memakai argumen daemon asli, tanpa username di judul proses. Pemutus lama mengandalkan pemilik proses atau username di judulnya, sehingga sesi seperti ini bisa terlewat walaupun akun sudah masuk `LOCK_TMP`.

Checker sekarang mencocokkan username terautentikasi di `ssh-live.map` dengan **PID dan port sumber** pada snapshot TCP baru. PID juga harus merupakan proses Dropbear, tidak memiliki socket LISTEN, dan waktu mulai proses dibaca ulang sebelum kill untuk menolak PID yang berganti. Proses DNSTT bersama, listener Dropbear, sesi administrator root, dan sesi akun lain tidak ikut dihentikan.

Pola `pkill -f` berbasis awalan username di jalur multi-login dihapus agar nama seperti `alice` tidak ikut memutus `alice2`. Cadangan berbasis UID akun tetap tersedia untuk proses yang memang berjalan sebagai pengguna tersebut.

Password Linux dikunci sebelum pemutusan sesi untuk menutup celah reconnect di antara dua langkah itu. Setiap siklus checker juga menegakkan kembali lock sementara yang belum berakhir: mengunci ulang password jika terbuka, lalu memutus sesi akun terkunci yang masih lolos. Akun dengan status AKTIF setelah manual unlock dan lock yang sudah kedaluwarsa tidak termasuk sapuan ini. Expiry 15 menit dan notifikasi awal tidak diperpanjang atau dikirim ulang oleh sapuan.

Tidak ada daemon atau timer baru. Akun terkunci memakai satu snapshot proses/socket bersama per sapuan; pemeriksaan ulang hanya berjalan jika ada sesi yang dicoba diputus. Jika tidak ada lock sementara, tidak ada snapshot tambahan. MTU, KCP, window, resolver, buffer socket, dan binary SlowDNS tetap memakai pengaturan sebelumnya.

Pengujian regresi ada di `scripts/test-ssh-lock-enforcement.js`, masuk dalam `npm run test:slowdns`: proses root tanpa judul username, pemutusan selektif, IPv4/IPv6, port alternatif, state usang, konflik identitas, listener, pergantian PID, data socket gagal, penegakan lock berulang, dan manual unlock. Uji ini memakai simulasi snapshot sistem; validasi pemasangan di VPS tetap terpisah.

Validasi lokal: `npm run test:slowdns` lulus, termasuk uji monitor, auto-lock, pemutusan sesi, dan efisiensi. Syntax installer, 35 script Bash hasil heredoc, `iplimit-checker.js` hasil heredoc, `app3.js`, serta `license-api.js` juga lulus. Uji pemutusan memeriksa SSH langsung/OpenSSH baru dan memastikan beberapa akun terkunci tetap memakai satu snapshot bersama; saat tidak ada lock, tidak ada snapshot tambahan.

Suite `npm test` berhenti pada `test:installer-ui`: baris animasi terminal `linux` terbaca selebar 49, diharapkan 43 (`scripts/test-installer-ui.js:376`). Blok `installer-ui` dan helper domain yang menjadi input pengujian tersebut sudah dibandingkan dengan HEAD sebelum perbaikan dan identik. Tidak ada perubahan tampilan installer dalam V.124; kegagalan suite ini tetap dicatat sebagai batas validasi, bukan dianggap lulus.

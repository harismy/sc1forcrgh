# Paket penerapan langsung pada VPS

Paket ini memuat empat file runtime yang sudah dicocokkan dengan versi VPS saat paket disiapkan:

- `/usr/local/sbin/sc-1forcr-udpgw-drain`: satu snapshot untuk beberapa port alias; kegagalan membaca koneksi tidak menghentikan proses aktif.
- `/usr/local/sbin/sc-1forcr-postboot-health`: satu snapshot listener per percobaan pemeriksaan unit.
- `/usr/local/sbin/restart_update_safe_services`: mengurangi restart timer online-notify, pull-update, pull-summary-update, dan god-update.
- `/opt/sc-1forcr/menu-sc-1forcr.sh`: perubahan serupa pada fungsi akhir safe-update di menu.

Perubahan penulisan unit dan batching reload pada installer lengkap tetap berada di source installer. Paket runtime ini tidak menjalankan installer lengkap, tidak mengubah unit systemd, dan tidak mengubah DNSTT/KCP. Efek yang diuji adalah pengurangan overhead pengelolaan; persentase penurunan CPU tunneling belum diukur.

## Penggunaan di terminal host VPS sebagai root

Pemeriksaan tanpa penerapan:

```sh
python3 /root/autoscript-efficiency/apply-runtime.py
```

Penerapan:

```sh
python3 /root/autoscript-efficiency/apply-runtime.py --apply
```

Rollback:

```sh
python3 /root/autoscript-efficiency/apply-runtime.py --rollback
```

Program memverifikasi checksum payload, syntax Bash, dan versi file aktif. Ia mengambil lock updater terkait, menyimpan cadangan di `/root/autoscript-efficiency/runtime-backups/`, lalu mengganti file secara atomik dengan kepemilikan dan mode tetap. Kegagalan saat penulisan memulihkan file yang sudah diganti bila file tersebut masih sesuai payload patch.

Tidak ada restart tunnel atau pemanggilan installer. Skrip yang sedang berjalan menyelesaikan pekerjaannya; timer memakai versi baru pada pemanggilan berikutnya. Menu yang sudah terbuka perlu dibuka ulang untuk memuat fungsi baru.

Jika versi file sudah berubah karena update, program menolak menimpa perubahan tersebut. Regenerasi paket diperlukan. Update resmi autoscript berikutnya masih dapat menimpa patch lokal ini, sehingga perubahan permanen tetap perlu digabung ke source distribusi.

Status penerapan harus dilihat dari keluaran `APPLY OK` dan hasil pemeriksaan `PATCHED` untuk empat file. Keberadaan paket dan hasil pengujian saja tidak berarti patch sudah diterapkan.

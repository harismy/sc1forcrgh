# SC 1FORCR GitHub Installer

Repository installer:

```text
https://github.com/harismy/sc1forcrgh.git
```

Raw installer:

```text
https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh
https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh
```

## Install AutoSC

Jalankan sebagai `root` di VPS Debian/Ubuntu:

```bash
apt-get update -y && apt-get install -y --no-upgrade curl ca-certificates htop && TMP_SC=/tmp/setup-autoscript-compat.sh && curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh -o "$TMP_SC" && chmod +x "$TMP_SC" && bash "$TMP_SC"
```

## Install Summary API

Jalankan jika hanya ingin memasang/update Summary API:

```bash
apt-get update -y && apt-get install -y --no-upgrade curl ca-certificates && TMP_SUMMARY=/tmp/setup-summary-api.sh && curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh -o "$TMP_SUMMARY" && chmod +x "$TMP_SUMMARY" && bash "$TMP_SUMMARY"
```

## Install AutoSC + Summary API

AutoSC default sudah bisa menjalankan instalasi Summary API jika fitur `AUTO_INSTALL_SUMMARY_API=1` aktif:

```bash
apt-get update -y && apt-get install -y --no-upgrade curl ca-certificates htop && TMP_SC=/tmp/setup-autoscript-compat.sh && curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh -o "$TMP_SC" && chmod +x "$TMP_SC" && AUTO_INSTALL_SUMMARY_API=1 SUMMARY_API_SETUP_URL=https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh bash "$TMP_SC"
```

## Update AutoSC

Jika SC sudah terpasang, update bisa dijalankan dari menu VPS atau langsung:

```bash
UPDATE_SCRIPT_URL=https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh menu-sc-1forcr update
```

## Update Summary API

```bash
SUMMARY_API_SETUP_URL=https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh menu-sc-1forcr update-summary
```

## DNS Resolver Guard

SC memeriksa resolusi beberapa domain sebelum instalasi dan secara berkala melalui
`sc-1forcr-dns-guard.timer`. Selama DNS VPS sehat, konfigurasi resolver tidak
diubah. Jika seluruh tes DNS gagal dua kali, konfigurasi lama dicadangkan ke
`/var/backups/sc-1forcr/dns`, lalu resolver dipulihkan menggunakan `8.8.8.8` dan
`1.1.1.1`.

Fitur aktif secara default dan dapat disesuaikan melalui:

```bash
DNS_GUARD_ENABLE=1
DNS_GUARD_INTERVAL_MINUTES=10
```

## HAProxy Backend Readiness

Konfigurasi HAProxy memberi toleransi pada restart singkat Nginx dan SSHWS agar
backend tidak langsung ditandai `DOWN`. Instalasi penuh menunggu seluruh port
backend lokal siap sebelum HAProxy dinyalakan kembali, sedangkan safe update
memvalidasi listener backend dan menjalankan rollback jika layanan tidak pulih.

## Catatan Penting

Jangan menjalankan installer besar dengan format ini:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh)"
```

Format tersebut bisa gagal dengan error:

```text
/usr/bin/bash: Argument list too long
```

Gunakan command yang men-download file dulu ke `/tmp`, lalu jalankan dengan `bash "$TMP_SC"`.

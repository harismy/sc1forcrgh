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
apt-get update -y && apt-get install -y curl ca-certificates htop && TMP_SC=/tmp/setup-autoscript-compat.sh && curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh -o "$TMP_SC" && chmod +x "$TMP_SC" && bash "$TMP_SC"
```

## Install Summary API

Jalankan jika hanya ingin memasang/update Summary API:

```bash
apt-get update -y && apt-get install -y curl ca-certificates && TMP_SUMMARY=/tmp/setup-summary-api.sh && curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh -o "$TMP_SUMMARY" && chmod +x "$TMP_SUMMARY" && bash "$TMP_SUMMARY"
```

## Install AutoSC + Summary API

AutoSC default sudah bisa menjalankan instalasi Summary API jika fitur `AUTO_INSTALL_SUMMARY_API=1` aktif:

```bash
apt-get update -y && apt-get install -y curl ca-certificates htop && TMP_SC=/tmp/setup-autoscript-compat.sh && curl -fsSL https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-autoscript-compat.sh -o "$TMP_SC" && chmod +x "$TMP_SC" && AUTO_INSTALL_SUMMARY_API=1 SUMMARY_API_SETUP_URL=https://raw.githubusercontent.com/harismy/sc1forcrgh/main/setup-summary-api.sh bash "$TMP_SC"
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

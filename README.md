# SC 1FORCR Nexus Bot (app3)

## Lokasi
- Bot source: `apps/sc1forcr-nexus-bot/app3.js`
- Installer: `apps/sc1forcr-nexus-bot/start.sh`
<<<<<<< HEAD
=======
- Bot ini standalone (tidak terhubung ke `app.js` dan tidak pakai `sellvpn.db` utama).
- API installer/license: `apps/sc1forcr-nexus-bot/license-api.js`
>>>>>>> 12d9022 (update)

## Cara install di VPS
Jalankan dari root repo:

```bash
cd /root/BotVPN/apps/sc1forcr-nexus-bot
bash start.sh
```

Installer akan meminta:
- `.env`
  - `BOT_TOKEN`
<<<<<<< HEAD
=======
  - `ADMIN_IDS` (untuk menu admin domain API)
>>>>>>> 12d9022 (update)
  - `DB_PATH`
  - `SC_REGISTRATION_FEE`
  - `TOPUP_MIN`
  - `TOPUP_EXPIRE_MS`
<<<<<<< HEAD
=======
  - `LICENSE_API_PORT`
  - `LICENSE_API_TOKEN`
  - `LICENSE_PUBLIC_BASE_URL`
  - `AUTO_PROVISION_DOMAIN`
  - `CERTBOT_EMAIL`
  - `INSTALL_SCRIPT_URL`
  - `SC_INSTALLER_LOCAL_PATH`
>>>>>>> 12d9022 (update)
- `.vars.json`
  - `PAYMENT_GATEWAY_MODE`
  - `GOPAY_API_BASE_URL`
  - `GOPAY_API_KEY`

<<<<<<< HEAD
=======
Default DB bot ini: `sc1forcrnexus.db` di folder bot.

>>>>>>> 12d9022 (update)
## Jalankan manual
```bash
cd /root/BotVPN/apps/sc1forcr-nexus-bot
npm install --omit=dev
pm2 start ecosystem.config.cjs --only sc1forcr-nexus-bot --update-env
<<<<<<< HEAD
pm2 save
```
=======
pm2 start ecosystem.config.cjs --only sc1forcr-license-api --update-env
pm2 save
```

## Endpoint API
- `GET /health`
- `GET /sc1forcr/installer.sh`
- `GET /sc1forcr/payload/setup-autoscript-compat.sh` (khusus IP terdaftar)
- `POST /sc1forcr/license/activate` (Bearer token = `LICENSE_API_TOKEN`)

## Admin Bot
- Gunakan `/admin` (hanya `ADMIN_IDS`) untuk:
  - tambah domain API installer
  - lihat list domain API
  - hapus domain API
  - lihat/ubah env dinamis langsung dari bot (sudah dikelompokkan menu: Billing / Provisioning / Installer)
    - `SC_REGISTRATION_FEE`, `TOPUP_MIN`, `TOPUP_EXPIRE_MS`, `AUTO_PROVISION_DOMAIN`, `CERTBOT_EMAIL`, `SC_INSTALLER_LOCAL_PATH`
- Saat tambah domain, bot bisa auto-setup Nginx + SSL certbot (jika `AUTO_PROVISION_DOMAIN=1`, bot jalan sebagai root, dan `nginx/certbot` tersedia).
- Upload update SC via tombol `Upload File Update SC` di menu admin.
- Setelah upload, endpoint installer otomatis pakai file lokal VPS (fallback ke `INSTALL_SCRIPT_URL` jika file lokal belum ada).
- User bisa ambil command installer dari menu bot `Ambil Link Install SC`.
>>>>>>> 12d9022 (update)

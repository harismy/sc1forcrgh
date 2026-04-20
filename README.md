# SC 1FORCR Nexus Bot (app3)

## Lokasi
- Bot source: `apps/sc1forcr-nexus-bot/app3.js`
- Installer: `apps/sc1forcr-nexus-bot/start.sh`

## Cara install di VPS
Jalankan dari root repo:

```bash
cd /root/BotVPN/apps/sc1forcr-nexus-bot
bash start.sh
```

Installer akan meminta:
- `.env`
  - `BOT_TOKEN`
  - `DB_PATH`
  - `SC_REGISTRATION_FEE`
  - `TOPUP_MIN`
  - `TOPUP_EXPIRE_MS`
- `.vars.json`
  - `PAYMENT_GATEWAY_MODE`
  - `GOPAY_API_BASE_URL`
  - `GOPAY_API_KEY`

## Jalankan manual
```bash
cd /root/BotVPN/apps/sc1forcr-nexus-bot
npm install --omit=dev
pm2 start ecosystem.config.cjs --only sc1forcr-nexus-bot --update-env
pm2 save
```

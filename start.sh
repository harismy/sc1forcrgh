#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${APP_DIR}"

prompt_required() {
  local label="$1"
  local outvar="$2"
  local val=""
  while true; do
    read -r -p "${label}: " val
    val="$(echo "${val}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [[ -n "${val}" ]]; then
      printf -v "${outvar}" '%s' "${val}"
      return 0
    fi
    echo "Input tidak boleh kosong."
  done
}

prompt_default() {
  local label="$1"
  local default_val="$2"
  local outvar="$3"
  local val=""
  read -r -p "${label} [${default_val}]: " val
  val="$(echo "${val}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [[ -z "${val}" ]]; then
    val="${default_val}"
  fi
  printf -v "${outvar}" '%s' "${val}"
}

echo "============================================"
echo " Setup SC 1FORCR Nexus Bot (app3)"
echo " Folder: ${APP_DIR}"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum terpasang. Install Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "PM2 belum terpasang. Install PM2..."
  npm install -g pm2
fi

echo
echo "Isi variabel .env"
prompt_required "BOT_TOKEN (token bot Telegram)" BOT_TOKEN
prompt_default "DB_PATH (path sqlite bot ini)" "${APP_DIR}/sc1forcrnexus.db" DB_PATH
prompt_default "SC_REGISTRATION_FEE" "25000" SC_REGISTRATION_FEE
prompt_default "TOPUP_MIN" "5000" TOPUP_MIN
prompt_default "TOPUP_EXPIRE_MS (ms)" "300000" TOPUP_EXPIRE_MS

echo
echo "Isi variabel .vars.json (payment gateway)"
prompt_default "PAYMENT_GATEWAY_MODE (gopay|both)" "gopay" PAYMENT_GATEWAY_MODE
prompt_default "GOPAY_API_BASE_URL" "https://api-gopay.sawargipay.cloud" GOPAY_API_BASE_URL
prompt_required "GOPAY_API_KEY" GOPAY_API_KEY

cat > .env <<EOF
BOT_TOKEN=${BOT_TOKEN}
DB_PATH=${DB_PATH}
SC_REGISTRATION_FEE=${SC_REGISTRATION_FEE}
TOPUP_MIN=${TOPUP_MIN}
TOPUP_EXPIRE_MS=${TOPUP_EXPIRE_MS}
EOF

cat > .vars.json <<EOF
{
  "PAYMENT_GATEWAY_MODE": "${PAYMENT_GATEWAY_MODE}",
  "GOPAY_API_BASE_URL": "${GOPAY_API_BASE_URL}",
  "GOPAY_API_KEY": "${GOPAY_API_KEY}"
}
EOF

echo
echo "Install dependency npm..."
npm install --omit=dev

echo "Menjalankan bot via PM2..."
pm2 start ecosystem.config.cjs --only sc1forcr-nexus-bot --update-env
pm2 save

echo
echo "Selesai."
echo "Cek status: pm2 status sc1forcr-nexus-bot"
echo "Cek log   : pm2 logs sc1forcr-nexus-bot"

#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Jalankan sebagai root."
  exit 1
fi

ipv6_supported() {
  [[ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)" == "0" ]] || return 1
  grep -q . /proc/net/if_inet6 2>/dev/null || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket; socket.socket(socket.AF_INET6, socket.SOCK_STREAM)' >/dev/null 2>&1 || return 1
  elif command -v ip >/dev/null 2>&1; then
    ip -6 addr replace ::1/128 dev lo >/dev/null 2>&1 || return 1
  fi
  return 0
}

ipv6_global_address_present() {
  ip -6 addr show scope global 2>/dev/null | grep -q .
}

sanitize_env_file() {
  local file="$1" tmp
  [[ -f "${file}" ]] || return 0
  tmp="$(mktemp)"
  awk '
    /^[[:space:]]*$/ { print; next }
    /^[[:space:]]*#/ { print; next }
    /^[A-Za-z_][A-Za-z0-9_]*=.*/ { print; next }
    { next }
  ' "${file}" > "${tmp}" && mv -f "${tmp}" "${file}"
}

safe_source_env_file() {
  local file="$1" line key value
  [[ -f "${file}" ]] || return 0
  sanitize_env_file "${file}"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "${line}" =~ ^[[:space:]]*# ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "${key}" | tr -d '[:space:]')"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "${#value}" -ge 2 ]]; then
      if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    printf -v "${key}" '%s' "${value}"
    export "${key}"
  done < "${file}"
}

safe_source_env_file /etc/sc-1forcr.env

# --- MIGRASI: upgrade default lama ke nilai optimal (dijalankan saat install & update) ---
# Guard SSH outbound dimatikan sekali jalan. Dulu default 1, tapi efeknya
# timpang: Xray (user nobody) terblokir, sedangkan tunnel SSH lolos karena
# forwarding dropbear berjalan sebagai root. Akibatnya pelanggan Xray tidak
# bisa SSH ke VPS sendiri lewat Termius/JuiceSSH/PuTTY. Pakai penanda supaya
# admin yang sengaja menyalakannya lagi tidak tertimpa tiap update.
if [[ ! -f /var/lib/sc-1forcr/migrated-outbound-ssh-guard ]]; then
  if [[ "${SSH_TUNNEL_BLOCK_OUTBOUND_SSH:-0}" != "0" ]]; then
    SSH_TUNNEL_BLOCK_OUTBOUND_SSH="0"
    if [[ -f /etc/sc-1forcr.env ]]; then
      sed -i 's/^SSH_TUNNEL_BLOCK_OUTBOUND_SSH=.*/SSH_TUNNEL_BLOCK_OUTBOUND_SSH=0/' /etc/sc-1forcr.env
    fi
    log "Migrasi: SSH_TUNNEL_BLOCK_OUTBOUND_SSH 1 -> 0 (Xray kini bisa SSH ke VPS lain)"
  fi
  mkdir -p /var/lib/sc-1forcr >/dev/null 2>&1 || true
  : > /var/lib/sc-1forcr/migrated-outbound-ssh-guard 2>/dev/null || true
fi
if [[ "${DROPBEAR_IDLE_TIMEOUT_SECONDS:-0}" == "0" ]]; then
  DROPBEAR_IDLE_TIMEOUT_SECONDS="300"
  if [[ -f /etc/sc-1forcr.env ]]; then
    sed -i 's/^DROPBEAR_IDLE_TIMEOUT_SECONDS=.*/DROPBEAR_IDLE_TIMEOUT_SECONDS=300/' /etc/sc-1forcr.env
  fi
  log "Migrasi: DROPBEAR_IDLE_TIMEOUT_SECONDS 0 -> 300 (cegah zombie proses)"
fi
_iplimit_cur="$(echo "${IPLIMIT_CHECK_INTERVAL_MINUTES:-3}" | tr -cd '0-9')"
if [[ -z "${_iplimit_cur}" || "${_iplimit_cur}" -lt 5 ]]; then
  IPLIMIT_CHECK_INTERVAL_MINUTES="5"
  if [[ -f /etc/sc-1forcr.env ]]; then
    sed -i 's/^IPLIMIT_CHECK_INTERVAL_MINUTES=.*/IPLIMIT_CHECK_INTERVAL_MINUTES=5/' /etc/sc-1forcr.env
  fi
  log "Migrasi: IPLIMIT_CHECK_INTERVAL_MINUTES ${_iplimit_cur:-?} -> 5 (minimal 5 menit)"
fi
# --- END MIGRASI ---

AUTH_TOKEN="${AUTH_TOKEN:-${API_AUTH_TOKEN:-}}"
API_BASE="http://127.0.0.1:${API_PORT}/vps"
PENDING_OP_FILE="/var/lib/sc-1forcr/pending-op.env"

set_pending_operation() {
  local type="$1" cmd="$2" note="$3"
  mkdir -p /var/lib/sc-1forcr >/dev/null 2>&1 || true
  {
    printf 'PENDING_TYPE=%q\n' "${type}"
    printf 'PENDING_CMD=%q\n' "${cmd}"
    printf 'PENDING_NOTE=%q\n' "${note}"
    printf 'PENDING_TIME=%q\n' "$(date '+%F %T')"
  } > "${PENDING_OP_FILE}"
  chmod 600 "${PENDING_OP_FILE}" >/dev/null 2>&1 || true
}

clear_pending_operation() {
  rm -f "${PENDING_OP_FILE}" >/dev/null 2>&1 || true
}

resume_pending_operation_prompt() {
  local ans cmd type note
  [[ -t 0 && -t 1 ]] || return 0
  [[ -f "${PENDING_OP_FILE}" ]] || return 0
  [[ "${SC_PENDING_PROMPT_SHOWN:-0}" == "1" ]] && return 0
  SC_PENDING_PROMPT_SHOWN=1
  # shellcheck disable=SC1090
  source "${PENDING_OP_FILE}" >/dev/null 2>&1 || true
  cmd="${PENDING_CMD:-}"
  type="${PENDING_TYPE:-unknown}"
  note="${PENDING_NOTE:-pending operation}"
  [[ -z "${cmd}" ]] && return 0
  {
    printf '\nAda proses %s yang belum selesai.\n' "${type}"
    printf 'Info : %s\n' "${note}"
    printf 'Cmd  : %s\n' "${cmd}"
  } | ui_fx >/dev/tty
  if [[ -z "${UI_MODE:-}" ]]; then ui_init; fi
  printf ' %s◆%s %sTekan Enter untuk lanjutkan, atau ketik %sskip%s%s untuk nanti:%s ' \
    "${UI_ACC2}" "${UI_NC}" "${UI_VAL}" "${UI_ACC}" "${UI_NC}" "${UI_VAL}" "${UI_NC}" >/dev/tty
  read -r ans </dev/tty || true
  [[ "${ans,,}" == "skip" ]] && return 0
  rm -f "${PENDING_OP_FILE}" >/dev/null 2>&1 || true
  if [[ "${type}" == "update" ]]; then
    if ! update_script_locked; then
      set_pending_operation "${type}" "${cmd}" "${note}"
      echo "Proses pending masih gagal. Akan ditawarkan lagi saat login berikutnya."
    fi
    return 0
  fi
  if ! bash -lc "${cmd}"; then
    set_pending_operation "${type}" "${cmd}" "${note}"
    echo "Proses pending masih gagal. Akan ditawarkan lagi saat login berikutnya."
  fi
}

has_pending_install_only() {
  [[ -f "${PENDING_OP_FILE}" ]] || return 1
  # shellcheck disable=SC1090
  source "${PENDING_OP_FILE}" >/dev/null 2>&1 || return 1
  [[ "${PENDING_TYPE:-}" == "install" && -n "${PENDING_CMD:-}" ]]
}

is_sc_installed_runtime() {
  systemctl list-unit-files 2>/dev/null | grep -q '^sc-1forcr-api\.service' && return 0
  [[ -x /usr/local/sbin/menu-sc-1forcr ]] && [[ -f /etc/sc-1forcr.env ]] && return 0
  return 1
}

normalize_pending_operation() {
  [[ -f "${PENDING_OP_FILE}" ]] || return 0
  # shellcheck disable=SC1090
  source "${PENDING_OP_FILE}" >/dev/null 2>&1 || true
  local type cmd note
  type="${PENDING_TYPE:-}"
  cmd="${PENDING_CMD:-}"
  note="${PENDING_NOTE:-}"
  [[ -z "${type}" || -z "${cmd}" ]] && return 0

  if [[ "${type}" == "install" && "${cmd}" == *"/tmp/setup-autoscript-compat.sh"* && ! -f /tmp/setup-autoscript-compat.sh ]]; then
    if [[ -x /var/lib/sc-1forcr/pending-install.sh ]]; then
      set_pending_operation "install" "bash /var/lib/sc-1forcr/pending-install.sh" "Install SC 1FORCR terputus sebelum selesai"
    fi
    return 0
  fi

  # Fokus hanya pending install: pending type lain dibersihkan agar tidak bentrok menu utama.
  if [[ "${type}" != "install" ]]; then
    clear_pending_operation
  fi
}

pending_install_gate_menu() {
  local pu_ans cmd type note gate_title opt1_label current_line
  [[ -t 0 && -t 1 ]] || return 0
  has_pending_install_only || return 0
  # shellcheck disable=SC1090
  source "${PENDING_OP_FILE}" >/dev/null 2>&1 || true
  cmd="${PENDING_CMD:-bash /var/lib/sc-1forcr/pending-install.sh}"
  type="${PENDING_TYPE:-install}"
  note="${PENDING_NOTE:-Install SC 1FORCR terputus sebelum selesai}"
  gate_title="INSTALL PENDING"
  opt1_label="Lanjutkan Install"
  while true; do
    current_line="${note}"
    if [[ -f /var/lib/sc-1forcr/install-current.env ]]; then
      # shellcheck disable=SC1091
      source /var/lib/sc-1forcr/install-current.env >/dev/null 2>&1 || true
      current_line="Terakhir: ${STEP_MESSAGE:-unknown} (${STEP_PERCENT:-?}%)"
    fi
    clear
    draw_menu_panel "${gate_title}" \
      "${current_line}" \
      "1) ${opt1_label}" \
      "2) Batalkan pending" \
      "0) Exit"
    echo
    if ! prompt_input pu_ans "Pilih menu [0-2]: "; then
      exit 0
    fi
    case "${pu_ans}" in
      1)
        if ! bash -lc "${cmd}"; then
          set_pending_operation "${type}" "${cmd}" "${note}"
          echo
          echo "Install pending belum berhasil dilanjutkan."
          menu_pause "Enter untuk kembali ke menu pending..."
        else
          return 0
        fi
        ;;
      2)
        rm -f "${PENDING_OP_FILE}" >/dev/null 2>&1 || true
        return 0
        ;;
      0) exit 0 ;;
      *)
        echo "Pilihan tidak valid."
        sleep 1
        ;;
    esac
  done
}

ZIVPN_DNAT_RANGE="${ZIVPN_DNAT_RANGE:-6000:19999}"
UDPCUSTOM_DNAT_RANGE="${UDPCUSTOM_DNAT_RANGE:-}"
UDPCUSTOM_DNAT_AUTO_RANGE="${UDPCUSTOM_DNAT_AUTO_RANGE:-}"
SSHWS_NGINX_LIMIT_ENABLE="${SSHWS_NGINX_LIMIT_ENABLE:-1}"
SSHWS_NGINX_LIMIT_RATE="${SSHWS_NGINX_LIMIT_RATE:-2r/s}"
SSHWS_NGINX_LIMIT_BURST="${SSHWS_NGINX_LIMIT_BURST:-4}"
SSHWS_NGINX_LIMIT_CONN="${SSHWS_NGINX_LIMIT_CONN:-3}"
XRAY_MONITOR_ACTIVE_WINDOW_SECONDS="${XRAY_MONITOR_ACTIVE_WINDOW_SECONDS:-60}"
XRAY_MONITOR_RECENT_WINDOW_MINUTES="${XRAY_MONITOR_RECENT_WINDOW_MINUTES:-5}"
ONLINE_NOTIFY_ENABLE="${ONLINE_NOTIFY_ENABLE:-1}"
ONLINE_NOTIFY_INTERVAL_HOURS="$(echo "${ONLINE_NOTIFY_INTERVAL_HOURS:-3}" | tr -cd '0-9')"
ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS="$(echo "${ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS:-300}" | tr -cd '0-9')"
AUTO_PULL_UPDATE_ENABLE="${AUTO_PULL_UPDATE_ENABLE:-1}"
AUTO_PULL_UPDATE_INTERVAL_MINUTES="$(echo "${AUTO_PULL_UPDATE_INTERVAL_MINUTES:-360}" | tr -cd '0-9')"
AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES="$(echo "${AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES:-360}" | tr -cd '0-9')"
QUOTA_LOCK_ENABLE="${QUOTA_LOCK_ENABLE:-1}"
DROPBEAR_LOG_MAX_LINES="$(echo "${DROPBEAR_LOG_MAX_LINES:-12000}" | tr -cd '0-9')"
DROPBEAR_RECENT_LOG_MAX_LINES="$(echo "${DROPBEAR_RECENT_LOG_MAX_LINES:-5000}" | tr -cd '0-9')"
UDPHC_LOG_LINES_HISTORY="$(echo "${UDPHC_LOG_LINES_HISTORY:-1200}" | tr -cd '0-9')"
UDPHC_LOG_LINES_REALTIME="$(echo "${UDPHC_LOG_LINES_REALTIME:-400}" | tr -cd '0-9')"
UDPHC_LOG_LINES_CHECKER="$(echo "${UDPHC_LOG_LINES_CHECKER:-6000}" | tr -cd '0-9')"
  xray_recent_window_min="$(echo "${XRAY_RECENT_WINDOW_MINUTES:-5}" | tr -cd '0-9')"
  xray_active_window_sec="$(echo "${XRAY_ACTIVE_WINDOW_SECONDS:-60}" | tr -cd '0-9')"
  xray_min_hits_per_ip="$(echo "${XRAY_MIN_HITS_PER_IP:-2}" | tr -cd '0-9')"
xray_monitor_active_window_sec="$(echo "${XRAY_MONITOR_ACTIVE_WINDOW_SECONDS:-60}" | tr -cd '0-9')"
xray_monitor_recent_window_min="$(echo "${XRAY_MONITOR_RECENT_WINDOW_MINUTES:-5}" | tr -cd '0-9')"
[[ -z "${DROPBEAR_LOG_MAX_LINES}" || "${DROPBEAR_LOG_MAX_LINES}" -lt 2000 ]] && DROPBEAR_LOG_MAX_LINES="12000"
[[ -z "${DROPBEAR_RECENT_LOG_MAX_LINES}" || "${DROPBEAR_RECENT_LOG_MAX_LINES}" -lt 500 ]] && DROPBEAR_RECENT_LOG_MAX_LINES="5000"
[[ -z "${UDPHC_LOG_LINES_HISTORY}" || "${UDPHC_LOG_LINES_HISTORY}" -lt 200 ]] && UDPHC_LOG_LINES_HISTORY="1200"
[[ -z "${UDPHC_LOG_LINES_REALTIME}" || "${UDPHC_LOG_LINES_REALTIME}" -lt 100 ]] && UDPHC_LOG_LINES_REALTIME="400"
[[ -z "${UDPHC_LOG_LINES_CHECKER}" || "${UDPHC_LOG_LINES_CHECKER}" -lt 1000 ]] && UDPHC_LOG_LINES_CHECKER="6000"
  [[ -z "${xray_recent_window_min}" || "${xray_recent_window_min}" -lt 5 ]] && xray_recent_window_min="5"
  [[ -z "${xray_active_window_sec}" || "${xray_active_window_sec}" -lt 30 ]] && xray_active_window_sec="60"
  [[ -z "${xray_min_hits_per_ip}" || "${xray_min_hits_per_ip}" -lt 1 ]] && xray_min_hits_per_ip="2"
[[ -z "${xray_monitor_active_window_sec}" || "${xray_monitor_active_window_sec}" -lt 30 || "${xray_monitor_active_window_sec}" -gt 3600 ]] && xray_monitor_active_window_sec="60"
[[ -z "${xray_monitor_recent_window_min}" || "${xray_monitor_recent_window_min}" -lt 1 || "${xray_monitor_recent_window_min}" -gt 60 ]] && xray_monitor_recent_window_min="5"
[[ "${ONLINE_NOTIFY_ENABLE}" != "0" ]] && ONLINE_NOTIFY_ENABLE="1"
[[ -z "${ONLINE_NOTIFY_INTERVAL_HOURS}" || "${ONLINE_NOTIFY_INTERVAL_HOURS}" -lt 1 || "${ONLINE_NOTIFY_INTERVAL_HOURS}" -gt 168 ]] && ONLINE_NOTIFY_INTERVAL_HOURS="3"
[[ -z "${ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS}" || "${ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS}" -lt 60 || "${ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS}" -gt 86400 ]] && ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS="300"
[[ "${AUTO_PULL_UPDATE_ENABLE}" != "0" ]] && AUTO_PULL_UPDATE_ENABLE="1"
[[ -z "${AUTO_PULL_UPDATE_INTERVAL_MINUTES}" || "${AUTO_PULL_UPDATE_INTERVAL_MINUTES}" -lt 1 || "${AUTO_PULL_UPDATE_INTERVAL_MINUTES}" -gt 1440 ]] && AUTO_PULL_UPDATE_INTERVAL_MINUTES="360"
[[ -z "${AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES}" || "${AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES}" -lt 10 || "${AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES}" -gt 10080 ]] && AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES="360"
[[ "${QUOTA_LOCK_ENABLE}" != "0" ]] && QUOTA_LOCK_ENABLE="1"

# Compatibility helpers for older runtime files on upgraded VPS.
dropbear_runtime_args() {
  local keepalive idle
  keepalive="$(echo "${DROPBEAR_KEEPALIVE_SECONDS:-30}" | tr -cd '0-9')"
  idle="$(echo "${DROPBEAR_IDLE_TIMEOUT_SECONDS:-300}" | tr -cd '0-9')"
  [[ -z "${keepalive}" || "${keepalive}" -gt 3600 ]] && keepalive="30"
  [[ -z "${idle}" || "${idle}" -gt 86400 ]] && idle="300"
  # -w: tolak login root (admin lewat sshd); -k: tolak remote port forwarding.
  printf -- '-w -k -K %s -I %s' "${keepalive}" "${idle}"
}

# Dropbear menolak start kalau file banner lebih dari 2000 byte ("Early exit:
# Banner file too large, max is 2000 bytes"), lalu systemd menyerah setelah 5
# percobaan dan port 109/143 mati. Ini pernah terjadi sungguhan setelah banner
# HTML diganti dengan versi berwarna per huruf. OpenSSH tidak punya batas itu,
# jadi hanya Dropbear yang diberi salinan yang dipadatkan (komentar HTML dibuang,
# spasi/baris baru dirapatkan; tampilan HTML sama). Kalau masih kebesaran,
# Dropbear jalan tanpa banner: koneksi lebih penting daripada banner.
DROPBEAR_BANNER_MAX_BYTES=1990
dropbear_safe_banner() {
  local src="$1" compact="/etc/sc-1forcr/banner-dropbear.html" size orig
  [[ -n "${src}" && -s "${src}" ]] || return 0
  orig="$(wc -c < "${src}" 2>/dev/null | tr -cd '0-9' || true)"
  if (( ${orig:-0} <= DROPBEAR_BANNER_MAX_BYTES )); then
    printf '%s' "${src}"
    return 0
  fi
  mkdir -p "$(dirname "${compact}")" >/dev/null 2>&1 || true
  { tr -d '\r' < "${src}" | tr '\n\t' '  ' | sed -E 's/<!--([^-]|-[^-])*-->//g; s/ +/ /g; s/^ //; s/ $//'; } > "${compact}.tmp" 2>/dev/null || true
  size="$(wc -c < "${compact}.tmp" 2>/dev/null | tr -cd '0-9' || true)"
  if [[ -s "${compact}.tmp" ]] && (( ${size:-0} <= DROPBEAR_BANNER_MAX_BYTES )); then
    mv -f "${compact}.tmp" "${compact}"
    chmod 644 "${compact}" >/dev/null 2>&1 || true
    echo "Catatan: banner ${orig} byte melebihi batas Dropbear 2000 byte; Dropbear memakai salinan padat ${size} byte." >&2
    printf '%s' "${compact}"
    return 0
  fi
  rm -f "${compact}.tmp" "${compact}" >/dev/null 2>&1 || true
  echo "Peringatan: banner ${orig} byte melebihi batas Dropbear 2000 byte. Dropbear jalan tanpa banner (SSH port 22 tetap memakai banner). Perkecil banner supaya tampil di Dropbear." >&2
  return 0
}

flag_enabled() {
  case "$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

normalize_bool_01() {
  local raw
  raw="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "${raw}" in
    1|true|yes|on) echo "1" ;;
    *) echo "0" ;;
  esac
}

trim_env_value() {
  local value
  value="$(printf '%s' "${1:-}" | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  echo "${value}"
}

clean_cloudflare_secret() {
  local value
  value="$(trim_env_value "${1:-}")"
  value="$(printf '%s' "${value}" | sed -E 's/^[Bb]earer[[:space:]]+//; s/[[:space:]]+//g')"
  echo "${value}"
}

write_cloudflare_certbot_credentials() {
  local cred_file cf_email cf_key
  cred_file="${1:-/root/.secrets/certbot/cloudflare.ini}"
  cf_email="$(trim_env_value "${WILDCARD_CF_EMAIL:-}")"
  cf_key="$(clean_cloudflare_secret "${WILDCARD_CF_API_KEY:-}")"

  mkdir -p "$(dirname "${cred_file}")"
  if [[ -n "${cf_email}" && -n "${cf_key}" ]]; then
    WILDCARD_CF_API_TOKEN=""
    WILDCARD_CF_EMAIL="${cf_email}"
    WILDCARD_CF_API_KEY="${cf_key}"
    cat > "${cred_file}" <<EOF
dns_cloudflare_email = ${cf_email}
dns_cloudflare_api_key = ${cf_key}
EOF
  else
    return 1
  fi
  chmod 600 "${cred_file}"
  return 0
}

sanitize_domain_host() {
  local host
  host="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  host="${host#https://}"
  host="${host#http://}"
  host="${host%%/*}"
  host="${host%%:*}"
  host="$(printf '%s' "${host}" | sed -E 's/[^a-z0-9.-]//g; s/^\.+//; s/\.+$//; s/\.\.+/./g')"
  echo "${host}"
}

certificate_dns_host_valid() {
  local host label
  host="$(sanitize_domain_host "${1:-}")"
  [[ -n "${host}" && "${host}" == *.* ]] || return 1
  [[ ! "${host}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS='.' read -ra __certificate_labels <<< "${host}"
  for label in "${__certificate_labels[@]}"; do
    [[ "${#label}" -ge 1 && "${#label}" -le 63 ]] || return 1
    [[ "${label}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
  return 0
}

normalize_domain_host_list() {
  local raw item host out
  raw="$(printf '%s' "${1:-}" | tr '\r\n\t ;|' ',')"
  out=""
  IFS=',' read -ra __host_items <<< "${raw}"
  for item in "${__host_items[@]}"; do
    host="$(sanitize_domain_host "${item}")"
    [[ -z "${host}" ]] && continue
    if [[ ",${out}," != *",${host},"* ]]; then
      out="${out}${out:+,}${host}"
    fi
  done
  echo "${out}"
}

csv_first_item() {
  local raw first
  raw="${1:-}"
  first="${raw%%,*}"
  echo "${first}"
}

build_xray_alias_hosts() {
  local domain aliases exact_hosts prefix_hosts host prefix candidate
  domain="$(sanitize_domain_host "${DOMAIN:-}")"
  aliases=""

  if [[ -n "${WILDCARD_XRAY_HOSTS:-}${WILDCARD_XRAY_HOST:-}${WILDCARD_BUG_PREFIXES:-}${WILDCARD_BUG_PREFIX:-}" ]]; then
    exact_hosts="$(normalize_domain_host_list "${WILDCARD_XRAY_HOSTS:-},${WILDCARD_XRAY_HOST:-}")"
  else
    exact_hosts="$(normalize_domain_host_list "${XRAY_PUBLIC_HOST:-}")"
  fi
  IFS=',' read -ra __exact_hosts <<< "${exact_hosts}"
  for host in "${__exact_hosts[@]}"; do
    [[ -z "${host}" || "${host}" == "${domain}" ]] && continue
    if [[ ",${aliases}," != *",${host},"* ]]; then
      aliases="${aliases}${aliases:+,}${host}"
    fi
  done

  prefix_hosts="$(normalize_domain_host_list "${WILDCARD_BUG_PREFIXES:-},${WILDCARD_BUG_PREFIX:-}")"
  IFS=',' read -ra __prefix_hosts <<< "${prefix_hosts}"
  for prefix in "${__prefix_hosts[@]}"; do
    [[ -z "${prefix}" || -z "${domain}" ]] && continue
    if [[ "${prefix}" == "${domain}" || "${prefix}" == *".${domain}" ]]; then
      candidate="${prefix}"
    else
      candidate="${prefix}.${domain}"
    fi
    candidate="$(sanitize_domain_host "${candidate}")"
    [[ -z "${candidate}" || "${candidate}" == "${domain}" ]] && continue
    if [[ ",${aliases}," != *",${candidate},"* ]]; then
      aliases="${aliases}${aliases:+,}${candidate}"
    fi
  done

  echo "${aliases}"
}

build_sshws_realip_nginx_map() {
  cat <<'EOF'
# sc-1forcr-trusted-realip-v2: trust CF-Connecting-IP only from Cloudflare peers
map $proxy_protocol_addr $sc_sshws_peer_ip {
    "" $remote_addr;
    default $proxy_protocol_addr;
}
geo $sc_sshws_peer_ip $sc_sshws_peer_is_cloudflare {
    default 0;
    173.245.48.0/20 1;
    103.21.244.0/22 1;
    103.22.200.0/22 1;
    103.31.4.0/22 1;
    141.101.64.0/18 1;
    108.162.192.0/18 1;
    190.93.240.0/20 1;
    188.114.96.0/20 1;
    197.234.240.0/22 1;
    198.41.128.0/17 1;
    162.158.0.0/15 1;
    104.16.0.0/13 1;
    104.24.0.0/14 1;
    172.64.0.0/13 1;
    131.0.72.0/22 1;
    2400:cb00::/32 1;
    2606:4700::/32 1;
    2803:f800::/32 1;
    2405:b500::/32 1;
    2405:8100::/32 1;
    2a06:98c0::/29 1;
    2c0f:f248::/32 1;
}
map "$sc_sshws_peer_is_cloudflare:$http_cf_connecting_ip" $sc_sshws_real_ip {
    ~^1:.+ $http_cf_connecting_ip;
    default $sc_sshws_peer_ip;
}
EOF
}

build_xray_public_host() {
  local aliases first domain
  domain="$(sanitize_domain_host "${DOMAIN:-}")"
  aliases="$(build_xray_alias_hosts)"
  first="$(csv_first_item "${aliases}")"
  echo "${first:-${domain}}"
}

build_xray_front_hosts() {
  normalize_domain_host_list "${XRAY_FRONT_DOMAINS:-},${XRAY_FRONT_DOMAIN:-}"
}

build_nginx_server_names() {
  local names host base aliases
  names=""
  for host in "${DOMAIN:-}"; do
    host="$(sanitize_domain_host "${host}")"
    [[ -z "${host}" ]] && continue
    if [[ " ${names} " != *" ${host} "* ]]; then
      names="${names}${names:+ }${host}"
    fi
  done
  aliases="$(build_xray_alias_hosts)"
  IFS=',' read -ra __nginx_aliases <<< "${aliases}"
  for host in "${__nginx_aliases[@]}"; do
    [[ -z "${host}" ]] && continue
    if [[ " ${names} " != *" ${host} "* ]]; then
      names="${names}${names:+ }${host}"
    fi
  done
  if flag_enabled "${WILDCARD_ENABLE:-0}"; then
    base="$(sanitize_domain_host "${WILDCARD_BASE_DOMAIN:-}")"
    if [[ -n "${base}" && " ${names} " != *" *.${base} "* ]]; then
      names="${names}${names:+ }*.${base}"
    fi
  fi
  [[ -z "${names}" ]] && names="_"
  echo "${names}"
}

domain_covered_by_one_label_wildcard() {
  local host base left
  host="$(sanitize_domain_host "${1:-}")"
  base="$(sanitize_domain_host "${2:-}")"
  [[ -n "${host}" && -n "${base}" ]] || return 1
  [[ "${host}" == *".${base}" ]] || return 1
  left="${host%.${base}}"
  [[ -n "${left}" && "${left}" != *.* ]]
}

DOMAIN="$(sanitize_domain_host "${DOMAIN:-}")"
WILDCARD_BASE_DOMAIN="$(sanitize_domain_host "${WILDCARD_BASE_DOMAIN:-}")"
WILDCARD_BUG_PREFIX="$(csv_first_item "$(normalize_domain_host_list "${WILDCARD_BUG_PREFIX:-}")")"
WILDCARD_BUG_PREFIXES="$(normalize_domain_host_list "${WILDCARD_BUG_PREFIXES:-}")"
WILDCARD_XRAY_HOST="$(csv_first_item "$(normalize_domain_host_list "${WILDCARD_XRAY_HOST:-}")")"
WILDCARD_XRAY_HOSTS="$(normalize_domain_host_list "${WILDCARD_XRAY_HOSTS:-}")"
XRAY_PUBLIC_HOST="$(build_xray_public_host)"
XRAY_FRONT_DOMAIN="$(csv_first_item "$(normalize_domain_host_list "${XRAY_FRONT_DOMAIN:-}")")"
XRAY_FRONT_DOMAINS="$(normalize_domain_host_list "${XRAY_FRONT_DOMAINS:-}")"

tls_cert_domain() {
  if flag_enabled "${WILDCARD_ENABLE:-0}" && [[ -n "${WILDCARD_BASE_DOMAIN:-}" ]]; then
    echo "${WILDCARD_BASE_DOMAIN}"
  else
    echo "${DOMAIN}"
  fi
}

get_cpu_cores() {
  local cores
  cores="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
  if [[ -z "${cores}" || ! "${cores}" =~ ^[0-9]+$ || "${cores}" -lt 1 ]]; then
    echo "1"
    return
  fi
  echo "${cores}"
}

tune_nginx_capacity() {
  local nginx_conf wc rl nof
  nginx_conf="/etc/nginx/nginx.conf"
  [[ -f "${nginx_conf}" ]] || return 0

  wc="$(echo "${NGINX_WORKER_CONNECTIONS:-8192}" | tr -cd '0-9')"
  rl="$(echo "${NGINX_WORKER_RLIMIT_NOFILE:-200000}" | tr -cd '0-9')"
  nof="$(echo "${NGINX_SERVICE_LIMIT_NOFILE:-200000}" | tr -cd '0-9')"
  [[ -z "${wc}" || "${wc}" -lt 1024 ]] && wc="8192"
  [[ -z "${rl}" || "${rl}" -lt 65536 ]] && rl="200000"
  [[ -z "${nof}" || "${nof}" -lt 65536 ]] && nof="200000"

  sed -ri 's/^[[:space:]]*worker_processes[[:space:]]+[^;]+;/worker_processes auto;/' "${nginx_conf}" || true

  if grep -qE '^[[:space:]]*worker_rlimit_nofile[[:space:]]+[0-9]+;' "${nginx_conf}"; then
    sed -ri "s/^[[:space:]]*worker_rlimit_nofile[[:space:]]+[0-9]+;/worker_rlimit_nofile ${rl};/" "${nginx_conf}" || true
  else
    sed -ri "/^[[:space:]]*worker_processes[[:space:]]+auto;/a worker_rlimit_nofile ${rl};" "${nginx_conf}" || true
  fi

  sed -ri "0,/worker_connections[[:space:]]+[0-9]+[[:space:]]*;/{s/worker_connections[[:space:]]+[0-9]+[[:space:]]*;/worker_connections ${wc};/}" "${nginx_conf}" || true
  if ! grep -qE '^[[:space:]]*multi_accept[[:space:]]+on;' "${nginx_conf}"; then
    sed -ri "/worker_connections[[:space:]]+${wc}[[:space:]]*;/a\\    multi_accept on;" "${nginx_conf}" || true
  fi
  if ! grep -qE '^[[:space:]]*use[[:space:]]+epoll;' "${nginx_conf}"; then
    sed -ri "/worker_connections[[:space:]]+${wc}[[:space:]]*;/a\\    use epoll;" "${nginx_conf}" || true
  fi

  mkdir -p /etc/systemd/system/nginx.service.d
  cat > /etc/systemd/system/nginx.service.d/limits.conf <<EOF
[Service]
LimitNOFILE=${nof}
EOF
  systemctl daemon-reload || true
}

# Simpan permintaan cert terakhir supaya sc-1forcr-cert-sync bisa mencoba lagi
# dengan domain dan cara yang sama kalau Let's Encrypt gagal sekarang.
write_cert_request_file() {
  local mode="$1" name="$2" email="$3"
  shift 3
  mkdir -p /var/lib/sc-1forcr 2>/dev/null || true
  {
    echo "MODE=${mode}"
    echo "NAME=${name}"
    echo "DOMAINS=$*"
    echo "EMAIL=${email}"
  } > /var/lib/sc-1forcr/cert-request 2>/dev/null || true
  date +%s > /var/lib/sc-1forcr/cert-attempt 2>/dev/null || true
  return 0
}

issue_letsencrypt_cert() {
  local certbot_email_arg cert_email="" cert_domain xray_alias_hosts alias_host
  local -a cert_extra_args cert_extra_hosts
  cert_extra_args=()
  cert_extra_hosts=()
  cert_domain="$(tls_cert_domain)"
  if [[ -z "${cert_domain}" ]]; then
    echo "Domain sertifikat TLS kosong. Skip issue cert."
    return 1
  fi

  if [[ -z "${EMAIL:-}" || "${EMAIL:-}" == "admin@example.com" || "${EMAIL:-}" == *"@example.com" ]]; then
    certbot_email_arg="--register-unsafely-without-email"
  else
    certbot_email_arg="-m ${EMAIL}"
    cert_email="${EMAIL}"
  fi

  if flag_enabled "${WILDCARD_ENABLE:-0}"; then
    if [[ -z "${WILDCARD_BASE_DOMAIN:-}" || -z "${WILDCARD_CF_EMAIL:-}" || -z "${WILDCARD_CF_API_KEY:-}" ]]; then
      echo "Wildcard aktif tapi WILDCARD_BASE_DOMAIN/kredensial Cloudflare belum valid."
      return 1
    fi
    if ! certbot --help plugins 2>/dev/null | grep -qi 'dns-cloudflare'; then
      echo "Plugin certbot dns-cloudflare belum tersedia."
      return 1
    fi
    if ! write_cloudflare_certbot_credentials /root/.secrets/certbot/cloudflare.ini; then
      echo "Kredensial Cloudflare belum valid untuk certbot."
      return 1
    fi
    xray_alias_hosts="$(build_xray_alias_hosts)"
    IFS=',' read -ra __cert_alias_hosts <<< "${xray_alias_hosts}"
    for alias_host in "${__cert_alias_hosts[@]}"; do
      [[ -z "${alias_host}" || "${alias_host}" == "${WILDCARD_BASE_DOMAIN}" ]] && continue
      if ! certificate_dns_host_valid "${alias_host}"; then
        echo "Lewati SAN alias Xray non-domain: ${alias_host}"
        continue
      fi
      if ! domain_covered_by_one_label_wildcard "${alias_host}" "${WILDCARD_BASE_DOMAIN}"; then
        cert_extra_args+=(-d "${alias_host}")
        cert_extra_hosts+=("${alias_host}")
        echo "Tambahkan SAN exact untuk alias Xray wildcard: ${alias_host}"
      fi
    done
    write_cert_request_file cloudflare "${WILDCARD_BASE_DOMAIN}" "${cert_email}" \
      "${WILDCARD_BASE_DOMAIN}" "*.${WILDCARD_BASE_DOMAIN}" "${cert_extra_hosts[@]}"
    certbot certonly \
      --dns-cloudflare \
      --dns-cloudflare-credentials /root/.secrets/certbot/cloudflare.ini \
      --dns-cloudflare-propagation-seconds 30 \
      --cert-name "${WILDCARD_BASE_DOMAIN}" \
      --expand \
      -d "${WILDCARD_BASE_DOMAIN}" \
      -d "*.${WILDCARD_BASE_DOMAIN}" \
      "${cert_extra_args[@]}" \
      --non-interactive --agree-tos ${certbot_email_arg}
    return $?
  fi

  xray_alias_hosts="$(build_xray_alias_hosts)"
  IFS=',' read -ra __cert_alias_hosts <<< "${xray_alias_hosts}"
  for alias_host in "${__cert_alias_hosts[@]}"; do
    [[ -z "${alias_host}" || "${alias_host}" == "${DOMAIN}" ]] && continue
    if ! certificate_dns_host_valid "${alias_host}"; then
      echo "Lewati SAN alias Xray non-domain: ${alias_host}"
      continue
    fi
    cert_extra_args+=(-d "${alias_host}")
    cert_extra_hosts+=("${alias_host}")
    echo "Tambahkan SAN exact untuk alias Xray: ${alias_host}"
  done
  write_cert_request_file webroot "${cert_domain}" "${cert_email}" "${DOMAIN}" "${cert_extra_hosts[@]}"
  certbot certonly --webroot -w /var/www/html \
    --cert-name "${cert_domain}" \
    --expand \
    -d "${DOMAIN}" "${cert_extra_args[@]}" \
    --non-interactive --agree-tos ${certbot_email_arg}
}

prepare_haproxy_pem() {
  local cert_domain fullchain privkey pem
  cert_domain="$(tls_cert_domain)"
  fullchain="/etc/letsencrypt/live/${cert_domain}/fullchain.pem"
  privkey="/etc/letsencrypt/live/${cert_domain}/privkey.pem"
  pem="/etc/haproxy/certs/${cert_domain}.pem"

  mkdir -p /etc/haproxy/certs
  if [[ -s "${fullchain}" && -s "${privkey}" ]]; then
    cat "${fullchain}" "${privkey}" > "${pem}" || return 1
    chmod 600 "${pem}" || true
    echo "${pem}"
    return 0
  fi

  echo "Cert Let's Encrypt untuk ${cert_domain} belum ada. Pakai self-signed sementara agar 443 tetap aktif." >&2
  openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 3 \
    -subj "/CN=${cert_domain}" \
    -keyout "/etc/haproxy/certs/${cert_domain}.key" \
    -out "/etc/haproxy/certs/${cert_domain}.crt" >/dev/null 2>&1 || return 1
  cat "/etc/haproxy/certs/${cert_domain}.crt" "/etc/haproxy/certs/${cert_domain}.key" > "${pem}" || return 1
  chmod 600 "${pem}" || true
  echo "${pem}"
  return 0
}

fw_persist_rules() {
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
    systemctl enable netfilter-persistent >/dev/null 2>&1 || true
    return 0
  fi
  if command -v nft >/dev/null 2>&1 && systemctl is-enabled --quiet nftables 2>/dev/null; then
    nft list ruleset >/etc/nftables.conf 2>/dev/null || true
  fi
  return 0
}

network_effective_tcp_mss() {
  local requested iface mtu route_max
  requested="$(echo "${NETWORK_TCP_MSS:-1360}" | tr -cd '0-9')"
  [[ -z "${requested}" || "${requested}" -lt 536 || "${requested}" -gt 1460 ]] && requested="1360"
  iface="$(ip -4 route show default 2>/dev/null | awk 'NR==1 {print $5}')"
  mtu=""
  if [[ -n "${iface}" && -r "/sys/class/net/${iface}/mtu" ]]; then
    mtu="$(tr -cd '0-9' < "/sys/class/net/${iface}/mtu")"
  fi
  if [[ -n "${mtu}" && "${mtu}" -gt 576 ]]; then
    route_max=$((mtu - 40))
    [[ "${route_max}" -lt "${requested}" ]] && requested="${route_max}"
  fi
  [[ "${requested}" -lt 536 ]] && requested="536"
  printf '%s\n' "${requested}"
}

clear_network_mss_rules() {
  local parent
  command -v iptables >/dev/null 2>&1 || return 0
  for parent in INPUT OUTPUT FORWARD; do
    while iptables -w 10 -t mangle -C "${parent}" -p tcp --tcp-flags SYN,RST SYN \
      -j SC1FORCR_MSS >/dev/null 2>&1; do
      iptables -w 10 -t mangle -D "${parent}" -p tcp --tcp-flags SYN,RST SYN \
        -j SC1FORCR_MSS >/dev/null 2>&1 || break
    done
  done
  iptables -w 10 -t mangle -F SC1FORCR_MSS >/dev/null 2>&1 || true
  iptables -w 10 -t mangle -X SC1FORCR_MSS >/dev/null 2>&1 || true
}

apply_network_mss_rules() {
  local effective_mss min_match parent
  if ! command -v iptables >/dev/null 2>&1; then
    echo "iptables tidak tersedia, rule MSS dilewati."
    return 0
  fi
  effective_mss="$(network_effective_tcp_mss)"
  min_match=$((effective_mss + 1))
  clear_network_mss_rules
  iptables -w 10 -t mangle -N SC1FORCR_MSS >/dev/null 2>&1 || true
  if ! iptables -w 10 -t mangle -A SC1FORCR_MSS -p tcp --tcp-flags SYN,RST SYN \
    -m tcpmss --mss "${min_match}:65535" \
    -j TCPMSS --set-mss "${effective_mss}" >/dev/null 2>&1; then
    echo "Gagal memasang TCPMSS. Modul netfilter VPS mungkin tidak tersedia."
    return 1
  fi
  for parent in INPUT OUTPUT FORWARD; do
    iptables -w 10 -t mangle -I "${parent}" 1 -p tcp --tcp-flags SYN,RST SYN \
      -j SC1FORCR_MSS >/dev/null 2>&1 || true
  done
  fw_persist_rules
  echo "MSS compatibility aktif: ${effective_mss}."
}

set_network_ipv4_preference() {
  touch /etc/gai.conf
  sed -i '/^# BEGIN SC-1FORCR NETWORK COMPAT$/,/^# END SC-1FORCR NETWORK COMPAT$/d' /etc/gai.conf
  cat >> /etc/gai.conf <<'EOF'
# BEGIN SC-1FORCR NETWORK COMPAT
precedence ::1/128       50
precedence ::/0          40
precedence 2002::/16     30
precedence ::/96         20
precedence ::ffff:0:0/96  100
# END SC-1FORCR NETWORK COMPAT
EOF
}

clear_network_ipv4_preference() {
  [[ -f /etc/gai.conf ]] || return 0
  sed -i '/^# BEGIN SC-1FORCR NETWORK COMPAT$/,/^# END SC-1FORCR NETWORK COMPAT$/d' /etc/gai.conf
}

patch_xray_outbound_strategy() {
  local strategy="$1" cfg tmp
  command -v jq >/dev/null 2>&1 || return 0
  for cfg in /usr/local/etc/xray/config.json /etc/xray/config.json; do
    [[ -s "${cfg}" ]] || continue
    tmp="$(mktemp)"
    if jq --arg strategy "${strategy}" '
      .outbounds = ((.outbounds // []) | map(
        if ((.protocol // "") | ascii_downcase) == "freedom" then
          .settings = ((.settings // {}) + {domainStrategy: $strategy})
        else . end
      ))
    ' "${cfg}" > "${tmp}"; then
      install -m 644 "${tmp}" "${cfg}"
    fi
    rm -f "${tmp}"
  done
  return 0
}

save_network_mode() {
  update_sc_env_var "NETWORK_COMPAT_ENABLE" "${NETWORK_COMPAT_ENABLE}"
  update_sc_env_var "NETWORK_TCP_MSS" "${NETWORK_TCP_MSS}"
  update_sc_env_var "XRAY_OUTBOUND_DOMAIN_STRATEGY" "${XRAY_OUTBOUND_DOMAIN_STRATEGY}"
  update_app_env_var "NETWORK_COMPAT_ENABLE" "${NETWORK_COMPAT_ENABLE}"
  update_app_env_var "NETWORK_TCP_MSS" "${NETWORK_TCP_MSS}"
  update_app_env_var "XRAY_OUTBOUND_DOMAIN_STRATEGY" "${XRAY_OUTBOUND_DOMAIN_STRATEGY}"
}

restart_network_compat_services() {
  systemctl restart sc-1forcr-api >/dev/null 2>&1 || true
  sleep 2
  if ! systemctl restart xray >/dev/null 2>&1; then
    echo "Xray gagal restart. Cek: journalctl -u xray -n 50 --no-pager"
    return 1
  fi
  return 0
}

enable_network_compatibility() {
  local mss_in
  if prompt_input mss_in "MSS TCP [${NETWORK_TCP_MSS:-1360}]: "; then
    mss_in="$(echo "${mss_in:-${NETWORK_TCP_MSS:-1360}}" | tr -cd '0-9')"
  else
    return 1
  fi
  if [[ -z "${mss_in}" || "${mss_in}" -lt 536 || "${mss_in}" -gt 1460 ]]; then
    echo "MSS harus 536-1460."
    return 1
  fi

  NETWORK_COMPAT_ENABLE="1"
  NETWORK_TCP_MSS="${mss_in}"
  XRAY_OUTBOUND_DOMAIN_STRATEGY="UseIPv4"
  cat > /etc/sysctl.d/99-sc-1forcr-network.conf <<'EOF'
# Pulihkan koneksi TCP saat ICMP packet-too-big diblok oleh jaringan provider.
net.ipv4.tcp_mtu_probing=1
EOF
  sysctl -p /etc/sysctl.d/99-sc-1forcr-network.conf >/dev/null 2>&1 || true
  set_network_ipv4_preference
  apply_network_mss_rules || true
  patch_xray_outbound_strategy "${XRAY_OUTBOUND_DOMAIN_STRATEGY}"
  save_network_mode
  restart_network_compat_services || true
  echo "Mode kompatibilitas jaringan aktif (Xray IPv4, PMTU probing, MSS ${NETWORK_TCP_MSS})."
}

disable_network_compatibility() {
  NETWORK_COMPAT_ENABLE="0"
  XRAY_OUTBOUND_DOMAIN_STRATEGY="AsIs"
  clear_network_mss_rules
  fw_persist_rules
  clear_network_ipv4_preference
  rm -f /etc/sysctl.d/99-sc-1forcr-network.conf
  sysctl -w net.ipv4.tcp_mtu_probing=0 >/dev/null 2>&1 || true
  patch_xray_outbound_strategy "${XRAY_OUTBOUND_DOMAIN_STRATEGY}"
  save_network_mode
  restart_network_compat_services || true
  echo "Mode kompatibilitas nonaktif; pemilihan IPv4/IPv6 kembali otomatis."
}

network_http_probe() {
  local family="$1" label="$2" url="$3" result
  if result="$(curl "-${family}" -LsS -o /dev/null --connect-timeout 5 --max-time 12 \
    -w '%{http_code} %{time_total}s' "${url}" 2>/dev/null)"; then
    echo "- ${label}: OK (${result})"
  else
    echo "- ${label}: GAGAL"
  fi
}

show_network_diagnostics() {
  local iface mtu dns4 dns6 strategy
  iface="$(ip -4 route show default 2>/dev/null | awk 'NR==1 {print $5}')"
  mtu="-"
  [[ -n "${iface}" && -r "/sys/class/net/${iface}/mtu" ]] && mtu="$(cat "/sys/class/net/${iface}/mtu")"
  dns4="$(getent ahostsv4 www.youtube.com 2>/dev/null | awk 'NR==1 {print $1}' || true)"
  dns6="$(getent ahostsv6 www.youtube.com 2>/dev/null | awk 'NR==1 {print $1}' || true)"
  strategy="$(jq -r '[.outbounds[]? | select(((.protocol // "") | ascii_downcase) == "freedom") | (.settings.domainStrategy // "AsIs")][0] // "tidak ditemukan"' /usr/local/etc/xray/config.json 2>/dev/null || true)"

  echo "=== DIAGNOSA JARINGAN ==="
  echo "- Default route : $(ip -4 route show default 2>/dev/null | head -n1 || true)"
  echo "- Interface/MTU : ${iface:--}/${mtu}"
  echo "- DNS YouTube   : IPv4=${dns4:--} IPv6=${dns6:--}"
  echo "- TCP MTU probe : $(sysctl -n net.ipv4.tcp_mtu_probing 2>/dev/null || echo '-')"
  echo "- Xray strategy : ${strategy:--}"
  if command -v iptables >/dev/null 2>&1 && iptables -w 10 -t mangle -S SC1FORCR_MSS >/dev/null 2>&1; then
    echo "- MSS rule      : aktif ($(network_effective_tcp_mss))"
  else
    echo "- MSS rule      : nonaktif"
  fi
  network_http_probe 4 "YouTube IPv4" "https://www.youtube.com/generate_204"
  network_http_probe 4 "Cloudflare IPv4" "https://1.1.1.1/cdn-cgi/trace"
  if ip -6 route show default 2>/dev/null | grep -q .; then
    network_http_probe 6 "YouTube IPv6" "https://www.youtube.com/generate_204"
  else
    echo "- IPv6 route    : tidak tersedia"
  fi
}

network_compatibility_menu() {
  local nm
  while true; do
    clear
    draw_menu_panel "ROUTING JARINGAN" \
      "1) Diagnosa koneksi" \
      "2) Repair mode kompatibilitas" \
      "3) Kembali ke dual-stack otomatis" \
      "0) Kembali"
    echo
    if ! prompt_input nm "Pilih menu [0-3]: "; then
      return
    fi
    clear
    case "${nm}" in
      1) show_network_diagnostics | ui_fx ;;
      2) enable_network_compatibility ;;
      3) disable_network_compatibility ;;
      0) return ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    echo
    menu_pause
  done
}

ensure_sshws_firewall_allow_rules() {
  if command -v iptables >/dev/null 2>&1; then
    iptables -w 10 -C INPUT -i lo -j ACCEPT >/dev/null 2>&1 || iptables -w 10 -I INPUT -i lo -j ACCEPT
    iptables -w 10 -C INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT >/dev/null 2>&1 || \
      iptables -w 10 -I INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -w 10 -C INPUT -p tcp -m multiport --dports 80,443,109,143 -j ACCEPT >/dev/null 2>&1 || \
      iptables -w 10 -I INPUT -p tcp -m multiport --dports 80,443,109,143 -j ACCEPT
  fi
  fw_persist_rules
}

get_hc_auth_lookback_hours() {
  local v
  v="$(echo "${SSH_HC_AUTH_LOOKBACK_HOURS:-6}" | tr -cd '0-9')"
  [[ -z "${v}" || "${v}" -lt 1 || "${v}" -gt 48 ]] && v="6"
  echo "${v}"
}

normalize_xray_paths_csv() {
  local raw fallback p normalized out
  raw="${1:-}"
  fallback="${2:-/}"
  out=""
  IFS=',' read -ra __xray_paths <<< "${raw}"
  for p in "${__xray_paths[@]}"; do
    normalized="$(echo "${p}" | tr -d '\r' | xargs)"
    [[ -z "${normalized}" ]] && continue
    [[ "${normalized}" != /* ]] && normalized="/${normalized}"
    normalized="/$(echo "${normalized}" | sed -E 's#^/+##; s#/+#/#g')"
    if [[ -z "${out}" ]]; then
      out="${normalized}"
    elif [[ ",${out}," != *",${normalized},"* ]]; then
      out="${out},${normalized}"
    fi
  done
  if [[ -z "${out}" ]]; then
    normalized="$(echo "${fallback}" | tr -d '\r' | xargs)"
    [[ -z "${normalized}" ]] && normalized="/"
    [[ "${normalized}" != /* ]] && normalized="/${normalized}"
    normalized="/$(echo "${normalized}" | sed -E 's#^/+##; s#/+#/#g')"
    out="${normalized}"
  fi
  echo "${out}"
}
build_nginx_ws_locations() {
  local paths_csv backend canonical path out
  paths_csv="${1:-}"
  backend="${2:-}"
  canonical="${3:-}"
  out=""
  [[ -z "${backend}" || -z "${canonical}" ]] && return 0
  IFS=',' read -ra __ws_paths <<< "${paths_csv}"
  for path in "${__ws_paths[@]}"; do
    path="$(echo "${path}" | xargs)"
    [[ -z "${path}" ]] && continue
    out+=$'    location '"${path}"$' {\n'
    out+=$'        access_log off;\n'
    out+=$'        proxy_redirect off;\n'
    if [[ "${path}" != "${canonical}" ]]; then
      out+=$'        rewrite ^ '"${canonical}"$' break;\n'
    fi
    out+=$'        proxy_pass http://127.0.0.1:'"${backend}"$';\n'
    out+=$'        proxy_http_version 1.1;\n'
    out+=$'        proxy_method GET;\n'
    out+=$'        proxy_set_header Upgrade "websocket";\n'
    out+=$'        proxy_set_header Connection "Upgrade";\n'
    out+=$'        proxy_set_header Host \\$host;\n'
    out+=$'        proxy_read_timeout 3600s;\n'
    out+=$'        proxy_send_timeout 3600s;\n'
    out+=$'        proxy_connect_timeout 60s;\n'
    out+=$'        proxy_buffering off;\n'
    out+=$'    }\n\n'
  done
  printf '%s' "${out}"
}
XRAY_PATHS_VMESS="$(normalize_xray_paths_csv "${XRAY_PATHS_VMESS:-/vmess}" "/vmess")"
XRAY_PATHS_VLESS="$(normalize_xray_paths_csv "${XRAY_PATHS_VLESS:-/vless}" "/vless")"
XRAY_PATHS_TROJAN="$(normalize_xray_paths_csv "${XRAY_PATHS_TROJAN:-/trojan}" "/trojan")"

api_call() {
  local method="$1" path="$2" data="${3:-}"
  if [[ -n "${data}" ]]; then
    curl -sS -X "${method}" "${API_BASE}${path}" \
      -H "Authorization: ${AUTH_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${data}"
  else
    curl -sS -X "${method}" "${API_BASE}${path}" \
      -H "Authorization: ${AUTH_TOKEN}"
  fi
}

telegram_notify() {
  local text="$1" resp
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" || -z "${text:-}" ]] && return 1
  resp="$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "disable_web_page_preview=true" \
    --data-urlencode "text=${text}" 2>/dev/null || true)"
  [[ -z "${resp}" ]] && return 1
  echo "${resp}" | jq -e '.ok == true' >/dev/null 2>&1
}

# Susunan sama dengan notifikasi API: judul, garis, baris isi, garis, lalu
# domain + waktu WIB. Pakai: telegram_notify_box "JUDUL" "Label    : nilai" ...
telegram_notify_box() {
  local title="$1" rule="━━━━━━━━━━━━━━━━━━━━━━" body="" line
  shift
  for line in "$@"; do
    if [[ -n "${line}" ]]; then
      body+="${line}"$'\n'
    fi
  done
  telegram_notify "${title}
${rule}
${body}${rule}
SC 1FORCR • ${DOMAIN:--}
$(TZ=Asia/Jakarta date '+%d-%m-%Y %H:%M WIB')"
}

telegram_notify_action() {
  local action="$1" type="$2" username="$3" title
  case "${action}" in
    LOCK) title="AKUN DIKUNCI" ;;
    UNLOCK) title="AKUN DIBUKA" ;;
    CHANGE_PASSWORD) title="PASSWORD AKUN DIGANTI" ;;
    *) title="AKUN ${action}" ;;
  esac
  telegram_notify_box "${title}" \
    "Layanan  : $(printf '%s' "${type}" | tr '[:lower:]' '[:upper:]')" \
    "Username : ${username}" \
    "Oleh     : Menu VPS"
}

cancelled() {
  echo
  echo "Dibatalkan. Kembali ke menu sebelumnya."
}

prompt_input() {
  local var_name="$1" prompt="$2"
  # Prompt polos diberi gaya menu; prompt yang sudah berwarna dibiarkan.
  if [[ "${prompt}" != *$'\033'* ]] && declare -F ui_init >/dev/null 2>&1; then
    if [[ -z "${UI_MODE:-}" ]]; then ui_init; fi
    prompt=" ${UI_ACC2}◆${UI_NC} ${UI_VAL}${prompt}${UI_NC}"
  fi
  if ! read -rp "${prompt}" "${var_name}" </dev/tty; then
    cancelled
    return 130
  fi
  return 0
}

# Jeda "Enter untuk lanjut" dengan gaya prompt menu. Tetap membaca stdin
# seperti read -rp sebelumnya.
menu_pause() {
  local msg="${1:-Enter untuk lanjut...}"
  if [[ -z "${UI_MODE:-}" ]] && declare -F ui_init >/dev/null 2>&1; then ui_init; fi
  read -rp " ${UI_ACC2:-}◆${UI_NC:-} ${UI_MUTED:-}${msg}${UI_NC:-}" _ || true
  return 0
}

# Satu baris "Label        : nilai" lewat echo, jadi ikut gaya menu.
menu_kv() {
  local line
  printf -v line '%-12s : %s' "${1:-}" "${2:-}"
  echo "${line}"
}

mask_secret() {
  local s="$1" n
  n="${#s}"
  if [[ -z "${s}" ]]; then
    echo "-"
    return
  fi
  if [[ "${n}" -le 8 ]]; then
    echo "****"
    return
  fi
  echo "${s:0:4}****${s:n-4:4}"
}

update_sc_env_var() {
  local key="$1" value="$2" tmp
  sanitize_env_file /etc/sc-1forcr.env
  tmp="$(mktemp)"
  awk -v k="${key}" -v v="${value}" '
    BEGIN { done=0 }
    $0 ~ ("^" k "=") { print k "=" v; done=1; next }
    { print }
    END { if (!done) print k "=" v }
  ' /etc/sc-1forcr.env > "${tmp}" && mv -f "${tmp}" /etc/sc-1forcr.env
  chmod 600 /etc/sc-1forcr.env
}

update_app_env_var() {
  local key="$1" value="$2" app_env tmp
  app_env="/opt/sc-1forcr/.env"
  if [[ ! -f "${app_env}" ]]; then
    app_env="/opt/potato-compat/.env"
  fi
  if [[ ! -f "${app_env}" ]]; then
    return 0
  fi
  sanitize_env_file "${app_env}"
  tmp="$(mktemp)"
  awk -v k="${key}" -v v="${value}" '
    BEGIN { done=0 }
    $0 ~ ("^" k "=") { print k "=" v; done=1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "${app_env}" > "${tmp}" && mv -f "${tmp}" "${app_env}"
}

write_iplimit_timer_unit() {
  local interval="$1"
  cat > /etc/systemd/system/sc-1forcr-iplimit.timer <<EOF
[Unit]
Description=Run SC 1FORCR IP Limit Checker every ${interval} minutes

[Timer]
OnActiveSec=15s
OnUnitInactiveSec=${interval}min
AccuracySec=1s
RandomizedDelaySec=0
Persistent=false
Unit=sc-1forcr-iplimit.service

[Install]
WantedBy=timers.target
EOF
}

write_online_notify_timer_unit() {
  local interval_h="$1"
  cat > /etc/systemd/system/sc-1forcr-online-notify.timer <<EOF
[Unit]
Description=Check SC 1FORCR online account notifier every 15 minutes (report every ${interval_h} hours)

[Timer]
# Timer hanya memeriksa; jadwal kirim dijaga script lewat stempel kirim terakhir.
# OnBootSec menjamin cek pertama setelah reboot walau ada daemon-reload.
OnBootSec=10min
OnActiveSec=10min
OnUnitInactiveSec=15min
AccuracySec=1min
RandomizedDelaySec=0
Persistent=false
Unit=sc-1forcr-online-notify.service

[Install]
WantedBy=timers.target
EOF
}

menu_auto_backup_initial_delay_seconds() {
  local interval_min="${1:-1440}" interval_sec now_epoch last_epoch delta remaining
  interval_min="$(printf '%s' "${interval_min}" | tr -cd '0-9')"
  [[ -z "${interval_min}" || "${interval_min}" -lt 1 ]] && interval_min="1440"
  interval_sec="$(( interval_min * 60 ))"
  now_epoch="$(date +%s)"
  last_epoch="$(cat /var/lib/sc-1forcr/last-auto-backup-epoch 2>/dev/null || true)"
  remaining="300"
  if [[ "${last_epoch}" =~ ^[0-9]+$ ]]; then
    delta="$(( now_epoch - last_epoch ))"
    if (( delta >= 0 && delta < interval_sec )); then
      remaining="$(( interval_sec - delta ))"
    else
      remaining="60"
    fi
  fi
  (( remaining < 60 )) && remaining="60"
  (( remaining > interval_sec )) && remaining="${interval_sec}"
  printf '%s\n' "${remaining}"
}

# SubState timer yang sehat. Menu adalah file mandiri, jadi helper ini harus
# didefinisikan di sini (tidak mewarisi timer_substate_ok dari installer utama).
timer_substate_ok() {
  case "${1:-}" in
    waiting|running|elapsed) return 0 ;;
    *) return 1 ;;
  esac
}

menu_ensure_auto_backup_timer_armed() {
  local attempt timer_state
  systemctl enable sc-1forcr-autobackup.timer >/dev/null 2>&1 || {
    echo "Gagal enable timer auto-backup."
    return 1
  }
  systemctl restart sc-1forcr-autobackup.timer >/dev/null 2>&1 || {
    echo "Gagal me-restart timer auto-backup."
    return 1
  }
  for attempt in 1 2 3 4 5; do
    timer_state="$(systemctl show sc-1forcr-autobackup.timer -p SubState --value 2>/dev/null || true)"
    if systemctl is-active --quiet sc-1forcr-autobackup.timer && \
       timer_substate_ok "${timer_state}"; then
      return 0
    fi
    sleep 1
  done
  echo "Timer auto-backup tidak terjadwal (state=${timer_state:-unknown})."
  return 1
}

write_auto_backup_timer_unit() {
  local mode_raw="$1"
  local interval_min="$2"
  local wib_hour="$3"
  local mode initial_delay_sec
  mode="$(echo "${mode_raw:-interval}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [[ "${mode}" == "daily" || "${mode}" == "wib" ]]; then
    mode="daily_wib"
  fi
  if [[ "${mode}" != "daily_wib" ]]; then
    mode="interval"
  fi
  interval_min="$(echo "${interval_min:-1440}" | tr -cd '0-9')"
  [[ -z "${interval_min}" || "${interval_min}" -lt 1 || "${interval_min}" -gt 10080 ]] && interval_min="1440"
  wib_hour="$(echo "${wib_hour:-2}" | tr -cd '0-9')"
  [[ -z "${wib_hour}" || "${wib_hour}" -lt 0 || "${wib_hour}" -gt 23 ]] && wib_hour="2"
  initial_delay_sec="$(menu_auto_backup_initial_delay_seconds "${interval_min}")"

  if [[ "${mode}" == "daily_wib" ]]; then
    cat > /etc/systemd/system/sc-1forcr-autobackup.timer <<EOF
[Unit]
Description=Run SC 1FORCR auto backup daily at $(printf '%02d' "${wib_hour}"):00 WIB

[Timer]
OnCalendar=hourly
AccuracySec=1min
Persistent=true
RandomizedDelaySec=0
Unit=sc-1forcr-autobackup.service

[Install]
WantedBy=timers.target
EOF
    return
  fi

  cat > /etc/systemd/system/sc-1forcr-autobackup.timer <<EOF
[Unit]
Description=Run SC 1FORCR auto backup every ${interval_min} minutes

[Timer]
OnActiveSec=${initial_delay_sec}s
OnUnitInactiveSec=${interval_min}min
AccuracySec=1s
Persistent=false
RandomizedDelaySec=30s
Unit=sc-1forcr-autobackup.service

[Install]
WantedBy=timers.target
EOF
}

write_auto_reboot_timer_unit() {
  local interval_min="${1:-1440}" mode="${2:-${AUTO_REBOOT_SCHEDULE_MODE:-interval}}" wib_hour="${3:-${AUTO_REBOOT_WIB_HOUR:-3}}"
  interval_min="$(echo "${interval_min:-1440}" | tr -cd '0-9')"
  [[ -z "${interval_min}" || "${interval_min}" -lt 30 || "${interval_min}" -gt 10080 ]] && interval_min="1440"
  mode="$(echo "${mode:-interval}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "${mode}" in
    daily|daily_wib|wib) mode="daily_wib" ;;
    *) mode="interval" ;;
  esac
  wib_hour="$(echo "${wib_hour:-3}" | tr -cd '0-9')"
  [[ -n "${wib_hour}" ]] && wib_hour="$((10#${wib_hour}))"
  [[ -z "${wib_hour}" || "${wib_hour}" -gt 23 ]] && wib_hour="3"

  if [[ "${mode}" == "daily_wib" ]]; then
    cat > /etc/systemd/system/sc-1forcr-autoreboot.timer <<EOF
[Unit]
Description=Run SC 1FORCR auto reboot daily at $(printf '%02d' "${wib_hour}"):00 WIB

[Timer]
OnCalendar=hourly
Persistent=true
AccuracySec=1min
RandomizedDelaySec=30s
Unit=sc-1forcr-autoreboot.service

[Install]
WantedBy=timers.target
EOF
    return
  fi

  cat > /etc/systemd/system/sc-1forcr-autoreboot.timer <<EOF
[Unit]
Description=Run SC 1FORCR auto reboot every ${interval_min} minutes

[Timer]
OnActiveSec=${interval_min}min
OnUnitInactiveSec=${interval_min}min
Persistent=false
AccuracySec=1min
Unit=sc-1forcr-autoreboot.service

[Install]
WantedBy=timers.target
EOF
}

write_pull_update_timer_unit() {
  local interval_min="$1"
  interval_min="$(echo "${interval_min:-360}" | tr -cd '0-9')"
  [[ -z "${interval_min}" || "${interval_min}" -lt 1 || "${interval_min}" -gt 1440 ]] && interval_min="360"
  cat > /etc/systemd/system/sc-1forcr-pull-update.timer <<EOF
[Unit]
Description=Check SC 1FORCR update trigger every ${interval_min} minutes

[Timer]
OnActiveSec=3m
OnUnitInactiveSec=${interval_min}min
AccuracySec=30s
Persistent=false
RandomizedDelaySec=30s
Unit=sc-1forcr-pull-update.service

[Install]
WantedBy=timers.target
EOF
  cat > /etc/systemd/system/sc-1forcr-pull-summary-update.timer <<EOF
[Unit]
Description=Check SC 1FORCR Summary API update trigger every ${interval_min} minutes

[Timer]
OnActiveSec=4m
OnUnitInactiveSec=${interval_min}min
AccuracySec=30s
Persistent=false
RandomizedDelaySec=45s
Unit=sc-1forcr-pull-summary-update.service

[Install]
WantedBy=timers.target
EOF
}

set_auto_reboot_config_menu() {
  local current_enable current_interval current_hours current_mode current_wib_hour enable_in mode_in val_in interval_min wib_hour_in
  current_enable="${AUTO_REBOOT_ENABLE:-0}"
  [[ "${current_enable}" != "0" ]] && current_enable="1"
  current_interval="$(echo "${AUTO_REBOOT_INTERVAL_MINUTES:-1440}" | tr -cd '0-9')"
  [[ -z "${current_interval}" || "${current_interval}" -lt 30 || "${current_interval}" -gt 10080 ]] && current_interval="1440"
  current_hours="$(awk -v m="${current_interval}" 'BEGIN { printf "%.2f", (m/60) }')"
  current_mode="$(echo "${AUTO_REBOOT_SCHEDULE_MODE:-interval}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "${current_mode}" in
    daily|daily_wib|wib) current_mode="daily_wib" ;;
    *) current_mode="interval" ;;
  esac
  current_wib_hour="$(echo "${AUTO_REBOOT_WIB_HOUR:-3}" | tr -cd '0-9')"
  [[ -n "${current_wib_hour}" ]] && current_wib_hour="$((10#${current_wib_hour}))"
  [[ -z "${current_wib_hour}" || "${current_wib_hour}" -gt 23 ]] && current_wib_hour="3"

  draw_menu_header "SETTING AUTO REBOOT"
  echo "Status saat ini   : $([[ "${current_enable}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  if [[ "${current_mode}" == "daily_wib" ]]; then
    echo "Jadwal saat ini   : harian jam $(printf '%02d' "${current_wib_hour}"):00 WIB"
  else
    echo "Jadwal saat ini   : interval ${current_interval} menit (~${current_hours} jam)"
  fi
  echo
  echo "Kosongkan input untuk mempertahankan nilai lama."
  echo "Ketik 'batal' untuk kembali."

  if ! prompt_input enable_in "Aktifkan auto reboot? (1=aktif,0=nonaktif) [${current_enable}]: "; then
    return
  fi
  [[ "${enable_in,,}" == "batal" ]] && return
  enable_in="${enable_in:-${current_enable}}"
  case "${enable_in,,}" in
    1|on|yes|y) enable_in="1" ;;
    0|off|no|n) enable_in="0" ;;
    *)
      echo "Input status tidak valid. Gunakan 1 atau 0."
      return
      ;;
  esac

  if ! prompt_input mode_in "Mode jadwal (i=interval,d=harian WIB) [${current_mode}]: "; then
    return
  fi
  [[ "${mode_in,,}" == "batal" ]] && return
  mode_in="${mode_in:-${current_mode}}"
  case "${mode_in,,}" in
    i|interval) mode_in="interval" ;;
    d|daily|daily_wib|wib|harian) mode_in="daily_wib" ;;
    *)
      echo "Mode jadwal tidak valid. Gunakan i atau d."
      return
      ;;
  esac

  interval_min="${current_interval}"
  wib_hour_in="${current_wib_hour}"
  if [[ "${mode_in}" == "daily_wib" ]]; then
    if ! prompt_input wib_hour_in "Jam reboot WIB (0-23) [${current_wib_hour}]: "; then
      return
    fi
    [[ "${wib_hour_in,,}" == "batal" ]] && return
    wib_hour_in="${wib_hour_in:-${current_wib_hour}}"
    if [[ ! "${wib_hour_in}" =~ ^[0-9]+$ ]]; then
      echo "Jam WIB harus angka 0-23."
      return
    fi
    wib_hour_in="$((10#${wib_hour_in}))"
    if [[ "${wib_hour_in}" -gt 23 ]]; then
      echo "Jam WIB harus angka 0-23."
      return
    fi
  else
    if ! prompt_input val_in "Set interval dalam (m=menit, h=jam) [m]: "; then
      return
    fi
    [[ "${val_in,,}" == "batal" ]] && return
    val_in="${val_in:-m}"
    case "${val_in,,}" in
      m|menit) val_in="m" ;;
      h|jam) val_in="h" ;;
      *)
        echo "Mode interval tidak valid. Gunakan m atau h."
        return
        ;;
    esac

    if [[ "${val_in}" == "m" ]]; then
      if ! prompt_input interval_min "Interval reboot (menit, min 30) [${current_interval}]: "; then
        return
      fi
      [[ "${interval_min,,}" == "batal" ]] && return
      interval_min="${interval_min:-${current_interval}}"
      if [[ ! "${interval_min}" =~ ^[0-9]+$ || "${interval_min}" -lt 30 || "${interval_min}" -gt 10080 ]]; then
        echo "Interval menit harus angka 30-10080."
        return
      fi
    else
      if ! prompt_input val_in "Interval reboot (jam) [24]: "; then
        return
      fi
      [[ "${val_in,,}" == "batal" ]] && return
      val_in="${val_in:-24}"
      if [[ ! "${val_in}" =~ ^[0-9]+$ || "${val_in}" -lt 1 || "${val_in}" -gt 168 ]]; then
        echo "Interval jam harus angka 1-168."
        return
      fi
      interval_min="$(( val_in * 60 ))"
    fi
  fi

  AUTO_REBOOT_ENABLE="${enable_in}"
  AUTO_REBOOT_INTERVAL_MINUTES="${interval_min}"
  AUTO_REBOOT_SCHEDULE_MODE="${mode_in}"
  AUTO_REBOOT_WIB_HOUR="${wib_hour_in}"
  update_sc_env_var "AUTO_REBOOT_ENABLE" "${AUTO_REBOOT_ENABLE}"
  update_sc_env_var "AUTO_REBOOT_INTERVAL_MINUTES" "${AUTO_REBOOT_INTERVAL_MINUTES}"
  update_sc_env_var "AUTO_REBOOT_SCHEDULE_MODE" "${AUTO_REBOOT_SCHEDULE_MODE}"
  update_sc_env_var "AUTO_REBOOT_WIB_HOUR" "${AUTO_REBOOT_WIB_HOUR}"
  update_app_env_var "AUTO_REBOOT_ENABLE" "${AUTO_REBOOT_ENABLE}"
  update_app_env_var "AUTO_REBOOT_INTERVAL_MINUTES" "${AUTO_REBOOT_INTERVAL_MINUTES}"
  update_app_env_var "AUTO_REBOOT_SCHEDULE_MODE" "${AUTO_REBOOT_SCHEDULE_MODE}"
  update_app_env_var "AUTO_REBOOT_WIB_HOUR" "${AUTO_REBOOT_WIB_HOUR}"

  write_auto_reboot_timer_unit "${AUTO_REBOOT_INTERVAL_MINUTES}" "${AUTO_REBOOT_SCHEDULE_MODE}" "${AUTO_REBOOT_WIB_HOUR}"
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ "${AUTO_REBOOT_ENABLE}" == "1" ]]; then
    systemctl enable --now sc-1forcr-autoreboot.timer >/dev/null 2>&1 || true
    systemctl restart sc-1forcr-autoreboot.timer >/dev/null 2>&1 || true
  else
    systemctl disable --now sc-1forcr-autoreboot.timer >/dev/null 2>&1 || true
  fi

  echo
  echo "Berhasil update auto reboot:"
  echo "- Status   : $([[ "${AUTO_REBOOT_ENABLE}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  if [[ "${AUTO_REBOOT_SCHEDULE_MODE}" == "daily_wib" ]]; then
    echo "- Jadwal   : harian jam $(printf '%02d' "${AUTO_REBOOT_WIB_HOUR}"):00 WIB"
  else
    echo "- Jadwal   : interval ${AUTO_REBOOT_INTERVAL_MINUTES} menit"
  fi
}

set_auto_pull_update_config_menu() {
  local current_enable current_interval current_hours current_cooldown enable_in mode_in val_in interval_min cooldown_in cooldown_min
  current_enable="${AUTO_PULL_UPDATE_ENABLE:-1}"
  [[ "${current_enable}" != "0" ]] && current_enable="1"
  current_interval="$(echo "${AUTO_PULL_UPDATE_INTERVAL_MINUTES:-360}" | tr -cd '0-9')"
  [[ -z "${current_interval}" || "${current_interval}" -lt 1 || "${current_interval}" -gt 1440 ]] && current_interval="360"
  current_hours="$(awk -v m="${current_interval}" 'BEGIN { printf "%.2f", (m/60) }')"
  current_cooldown="$(echo "${AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES:-360}" | tr -cd '0-9')"
  [[ -z "${current_cooldown}" || "${current_cooldown}" -lt 10 || "${current_cooldown}" -gt 10080 ]] && current_cooldown="360"

  draw_menu_header "SETTING AUTO UPDATE BOT"
  echo "Status saat ini   : $([[ "${current_enable}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  echo "Interval saat ini : ${current_interval} menit (~${current_hours} jam)"
  echo "Cooldown gagal    : ${current_cooldown} menit"
  echo
  echo "Jika NONAKTIF, VPS ini tidak akan menjalankan update saat admin trigger dari bot."
  echo "Update dari bot memakai mode aman: service SSHWS/Xray aktif tidak direstart penuh."
  echo "Cooldown mencegah retry versi gagal terus-menerus yang bisa memutus tunnel."
  echo "Update manual dari menu tetap bisa dijalankan."
  echo
  echo "Kosongkan input untuk mempertahankan nilai lama."
  echo "Ketik 'batal' untuk kembali."

  if ! prompt_input enable_in "Aktifkan auto update dari bot? (1=aktif,0=nonaktif) [${current_enable}]: "; then
    return
  fi
  [[ "${enable_in,,}" == "batal" ]] && return
  enable_in="${enable_in:-${current_enable}}"
  case "${enable_in,,}" in
    1|on|yes|y|aktif) enable_in="1" ;;
    0|off|no|n|nonaktif) enable_in="0" ;;
    *)
      echo "Input status tidak valid. Gunakan 1 atau 0."
      return
      ;;
  esac

  if ! prompt_input mode_in "Set interval dalam (m=menit, h=jam) [m]: "; then
    return
  fi
  [[ "${mode_in,,}" == "batal" ]] && return
  mode_in="${mode_in:-m}"
  case "${mode_in,,}" in
    m|menit) mode_in="m" ;;
    h|jam) mode_in="h" ;;
    *)
      echo "Mode interval tidak valid. Gunakan m atau h."
      return
      ;;
  esac

  if [[ "${mode_in}" == "m" ]]; then
    if ! prompt_input val_in "Interval cek trigger (menit, 1-1440) [${current_interval}]: "; then
      return
    fi
    [[ "${val_in,,}" == "batal" ]] && return
    val_in="${val_in:-${current_interval}}"
    if [[ ! "${val_in}" =~ ^[0-9]+$ || "${val_in}" -lt 1 || "${val_in}" -gt 1440 ]]; then
      echo "Interval menit harus angka 1-1440."
      return
    fi
    interval_min="${val_in}"
  else
    if ! prompt_input val_in "Interval cek trigger (jam, 1-24) [1]: "; then
      return
    fi
    [[ "${val_in,,}" == "batal" ]] && return
    val_in="${val_in:-1}"
    if [[ ! "${val_in}" =~ ^[0-9]+$ || "${val_in}" -lt 1 || "${val_in}" -gt 24 ]]; then
      echo "Interval jam harus angka 1-24."
      return
    fi
    interval_min="$(( val_in * 60 ))"
  fi

  if ! prompt_input cooldown_in "Cooldown retry jika update gagal (menit, 10-10080) [${current_cooldown}]: "; then
    return
  fi
  [[ "${cooldown_in,,}" == "batal" ]] && return
  cooldown_in="${cooldown_in:-${current_cooldown}}"
  if [[ ! "${cooldown_in}" =~ ^[0-9]+$ || "${cooldown_in}" -lt 10 || "${cooldown_in}" -gt 10080 ]]; then
    echo "Cooldown harus angka 10-10080 menit."
    return
  fi
  cooldown_min="${cooldown_in}"

  AUTO_PULL_UPDATE_ENABLE="${enable_in}"
  AUTO_PULL_UPDATE_INTERVAL_MINUTES="${interval_min}"
  AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES="${cooldown_min}"
  update_sc_env_var "AUTO_PULL_UPDATE_ENABLE" "${AUTO_PULL_UPDATE_ENABLE}"
  update_sc_env_var "AUTO_PULL_UPDATE_INTERVAL_MINUTES" "${AUTO_PULL_UPDATE_INTERVAL_MINUTES}"
  update_sc_env_var "AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES" "${AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES}"
  update_app_env_var "AUTO_PULL_UPDATE_ENABLE" "${AUTO_PULL_UPDATE_ENABLE}"
  update_app_env_var "AUTO_PULL_UPDATE_INTERVAL_MINUTES" "${AUTO_PULL_UPDATE_INTERVAL_MINUTES}"
  update_app_env_var "AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES" "${AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES}"

  if [[ -f /etc/systemd/system/sc-1forcr-pull-update.service ]]; then
    write_pull_update_timer_unit "${AUTO_PULL_UPDATE_INTERVAL_MINUTES}"
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ "${AUTO_PULL_UPDATE_ENABLE}" == "1" ]]; then
      systemctl enable --now sc-1forcr-pull-update.timer >/dev/null 2>&1 || true
      systemctl restart sc-1forcr-pull-update.timer >/dev/null 2>&1 || true
      if [[ -f /etc/systemd/system/sc-1forcr-pull-summary-update.service ]]; then
        systemctl enable --now sc-1forcr-pull-summary-update.timer >/dev/null 2>&1 || true
        systemctl restart sc-1forcr-pull-summary-update.timer >/dev/null 2>&1 || true
      fi
    else
      systemctl disable --now sc-1forcr-pull-update.timer >/dev/null 2>&1 || true
      systemctl stop sc-1forcr-pull-update.service >/dev/null 2>&1 || true
      systemctl disable --now sc-1forcr-pull-summary-update.timer >/dev/null 2>&1 || true
      systemctl stop sc-1forcr-pull-summary-update.service >/dev/null 2>&1 || true
    fi
  else
    echo
    echo "Service sc-1forcr-pull-update belum tersedia. Jalankan update script terbaru dulu."
  fi

  echo
  echo "Berhasil update auto update bot:"
  echo "- Status   : $([[ "${AUTO_PULL_UPDATE_ENABLE}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  echo "- Interval : ${AUTO_PULL_UPDATE_INTERVAL_MINUTES} menit"
  echo "- Cooldown : ${AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES} menit"
}

set_auto_backup_config_menu() {
  local current_enable current_interval current_hours enable_in mode_in val_in interval_min
  local current_sched current_wib_hour chosen_sched
  current_enable="${AUTO_BACKUP_ENABLE:-1}"
  [[ "${current_enable}" != "0" ]] && current_enable="1"
  current_interval="$(echo "${AUTO_BACKUP_INTERVAL_MINUTES:-1440}" | tr -cd '0-9')"
  [[ -z "${current_interval}" || "${current_interval}" -lt 1 || "${current_interval}" -gt 10080 ]] && current_interval="1440"
  current_hours="$(awk -v m="${current_interval}" 'BEGIN { printf "%.2f", (m/60) }')"
  current_sched="$(echo "${AUTO_BACKUP_SCHEDULE_MODE:-interval}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [[ "${current_sched}" == "daily" || "${current_sched}" == "wib" ]]; then
    current_sched="daily_wib"
  fi
  [[ "${current_sched}" != "daily_wib" ]] && current_sched="interval"
  current_wib_hour="$(echo "${AUTO_BACKUP_WIB_HOUR:-2}" | tr -cd '0-9')"
  [[ -z "${current_wib_hour}" || "${current_wib_hour}" -lt 0 || "${current_wib_hour}" -gt 23 ]] && current_wib_hour="2"

  draw_menu_header "SETTING AUTO BACKUP"
  echo "Status saat ini   : $([[ "${current_enable}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  if [[ "${current_sched}" == "daily_wib" ]]; then
    echo "Mode saat ini     : Harian WIB jam $(printf '%02d' "${current_wib_hour}"):00"
  else
    echo "Mode saat ini     : Interval"
    echo "Interval saat ini : ${current_interval} menit (~${current_hours} jam)"
  fi
  echo "Retensi file      : ${AUTO_BACKUP_KEEP_DAYS:-7} hari"
  echo
  echo "Kosongkan input untuk mempertahankan nilai lama."
  echo "Ketik 'batal' untuk kembali."

  if ! prompt_input enable_in "Aktifkan auto backup? (1=aktif,0=nonaktif) [${current_enable}]: "; then
    return
  fi
  [[ "${enable_in,,}" == "batal" ]] && return
  enable_in="${enable_in:-${current_enable}}"
  case "${enable_in,,}" in
    1|on|yes|y) enable_in="1" ;;
    0|off|no|n) enable_in="0" ;;
    *)
      echo "Input status tidak valid. Gunakan 1 atau 0."
      return
      ;;
  esac

  if ! prompt_input mode_in "Mode jadwal backup (1=interval,2=harian WIB) [$([[ "${current_sched}" == "daily_wib" ]] && echo 2 || echo 1)]: "; then
    return
  fi
  [[ "${mode_in,,}" == "batal" ]] && return
  mode_in="${mode_in:-$([[ "${current_sched}" == "daily_wib" ]] && echo 2 || echo 1)}"
  case "${mode_in,,}" in
    1|interval|m|menit|h|jam) chosen_sched="interval" ;;
    2|harian|daily|wib) chosen_sched="daily_wib" ;;
    *)
      echo "Mode tidak valid. Gunakan 1 (interval) atau 2 (harian WIB)."
      return
      ;;
  esac

  if [[ "${chosen_sched}" == "daily_wib" ]]; then
    if ! prompt_input val_in "Jam backup WIB (0-23) [${current_wib_hour}]: "; then
      return
    fi
    [[ "${val_in,,}" == "batal" ]] && return
    val_in="${val_in:-${current_wib_hour}}"
    if [[ ! "${val_in}" =~ ^[0-9]+$ || "${val_in}" -lt 0 || "${val_in}" -gt 23 ]]; then
      echo "Jam WIB harus angka 0-23."
      return
    fi
    AUTO_BACKUP_WIB_HOUR="${val_in}"
    AUTO_BACKUP_INTERVAL_MINUTES="${current_interval}"
  else
    if ! prompt_input mode_in "Set interval dalam (m=menit, h=jam) [m]: "; then
      return
    fi
    [[ "${mode_in,,}" == "batal" ]] && return
    mode_in="${mode_in:-m}"
    case "${mode_in,,}" in
      m|menit) mode_in="m" ;;
      h|jam) mode_in="h" ;;
      *)
        echo "Mode interval tidak valid. Gunakan m atau h."
        return
        ;;
    esac
    if [[ "${mode_in}" == "m" ]]; then
      if ! prompt_input val_in "Interval backup (menit) [${current_interval}]: "; then
        return
      fi
      [[ "${val_in,,}" == "batal" ]] && return
      val_in="${val_in:-${current_interval}}"
      if [[ ! "${val_in}" =~ ^[0-9]+$ || "${val_in}" -lt 1 || "${val_in}" -gt 10080 ]]; then
        echo "Interval menit harus angka 1-10080."
        return
      fi
      interval_min="${val_in}"
    else
      if ! prompt_input val_in "Interval backup (jam) [24]: "; then
        return
      fi
      [[ "${val_in,,}" == "batal" ]] && return
      val_in="${val_in:-24}"
      if [[ ! "${val_in}" =~ ^[0-9]+$ || "${val_in}" -lt 1 || "${val_in}" -gt 168 ]]; then
        echo "Interval jam harus angka 1-168."
        return
      fi
      interval_min="$(( val_in * 60 ))"
    fi
    AUTO_BACKUP_INTERVAL_MINUTES="${interval_min}"
    AUTO_BACKUP_WIB_HOUR="${current_wib_hour}"
  fi

  AUTO_BACKUP_ENABLE="${enable_in}"
  AUTO_BACKUP_SCHEDULE_MODE="${chosen_sched}"
  update_sc_env_var "AUTO_BACKUP_ENABLE" "${AUTO_BACKUP_ENABLE}"
  update_sc_env_var "AUTO_BACKUP_INTERVAL_MINUTES" "${AUTO_BACKUP_INTERVAL_MINUTES}"
  update_sc_env_var "AUTO_BACKUP_SCHEDULE_MODE" "${AUTO_BACKUP_SCHEDULE_MODE}"
  update_sc_env_var "AUTO_BACKUP_WIB_HOUR" "${AUTO_BACKUP_WIB_HOUR}"
  update_app_env_var "AUTO_BACKUP_ENABLE" "${AUTO_BACKUP_ENABLE}"
  update_app_env_var "AUTO_BACKUP_INTERVAL_MINUTES" "${AUTO_BACKUP_INTERVAL_MINUTES}"
  update_app_env_var "AUTO_BACKUP_SCHEDULE_MODE" "${AUTO_BACKUP_SCHEDULE_MODE}"
  update_app_env_var "AUTO_BACKUP_WIB_HOUR" "${AUTO_BACKUP_WIB_HOUR}"

  write_auto_backup_timer_unit "${AUTO_BACKUP_SCHEDULE_MODE}" "${AUTO_BACKUP_INTERVAL_MINUTES}" "${AUTO_BACKUP_WIB_HOUR}"
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ "${AUTO_BACKUP_ENABLE}" == "1" ]]; then
    menu_ensure_auto_backup_timer_armed || return 1
    systemctl start sc-1forcr-autobackup.service >/dev/null 2>&1 || true
  else
    systemctl disable --now sc-1forcr-autobackup.timer >/dev/null 2>&1 || true
  fi

  echo
  echo "Berhasil update auto backup:"
  echo "- Status   : $([[ "${AUTO_BACKUP_ENABLE}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  if [[ "${AUTO_BACKUP_SCHEDULE_MODE}" == "daily_wib" ]]; then
    echo "- Jadwal   : Harian WIB jam $(printf '%02d' "${AUTO_BACKUP_WIB_HOUR}"):00"
  else
    echo "- Interval : ${AUTO_BACKUP_INTERVAL_MINUTES} menit"
  fi
}

pick_type() {
  draw_menu_panel "Pilih tipe:" \
    "0) kembali" \
    "1) ssh" \
    "2) vmess" \
    "3) vless" \
    "4) trojan" \
    "5) zivpn" >&2
  if ! prompt_input t "Input [0-5]: "; then
    echo ""
    return 0
  fi
  case "$t" in
    0) echo "" ;;
    1) echo "ssh" ;;
    2) echo "vmess" ;;
    3) echo "vless" ;;
    4) echo "trojan" ;;
    5) echo "zivpn" ;;
    *) echo "" ;;
  esac
}

endpoint_create() {
  case "$1" in
    ssh|zivpn) echo "/sshvpn" ;;
    vmess) echo "/vmessall" ;;
    vless) echo "/vlessall" ;;
    trojan) echo "/trojanall" ;;
    *) echo "" ;;
  esac
}
endpoint_trial() {
  case "$1" in
    ssh|zivpn) echo "/trialsshvpn" ;;
    vmess) echo "/trialvmessall" ;;
    vless) echo "/trialvlessall" ;;
    trojan) echo "/trialtrojanall" ;;
    *) echo "" ;;
  esac
}
endpoint_renew() {
  case "$1" in
    ssh|zivpn) echo "/renewsshvpn" ;;
    vmess) echo "/renewvmess" ;;
    vless) echo "/renewvless" ;;
    trojan) echo "/renewtrojan" ;;
    *) echo "" ;;
  esac
}
endpoint_delete() {
  case "$1" in
    ssh|zivpn) echo "/deletesshvpn" ;;
    vmess) echo "/deletevmess" ;;
    vless) echo "/deletevless" ;;
    trojan) echo "/deletetrojan" ;;
    *) echo "" ;;
  esac
}
endpoint_unlock() {
  case "$1" in
    ssh|zivpn) echo "/unlocksshvpn" ;;
    vmess) echo "/unlockvmess" ;;
    vless) echo "/unlockvless" ;;
    trojan) echo "/unlocktrojan" ;;
    *) echo "" ;;
  esac
}
endpoint_lock() {
  case "$1" in
    ssh|zivpn) echo "/locksshvpn" ;;
    vmess) echo "/lockvmess" ;;
    vless) echo "/lockvless" ;;
    trojan) echo "/locktrojan" ;;
    *) echo "" ;;
  esac
}
endpoint_quota() {
  case "$1" in
    ssh|zivpn) echo "/editquotasshvpn" ;;
    vmess) echo "/editquotavmess" ;;
    vless) echo "/editquotavless" ;;
    trojan) echo "/editquotatrojan" ;;
    *) echo "" ;;
  esac
}

created_json_value() {
  local raw="$1" query="$2" fallback="${3--}"
  local value
  value="$(printf '%s' "${raw}" | jq -r "(${query}) // empty" 2>/dev/null || true)"
  if [[ -n "${value}" && "${value}" != "null" ]]; then
    printf '%s' "${value}"
  else
    printf '%s' "${fallback}"
  fi
}

created_expiry_time() {
  local expired="$1" fallback="${2--}"
  if [[ "${expired}" =~ ([0-9]{2}:[0-9]{2}:[0-9]{2}) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "${fallback}"
  fi
}

# Teks detail akun di sini harus sama dengan pesan akun BotVPN
# (modules/accountMessages.js). Fixture bersama di
# scripts/fixtures/account-message-parity.json dijaga test:account-parity.
created_quota_text() {
  local quota="$1"
  if [[ "${quota}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    if [[ "${quota}" =~ ^0+([.]0+)?$ ]]; then
      printf 'Unlimited'
    else
      printf '%s GB' "${quota}"
    fi
  else
    printf '%s' "${quota:--}"
  fi
}

# Limit IP 0 berarti tidak dibatasi. Argumen kedua ditempel hanya ke angka.
created_limit_text() {
  local limit="$1" suffix="${2:-}"
  if [[ "${limit}" =~ ^0+$ ]]; then
    printf 'Unlimited'
  else
    printf '%s%s' "${limit:--}" "${suffix}"
  fi
}

# Expired Xray: tanggal API sudah memuat jam, jadi jam terpisah hanya ditempel
# kalau tanggalnya belum memuat jam.
created_expired_text() {
  local expired="$1" time_value="$2"
  if [[ "${expired}" =~ [0-9]{2}:[0-9]{2}:[0-9]{2} || "${expired}" == *" - "* || -z "${time_value}" ]]; then
    printf '%s' "${expired}"
  else
    printf '%s - %s' "${expired}" "${time_value}"
  fi
}

print_created_account() {
  local type="$1" raw="$2" mode="${3:-create}"
  local code err_msg
  code="$(echo "${raw}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  if [[ "${code}" != "200" ]]; then
    err_msg="$(echo "${raw}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
    echo "Gagal membuat akun ${type^^}: ${err_msg}"
    return
  fi

  case "${type}" in
    ssh)
      # OpenVPN dan SSH OHP tidak dipasang SC, jadi tidak ditampilkan walau API
      # masih mengirim kunci ovpntcp/ovpnudp/sshohp untuk bot lama. SlowDNS
      # hanya tampil kalau API mengirim data.slowdns (SlowDNS aktif di VPS).
      local title host user pass exp exp_time quota lim city isp tls ntls tls_list ntls_list udpgw udp_custom
      local slowdns_ns slowdns_pubkey slowdns_dns
      title="SSH ACCOUNT CREATED"
      [[ "${mode}" == "trial" ]] && title="TRIAL SSH ACCOUNT"
      host="$(created_json_value "${raw}" '.data.hostname // .data.host')"
      user="$(created_json_value "${raw}" '.data.username')"
      pass="$(created_json_value "${raw}" '.data.password // .data.secret')"
      exp="$(created_json_value "${raw}" '.data.exp // .data.expired // .data.date_exp')"
      exp_time="$(created_expiry_time "${exp}" "$(created_json_value "${raw}" '.data.time')")"
      quota="$(created_quota_text "$(created_json_value "${raw}" '.data.quota // .data.kuota // .data.quota_gb' '0')")"
      lim="$(created_limit_text "$(created_json_value "${raw}" '.data.limitip // .data.iplimit' '0')")"
      city="$(created_json_value "${raw}" '.data.city // .data.location.city')"
      isp="$(created_json_value "${raw}" '.data.isp // .data.location.isp')"
      tls="$(created_json_value "${raw}" '.data.port.tls // .data.port.ssl // .data.port.any' '443')"
      ntls="$(created_json_value "${raw}" '.data.port.none // .data.port.ntls // .data.port.ws' '80')"
      tls_list="$(created_json_value "${raw}" '.data.port.tls_all' "${tls}")"
      ntls_list="$(created_json_value "${raw}" '.data.port.none_all' "${ntls}")"
      udpgw="$(created_json_value "${raw}" '.data.port.udpgw' '')"
      udp_custom="$(created_json_value "${raw}" '.data.port.udpcustom // .data.port.udp_custom // .data.port.udphc' '')"
      slowdns_ns="$(created_json_value "${raw}" '.data.slowdns.ns' '')"
      slowdns_pubkey="$(created_json_value "${raw}" '.data.slowdns.pubkey' '')"
      slowdns_dns="$(created_json_value "${raw}" '.data.slowdns.dns' '')"
      cat <<EOT_SSH | ui_fx
=============================
 ${title}
=============================

[ SSH PREMIUM DETAILS ]
-----------------------------
SSH WS      : ${host}:${ntls}@${user}:${pass}
SSH SSL     : ${host}:${tls}@${user}:${pass}

[ HOST INFORMATION ]
-----------------------------
Hostname    : ${host}
City        : ${city}
ISP         : ${isp}
Username    : ${user}
Password    : ${pass}
Expiry Date : ${exp}
Expiry Time : ${exp_time}
Quota       : ${quota}
IP Limit    : ${lim}

[ PORTS ]
------------------------------
TLS         : ${tls_list}
Non-TLS     : ${ntls_list}
EOT_SSH
      if [[ -n "${udpgw}" ]]; then
        printf 'UDPGW       : %s\n' "${udpgw}" | ui_fx
      fi
      if [[ -n "${udp_custom}" ]]; then
        printf 'UDP Custom  : %s\n' "${udp_custom}" | ui_fx
      fi
      if [[ -n "${slowdns_ns}" && -n "${slowdns_pubkey}" ]]; then
        {
          printf '\n[ SLOWDNS ]\n------------------------------\n'
          printf 'NS          : %s\n' "${slowdns_ns}"
          printf 'Pubkey      : %s\n' "${slowdns_pubkey}"
          if [[ -n "${slowdns_dns}" ]]; then
            printf 'DNS         : %s\n' "${slowdns_dns}"
          fi
        } | ui_fx
      fi
      cat <<EOT_SSH_PAYLOAD | ui_fx

[ PAYLOAD WS ]
------------------------------
GET wss://[host_port]/ HTTP/1.1[crlf]Host: [host_port][crlf]Upgrade: Websocket[crlf]Connection: Keep-Alive[crlf][crlf]

[ PAYLOAD ENHANCED + SPLIT ]
------------------------------
PATCH /ssh-ws HTTP/1.1[crlf]Host: [host][crlf]Host: www.google.com[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf]User-Agent: [ua][crlf][crlf][split]HTTP/1.1 200 OK[crlf][crlf]
------------------------------
Terima kasih telah menggunakan layanan kami.
EOT_SSH_PAYLOAD
      ;;
    zivpn)
      local host user exp exp_time lim city isp udp_port backend
      host="$(created_json_value "${raw}" '.data.hostname // .data.host')"
      user="$(created_json_value "${raw}" '.data.username')"
      exp="$(created_json_value "${raw}" '.data.exp // .data.expired // .data.date_exp')"
      exp_time="$(created_expiry_time "${exp}" "$(created_json_value "${raw}" '.data.time')")"
      lim="$(created_json_value "${raw}" '.data.limitip // .data.iplimit' '0')"
      city="$(created_json_value "${raw}" '.data.city // .data.location.city')"
      isp="$(created_json_value "${raw}" '.data.isp // .data.location.isp')"
      backend="$(printf '%s' "${ACTIVE_UDP_BACKEND:-zivpn}" | tr '[:upper:]' '[:lower:]')"
      udp_port="-"
      if [[ "${backend}" == "zivpn" ]]; then
        udp_port="${ZIVPN_LISTEN_PORT:-5667}"
      fi
      cat <<EOT_ZIVPN | ui_fx
=============================
 ZIVPN ACCOUNT CREATED
=============================

[ ZIVPN DETAILS ]
-----------------------------
HOST         : ${host}
UDP PASSWORD : ${user}
UDP PORT     : ${udp_port}
EXPIRED      : ${exp}
EXPIRY TIME  : ${exp_time}
IP LIMIT     : ${lim} pengguna

[ HOST INFORMATION ]
-----------------------------
Hostname     : ${host}
City         : ${city}
ISP          : ${isp}
-----------------------------
Terima kasih telah menggunakan layanan kami.
EOT_ZIVPN
      ;;
    vmess|vless|trojan)
      local title heading host user secret exp exp_text quota lim city isp domain sni tls none grpc any_port path_ws path_upgrade service_name network
      local linktls linknone linkgrpc linkuptls linkupntls linkxhttptls linkxhttpntls linkonering path_xhttp
      title="${type^^}"
      heading="        ${title} ACCOUNT"
      [[ "${mode}" == "trial" ]] && heading="    TRIAL ${title} ACCOUNT"
      host="$(created_json_value "${raw}" '.data.hostname // .data.host')"
      user="$(created_json_value "${raw}" '.data.username')"
      secret="$(created_json_value "${raw}" '.data.uuid // .data.password // .data.secret // .data.id')"
      exp="$(created_json_value "${raw}" '.data.exp // .data.expired // .data.date_exp')"
      exp_text="$(created_expired_text "${exp}" "$(created_json_value "${raw}" '.data.time' '')")"
      quota="$(created_quota_text "$(created_json_value "${raw}" '.data.quota // .data.kuota // .data.quota_gb' '0')")"
      lim="$(created_limit_text "$(created_json_value "${raw}" '.data.limitip // .data.iplimit' '0')" ' pengguna')"
      city="$(created_json_value "${raw}" '.data.city // .data.location.city')"
      isp="$(created_json_value "${raw}" '.data.isp // .data.location.isp')"
      domain="$(created_json_value "${raw}" '.data.domain // .data.hostname // .data.host')"
      sni="$(created_json_value "${raw}" '.data.sni // .data.server_name // .data.hostname // .data.host')"
      tls="$(created_json_value "${raw}" '.data.port.tls_all // .data.port.tls // .data.port.any' '443')"
      none="$(created_json_value "${raw}" '.data.port.none_all // .data.port.none // .data.port.ntls' '80')"
      grpc="$(created_json_value "${raw}" '.data.port.grpc' '443')"
      any_port="$(created_json_value "${raw}" '.data.port.any // .data.port.tls' '443')"
      path_ws="$(created_json_value "${raw}" ".data.path.ws // .data.path.stn // .data.ws_path" "/${type}")"
      if [[ "$(created_json_value "${raw}" '.data.path.any' 'false')" == "true" ]]; then
        path_ws="${path_ws} atau path bebas"
      fi
      path_upgrade="$(created_json_value "${raw}" ".data.path.upgrade // .data.upgrade_path" "/up${type}")"
      service_name="$(created_json_value "${raw}" '.data.serviceName // .data.service_name' "${type}-grpc")"
      linktls="$(created_json_value "${raw}" '.data.link.tls // .data.link.ws_tls')"
      linknone="$(created_json_value "${raw}" '.data.link.none // .data.link.ntls // .data.link.ws_ntls')"
      linkgrpc="$(created_json_value "${raw}" '.data.link.grpc // .data.link.grpc_tls')"
      linkuptls="$(created_json_value "${raw}" '.data.link.uptls // .data.link.up_tls // .data.link.tls')"
      linkupntls="$(created_json_value "${raw}" '.data.link.upntls // .data.link.up_ntls // .data.link.none // .data.link.ntls')"
      # Opsional: XHTTP hanya ada di VLESS saat inbound-nya aktif; OneRing untuk
      # aplikasi 1FTunnel. Tidak ditampilkan kalau API tidak mengirimnya.
      linkxhttptls="$(created_json_value "${raw}" '.data.link.xhttptls // .data.link.xhttp_tls' '')"
      linkxhttpntls="$(created_json_value "${raw}" '.data.link.xhttpntls // .data.link.xhttp_ntls' '')"
      linkonering="$(created_json_value "${raw}" '.data.link.onering' '')"
      path_xhttp="$(created_json_value "${raw}" '.data.path.xhttp' '')"
      network="ws, grpc, upgrade"
      if [[ -n "${linkxhttptls}" || -n "${linkxhttpntls}" ]]; then
        network="${network}, xhttp"
      fi
      cat <<EOT_XRAY | ui_fx
=============================
${heading}
=============================

[ ${title} DETAILS ]
-----------------------------
REMARKS     : ${user}
HOST        : ${host}
PORT TLS    : ${tls}
PORT NTLS   : ${none}
PORT GRPC   : ${grpc}
PORT ANY    : ${any_port}
EOT_XRAY
      case "${type}" in
        vmess)
          cat <<EOT_VMESS_DETAIL | ui_fx
UUID        : ${secret}
ALTER ID    : 0
SECURITY    : auto
EOT_VMESS_DETAIL
          ;;
        vless)
          cat <<EOT_VLESS_DETAIL | ui_fx
UUID        : ${secret}
ENCRYPTION  : none
SECURITY    : tls / none
EOT_VLESS_DETAIL
          ;;
        trojan)
          cat <<EOT_TROJAN_DETAIL | ui_fx
PASSWORD    : ${secret}
SECURITY    : tls / none
EOT_TROJAN_DETAIL
          ;;
      esac
      cat <<EOT_XRAY_PATHS | ui_fx
NETWORK     : ${network}
PATH WS     : ${path_ws}
SERVICE     : ${service_name}
PATH UPGRADE: ${path_upgrade}
EOT_XRAY_PATHS
      if [[ -n "${path_xhttp}" ]]; then
        printf 'PATH XHTTP  : %s\n' "${path_xhttp}" | ui_fx
      fi
      cat <<EOT_XRAY_LINKS | ui_fx
EXPIRED     : ${exp_text}
QUOTA       : ${quota}
IP LIMIT    : ${lim}

[ ${title} URL ]
-----------------------------
TLS:
${linktls}

Non-TLS:
${linknone}

gRPC:
${linkgrpc}

Up TLS:
${linkuptls}

Up Non-TLS:
${linkupntls}
EOT_XRAY_LINKS
      if [[ -n "${linkxhttptls}" ]]; then
        printf '\nXHTTP TLS:\n%s\n' "${linkxhttptls}" | ui_fx
      fi
      if [[ -n "${linkxhttpntls}" ]]; then
        printf '\nXHTTP Non-TLS:\n%s\n' "${linkxhttpntls}" | ui_fx
      fi
      if [[ -n "${linkonering}" ]]; then
        cat <<EOT_XRAY_ONERING | ui_fx

OneRing (1FTunnel):
${linkonering}
EOT_XRAY_ONERING
      fi
      cat <<EOT_XRAY_FOOTER | ui_fx

[ HOST INFORMATION ]
-----------------------------
Domain      : ${domain}
SNI         : ${sni}
City        : ${city}
ISP         : ${isp}

[ PORTS ]
-----------------------------
WS TLS      : ${tls}
WS NTLS     : ${none}
GRPC TLS    : ${grpc}
ANY PORT    : ${any_port}
-----------------------------
Terima kasih telah menggunakan layanan kami.
EOT_XRAY_FOOTER
      ;;
    *)
      echo "${raw}" | jq . 2>/dev/null || echo "${raw}"
      ;;
  esac
}

random_alnum8() {
  local value
  value="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 8 || true)"
  if [[ "${#value}" -lt 8 ]]; then
    value="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' | cut -c1-8 || true)"
  fi
  if [[ "${#value}" -lt 8 ]]; then
    value="$(date +%s%N | sha256sum | cut -c1-8)"
  fi
  printf '%s' "${value:0:8}"
}

create_account() {
  local type ep username password exp limitip quota payload resp code
  while true; do
    type="$(pick_type)"
    [[ -z "$type" ]] && return
    ep="$(endpoint_create "$type")"
    [[ -z "$ep" ]] && { echo "Endpoint create tidak ada."; return; }

    username="$(prompt_new_username "$type")" || continue
    prompt_input exp "Expired (hari) [30]: " || continue
    exp="${exp:-30}"
    if [[ "$type" == "zivpn" ]]; then
      prompt_input limitip "Limit IP [2]: " || continue
      limitip="${limitip:-2}"
      quota="0"
      password="$(random_alnum8)"
    else
      prompt_input limitip "Limit IP [2]: " || continue
      limitip="${limitip:-2}"
      prompt_input quota "Quota GB [0]: " || continue
      quota="${quota:-0}"
    fi
    if [[ "$type" == "ssh" ]]; then
      prompt_input password "Password [default=username]: " || continue
      password="${password:-$username}"
    elif [[ "$type" != "zivpn" ]]; then
      password=""
    fi

    if [[ -n "$password" ]]; then
      payload="$(jq -nc --arg u "$username" --arg p "$password" --argjson e "$exp" --arg l "$limitip" --arg q "$quota" \
        '{username:$u,password:$p,expired:$e,limitip:$l,kuota:$q}')"
    else
      payload="$(jq -nc --arg u "$username" --argjson e "$exp" --arg l "$limitip" --arg q "$quota" \
        '{username:$u,expired:$e,limitip:$l,kuota:$q}')"
    fi
    resp="$(api_call "POST" "$ep" "$payload")"
    print_created_account "$type" "${resp}"
    code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
    return
  done
}

schedule_trial_delete_1h() {
  local type="$1" username="$2" del_ep unit safe_user
  del_ep="$(endpoint_delete "${type}")"
  [[ -z "${del_ep}" ]] && return
  if ! command -v systemd-run >/dev/null 2>&1; then
    echo "Catatan: systemd-run tidak tersedia, auto-delete trial 1 jam tidak dijadwalkan."
    return
  fi
  safe_user="$(echo "${username}" | tr -c 'A-Za-z0-9._-' '_')"
  unit="sc1forcr-trial-${type}-${safe_user}-$(date +%s)"
  if systemd-run --quiet --unit "${unit}" --on-active=1h \
    /usr/bin/curl -sS -X DELETE "${API_BASE}${del_ep}/${username}" \
    -H "Authorization: ${AUTH_TOKEN}" >/dev/null 2>&1; then
    echo "Trial 1 jam aktif. Auto-delete dijadwalkan (unit: ${unit})."
  else
    echo "Peringatan: gagal jadwalkan auto-delete trial 1 jam."
  fi
}

create_trial_account() {
  local type ep username password limitip resp code
  while true; do
    type="$(pick_type)"
    [[ -z "${type}" ]] && return
    ep="$(endpoint_trial "${type}")"
    [[ -z "${ep}" ]] && { echo "Endpoint trial tidak ada."; return; }

    username="$(prompt_new_username "${type}")" || continue

    if [[ "${type}" == "zivpn" ]]; then
      password="$(random_alnum8)"
      prompt_input limitip "Limit IP trial [1]: " || continue
      limitip="${limitip:-1}"
    elif [[ "${type}" == "ssh" ]]; then
      prompt_input password "Password [default=username]: " || continue
      password="${password:-$username}"
      limitip="0"
    else
      password=""
      limitip="0"
    fi

    if [[ -n "${password}" ]]; then
      resp="$(api_call "POST" "${ep}" "$(jq -nc --arg u "${username}" --arg p "${password}" --argjson e 1 --arg l "${limitip}" --arg q "0" '{username:$u,password:$p,expired:$e,limitip:$l,kuota:$q}')")"
    else
      resp="$(api_call "POST" "${ep}" "$(jq -nc --arg u "${username}" --argjson e 1 --arg l "${limitip}" --arg q "0" '{username:$u,expired:$e,limitip:$l,kuota:$q}')")"
    fi

    print_created_account "${type}" "${resp}" trial
    code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
    if [[ "${code}" == "200" ]]; then
      schedule_trial_delete_1h "${type}" "${username}"
    fi
    return
  done
}

edit_limit_ip_account() {
  local type table username new_limit
  type="$(pick_type)"
  [[ -z "${type}" ]] && { echo "Tipe tidak valid."; return; }
  table="$(account_table_by_type "${type}")"
  [[ -z "${table}" ]] && { echo "Tabel akun tidak ditemukan."; return; }
  username="$(pick_existing_username "${type}")" || return
  prompt_input new_limit "Limit IP baru [0]: " || return
  new_limit="${new_limit:-0}"
  if [[ ! "${new_limit}" =~ ^[0-9]+$ ]]; then
    echo "Limit IP harus angka 0 atau lebih."
    return
  fi
  sqlite3 "${DB_PATH}" "UPDATE ${table} SET limitip=${new_limit} WHERE LOWER(username)=LOWER('${username}');" >/dev/null 2>&1 || {
    echo "Gagal update limit IP."
    return
  }
  echo "Berhasil update limit IP akun ${type^^} '${username}' jadi ${new_limit}."
}

edit_limit_ip_all_accounts() {
  local type table new_limit changed title
  type="$(pick_type)"
  [[ -z "${type}" ]] && { echo "Tipe tidak valid."; return; }
  table="$(account_table_by_type "${type}")"
  [[ -z "${table}" ]] && { echo "Tabel akun tidak ditemukan."; return; }

  case "${type}" in
    ssh|zivpn) title="SSH/ZIVPN/UDPHC" ;;
    vmess) title="VMESS" ;;
    vless) title="VLESS" ;;
    trojan) title="TROJAN" ;;
    *) title="${type^^}" ;;
  esac

  echo "EDIT LIMIT IP SEMUA USER (${title})"
  prompt_input new_limit "Limit IP baru untuk semua akun ${title} [0]: " || return
  new_limit="${new_limit:-0}"
  if [[ ! "${new_limit}" =~ ^[0-9]+$ ]]; then
    echo "Limit IP harus angka 0 atau lebih."
    return
  fi

  changed="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM ${table} WHERE CAST(COALESCE(limitip,0) AS INTEGER) <> ${new_limit};" 2>/dev/null || echo 0)"
  [[ "${changed}" =~ ^[0-9]+$ ]] || changed="0"

  sqlite3 "${DB_PATH}" "UPDATE ${table} SET limitip=${new_limit};" >/dev/null 2>&1 || {
    echo "Gagal update limit IP."
    return
  }

  echo "Berhasil update limit IP semua akun ${title} jadi ${new_limit}."
  echo "Total akun ter-update: ${changed}"
}

quota_type_key() {
  case "${1,,}" in
    ssh|zivpn|udphc) echo "ssh" ;;
    vmess) echo "vmess" ;;
    vless) echo "vless" ;;
    trojan) echo "trojan" ;;
    *) echo "${1,,}" ;;
  esac
}

quota_type_from_table() {
  case "${1}" in
    account_sshs) echo "ssh" ;;
    account_vmesses) echo "vmess" ;;
    account_vlesses) echo "vless" ;;
    account_trojans) echo "trojan" ;;
    *) echo "${1#account_}" ;;
  esac
}

bytes_to_gb_label() {
  local bytes="${1:-0}"
  [[ "${bytes}" =~ ^[0-9]+$ ]] || bytes="0"
  awk -v b="${bytes}" 'BEGIN {
    gb = b / 1073741824;
    if (gb >= 100 || gb == int(gb)) printf "%d GB", gb;
    else printf "%.2f GB", gb;
  }'
}

quota_limit_label() {
  local quota="${1:-0}"
  [[ "${quota}" =~ ^[0-9]+$ ]] || quota="0"
  if [[ "${quota}" -le 0 ]]; then
    echo "Unlimited"
  else
    echo "${quota} GB"
  fi
}

quota_usage_bytes_for_account() {
  local type username username_sql usage_type
  type="$(quota_type_key "${1:-}")"
  username="${2:-}"
  username_sql="${username//\'/''}"
  usage_type="${type//\'/''}"
  sqlite3 "${DB_PATH}" \
    "SELECT COALESCE(MAX(used_bytes),0) FROM account_quota_usage WHERE account_type='${usage_type}' AND LOWER(username)=LOWER('${username_sql}');" \
    2>/dev/null || echo "0"
}

quota_usage_label_for_account() {
  local type username quota used used_label limit_label
  type="${1:-}"
  username="${2:-}"
  quota="${3:-0}"
  used="$(quota_usage_bytes_for_account "${type}" "${username}")"
  [[ "${used}" =~ ^[0-9]+$ ]] || used="0"
  used_label="$(bytes_to_gb_label "${used}")"
  limit_label="$(quota_limit_label "${quota}")"
  echo "${used_label} / ${limit_label}"
}

edit_quota_account() {
  local type ep username quota mode payload resp code message used unlocked status
  type="$(pick_type)"
  [[ -z "${type}" ]] && { echo "Tipe tidak valid."; return; }
  ep="$(endpoint_quota "${type}")"
  [[ -z "${ep}" ]] && { echo "Endpoint quota tidak ada."; return; }
  username="$(pick_existing_username "${type}")" || return
  echo "EDIT QUOTA AKUN ${type^^}: ${username}"
  echo "Mode: set = ganti quota total, add = tambah quota dari quota sekarang."
  prompt_input mode "Mode quota (set/add) [set]: " || return
  mode="${mode:-set}"
  case "${mode,,}" in
    set|ganti) mode="set" ;;
    add|tambah) mode="add" ;;
    *) echo "Mode tidak valid."; return ;;
  esac
  prompt_input quota "Quota GB [0=unlimited]: " || return
  quota="${quota:-0}"
  if [[ ! "${quota}" =~ ^[0-9]+$ ]]; then
    echo "Quota harus angka 0 atau lebih."
    return
  fi
  payload="$(jq -nc --arg q "${quota}" --arg m "${mode}" '{kuota:$q,mode:$m}')"
  resp="$(api_call "PATCH" "${ep}/${username}" "${payload}")"
  code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
  if [[ "${code}" != "200" ]]; then
    echo "Gagal edit quota: ${message}"
    return
  fi
  quota="$(echo "${resp}" | jq -r '.data.quota // "0"' 2>/dev/null || echo "0")"
  used="$(echo "${resp}" | jq -r '.data.quota_used_bytes // "0"' 2>/dev/null || echo "0")"
  unlocked="$(echo "${resp}" | jq -r '.data.quota_unlocked // false' 2>/dev/null || echo "false")"
  status="$(echo "${resp}" | jq -r '.data.status // "-"' 2>/dev/null || echo "-")"
  echo "Berhasil edit quota akun ${type^^} '${username}'."
  echo "Quota sekarang : ${quota} GB"
  echo "Used bytes     : ${used}"
  echo "Status         : ${status}"
  echo "Unlock quota   : ${unlocked}"
}

edit_quota_all_accounts() {
  local type table new_quota changed title
  type="$(pick_type)"
  [[ -z "${type}" ]] && { echo "Tipe tidak valid."; return; }
  table="$(account_table_by_type "${type}")"
  [[ -z "${table}" ]] && { echo "Tabel akun tidak ditemukan."; return; }

  case "${type}" in
    ssh|zivpn) title="SSH/ZIVPN/UDPHC" ; type="ssh" ;;
    vmess) title="VMESS" ;;
    vless) title="VLESS" ;;
    trojan) title="TROJAN" ;;
    *) title="${type^^}" ;;
  esac

  echo "EDIT QUOTA SEMUA USER (${title})"
  prompt_input new_quota "Quota baru semua akun ${title} dalam GB [0=unlimited]: " || return
  new_quota="${new_quota:-0}"
  if [[ ! "${new_quota}" =~ ^[0-9]+$ ]]; then
    echo "Quota harus angka 0 atau lebih."
    return
  fi
  changed="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM ${table} WHERE CAST(COALESCE(quota,0) AS INTEGER) <> ${new_quota};" 2>/dev/null || echo 0)"
  [[ "${changed}" =~ ^[0-9]+$ ]] || changed="0"
  sqlite3 "${DB_PATH}" "UPDATE ${table} SET quota=${new_quota};" >/dev/null 2>&1 || {
    echo "Gagal update quota."
    return
  }
  systemctl start sc-1forcr-iplimit.service >/dev/null 2>&1 || true
  echo "Berhasil update quota semua akun ${title} jadi ${new_quota} GB."
  echo "Total akun ter-update: ${changed}"
  echo "Jika ada akun LOCK_QUOTA, jalankan menu Unlock Semua Akun setelah quota dinaikkan."
}

validate_ssh_password_cli() {
  local password="$1"
  if [[ -z "${password}" ]]; then
    echo "Password tidak boleh kosong."
    return 1
  fi
  if [[ "${password}" == *":"* || "${password}" =~ [[:space:]] ]]; then
    echo "Password tidak boleh mengandung spasi, enter, atau titik dua."
    return 1
  fi
  if [[ "${#password}" -gt 128 ]]; then
    echo "Password terlalu panjang."
    return 1
  fi
  return 0
}

change_ssh_password_account() {
  local username password payload resp code message host exp limitip
  echo "GANTI PASSWORD SSH/ZIVPN/UDPHC"
  username="$(pick_existing_username "ssh")" || return
  menu_kv "Username" "${username}"
  prompt_input password "Password baru: " || return
  password="$(echo "${password}" | tr -d '\r')"
  validate_ssh_password_cli "${password}" || return

  payload="$(jq -nc --arg p "${password}" '{password:$p}')"
  resp="$(api_call "PATCH" "/passwordsshvpn/${username}" "${payload}")"
  code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
  if [[ "${code}" != "200" ]]; then
    echo "Gagal ganti password SSH: ${message}"
    return
  fi

  host="${DOMAIN}"
  exp="$(echo "${resp}" | jq -r '.data.exp // "-"' 2>/dev/null || echo "-")"
  limitip="$(echo "${resp}" | jq -r '.data.limitip // "0"' 2>/dev/null || echo "0")"
  cat <<EOT_PASS_SSH | ui_fx
=============================
 PASSWORD SSH BERHASIL DIGANTI
=============================
Username     : ${username}
Password     : ${password}
Expired      : ${exp}
IP Limit     : ${limitip}
SSH WS       : ${host}:80@${username}:${password}
SSH SSL      : ${host}:443@${username}:${password}
EOT_PASS_SSH
  telegram_notify_action "CHANGE_PASSWORD" "ssh" "${username}"
}

change_ssh_password_all_accounts() {
  local password confirm payload resp code message changed total
  echo "GANTI PASSWORD SEMUA AKUN SSH/ZIVPN/UDPHC"
  echo "Semua akun di tabel SSH akan memakai password yang sama."
  prompt_input password "Password baru untuk semua akun SSH: " || return
  password="$(echo "${password}" | tr -d '\r')"
  validate_ssh_password_cli "${password}" || return
  prompt_input confirm "Ketik GANTI untuk lanjut: " || return
  if [[ "${confirm}" != "GANTI" ]]; then
    echo "Dibatalkan."
    return
  fi

  payload="$(jq -nc --arg p "${password}" '{password:$p}')"
  resp="$(api_call "PATCH" "/passwordsshvpn-all" "${payload}")"
  code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
  if [[ "${code}" != "200" ]]; then
    echo "Gagal ganti password semua akun SSH: ${message}"
    return
  fi

  changed="$(echo "${resp}" | jq -r '.data.changed // 0' 2>/dev/null || echo 0)"
  total="$(echo "${resp}" | jq -r '.data.total // 0' 2>/dev/null || echo 0)"
  echo "Password semua akun SSH berhasil diganti."
  echo "Password baru : ${password}"
  echo "Total akun    : ${total}"
  echo "Ter-update    : ${changed}"
}

account_table_by_type() {
  case "$1" in
    ssh|zivpn) echo "account_sshs" ;;
    vmess) echo "account_vmesses" ;;
    vless) echo "account_vlesses" ;;
    trojan) echo "account_trojans" ;;
    *) echo "" ;;
  esac
}

account_type_for_table() {
  case "$1" in
    account_sshs) echo "ssh" ;;
    account_vmesses) echo "vmess" ;;
    account_vlesses) echo "vless" ;;
    account_trojans) echo "trojan" ;;
    *) echo "" ;;
  esac
}

username_exists_by_type() {
  local type="$1" username="$2" table cnt
  table="$(account_table_by_type "${type}")"
  [[ -z "${table}" ]] && return 1
  cnt="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM ${table} WHERE LOWER(username)=LOWER('${username}');" 2>/dev/null || echo 0)"
  [[ "${cnt}" =~ ^[0-9]+$ ]] || cnt="0"
  if [[ "${cnt}" -gt 0 ]]; then
    return 0
  fi
  return 1
}

prompt_new_username() {
  local type="$1" username=""
  while true; do
    prompt_input username "Username: " || return 1
    username="$(echo "${username}" | tr -d '[:space:]')"
    if [[ -z "${username}" ]]; then
      echo "Username tidak boleh kosong." >&2
      continue
    fi
    if [[ ! "${username}" =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "Username hanya boleh huruf, angka, titik, underscore, dan dash." >&2
      continue
    fi
    if username_exists_by_type "${type}" "${username}"; then
      echo "Username '${username}' sudah ada di database. Coba username lain." >&2
      continue
    fi
    echo "${username}"
    return 0
  done
}

format_remaining_from_minutes() {
  local mins="${1:-0}" d h m
  mins="$(echo "${mins}" | tr -cd '0-9')"
  [[ -z "${mins}" ]] && mins=0
  if [[ "${mins}" -ge 999999999 ]]; then
    echo "Unlimited"
    return
  fi
  if [[ "${mins}" -le 0 ]]; then
    echo "0m"
    return
  fi
  d=$(( mins / 1440 ))
  h=$(( (mins % 1440) / 60 ))
  m=$(( mins % 60 ))
  if [[ "${d}" -gt 0 ]]; then
    echo "${d}d ${h}h"
    return
  fi
  if [[ "${h}" -gt 0 ]]; then
    echo "${h}h ${m}m"
    return
  fi
  echo "${m}m"
}

account_remaining_minutes_expr() {
  cat <<'EOF'
CASE
  WHEN TRIM(COALESCE(date_exp,''))='' THEN 999999999
  ELSE COALESCE(MAX(0, CAST(((julianday(CASE WHEN LENGTH(TRIM(COALESCE(date_exp,''))) <= 10 THEN datetime(date(TRIM(date_exp)),'+1 day') ELSE datetime(REPLACE(TRIM(date_exp),'T',' ')) END) - julianday(datetime('now','localtime'))) * 24 * 60) AS INTEGER)), 0)
END
EOF
}

account_expire_datetime_expr() {
  echo "CASE WHEN LENGTH(TRIM(COALESCE(date_exp,''))) <= 10 THEN datetime(date(TRIM(date_exp)),'+1 day') ELSE datetime(REPLACE(TRIM(date_exp),'T',' ')) END"
}

account_active_where_expr() {
  local exp_expr
  exp_expr="$(account_expire_datetime_expr)"
  echo "UPPER(TRIM(COALESCE(status,'')))='AKTIF' AND (TRIM(COALESCE(date_exp,''))='' OR (${exp_expr}) > datetime('now','localtime'))"
}

account_nonexpired_where_expr() {
  local exp_expr
  exp_expr="$(account_expire_datetime_expr)"
  echo "UPPER(TRIM(COALESCE(status,''))) NOT IN ('EXPIRED','RECOVERY','KADALUARSA') AND (TRIM(COALESCE(date_exp,''))='' OR (${exp_expr}) > datetime('now','localtime'))"
}

account_expired_where_expr() {
  local exp_expr
  exp_expr="$(account_expire_datetime_expr)"
  echo "UPPER(TRIM(COALESCE(status,''))) IN ('EXPIRED','RECOVERY','KADALUARSA') OR (TRIM(COALESCE(date_exp,''))<>'' AND (${exp_expr}) <= datetime('now','localtime'))"
}

account_effective_status_sql() {
  local exp_expr
  exp_expr="$(account_expire_datetime_expr)"
  echo "CASE WHEN UPPER(TRIM(COALESCE(status,''))) IN ('EXPIRED','RECOVERY','KADALUARSA') THEN 'EXPIRED' WHEN UPPER(TRIM(COALESCE(status,'')))='AKTIF' AND TRIM(COALESCE(date_exp,''))<>'' AND (${exp_expr}) <= datetime('now','localtime') THEN 'EXPIRED' ELSE UPPER(TRIM(COALESCE(status,''))) END"
}

print_account_picker_table() {
  local type="$1" lock_only="${2:-0}" mode="${3:-all}" table where rows active_where nonexpired_where expired_where rem_expr
  table="$(account_table_by_type "${type}")"
  [[ -z "${table}" ]] && return 1
  where=""
  active_where="$(account_active_where_expr)"
  nonexpired_where="$(account_nonexpired_where_expr)"
  expired_where="$(account_expired_where_expr)"
  if [[ "${lock_only}" == "1" ]]; then
    where="WHERE LOWER(username) IN (
      SELECT LOWER(username) FROM ${table} WHERE UPPER(TRIM(COALESCE(status,''))) IN ('LOCK','LOCK_TMP','LOCK_QUOTA')
      UNION
      SELECT LOWER(username) FROM temp_ip_locks WHERE account_type='${type}' AND locked_until > strftime('%s','now')
    )"
  else
    case "${mode}" in
      active) where="WHERE ${active_where}" ;;
      nonexpired) where="WHERE ${nonexpired_where}" ;;
      expired) where="WHERE ${expired_where}" ;;
      *) where="" ;;
    esac
  fi
  rem_expr="$(account_remaining_minutes_expr)"
  rows="$(sqlite3 -separator '|' "$DB_PATH" \
    "SELECT username, ${rem_expr}, UPPER(TRIM(COALESCE(status,''))), CAST(COALESCE(limitip,0) AS INTEGER) FROM ${table} ${where} ORDER BY username;" 2>/dev/null || true)"
  if [[ -z "${rows}" ]]; then
    return 1
  fi
  printf "%-4s %-24s %-10s %-8s %-8s\n" "NO" "USERNAME" "STATUS" "SISA" "LIM_IP"
  printf "%-4s %-24s %-10s %-8s %-8s\n" "----" "------------------------" "----------" "--------" "--------"
  local i=0 u sisa st lim sisa_human
  while IFS='|' read -r u sisa st lim; do
    [[ -z "${u}" ]] && continue
    i=$((i + 1))
    sisa_human="$(format_remaining_from_minutes "${sisa:-0}")"
    if [[ "${mode}" == "expired" && "${st}" != "EXPIRED" ]]; then
      st="EXPIRED"
    fi
    printf "%-4s %-24s %-10s %-8s %-8s\n" "${i}" "${u}" "${st:-AKTIF}" "${sisa_human}" "${lim:-0}"
  done <<< "${rows}"
  return 0
}

pick_existing_username() {
  local type="$1" mode="${2:-all}" table rows input username where active_where nonexpired_where expired_where
  table="$(account_table_by_type "${type}")"
  [[ -z "${table}" ]] && return 1

  active_where="$(account_active_where_expr)"
  nonexpired_where="$(account_nonexpired_where_expr)"
  expired_where="$(account_expired_where_expr)"
  case "${mode}" in
    active) where="WHERE ${active_where}" ;;
    nonexpired) where="WHERE ${nonexpired_where}" ;;
    expired) where="WHERE ${expired_where}" ;;
    *) where="" ;;
  esac

  rows="$(sqlite3 "$DB_PATH" "SELECT username FROM ${table} ${where} ORDER BY username;" 2>/dev/null || true)"
  if [[ -z "${rows}" ]]; then
    echo "Tidak ada akun ${type} ${mode} di DB." >&2
    return 1
  fi

  echo "LIST AKUN ${type^^} - ${mode^^}" >&2
  if ! print_account_picker_table "${type}" "0" "${mode}" | ui_fx >&2; then
    echo "Tidak ada data akun untuk ditampilkan." >&2
  fi
  prompt_input input "Pilih nomor atau isi username: " || return 1
  input="$(echo "${input}" | tr -d '[:space:]')"
  [[ -z "${input}" ]] && { echo "Input kosong." >&2; return 1; }

  if [[ "${input}" =~ ^[0-9]+$ ]]; then
    username="$(echo "${rows}" | sed -n "${input}p")"
    [[ -z "${username}" ]] && { echo "Nomor tidak valid." >&2; return 1; }
  else
    username="$(echo "${rows}" | grep -Fxi "${input}" | head -n1 || true)"
    [[ -z "${username}" ]] && { echo "Username tidak ditemukan." >&2; return 1; }
  fi

  echo "${username}"
  return 0
}

pick_account_detail_mode() {
  local mode
  draw_menu_panel "Pilih status akun:" \
    "1) Aktif" \
    "2) Expired" \
    "3) Semua status" \
    "0) Kembali" >&2
  prompt_input mode "Input [0-3]: " || return 1
  case "${mode}" in
    1) echo "active" ;;
    2) echo "expired" ;;
    3) echo "all" ;;
    0) return 1 ;;
    *) echo "Pilihan tidak valid." >&2; return 1 ;;
  esac
}

pick_locked_username() {
  local type="$1" table rows input username
  table="$(account_table_by_type "${type}")"
  [[ -z "${table}" ]] && return 1

  rows="$(sqlite3 "$DB_PATH" "
    SELECT username FROM (
      SELECT username FROM ${table}
      WHERE UPPER(TRIM(COALESCE(status,''))) IN ('LOCK','LOCK_TMP','LOCK_QUOTA')
      UNION
      SELECT username FROM temp_ip_locks
      WHERE account_type='${type}' AND locked_until > strftime('%s','now')
    ) ORDER BY username;
  " 2>/dev/null || true)"
  if [[ -z "${rows}" ]]; then
    echo "Tidak ada akun ${type} yang sedang lock." >&2
    return 1
  fi

  echo "LIST AKUN LOCK ${type^^}" >&2
  if ! print_account_picker_table "${type}" "1" | ui_fx >&2; then
    echo "Tidak ada data lock untuk ditampilkan." >&2
  fi
  prompt_input input "Pilih nomor atau isi username: " || return 1
  input="$(echo "${input}" | tr -d '[:space:]')"
  [[ -z "${input}" ]] && { echo "Input kosong." >&2; return 1; }

  if [[ "${input}" =~ ^[0-9]+$ ]]; then
    username="$(echo "${rows}" | sed -n "${input}p")"
    [[ -z "${username}" ]] && { echo "Nomor tidak valid." >&2; return 1; }
  else
    username="$(echo "${rows}" | grep -Fxi "${input}" | head -n1 || true)"
    [[ -z "${username}" ]] && { echo "Username tidak ditemukan." >&2; return 1; }
  fi

  echo "${username}"
  return 0
}

renew_account() {
  local type ep username exp resp code message from_date to_date quota limitip
  type="$(pick_type)"
  [[ -z "$type" ]] && { echo "Tipe tidak valid."; return; }
  ep="$(endpoint_renew "$type")"
  [[ -z "$ep" ]] && { echo "Endpoint renew tidak ada."; return; }
  echo "RENEW AKUN ${type^^} - AKTIF/NON-EXPIRED"
  username="$(pick_existing_username "$type" "nonexpired")" || return
  menu_kv "Username" "${username}"
  prompt_input exp "Tambah expired (hari) [30]: " || return
  exp="${exp:-30}"
  resp="$(api_call "POST" "${ep}/${username}/${exp}")"
  code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
  if [[ "${code}" != "200" ]]; then
    echo "Gagal renew akun ${type^^}: ${message}"
    return
  fi
  from_date="$(echo "${resp}" | jq -r '.data.from // "-"' 2>/dev/null || echo "-")"
  to_date="$(echo "${resp}" | jq -r '.data.to // .data.exp // "-"' 2>/dev/null || echo "-")"
  quota="$(echo "${resp}" | jq -r '.data.quota // "0"' 2>/dev/null || echo "0")"
  limitip="$(echo "${resp}" | jq -r '.data.limitip // "0"' 2>/dev/null || echo "0")"
  cat <<EOT_RENEW | ui_fx
=============================
 RENEW ${type^^} BERHASIL
=============================
Username     : ${username}
Dari         : ${from_date}
Sampai       : ${to_date}
Quota        : ${quota}
IP Limit     : ${limitip}
EOT_RENEW
  # Notifikasi RENEW dikirim oleh API (notifyAccountEvent) supaya renew dari
  # menu maupun dari bot sama-sama terkirim dan formatnya seragam dengan
  # notifikasi create account. Jangan kirim lagi dari sini (dobel).
}

recover_expired_account() {
  local expired_where rows choice selected matches match_count type username old_exp old_status days ep resp code message to_date status
  expired_where="$(account_expired_where_expr)"
  rows="$(sqlite3 -separator '|' "${DB_PATH}" "
    SELECT type, username, date_exp, status FROM (
      SELECT 'ssh' AS type, username, date_exp, UPPER(TRIM(COALESCE(status,''))) AS status
        FROM account_sshs WHERE ${expired_where}
      UNION ALL
      SELECT 'vmess', username, date_exp, UPPER(TRIM(COALESCE(status,'')))
        FROM account_vmesses WHERE ${expired_where}
      UNION ALL
      SELECT 'vless', username, date_exp, UPPER(TRIM(COALESCE(status,'')))
        FROM account_vlesses WHERE ${expired_where}
      UNION ALL
      SELECT 'trojan', username, date_exp, UPPER(TRIM(COALESCE(status,'')))
        FROM account_trojans WHERE ${expired_where}
    ) ORDER BY date_exp, type, username;
  " 2>/dev/null || true)"

  if [[ -z "${rows}" ]]; then
    echo "Tidak ada akun expired yang masih dalam masa recovery."
    echo "Akun expired lebih dari ${EXPIRED_ACCOUNT_RETENTION_DAYS:-30} hari dihapus otomatis."
    return
  fi

  echo "RECOVERY AKUN EXPIRED"
  echo "Masa recovery: ${EXPIRED_ACCOUNT_RETENTION_DAYS:-30} hari sejak tanggal expired."
  local i=0 row_type row_user row_exp row_status
  {
    printf "%-4s %-9s %-24s %-20s %-10s\n" "NO" "TYPE" "USERNAME" "EXPIRED" "STATUS"
    printf "%-4s %-9s %-24s %-20s %-10s\n" "----" "---------" "------------------------" "--------------------" "----------"
    while IFS='|' read -r row_type row_user row_exp row_status; do
      [[ -z "${row_user}" ]] && continue
      i=$((i + 1))
      printf "%-4s %-9s %-24s %-20s %-10s\n" "${i}" "${row_type^^}" "${row_user}" "${row_exp:--}" "EXPIRED"
    done <<< "${rows}"
  } | ui_fx

  prompt_input choice "Pilih nomor atau username akun [0=kembali]: " || return
  choice="$(echo "${choice}" | tr -d '[:space:]')"
  [[ "${choice}" == "0" ]] && return
  if [[ "${choice}" =~ ^[0-9]+$ ]]; then
    if [[ "${choice}" -lt 1 ]]; then
      echo "Nomor tidak valid."
      return
    fi
    selected="$(printf '%s\n' "${rows}" | sed -n "${choice}p")"
  else
    matches="$(printf '%s\n' "${rows}" | awk -F'|' -v q="${choice}" 'tolower($2)==tolower(q)')"
    match_count="$(printf '%s\n' "${matches}" | awk 'NF {n++} END {print n+0}')"
    if [[ "${match_count}" -gt 1 ]]; then
      echo "Username '${choice}' ada di beberapa tipe akun. Pilih menggunakan nomor."
      return
    fi
    selected="$(printf '%s\n' "${matches}" | head -n1)"
  fi
  if [[ -z "${selected}" ]]; then
    echo "Nomor atau username tidak ditemukan."
    return
  fi
  IFS='|' read -r type username old_exp old_status <<< "${selected}"
  ep="$(endpoint_renew "${type}")"
  [[ -z "${ep}" ]] && { echo "Endpoint recovery tidak tersedia."; return; }

  prompt_input days "Tambah masa aktif dari sekarang (hari) [30]: " || return
  days="${days:-30}"
  if [[ ! "${days}" =~ ^[0-9]+$ || "${days}" -lt 1 || "${days}" -gt 3650 ]]; then
    echo "Jumlah hari tidak valid. Gunakan angka 1-3650."
    return
  fi

  resp="$(api_call "POST" "${ep}/${username}/${days}")"
  code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
  if [[ "${code}" != "200" ]]; then
    echo "Gagal recovery akun ${type^^}: ${message}"
    return
  fi
  to_date="$(echo "${resp}" | jq -r '.data.to // .data.exp // "-"' 2>/dev/null || echo "-")"
  status="$(echo "${resp}" | jq -r '.data.status // "AKTIF"' 2>/dev/null || echo "AKTIF")"
  cat <<EOT_RECOVERY | ui_fx
=============================
 RECOVERY ${type^^} BERHASIL
=============================
Username     : ${username}
Expired Lama : ${old_exp:--}
Expired Baru : ${to_date}
Tambah Hari  : ${days}
Status       : ${status}
EOT_RECOVERY
  if [[ "${status}" == "LOCK_QUOTA" ]]; then
    echo "Catatan: masa aktif pulih, tetapi akun tetap lock karena quota habis."
  fi
  # Notifikasi dikirim oleh API lewat notifyAccountEvent (RENEW/RECOVER).
}

sync_xray_from_summary_api() {
  local type="$1" body resp ok msg
  if [[ -z "${type}" ]]; then
    echo "sync xray skip: type kosong"
    return 1
  fi
  body="$(jq -nc --arg t "${type}" '{type:$t,restart:false}')"
  resp="$(curl -sS -X POST "http://127.0.0.1:8789/internal/sync-xray-from-db" \
    -H "x-sync-token: ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${body}" 2>/dev/null || true)"
  ok="$(echo "${resp}" | jq -r '.ok // false' 2>/dev/null || echo "false")"
  if [[ "${ok}" != "true" ]]; then
    msg="$(echo "${resp}" | jq -r '.message // "gagal sync xray"' 2>/dev/null || echo "gagal sync xray")"
    echo "XRAY sync ${type^^} gagal: ${msg}"
    return 1
  fi
  return 0
}

apply_xray_restart_from_summary_api() {
  local resp ok msg
  resp="$(curl -sS -X POST "http://127.0.0.1:8789/internal/apply-xray-restart" \
    -H "x-sync-token: ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null || true)"
  ok="$(echo "${resp}" | jq -r '.ok // false' 2>/dev/null || echo "false")"
  if [[ "${ok}" != "true" ]]; then
    msg="$(echo "${resp}" | jq -r '.message // "gagal restart xray"' 2>/dev/null || echo "gagal restart xray")"
    echo "XRAY restart gagal via Summary API: ${msg}"
    return 1
  fi
  return 0
}

extend_expired_all_accounts() {
  local days ans changed_ssh changed_vmess changed_vless changed_trojan
  local total_changed sync_ok
  echo "TAMBAH MASA AKTIF SEMUA AKUN (SSH/VMESS/VLESS/TROJAN)"
  prompt_input days "Tambah masa aktif (hari) [30]: " || return
  days="${days:-30}"
  if [[ ! "${days}" =~ ^[0-9]+$ || "${days}" -lt 1 || "${days}" -gt 3650 ]]; then
    echo "Jumlah hari tidak valid. Gunakan angka 1-3650."
    return
  fi
  if ! prompt_input ans "Lanjutkan tambah masa aktif ${days} hari untuk semua akun? [y/N]: "; then
    return
  fi
  ans="$(echo "${ans}" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ "${ans}" != "y" && "${ans}" != "yes" ]] && { echo "Dibatalkan."; return; }

  if ! sqlite3 "${DB_PATH}" "
BEGIN IMMEDIATE;
UPDATE account_sshs
SET date_exp = CASE
  WHEN date(COALESCE(date_exp,'')) IS NULL OR date(date_exp) < date('now','localtime')
    THEN date('now','localtime','+${days} day')
  ELSE date(date_exp,'+${days} day')
END;
SELECT changes();
UPDATE account_vmesses
SET date_exp = CASE
  WHEN date(COALESCE(date_exp,'')) IS NULL OR date(date_exp) < date('now','localtime')
    THEN date('now','localtime','+${days} day')
  ELSE date(date_exp,'+${days} day')
END;
SELECT changes();
UPDATE account_vlesses
SET date_exp = CASE
  WHEN date(COALESCE(date_exp,'')) IS NULL OR date(date_exp) < date('now','localtime')
    THEN date('now','localtime','+${days} day')
  ELSE date(date_exp,'+${days} day')
END;
SELECT changes();
UPDATE account_trojans
SET date_exp = CASE
  WHEN date(COALESCE(date_exp,'')) IS NULL OR date(date_exp) < date('now','localtime')
    THEN date('now','localtime','+${days} day')
  ELSE date(date_exp,'+${days} day')
END;
SELECT changes();
COMMIT;
" > /tmp/sc_extend_all_changes.$$ 2>/tmp/sc_extend_all_err.$$; then
    echo "Gagal update masa aktif semua akun."
    cat /tmp/sc_extend_all_err.$$ 2>/dev/null || true
    rm -f /tmp/sc_extend_all_changes.$$ /tmp/sc_extend_all_err.$$
    return
  fi

  mapfile -t __chg < /tmp/sc_extend_all_changes.$$ || true
  changed_ssh="${__chg[0]:-0}"
  changed_vmess="${__chg[1]:-0}"
  changed_vless="${__chg[2]:-0}"
  changed_trojan="${__chg[3]:-0}"
  rm -f /tmp/sc_extend_all_changes.$$ /tmp/sc_extend_all_err.$$

  [[ "${changed_ssh}" =~ ^[0-9]+$ ]] || changed_ssh="0"
  [[ "${changed_vmess}" =~ ^[0-9]+$ ]] || changed_vmess="0"
  [[ "${changed_vless}" =~ ^[0-9]+$ ]] || changed_vless="0"
  [[ "${changed_trojan}" =~ ^[0-9]+$ ]] || changed_trojan="0"
  total_changed=$((changed_ssh + changed_vmess + changed_vless + changed_trojan))

  sync_ok=1
  if ! sync_xray_from_summary_api "vmess"; then sync_ok=0; fi
  if ! sync_xray_from_summary_api "vless"; then sync_ok=0; fi
  if ! sync_xray_from_summary_api "trojan"; then sync_ok=0; fi
  if [[ "${sync_ok}" -eq 1 ]]; then
    apply_xray_restart_from_summary_api || sync_ok=0
  fi

  echo "Berhasil tambah masa aktif ${days} hari untuk semua akun."
  echo "- SSH    : ${changed_ssh} akun"
  echo "- VMESS  : ${changed_vmess} akun"
  echo "- VLESS  : ${changed_vless} akun"
  echo "- TROJAN : ${changed_trojan} akun"
  echo "Total    : ${total_changed} akun"
  if [[ "${sync_ok}" -eq 1 ]]; then
    echo "XRAY sync+restart: OK"
  else
    echo "XRAY sync+restart: ada yang gagal (cek log di atas)."
  fi
}

edit_uuid_xray_account() {
  local type username username_sql new_uuid new_uuid_sql row old_uuid
  echo "EDIT ID XRAY (VMESS/VLESS/TROJAN)"
  draw_menu_panel "Pilih tipe Xray:" \
    "1) VMESS" \
    "2) VLESS" \
    "3) TROJAN" \
    "0) Kembali"
  if ! prompt_input type "Input [0-3]: "; then
    return
  fi
  case "${type}" in
    0) return ;;
    1) type="vmess" ;;
    2) type="vless" ;;
    3) type="trojan" ;;
    *) echo "Pilihan tidak valid."; return ;;
  esac

  username="$(pick_existing_username "${type}")" || return
  username_sql="${username//\'/''}"
  if [[ "${type}" == "vmess" ]]; then
    row="$(sqlite3 -separator '|' "${DB_PATH}" "SELECT uuid FROM account_vmesses WHERE LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"
  elif [[ "${type}" == "vless" ]]; then
    row="$(sqlite3 -separator '|' "${DB_PATH}" "SELECT uuid FROM account_vlesses WHERE LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"
  else
    row="$(sqlite3 -separator '|' "${DB_PATH}" "SELECT password FROM account_trojans WHERE LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"
  fi
  old_uuid="$(echo "${row}" | head -n1 | xargs)"
  echo "Username : ${username}"
  if [[ "${type}" == "trojan" ]]; then
    echo "Password lama: ${old_uuid:--}"
  else
    echo "UUID lama: ${old_uuid:--}"
  fi
  prompt_input new_uuid "ID baru ${type^^} (bebas tanpa spasi / UUID standar): " || return
  new_uuid="$(echo "${new_uuid}" | tr -d '\r' | xargs)"
  if [[ ! "${new_uuid}" =~ ^[^[:space:]]{3,}$ ]]; then
    echo "Format tidak valid. Gunakan minimal 3 karakter tanpa spasi."
    return
  fi
  if [[ "${type}" == "vmess" || "${type}" == "vless" ]]; then
    if [[ ! "${new_uuid}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
      echo "Peringatan: ${type^^} umumnya paling aman memakai UUID standar."
      echo "Jika sync/restart Xray gagal, pakai format: $(uuidgen 2>/dev/null || echo "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")"
    fi
  fi
  new_uuid_sql="${new_uuid//\'/''}"

  if [[ "${type}" == "vmess" ]]; then
    sqlite3 "${DB_PATH}" "UPDATE account_vmesses SET uuid='${new_uuid_sql}' WHERE LOWER(username)=LOWER('${username_sql}');" >/dev/null 2>&1 || {
      echo "Gagal update UUID VMESS."
      return
    }
  elif [[ "${type}" == "vless" ]]; then
    sqlite3 "${DB_PATH}" "UPDATE account_vlesses SET uuid='${new_uuid_sql}' WHERE LOWER(username)=LOWER('${username_sql}');" >/dev/null 2>&1 || {
      echo "Gagal update UUID VLESS."
      return
    }
  else
    sqlite3 "${DB_PATH}" "UPDATE account_trojans SET password='${new_uuid_sql}' WHERE LOWER(username)=LOWER('${username_sql}');" >/dev/null 2>&1 || {
      echo "Gagal update password TROJAN."
      return
    }
  fi

  if sync_xray_from_summary_api "${type}" && apply_xray_restart_from_summary_api; then
    echo "Berhasil edit ID ${type^^}."
    echo "Username : ${username}"
    if [[ "${type}" == "trojan" ]]; then
      echo "Password baru: ${new_uuid}"
    else
      echo "UUID baru: ${new_uuid}"
    fi
  else
    echo "ID tersimpan di DB, tapi sync/restart Xray gagal."
    echo "Coba jalankan lagi saat Summary API aktif."
  fi
}

delete_account() {
  local mode="${1:-nonexpired}" type ep username resp code message label confirm
  case "${mode}" in
    expired) label="EXPIRED" ;;
    nonexpired) label="AKTIF/NON-EXPIRED" ;;
    *) echo "Mode hapus tidak valid."; return ;;
  esac
  type="$(pick_type)"
  [[ -z "$type" ]] && { echo "Tipe tidak valid."; return; }
  ep="$(endpoint_delete "$type")"
  [[ -z "$ep" ]] && { echo "Endpoint delete tidak ada."; return; }
  echo "DELETE AKUN ${type^^} - ${label}"
  username="$(pick_existing_username "$type" "$mode")" || return
  menu_kv "Username" "${username}"
  prompt_input confirm "Ketik HAPUS untuk konfirmasi: " || return
  [[ "${confirm^^}" != "HAPUS" ]] && { echo "Dibatalkan."; return; }
  resp="$(api_call "DELETE" "${ep}/${username}")"
  code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
  if [[ "${code}" != "200" ]]; then
    echo "Gagal hapus akun ${type^^}: ${message}"
    return
  fi
  echo "Akun ${type^^} ${label} '${username}' berhasil dihapus permanen."
}

delete_all_expired_accounts() {
  local expire_expr expired_where ssh_count vmess_count vless_count trojan_count total confirm resp code message
  local deleted_total deleted_ssh deleted_vmess deleted_vless deleted_trojan sync_ssh sync_xray
  expire_expr="$(account_expire_datetime_expr)"
  expired_where="((TRIM(COALESCE(date_exp,''))<>'' AND (${expire_expr}) <= datetime('now','localtime')) OR (UPPER(TRIM(COALESCE(status,''))) IN ('EXPIRED','RECOVERY','KADALUARSA') AND (TRIM(COALESCE(date_exp,''))='' OR (${expire_expr}) IS NULL)))"
  ssh_count="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM account_sshs WHERE ${expired_where};" 2>/dev/null || echo 0)"
  vmess_count="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM account_vmesses WHERE ${expired_where};" 2>/dev/null || echo 0)"
  vless_count="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM account_vlesses WHERE ${expired_where};" 2>/dev/null || echo 0)"
  trojan_count="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM account_trojans WHERE ${expired_where};" 2>/dev/null || echo 0)"
  [[ "${ssh_count}" =~ ^[0-9]+$ ]] || ssh_count=0
  [[ "${vmess_count}" =~ ^[0-9]+$ ]] || vmess_count=0
  [[ "${vless_count}" =~ ^[0-9]+$ ]] || vless_count=0
  [[ "${trojan_count}" =~ ^[0-9]+$ ]] || trojan_count=0
  total=$((ssh_count + vmess_count + vless_count + trojan_count))

  echo "HAPUS SEMUA ACCOUNT EXPIRED"
  echo "Akun trial expired yang masih tersisa juga akan dihapus."
  menu_kv "SSH/ZIVPN" "${ssh_count}"
  menu_kv "VMESS" "${vmess_count}"
  menu_kv "VLESS" "${vless_count}"
  menu_kv "TROJAN" "${trojan_count}"
  menu_kv "TOTAL" "${total}"
  if [[ "${total}" -lt 1 ]]; then
    echo "Tidak ada akun expired yang perlu dihapus."
    return
  fi

  echo
  echo "Tindakan ini permanen dan tidak dapat dibatalkan."
  prompt_input confirm "Ketik HAPUS SEMUA EXPIRED untuk konfirmasi: " || return
  [[ "${confirm^^}" != "HAPUS SEMUA EXPIRED" ]] && { echo "Dibatalkan."; return; }

  resp="$(api_call "DELETE" "/delete-expired-all")"
  code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
  if [[ "${code}" != "200" ]]; then
    echo "Gagal menghapus semua akun expired: ${message}"
    return
  fi

  deleted_total="$(echo "${resp}" | jq -r '.data.total // 0' 2>/dev/null || echo 0)"
  deleted_ssh="$(echo "${resp}" | jq -r '.data.removed.ssh // 0' 2>/dev/null || echo 0)"
  deleted_vmess="$(echo "${resp}" | jq -r '.data.removed.vmess // 0' 2>/dev/null || echo 0)"
  deleted_vless="$(echo "${resp}" | jq -r '.data.removed.vless // 0' 2>/dev/null || echo 0)"
  deleted_trojan="$(echo "${resp}" | jq -r '.data.removed.trojan // 0' 2>/dev/null || echo 0)"
  sync_ssh="$(echo "${resp}" | jq -r '.data.sync.ssh_backends // true' 2>/dev/null || echo true)"
  sync_xray="$(echo "${resp}" | jq -r '.data.sync.xray // true' 2>/dev/null || echo true)"
  echo "Semua akun yang masih berstatus expired berhasil diproses."
  menu_kv "SSH/ZIVPN" "${deleted_ssh}"
  menu_kv "VMESS" "${deleted_vmess}"
  menu_kv "VLESS" "${deleted_vless}"
  menu_kv "TROJAN" "${deleted_trojan}"
  menu_kv "TOTAL" "${deleted_total}"
  if [[ "${sync_ssh}" != "true" ]]; then
    echo "Peringatan: sinkronisasi backend SSH/UDP perlu dijalankan ulang."
  fi
  if [[ "${sync_xray}" != "true" ]]; then
    echo "Peringatan: akun sudah terhapus dari DB, tetapi reload Xray gagal."
    echo "Jalankan menu restart Xray agar konfigurasi aktif ikut tersinkron."
  fi
}

lock_account() {
  local type ep username resp code message confirm
  type="$(pick_type)"
  [[ -z "$type" ]] && { echo "Tipe tidak valid."; return; }
  ep="$(endpoint_lock "$type")"
  [[ -z "$ep" ]] && { echo "Endpoint lock tidak ada."; return; }
  echo "LOCK AKUN ${type^^} - AKTIF"
  username="$(pick_existing_username "$type" "active")" || return
  menu_kv "Username" "${username}"
  prompt_input confirm "Ketik LOCK untuk konfirmasi: " || return
  [[ "${confirm^^}" != "LOCK" ]] && { echo "Dibatalkan."; return; }
  resp="$(api_call "PATCH" "${ep}/${username}")"
  code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
  if [[ "${code}" != "200" ]]; then
    echo "Gagal lock akun ${type^^}: ${message}"
    return
  fi
  echo "Akun ${type^^} '${username}' berhasil di-lock."
  telegram_notify_action "LOCK" "${type}" "${username}"
}

unlock_account() {
  local type ep username resp code message username_sql
  type="$(pick_type)"
  [[ -z "$type" ]] && { echo "Tipe tidak valid."; return; }
  ep="$(endpoint_unlock "$type")"
  [[ -z "$ep" ]] && { echo "Endpoint unlock tidak ada."; return; }
  username="$(pick_locked_username "$type")" || return
  echo "Unlock akun: ${username}"
  resp="$(api_call "PATCH" "${ep}/${username}")"
  code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
  message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
  if [[ "${code}" != "200" ]]; then
    echo "Gagal unlock akun ${type^^}: ${message}"
    return
  fi
  username_sql="${username//\'/''}"
  if [[ "${type}" == "ssh" || "${type}" == "zivpn" ]]; then
    # Manual unlock harus langsung sinkron dengan checker:
    # - percepat release lock tmp (drop rules / temp lock table)
    # Jangan paksa restart/switch backend UDP saat unlock manual.
    sqlite3 "${DB_PATH}" "UPDATE temp_ip_locks SET locked_until=0 WHERE account_type='ssh' AND LOWER(username)=LOWER('${username_sql}');" >/dev/null 2>&1 || true
    systemctl start sc-1forcr-iplimit.service >/dev/null 2>&1 || true
    systemctl restart sc-1forcr-iplimit.timer >/dev/null 2>&1 || true
  fi
  echo "Akun ${type^^} '${username}' berhasil di-unlock."
  telegram_notify_action "UNLOCK" "${type}" "${username}"
}

unlock_all_accounts() {
  local ans type table ep rows username resp code message ok_count fail_count total_count username_sql
  echo "Unlock semua akun LOCK/LOCK_TMP/LOCK_QUOTA (SSH/VMESS/VLESS/TROJAN)."
  if ! prompt_input ans "Lanjutkan? [y/N]: "; then
    return
  fi
  ans="$(echo "${ans}" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ "${ans}" != "y" && "${ans}" != "yes" ]] && { echo "Dibatalkan."; return; }

  ok_count=0
  fail_count=0
  total_count=0

  for type in ssh vmess vless trojan; do
    table="$(account_table_by_type "${type}")"
    ep="$(endpoint_unlock "${type}")"
    [[ -z "${table}" || -z "${ep}" ]] && continue

    rows="$(sqlite3 "${DB_PATH}" "
      SELECT username FROM (
        SELECT username FROM ${table}
        WHERE UPPER(TRIM(COALESCE(status,''))) IN ('LOCK','LOCK_TMP','LOCK_QUOTA')
        UNION
        SELECT username FROM temp_ip_locks
        WHERE account_type='${type}' AND locked_until > strftime('%s','now')
      ) ORDER BY username;
    " 2>/dev/null || true)"
    [[ -z "${rows}" ]] && continue

    while IFS= read -r username; do
      username="$(echo "${username}" | xargs)"
      [[ -z "${username}" ]] && continue
      total_count=$((total_count + 1))
      echo "Unlock ${type^^}: ${username}"
      resp="$(api_call "PATCH" "${ep}/${username}")"
      code="$(echo "${resp}" | jq -r '.meta.code // empty' 2>/dev/null || true)"
      message="$(echo "${resp}" | jq -r '.meta.message // .message // "unknown error"' 2>/dev/null || echo "unknown error")"
      if [[ "${code}" == "200" ]]; then
        ok_count=$((ok_count + 1))
        telegram_notify_action "UNLOCK" "${type}" "${username}"
        if [[ "${type}" == "ssh" ]]; then
          username_sql="${username//\'/''}"
          sqlite3 "${DB_PATH}" "UPDATE temp_ip_locks SET locked_until=0 WHERE account_type='ssh' AND LOWER(username)=LOWER('${username_sql}');" >/dev/null 2>&1 || true
        fi
      else
        fail_count=$((fail_count + 1))
        echo "  Gagal: ${message}"
      fi
    done <<< "${rows}"
  done

  if [[ "${total_count}" -eq 0 ]]; then
    echo "Tidak ada akun LOCK/LOCK_TMP/LOCK_QUOTA yang perlu di-unlock."
    return
  fi

  systemctl start sc-1forcr-iplimit.service >/dev/null 2>&1 || true
  systemctl restart sc-1forcr-iplimit.timer >/dev/null 2>&1 || true

  echo "Selesai unlock massal."
  echo "Total : ${total_count}"
  echo "Sukses: ${ok_count}"
  echo "Gagal : ${fail_count}"
}

list_accounts() {
  print_account_table_rows() {
    local table="$1" title="$2" mode="${3:-active}" acct_type trial_expr where rows total active_total trial_total expired_total active_where expired_where rem_expr
    acct_type="$(account_type_for_table "${table}")"
    trial_expr="(LOWER(username) LIKE 'trial%' OR EXISTS (SELECT 1 FROM account_trial_flags f WHERE f.account_type='${acct_type}' AND LOWER(f.username)=LOWER(${table}.username)))"
    active_where="$(account_active_where_expr)"
    expired_where="$(account_expired_where_expr)"
    case "${mode}" in
      trial)
        where="WHERE ${trial_expr}"
        ;;
      expired)
        where="WHERE (${expired_where}) AND NOT ${trial_expr}"
        ;;
      all)
        where=""
        ;;
      active|*)
        where="WHERE ${active_where} AND NOT ${trial_expr}"
        ;;
    esac
    rem_expr="$(account_remaining_minutes_expr)"
    rows="$(sqlite3 -separator '|' "$DB_PATH" \
      "SELECT username, ${rem_expr}, UPPER(TRIM(COALESCE(status,''))), CAST(COALESCE(limitip,0) AS INTEGER), CAST(COALESCE(quota,0) AS INTEGER), CASE WHEN ${trial_expr} THEN 'TRIAL' ELSE 'REGULER' END FROM ${table} ${where} ORDER BY username;" 2>/dev/null || true)"
    total="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM ${table};" 2>/dev/null || echo 0)"
    active_total="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM ${table} WHERE ${active_where} AND NOT ${trial_expr};" 2>/dev/null || echo 0)"
    trial_total="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM ${table} WHERE ${trial_expr};" 2>/dev/null || echo 0)"
    expired_total="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM ${table} WHERE (${expired_where}) AND NOT ${trial_expr};" 2>/dev/null || echo 0)"
    draw_menu_header "LIST AKUN ${title} - ${mode^^}"
    echo "Summary: aktif=${active_total:-0} | trial=${trial_total:-0} | expired=${expired_total:-0} | total_db=${total:-0}"
    printf "%-4s %-22s %-10s %-8s %-7s %-24s\n" "NO" "USERNAME" "STATUS" "SISA" "LIM_IP" "QUOTA"
    printf "%-4s %-22s %-10s %-8s %-7s %-24s\n" "----" "----------------------" "----------" "--------" "-------" "------------------------"
    if [[ -z "${rows}" ]]; then
      echo "(kosong)"
      return
    fi
    local i=0 u sisa st lim quota kind sisa_human display_st quota_text
    while IFS='|' read -r u sisa st lim quota kind; do
      [[ -z "${u}" ]] && continue
      i=$((i + 1))
      sisa_human="$(format_remaining_from_minutes "${sisa:-0}")"
      display_st="${st:-AKTIF}"
      if [[ "${mode}" == "expired" && "${display_st}" != "EXPIRED" ]]; then
        display_st="EXPIRED"
      fi
      [[ "${kind}" == "TRIAL" && "${display_st}" == "AKTIF" ]] && display_st="TRIAL"
      quota_text="$(quota_usage_label_for_account "$(quota_type_from_table "${table}")" "${u}" "${quota:-0}")"
      printf "%-4s %-22s %-10s %-8s %-7s %-24s\n" "${i}" "${u}" "${display_st}" "${sisa_human}" "${lim:-0}" "${quota_text}"
    done <<< "${rows}"
  }
  print_account_table() {
    print_account_table_rows "$@" | ui_fx
  }

  draw_menu_panel "Pilih list akun:" \
    "1) SSH/ZIVPN/UDPHC aktif" \
    "2) VMESS aktif" \
    "3) VLESS aktif" \
    "4) TROJAN aktif" \
    "5) Semua aktif" \
    "6) Trial saja" \
    "7) Expired saja" \
    "8) Semua status (debug)" \
    "0) Kembali"
  prompt_input l "Input [0-8]: " || return
  clear

  case "${l}" in
    0) return ;;
    1)
      print_account_table "account_sshs" "SSH/ZIVPN" "active"
      ;;
    2)
      print_account_table "account_vmesses" "VMESS" "active"
      ;;
    3)
      print_account_table "account_vlesses" "VLESS" "active"
      ;;
    4)
      print_account_table "account_trojans" "TROJAN" "active"
      ;;
    5)
      print_account_table "account_sshs" "SSH/ZIVPN" "active"
      echo
      print_account_table "account_vmesses" "VMESS" "active"
      echo
      print_account_table "account_vlesses" "VLESS" "active"
      echo
      print_account_table "account_trojans" "TROJAN" "active"
      ;;
    6)
      print_account_table "account_sshs" "SSH/ZIVPN" "trial"
      echo
      print_account_table "account_vmesses" "VMESS" "trial"
      echo
      print_account_table "account_vlesses" "VLESS" "trial"
      echo
      print_account_table "account_trojans" "TROJAN" "trial"
      ;;
    7)
      print_account_table "account_sshs" "SSH/ZIVPN" "expired"
      echo
      print_account_table "account_vmesses" "VMESS" "expired"
      echo
      print_account_table "account_vlesses" "VLESS" "expired"
      echo
      print_account_table "account_trojans" "TROJAN" "expired"
      ;;
    8)
      print_account_table "account_sshs" "SSH/ZIVPN" "all"
      echo
      print_account_table "account_vmesses" "VMESS" "all"
      echo
      print_account_table "account_vlesses" "VLESS" "all"
      echo
      print_account_table "account_trojans" "TROJAN" "all"
      ;;
    *)
      echo "Pilihan tidak valid."
      ;;
  esac
}

show_account_detail() {
  local type mode username username_sql row d_quota_usage status_expr
  type="$(pick_type)"
  [[ -z "${type}" ]] && { echo "Tipe tidak valid."; return; }
  mode="$(pick_account_detail_mode)" || return
  username="$(pick_existing_username "${type}" "${mode}")" || return
  username_sql="${username//\'/''}"
  status_expr="$(account_effective_status_sql)"

  case "${type}" in
    ssh|zivpn)
      row="$(sqlite3 -separator '|' "${DB_PATH}" \
        "SELECT username,password,date_exp,${status_expr},CAST(COALESCE(quota,0) AS INTEGER),CAST(COALESCE(limitip,0) AS INTEGER) FROM account_sshs WHERE LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"
      if [[ -z "${row}" ]]; then
        echo "Data akun tidak ditemukan."
        return
      fi
      IFS='|' read -r d_user d_pass d_exp d_status d_quota d_limit <<< "${row}"
      d_quota_usage="$(quota_usage_label_for_account "ssh" "${d_user}" "${d_quota}")"
      cat <<EOT_SSH_DETAIL | ui_fx
=============================
 DETAIL AKUN ${type^^}
=============================
Username     : ${d_user}
Password     : ${d_pass}
Expired      : ${d_exp}
Status       : ${d_status}
Quota        : $(quota_limit_label "${d_quota}")
Quota Pakai  : ${d_quota_usage}
Limit IP     : ${d_limit}
Host         : ${DOMAIN}
SSH WS       : ${DOMAIN}:80@${d_user}:${d_pass}
SSH SSL      : ${DOMAIN}:443@${d_user}:${d_pass}
EOT_SSH_DETAIL
      ;;
    vmess)
      row="$(sqlite3 -separator '|' "${DB_PATH}" \
        "SELECT username,uuid,date_exp,${status_expr},CAST(COALESCE(quota,0) AS INTEGER),CAST(COALESCE(limitip,0) AS INTEGER) FROM account_vmesses WHERE LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"
      if [[ -z "${row}" ]]; then
        echo "Data akun tidak ditemukan."
        return
      fi
      IFS='|' read -r d_user d_uuid d_exp d_status d_quota d_limit <<< "${row}"
      d_quota_usage="$(quota_usage_label_for_account "vmess" "${d_user}" "${d_quota}")"
      vmess_tls="$(printf '{"v":"2","ps":"%s","add":"%s","port":"443","id":"%s","aid":"0","net":"ws","type":"none","host":"%s","path":"/vmess","tls":"tls","sni":"%s"}' "${d_user}" "${DOMAIN}" "${d_uuid}" "${DOMAIN}" "${DOMAIN}" | base64 -w 0 2>/dev/null || true)"
      vmess_ntls="$(printf '{"v":"2","ps":"%s","add":"%s","port":"80","id":"%s","aid":"0","net":"ws","type":"none","host":"%s","path":"/vmess","tls":"none","sni":"%s"}' "${d_user}" "${DOMAIN}" "${d_uuid}" "${DOMAIN}" "${DOMAIN}" | base64 -w 0 2>/dev/null || true)"
      cat <<EOT_VMESS_DETAIL | ui_fx
=============================
 DETAIL AKUN VMESS
=============================
Username     : ${d_user}
UUID         : ${d_uuid}
Expired      : ${d_exp}
Status       : ${d_status}
Quota        : $(quota_limit_label "${d_quota}")
Quota Pakai  : ${d_quota_usage}
Limit IP     : ${d_limit}
Host         : ${DOMAIN}
Link TLS     : vmess://${vmess_tls}
Link NON TLS : vmess://${vmess_ntls}
EOT_VMESS_DETAIL
      ;;
    vless)
      row="$(sqlite3 -separator '|' "${DB_PATH}" \
        "SELECT username,uuid,date_exp,${status_expr},CAST(COALESCE(quota,0) AS INTEGER),CAST(COALESCE(limitip,0) AS INTEGER) FROM account_vlesses WHERE LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"
      if [[ -z "${row}" ]]; then
        echo "Data akun tidak ditemukan."
        return
      fi
      IFS='|' read -r d_user d_uuid d_exp d_status d_quota d_limit <<< "${row}"
      d_quota_usage="$(quota_usage_label_for_account "vless" "${d_user}" "${d_quota}")"
      cat <<EOT_VLESS_DETAIL | ui_fx
=============================
 DETAIL AKUN VLESS
=============================
Username     : ${d_user}
UUID         : ${d_uuid}
Expired      : ${d_exp}
Status       : ${d_status}
Quota        : $(quota_limit_label "${d_quota}")
Quota Pakai  : ${d_quota_usage}
Limit IP     : ${d_limit}
Host         : ${DOMAIN}
Link TLS     : vless://${d_uuid}@${DOMAIN}:443?type=ws&path=%2Fvless&security=tls&sni=${DOMAIN}&host=${DOMAIN}&encryption=none#${d_user}
Link NON TLS : vless://${d_uuid}@${DOMAIN}:80?type=ws&path=%2Fvless&security=none&host=${DOMAIN}&encryption=none#${d_user}
EOT_VLESS_DETAIL
      ;;
    trojan)
      row="$(sqlite3 -separator '|' "${DB_PATH}" \
        "SELECT username,password,date_exp,${status_expr},CAST(COALESCE(quota,0) AS INTEGER),CAST(COALESCE(limitip,0) AS INTEGER) FROM account_trojans WHERE LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"
      if [[ -z "${row}" ]]; then
        echo "Data akun tidak ditemukan."
        return
      fi
      IFS='|' read -r d_user d_pass d_exp d_status d_quota d_limit <<< "${row}"
      d_quota_usage="$(quota_usage_label_for_account "trojan" "${d_user}" "${d_quota}")"
      cat <<EOT_TROJAN_DETAIL | ui_fx
=============================
 DETAIL AKUN TROJAN
=============================
Username     : ${d_user}
Password     : ${d_pass}
Expired      : ${d_exp}
Status       : ${d_status}
Quota        : $(quota_limit_label "${d_quota}")
Quota Pakai  : ${d_quota_usage}
Limit IP     : ${d_limit}
Host         : ${DOMAIN}
Link TLS     : trojan://${d_pass}@${DOMAIN}:443?type=ws&path=%2Ftrojan&security=tls&sni=${DOMAIN}&host=${DOMAIN}&alpn=http%2F1.1#${d_user}
Link NON TLS : trojan://${d_pass}@${DOMAIN}:80?type=ws&path=%2Ftrojan&security=none&host=${DOMAIN}#${d_user}
EOT_TROJAN_DETAIL
      ;;
    *)
      echo "Tipe tidak valid."
      ;;
  esac
}

show_account_quota_info() {
  local type table username username_sql usage_type row quota status used_bytes quota_bytes used_label limit_label remain_bytes remain_label locked locked_at percent
  type="$(pick_type)"
  [[ -z "${type}" ]] && { echo "Tipe tidak valid."; return; }
  table="$(account_table_by_type "${type}")"
  [[ -z "${table}" ]] && { echo "Tabel akun tidak ditemukan."; return; }
  username="$(pick_existing_username "${type}")" || return
  username_sql="${username//\'/''}"
  usage_type="$(quota_type_key "${type}")"

  row="$(sqlite3 -separator '|' "${DB_PATH}" \
    "SELECT username, CAST(COALESCE(quota,0) AS INTEGER), UPPER(TRIM(COALESCE(status,''))) FROM ${table} WHERE LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"
  if [[ -z "${row}" ]]; then
    echo "Data akun tidak ditemukan."
    return
  fi

  IFS='|' read -r d_user quota status <<< "${row}"
  used_bytes="$(quota_usage_bytes_for_account "${usage_type}" "${d_user}")"
  [[ "${used_bytes}" =~ ^[0-9]+$ ]] || used_bytes="0"
  quota_bytes="$(( ${quota:-0} * 1024 * 1024 * 1024 ))"
  used_label="$(bytes_to_gb_label "${used_bytes}")"
  limit_label="$(quota_limit_label "${quota:-0}")"
  if [[ "${quota:-0}" -le 0 ]]; then
    remain_label="Unlimited"
    percent="0%"
  else
    if (( used_bytes >= quota_bytes )); then
      remain_bytes=0
    else
      remain_bytes=$((quota_bytes - used_bytes))
    fi
    remain_label="$(bytes_to_gb_label "${remain_bytes}")"
    percent="$(awk -v u="${used_bytes}" -v q="${quota_bytes}" 'BEGIN { if (q <= 0) print "0%"; else printf "%.1f%%", (u/q)*100 }')"
  fi
  locked="$(sqlite3 "${DB_PATH}" "SELECT used_bytes FROM account_quota_locks WHERE account_type='${usage_type}' AND LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"
  locked_at="$(sqlite3 "${DB_PATH}" "SELECT datetime(locked_at,'unixepoch','localtime') FROM account_quota_locks WHERE account_type='${usage_type}' AND LOWER(username)=LOWER('${username_sql}') LIMIT 1;" 2>/dev/null || true)"

  cat <<EOT_QUOTA_INFO | ui_fx
=============================
 INFO QUOTA AKUN ${type^^}
=============================
Username     : ${d_user}
Status       : ${status:-AKTIF}
Quota Pakai  : ${used_label} / ${limit_label}
Sisa Quota   : ${remain_label}
Persentase   : ${percent}
Lock Quota   : $([[ -n "${locked}" ]] && echo "YA" || echo "TIDAK")
Locked At    : ${locked_at:-"-"}
=============================
EOT_QUOTA_INFO
}

account_menu_pause() {
  echo
  menu_pause "Enter untuk kembali..."
}

account_lifetime_menu() {
  local choice
  while true; do
    clear
    draw_menu_panel "BUAT & MASA AKTIF" \
      "1) Add Account" \
      "2) Trial Account (1 jam)" \
      "3) Renew Account Aktif" \
      "4) Recovery Account Expired" \
      "5) Tambah Masa Aktif Semua Akun" \
      "0) Kembali"
    prompt_input choice "Pilih menu [0-5]: " || return
    clear
    case "${choice}" in
      1) create_account || true ;;
      2) create_trial_account || true ;;
      3) renew_account || true ;;
      4) recover_expired_account || true ;;
      5) extend_expired_all_accounts || true ;;
      0) return ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    account_menu_pause
  done
}

account_edit_menu() {
  local choice
  while true; do
    clear
    draw_menu_panel "EDIT ACCOUNT" \
      "1) Edit Limit IP" \
      "2) Edit Limit IP Semua Akun" \
      "3) Edit UUID Xray" \
      "4) Ganti Password SSH" \
      "5) Ganti Password Semua SSH" \
      "6) Edit Quota" \
      "7) Edit Quota Semua Akun" \
      "0) Kembali"
    prompt_input choice "Pilih menu [0-7]: " || return
    clear
    case "${choice}" in
      1) edit_limit_ip_account || true ;;
      2) edit_limit_ip_all_accounts || true ;;
      3) edit_uuid_xray_account || true ;;
      4) change_ssh_password_account || true ;;
      5) change_ssh_password_all_accounts || true ;;
      6) edit_quota_account || true ;;
      7) edit_quota_all_accounts || true ;;
      0) return ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    account_menu_pause
  done
}

account_delete_menu() {
  local choice
  while true; do
    clear
    draw_menu_panel "HAPUS ACCOUNT" \
      "1) Hapus Account Aktif" \
      "2) Hapus Account Expired" \
      "3) Hapus Semua Account Expired" \
      "0) Kembali"
    prompt_input choice "Pilih menu [0-3]: " || return
    clear
    case "${choice}" in
      1) delete_account "nonexpired" || true ;;
      2) delete_account "expired" || true ;;
      3) delete_all_expired_accounts || true ;;
      0) return ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    account_menu_pause
  done
}

account_info_menu() {
  local choice
  while true; do
    clear
    draw_menu_panel "INFORMASI ACCOUNT" \
      "1) List Account" \
      "2) Lihat Detail Account" \
      "3) Info Quota Akun" \
      "0) Kembali"
    prompt_input choice "Pilih menu [0-3]: " || return
    clear
    case "${choice}" in
      1) list_accounts || true ;;
      2) show_account_detail || true ;;
      3) show_account_quota_info || true ;;
      0) return ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    account_menu_pause
  done
}

account_lock_menu() {
  local choice
  while true; do
    clear
    draw_menu_panel "LOCK & UNLOCK" \
      "1) Lock Account" \
      "2) Unlock Account" \
      "3) Unlock Semua Akun" \
      "0) Kembali"
    prompt_input choice "Pilih menu [0-3]: " || return
    clear
    case "${choice}" in
      1) lock_account || true ;;
      2) unlock_account || true ;;
      3) unlock_all_accounts || true ;;
      0) return ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    account_menu_pause
  done
}

akun_menu() {
  local choice
  while true; do
    clear
    draw_menu_panel "MENU AKUN" \
      "1) Buat & Masa Aktif" \
      "2) Edit Account" \
      "3) Hapus Account" \
      "4) Informasi Account" \
      "5) Lock & Unlock" \
      "0) Kembali"
    prompt_input choice "Pilih menu [0-5]: " || return
    case "${choice}" in
      1) account_lifetime_menu ;;
      2) account_edit_menu ;;
      3) account_delete_menu ;;
      4) account_info_menu ;;
      5) account_lock_menu ;;
      0) return ;;
      *) echo "Pilihan tidak valid."; account_menu_pause ;;
    esac
  done
}

set_iplimit_checker_config_menu() {
  local current_interval current_lock interval_in lock_in
  current_interval="$(echo "${IPLIMIT_CHECK_INTERVAL_MINUTES:-5}" | tr -cd '0-9')"
  current_lock="$(echo "${IPLIMIT_LOCK_MINUTES:-15}" | tr -cd '0-9')"
  [[ -z "${current_interval}" ]] && current_interval="5"
  [[ -z "${current_lock}" ]] && current_lock="15"

  draw_menu_header "SETTING IP LIMIT CHECKER"
  echo "Interval checker saat ini : ${current_interval} menit"
  echo "Durasi unlock (lock tmp)  : ${current_lock} menit"
  echo
  echo "Kosongkan input untuk mempertahankan nilai lama."
  echo "Ketik 'batal' untuk kembali."

  if ! prompt_input interval_in "Interval checker (menit) [${current_interval}]: "; then
    return
  fi
  [[ "${interval_in,,}" == "batal" ]] && return
  interval_in="${interval_in:-${current_interval}}"
  if [[ ! "${interval_in}" =~ ^[0-9]+$ || "${interval_in}" -lt 1 || "${interval_in}" -gt 1440 ]]; then
    echo "Interval checker harus angka 1-1440 menit."
    return
  fi

  if ! prompt_input lock_in "Durasi unlock otomatis (menit) [${current_lock}]: "; then
    return
  fi
  [[ "${lock_in,,}" == "batal" ]] && return
  lock_in="${lock_in:-${current_lock}}"
  if [[ ! "${lock_in}" =~ ^[0-9]+$ || "${lock_in}" -lt 1 || "${lock_in}" -gt 10080 ]]; then
    echo "Durasi unlock harus angka 1-10080 menit."
    return
  fi

  IPLIMIT_CHECK_INTERVAL_MINUTES="${interval_in}"
  IPLIMIT_LOCK_MINUTES="${lock_in}"

  update_sc_env_var "IPLIMIT_CHECK_INTERVAL_MINUTES" "${IPLIMIT_CHECK_INTERVAL_MINUTES}"
  update_sc_env_var "IPLIMIT_LOCK_MINUTES" "${IPLIMIT_LOCK_MINUTES}"
  update_app_env_var "IPLIMIT_CHECK_INTERVAL_MINUTES" "${IPLIMIT_CHECK_INTERVAL_MINUTES}"
  update_app_env_var "IPLIMIT_LOCK_MINUTES" "${IPLIMIT_LOCK_MINUTES}"

  write_iplimit_timer_unit "${IPLIMIT_CHECK_INTERVAL_MINUTES}"
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now sc-1forcr-iplimit.timer >/dev/null 2>&1 || true
  systemctl restart sc-1forcr-iplimit.timer >/dev/null 2>&1 || true
  systemctl start sc-1forcr-iplimit.service >/dev/null 2>&1 || true

  echo
  echo "Berhasil update checker limit IP:"
  echo "- Interval checker : ${IPLIMIT_CHECK_INTERVAL_MINUTES} menit"
  echo "- Durasi unlock    : ${IPLIMIT_LOCK_MINUTES} menit"
}

set_autolock_realtime_tuning_menu() {
  local cur_interval cur_lock cur_xray_recent cur_xray_active cur_xray_hits cur_zivpn_active cur_zivpn_handoff
  local in_interval in_lock in_xray_recent in_xray_active in_xray_hits in_zivpn_active in_zivpn_handoff
  local def_interval def_lock def_xray_recent def_xray_active def_xray_hits def_zivpn_active def_zivpn_handoff

  # Default rekomendasi (balanced realtime + minim false-positive).
  def_interval="3"
  def_lock="15"
  def_xray_recent="5"
  def_xray_active="60"
  def_xray_hits="2"
  def_zivpn_active="90"
  def_zivpn_handoff="90"

  cur_interval="$(echo "${IPLIMIT_CHECK_INTERVAL_MINUTES:-5}" | tr -cd '0-9')"
  cur_lock="$(echo "${IPLIMIT_LOCK_MINUTES:-15}" | tr -cd '0-9')"
  cur_xray_recent="$(echo "${XRAY_RECENT_WINDOW_MINUTES:-5}" | tr -cd '0-9')"
  cur_xray_active="$(echo "${XRAY_ACTIVE_WINDOW_SECONDS:-60}" | tr -cd '0-9')"
  cur_xray_hits="$(echo "${XRAY_MIN_HITS_PER_IP:-2}" | tr -cd '0-9')"
  cur_zivpn_active="$(echo "${ZIVPN_ACTIVE_WINDOW_SECONDS:-90}" | tr -cd '0-9')"
  cur_zivpn_handoff="$(echo "${ZIVPN_HANDOFF_GRACE_SECONDS:-90}" | tr -cd '0-9')"

  [[ -z "${cur_interval}" ]] && cur_interval="3"
  [[ -z "${cur_lock}" ]] && cur_lock="15"
  [[ -z "${cur_xray_recent}" ]] && cur_xray_recent="5"
  [[ -z "${cur_xray_active}" ]] && cur_xray_active="60"
  [[ -z "${cur_xray_hits}" ]] && cur_xray_hits="2"
  [[ -z "${cur_zivpn_active}" ]] && cur_zivpn_active="90"
  [[ -z "${cur_zivpn_handoff}" ]] && cur_zivpn_handoff="90"

  draw_menu_header "SETTING AUTO LOCK REALTIME"
  echo "Nilai saat ini:"
  echo "- Interval checker (menit)   : ${cur_interval}"
  echo "- Durasi unlock lock tmp (m) : ${cur_lock}"
  echo "- XRAY recent window (menit) : ${cur_xray_recent}"
  echo "- XRAY active window (detik) : ${cur_xray_active}"
  echo "- XRAY min hits per IP       : ${cur_xray_hits}"
  echo "- ZIVPN active window (detik): ${cur_zivpn_active}"
  echo "- ZIVPN handoff grace (detik): ${cur_zivpn_handoff}"
  echo
  echo "Fungsi parameter:"
  echo "- Interval checker: seberapa sering auto-lock dieksekusi (timer)."
  echo "- Durasi unlock lock tmp: lama akun berada di status LOCK_TMP sebelum auto unlock."
  echo "- XRAY recent window: jangkauan log XRAY yang discan."
  echo "- XRAY active window: batas umur aktivitas untuk dianggap masih online."
  echo "- XRAY min hits per IP: minimal jumlah hit log agar IP dihitung valid."
  echo "- ZIVPN active window: batas umur sesi live ZIVPN yang masih dihitung aktif."
  echo "- ZIVPN handoff grace: toleransi perpindahan IP mobile agar tidak false multi-login."
  echo
  echo "Catatan false positive:"
  echo "- False positive = user normal terdeteksi melanggar padahal tidak."
  echo "- Contoh: 1 HP ganti IP cepat (handoff), reconnect burst, atau jejak log lama"
  echo "  masih terbaca di window aktif lalu dianggap multi-login."
  echo "- Jika sering false positive: naikkan XRAY active window, naikkan XRAY min hits,"
  echo "  dan/atau naikkan ZIVPN handoff grace."
  echo
  echo "Rekomendasi:"
  echo "- Aman umum (disarankan): interval=${def_interval}, lock=${def_lock}, xray_recent=${def_xray_recent}, xray_active=${def_xray_active}, xray_hits=${def_xray_hits}, zivpn_active=${def_zivpn_active}, handoff=${def_zivpn_handoff}"
  echo "- Agresif: interval=1, xray_active=30, xray_hits=1 (CPU lebih tinggi, resiko false-positive naik)."
  echo "- Stabil tinggi trafik: interval=3, xray_active=90, xray_hits=2."
  echo
  echo "Kosongkan input (Enter) untuk pakai DEFAULT REKOMENDASI."
  echo "Ketik 'batal' untuk keluar."

  if ! prompt_input in_interval "Interval checker (menit) [${def_interval}]: "; then return; fi
  [[ "${in_interval,,}" == "batal" ]] && return
  in_interval="${in_interval:-${def_interval}}"
  if [[ ! "${in_interval}" =~ ^[0-9]+$ || "${in_interval}" -lt 1 || "${in_interval}" -gt 1440 ]]; then
    echo "Interval checker harus angka 1-1440 menit."
    return
  fi

  if ! prompt_input in_lock "Durasi unlock lock tmp (menit) [${def_lock}]: "; then return; fi
  [[ "${in_lock,,}" == "batal" ]] && return
  in_lock="${in_lock:-${def_lock}}"
  if [[ ! "${in_lock}" =~ ^[0-9]+$ || "${in_lock}" -lt 1 || "${in_lock}" -gt 10080 ]]; then
    echo "Durasi unlock harus angka 1-10080 menit."
    return
  fi

  if ! prompt_input in_xray_recent "XRAY recent window (menit) [${def_xray_recent}]: "; then return; fi
  [[ "${in_xray_recent,,}" == "batal" ]] && return
  in_xray_recent="${in_xray_recent:-${def_xray_recent}}"
  if [[ ! "${in_xray_recent}" =~ ^[0-9]+$ || "${in_xray_recent}" -lt 5 || "${in_xray_recent}" -gt 1440 ]]; then
    echo "XRAY recent window harus angka 5-1440 menit."
    return
  fi

  if ! prompt_input in_xray_active "XRAY active window (detik) [${def_xray_active}]: "; then return; fi
  [[ "${in_xray_active,,}" == "batal" ]] && return
  in_xray_active="${in_xray_active:-${def_xray_active}}"
  if [[ ! "${in_xray_active}" =~ ^[0-9]+$ || "${in_xray_active}" -lt 30 || "${in_xray_active}" -gt 1800 ]]; then
    echo "XRAY active window harus angka 30-1800 detik."
    return
  fi

  if ! prompt_input in_xray_hits "XRAY min hits per IP [${def_xray_hits}]: "; then return; fi
  [[ "${in_xray_hits,,}" == "batal" ]] && return
  in_xray_hits="${in_xray_hits:-${def_xray_hits}}"
  if [[ ! "${in_xray_hits}" =~ ^[0-9]+$ || "${in_xray_hits}" -lt 1 || "${in_xray_hits}" -gt 20 ]]; then
    echo "XRAY min hits per IP harus angka 1-20."
    return
  fi

  if ! prompt_input in_zivpn_active "ZIVPN active window (detik) [${def_zivpn_active}]: "; then return; fi
  [[ "${in_zivpn_active,,}" == "batal" ]] && return
  in_zivpn_active="${in_zivpn_active:-${def_zivpn_active}}"
  if [[ ! "${in_zivpn_active}" =~ ^[0-9]+$ || "${in_zivpn_active}" -lt 20 || "${in_zivpn_active}" -gt 1800 ]]; then
    echo "ZIVPN active window harus angka 20-1800 detik."
    return
  fi

  if ! prompt_input in_zivpn_handoff "ZIVPN handoff grace (detik) [${def_zivpn_handoff}]: "; then return; fi
  [[ "${in_zivpn_handoff,,}" == "batal" ]] && return
  in_zivpn_handoff="${in_zivpn_handoff:-${def_zivpn_handoff}}"
  if [[ ! "${in_zivpn_handoff}" =~ ^[0-9]+$ || "${in_zivpn_handoff}" -lt 3 || "${in_zivpn_handoff}" -gt 120 ]]; then
    echo "ZIVPN handoff grace harus angka 3-120 detik."
    return
  fi

  IPLIMIT_CHECK_INTERVAL_MINUTES="${in_interval}"
  IPLIMIT_LOCK_MINUTES="${in_lock}"
  XRAY_RECENT_WINDOW_MINUTES="${in_xray_recent}"
  XRAY_ACTIVE_WINDOW_SECONDS="${in_xray_active}"
  XRAY_MIN_HITS_PER_IP="${in_xray_hits}"
  ZIVPN_ACTIVE_WINDOW_SECONDS="${in_zivpn_active}"
  ZIVPN_HANDOFF_GRACE_SECONDS="${in_zivpn_handoff}"

  update_sc_env_var "IPLIMIT_CHECK_INTERVAL_MINUTES" "${IPLIMIT_CHECK_INTERVAL_MINUTES}"
  update_sc_env_var "IPLIMIT_LOCK_MINUTES" "${IPLIMIT_LOCK_MINUTES}"
  update_sc_env_var "XRAY_RECENT_WINDOW_MINUTES" "${XRAY_RECENT_WINDOW_MINUTES}"
  update_sc_env_var "XRAY_ACTIVE_WINDOW_SECONDS" "${XRAY_ACTIVE_WINDOW_SECONDS}"
  update_sc_env_var "XRAY_MIN_HITS_PER_IP" "${XRAY_MIN_HITS_PER_IP}"
  update_sc_env_var "ZIVPN_ACTIVE_WINDOW_SECONDS" "${ZIVPN_ACTIVE_WINDOW_SECONDS}"
  update_sc_env_var "ZIVPN_HANDOFF_GRACE_SECONDS" "${ZIVPN_HANDOFF_GRACE_SECONDS}"

  update_app_env_var "IPLIMIT_CHECK_INTERVAL_MINUTES" "${IPLIMIT_CHECK_INTERVAL_MINUTES}"
  update_app_env_var "IPLIMIT_LOCK_MINUTES" "${IPLIMIT_LOCK_MINUTES}"
  update_app_env_var "XRAY_RECENT_WINDOW_MINUTES" "${XRAY_RECENT_WINDOW_MINUTES}"
  update_app_env_var "XRAY_ACTIVE_WINDOW_SECONDS" "${XRAY_ACTIVE_WINDOW_SECONDS}"
  update_app_env_var "XRAY_MIN_HITS_PER_IP" "${XRAY_MIN_HITS_PER_IP}"
  update_app_env_var "ZIVPN_ACTIVE_WINDOW_SECONDS" "${ZIVPN_ACTIVE_WINDOW_SECONDS}"
  update_app_env_var "ZIVPN_HANDOFF_GRACE_SECONDS" "${ZIVPN_HANDOFF_GRACE_SECONDS}"

  write_iplimit_timer_unit "${IPLIMIT_CHECK_INTERVAL_MINUTES}"
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now sc-1forcr-iplimit.timer >/dev/null 2>&1 || true
  systemctl restart sc-1forcr-iplimit.timer >/dev/null 2>&1 || true
  systemctl start sc-1forcr-iplimit.service >/dev/null 2>&1 || true
  systemctl restart sc-1forcr-api >/dev/null 2>&1 || true

  echo
  echo "Berhasil update tuning auto-lock:"
  echo "- Interval checker            : ${IPLIMIT_CHECK_INTERVAL_MINUTES} menit"
  echo "- Durasi unlock lock tmp      : ${IPLIMIT_LOCK_MINUTES} menit"
  echo "- XRAY recent window          : ${XRAY_RECENT_WINDOW_MINUTES} menit"
  echo "- XRAY active window          : ${XRAY_ACTIVE_WINDOW_SECONDS} detik"
  echo "- XRAY min hits per IP        : ${XRAY_MIN_HITS_PER_IP}"
  echo "- ZIVPN active window         : ${ZIVPN_ACTIVE_WINDOW_SECONDS} detik"
  echo "- ZIVPN handoff grace         : ${ZIVPN_HANDOFF_GRACE_SECONDS} detik"
}

online_notify_status_value() {
  local key="$1"
  awk -F= -v k="${key}" '$1 == k { print substr($0, index($0, "=") + 1); exit }' \
    /var/lib/sc-1forcr/online-notify.status 2>/dev/null || true
}

# Hapus jeda retry setelah gagal kirim, supaya setting baru langsung dicoba.
reset_online_notify_retry() {
  rm -f /var/lib/sc-1forcr/online-notify.status >/dev/null 2>&1 || true
}

show_online_notify_delivery_status() {
  local last_sent result retry_at error
  last_sent="$(tr -cd '0-9' 2>/dev/null < /var/lib/sc-1forcr/online-notify.last || true)"
  result="$(online_notify_status_value ONLINE_NOTIFY_LAST_RESULT)"
  retry_at="$(online_notify_status_value ONLINE_NOTIFY_RETRY_AFTER | tr -cd '0-9')"
  error="$(online_notify_status_value ONLINE_NOTIFY_LAST_ERROR)"
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    echo "Pengiriman         : TIDAK JALAN, Token/Chat ID BOT belum diisi (Tools > 5)"
  fi
  if [[ "${last_sent}" =~ ^[0-9]+$ && "${last_sent}" -gt 0 ]]; then
    echo "Terakhir terkirim  : $(date -d "@${last_sent}" '+%F %T' 2>/dev/null || echo "${last_sent}")"
  else
    echo "Terakhir terkirim  : belum pernah"
  fi
  if [[ "${result}" == "gagal" ]]; then
    echo "Percobaan terakhir : GAGAL, ${error:-tanpa keterangan}"
    if [[ "${retry_at}" =~ ^[0-9]+$ ]]; then
      echo "Dicoba lagi        : $(date -d "@${retry_at}" '+%F %T' 2>/dev/null || echo "${retry_at}")"
    fi
  fi
}

set_online_notify_config_menu() {
  local current_enable current_interval current_window enable_in interval_in window_in
  current_enable="${ONLINE_NOTIFY_ENABLE:-1}"
  [[ "${current_enable}" != "0" ]] && current_enable="1"
  current_interval="$(echo "${ONLINE_NOTIFY_INTERVAL_HOURS:-3}" | tr -cd '0-9')"
  current_window="$(echo "${ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS:-300}" | tr -cd '0-9')"
  [[ -z "${current_interval}" || "${current_interval}" -lt 1 || "${current_interval}" -gt 168 ]] && current_interval="3"
  [[ -z "${current_window}" || "${current_window}" -lt 60 || "${current_window}" -gt 86400 ]] && current_window="300"

  draw_menu_header "SETTING NOTIF AKUN ONLINE"
  echo "Status saat ini    : $([[ "${current_enable}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  echo "Interval saat ini  : ${current_interval} jam"
  echo "Window realtime    : ${current_window} detik (XRAY last seen)"
  show_online_notify_delivery_status
  echo
  echo "Kosongkan input untuk mempertahankan nilai lama."
  echo "Ketik 'batal' untuk kembali."

  if ! prompt_input enable_in "Aktifkan notif online? (1=aktif,0=nonaktif) [${current_enable}]: "; then
    return
  fi
  [[ "${enable_in,,}" == "batal" ]] && return
  enable_in="${enable_in:-${current_enable}}"
  case "${enable_in,,}" in
    1|on|yes|y) enable_in="1" ;;
    0|off|no|n) enable_in="0" ;;
    *)
      echo "Input status tidak valid. Gunakan 1 atau 0."
      return
      ;;
  esac

  if ! prompt_input interval_in "Interval notif (jam) [${current_interval}]: "; then
    return
  fi
  [[ "${interval_in,,}" == "batal" ]] && return
  interval_in="${interval_in:-${current_interval}}"
  if [[ ! "${interval_in}" =~ ^[0-9]+$ || "${interval_in}" -lt 1 || "${interval_in}" -gt 168 ]]; then
    echo "Interval notif harus angka 1-168 jam."
    return
  fi

  if ! prompt_input window_in "Window realtime XRAY (detik) [${current_window}]: "; then
    return
  fi
  [[ "${window_in,,}" == "batal" ]] && return
  window_in="${window_in:-${current_window}}"
  if [[ ! "${window_in}" =~ ^[0-9]+$ || "${window_in}" -lt 60 || "${window_in}" -gt 86400 ]]; then
    echo "Window realtime harus angka 60-86400 detik."
    return
  fi

  ONLINE_NOTIFY_ENABLE="${enable_in}"
  ONLINE_NOTIFY_INTERVAL_HOURS="${interval_in}"
  ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS="${window_in}"
  update_sc_env_var "ONLINE_NOTIFY_ENABLE" "${ONLINE_NOTIFY_ENABLE}"
  update_sc_env_var "ONLINE_NOTIFY_INTERVAL_HOURS" "${ONLINE_NOTIFY_INTERVAL_HOURS}"
  update_sc_env_var "ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS" "${ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS}"
  update_app_env_var "ONLINE_NOTIFY_ENABLE" "${ONLINE_NOTIFY_ENABLE}"
  update_app_env_var "ONLINE_NOTIFY_INTERVAL_HOURS" "${ONLINE_NOTIFY_INTERVAL_HOURS}"
  update_app_env_var "ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS" "${ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS}"
  write_online_notify_timer_unit "${ONLINE_NOTIFY_INTERVAL_HOURS}"
  reset_online_notify_retry

  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ "${ONLINE_NOTIFY_ENABLE}" == "1" ]]; then
    systemctl enable --now sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
    systemctl restart sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
    systemctl start sc-1forcr-online-notify.service >/dev/null 2>&1 || true
  else
    systemctl disable --now sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
  fi

  echo
  echo "Berhasil update notif akun online:"
  echo "- Status   : $([[ "${ONLINE_NOTIFY_ENABLE}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  echo "- Interval : ${ONLINE_NOTIFY_INTERVAL_HOURS} jam"
  echo "- Window   : ${ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS} detik"
}

trigger_online_notify_now() {
  local notify_bin
  notify_bin="/usr/local/sbin/sc-1forcr-online-notify"
  echo "Trigger notif akun online manual..."
  if [[ ! -x "${notify_bin}" ]]; then
    echo "Script notifier tidak ditemukan: ${notify_bin}"
    return 1
  fi
  local notify_err notify_rc
  notify_rc=0
  notify_err="$(ONLINE_NOTIFY_ENABLE=1 FORCE_ONLINE_NOTIFY=1 "${notify_bin}" 2>&1 >/dev/null)" || notify_rc=$?
  if [[ "${notify_rc}" -eq 0 && -z "${notify_err}" ]]; then
    echo "Notifikasi online berhasil dikirim ke Telegram."
    return 0
  fi
  echo "Gagal mengirim notifikasi online manual."
  [[ -n "${notify_err}" ]] && echo "${notify_err}"
  return 1
}

api_docs_nginx_snippet_path() {
  echo "/etc/nginx/snippets/sc-1forcr-api-docs.conf"
}

api_docs_web_root() {
  echo "/var/www/sc-1forcr-api-docs"
}

ensure_api_docs_nginx_include() {
  local conf tmp
  conf="/etc/nginx/sites-available/sc-1forcr.conf"
  [[ -f "${conf}" ]] || return 0
  tmp="$(mktemp)"
  awk '
    function brace_delta(text,   tmp, open_count, close_count) {
      tmp = text
      open_count = gsub(/\{/, "{", tmp)
      close_count = gsub(/\}/, "}", tmp)
      return open_count - close_count
    }
    function flush_server_block(   i, line, target, inserted, server_name_idx) {
      if (block_n < 1) return
      target = 0
      server_name_idx = 0
      for (i = 1; i <= block_n; i++) {
        line = block[i]
        if (line ~ /listen[[:space:]]+80;[[:space:]]*$/) target = 1
        if (line ~ /listen[[:space:]]+\[::\]:80;[[:space:]]*$/) target = 1
        if (line ~ /listen[[:space:]]+127\.0\.0\.1:8081[[:space:]]+http2;/) target = 1
        if (server_name_idx == 0 && line ~ /^[[:space:]]*server_name[[:space:]]+.*;[[:space:]]*$/) {
          server_name_idx = i
        }
      }

      inserted = 0
      for (i = 1; i <= block_n; i++) {
        line = block[i]
        if (line ~ /include[[:space:]]+\/etc\/nginx\/snippets\/sc-1forcr-api-docs\.conf;/) {
          continue
        }
        print line
        if (target && server_name_idx == i) {
          print "    include /etc/nginx/snippets/sc-1forcr-api-docs.conf;"
          inserted = 1
        }
        if (target && !inserted && server_name_idx == 0 && i == block_n && line ~ /^[[:space:]]*}[[:space:]]*$/) {
          print "    include /etc/nginx/snippets/sc-1forcr-api-docs.conf;"
          inserted = 1
        }
      }
      delete block
      block_n = 0
    }
    /^[[:space:]]*server[[:space:]]*\{/ {
      server_mode = 1
      brace = 1
      block_n = 1
      block[block_n] = $0
      next
    }
    server_mode {
      block[++block_n] = $0
      brace += brace_delta($0)
      if (brace <= 0) {
        flush_server_block()
        server_mode = 0
        brace = 0
      }
      next
    }
    { print }
    END {
      if (server_mode) {
        flush_server_block()
      }
    }
  ' "${conf}" > "${tmp}" && mv -f "${tmp}" "${conf}"
}

write_api_docs_index() {
  local web_root
  web_root="$(api_docs_web_root)"
  mkdir -p "${web_root}"
  cat > "${web_root}/index.html" <<'EOF'
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SC 1FORCR API Docs</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #111a2b;
      --panel-2: #0f1727;
      --line: #223047;
      --text: #e5eefc;
      --muted: #8ea2c5;
      --accent: #4fd1c5;
      --accent-2: #f59e0b;
      --danger: #ef4444;
      --ok: #22c55e;
      --shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
      --radius: 8px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.55 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(180deg, rgba(79, 209, 197, 0.04), transparent 24%),
        linear-gradient(180deg, #08101c 0%, #0b1220 100%);
      color: var(--text);
    }
    a { color: inherit; }
    button, input, code, pre { font: inherit; }
    .wrap {
      width: min(1240px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.7fr) minmax(280px, 0.95fr);
      gap: 20px;
      align-items: end;
      margin-bottom: 20px;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0;
      font-size: 12px;
      font-weight: 700;
    }
    h1 {
      margin: 0;
      font-size: 36px;
      line-height: 1.05;
    }
    .lede {
      margin: 10px 0 0;
      max-width: 68ch;
      color: var(--muted);
      font-size: 15px;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(17, 26, 43, 0.84);
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .meta {
      display: grid;
      gap: 10px;
    }
    .meta-row {
      display: grid;
      gap: 4px;
    }
    .meta-row span {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    code, pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    code {
      padding: 2px 6px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .quick {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 18px;
    }
    .chip {
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: rgba(17, 26, 43, 0.62);
    }
    .bar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      margin-bottom: 18px;
    }
    .search {
      width: 100%;
      min-width: 0;
      border-radius: var(--radius);
      border: 1px solid var(--line);
      background: rgba(17, 26, 43, 0.84);
      color: var(--text);
      padding: 12px 14px;
      outline: none;
    }
    .search:focus { border-color: rgba(79, 209, 197, 0.55); }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }
    .tab {
      border: 1px solid var(--line);
      background: rgba(17, 26, 43, 0.7);
      color: var(--muted);
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .tab.active {
      color: var(--text);
      border-color: rgba(79, 209, 197, 0.45);
      background: rgba(79, 209, 197, 0.12);
    }
    .section {
      margin-top: 18px;
    }
    .section h2 {
      margin: 0 0 10px;
      font-size: 18px;
      line-height: 1.25;
    }
    .section p.sub {
      margin: -2px 0 14px;
      color: var(--muted);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .route {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(17, 26, 43, 0.8);
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .route-top {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .method {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
      border: 1px solid transparent;
    }
    .m-get { background: rgba(34, 197, 94, 0.12); color: #8df0b1; border-color: rgba(34, 197, 94, 0.25); }
    .m-post { background: rgba(79, 209, 197, 0.12); color: #8ef0ea; border-color: rgba(79, 209, 197, 0.25); }
    .m-patch { background: rgba(245, 158, 11, 0.12); color: #ffd08a; border-color: rgba(245, 158, 11, 0.25); }
    .m-delete { background: rgba(239, 68, 68, 0.12); color: #ff9a9a; border-color: rgba(239, 68, 68, 0.25); }
    .tags {
      color: var(--muted);
      font-size: 12px;
    }
    .path {
      margin: 0 0 8px;
      font-size: 15px;
      font-weight: 700;
      word-break: break-word;
    }
    .desc {
      margin: 0 0 10px;
      color: var(--muted);
    }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .block .label {
      margin: 0 0 6px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .block pre {
      min-height: 92px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(8, 16, 28, 0.8);
      overflow: auto;
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .btn {
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      border-radius: 7px;
      padding: 8px 11px;
      cursor: pointer;
    }
    .btn:hover { border-color: rgba(79, 209, 197, 0.45); }
    .empty {
      border: 1px dashed var(--line);
      border-radius: var(--radius);
      padding: 16px;
      color: var(--muted);
      text-align: center;
      background: rgba(17, 26, 43, 0.42);
    }
    @media (max-width: 920px) {
      .hero, .bar, .grid, .split { grid-template-columns: 1fr; }
      .tabs { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <div>
        <p class="eyebrow">SC 1FORCR</p>
        <h1>Dokumentasi API</h1>
        <p class="lede">Endpoint resmi untuk user sewa SC: create akun, trial, renew, lock, quota, dan sinkronisasi konfigurasi server.</p>
      </div>
      <aside class="panel meta">
        <div class="meta-row"><span>Base URL</span><code id="base"></code></div>
        <div class="meta-row"><span>Docs Path</span><code>/docs/</code></div>
        <div class="meta-row"><span>Auth Header</span><code>Authorization: Bearer &lt;token&gt;</code></div>
      </aside>
    </header>
    <div class="quick">
      <span class="chip">HTTPS</span>
      <span class="chip">Static HTML / CSS / JS</span>
      <span class="chip">Same domain, isolated path</span>
      <span class="chip">Default off, toggle via menu</span>
    </div>
    <div class="bar">
      <input id="search" class="search" type="search" placeholder="Cari path, method, atau keterangan endpoint...">
      <div id="tabs" class="tabs"></div>
    </div>
    <main id="content"></main>
  </div>
  <script>
    const BASE = location.origin;
    document.getElementById('base').textContent = BASE;
    const TOKEN = '<token>';
    const authCurl = `-H "Authorization: Bearer ${TOKEN}"`;
    const q = (v) => String(v || '').trim();
    const routes = [
      ['Core', 'GET', '/vps/health', false, 'Cek liveness API dan domain aktif.', '-', `curl -s "${BASE}/vps/health"`, 'Tanpa auth.'],
      ['Core', 'GET', '/vps/capacity', true, 'Baca state kapasitas server dan auto-tune.', '-', `curl ${authCurl} "${BASE}/vps/capacity"`, 'Auth wajib.'],
      ['Core', 'GET', '/vps/my-accounts?telegram_user_id=123456789', true, 'Daftar akun milik user Telegram tertentu.', 'Query:\ntelegram_user_id=123456789\ninclude_inactive=1 (opsional)', `curl ${authCurl} "${BASE}/vps/my-accounts?telegram_user_id=123456789"`, 'Auth wajib.'],
      ['SSH', 'POST', '/vps/sshvpn', true, 'Buat akun SSH / SSHWS reguler.', '{\n  "username": "jengger8844",\n  "password": "Rahasia123!",\n  "expired": 30,\n  "limitip": 2,\n  "kuota": 0\n}', `curl -X POST ${authCurl} -H "Content-Type: application/json" -d '{"username":"jengger8844","password":"Rahasia123!","expired":30,"limitip":2,"kuota":0}' "${BASE}/vps/sshvpn"`, 'Password boleh kosong, server bisa generate otomatis.'],
      ['SSH', 'POST', '/vps/trialsshvpn', true, 'Buat akun trial SSH / SSHWS.', '{\n  "username": "",\n  "password": "opsional",\n  "limitip": 1\n}', `curl -X POST ${authCurl} -H "Content-Type: application/json" -d '{"username":"","password":"opsional","limitip":1}' "${BASE}/vps/trialsshvpn"`, 'Username trial boleh kosong.'],
      ['SSH', 'POST / PATCH', '/vps/passwordsshvpn/:username', true, 'Ganti password akun SSH.', '{\n  "password": "password-baru"\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"password":"password-baru"}' "${BASE}/vps/passwordsshvpn/jengger8844"`, 'POST dan PATCH sama-sama diterima.'],
      ['SSH', 'POST / PATCH', '/vps/passwordsshvpn-all', true, 'Ganti password semua akun SSH aktif.', '{\n  "password": "password-baru"\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"password":"password-baru"}' "${BASE}/vps/passwordsshvpn-all"`, 'Berlaku untuk semua akun SSH.'],
      ['SSH', 'DELETE', '/vps/deletesshvpn/:username', true, 'Hapus akun SSH.', '-', `curl -X DELETE ${authCurl} "${BASE}/vps/deletesshvpn/jengger8844"`, 'Akun dan state backend ikut dibersihkan.'],
      ['SSH', 'POST / PATCH', '/vps/renewsshvpn/:username/:exp', true, 'Perpanjang atau recover akun SSH.', '{\n  "password": "opsional",\n  "limitip": 2,\n  "kuota": 10,\n  "recover_missing": 1\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"password":"opsional","limitip":2,"kuota":10,"recover_missing":1}' "${BASE}/vps/renewsshvpn/jengger8844/30"`, ':exp adalah tambahan hari.'],
      ['SSH', 'PATCH', '/vps/locksshvpn/:username', true, 'Lock akun SSH.', '-', `curl -X PATCH ${authCurl} "${BASE}/vps/locksshvpn/jengger8844"`, 'Memutus akses login lama.'],
      ['SSH', 'PATCH', '/vps/unlocksshvpn/:username', true, 'Unlock akun SSH jika quota masih cukup.', '-', `curl -X PATCH ${authCurl} "${BASE}/vps/unlocksshvpn/jengger8844"`, 'Akan ditolak kalau quota habis.'],
      ['SSH', 'PATCH', '/vps/unlocksshvpn/:username/pw', true, 'Unlock SSH dengan sinkron password helper.', '-', `curl -X PATCH ${authCurl} "${BASE}/vps/unlocksshvpn/jengger8844/pw"`, 'Alias unlock dengan validasi password.'],
      ['Xray', 'POST', '/vps/vmessall', true, 'Buat akun VMess.', '{\n  "username": "vmess01",\n  "expired": 30,\n  "limitip": 2,\n  "kuota": 0\n}', `curl -X POST ${authCurl} -H "Content-Type: application/json" -d '{"username":"vmess01","expired":30,"limitip":2,"kuota":0}' "${BASE}/vps/vmessall"`, 'UUID dibuat server dan dikirim di response.'],
      ['Xray', 'POST', '/vps/trialvmessall', true, 'Buat akun trial VMess.', '{\n  "username": "",\n  "limitip": 1\n}', `curl -X POST ${authCurl} -H "Content-Type: application/json" -d '{"username":"","limitip":1}' "${BASE}/vps/trialvmessall"`, 'Username trial boleh kosong.'],
      ['Xray', 'POST', '/vps/vlessall', true, 'Buat akun VLESS.', '{\n  "username": "vless01",\n  "expired": 30,\n  "limitip": 2,\n  "kuota": 0\n}', `curl -X POST ${authCurl} -H "Content-Type: application/json" -d '{"username":"vless01","expired":30,"limitip":2,"kuota":0}' "${BASE}/vps/vlessall"`, 'UUID dibuat server dan dikirim di response.'],
      ['Xray', 'POST', '/vps/trialvlessall', true, 'Buat akun trial VLESS.', '{\n  "username": "",\n  "limitip": 1\n}', `curl -X POST ${authCurl} -H "Content-Type: application/json" -d '{"username":"","limitip":1}' "${BASE}/vps/trialvlessall"`, 'Username trial boleh kosong.'],
      ['Xray', 'POST', '/vps/trojanall', true, 'Buat akun Trojan.', '{\n  "username": "trojan01",\n  "expired": 30,\n  "limitip": 2,\n  "kuota": 0\n}', `curl -X POST ${authCurl} -H "Content-Type: application/json" -d '{"username":"trojan01","expired":30,"limitip":2,"kuota":0}' "${BASE}/vps/trojanall"`, 'Password Trojan dibuat server dan dikirim di response.'],
      ['Xray', 'POST', '/vps/trialtrojanall', true, 'Buat akun trial Trojan.', '{\n  "username": "",\n  "limitip": 1\n}', `curl -X POST ${authCurl} -H "Content-Type: application/json" -d '{"username":"","limitip":1}' "${BASE}/vps/trialtrojanall"`, 'Username trial boleh kosong.'],
      ['Xray', 'POST / PATCH', '/vps/renewvmess/:username/:exp', true, 'Perpanjang akun VMess.', '{\n  "limitip": 2,\n  "kuota": 10\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"limitip":2,"kuota":10}' "${BASE}/vps/renewvmess/vmess01/30"`, ':exp adalah tambahan hari.'],
      ['Xray', 'POST / PATCH', '/vps/renewvless/:username/:exp', true, 'Perpanjang akun VLESS.', '{\n  "limitip": 2,\n  "kuota": 10\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"limitip":2,"kuota":10}' "${BASE}/vps/renewvless/vless01/30"`, ':exp adalah tambahan hari.'],
      ['Xray', 'POST / PATCH', '/vps/renewtrojan/:username/:exp', true, 'Perpanjang akun Trojan.', '{\n  "limitip": 2,\n  "kuota": 10\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"limitip":2,"kuota":10}' "${BASE}/vps/renewtrojan/trojan01/30"`, ':exp adalah tambahan hari.'],
      ['Xray', 'DELETE', '/vps/deletevmess/:username', true, 'Hapus akun VMess.', '-', `curl -X DELETE ${authCurl} "${BASE}/vps/deletevmess/vmess01"`, 'State Xray ikut dibersihkan.'],
      ['Xray', 'DELETE', '/vps/deletevless/:username', true, 'Hapus akun VLESS.', '-', `curl -X DELETE ${authCurl} "${BASE}/vps/deletevless/vless01"`, 'State Xray ikut dibersihkan.'],
      ['Xray', 'DELETE', '/vps/deletetrojan/:username', true, 'Hapus akun Trojan.', '-', `curl -X DELETE ${authCurl} "${BASE}/vps/deletetrojan/trojan01"`, 'State Xray ikut dibersihkan.'],
      ['Xray', 'PATCH', '/vps/lockvmess/:username', true, 'Lock akun VMess.', '-', `curl -X PATCH ${authCurl} "${BASE}/vps/lockvmess/vmess01"`, 'Menonaktifkan akses account.'],
      ['Xray', 'PATCH', '/vps/lockvless/:username', true, 'Lock akun VLESS.', '-', `curl -X PATCH ${authCurl} "${BASE}/vps/lockvless/vless01"`, 'Menonaktifkan akses account.'],
      ['Xray', 'PATCH', '/vps/locktrojan/:username', true, 'Lock akun Trojan.', '-', `curl -X PATCH ${authCurl} "${BASE}/vps/locktrojan/trojan01"`, 'Menonaktifkan akses account.'],
      ['Xray', 'PATCH', '/vps/unlockvmess/:username', true, 'Unlock akun VMess.', '-', `curl -X PATCH ${authCurl} "${BASE}/vps/unlockvmess/vmess01"`, 'Akan gagal jika quota habis.'],
      ['Xray', 'PATCH', '/vps/unlockvless/:username', true, 'Unlock akun VLESS.', '-', `curl -X PATCH ${authCurl} "${BASE}/vps/unlockvless/vless01"`, 'Akan gagal jika quota habis.'],
      ['Xray', 'PATCH', '/vps/unlocktrojan/:username', true, 'Unlock akun Trojan.', '-', `curl -X PATCH ${authCurl} "${BASE}/vps/unlocktrojan/trojan01"`, 'Akan gagal jika quota habis.'],
      ['Quota', 'PATCH', '/vps/quota/:type/:username', true, 'Ubah quota akun SSH/VMess/VLESS/Trojan.', '{\n  "kuota": 10,\n  "mode": "add"\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"kuota":10,"mode":"add"}' "${BASE}/vps/quota/ssh/jengger8844"`, 'Gunakan mode add untuk menambah saldo kuota.'],
      ['Quota', 'PATCH', '/vps/editquotasshvpn/:username', true, 'Alias quota untuk akun SSH.', '{\n  "kuota": 10,\n  "mode": "add"\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"kuota":10,"mode":"add"}' "${BASE}/vps/editquotasshvpn/jengger8844"`, 'Alias endpoint quota SSH.'],
      ['Quota', 'PATCH', '/vps/editquotavmess/:username', true, 'Alias quota untuk akun VMess.', '{\n  "kuota": 10,\n  "mode": "add"\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"kuota":10,"mode":"add"}' "${BASE}/vps/editquotavmess/vmess01"`, 'Alias endpoint quota VMess.'],
      ['Quota', 'PATCH', '/vps/editquotavless/:username', true, 'Alias quota untuk akun VLESS.', '{\n  "kuota": 10,\n  "mode": "add"\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"kuota":10,"mode":"add"}' "${BASE}/vps/editquotavless/vless01"`, 'Alias endpoint quota VLESS.'],
      ['Quota', 'PATCH', '/vps/editquotatrojan/:username', true, 'Alias quota untuk akun Trojan.', '{\n  "kuota": 10,\n  "mode": "add"\n}', `curl -X PATCH ${authCurl} -H "Content-Type: application/json" -d '{"kuota":10,"mode":"add"}' "${BASE}/vps/editquotatrojan/trojan01"`, 'Alias endpoint quota Trojan.'],
      ['Utility', 'POST', '/vps/sync-xray', true, 'Sinkron ulang konfigurasi Xray dari database.', '-', `curl -X POST ${authCurl} "${BASE}/vps/sync-xray"`, 'Dipakai setelah restore/import DB.'],
      ['Utility', 'POST', '/vps/restore-finished', true, 'Sinkron runtime SSH backend dan Xray setelah restore selesai.', '-', `curl -X POST ${authCurl} "${BASE}/vps/restore-finished"`, 'Dipakai setelah restore/import DB.']
    ].map(([group, method, path, auth, summary, body, curl, note]) => ({ group, method, path, auth, summary, body, curl, note }));
    const groups = ['Semua', 'Core', 'SSH', 'Xray', 'Quota', 'Utility'];
    let activeGroup = 'Semua';
    const tabs = document.getElementById('tabs');
    const search = document.getElementById('search');
    const content = document.getElementById('content');

    const methodClass = (m) => {
      const key = String(m || '').toLowerCase();
      if (key.includes('get')) return 'm-get';
      if (key.includes('post')) return 'm-post';
      if (key.includes('patch')) return 'm-patch';
      if (key.includes('delete')) return 'm-delete';
      return 'm-post';
    };

    const matches = (item, term, group) => {
      const hay = [item.group, item.method, item.path, item.summary, item.body, item.note, item.curl].join(' ').toLowerCase();
      const okGroup = group === 'Semua' || item.group === group;
      return okGroup && (!term || hay.includes(term));
    };

    const copy = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {}
    };

    const renderTabs = () => {
      tabs.innerHTML = groups.map((g) => `<button class="tab${g === activeGroup ? ' active' : ''}" data-group="${g}">${g}</button>`).join('');
      tabs.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeGroup = btn.dataset.group || 'Semua';
          render();
        });
      });
    };

    const render = () => {
      renderTabs();
      const term = q(search.value).toLowerCase();
      const filtered = routes.filter((item) => matches(item, term, activeGroup));
      if (!filtered.length) {
        content.innerHTML = '<div class="empty">Tidak ada endpoint yang cocok dengan pencarian.</div>';
        return;
      }
      const byGroup = filtered.reduce((acc, item) => {
        (acc[item.group] ||= []).push(item);
        return acc;
      }, {});
      content.innerHTML = Object.entries(byGroup).map(([group, items]) => `
        <section class="section">
          <h2>${group}</h2>
          <p class="sub">${items.length} endpoint tersedia</p>
          <div class="grid">
            ${items.map((item) => `
              <article class="route">
                <div class="route-top">
                  <span class="method ${methodClass(item.method)}">${item.method}</span>
                  <span class="tags">${item.auth ? 'Auth required' : 'Public'}${item.note ? ' • ' + item.note : ''}</span>
                </div>
                <p class="path">${item.path}</p>
                <p class="desc">${item.summary}</p>
                <div class="split">
                  <div class="block">
                    <div class="label">Request</div>
                    <pre><code>${item.body}</code></pre>
                  </div>
                  <div class="block">
                    <div class="label">cURL</div>
                    <pre><code>${item.curl}</code></pre>
                  </div>
                </div>
                <div class="actions">
                  <button class="btn" data-copy="${item.curl.replace(/"/g, '&quot;')}">Copy cURL</button>
                </div>
              </article>
            `).join('')}
          </div>
        </section>
      `).join('');
      content.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', () => copy(btn.dataset.copy || ''));
      });
    };

    search.addEventListener('input', render);
    render();
  </script>
</body>
</html>
EOF
  chmod 644 "${web_root}/index.html" >/dev/null 2>&1 || true
}

write_api_docs_nginx_snippet() {
  local snippet enabled web_root
  snippet="$(api_docs_nginx_snippet_path)"
  web_root="$(api_docs_web_root)"
  enabled="$(normalize_bool_01 "${API_DOCS_ENABLE:-0}")"
  mkdir -p "$(dirname "${snippet}")"
  if [[ "${enabled}" == "1" ]]; then
    cat > "${snippet}" <<EOF
# SC 1FORCR API docs
location = /docs {
    return 301 /docs/;
}

location = /docs/ {
    root ${web_root};
    try_files /index.html =404;
}

location ^~ /docs/ {
    alias ${web_root}/;
    try_files \$uri \$uri/ =404;
}
EOF
  else
    cat > "${snippet}" <<'EOF'
# SC 1FORCR API docs disabled
location = /docs {
    return 404;
}

location ^~ /docs/ {
    return 404;
}
EOF
  fi
  chmod 644 "${snippet}" >/dev/null 2>&1 || true
}

prepare_api_docs_site() {
  local enabled web_root
  enabled="$(normalize_bool_01 "${API_DOCS_ENABLE:-0}")"
  web_root="$(api_docs_web_root)"
  ensure_api_docs_nginx_include
  write_api_docs_nginx_snippet
  if [[ "${enabled}" == "1" ]]; then
    write_api_docs_index
  else
    rm -rf "${web_root}" >/dev/null 2>&1 || true
  fi
}

apply_api_docs_site() {
  prepare_api_docs_site
  if ! command -v nginx >/dev/null 2>&1; then
    echo "nginx tidak ditemukan, docs site belum bisa diaktifkan."
    return 1
  fi
  if ! nginx -t >/dev/null 2>&1; then
    echo "Konfigurasi nginx tidak valid saat menerapkan docs site."
    return 1
  fi
  systemctl reload nginx >/dev/null 2>&1 || systemctl restart nginx >/dev/null 2>&1 || true
  return 0
}

set_api_docs_config_menu() {
  local current_enable enable_in desired_state current_url
  current_enable="$(normalize_bool_01 "${API_DOCS_ENABLE:-0}")"
  current_url="https://${DOMAIN}/docs/"
  echo "SETTING WEB DOKUMENTASI API"
  echo "Status sekarang : $([[ "${current_enable}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  echo "URL saat aktif  : ${current_url}"
  echo "Path isolasi    : /docs/ (tidak menabrak routing SSH/Xray)"
  echo
  prompt_input enable_in "Aktifkan web dokumentasi API? [1/0, enter=keep]: " || return
  enable_in="$(echo "${enable_in:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "${enable_in}" in
    1|true|yes|on) desired_state="1" ;;
    0|false|no|off) desired_state="0" ;;
    "") desired_state="${current_enable}" ;;
    *) echo "Input tidak valid, status lama dipakai."; desired_state="${current_enable}" ;;
  esac

  API_DOCS_ENABLE="${desired_state}"
  if ! apply_api_docs_site; then
    API_DOCS_ENABLE="${current_enable}"
    echo "Gagal menerapkan web dokumentasi API."
    return 1
  fi

  update_sc_env_var "API_DOCS_ENABLE" "${API_DOCS_ENABLE}"
  update_app_env_var "API_DOCS_ENABLE" "${API_DOCS_ENABLE}"

  echo
  echo "Berhasil update web dokumentasi API:"
  echo "- Status : $([[ "${API_DOCS_ENABLE}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  if [[ "${API_DOCS_ENABLE}" == "1" ]]; then
    echo "- URL    : ${current_url}"
  else
    echo "- URL    : nonaktif"
  fi
}

tools_menu() {
  while true; do
    clear
    draw_menu_panel "MENU TOOLS" \
      "1) Informasi Key Script" \
      "2) Install API 1FORCR" \
      "3) Setting Banner" \
      "4) Update / Rollback SC" \
      "5) Setting BOT Telegram" \
      "6) Setting Checker IP Limit" \
      "7) Setting Auto-Lock Realtime" \
      "8) Setting Notif Akun Online BOT" \
      "9) Kirim Notif Online Sekarang ke BOT" \
      "10) Setting Token Webhook BotVPN" \
      "11) Upgrade/Downgrade Versi Dropbear" \
      "12) Setting Interval Auto Backup" \
      "13) Setting Interval Auto Reboot" \
      "14) Setting Auto Update Bot" \
      "15) Diagnosa/Repair Routing Jaringan" \
      "16) Setting Web Dokumentasi API" \
      "17) Tema Warna Menu" \
      "18) Port TLS/NTLS Tambahan" \
      "19) Mode Bot Panel (Jualan Akun)" \
      "20) SlowDNS (DNS Tunnel)" \
      "0) Kembali"
    echo
    if ! prompt_input tm "Pilih menu [0-20]: "; then
      return
    fi
    clear
    case "${tm}" in
      1) show_sc_key_info | ui_fx || true ;;
      2) install_summary_api_1forcr || true ;;
      3) set_html_banner_menu || true ;;
      4) update_rollback_menu || true ;;
      5) set_telegram_notif_config || true ;;
      6) set_iplimit_checker_config_menu || true ;;
      7) set_autolock_realtime_tuning_menu || true ;;
      8) set_online_notify_config_menu || true ;;
      9) trigger_online_notify_now || true ;;
      10) set_account_event_webhook_config || true ;;
      11) set_dropbear_version_menu || true ;;
      12) set_auto_backup_config_menu || true ;;
      13) set_auto_reboot_config_menu || true ;;
      14) set_auto_pull_update_config_menu || true ;;
      15) network_compatibility_menu || true ;;
      16) set_api_docs_config_menu || true ;;
      17) set_menu_color_menu || true ;;
      18) set_extra_ports_menu || true ;;
      19) set_bot_panel_menu || true ;;
      20) set_slowdns_menu || true ;;
      0) return ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    echo
    menu_pause
  done
}

# Deteksi otomatis tidak bisa tahu kemampuan aplikasi SSH di HP/PC, jadi
# pemilik VPS bisa memaksa mode warna. Truecolor memberi gradasi paling halus.
# Port TLS/NTLS tambahan dialihkan kernel ke 443/80 oleh sc-1forcr-extra-ports.
# Port yang sedang dipakai program lain otomatis dilewati.
extra_ports_clean_input() {
  local raw="$1"
  case "$(echo "${raw}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    off|0|none) printf 'off'; return 0 ;;
  esac
  echo "${raw}" | tr ' ;' ',,' | tr -cd '0-9,' | sed 's/,,*/,/g; s/^,//; s/,$//'
}

set_extra_ports_menu() {
  local bin="/usr/local/sbin/sc-1forcr-extra-ports" tls_in ntls_in value changed=0
  if [[ ! -x "${bin}" ]]; then
    echo "Gagal: ${bin} belum terpasang. Jalankan update SC dulu."
    return 0
  fi
  draw_menu_header "PORT TLS/NTLS TAMBAHAN"
  "${bin}" apply >/dev/null 2>&1 || true
  "${bin}" status | ui_fx
  if [[ "$(menu_bool_01 "${XRAY_MULTIPATH_ENABLE:-1}")" != "1" ]]; then
    menu_kv "Multi path WS" "NONAKTIF (hanya path standar)"
  elif [[ -f /run/sc-1forcr/sshws-multipath ]]; then
    menu_kv "Multi path WS" "AKTIF (SSH/VMess/VLESS/Trojan path bebas)"
  else
    menu_kv "Multi path WS" "menunggu restart SSH-WS (aktif setelah reboot)"
  fi
  echo
  echo "Port TLS dialihkan ke 443, port NTLS ke 80. Isi daftar dipisah koma,"
  echo "ketik off untuk mematikan, atau Enter untuk tetap."
  echo "Catatan: buka juga port ini di firewall panel provider kalau ada."
  echo
  prompt_input tls_in "Port TLS  [${EXTRA_TLS_PORTS:-8443,2053,2083,2087,2096}]: " || return 0
  prompt_input ntls_in "Port NTLS [${EXTRA_NTLS_PORTS:-8080,8880,2052,2082,2086,2095}]: " || return 0
  if [[ -n "${tls_in// /}" ]]; then
    value="$(extra_ports_clean_input "${tls_in}")"
    if [[ -z "${value}" ]]; then
      echo "Input port TLS tidak valid, daftar lama dipakai."
    else
      EXTRA_TLS_PORTS="${value}"
      update_sc_env_var EXTRA_TLS_PORTS "${EXTRA_TLS_PORTS}"
      changed=1
    fi
  fi
  if [[ -n "${ntls_in// /}" ]]; then
    value="$(extra_ports_clean_input "${ntls_in}")"
    if [[ -z "${value}" ]]; then
      echo "Input port NTLS tidak valid, daftar lama dipakai."
    else
      EXTRA_NTLS_PORTS="${value}"
      update_sc_env_var EXTRA_NTLS_PORTS "${EXTRA_NTLS_PORTS}"
      changed=1
    fi
  fi
  if (( changed == 0 )); then
    return 0
  fi
  echo
  if "${bin}" apply >/dev/null 2>&1; then
    echo "Berhasil menerapkan port tambahan:"
  else
    echo "Gagal menerapkan port tambahan. Watchdog akan mencoba lagi."
  fi
  "${bin}" status | ui_fx
  return 0
}

# SlowDNS (dnstt) lewat sc-1forcr-slowdns. Butuh record NS di DNS domain yang
# mendelegasikan domain tunnel ke VPS ini. Build binary pertama 2-6 menit.
# Env dibaca ulang setelah tiap perubahan, supaya Update dari menu membawa
# nilai SLOWDNS_* terbaru (helper menulis /etc/sc-1forcr.env sendiri).
slowdns_enable_menu() {
  local bin="$1" ns def_ns ans
  def_ns="${SLOWDNS_NS_DOMAIN:-}"
  [[ -n "${def_ns}" ]] || def_ns="$("${bin}" suggest 2>/dev/null || true)"
  echo "Domain NS = subdomain khusus yang didelegasikan ke VPS ini (jangan sama dengan ${DOMAIN:-domain utama})."
  echo "Usulan: ${def_ns:-ns-...}. Kosongkan = pakai usulan, 'batal' = kembali."
  if ! prompt_input ns "Domain NS [${def_ns}]: "; then
    return 0
  fi
  [[ "${ns,,}" == "batal" ]] && return 0
  [[ -z "${ns}" ]] && ns="${def_ns}"
  if [[ ! -x /usr/local/lib/sc-1forcr/dnstt-server ]]; then
    echo "Binary dnstt dibangun dari source resmi dulu: 2-6 menit, ~800 MB disk sementara. Layanan lain tetap jalan."
  fi
  if ! prompt_input ans "Lanjut aktifkan SlowDNS? [y/N]: "; then
    return 0
  fi
  if [[ "${ans,,}" != "y" && "${ans,,}" != "yes" ]]; then
    echo "Dibatalkan."
    return 0
  fi
  "${bin}" enable "${ns}" 2>&1 | ui_fx || true
  return 0
}

show_slowdns_online() {
  draw_menu_header "AKUN ONLINE SLOWDNS"
  /usr/local/sbin/sc-1forcr-slowdns online
  return 0
}

set_slowdns_menu() {
  local bin="/usr/local/sbin/sc-1forcr-slowdns" choice ns ans
  if [[ ! -x "${bin}" ]]; then
    echo "Gagal: ${bin} belum terpasang. Jalankan update SC dulu."
    return 0
  fi
  safe_source_env_file /etc/sc-1forcr.env
  draw_menu_header "SLOWDNS (DNS TUNNEL)"
  "${bin}" status | ui_fx
  echo
  echo "SlowDNS = SSH lewat query DNS: tetap konek di jaringan yang cuma buka DNS."
  echo "Syarat: buat record NS di DNS domain -> VPS ini (pilih menu 5 untuk panduannya)."
  echo "Di app: pilih Type NULL, isi NS + Pubkey + DNS dari detail akun, akun SSH biasa."
  echo
  if [[ "$(normalize_bool_01 "${SLOWDNS_ENABLE:-0}")" == "1" ]]; then
    echo "1) Nonaktifkan SlowDNS"
  else
    echo "1) Aktifkan SlowDNS"
  fi
  echo "2) Ganti Domain NS"
  echo "3) Cek Delegasi NS"
  echo "4) Buat Ulang Kunci (pubkey baru)"
  echo "5) Lihat Record DNS yang Dibutuhkan"
  echo "6) Lihat Log SlowDNS"
  echo "7) Lihat Akun Online SlowDNS"
  if [[ "$(normalize_bool_01 "${SLOWDNS_AUTO_LOCK_ENABLE:-1}")" == "1" ]]; then
    echo "8) Nonaktifkan Auto-lock SlowDNS"
  else
    echo "8) Aktifkan Auto-lock SlowDNS"
  fi
  echo "0) Kembali"
  if ! prompt_input choice "Pilih [0-8]: "; then
    return 0
  fi
  case "${choice}" in
    1)
      if [[ "$(normalize_bool_01 "${SLOWDNS_ENABLE:-0}")" == "1" ]]; then
        "${bin}" disable 2>&1 | ui_fx || true
      else
        slowdns_enable_menu "${bin}"
      fi
      ;;
    2)
      echo "Domain NS sekarang: ${SLOWDNS_NS_DOMAIN:--}"
      if prompt_input ns "Domain NS baru (kosong = batal): " && [[ -n "${ns}" ]]; then
        "${bin}" set-ns "${ns}" 2>&1 | ui_fx || true
      fi
      ;;
    3) "${bin}" check 2>&1 | ui_fx || true ;;
    4)
      echo "Peringatan: semua pengguna SlowDNS harus mengganti pubkey di aplikasinya."
      if prompt_input ans "Buat kunci baru? [y/N]: " && [[ "${ans,,}" == "y" || "${ans,,}" == "yes" ]]; then
        "${bin}" regen-key 2>&1 | ui_fx || true
      else
        echo "Dibatalkan."
      fi
      ;;
    5) "${bin}" records | ui_fx || true ;;
    6) journalctl -u sc-1forcr-slowdns.service -n 40 --no-pager -o cat 2>/dev/null || echo "Log SlowDNS belum tersedia." ;;
    7) ui_monitor show_slowdns_online ;;
    8)
      if [[ "$(normalize_bool_01 "${SLOWDNS_AUTO_LOCK_ENABLE:-1}")" == "1" ]]; then
        "${bin}" set-lock 0 2>&1 | ui_fx || true
      else
        "${bin}" set-lock 1 2>&1 | ui_fx || true
      fi
      ;;
    *) return 0 ;;
  esac
  safe_source_env_file /etc/sc-1forcr.env
  return 0
}

set_menu_color_menu() {
  local current="" detected choice mode=""
  if [[ -r "${MENU_COLOR_FILE}" ]]; then
    current="$(tr -cd 'a-z0-9' < "${MENU_COLOR_FILE}" 2>/dev/null || true)"
  fi
  if [[ -z "${current}" ]]; then current="auto"; fi
  detected="$(ui_color_mode_auto)"
  draw_menu_panel "TEMA WARNA MENU" \
    "Mode sekarang : ${current} (otomatis terdeteksi: ${detected})" \
    "" \
    "1) Otomatis (default, truecolor)" \
    "2) Truecolor 24-bit (gradasi paling halus)" \
    "3) 256 warna (kalau warna truecolor aneh)" \
    "4) 16 warna (terminal lama)" \
    "5) Tanpa warna" \
    "0) Kembali"
  echo
  if ! prompt_input choice "Pilih [0-5]: "; then
    return 0
  fi
  case "${choice}" in
    1) mode="auto" ;;
    2) mode="truecolor" ;;
    3) mode="256" ;;
    4) mode="16" ;;
    5) mode="none" ;;
    0) return 0 ;;
    *) echo "Pilihan tidak valid."; return 0 ;;
  esac
  if [[ "${mode}" == "auto" ]]; then
    rm -f "${MENU_COLOR_FILE}" >/dev/null 2>&1 || true
  else
    mkdir -p "$(dirname "${MENU_COLOR_FILE}")"
    printf '%s\n' "${mode}" > "${MENU_COLOR_FILE}"
  fi
  UI_MODE=""
  ui_init
  echo "Tema warna menu disimpan: ${mode}."
  echo "Kalau gradasi terlihat kotak-kotak atau warnanya aneh, pilih 256 atau 16 warna."
}

udp_backend_status() {
  local udpcustom
  udpcustom="$(detect_udpcustom_service)"
  echo "UDP backend:"
  echo "- ZIVPN (${ZIVPN_SERVICE}): $(service_onoff "${ZIVPN_SERVICE}")"
  echo "- UDPHC (${udpcustom}): $(service_onoff "${udpcustom}")"
}

service_onoff() {
  local svc="$1"
  if systemctl is-active --quiet "${svc}" 2>/dev/null; then
    echo "ON"
  else
    echo "OFF"
  fi
}

show_core_services_onoff() {
  local udpcustom svc state detail
  udpcustom="$(detect_udpcustom_service)"
  echo "Service status (ON/OFF):"
  echo "- ssh: $(service_onoff ssh)"
  echo "- dropbear: $(service_onoff dropbear)"
  echo "- nginx: $(service_onoff nginx)"
  echo "- haproxy: $(service_onoff haproxy)"
  echo "- xray: $(service_onoff xray)"
  echo "- sc-1forcr-api: $(service_onoff sc-1forcr-api)"
  echo "- sc-1forcr-sshws: $(service_onoff sc-1forcr-sshws)"
  echo "- ${ZIVPN_SERVICE}: $(service_onoff "${ZIVPN_SERVICE}")"
  echo "- ${udpcustom}: $(service_onoff "${udpcustom}")"
  # Service systemd di atas bisa ON walau layanannya dimatikan admin.
  if [[ -x "${SERVICE_GATE_BIN:-}" ]]; then
    echo
    echo "Layanan (menu ON/OFF LAYANAN):"
    while read -r svc state detail; do
      [[ -n "${svc}" ]] || continue
      echo "- $(service_toggle_label "${svc}"): ${state}"
    done < <("${SERVICE_GATE_BIN}" status 2>/dev/null || true)
  fi
}

cleanup_zivpn_dnat_for_udphc() {
  local udphc_port range_nft handle ports p
  udphc_port="$(jq -r '.listen // empty' /root/udp/config.json 2>/dev/null | sed -E 's/^:([0-9]+)$/\1/' | tr -cd '0-9')"
  [[ -z "${udphc_port}" ]] && udphc_port="5667"
  if command -v iptables >/dev/null 2>&1; then
    while iptables -w 10 -t nat -C PREROUTING -p udp --dport "${ZIVPN_DNAT_RANGE}" -j DNAT --to-destination ":${udphc_port}" >/dev/null 2>&1; do
      iptables -w 10 -t nat -D PREROUTING -p udp --dport "${ZIVPN_DNAT_RANGE}" -j DNAT --to-destination ":${udphc_port}" >/dev/null 2>&1 || break
    done
  elif command -v nft >/dev/null 2>&1; then
    range_nft="${ZIVPN_DNAT_RANGE/:/-}"
    while IFS= read -r handle; do
      [[ -z "${handle}" ]] && continue
      nft delete rule ip nat prerouting handle "${handle}" >/dev/null 2>&1 || true
    done < <(
      nft -a list chain ip nat prerouting 2>/dev/null | \
        awk -v sig="udp dport ${range_nft} dnat to :${udphc_port}" '$0 ~ sig {for (i=1;i<=NF;i++) if ($i=="handle") print $(i+1)}'
    )
  fi

  ports="$(echo "${ZIVPN_EXTRA_UDP_PORTS:-}" | tr ',' ' ')"
  for p in ${ports}; do
    p="$(echo "${p}" | tr -cd '0-9')"
    [[ -z "${p}" || "${p}" -lt 1 || "${p}" -gt 65535 || "${p}" == "${udphc_port}" ]] && continue
    if command -v iptables >/dev/null 2>&1; then
      while iptables -w 10 -t nat -C PREROUTING -p udp --dport "${p}" -j DNAT --to-destination ":${udphc_port}" >/dev/null 2>&1; do
        iptables -w 10 -t nat -D PREROUTING -p udp --dport "${p}" -j DNAT --to-destination ":${udphc_port}" >/dev/null 2>&1 || break
      done
    elif command -v nft >/dev/null 2>&1; then
      while IFS= read -r handle; do
        [[ -z "${handle}" ]] && continue
        nft delete rule ip nat prerouting handle "${handle}" >/dev/null 2>&1 || true
      done < <(
        nft -a list chain ip nat prerouting 2>/dev/null | \
          awk -v sig="udp dport ${p} dnat to :${udphc_port}" '$0 ~ sig {for (i=1;i<=NF;i++) if ($i=="handle") print $(i+1)}'
      )
    fi
  done
}

# Klien UDP Custom (HTTP Custom, host:1-65535@user:pass) mengirim ke port acak
# di rentang itu, jadi semua port UDP harus dialihkan ke port listen. Binary
# udp-custom memasang DNAT 1:65535 sendiri saat start, tapi rule itu hilang
# kalau dihapus pihak lain sampai binary restart, dan interface-nya ditebak
# dari `ip route get` (bisa salah di VPS tertentu). Rule ini milik SC: ditandai
# comment, hanya untuk paket ke alamat VPS sendiri (trafik docker/forward tidak
# ikut berbelok), dan ditambah di akhir PREROUTING supaya DNAT lain didahulukan.
# Jangan hapus DNAT lain yang menuju port UDP Custom: rule binary ikut terhapus.
# Binary tidak membuang rule-nya saat mati, jadi `del` (backend ZIVPN) membuang
# rule SC dan rule sisa binary; DNAT range milik ZIVPN tidak pernah disentuh.
# Tanpa iptables dilewati (binary udp-custom juga butuh iptables).
udpcustom_port_range_rule() {
  local action="${1:-}" port="${2:-}" line
  local binary_rule='^-A PREROUTING -i [^ ]+ -p udp -m udp --dport 1:65535 -j DNAT --to-destination [0-9.]*:[0-9]+$'
  local -a rule
  command -v iptables >/dev/null 2>&1 || return 0
  [[ "${action}" == "add" && "${port}" =~ ^[0-9]+$ ]] || port=""
  while IFS= read -r line; do
    line="${line//\"/}"
    if [[ "${line} " == *" sc-udpcustom-range "* ]]; then
      [[ -n "${port}" && "${line} " == *" --to-destination :${port} "* ]] && continue
    elif [[ "${action}" != "del" || ! "${line}" =~ ${binary_rule} ]]; then
      continue
    fi
    # shellcheck disable=SC2086
    iptables -w 10 -t nat -D ${line#-A } >/dev/null 2>&1 || true
  done < <(iptables -w 10 -t nat -S PREROUTING 2>/dev/null | grep -F -e 'sc-udpcustom-range' -e '--dport 1:65535 -j DNAT' || true)
  [[ -n "${port}" ]] || return 0
  rule=(-p udp -m udp --dport 1:65535 -m addrtype --dst-type LOCAL -m comment --comment sc-udpcustom-range -j DNAT --to-destination ":${port}")
  iptables -w 10 -t nat -C PREROUTING "${rule[@]}" >/dev/null 2>&1 || \
    iptables -w 10 -t nat -A PREROUTING "${rule[@]}" >/dev/null 2>&1 || true
}

ensure_zivpn_dnat_for_zivpn() {
  local zivpn_port range_nft ports p
  [[ -z "${ZIVPN_DNAT_RANGE}" ]] && return 0
  zivpn_port="$(jq -r '.listen // empty' /etc/zivpn/config.json 2>/dev/null | sed -E 's/^:([0-9]+)$/\1/' | tr -cd '0-9')"
  [[ -z "${zivpn_port}" ]] && zivpn_port="5667"

  if command -v iptables >/dev/null 2>&1; then
    iptables -w 10 -C INPUT -p udp --dport "${zivpn_port}" -j ACCEPT >/dev/null 2>&1 || \
      iptables -w 10 -I INPUT -p udp --dport "${zivpn_port}" -j ACCEPT
    iptables -w 10 -t nat -C PREROUTING -p udp --dport "${ZIVPN_DNAT_RANGE}" -j DNAT --to-destination ":${zivpn_port}" >/dev/null 2>&1 || \
      iptables -w 10 -t nat -I PREROUTING -p udp --dport "${ZIVPN_DNAT_RANGE}" -j DNAT --to-destination ":${zivpn_port}"
  elif command -v nft >/dev/null 2>&1; then
    range_nft="${ZIVPN_DNAT_RANGE/:/-}"
    nft add table ip nat >/dev/null 2>&1 || true
    nft 'add chain ip nat prerouting { type nat hook prerouting priority dstnat; }' >/dev/null 2>&1 || true
    if nft list chain inet filter input >/dev/null 2>&1; then
      nft list chain inet filter input | grep -F -- "udp dport ${zivpn_port} accept" >/dev/null 2>&1 || \
        nft add rule inet filter input udp dport "${zivpn_port}" accept
    elif nft list chain ip filter input >/dev/null 2>&1; then
      nft list chain ip filter input | grep -F -- "udp dport ${zivpn_port} accept" >/dev/null 2>&1 || \
        nft add rule ip filter input udp dport "${zivpn_port}" accept
    fi
    nft list chain ip nat prerouting 2>/dev/null | grep -F -- "udp dport ${range_nft} dnat to :${zivpn_port}" >/dev/null 2>&1 || \
      nft add rule ip nat prerouting udp dport "${range_nft}" dnat to ":${zivpn_port}"
  fi

  ports="$(echo "${ZIVPN_EXTRA_UDP_PORTS:-}" | tr ',' ' ')"
  for p in ${ports}; do
    p="$(echo "${p}" | tr -cd '0-9')"
    [[ -z "${p}" || "${p}" -lt 1 || "${p}" -gt 65535 ]] && continue
    if command -v iptables >/dev/null 2>&1; then
      iptables -w 10 -C INPUT -p udp --dport "${p}" -j ACCEPT >/dev/null 2>&1 || \
        iptables -w 10 -I INPUT -p udp --dport "${p}" -j ACCEPT
      [[ "${p}" == "${zivpn_port}" ]] && continue
      iptables -w 10 -t nat -C PREROUTING -p udp --dport "${p}" -j DNAT --to-destination ":${zivpn_port}" >/dev/null 2>&1 || \
        iptables -w 10 -t nat -I PREROUTING -p udp --dport "${p}" -j DNAT --to-destination ":${zivpn_port}"
    elif command -v nft >/dev/null 2>&1; then
      if nft list chain inet filter input >/dev/null 2>&1; then
        nft list chain inet filter input | grep -F -- "udp dport ${p} accept" >/dev/null 2>&1 || \
          nft add rule inet filter input udp dport "${p}" accept
      elif nft list chain ip filter input >/dev/null 2>&1; then
        nft list chain ip filter input | grep -F -- "udp dport ${p} accept" >/dev/null 2>&1 || \
          nft add rule ip filter input udp dport "${p}" accept
      fi
      [[ "${p}" == "${zivpn_port}" ]] && continue
      nft add table ip nat >/dev/null 2>&1 || true
      nft 'add chain ip nat prerouting { type nat hook prerouting priority dstnat; }' >/dev/null 2>&1 || true
      nft list chain ip nat prerouting 2>/dev/null | grep -F -- "udp dport ${p} dnat to :${zivpn_port}" >/dev/null 2>&1 || \
        nft add rule ip nat prerouting udp dport "${p}" dnat to ":${zivpn_port}"
    fi
  done
}

menu_udp_unit_active_state() {
  systemctl show "$1" --property=ActiveState --value 2>/dev/null || true
}

menu_wait_udp_unit_quiescent() {
  local unit="$1" timeout_seconds="${2:-15}" state consecutive_quiet=0
  while (( timeout_seconds > 0 )); do
    state="$(menu_udp_unit_active_state "${unit}")"
    case "${state}" in
      inactive|failed|not-found|"")
        consecutive_quiet=$((consecutive_quiet + 1))
        (( consecutive_quiet >= 2 )) && return 0
        ;;
      *) consecutive_quiet=0 ;;
    esac
    sleep 1
    timeout_seconds=$((timeout_seconds - 1))
  done
  return 1
}

menu_stop_disable_udp_unit() {
  local unit="$1" process_name="${2:-}" state
  systemctl disable "${unit}" >/dev/null 2>&1 || true
  systemctl stop --no-block "${unit}" >/dev/null 2>&1 || true
  if ! menu_wait_udp_unit_quiescent "${unit}" 15; then
    systemctl kill --kill-who=all --signal=SIGKILL "${unit}" >/dev/null 2>&1 || true
    [[ -n "${process_name}" ]] && pkill -KILL -x "${process_name}" >/dev/null 2>&1 || true
    systemctl stop --no-block "${unit}" >/dev/null 2>&1 || true
    if ! menu_wait_udp_unit_quiescent "${unit}" 10; then
      state="$(menu_udp_unit_active_state "${unit}")"
      echo "Gagal menghentikan backend UDP ${unit} (state=${state:-unknown})."
      return 1
    fi
  fi
  systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
}

switch_udp_to_zivpn() {
  local udpcustom
  udpcustom="$(detect_udpcustom_service)"
  menu_stop_disable_udp_unit "${udpcustom}" "udp-custom" || return 1
  systemctl enable "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
  systemctl restart "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
  ACTIVE_UDP_BACKEND="zivpn"
  update_sc_env_var "ACTIVE_UDP_BACKEND" "${ACTIVE_UDP_BACKEND}"
  update_app_env_var "ACTIVE_UDP_BACKEND" "${ACTIVE_UDP_BACKEND}"
  ensure_zivpn_dnat_for_zivpn
  udpcustom_port_range_rule del
  echo "Mode UDP aktif: ZIVPN (UDPHC dimatikan)."
}

switch_udp_to_udpcustom() {
  local udpcustom udphc_port
  udpcustom="$(detect_udpcustom_service)"
  udphc_port="$(jq -r '.listen // empty' /root/udp/config.json 2>/dev/null | sed -E 's/^:([0-9]+)$/\1/' | tr -cd '0-9')"
  [[ -z "${udphc_port}" ]] && udphc_port="5667"
  menu_stop_disable_udp_unit "${ZIVPN_SERVICE}" "zivpn" || return 1
  systemctl enable "${udpcustom}" >/dev/null 2>&1 || true
  systemctl restart "${udpcustom}" >/dev/null 2>&1 || true
  cleanup_zivpn_dnat_for_udphc
  if command -v iptables >/dev/null 2>&1; then
    iptables -w 10 -C INPUT -p udp --dport "${udphc_port}" -j ACCEPT >/dev/null 2>&1 || \
      iptables -w 10 -I INPUT -p udp --dport "${udphc_port}" -j ACCEPT
  elif command -v nft >/dev/null 2>&1; then
    if nft list chain inet filter input >/dev/null 2>&1; then
      nft list chain inet filter input | grep -F -- "udp dport ${udphc_port} accept" >/dev/null 2>&1 || \
        nft add rule inet filter input udp dport "${udphc_port}" accept
    elif nft list chain ip filter input >/dev/null 2>&1; then
      nft list chain ip filter input | grep -F -- "udp dport ${udphc_port} accept" >/dev/null 2>&1 || \
        nft add rule ip filter input udp dport "${udphc_port}" accept
    fi
  fi
  udpcustom_port_range_rule add "${udphc_port}"
  ACTIVE_UDP_BACKEND="udpcustom"
  update_sc_env_var "ACTIVE_UDP_BACKEND" "${ACTIVE_UDP_BACKEND}"
  update_app_env_var "ACTIVE_UDP_BACKEND" "${ACTIVE_UDP_BACKEND}"
  echo "Mode UDP aktif: UDPHC (ZIVPN dimatikan)."
}

restart_active_udp_backend() {
  local udpcustom zstat ustat preferred
  udpcustom="$(detect_udpcustom_service)"
  preferred="$(echo "${ACTIVE_UDP_BACKEND:-zivpn}" | tr '[:upper:]' '[:lower:]')"
  zstat="$(systemctl is-active "${ZIVPN_SERVICE}" 2>/dev/null || true)"
  ustat="$(systemctl is-active "${udpcustom}" 2>/dev/null || true)"
  if [[ "${zstat}" == "active" && "${ustat}" == "active" ]]; then
    if [[ "${preferred}" == "udpcustom" || "${preferred}" == "udp-custom" || "${preferred}" == "udphc" ]]; then
      menu_stop_disable_udp_unit "${ZIVPN_SERVICE}" "zivpn" || return 1
      systemctl restart "${udpcustom}" >/dev/null 2>&1 || true
      echo "Keduanya aktif, dipaksa single backend: UDPHC aktif, ZIVPN dimatikan."
    else
      menu_stop_disable_udp_unit "${udpcustom}" "udp-custom" || return 1
      systemctl restart "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
      echo "Keduanya aktif, dipaksa single backend: ZIVPN aktif, UDPHC dimatikan."
    fi
    return
  fi
  if [[ "${zstat}" == "active" ]]; then
    systemctl restart "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
    echo "Restart backend aktif: ZIVPN."
    return
  fi
  if [[ "${ustat}" == "active" ]]; then
    systemctl restart "${udpcustom}" >/dev/null 2>&1 || true
    echo "Restart backend aktif: UDPHC."
    return
  fi
  if [[ "${preferred}" == "udpcustom" || "${preferred}" == "udp-custom" || "${preferred}" == "udphc" ]]; then
    systemctl enable "${udpcustom}" >/dev/null 2>&1 || true
    systemctl restart "${udpcustom}" >/dev/null 2>&1 || true
    echo "Tidak ada backend aktif, menyalakan backend preferensi: UDPHC."
  else
    systemctl enable "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
    systemctl restart "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
    echo "Tidak ada backend aktif, menyalakan backend preferensi: ZIVPN."
  fi
}

restart_all_services() {
  local haproxy_ok="0"
  if haproxy -c -f /etc/haproxy/haproxy.cfg >/dev/null 2>&1; then
    haproxy_ok="1"
  else
    echo "Peringatan: config haproxy invalid, restart haproxy dilewati."
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  if declare -F ensure_sshws_firewall_allow_rules >/dev/null 2>&1; then
    ensure_sshws_firewall_allow_rules
  elif declare -F apply_sshws_loop_guard_rules >/dev/null 2>&1; then
    apply_sshws_loop_guard_rules
  else
    echo "Peringatan: helper firewall SSHWS tidak ditemukan, lanjut restart tanpa update firewall allow-rules."
  fi
  systemctl restart ssh dropbear sc-1forcr-api sc-1forcr-sshws xray nginx >/dev/null 2>&1 || true
  if [[ "${haproxy_ok}" == "1" ]]; then
    systemctl restart haproxy >/dev/null 2>&1 || true
  fi
  systemctl restart sc-1forcr-iplimit.timer >/dev/null 2>&1 || true
  systemctl start sc-1forcr-iplimit.service >/dev/null 2>&1 || true
  systemctl restart sc-1forcr-autoreboot.timer >/dev/null 2>&1 || true
  if [[ "${AUTO_BACKUP_ENABLE:-1}" == "1" ]]; then
    menu_ensure_auto_backup_timer_armed || true
  else
    systemctl disable --now sc-1forcr-autobackup.timer >/dev/null 2>&1 || true
  fi
  systemctl restart sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
  systemctl start sc-1forcr-online-notify.service >/dev/null 2>&1 || true
  if [[ "${RESOURCE_AUTOTUNE_ENABLE:-1}" == "1" ]]; then
    systemctl restart sc-1forcr-capacity-tune.timer >/dev/null 2>&1 || true
    systemctl start sc-1forcr-capacity-tune.service >/dev/null 2>&1 || true
  fi
  restart_active_udp_backend
}

restart_update_safe_services() {
  systemctl daemon-reload >/dev/null 2>&1 || true
  if declare -F ensure_sshws_firewall_allow_rules >/dev/null 2>&1; then
    ensure_sshws_firewall_allow_rules
  elif declare -F apply_sshws_loop_guard_rules >/dev/null 2>&1; then
    apply_sshws_loop_guard_rules
  fi

  systemctl restart sc-1forcr-api >/dev/null 2>&1 || true
  systemctl restart sc-1forcr-iplimit.timer >/dev/null 2>&1 || true
  # Jangan jalankan checker langsung saat update aman; checker bisa rebuild Xray
  # jika mendeteksi lock/quota/expired, dan itu dapat memutus sesi aktif.
  if [[ "${AUTO_REBOOT_ENABLE:-0}" == "1" ]]; then
    systemctl restart sc-1forcr-autoreboot.timer >/dev/null 2>&1 || true
  else
    systemctl stop sc-1forcr-autoreboot.timer >/dev/null 2>&1 || true
  fi
  if [[ "${AUTO_BACKUP_ENABLE:-1}" == "1" ]]; then
    menu_ensure_auto_backup_timer_armed || return 1
  else
    systemctl disable --now sc-1forcr-autobackup.timer >/dev/null 2>&1 || true
  fi
  if [[ "${ONLINE_NOTIFY_ENABLE:-1}" == "1" ]]; then
    systemctl restart sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
    systemctl start sc-1forcr-online-notify.service >/dev/null 2>&1 || true
  else
    systemctl stop sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
  fi
  if [[ "${AUTO_PULL_UPDATE_ENABLE:-1}" == "1" ]]; then
    systemctl restart sc-1forcr-pull-update.timer >/dev/null 2>&1 || true
    systemctl restart sc-1forcr-pull-summary-update.timer >/dev/null 2>&1 || true
  fi
  systemctl enable --now sc-1forcr-god-update.timer >/dev/null 2>&1 || true
  systemctl restart sc-1forcr-god-update.timer >/dev/null 2>&1 || true
  if [[ "${RESOURCE_AUTOTUNE_ENABLE:-1}" == "1" ]]; then
    systemctl restart sc-1forcr-capacity-tune.timer >/dev/null 2>&1 || true
    systemctl start sc-1forcr-capacity-tune.service >/dev/null 2>&1 || true
  fi
}

sync_xray_runtime_after_update() {
  local port token response api_ready attempt all_ports_ready capabilities
  port="$(printf '%s' "${API_PORT:-8088}" | tr -cd '0-9')"
  [[ -z "${port}" ]] && port="8088"
  token="${API_AUTH_TOKEN:-${AUTH_TOKEN:-}}"
  [[ -n "${token}" ]] || {
    log "Sinkronisasi Xray gagal: token API lokal kosong."
    return 1
  }

  api_ready="0"
  for attempt in {1..20}; do
    if curl -fsS --connect-timeout 2 --max-time 4 "http://127.0.0.1:${port}/vps/health" >/dev/null 2>&1; then
      api_ready="1"
      break
    fi
    sleep 1
  done
  [[ "${api_ready}" == "1" ]] || {
    log "Sinkronisasi Xray gagal: API lokal belum siap."
    return 1
  }

  response="$(curl -fsS --connect-timeout 3 --max-time 45 -X POST \
    -H "Authorization: Bearer ${token}" \
    "http://127.0.0.1:${port}/vps/sync-xray" 2>/dev/null || true)"
  if ! printf '%s' "${response}" | jq -e '.meta.code == 200 and .data.synced == true' >/dev/null 2>&1; then
    log "Sinkronisasi Xray pasca-update ditolak oleh API."
    journalctl -u sc-1forcr-api.service -n 20 --no-pager -o cat 2>/dev/null || true
    return 1
  fi

  all_ports_ready="0"
  for attempt in {1..20}; do
    all_ports_ready="1"
    for port in 10001 10002 10003 11001 11002 11003; do
      if ! ss -H -lnt 2>/dev/null | awk -v want="${port}" '
        { address=$4; sub(/^.*:/, "", address); if (address == want) found=1 }
        END { exit(found ? 0 : 1) }
      '; then
        all_ports_ready="0"
        break
      fi
    done
    [[ "${all_ports_ready}" == "1" ]] && break
    sleep 1
  done
  [[ "${all_ports_ready}" == "1" ]] || {
    log "Sinkronisasi Xray gagal: inbound 10001-10003/11001-11003 belum lengkap."
    return 1
  }

  [[ -x /usr/local/sbin/sc-1forcr-xray-live ]] || {
    log "Sinkronisasi Xray gagal: tracker realtime belum terpasang."
    return 1
  }
  capabilities="$(/usr/local/sbin/sc-1forcr-xray-live capabilities 2>/dev/null || true)"
  [[ "${capabilities}" == "rows-v3" ]] || {
    log "Sinkronisasi Xray gagal: tracker realtime tidak kompatibel (${capabilities:-unknown})."
    return 1
  }
  return 0
}

udp_port_from_config() {
  local cfg="$1" fallback="$2" port
  port="${fallback}"
  if [[ -f "${cfg}" ]]; then
    port="$(jq -r '.listen // empty' "${cfg}" 2>/dev/null | sed -E 's/^:([0-9]+)$/\1/' | tr -cd '0-9')"
  fi
  [[ -z "${port}" ]] && port="${fallback}"
  echo "${port}"
}

is_udp_port_listening() {
  local port="$1"
  ss -lunp 2>/dev/null | awk -v p=":${port}" '$5 ~ p"$" {ok=1} END {exit(ok?0:1)}'
}

diagnose_udp_backends() {
  local udpcustom zstat ustat zport uport
  udpcustom="$(detect_udpcustom_service)"
  zstat="$(systemctl is-active "${ZIVPN_SERVICE}" 2>/dev/null || true)"
  ustat="$(systemctl is-active "${udpcustom}" 2>/dev/null || true)"
  zport="$(udp_port_from_config /etc/zivpn/config.json 5667)"
  uport="$(udp_port_from_config /root/udp/config.json 5667)"

  draw_menu_header "DIAGNOSE UDP BACKEND"
  echo "ZIVPN service   : ${ZIVPN_SERVICE} (${zstat:-unknown})"
  echo "UDPHC service   : ${udpcustom} (${ustat:-unknown})"
  echo "ZIVPN port      : ${zport} ($(is_udp_port_listening "${zport}" && echo LISTEN || echo NO-LISTEN))"
  echo "UDPHC port      : ${uport} ($(is_udp_port_listening "${uport}" && echo LISTEN || echo NO-LISTEN))"
  echo
  echo "NAT PREROUTING (ringkas):"
  if command -v iptables >/dev/null 2>&1; then
    iptables -t nat -S PREROUTING 2>/dev/null | grep -E 'DNAT|553|5667|5668|6000:19999' || echo "(tidak ada rule terkait)"
  elif command -v nft >/dev/null 2>&1; then
    nft list chain ip nat prerouting 2>/dev/null | grep -E 'dnat|553|5667|5668|6000-19999' || echo "(tidak ada rule terkait)"
  else
    echo "(iptables/nft tidak tersedia)"
  fi
  echo
  if [[ "${zstat}" != "active" ]]; then
    echo "--- log ${ZIVPN_SERVICE} ---"
    journalctl -u "${ZIVPN_SERVICE}" -n 25 --no-pager 2>/dev/null || true
  fi
  if [[ "${ustat}" != "active" ]]; then
    echo "--- log ${udpcustom} ---"
    journalctl -u "${udpcustom}" -n 25 --no-pager 2>/dev/null || true
  fi
}

repair_udp_backends() {
  local udpcustom zstat ustat chosen preferred
  udpcustom="$(detect_udpcustom_service)"
  zstat="$(systemctl is-active "${ZIVPN_SERVICE}" 2>/dev/null || true)"
  ustat="$(systemctl is-active "${udpcustom}" 2>/dev/null || true)"
  preferred="$(echo "${ACTIVE_UDP_BACKEND:-zivpn}" | tr '[:upper:]' '[:lower:]')"
  chosen=""

  echo "Auto-repair UDP backend..."
  systemctl daemon-reload >/dev/null 2>&1 || true

  if [[ "${zstat}" == "active" && "${ustat}" == "active" ]]; then
    # Single backend policy: default ke ZIVPN saat bentrok.
    menu_stop_disable_udp_unit "${udpcustom}" "udp-custom" || return 1
    systemctl restart "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
    chosen="zivpn"
  elif [[ "${zstat}" == "active" ]]; then
    systemctl restart "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
    chosen="zivpn"
  elif [[ "${ustat}" == "active" ]]; then
    systemctl restart "${udpcustom}" >/dev/null 2>&1 || true
    chosen="udphc"
  else
    # Tidak ada aktif: prioritaskan backend sesuai ACTIVE_UDP_BACKEND.
    if [[ "${preferred}" == "udpcustom" || "${preferred}" == "udp-custom" || "${preferred}" == "udphc" ]]; then
      systemctl enable "${udpcustom}" >/dev/null 2>&1 || true
      if systemctl restart "${udpcustom}" >/dev/null 2>&1; then
        chosen="udphc"
      else
        systemctl enable "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
        systemctl restart "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
        chosen="zivpn"
      fi
    else
      systemctl enable "${ZIVPN_SERVICE}" >/dev/null 2>&1 || true
      if systemctl restart "${ZIVPN_SERVICE}" >/dev/null 2>&1; then
        chosen="zivpn"
      else
        systemctl enable "${udpcustom}" >/dev/null 2>&1 || true
        systemctl restart "${udpcustom}" >/dev/null 2>&1 || true
        chosen="udphc"
      fi
    fi
  fi

  sleep 1
  echo "Backend dipilih: ${chosen:-unknown}"
  diagnose_udp_backends
}

heal_sshws_xray_rules() {
  echo "Heal firewall rule SSHWS+XRAY..."
  if ! command -v iptables >/dev/null 2>&1; then
    echo "iptables tidak tersedia."
    return 1
  fi

  # Hapus rule legacy ketat yang sering ganggu HC/SSHWS.
  while iptables -w 10 -D INPUT -p tcp -m multiport --dports 80,443,109,143 \
    -m connlimit --connlimit-above 12 --connlimit-mask 32 -j REJECT --reject-with tcp-reset >/dev/null 2>&1; do :; done
  while iptables -w 10 -D INPUT -p tcp -m multiport --dports 80,443,109,143 \
    -m conntrack --ctstate NEW -m hashlimit --hashlimit-name sc_sshws_new --hashlimit-above 8/second \
    --hashlimit-burst 16 --hashlimit-mode srcip --hashlimit-srcmask 32 -j DROP >/dev/null 2>&1; do :; done

  if declare -F ensure_sshws_firewall_allow_rules >/dev/null 2>&1; then
    ensure_sshws_firewall_allow_rules
  fi
  if declare -F apply_sshws_loop_guard_rules >/dev/null 2>&1; then
    apply_sshws_loop_guard_rules
  fi

  # Guard di atas menyisipkan rule ACCEPT di puncak INPUT; gerbang layanan
  # yang OFF harus kembali ke atasnya.
  if [[ -x "${SERVICE_GATE_BIN:-}" ]]; then
    "${SERVICE_GATE_BIN}" apply || echo "Peringatan: status ON/OFF layanan belum bisa diterapkan ulang."
  fi

  fw_persist_rules
  echo "Heal rule SSHWS+XRAY selesai."
}

# Menu ON/OFF LAYANAN. Layanan yang OFF ditolak di iptables oleh
# sc-1forcr-service-gate; service systemd tetap jalan, jadi watchdog tidak
# menyalakannya lagi dan protokol lain tidak ikut terputus.
SERVICE_GATE_BIN="/usr/local/sbin/sc-1forcr-service-gate"
SERVICE_TOGGLE_ORDER=(ssh vmess vless trojan udp xhttp)

service_toggle_label() {
  case "$1" in
    ssh) echo "SSH WS/SSL/Dropbear" ;;
    vmess) echo "VMess" ;;
    vless) echo "VLESS" ;;
    trojan) echo "Trojan" ;;
    udp) echo "UDP ZIVPN/UDPHC" ;;
    xhttp) echo "XHTTP VLESS" ;;
  esac
}

# Satu baris panel: "N) Label ...... ON". OFF yang rule-nya belum terpasang
# ditandai kuning supaya admin tahu layanan itu masih bisa diakses.
service_toggle_item() {
  local num="$1" svc="$2" state="$3" detail="$4" label color
  label="$(service_toggle_label "${svc}")"
  case "${state}" in
    ON) color="${UI_OK}" ;;
    *) color="${UI_BAD}" ;;
  esac
  if [[ "${state}" == "OFF" && "${detail}" == "BELUM" ]]; then
    color="${UI_WARN}"
    state="OFF*"
  fi
  printf '%s) %-20s %s%s%s' "${num}" "${label}" "${color}${UI_BOLD}" "${state}" "${UI_NC}"
}

service_toggle_explain() {
  local svc="$1" want="$2" mem_mb
  case "${svc}:${want}" in
    ssh:off)
      echo "Efek: SSH-WS, SSH SSL/CONNECT, dan Dropbear ditolak; sesi SSH aktif terputus."
      echo "OpenSSH port 22 tetap terbuka untuk akses admin."
      echo "Pembuatan akun SSH baru lewat API baru diblokir kalau UDP juga OFF (akun SSH dipakai login UDP)."
      ;;
    vmess:off|vless:off|trojan:off)
      echo "Efek: sesi $(service_toggle_label "${svc}") aktif terputus dan akun baru ditolak API."
      echo "Xray tidak direstart; protokol lain tetap jalan."
      if [[ "${svc}" == "vless" ]]; then echo "XHTTP ikut tertutup karena memakai VLESS."; fi
      ;;
    udp:off)
      echo "Efek: ZIVPN/UDP Custom berhenti menerima koneksi; sesi UDP aktif terputus."
      ;;
    xhttp:on|xhttp:off)
      echo "Peringatan: Xray direstart sekali; semua sesi VMess/VLESS/Trojan reconnect."
      echo "Kalau Xray gagal memuat config baru, pengaturan dikembalikan otomatis."
      if [[ "${want}" == "on" ]]; then
        mem_mb="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)"
        if [[ "${mem_mb:-0}" =~ ^[0-9]+$ ]] && (( mem_mb > 0 && mem_mb < 1800 )); then
          echo "Peringatan: RAM VPS ${mem_mb} MB. XHTTP menambah pemakaian RAM Xray; disarankan untuk VPS 2 GB ke atas."
        fi
      fi
      ;;
    *:on)
      echo "Efek: layanan dibuka lagi tanpa restart service."
      ;;
  esac
}

service_toggle_switch() {
  local svc="$1" state="$2" want label confirm
  label="$(service_toggle_label "${svc}")"
  if [[ "${state}" == "ON" ]]; then want="off"; else want="on"; fi
  echo "Layanan         : ${label}"
  echo "Status sekarang : ${state}"
  echo "Diubah menjadi  : ${want^^}"
  echo
  service_toggle_explain "${svc}" "${want}"
  echo
  prompt_input confirm "Lanjut ubah ${label} ke ${want^^}? [y/N]: " || return 0
  if [[ ! "${confirm}" =~ ^[yY]$ ]]; then
    echo "Dibatalkan."
    return 0
  fi
  if [[ "${svc}" == "xhttp" ]]; then
    echo "Menunggu Xray memuat config baru (maksimal sekitar 1 menit)..."
  fi
  if "${SERVICE_GATE_BIN}" set "${svc}" "${want}"; then
    echo "Berhasil: ${label} sekarang ${want^^}."
  else
    echo "Gagal mengubah ${label}. Status lama dipertahankan."
  fi
  return 0
}

service_toggle_menu() {
  local choice svc state detail n missing
  local -A st=() dt=()
  if [[ ! -x "${SERVICE_GATE_BIN}" ]]; then
    echo "Gagal: ${SERVICE_GATE_BIN} belum terpasang. Jalankan update SC dulu."
    return 0
  fi
  while true; do
    st=(); dt=(); missing=0
    while read -r svc state detail; do
      [[ -n "${svc}" ]] || continue
      st["${svc}"]="${state}"
      dt["${svc}"]="${detail:--}"
      if [[ "${state}" == "OFF" && "${detail}" == "BELUM" ]]; then missing=1; fi
    done < <("${SERVICE_GATE_BIN}" status 2>/dev/null || true)
    if [[ -z "${UI_MODE:-}" ]]; then ui_init; fi
    clear
    draw_menu_panel "ON/OFF LAYANAN" \
      "$(service_toggle_item 1 ssh "${st[ssh]:-ON}" "${dt[ssh]:--}")" \
      "$(service_toggle_item 2 vmess "${st[vmess]:-ON}" "${dt[vmess]:--}")" \
      "$(service_toggle_item 3 vless "${st[vless]:-ON}" "${dt[vless]:--}")" \
      "$(service_toggle_item 4 trojan "${st[trojan]:-ON}" "${dt[trojan]:--}")" \
      "$(service_toggle_item 5 udp "${st[udp]:-ON}" "${dt[udp]:--}")" \
      "$(service_toggle_item 6 xhttp "${st[xhttp]:-OFF}" "${dt[xhttp]:--}")" \
      "7) Terapkan ulang (repair rule)" \
      "0) Kembali"
    if (( missing )); then
      echo "Peringatan: layanan bertanda OFF* belum tertutup. Pilih 7 untuk memasang ulang rule."
    fi
    echo
    if ! prompt_input choice "Pilih [0-7]: "; then
      return 0
    fi
    clear
    case "${choice}" in
      1) service_toggle_switch ssh "${st[ssh]:-ON}" ;;
      2) service_toggle_switch vmess "${st[vmess]:-ON}" ;;
      3) service_toggle_switch vless "${st[vless]:-ON}" ;;
      4) service_toggle_switch trojan "${st[trojan]:-ON}" ;;
      5) service_toggle_switch udp "${st[udp]:-ON}" ;;
      6) service_toggle_switch xhttp "${st[xhttp]:-OFF}" ;;
      7)
        if "${SERVICE_GATE_BIN}" apply; then
          echo "Berhasil menerapkan ulang status ON/OFF layanan."
        else
          echo "Gagal menerapkan status ON/OFF layanan."
        fi
        ;;
      0) return 0 ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    echo
    menu_pause
  done
}

service_menu() {
  local udpcustom
  udpcustom="$(detect_udpcustom_service)"
  draw_menu_panel "SERVICE MENU" \
    "0) kembali" \
    "1) status semua" \
    "2) restart semua" \
    "3) restart backend UDP aktif" \
    "4) aktifkan ZIVPN (matikan UDPHC)" \
    "5) aktifkan UDPHC (matikan ZIVPN)" \
    "6) status backend UDP" \
    "7) diagnose + auto-repair UDP backend" \
    "8) heal rule SSHWS+XRAY" \
    "9) resource auto tune"
  prompt_input s "Pilih [0-9]: " || return
  clear
  case "$s" in
    0)
      return
      ;;
    1)
      show_core_services_onoff
      ;;
    2)
      restart_all_services
      echo "Restart selesai."
      ;;
    3)
      restart_active_udp_backend
      ;;
    4)
      switch_udp_to_zivpn
      ;;
    5)
      switch_udp_to_udpcustom
      ;;
    6)
      udp_backend_status | ui_fx
      ;;
    7)
      repair_udp_backends
      ;;
    8)
      heal_sshws_xray_rules
      ;;
    9)
      if [[ -x /usr/local/sbin/sc-1forcr-capacity-tune ]]; then
        /usr/local/sbin/sc-1forcr-capacity-tune >/dev/null 2>&1 || true
      fi
      show_capacity_report | ui_fx
      ;;
    *)
      echo "Pilihan tidak valid."
      ;;
  esac
}

set_backup_web_config_menu() {
  local current_enable enable_in desired_state current_url
  current_enable="$(normalize_bool_01 "${BACKUP_WEB_ENABLE:-0}")"
  current_url="https://${DOMAIN}/vps/backup-ui"
  echo "SETTING WEB BACKUP & RESTORE"
  echo "Status sekarang : $([[ "${current_enable}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  echo "URL saat aktif  : ${current_url}"
  echo "Auth            : wajib API token server ini"
  echo
  echo "Catatan: lewat web ini akun bisa di-restore (menimpa data)."
  echo "Aktifkan hanya kalau API token kamu memang aman."
  echo
  prompt_input enable_in "Aktifkan web backup/restore? [1/0, enter=keep]: " || return
  enable_in="$(echo "${enable_in:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "${enable_in}" in
    1|true|yes|on) desired_state="1" ;;
    0|false|no|off) desired_state="0" ;;
    "") desired_state="${current_enable}" ;;
    *) echo "Input tidak valid, status lama dipakai."; desired_state="${current_enable}" ;;
  esac

  BACKUP_WEB_ENABLE="${desired_state}"
  update_sc_env_var "BACKUP_WEB_ENABLE" "${BACKUP_WEB_ENABLE}"
  update_app_env_var "BACKUP_WEB_ENABLE" "${BACKUP_WEB_ENABLE}"
  systemctl restart sc-1forcr-api >/dev/null 2>&1 || true

  echo
  echo "Berhasil update web backup/restore:"
  echo "- Status : $([[ "${BACKUP_WEB_ENABLE}" == "1" ]] && echo AKTIF || echo NONAKTIF)"
  if [[ "${BACKUP_WEB_ENABLE}" == "1" ]]; then
    echo "- URL    : ${current_url}"
    echo "- Token  : ${API_AUTH_TOKEN:-${AUTH_TOKEN:-lihat /etc/sc-1forcr.env}}"
  else
    echo "- URL    : nonaktif"
  fi
}

backup_restore_menu() {
  local full_file
  draw_menu_panel "BACKUP/RESTORE" \
    "0) Kembali" \
    "1) BACKUP AKUN + AUTH ZIVPN (1 file JSON) & kirim ke Telegram" \
    "2) Restore AKUN + AUTH ZIVPN (.json) dari path file" \
    "3) Web Backup & Restore (on/off + link)"
  prompt_input b "Pilih [0-3]: " || return
  clear
  case "$b" in
    0)
      return
      ;;
    3)
      set_backup_web_config_menu
      ;;
    1)
      if [[ -x /usr/local/sbin/sc-1forcr-auto-backup ]]; then
        /usr/local/sbin/sc-1forcr-auto-backup manual
      else
        echo "Script auto backup belum tersedia."
      fi
      ;;
    2)
      prompt_input full_file "Path file backup (.json): " || return
      if [[ -z "${full_file}" || ! -f "${full_file}" ]]; then
        echo "File backup tidak ditemukan."
        return
      fi
      if [[ -x /usr/local/sbin/sc-1forcr-restore-backup ]]; then
        /usr/local/sbin/sc-1forcr-restore-backup "${full_file}"
      else
        echo "Script restore backup belum tersedia."
      fi
      ;;
    *)
      echo "Pilihan tidak valid."
      ;;
  esac
}

change_domain_menu() {
  local new_domain email app_env pem cert_domain haproxy_maxconn haproxy_nbthread haproxy_limit_nofile haproxy_log_option cores nginx_server_names
  local xray_ws_backend_line xray_grpc_backend_line
  local xray_realip_nginx_map xray_realip_ws_listener xray_realip_grpc_listener
  local xray_proxy_realip_headers xray_grpc_realip_headers nginx_ipv6_listen
  prompt_input new_domain "Masukkan domain baru: " || return
  new_domain="$(sanitize_domain_host "${new_domain}")"
  if [[ -z "${new_domain}" ]]; then
    echo "Domain tidak boleh kosong."
    return
  fi

  # Tidak perlu input email tiap ganti domain:
  # pakai EMAIL lama jika valid, fallback admin@domain.
  email="${EMAIL:-}"
  if [[ -z "${email}" || "${email}" == "admin@example.com" || "${email}" == *"@example.com" ]]; then
    email="admin@${new_domain}"
  fi

  DOMAIN="${new_domain}"
  EMAIL="${email}"
  WILDCARD_BASE_DOMAIN="$(sanitize_domain_host "${WILDCARD_BASE_DOMAIN:-}")"
  WILDCARD_BUG_PREFIX="$(csv_first_item "$(normalize_domain_host_list "${WILDCARD_BUG_PREFIX:-}")")"
  WILDCARD_BUG_PREFIXES="$(normalize_domain_host_list "${WILDCARD_BUG_PREFIXES:-}")"
  WILDCARD_XRAY_HOST="$(csv_first_item "$(normalize_domain_host_list "${WILDCARD_XRAY_HOST:-}")")"
  WILDCARD_XRAY_HOSTS="$(normalize_domain_host_list "${WILDCARD_XRAY_HOSTS:-}")"
  XRAY_FRONT_DOMAIN="$(csv_first_item "$(normalize_domain_host_list "${XRAY_FRONT_DOMAIN:-}")")"
  XRAY_FRONT_DOMAINS="$(normalize_domain_host_list "${XRAY_FRONT_DOMAINS:-}")"
  XRAY_PUBLIC_HOST="$(build_xray_public_host)"

  mkdir -p /var/www/html
  local sshws_nginx_limit_conf sshws_nginx_limit_rules sshws_realip_nginx_map
  sshws_nginx_limit_conf=""
  sshws_nginx_limit_rules=""
  sshws_realip_nginx_map="$(build_sshws_realip_nginx_map)"
  xray_realip_nginx_map=""
  xray_realip_ws_listener=""
  xray_realip_grpc_listener=""
  xray_proxy_realip_headers=""
  xray_grpc_realip_headers=""
  nginx_server_names="$(build_nginx_server_names)"
  if flag_enabled "${SSHWS_NGINX_LIMIT_ENABLE:-1}"; then
    sshws_nginx_limit_conf=$(cat <<EOF_LIMIT
map \$sc_sshws_real_ip \$sc_sshws_limit_key {
    "" \$binary_remote_addr;
    default \$sc_sshws_real_ip;
}
# Klien WebSocket asli (Sec-WebSocket-Key) adalah Xray multi path yang
# membuka satu koneksi per aplikasi. Kunci kosong = tidak dihitung, sama
# seperti location /vmess, /vless, dan /trojan yang tidak dibatasi.
map \$http_sec_websocket_key \$sc_sshws_limit_scope {
    "" \$sc_sshws_limit_key;
    default "";
}
limit_req_zone \$sc_sshws_limit_scope zone=sc_sshws_req:10m rate=${SSHWS_NGINX_LIMIT_RATE};
limit_conn_zone \$sc_sshws_limit_scope zone=sc_sshws_conn:10m;

EOF_LIMIT
)
    sshws_nginx_limit_rules=$(cat <<EOF_LIMIT
        limit_req zone=sc_sshws_req burst=${SSHWS_NGINX_LIMIT_BURST} nodelay;
        limit_conn sc_sshws_conn ${SSHWS_NGINX_LIMIT_CONN};
        limit_req_status 429;
        limit_conn_status 429;
EOF_LIMIT
)
  fi
  if flag_enabled "${XRAY_REAL_IP_ENABLE:-0}"; then
    xray_realip_nginx_map=$(cat <<'EOF_REALIP'
map $sc_sshws_real_ip $sc_xray_real_ip {
    default $sc_sshws_real_ip;
}
EOF_REALIP
)
    xray_realip_ws_listener="    listen 127.0.0.1:8080 proxy_protocol;"
    xray_realip_grpc_listener="    listen 127.0.0.1:8082 proxy_protocol http2;"
    xray_proxy_realip_headers=$(cat <<'EOF_REALIP'
        proxy_set_header X-Forwarded-For $sc_xray_real_ip;
        proxy_set_header X-SC-Real-IP-Proxy "1";
EOF_REALIP
)
    xray_grpc_realip_headers=$(cat <<'EOF_REALIP'
        grpc_set_header X-Forwarded-For $sc_xray_real_ip;
        grpc_set_header X-SC-Real-IP-Proxy "1";
EOF_REALIP
)
  fi
  nginx_ipv6_listen=""
  if ipv6_supported; then
    nginx_ipv6_listen="    listen [::]:80;"
  else
    log "IPv6 tidak tersedia di VPS ini. Nginx listen IPv4 saja (port 80)."
  fi
  nginx_vhost_backup="/var/lib/sc-1forcr/backup/nginx/sc-1forcr.conf.pre-$(date +%s)"
  mkdir -p /var/lib/sc-1forcr/backup/nginx 2>/dev/null || true
  if [[ -e /etc/nginx/sites-available/sc-1forcr.conf ]]; then
    cp -a /etc/nginx/sites-available/sc-1forcr.conf "${nginx_vhost_backup}" 2>/dev/null || true
  fi
  cat > /etc/nginx/sites-available/sc-1forcr.conf <<EONGINX
${sshws_realip_nginx_map}
${sshws_nginx_limit_conf}
${xray_realip_nginx_map}

server {
    listen 80;
${nginx_ipv6_listen}
    listen 127.0.0.1:8083 proxy_protocol;
${xray_realip_ws_listener}
    server_name ${nginx_server_names};
    keepalive_timeout 30;

    location /.well-known/acme-challenge/ { root /var/www/html; }


    location = /cdn-cgi/trace {
        access_log off;
        proxy_redirect off;
        proxy_pass http://127.0.0.1:2082;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-SC-SSHWS-IP \$sc_sshws_real_ip;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location /vps/ {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    include /etc/nginx/snippets/sc-1forcr-api-docs.conf;

    location /vmess {
        access_log off;
        proxy_redirect off;
        proxy_pass http://127.0.0.1:10001;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location /yourbug {
        access_log off;
        proxy_redirect off;
        rewrite ^ /vmess break;
        proxy_pass http://127.0.0.1:10001;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location /vless {
        access_log off;
        proxy_redirect off;
        proxy_pass http://127.0.0.1:10002;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location /yourbug/vless {
        access_log off;
        proxy_redirect off;
        rewrite ^ /vless break;
        proxy_pass http://127.0.0.1:10002;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location /trojan {
        access_log off;
        proxy_redirect off;
        proxy_pass http://127.0.0.1:10003;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location /upvmess {
        access_log off;
        proxy_redirect off;
        proxy_pass http://127.0.0.1:10004;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location /upvless {
        access_log off;
        proxy_redirect off;
        proxy_pass http://127.0.0.1:10005;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location /uptrojan {
        access_log off;
        proxy_redirect off;
        proxy_pass http://127.0.0.1:10006;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    # XHTTP VLESS lewat HTTP/1.1: non-TLS port 80 dan TLS dengan ALPN http/1.1.
    # Unduhan (GET panjang) dan unggahan (POST) harus mengalir tanpa buffer.
    # Inbound hanya ada bila XRAY_XHTTP_ENABLE=1.
    location /xhvless {
        access_log off;
        proxy_redirect off;
        proxy_pass http://127.0.0.1:12002;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
    }

    location /vmess-grpc {
        access_log off;
        grpc_set_header Host \$host;
${xray_grpc_realip_headers}
        grpc_read_timeout 3600s;
        grpc_send_timeout 3600s;
        grpc_pass grpc://127.0.0.1:11001;
    }

    location /vless-grpc {
        access_log off;
        grpc_set_header Host \$host;
${xray_grpc_realip_headers}
        grpc_read_timeout 3600s;
        grpc_send_timeout 3600s;
        grpc_pass grpc://127.0.0.1:11002;
    }

    location /trojan-grpc {
        access_log off;
        grpc_set_header Host \$host;
${xray_grpc_realip_headers}
        grpc_read_timeout 3600s;
        grpc_send_timeout 3600s;
        grpc_pass grpc://127.0.0.1:11003;
    }

    location /yourbug/trojan {
        access_log off;
        proxy_redirect off;
        rewrite ^ /trojan break;
        proxy_pass http://127.0.0.1:10003;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
${xray_proxy_realip_headers}
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location ~ ^/(ssh-ws|ws|ws-ssh|ssh)$ {
        access_log off;
${sshws_nginx_limit_rules}
        proxy_redirect off;
        proxy_pass http://127.0.0.1:2082;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-SC-SSHWS-IP \$sc_sshws_real_ip;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }

    location / {
        access_log off;
${sshws_nginx_limit_rules}
        proxy_redirect off;
        proxy_pass http://127.0.0.1:2082;
        proxy_http_version 1.1;
        proxy_method GET;
        proxy_set_header Upgrade "websocket";
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-SC-SSHWS-IP \$sc_sshws_real_ip;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
    }
}

server {
    listen 127.0.0.1:8081 http2;
${xray_realip_grpc_listener}
    server_name _;

    include /etc/nginx/snippets/sc-1forcr-api-docs.conf;

    # Browser memakai HTTP/2 (ALPN h2), dan HAProxy mengarahkan semua koneksi
    # h2 ke backend gRPC ini. Tanpa location /vps/ di sini, halaman web yang
    # dilayani API (mis. /vps/backup-ui) selalu jatuh ke "location /" dan
    # balasannya 404 dari nginx, padahal lewat HTTP/1.1 normal saja.
    location /vps/ {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /vmess-grpc {
        access_log off;
        grpc_set_header Host \$host;
${xray_grpc_realip_headers}
        grpc_read_timeout 3600s;
        grpc_send_timeout 3600s;
        grpc_pass grpc://127.0.0.1:11001;
    }

    location /vless-grpc {
        access_log off;
        grpc_set_header Host \$host;
${xray_grpc_realip_headers}
        grpc_read_timeout 3600s;
        grpc_send_timeout 3600s;
        grpc_pass grpc://127.0.0.1:11002;
    }

    location /trojan-grpc {
        access_log off;
        grpc_set_header Host \$host;
${xray_grpc_realip_headers}
        grpc_read_timeout 3600s;
        grpc_send_timeout 3600s;
        grpc_pass grpc://127.0.0.1:11003;
    }

    # XHTTP VLESS (stream-up lewat H2). Inbound hanya ada bila XRAY_XHTTP_ENABLE=1.
    location /xhvless {
        access_log off;
        grpc_set_header Host \$host;
${xray_grpc_realip_headers}
        grpc_read_timeout 3600s;
        grpc_send_timeout 3600s;
        grpc_pass grpc://127.0.0.1:12002;
    }

    location / {
        return 404;
    }
}
EONGINX

  ln -sf /etc/nginx/sites-available/sc-1forcr.conf /etc/nginx/sites-enabled/sc-1forcr.conf
  rm -f /etc/nginx/sites-enabled/default
  tune_nginx_capacity
  if ! nginx -t; then
    echo "Konfigurasi nginx invalid. Mengembalikan konfigurasi sebelumnya (tanpa reload nginx)."
    rm -f /etc/nginx/sites-enabled/sc-1forcr.conf
    if [[ -n "${nginx_vhost_backup:-}" && -f "${nginx_vhost_backup}" ]]; then
      cp -a "${nginx_vhost_backup}" /etc/nginx/sites-available/sc-1forcr.conf
      ln -sf /etc/nginx/sites-available/sc-1forcr.conf /etc/nginx/sites-enabled/sc-1forcr.conf
    else
      rm -f /etc/nginx/sites-available/sc-1forcr.conf
    fi
    return
  fi
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx || true
  else
    systemctl start nginx || true
  fi

  if ! issue_letsencrypt_cert; then
    echo "Peringatan: issue cert Let's Encrypt untuk ${new_domain} gagal. Lanjut dengan cert sementara."
    if flag_enabled "${WILDCARD_ENABLE:-0}"; then
      echo "Cek WILDCARD_BASE_DOMAIN dan kredensial Cloudflare."
    else
      echo "Cek A record domain ke VPS."
    fi
    echo "Cert dicoba terbitkan lagi otomatis tiap 12 jam. Cek status: sc-1forcr-cert-sync status"
  fi

  pem="$(prepare_haproxy_pem)" || {
    echo "Gagal menyiapkan sertifikat HAProxy."
    return
  }
  haproxy_maxconn="$(echo "${HAPROXY_MAXCONN:-4096}" | tr -cd '0-9')"
  [[ -z "${haproxy_maxconn}" || "${haproxy_maxconn}" -lt 1024 ]] && haproxy_maxconn="4096"
  haproxy_nbthread="$(echo "${HAPROXY_NBTHREAD:-1}" | tr -cd '0-9')"
  [[ -z "${haproxy_nbthread}" || "${haproxy_nbthread}" -lt 1 ]] && haproxy_nbthread="1"
  cores="$(get_cpu_cores)"
  [[ -z "${cores}" || ! "${cores}" =~ ^[0-9]+$ || "${cores}" -lt 1 ]] && cores="1"
  [[ "${haproxy_nbthread}" -gt "${cores}" ]] && haproxy_nbthread="${cores}"
  [[ "${haproxy_nbthread}" -gt 8 ]] && haproxy_nbthread="8"
  [[ -z "${haproxy_nbthread}" || ! "${haproxy_nbthread}" =~ ^[0-9]+$ || "${haproxy_nbthread}" -lt 1 ]] && haproxy_nbthread="1"
  haproxy_limit_nofile="$(echo "${HAPROXY_SERVICE_LIMIT_NOFILE:-65536}" | tr -cd '0-9')"
  [[ -z "${haproxy_limit_nofile}" || "${haproxy_limit_nofile}" -lt 32768 ]] && haproxy_limit_nofile="65536"
  if flag_enabled "${HAPROXY_TCPLOG_ENABLE:-0}"; then
    haproxy_log_option="    option tcplog"
  else
    haproxy_log_option="    option dontlog-normal
    option log-separate-errors"
  fi
  if flag_enabled "${XRAY_REAL_IP_ENABLE:-0}"; then
    xray_ws_backend_line="    server nginx_local 127.0.0.1:8083 check inter 2s fall 3 rise 2 send-proxy-v2"
    xray_grpc_backend_line="    server nginx_grpc 127.0.0.1:8082 check inter 2s fall 3 rise 2 send-proxy-v2"
  else
    xray_ws_backend_line="    server nginx_local 127.0.0.1:8083 check inter 2s fall 3 rise 2 send-proxy-v2"
    xray_grpc_backend_line="    server nginx_grpc 127.0.0.1:8081 check inter 2s fall 3 rise 2"
  fi

  cat > /etc/haproxy/haproxy.cfg <<EOHAP
global
    # Level paling parah dibatasi ke alert. Tanpa itu, "backend ... has no server
    # available!" dikirim sebagai emerg dan journald menyiarkannya ke semua
    # terminal yang sedang login, termasuk layar menu dan layar install.
    log /dev/log local0 notice alert
    daemon
    maxconn ${haproxy_maxconn}
    nbthread ${haproxy_nbthread}
    # Kompatibilitas TLS maksimum (security lebih lemah) untuk klien lawas/HC.
    ssl-default-bind-ciphers DEFAULT:@SECLEVEL=0
    ssl-default-bind-ciphersuites TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256
    ssl-default-bind-options no-sslv3

defaults
    log global
    mode tcp
${haproxy_log_option}
    option dontlognull
    # Deteksi peer yang hilang tanpa memangkas timeout tunnel aktif 12 jam.
    option clitcpka
    option srvtcpka
    timeout connect 30s
    # WS tunnel perlu timeout panjang; 2m sering bikin koneksi putus sendiri.
    timeout client  12h
    timeout server  12h

frontend ft_443
    # Tetap longgar TLS, tapi paksa HTTP/1.1 agar WS (sshws/v2ray ws) tidak negosiasi h2.
    bind *:443 ssl crt ${pem} alpn h2,http/1.1 ssl-min-ver TLSv1.0 ssl-max-ver TLSv1.3
    tcp-request inspect-delay 5s
    tcp-request content accept if HTTP
    tcp-request content accept if WAIT_END
    acl is_h2_preface req.payload(0,14) -m str "PRI * HTTP/2.0"
    acl is_ssh_banner req.payload(0,4) -m str "SSH-"
    acl is_xray_vmess req.payload(0,256),lower -m sub "get /vmess"
    acl is_xray_vmess_bug req.payload(0,256),lower -m sub "get /yourbug"
    acl is_xray_vless req.payload(0,256),lower -m sub "get /vless"
    acl is_xray_vless_bug req.payload(0,256),lower -m sub "get /yourbug/vless"
    acl is_xray_trojan req.payload(0,256),lower -m sub "get /trojan"
    acl is_xray_trojan_bug req.payload(0,256),lower -m sub "get /yourbug/trojan"
    acl is_api_vps req.payload(0,256),lower -m sub " /vps/"
    # Beberapa client HC mengirim baris CONNECT terfragmentasi / tidak persis di awal payload.
    # Gunakan deteksi lebih longgar agar SSL-only tetap masuk backend sshws.
    acl is_hc_connect req.payload(0,512),lower -m sub "connect "
    use_backend bk_grpc if is_h2_preface
    use_backend bk_mux if is_h2_preface || is_xray_vmess || is_xray_vmess_bug || is_xray_vless || is_xray_vless_bug || is_xray_trojan || is_xray_trojan_bug || is_api_vps
    use_backend bk_sshws_tls if is_hc_connect
    use_backend bk_sshws_tls if is_ssh_banner
    # Default 443 diarahkan ke mux agar VMESS/VLESS/TROJAN WS tidak nyasar ke sshws.
    # SSH SSL-only tetap ditangani via route CONNECT (is_hc_connect) dan fallback nginx / -> 2082.
    default_backend bk_mux

backend bk_mux
    mode tcp
    # TLS terminasi di HAProxy, lalu HTTP/WS diteruskan langsung ke Nginx.
    # Ini menjaga jalur VMESS/VLESS WS stabil tanpa lewat sshws mux.
${xray_ws_backend_line}

backend bk_grpc
    mode tcp
    # Jalur khusus gRPC (HTTP/2) ke listener Nginx internal agar tidak mengganggu WS existing.
${xray_grpc_backend_line}

backend bk_sshws_tls
    mode tcp
    # Jalur khusus HTTP Custom SSL-only (payload CONNECT) langsung ke sshws mux.
    server sshws_local 127.0.0.1:2082 check inter 2s fall 3 rise 2 send-proxy
EOHAP

  mkdir -p /etc/systemd/system/haproxy.service.d
  cat > /etc/systemd/system/haproxy.service.d/sc-1forcr-order.conf <<EOF
[Unit]
After=network-online.target nginx.service sc-1forcr-sshws.service
Wants=network-online.target nginx.service sc-1forcr-sshws.service

[Service]
LimitNOFILE=${haproxy_limit_nofile}
EOF
  systemctl daemon-reload >/dev/null 2>&1 || true
  haproxy -c -f /etc/haproxy/haproxy.cfg || {
    echo "Konfigurasi haproxy invalid."
    return
  }
  if systemctl is-active --quiet haproxy; then
    systemctl reload haproxy || systemctl restart haproxy || true
  else
    systemctl start haproxy || true
  fi

  if [[ ! -s "${pem}" ]]; then
    echo "Gagal menyiapkan sertifikat HAProxy untuk domain ${new_domain}."
    if flag_enabled "${WILDCARD_ENABLE:-0}"; then
      echo "Pastikan wildcard cert berhasil terbit untuk domain kamu."
    else
      echo "Pastikan A record domain mengarah ke VPS, lalu ulangi."
    fi
    return
  fi

  if [[ -f /etc/sc-1forcr.env ]]; then
    if grep -q '^DOMAIN=' /etc/sc-1forcr.env; then
      sed -i "s/^DOMAIN=.*/DOMAIN=${new_domain}/" /etc/sc-1forcr.env
    else
      echo "DOMAIN=${new_domain}" >> /etc/sc-1forcr.env
    fi
  fi

  app_env="/opt/sc-1forcr/.env"
  if [[ ! -f "${app_env}" ]]; then
    app_env="/opt/potato-compat/.env"
  fi
  if [[ -f "${app_env}" ]]; then
    if grep -q '^DOMAIN=' "${app_env}"; then
      sed -i "s/^DOMAIN=.*/DOMAIN=${new_domain}/" "${app_env}"
    else
      echo "DOMAIN=${new_domain}" >> "${app_env}"
    fi
  fi
  if [[ -f /etc/sc-1forcr.env ]]; then
    update_sc_env_var "WILDCARD_BUG_PREFIX" "${WILDCARD_BUG_PREFIX:-}"
    update_sc_env_var "WILDCARD_BUG_PREFIXES" "${WILDCARD_BUG_PREFIXES:-}"
    update_sc_env_var "WILDCARD_XRAY_HOST" "${WILDCARD_XRAY_HOST:-}"
    update_sc_env_var "WILDCARD_XRAY_HOSTS" "${WILDCARD_XRAY_HOSTS:-}"
    update_sc_env_var "XRAY_PUBLIC_HOST" "${XRAY_PUBLIC_HOST:-}"
    update_sc_env_var "XRAY_FRONT_DOMAIN" "${XRAY_FRONT_DOMAIN:-}"
    update_sc_env_var "XRAY_FRONT_DOMAINS" "${XRAY_FRONT_DOMAINS:-}"
  fi
  update_app_env_var "WILDCARD_BUG_PREFIX" "${WILDCARD_BUG_PREFIX:-}"
  update_app_env_var "WILDCARD_BUG_PREFIXES" "${WILDCARD_BUG_PREFIXES:-}"
  update_app_env_var "WILDCARD_XRAY_HOST" "${WILDCARD_XRAY_HOST:-}"
  update_app_env_var "WILDCARD_XRAY_HOSTS" "${WILDCARD_XRAY_HOSTS:-}"
  update_app_env_var "XRAY_PUBLIC_HOST" "${XRAY_PUBLIC_HOST:-}"
  update_app_env_var "XRAY_FRONT_DOMAIN" "${XRAY_FRONT_DOMAIN:-}"
  update_app_env_var "XRAY_FRONT_DOMAINS" "${XRAY_FRONT_DOMAINS:-}"

  if declare -F prepare_api_docs_site >/dev/null 2>&1; then
    prepare_api_docs_site || true
  else
    mkdir -p /etc/nginx/snippets
    cat > /etc/nginx/snippets/sc-1forcr-api-docs.conf <<'EOF'
# SC 1FORCR API docs disabled
location = /docs {
    return 404;
}

location ^~ /docs/ {
    return 404;
}
EOF
  fi
  systemctl restart sc-1forcr-api sc-1forcr-sshws
  systemctl reload nginx
  systemctl reload haproxy || systemctl restart haproxy
  echo "Domain berhasil diubah ke ${new_domain}"
}

monitor_temp_lock_menu() {
  draw_menu_header "MONITOR & RIWAYAT IP LIMIT"
  if [[ ! -f "${DB_PATH}" ]]; then
    echo "DB tidak ditemukan: ${DB_PATH}"
    return
  fi

  local count
  count="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='temp_ip_locks';" 2>/dev/null || echo 0)"
  if [[ "${count}" != "1" ]]; then
    echo "Tabel temp_ip_locks belum ada."
    return
  fi

  echo "Lock aktif saat ini:"
  sqlite3 -header -column "${DB_PATH}" "
    SELECT
      account_type AS type,
      username,
      datetime(locked_until, 'unixepoch', 'localtime') AS unlock_at,
      CASE
        WHEN (locked_until - strftime('%s','now')) > 0
          THEN CAST((locked_until - strftime('%s','now')) AS INTEGER)
        ELSE 0
      END AS remain_sec
    FROM temp_ip_locks
    ORDER BY locked_until ASC;
  " || true

  local xray_lock_count xray_cfg xray_service_state
  xray_lock_count="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM temp_ip_locks WHERE account_type IN ('vmess','vless','trojan');" 2>/dev/null || echo 0)"
  if [[ "${xray_lock_count}" =~ ^[0-9]+$ ]] && [[ "${xray_lock_count}" -gt 0 ]]; then
    xray_cfg="/usr/local/etc/xray/config.json"
    xray_service_state="STOPPED"
    systemctl is-active --quiet xray 2>/dev/null && xray_service_state="ACTIVE"
    echo
    echo "XRAY RUNTIME ENFORCEMENT:"
    printf '%-8s %-20s %-12s %-10s %-10s\n' "TYPE" "USERNAME" "DB_STATUS" "CONFIG" "SERVICE"
    sqlite3 -separator '|' "${DB_PATH}" "
      SELECT l.account_type, l.username,
        CASE l.account_type
          WHEN 'vmess' THEN COALESCE((SELECT status FROM account_vmesses WHERE LOWER(username)=LOWER(l.username) LIMIT 1),'-')
          WHEN 'vless' THEN COALESCE((SELECT status FROM account_vlesses WHERE LOWER(username)=LOWER(l.username) LIMIT 1),'-')
          WHEN 'trojan' THEN COALESCE((SELECT status FROM account_trojans WHERE LOWER(username)=LOWER(l.username) LIMIT 1),'-')
        END,
        CASE l.account_type
          WHEN 'vmess' THEN COALESCE((SELECT uuid FROM account_vmesses WHERE LOWER(username)=LOWER(l.username) LIMIT 1),'')
          WHEN 'vless' THEN COALESCE((SELECT uuid FROM account_vlesses WHERE LOWER(username)=LOWER(l.username) LIMIT 1),'')
          WHEN 'trojan' THEN COALESCE((SELECT password FROM account_trojans WHERE LOWER(username)=LOWER(l.username) LIMIT 1),'')
        END
      FROM temp_ip_locks l
      WHERE l.account_type IN ('vmess','vless','trojan')
      ORDER BY l.locked_until ASC;
    " 2>/dev/null | while IFS='|' read -r lock_type lock_user db_status lock_secret; do
      local config_state="UNKNOWN"
      if [[ -s "${xray_cfg}" ]] && command -v jq >/dev/null 2>&1; then
        if jq -e --arg proto "${lock_type}" --arg secret "${lock_secret}" '
          any(.inbounds[]?;
            ((.protocol // "") | ascii_downcase) == ($proto | ascii_downcase) and
            any(.settings.clients[]?;
              if ($proto | ascii_downcase) == "trojan" then
                ((.password // "") | tostring) == $secret
              else
                (((.id // "") | tostring | ascii_downcase) == ($secret | ascii_downcase))
              end
            )
          )
        ' "${xray_cfg}" >/dev/null 2>&1; then
          config_state="LEAK"
        else
          config_state="CLEAN"
        fi
      fi
      printf '%-8s %-20s %-12s %-10s %-10s\n' \
        "${lock_type}" "${lock_user}" "${db_status}" "${config_state}" "${xray_service_state}"
    done
  fi

  local history_count
  history_count="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='iplimit_lock_history';" 2>/dev/null || echo 0)"
  if [[ "${history_count}" == "1" ]]; then
    echo
    echo "20 riwayat lock terbaru (retensi ${IPLIMIT_LOCK_HISTORY_RETENTION_DAYS:-90} hari):"
    sqlite3 -header -column "${DB_PATH}" "
      SELECT
        id,
        account_type AS type,
        username,
        limitip AS lim,
        detected AS hit,
        datetime(locked_at, 'unixepoch', 'localtime') AS locked_at,
        CASE WHEN unlocked_at IS NULL THEN 'ACTIVE'
             ELSE datetime(unlocked_at, 'unixepoch', 'localtime') END AS unlocked_at,
        admin_notify_status AS tg_admin,
        webhook_notify_status AS webhook
      FROM iplimit_lock_history
      ORDER BY locked_at DESC
      LIMIT 20;
    " || true
  fi
}

detect_udpcustom_service() {
  if systemctl is-active --quiet sc-1forcr-udpcustom 2>/dev/null; then
    echo "sc-1forcr-udpcustom"
    return
  fi
  if systemctl is-active --quiet udp-custom 2>/dev/null; then
    echo "udp-custom"
    return
  fi
  # systemctl cat mengecek satu unit saja. list-unit-files memuat semua unit,
  # dan dengan pipefail grep -q bisa membuat systemctl kena SIGPIPE sehingga
  # unit yang ada dianggap tidak ada.
  if systemctl cat sc-1forcr-udpcustom.service >/dev/null 2>&1; then
    echo "sc-1forcr-udpcustom"
    return
  fi
  if systemctl cat udp-custom.service >/dev/null 2>&1; then
    echo "udp-custom"
    return
  fi
  echo "${UDPCUSTOM_SERVICE:-sc-1forcr-udpcustom}"
}

onoff_word() {
  local svc="$1"
  if systemctl is-active --quiet "${svc}" 2>/dev/null; then
    echo "ON"
  else
    echo "OFF"
  fi
}

get_hc_auth_lookback_hours() {
  local h
  h="$(echo "${SSH_HC_AUTH_LOOKBACK_HOURS:-24}" | tr -cd '0-9')"
  [[ -z "${h}" ]] && h="24"
  if [[ "${h}" -lt 1 ]]; then h="1"; fi
  if [[ "${h}" -gt 168 ]]; then h="168"; fi
  echo "${h}"
}

menu_bool_01() {
  local raw
  raw="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "${raw}" in
    1|true|yes|on) echo "1" ;;
    *) echo "0" ;;
  esac
}

read_license_value_global() {
  local key="${1:-}"
  local file="/etc/sc-1forcr-license"
  if [[ ! -f "${file}" ]]; then
    echo ""
    return
  fi
  sed -n "s/^${key}=//p" "${file}" | head -n1
}

read_sc_meta_value_global() {
  local key="${1:-}"
  local file="/etc/sc-1forcr-registration.env"
  if [[ ! -f "${file}" ]]; then
    echo ""
    return
  fi
  sed -n "s/^${key}=//p" "${file}" | head -n1
}

parse_license_expire_epoch() {
  local raw ts
  raw="$(echo "${1:-}" | tr -cd '0-9')"
  [[ -z "${raw}" ]] && { echo "0"; return; }
  ts="${raw}"
  if [[ "${#ts}" -ge 13 ]]; then
    ts="$((ts / 1000))"
  fi
  [[ -z "${ts}" || "${ts}" -le 0 ]] && ts="0"
  echo "${ts}"
}

format_expiry_in() {
  local raw="${1:-}" ts now rem d h m
  raw="$(echo "${raw}" | tr -cd '0-9')"
  if [[ -z "${raw}" || "${raw}" == "0" ]]; then echo "Unlimited"; return; fi
  ts="${raw}"
  [[ "${#ts}" -ge 13 ]] && ts="$((ts / 1000))"
  now="$(date +%s)"
  rem="$((ts - now))"
  if (( rem <= 0 )); then echo "Expired"; return; fi
  d="$((rem / 86400))"
  h="$(((rem % 86400) / 3600))"
  m="$(((rem % 3600) / 60))"
  if (( d > 0 )); then echo "${d}d ${h}h ${m}m"
  elif (( h > 0 )); then echo "${h}h ${m}m"
  else echo "${m}m"; fi
}

sc_access_state_is_valid() {
  local status_raw expires_raw status expires_epoch now_epoch
  status_raw="${1:-}"
  expires_raw="${2:-}"
  status="$(echo "${status_raw}" | tr '[:upper:]' '[:lower:]' | xargs)"
  expires_epoch="$(parse_license_expire_epoch "${expires_raw}")"
  now_epoch="$(date +%s)"

  case "${status}" in
    expired|rejected|deny|denied|blocked|suspended|inactive|deleted_by_admin|migrated_ip)
      return 1
      ;;
  esac

  if [[ "${expires_epoch}" -gt 0 && "${now_epoch}" -ge "${expires_epoch}" ]]; then
    return 1
  fi

  case "${status}" in
    active|valid|allowed|ok|unlimited|lifetime)
      return 0
      ;;
  esac

  return 1
}

refresh_license_cache_guard() {
  local enabled now_s last_s stamp_file
  local ip_text resp status msg bound_ip expires distribution client_name key_hash
  local force="${1:-0}"
  enabled="$(menu_bool_01 "${LICENSE_ENFORCE:-1}")"
  [[ "${enabled}" != "1" ]] && return 0
  [[ -z "${LICENSE_API_URL:-}" || -z "${LICENSE_API_TOKEN:-}" || -z "${LICENSE_KEY:-}" ]] && return 0
  command -v jq >/dev/null 2>&1 || return 0

  stamp_file="/tmp/sc-1forcr-license-refresh.ts"
  now_s="$(date +%s)"
  last_s=0
  if [[ -f "${stamp_file}" ]]; then
    last_s="$(tr -cd '0-9' < "${stamp_file}" 2>/dev/null || echo 0)"
    [[ -z "${last_s}" ]] && last_s=0
  fi
  if [[ "${force}" != "1" ]] && (( now_s - last_s < 60 )); then
    return 0
  fi
  printf '%s' "${now_s}" > "${stamp_file}" 2>/dev/null || true

  ip_text="$(curl -4fsS --max-time 3 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  ip_text="${ip_text:-unknown}"

  resp="$(curl -4fsS --connect-timeout 8 --max-time 20 \
    -X POST "${LICENSE_API_URL}" \
    -H "Authorization: Bearer ${LICENSE_API_TOKEN}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "license_key=${LICENSE_KEY}" \
    --data-urlencode "ip=${ip_text}" 2>/dev/null ||
  curl -fsS --connect-timeout 8 --max-time 20 \
    -X POST "${LICENSE_API_URL}" \
    -H "Authorization: Bearer ${LICENSE_API_TOKEN}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "license_key=${LICENSE_KEY}" \
    --data-urlencode "ip=${ip_text}" 2>/dev/null ||
  true)"
  [[ -z "${resp}" ]] && return 0
  echo "${resp}" | jq . >/dev/null 2>&1 || return 0

  status="$(echo "${resp}" | jq -r '.status // (if .allowed==true then "active" else "rejected" end) // "rejected"' 2>/dev/null || echo "rejected")"
  msg="$(echo "${resp}" | jq -r '.message // "-" ' 2>/dev/null || echo "-")"
  bound_ip="$(echo "${resp}" | jq -r '.bound_ip // .ip // empty' 2>/dev/null || echo "")"
  expires="$(echo "${resp}" | jq -r '.expires_at // .expired_at // .expired // "-" ' 2>/dev/null || echo "-")"
  distribution="$(echo "${resp}" | jq -r '.distribution // "BOT 1FORCR NEXUS"' 2>/dev/null || echo "BOT 1FORCR NEXUS")"
  client_name="$(echo "${resp}" | jq -r '.client_name // .client // .name // empty' 2>/dev/null || echo "")"
  [[ -z "${bound_ip}" || "${bound_ip}" == "null" ]] && bound_ip="${ip_text}"
  [[ -z "${client_name}" || "${client_name}" == "null" ]] && client_name="${bound_ip}"
  key_hash="$(printf '%s' "${LICENSE_KEY}" | sha256sum | awk '{print $1}')"

  cat > /etc/sc-1forcr-license <<EOF
LICENSE_STATUS=${status}
LICENSE_MESSAGE=${msg}
LICENSE_BOUND_IP=${bound_ip}
LICENSE_EXPIRES_AT=${expires}
LICENSE_DISTRIBUTION=${distribution}
LICENSE_CLIENT_NAME=${client_name}
LICENSE_KEY_HASH=${key_hash}
LICENSE_CHECK_AT=$(date '+%F %T')
EOF
  chmod 600 /etc/sc-1forcr-license >/dev/null 2>&1 || true
}

# Isi layar kunci. Reason dari license guard adalah penyebab asli penolakan
# lisensi (misalnya key VPS tidak dikenal), jadi tidak semua kunci berarti
# SC expired. Tiap baris maksimal 60 kolom, selebar bingkai layar kunci.
menu_lock_reason_text() {
  local reason="${1:-}" managed_by="${2:-}"
  printf 'Reason : %s\n\n' "${reason}"
  case "${reason}" in
    *server-key-unknown*)
      printf '%s\n' \
        "Status : Key VPS ini tidak dikenal server lisensi." \
        "         Key di bot berbeda dengan key di VPS ini." \
        "Aksi   : Kirim IP dan key VPS ke admin untuk menu" \
        "         'Pulihkan Key VPS'. Lihat key VPS dengan:" \
        "         grep SC_UPDATE_KEY /etc/sc-1forcr.env" \
        "Akses terbuka otomatis setelah key dipulihkan."
      ;;
    *source-ip-mismatch*)
      printf '%s\n' \
        "Status : IP publik VPS tidak sama dengan IP terdaftar." \
        "Aksi   : Ganti IP lewat menu 'Ganti IP VPS' di bot."
      ;;
    *machine-id*)
      printf '%s\n' \
        "Status : VPS terdeteksi di-reinstall (machine-id berubah)." \
        "Aksi   : Minta admin 'Reset Binding VPS', lalu jalankan" \
        "         installer terbaru lagi di VPS ini."
      ;;
    *registration-not-active*|license-rejected*)
      printf '%s\n' \
        "Status : IP VPS ini belum punya registrasi SC aktif." \
        "Aksi   : Daftar atau perpanjang SC lewat bot resmi."
      ;;
    refresh-failed*|api-error*|lease-grace-expired|lease-format-invalid|signed-license-invalid)
      printf '%s\n' \
        "Status : VPS gagal memperbarui lisensi ke server bot." \
        "Aksi   : Cek koneksi dan DNS VPS. Akses terbuka otomatis" \
        "         setelah lisensi berhasil diperbarui (maks 15 menit)."
      ;;
    license-expired*|registration-expired)
      printf '%s\n' \
        "Status : SC expired." \
        "Aksi   : Perpanjang SC lewat bot resmi. Akses terbuka" \
        "         otomatis setelah perpanjang (maks 15 menit)."
      ;;
    migrate_ip_to_new_host)
      printf '%s\n' \
        "Status : SC sudah dipindah ke IP VPS baru." \
        "Aksi   : Pakai VPS baru, atau hubungi admin."
      ;;
    *)
      if [[ -n "${managed_by}" && "${managed_by}" != "control-plane" ]]; then
        printf '%s\n' \
          "Status : Lisensi VPS ditolak." \
          "Aksi   : Hubungi admin dan sertakan reason di atas."
      else
        printf '%s\n' \
          "Akses menu VPS dinonaktifkan admin." \
          "Status : SC expired." \
          "Aksi   : SC harus diperpanjang terlebih dahulu." \
          "Hubungi admin untuk membuka akses kembali setelah perpanjang."
      fi
      ;;
  esac
}

enforce_menu_license_access() {
  local enabled ip_text status expires_raw expires_epoch now_epoch lock_file lock_reason lock_managed_by meta_status meta_expires
  lock_file="/etc/sc-1forcr-access.lock"
  ip_text="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  ip_text="${ip_text:-unknown}"
  if [[ -f /etc/sc-1forcr-license-required ]]; then
    if [[ ! -x /usr/local/sbin/sc-1forcr-license-guard ]] || \
       ! /usr/local/sbin/sc-1forcr-license-guard refresh-enforce >/dev/null 2>&1; then
      if [[ ! -f "${lock_file}" ]]; then
        cat > "${lock_file}" <<'EOF'
blocked=1
reason=signed-license-invalid
managed_by=license-guard
EOF
        chmod 600 "${lock_file}" >/dev/null 2>&1 || true
      fi
    fi
  fi
  if [[ -f "${lock_file}" ]]; then
    lock_reason="$(sed -n 's/^reason=//p' "${lock_file}" | head -n1)"
    [[ -z "${lock_reason}" ]] && lock_reason="locked_by_admin"
    if [[ "${lock_reason}" == "natural_expired" ]]; then
      if [[ "$(menu_bool_01 "${LICENSE_ENFORCE:-1}")" == "1" ]]; then
        refresh_license_cache_guard 1
      fi
      status="$(echo "$(read_license_value_global "LICENSE_STATUS")" | tr '[:upper:]' '[:lower:]' | xargs)"
      expires_raw="$(read_license_value_global "LICENSE_EXPIRES_AT")"
      if sc_access_state_is_valid "${status}" "${expires_raw}"; then
        rm -f "${lock_file}" >/dev/null 2>&1 || true
        systemctl enable sc-1forcr-api >/dev/null 2>&1 || true
        systemctl start sc-1forcr-api >/dev/null 2>&1 || true
        return 0
      fi
      meta_status="$(echo "$(read_sc_meta_value_global "SC_STATUS")" | tr '[:upper:]' '[:lower:]' | xargs)"
      meta_expires="$(read_sc_meta_value_global "SC_EXPIRES_AT")"
      if sc_access_state_is_valid "${meta_status}" "${meta_expires}"; then
        rm -f "${lock_file}" >/dev/null 2>&1 || true
        systemctl enable sc-1forcr-api >/dev/null 2>&1 || true
        systemctl start sc-1forcr-api >/dev/null 2>&1 || true
        return 0
      fi
    fi
    clear
    if [[ "${lock_reason}" == "natural_expired" ]]; then
      cat <<EOF | ui_fx
============================================================
               SC 1FORCR NEXUS - AKSES DITOLAK            
============================================================

Script 1FORCRNEXUS anda sudah expired untuk IP (${ip_text}).

Silahkan perpanjang melalui bot resmi:
https://t.me/sc1forcrnexusbot

Setelah perpanjang berhasil, silakan ulangi install/update.
============================================================
EOF
    else
      lock_managed_by="$(sed -n 's/^managed_by=//p' "${lock_file}" | head -n1)"
      {
        printf '%s\n' \
          "============================================================" \
          "               SC 1FORCR NEXUS - AKSES DITOLAK" \
          "============================================================" \
          ""
        menu_lock_reason_text "${lock_reason}" "${lock_managed_by}"
        printf '%s\n' "============================================================"
      } | ui_fx
    fi
    return 1
  fi
  if [[ -f /etc/sc-1forcr-license-required ]]; then
    return 0
  fi
  enabled="$(menu_bool_01 "${LICENSE_ENFORCE:-1}")"
  [[ "${enabled}" != "1" ]] && return 0
  refresh_license_cache_guard
  status="$(echo "$(read_license_value_global "LICENSE_STATUS")" | tr '[:upper:]' '[:lower:]' | xargs)"
  expires_raw="$(read_license_value_global "LICENSE_EXPIRES_AT")"
  expires_epoch="$(parse_license_expire_epoch "${expires_raw}")"
  now_epoch="$(date +%s)"

  if { [[ "${status}" == "expired" || "${status}" == "rejected" || "${status}" == "deny" || "${status}" == "denied" || "${status}" == "blocked" || "${status}" == "suspended" || "${status}" == "inactive" ]] && \
       [[ "${expires_epoch}" -le 0 || "${now_epoch}" -ge "${expires_epoch}" ]]; } || \
     [[ "${expires_epoch}" -gt 0 && "${now_epoch}" -ge "${expires_epoch}" ]]; then
    clear
    cat <<EOF | ui_fx
============================================================
               SC 1FORCR NEXUS - AKSES DITOLAK            
============================================================

Script 1FORCRNEXUS anda sudah expired untuk IP (${ip_text}).
Status : SC expired.
Aksi   : SC harus diperpanjang terlebih dahulu.

Silahkan perpanjang melalui bot resmi:
https://t.me/sc1forcrnexusbot

Setelah perpanjang berhasil, silakan ulangi install/update.
============================================================
EOF
    return 1
  fi
  # Lisensi sudah valid lagi: pastikan API aktif kembali tanpa perlu install/update ulang.
  systemctl enable sc-1forcr-api >/dev/null 2>&1 || true
  systemctl start sc-1forcr-api >/dev/null 2>&1 || true
  return 0
}

get_server_capacity_profile() {
  local ram_kib ram_mb ram_gb cores tier est
  ram_kib="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)"
  if [[ -z "${ram_kib}" || ! "${ram_kib}" =~ ^[0-9]+$ ]]; then
    ram_mb="1024"
  else
    ram_mb="$((ram_kib / 1024))"
  fi
  (( ram_mb < 256 )) && ram_mb=1024
  ram_gb="$(( (ram_mb + 512) / 1024 ))"
  (( ram_gb < 1 )) && ram_gb=1

  cores="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
  [[ -z "${cores}" || ! "${cores}" =~ ^[0-9]+$ || "${cores}" -lt 1 ]] && cores=1

  tier="${ram_gb}"
  (( cores < tier )) && tier="${cores}"
  (( tier < 1 )) && tier=1

  est="30-40"
  if (( tier >= 8 )); then
    est="180-260"
  elif (( tier >= 4 )); then
    est="100-160"
  elif (( tier >= 2 )); then
    est="50-80"
  fi

  echo "${ram_gb}|${cores}|${tier}|${est}"
}

read_capacity_state_value() {
  local key="$1" file="${RESOURCE_CAPACITY_STATE_FILE:-/var/lib/sc-1forcr/capacity.env}"
  [[ -n "${key}" && -f "${file}" ]] || return 0
  awk -F= -v k="${key}" '$1==k {print substr($0, index($0,"=")+1); exit}' "${file}" 2>/dev/null || true
}

ensure_capacity_state_once() {
  local file="${RESOURCE_CAPACITY_STATE_FILE:-/var/lib/sc-1forcr/capacity.env}"
  if [[ ! -s "${file}" && -x /usr/local/sbin/sc-1forcr-capacity-tune ]]; then
    /usr/local/sbin/sc-1forcr-capacity-tune >/dev/null 2>&1 || true
  fi
}

show_capacity_report() {
  local file updated status reason target ram_total ram_used ram_pct avg_ram cpu_pct avg_cpu cores
  local active avg_active accounts cap user_ram user_cpu can_add add_batch conn_count ip_count ssh_count xray_count udphc_count zivpn_count online_source
  file="${RESOURCE_CAPACITY_STATE_FILE:-/var/lib/sc-1forcr/capacity.env}"
  ensure_capacity_state_once
  updated="$(read_capacity_state_value CAPACITY_UPDATED_AT)"
  status="$(read_capacity_state_value CAPACITY_STATUS)"
  reason="$(read_capacity_state_value CAPACITY_REASON)"
  target="$(read_capacity_state_value RESOURCE_TARGET_PERCENT)"
  ram_total="$(read_capacity_state_value RAM_TOTAL_MIB)"
  ram_used="$(read_capacity_state_value RAM_USED_MIB)"
  ram_pct="$(read_capacity_state_value RAM_USED_PERCENT)"
  avg_ram="$(read_capacity_state_value AVG_RAM_USED_PERCENT)"
  cpu_pct="$(read_capacity_state_value CPU_USED_PERCENT)"
  avg_cpu="$(read_capacity_state_value AVG_CPU_USED_PERCENT)"
  cores="$(read_capacity_state_value CPU_CORES)"
  conn_count="$(read_capacity_state_value ACTIVE_CONNECTION_COUNT)"
  ip_count="$(read_capacity_state_value ACTIVE_UNIQUE_IP_COUNT)"
  ssh_count="$(read_capacity_state_value ACTIVE_SSH_USER_COUNT)"
  xray_count="$(read_capacity_state_value ACTIVE_XRAY_USER_COUNT)"
  udphc_count="$(read_capacity_state_value ACTIVE_UDPHC_USER_COUNT)"
  zivpn_count="$(read_capacity_state_value ACTIVE_ZIVPN_USER_COUNT)"
  online_source="$(read_capacity_state_value ACTIVE_ONLINE_SOURCE)"
  active="$(read_capacity_state_value ACTIVE_USER_ESTIMATE)"
  avg_active="$(read_capacity_state_value AVG_ACTIVE_USER_ESTIMATE)"
  accounts="$(read_capacity_state_value ACTIVE_ACCOUNT_TOTAL)"
  cap="$(read_capacity_state_value CAPACITY_ACTIVE_USER_TARGET)"
  user_ram="$(read_capacity_state_value USER_RAM_ESTIMATE_MIB)"
  user_cpu="$(read_capacity_state_value USER_CPU_ESTIMATE_PERCENT)"
  can_add="$(read_capacity_state_value CAN_ADD_USERS)"
  add_batch="$(read_capacity_state_value RECOMMENDED_ADD_BATCH)"

  draw_menu_header "RESOURCE AUTO TUNE"
  if [[ -z "${status}" ]]; then
    echo "Data kapasitas belum tersedia."
    echo "Jalankan: systemctl start sc-1forcr-capacity-tune.service"
    return 0
  fi

  echo "Status          : ${status} (${reason:-unknown})"
  echo "Target aman     : maksimal ${target:-85}% RAM/CPU, sisakan minimal $((100 - ${target:-85}))%"
  echo "Update          : ${updated:-"-"}"
  echo
  echo "Server          : ${ram_total:-"-"} MiB RAM / ${cores:-"-"} vCPU"
  echo "RAM             : ${ram_used:-"-"} MiB (${ram_pct:-"-"}%), avg ${avg_ram:-"-"}%"
  echo "CPU             : ${cpu_pct:-"-"}%, avg ${avg_cpu:-"-"}%"
  echo
  echo "Akun aktif DB   : ${accounts:-0}"
  echo "Target kapasitas: sekitar ${cap:-"-"} user aktif ringan"
  echo "Patokan/user    : RAM ~${user_ram:-"-"} MiB, CPU ~${user_cpu:-"-"}%"
  echo
  echo "Sisa aman       : ${can_add:-0} user estimasi"
  echo "Saran tambah    : ${add_batch:-0} user dulu, lalu lihat rata-rata berikutnya"
  echo "State file      : ${file}"
}

bytes_human() {
  local bytes="${1:-0}"
  if [[ -z "${bytes}" || ! "${bytes}" =~ ^[0-9]+$ ]]; then
    echo "-"
    return
  fi
  numfmt --to=iec-i --suffix=B "${bytes}" 2>/dev/null || echo "${bytes}B"
}

read_vnstat_stats() {
  VNSTAT_MONTH_RX="-"
  VNSTAT_MONTH_TX="-"
  VNSTAT_MONTH_TOTAL="-"
  VNSTAT_MONTH_NAME="$(date +%B 2>/dev/null || echo "-")"
  VNSTAT_DAY_RX="-"
  VNSTAT_DAY_TX="-"
  VNSTAT_DAY_TOTAL="-"
  VNSTAT_DAY_NAME="$(date +%A 2>/dev/null || echo "-")"
  VNSTAT_RATE="-"
  VNSTAT_IFACE="-"
  if ! command -v vnstat >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    return
  fi

  local js rx tx drx dtx iface rate5m mtotal dtotal
  js="$(vnstat --json 2>/dev/null || true)"
  [[ -z "${js}" ]] && return

  iface="$(echo "${js}" | jq -r '.interfaces[0].name // "-"' 2>/dev/null || echo "-")"
  rx="$(echo "${js}" | jq -r '(.interfaces[0].traffic.month // [] | last | .rx // 0)' 2>/dev/null || echo 0)"
  tx="$(echo "${js}" | jq -r '(.interfaces[0].traffic.month // [] | last | .tx // 0)' 2>/dev/null || echo 0)"
  drx="$(echo "${js}" | jq -r '(.interfaces[0].traffic.day // [] | last | .rx // 0)' 2>/dev/null || echo 0)"
  dtx="$(echo "${js}" | jq -r '(.interfaces[0].traffic.day // [] | last | .tx // 0)' 2>/dev/null || echo 0)"

  VNSTAT_IFACE="${iface}"
  VNSTAT_MONTH_RX="$(bytes_human "${rx}")"
  VNSTAT_MONTH_TX="$(bytes_human "${tx}")"
  VNSTAT_DAY_RX="$(bytes_human "${drx}")"
  VNSTAT_DAY_TX="$(bytes_human "${dtx}")"
  if [[ "${rx}" =~ ^[0-9]+$ && "${tx}" =~ ^[0-9]+$ ]]; then
    mtotal="$((rx + tx))"
    VNSTAT_MONTH_TOTAL="$(bytes_human "${mtotal}")"
  fi
  if [[ "${drx}" =~ ^[0-9]+$ && "${dtx}" =~ ^[0-9]+$ ]]; then
    dtotal="$((drx + dtx))"
    VNSTAT_DAY_TOTAL="$(bytes_human "${dtotal}")"
  fi
  rate5m="$(echo "${js}" | jq -r '(.interfaces[0].traffic.fiveminute // [] | last | ((.rx // 0) + (.tx // 0)))' 2>/dev/null || echo 0)"
  if [[ "${rate5m}" =~ ^[0-9]+$ && "${rate5m}" -gt 0 ]]; then
    VNSTAT_RATE="$(awk -v b="${rate5m}" 'BEGIN { printf "%.2f Mbit/s", (b*8)/(300*1000000) }')"
  fi
}

# Info jaringan publik (IP, kota, ISP) disimpan 6 jam. Dulu tiga curl berbatas
# 3 detik jalan setiap kali menu digambar, jadi menu bisa tertahan beberapa
# detik saat jaringan lambat. Cache hanya ditulis kalau IP publik didapat.
dashboard_net_info() {
  local cache="/var/lib/sc-1forcr/menu-netinfo.cache" now ts="" ip="" city="" isp="" fresh_ip=""
  now="$(date +%s 2>/dev/null || echo 0)"
  if [[ -r "${cache}" ]]; then
    IFS='|' read -r ts ip city isp < "${cache}" || true
  fi
  if [[ ! "${ts}" =~ ^[0-9]+$ || -z "${ip}" ]] || (( now - ts > 21600 || now < ts )); then
    fresh_ip="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
    if [[ "${fresh_ip}" =~ ^[0-9a-fA-F:.]+$ ]]; then
      ip="${fresh_ip}"
      city="$(curl -fsS --max-time 3 https://ipinfo.io/city 2>/dev/null || true)"
      isp="$(curl -fsS --max-time 3 https://ipinfo.io/org 2>/dev/null || true)"
      city="${city//[|$'\n'$'\r']/}"
      isp="${isp//[|$'\n'$'\r']/}"
      mkdir -p /var/lib/sc-1forcr 2>/dev/null || true
      if printf '%s|%s|%s|%s\n' "${now}" "${ip}" "${city}" "${isp}" > "${cache}.tmp" 2>/dev/null; then
        mv -f "${cache}.tmp" "${cache}" 2>/dev/null || true
      fi
    elif [[ -z "${ip}" ]]; then
      ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    fi
  fi
  D_IP="${ip:-unknown}"
  D_CITY="${city:--}"
  D_ISP="${isp:--}"
  return 0
}

# RAM, swap, CPU, load, uptime, dan jam dibaca dari /proc dengan builtin bash,
# tanpa proses baru, jadi murah dipanggil berulang oleh dashboard live.
# CPU% adalah selisih /proc/stat sejak sampel sebelumnya, dikurangi pemakaian
# CPU menu ini sendiri beserta anak prosesnya (sqlite3, jq, curl saat
# mengumpulkan data), supaya angkanya tidak ikut naik karena menu dibuka.
# DASH_PROC_DIR hanya untuk test.
DASH_CPU_TOTAL=0
DASH_CPU_BUSY=0
dashboard_live_sample() {
  local proc="${DASH_PROC_DIR:-/proc}" key val rest mt="" mf=0 ma="" bf=0 ca=0 st=0 sf=0 used up="" self=""
  local cpu u n s i w q sq stl total busy self_ticks=0 d_total d_busy days hours mins
  local -a f=()
  if [[ -r "${proc}/meminfo" ]]; then
    while read -r key val rest; do
      case "${key}" in
        MemTotal:) mt="${val}" ;;
        MemFree:) mf="${val}" ;;
        MemAvailable:) ma="${val}" ;;
        Buffers:) bf="${val}" ;;
        Cached:) ca="${val}" ;;
        SwapTotal:) st="${val}" ;;
        SwapFree:) sf="${val}"; break ;;
      esac
    done < "${proc}/meminfo"
  fi
  if [[ "${mt}" =~ ^[0-9]+$ && "${mf}${bf}${ca}${st}${sf}" =~ ^[0-9]+$ ]] && (( mt > 0 )); then
    # MemAvailable sama dengan dasar kolom "used" pada free versi baru.
    if [[ "${ma}" =~ ^[0-9]+$ ]]; then used=$(( mt - ma )); else used=$(( mt - mf - bf - ca )); fi
    if (( used < 0 )); then used=0; fi
    D_RAM_TOTAL=$(( mt / 1024 )); D_RAM_USED=$(( used / 1024 )); D_RAM_PCT=$(( used * 100 / mt ))
    D_SWAP_TOTAL=$(( st / 1024 )); D_SWAP_USED=$(( (st - sf) / 1024 ))
  fi

  if [[ -r "${proc}/stat" ]] && read -r cpu u n s i w q sq stl rest < "${proc}/stat" \
     && [[ "${cpu}" == "cpu" && "${u}${n}${s}${i}" =~ ^[0-9]+$ ]]; then
    [[ "${w:-0}${q:-0}${sq:-0}${stl:-0}" =~ ^[0-9]+$ ]] || { w=0; q=0; sq=0; stl=0; }
    total=$(( u + n + s + i + ${w:-0} + ${q:-0} + ${sq:-0} + ${stl:-0} ))
    busy=$(( total - i - ${w:-0} ))
    # Field 14-17 /proc/PID/stat: utime stime cutime cstime (setelah "(nama) ").
    if [[ -r "${proc}/$$/stat" ]] && read -r self < "${proc}/$$/stat"; then
      self="${self##*) }"
      # Sengaja tanpa here-string: bash 5.0 (Ubuntu 20.04) membuat file
      # sementara untuk <<<. Isinya hanya angka dan satu huruf status.
      f=(${self})
      if [[ "${f[11]:-}${f[12]:-}${f[13]:-}${f[14]:-}" =~ ^[0-9]+$ ]]; then
        self_ticks=$(( f[11] + f[12] + f[13] + f[14] ))
      fi
    fi
    busy=$(( busy - self_ticks ))
    if (( DASH_CPU_TOTAL > 0 && total > DASH_CPU_TOTAL )); then
      d_total=$(( total - DASH_CPU_TOTAL ))
      d_busy=$(( busy - DASH_CPU_BUSY ))
      if (( d_busy < 0 )); then d_busy=0; fi
      if (( d_busy > d_total )); then d_busy="${d_total}"; fi
      D_CPU_PCT=$(( (d_busy * 100 + d_total / 2) / d_total ))
    fi
    DASH_CPU_TOTAL="${total}"
    DASH_CPU_BUSY="${busy}"
  fi

  if [[ -r "${proc}/loadavg" ]]; then
    read -r D_LOAD1 D_LOAD5 D_LOAD15 rest < "${proc}/loadavg" || true
  fi
  if [[ -r "${proc}/uptime" ]] && read -r up rest < "${proc}/uptime"; then
    up="${up%%.*}"
    if [[ "${up}" =~ ^[0-9]+$ ]]; then
      days=$(( up / 86400 )); hours=$(( (up % 86400) / 3600 )); mins=$(( (up % 3600) / 60 ))
      if (( days > 0 )); then D_UPTIME="${days}d ${hours}h ${mins}m"; else D_UPTIME="${hours}h ${mins}m"; fi
    fi
  fi
  printf -v D_TIME '%(%d %b %Y  %H:%M %Z)T' -1 2>/dev/null || true
  return 0
}

# Hasil capacity analyzer (timer 15 menit): status, online, rata-rata RAM/CPU,
# dan target kapasitas. Jumlah online sengaja tidak dihitung di menu, karena
# butuh membaca socket, journal, dan log Xray yang berat di VPS kecil. File
# state dibaca dengan builtin bash saat dashboard dibuka dan diulang dashboard
# live tiap DASH_CAP_REREAD_SECONDS, jadi hasil analyzer baru langsung tampil.
dashboard_cap_read() {
  local file="${RESOURCE_CAPACITY_STATE_FILE:-/var/lib/sc-1forcr/capacity.env}" k v
  local status="" active="" cap="" add="" ram="" cpu="" epoch=""
  if [[ -r "${file}" ]]; then
    while IFS='=' read -r k v; do
      case "${k}" in
        CAPACITY_STATUS) status="${v}" ;;
        ACTIVE_USER_ESTIMATE) active="${v}" ;;
        CAPACITY_ACTIVE_USER_TARGET) cap="${v}" ;;
        RECOMMENDED_ADD_BATCH) add="${v}" ;;
        AVG_RAM_USED_PERCENT) ram="${v}" ;;
        AVG_CPU_USED_PERCENT) cpu="${v}" ;;
        CAPACITY_UPDATED_EPOCH) epoch="${v}" ;;
      esac
    done < "${file}"
  fi
  D_LIVE_STATUS="${status:-WAIT}"
  D_LIVE_ONLINE="${active:-0}"
  D_LIVE_RAM="${ram:--}"
  D_LIVE_CPU="${cpu:--}"
  D_CAP_EPOCH=""
  if [[ "${epoch}" =~ ^[0-9]+$ ]]; then D_CAP_EPOCH="${epoch}"; fi
  D_CAP_TEXT="~${D_CAP_EST:-?} user"
  if [[ "${D_LIVE_STATUS}" != "WAIT" && "${cap}" =~ ^[0-9]+$ ]]; then
    D_CAP_TEXT="~${cap} user"
    if [[ "${add}" =~ ^[0-9]+$ ]] && (( add > 0 )); then D_CAP_TEXT+=" +${add}"; fi
  fi
  DASH_CAP_READ_AT="${SECONDS}"
  return 0
}

dashboard_collect() {
  local udpcustom active_where counts
  local license_client_name license_status license_expires_raw
  local sc_meta_status sc_meta_client sc_meta_expires
  local cap_ram_gb cap_cores cap_tier cap_est

  D_OS="$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-Unknown}")"
  D_KERNEL="$(uname -r 2>/dev/null || echo '-')"
  D_RAM_USED=""; D_RAM_TOTAL=""; D_RAM_PCT=0; D_SWAP_USED=""; D_SWAP_TOTAL=""; D_CPU_PCT=""
  D_LOAD1="-"; D_LOAD5="-"; D_LOAD15="-"; D_UPTIME="-"; D_TIME="-"
  # Sampel pertama jadi titik awal CPU%; sampel kedua di akhir fungsi ini.
  dashboard_live_sample
  read -r D_DISK_USED D_DISK_TOTAL D_DISK_PCT <<< "$(df -P -BG / 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$2); gsub(/G/,"",$3); gsub(/%/,"",$5); print $3, $2, $5}' || true)"

  dashboard_net_info
  refresh_license_cache_guard

  license_client_name="$(read_license_value_global "LICENSE_CLIENT_NAME")"
  license_status="$(echo "$(read_license_value_global "LICENSE_STATUS")" | tr '[:upper:]' '[:lower:]' | xargs)"
  license_expires_raw="$(read_license_value_global "LICENSE_EXPIRES_AT")"
  sc_meta_status="$(echo "$(read_sc_meta_value_global "SC_STATUS")" | tr '[:upper:]' '[:lower:]' | xargs)"
  sc_meta_client="$(read_sc_meta_value_global "SC_CLIENT_NAME")"
  sc_meta_expires="$(read_sc_meta_value_global "SC_EXPIRES_AT")"
  if [[ -n "${sc_meta_client}" ]]; then license_client_name="${sc_meta_client}"
  elif [[ -z "${license_client_name}" ]]; then license_client_name="${D_IP}"; fi
  D_CLIENT="${license_client_name}"
  if sc_access_state_is_valid "${sc_meta_status}" "${sc_meta_expires}"; then
    D_EXPIRY="$(format_expiry_in "${sc_meta_expires}")"
  elif sc_access_state_is_valid "${license_status}" "${license_expires_raw}"; then
    D_EXPIRY="$(format_expiry_in "${license_expires_raw}")"
  elif [[ -n "${license_expires_raw}" ]]; then
    D_EXPIRY="$(format_expiry_in "${license_expires_raw}")"
  else
    D_EXPIRY="$(format_expiry_in "${sc_meta_expires}")"
  fi
  D_VERSION="$(tr -d '[:space:]' </opt/sc-1forcr/VERSION 2>/dev/null || true)"
  if [[ ! "${D_VERSION}" =~ ^V\.1FSC\.[0-9]+$ ]]; then D_VERSION="${SCRIPT_VERSION:-V.1FSC}"; fi

  udpcustom="$(detect_udpcustom_service)"
  D_SVC_SSH="$(onoff_word ssh)"
  D_SVC_DROPBEAR="$(onoff_word dropbear)"
  D_SVC_WS="$(onoff_word sc-1forcr-sshws)"
  D_SVC_HAPROXY="$(onoff_word haproxy)"
  D_SVC_NGINX="$(onoff_word nginx)"
  D_SVC_XRAY="$(onoff_word xray)"
  D_SVC_ZIVPN="$(onoff_word "${ZIVPN_SERVICE}")"
  D_SVC_UDPHC="$(onoff_word "${udpcustom}")"
  D_UDP_BACKEND="$(echo "${ACTIVE_UDP_BACKEND:-zivpn}" | tr '[:upper:]' '[:lower:]')"
  D_HEALTH="CHECK"
  if [[ "${D_SVC_XRAY}" == "ON" && "${D_SVC_WS}" == "ON" && "${D_SVC_HAPROXY}" == "ON" ]]; then D_HEALTH="GOOD"; fi

  # Satu proses sqlite3 untuk keempat jumlah akun (dulu empat proses).
  active_where="$(account_active_where_expr)"
  counts="$(sqlite3 -separator '|' "${DB_PATH}" "SELECT
      (SELECT COUNT(*) FROM account_sshs WHERE ${active_where}),
      (SELECT COUNT(*) FROM account_vmesses WHERE ${active_where}),
      (SELECT COUNT(*) FROM account_vlesses WHERE ${active_where}),
      (SELECT COUNT(*) FROM account_trojans WHERE ${active_where});" 2>/dev/null || true)"
  IFS='|' read -r D_ACC_SSH D_ACC_VMESS D_ACC_VLESS D_ACC_TROJAN <<< "${counts}"
  if [[ ! "${D_ACC_SSH:-}" =~ ^[0-9]+$ ]]; then D_ACC_SSH=0; fi
  if [[ ! "${D_ACC_VMESS:-}" =~ ^[0-9]+$ ]]; then D_ACC_VMESS=0; fi
  if [[ ! "${D_ACC_VLESS:-}" =~ ^[0-9]+$ ]]; then D_ACC_VLESS=0; fi
  if [[ ! "${D_ACC_TROJAN:-}" =~ ^[0-9]+$ ]]; then D_ACC_TROJAN=0; fi

  read_vnstat_stats
  IFS='|' read -r cap_ram_gb cap_cores cap_tier cap_est <<< "$(get_server_capacity_profile)"
  D_CORES="${cap_cores:-1}"
  D_SPEC="${cap_ram_gb:-?}GB / ${cap_cores:-?} vCPU / tier ${cap_tier:-?}"
  D_CAP_EST="${cap_est:-?}"
  ensure_capacity_state_once
  dashboard_cap_read
  D_CAP_MODE="AUTO"
  if [[ "$(menu_bool_01 "${IPLIMIT_AUTO_TUNE:-1}")" != "1" ]]; then D_CAP_MODE="MANUAL"; fi
  dashboard_live_sample
  return 0
}

# Titik status layanan: hijau aktif, merah mati. Backend UDP yang memang
# tidak dipakai (ZIVPN vs UDPHC) tampil redup, bukan merah.
dashboard_svc() {
  local label="$1" state="$2" standby="${3:-0}" dot
  if [[ "${state}" == "ON" ]]; then dot="${UI_OK}●"
  elif [[ "${standby}" == "1" ]]; then dot="${UI_MUTED}○"
  else dot="${UI_BAD}○"; fi
  UI_OUT="${dot}${UI_NC} ${UI_VAL}${label}${UI_NC}"
}

# Baris yang ikut diperbarui dashboard live. Dipakai dashboard_render dan
# dashboard_live_tick, jadi tampilan awal dan hasil pembaruan selalu sama.
dashboard_row_cpu() {
  local txt="-"
  if [[ "${D_CPU_PCT:-}" =~ ^[0-9]+$ ]]; then txt="${D_CPU_PCT}%"; fi
  ui_bar "${D_CPU_PCT:-0}" "${D_BAR_LEN}"
  ui_kv_parts "CPU" "${UI_OUT} ${UI_VAL}${txt}${UI_NC}" "${UI_MUTED}load${UI_NC} ${UI_VAL}${D_LOAD1} ${D_LOAD5} ${D_LOAD15}${UI_NC}"
}

dashboard_row_ram() {
  ui_bar "${D_RAM_PCT}" "${D_BAR_LEN}"
  ui_kv_parts "RAM" "${UI_OUT} ${UI_VAL}${D_RAM_PCT}%${UI_NC}" "${UI_MUTED}${D_RAM_USED:-?}M/${D_RAM_TOTAL:-?}M${UI_NC}"
}

dashboard_row_uptime() {
  ui_kv_parts "UPTIME" "${UI_VAL}${D_UPTIME}${UI_NC}" "${UI_MUTED}swap${UI_NC} ${UI_VAL}${D_SWAP_USED:-0}M/${D_SWAP_TOTAL:-0}M${UI_NC}"
}

# Penanda live: "● live", atau titik saja kalau layar HP terlalu sempit.
dashboard_row_time() {
  local room=$(( UI_IW - 2 - 11 )) mark=""
  ui_fit "${D_TIME}" "${room}"
  if [[ "${DASH_LIVE_ON}" == "1" ]]; then
    if (( ${#UI_OUT} + 8 <= room )); then
      mark="  ${UI_OK}●${UI_NC} ${UI_MUTED}live${UI_NC}"
    elif (( ${#UI_OUT} + 3 <= room )); then
      mark="  ${UI_OK}●${UI_NC}"
    fi
  fi
  ui_kv "TIME" "${UI_VAL}${UI_OUT}${UI_NC}${mark}"
}

dashboard_row_cap() {
  ui_kv_parts "CAPACITY" "${UI_ACC}${D_CAP_MODE}${UI_NC}" "${UI_VAL}${D_CAP_TEXT}${UI_NC}"
}

# Umur hasil analyzer -> DASH_CAP_AGE ("7m lalu"), supaya jelas baris ini
# hasil pemeriksaan berkala, bukan angka realtime.
dashboard_cap_age() {
  local now=0 age
  DASH_CAP_AGE=""
  [[ "${D_CAP_EPOCH:-}" =~ ^[0-9]+$ ]] || return 0
  printf -v now '%(%s)T' -1 2>/dev/null || return 0
  age=$(( now - D_CAP_EPOCH ))
  if (( age < 0 )); then age=0; fi
  if (( age < 60 )); then DASH_CAP_AGE="baru saja"
  elif (( age < 3600 )); then DASH_CAP_AGE="$(( age / 60 ))m lalu"
  else DASH_CAP_AGE="$(( age / 3600 ))j lalu"; fi
  return 0
}

dashboard_row_analyzer() {
  local color="${UI_OK}"
  case "${D_LIVE_STATUS}" in
    WAIT|WATCH) color="${UI_WARN}" ;;
    FULL|CRITICAL) color="${UI_BAD}" ;;
  esac
  dashboard_cap_age
  ui_kv_parts "ANALYZER" "${color}${D_LIVE_STATUS}${UI_NC}" "${UI_MUTED}online${UI_NC} ${UI_VAL}${D_LIVE_ONLINE}${UI_NC}" \
    "${UI_MUTED}ram${UI_NC} ${UI_VAL}${D_LIVE_RAM}%${UI_NC}" "${UI_MUTED}cpu${UI_NC} ${UI_VAL}${D_LIVE_CPU}%${UI_NC}" \
    "${UI_MUTED}${DASH_CAP_AGE}${UI_NC}"
}

# Sidik nilai satu baris live -> DASH_K. Baris digambar ulang hanya kalau
# sidiknya berubah, supaya data yang dikirim lewat SSH tetap kecil.
DASH_LIVE_ROWS=(cpu ram uptime time cap analyzer)
dashboard_live_key() {
  case "$1" in
    cpu) DASH_K="${D_CPU_PCT:-}|${D_LOAD1}|${D_LOAD5}|${D_LOAD15}" ;;
    ram) DASH_K="${D_RAM_PCT}|${D_RAM_USED:-}|${D_RAM_TOTAL:-}" ;;
    uptime) DASH_K="${D_UPTIME}|${D_SWAP_USED:-}|${D_SWAP_TOTAL:-}" ;;
    time) DASH_K="${D_TIME}|${DASH_LIVE_ON}" ;;
    cap) DASH_K="${D_CAP_MODE}|${D_CAP_TEXT}" ;;
    analyzer)
      dashboard_cap_age
      DASH_K="${D_LIVE_STATUS}|${D_LIVE_ONLINE}|${D_LIVE_RAM}|${D_LIVE_CPU}|${DASH_CAP_AGE}" ;;
  esac
}

dashboard_live_remember() {
  local name
  for name in "${DASH_LIVE_ROWS[@]}"; do
    dashboard_live_key "${name}"
    DASH_KEYS[${name}]="${DASH_K}"
  done
}

# Satu siklus live: ambil sampel /proc, gambar ulang baris yang berubah di
# posisi tetapnya, semuanya dalam satu kali tulis. Posisi kursor disimpan
# (ESC 7) dan dikembalikan (ESC 8), jadi angka yang sedang diketik di prompt
# tetap di tempatnya.
dashboard_live_tick() {
  local esc=$'\033' out="" name row
  dashboard_live_sample
  if (( SECONDS - DASH_CAP_READ_AT >= DASH_CAP_REREAD_SECONDS )); then dashboard_cap_read; fi
  UI_ROW_SINK="buf"
  for name in "${DASH_LIVE_ROWS[@]}"; do
    dashboard_live_key "${name}"
    if [[ "${DASH_K}" == "${DASH_KEYS[${name}]:-}" ]]; then continue; fi
    DASH_KEYS[${name}]="${DASH_K}"
    row="D_ROW_${name^^}"
    UI_BUF=""
    "dashboard_row_${name}"
    out+="${esc}[${!row};1H${UI_BUF}${esc}[K"
  done
  UI_ROW_SINK=""
  if [[ -n "${out}" ]]; then printf '%s' "${esc}7${out}${esc}8"; fi
  return 0
}

# Live hanya kalau posisi baris pasti: seluruh layar (dashboard, menu, prompt)
# muat di terminal tanpa tergulung dan tidak ada baris yang terlipat. Tema
# none dan terminal dumb tetap polos tanpa kode kursor.
dashboard_live_allowed() {
  [[ "${DASHBOARD_LIVE_SECONDS}" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "${DASHBOARD_LIVE_IDLE_MINUTES}" =~ ^[0-9]+$ ]] || return 1
  [[ "${UI_MODE}" != "none" ]] || return 1
  case "${TERM:-}" in ''|dumb) return 1 ;; esac
  [[ -t 1 ]] || return 1
  (( ${D_ROW_CPU:-0} > 0 )) || return 1
  ui_tty_size
  (( UI_TTY_ROWS > 0 && UI_ROWS + 1 <= UI_TTY_ROWS )) || return 1
  (( UI_TTY_COLS >= UI_BW + 1 )) || return 1
  return 0
}

# Prompt menu utama sambil menjalankan dashboard live. Teks yang sedang
# diketik aman: terminal (mode kanonik) menahan satu baris sampai Enter, jadi
# read -t yang habis waktunya tidak memakan apa pun. Live berhenti kalau
# ukuran terminal berubah (posisi baris tidak pasti lagi) dan setelah
# DASHBOARD_LIVE_IDLE_MINUTES tanpa input, supaya sesi SSH yang ditinggal
# tidak terus mengirim data. MENU_INPUT_TTY hanya untuk test.
menu_read_choice_live() {
  local var_name="$1" prompt="$2" tty="${MENU_INPUT_TTY:-/dev/tty}" rc=0 idle_until
  idle_until=$(( SECONDS + DASHBOARD_LIVE_IDLE_MINUTES * 60 ))
  DASH_WINCH=0
  DASH_LIVE_ON=1
  printf '%s' "${prompt}"
  trap 'DASH_WINCH=1' WINCH
  while true; do
    rc=0
    read -r -t "${DASHBOARD_LIVE_SECONDS}" "${var_name}" < "${tty}" || rc=$?
    if (( rc <= 128 )); then break; fi
    if (( DASH_WINCH == 1 || SECONDS >= idle_until )); then
      trap - WINCH
      DASH_LIVE_ON=0
      if (( DASH_WINCH == 0 )); then dashboard_live_tick; fi
      rc=0
      read -r "${var_name}" < "${tty}" || rc=$?
      break
    fi
    dashboard_live_tick
  done
  trap - WINCH
  DASH_LIVE_ON=0
  if (( rc != 0 )); then
    cancelled
    return 130
  fi
  return 0
}

dashboard_render() {
  local valw bar_len exp_color days sub health_color zivpn_standby=0 udphc_standby=0
  local -a svc=() acc=()
  ui_layout
  valw=$(( UI_IW - 2 - 11 ))
  bar_len=$(( valw - 20 ))
  if (( bar_len > 20 )); then bar_len=20; fi
  if (( bar_len < 6 )); then bar_len=6; fi
  D_BAR_LEN="${bar_len}"

  clear
  printf '\n'
  UI_ROWS=1
  ui_banner "S C   1 F O R C R   N E X U S"

  exp_color="${UI_OK}"
  if [[ "${D_EXPIRY}" == "Expired" ]]; then
    exp_color="${UI_BAD}"
  elif [[ "${D_EXPIRY}" =~ ^([0-9]+)d ]]; then
    days="${BASH_REMATCH[1]}"
    if (( days < 3 )); then exp_color="${UI_WARN}"; fi
  elif [[ "${D_EXPIRY}" != "Unlimited" ]]; then
    exp_color="${UI_WARN}"
  fi
  local client_max=$(( UI_BW - 34 ))
  if (( client_max > 24 )); then client_max=24; fi
  if (( client_max < 6 )); then client_max=6; fi
  ui_fit "${D_CLIENT}" "${client_max}"
  sub="${UI_VAL}${UI_BOLD}${UI_OUT}${UI_NC}  ${UI_ACC2}◆${UI_NC}  ${UI_ACC}${D_VERSION}${UI_NC}  ${UI_ACC2}◆${UI_NC}  ${exp_color}${D_EXPIRY}${UI_NC}"
  ui_width "${sub}"
  ui_pad "$(( (UI_BW - UI_W) / 2 ))"
  printf ' %s%s\n' "${UI_TMP}" "${sub}"
  UI_ROWS=$(( UI_ROWS + 1 ))

  ui_line_top "SERVER"
  ui_kv_text "OS" "${D_OS}"
  ui_kv_text "KERNEL" "${D_KERNEL}"
  # Jumlah vCPU sudah tampil di baris HEALTH (spec), jadi baris CPU memuat
  # bar pemakaian seperti RAM.
  D_ROW_CPU=$(( UI_ROWS + 1 )); dashboard_row_cpu
  D_ROW_RAM=$(( UI_ROWS + 1 )); dashboard_row_ram
  ui_bar "${D_DISK_PCT:-0}" "${bar_len}"
  ui_kv_parts "DISK" "${UI_OUT} ${UI_VAL}${D_DISK_PCT:-0}%${UI_NC}" "${UI_MUTED}${D_DISK_USED:-?}G/${D_DISK_TOTAL:-?}G${UI_NC}"
  D_ROW_UPTIME=$(( UI_ROWS + 1 )); dashboard_row_uptime
  D_ROW_TIME=$(( UI_ROWS + 1 )); dashboard_row_time
  ui_line_sep "NETWORK"
  ui_fit "${D_CITY}" 16
  ui_kv_parts "IP" "${UI_VAL}${D_IP}${UI_NC}" "${UI_MUTED}${UI_OUT}${UI_NC}"
  ui_kv_text "ISP" "${D_ISP}"
  ui_kv_text "DOMAIN" "${DOMAIN:--}"
  ui_line_sep "TRAFFIC"
  ui_kv_parts "TODAY" "${UI_VAL}${VNSTAT_DAY_TOTAL}${UI_NC}" "${UI_OK}▼${UI_NC}${UI_VAL}${VNSTAT_DAY_RX}${UI_NC}" "${UI_ACC}▲${UI_NC}${UI_VAL}${VNSTAT_DAY_TX}${UI_NC}"
  ui_kv_parts "MONTH" "${UI_VAL}${VNSTAT_MONTH_TOTAL}${UI_NC}" "${UI_OK}▼${UI_NC}${UI_VAL}${VNSTAT_MONTH_RX}${UI_NC}" "${UI_ACC}▲${UI_NC}${UI_VAL}${VNSTAT_MONTH_TX}${UI_NC}"
  ui_kv_parts "SPEED" "${UI_VAL}${VNSTAT_RATE}${UI_NC}" "${UI_MUTED}${VNSTAT_MONTH_NAME}${UI_NC}"
  ui_line_bot

  case "${D_UDP_BACKEND}" in
    udpcustom|udp-custom|udphc) zivpn_standby=1 ;;
    *) udphc_standby=1 ;;
  esac
  dashboard_svc "SSH" "${D_SVC_SSH}"; svc+=("${UI_OUT}")
  dashboard_svc "DROPBEAR" "${D_SVC_DROPBEAR}"; svc+=("${UI_OUT}")
  dashboard_svc "SSH-WS" "${D_SVC_WS}"; svc+=("${UI_OUT}")
  dashboard_svc "HAPROXY" "${D_SVC_HAPROXY}"; svc+=("${UI_OUT}")
  dashboard_svc "NGINX" "${D_SVC_NGINX}"; svc+=("${UI_OUT}")
  dashboard_svc "XRAY" "${D_SVC_XRAY}"; svc+=("${UI_OUT}")
  dashboard_svc "ZIVPN" "${D_SVC_ZIVPN}" "${zivpn_standby}"; svc+=("${UI_OUT}")
  dashboard_svc "UDPHC" "${D_SVC_UDPHC}" "${udphc_standby}"; svc+=("${UI_OUT}")
  health_color="${UI_WARN}"
  if [[ "${D_HEALTH}" == "GOOD" ]]; then health_color="${UI_OK}"; fi
  ui_line_top "SERVICES"
  ui_flow 3 "${svc[@]}"
  ui_kv_parts "HEALTH" "${health_color}${UI_BOLD}${D_HEALTH}${UI_NC}" "${UI_MUTED}spec${UI_NC} ${UI_VAL}${D_SPEC}${UI_NC}"
  D_ROW_CAP=$(( UI_ROWS + 1 )); dashboard_row_cap
  D_ROW_ANALYZER=$(( UI_ROWS + 1 )); dashboard_row_analyzer
  ui_line_sep "ACCOUNTS"
  acc+=("${UI_MUTED}SSH${UI_NC} ${UI_ACC}${UI_BOLD}${D_ACC_SSH}${UI_NC}")
  acc+=("${UI_MUTED}VMESS${UI_NC} ${UI_ACC}${UI_BOLD}${D_ACC_VMESS}${UI_NC}")
  acc+=("${UI_MUTED}VLESS${UI_NC} ${UI_ACC}${UI_BOLD}${D_ACC_VLESS}${UI_NC}")
  acc+=("${UI_MUTED}TROJAN${UI_NC} ${UI_ACC}${UI_BOLD}${D_ACC_TROJAN}${UI_NC}")
  acc+=("${UI_MUTED}TOTAL${UI_NC} ${UI_ACC2}${UI_BOLD}$(( D_ACC_SSH + D_ACC_VMESS + D_ACC_VLESS + D_ACC_TROJAN ))${UI_NC}")
  ui_flow 3 "${acc[@]}"
  ui_line_bot
  dashboard_live_remember
  return 0
}

draw_dashboard() {
  dashboard_collect
  dashboard_render
}

# Pasangan "username ip" UDP Custom yang masih aktif dari journal: connected/
# disconnected dipasangkan per src dan sesi lama kedaluwarsa (anti ghost
# session). Dipakai layar SSH + UDP CUSTOM dan layar SEMUA AKUN ONLINE.
collect_udphc_online_pairs() {
  local mode="${1:-realtime}" out="$2" udpcustom udp_ttl
  udp_ttl="180"
  udpcustom="$(detect_udpcustom_service)"
  : > "${out}"
  if [[ "${mode}" == "history" ]]; then
    udp_ttl="43200"
    journalctl -u "${udpcustom}" -n "${UDPHC_LOG_LINES_HISTORY}" -o short-unix --no-pager 2>/dev/null
  else
    # Realtime tetap butuh histori cukup agar sesi UDPHC yang masih aktif
    # (tanpa spam log periodik) tidak langsung "hilang" dari monitor.
    udp_ttl="1800"
    journalctl -u "${udpcustom}" -n "${UDPHC_LOG_LINES_HISTORY}" -o short-unix --no-pager 2>/dev/null
  fi | awk -v ttl="${udp_ttl}" '
    function norm_user(v) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v);
      v=tolower(v);
      if (v ~ /^[a-z0-9._-]+$/ && v != "root") return v;
      return "";
    }
    BEGIN {
      now=systime();
      if (ttl <= 0) ttl=180;
    }
    function ip_only(v) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v);
      gsub(/^\[/, "", v);
      gsub(/\]$/, "", v);
      sub(/:[0-9]+$/, "", v);
      return v;
    }
    function mark_active(raw_user, raw_src, tsv,   u,s,ip,key) {
      u=norm_user(raw_user);
      s=raw_src;
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", s);
      if (u == "" || s == "") return;
      ip=ip_only(s);
      if (ip == "") return;
      key=s;
      active[key]=u "|" ip;
      seen[key]=tsv + 0;
    }
    function mark_disconnected(raw_src,   s) {
      s=raw_src;
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", s);
      if (s == "") return;
      if (s in active) delete active[s];
      if (s in seen) delete seen[s];
    }
    {
      ts=$1;
      sub(/\..*$/, "", ts);
      if (ts !~ /^[0-9]+$/) ts=now;
      line=$0;
      src=""; u=""; ip=""; key="";

      if (line ~ /Server up and running|Started SC 1FORCR UDP Custom Core/) {
        delete active;
        delete seen;
        next;
      }

      if (line ~ /\[src:[^]]+\][[:space:]]+\[user:[^]]+\][[:space:]]+Client connected/) {
        src=line;
        sub(/^.*\[src:/, "", src);
        sub(/\].*$/, "", src);
        u=line;
        sub(/^.*\[user:/, "", u);
        sub(/\].*$/, "", u);
        mark_active(u, src, ts);
        next;
      }
      if (line ~ /\[src:[^]]+\][[:space:]]+Client disconnected/) {
        src=line;
        sub(/^.*\[src:/, "", src);
        sub(/\].*$/, "", src);
        mark_disconnected(src);
        next;
      }

      # Fallback format log lain: user=... src=... atau src=... user=...
      if (line ~ /user[=: ][^ ,\]]+.*src[=: ][^ ,\]]+/) {
        u=line;
        sub(/^.*user[=: ]/, "", u);
        sub(/[ ,\]].*$/, "", u);
        src=line;
        sub(/^.*src[=: ]/, "", src);
        sub(/[ ,\]].*$/, "", src);
        mark_active(u, src, ts);
        next;
      }
      if (line ~ /src[=: ][^ ,\]]+.*user[=: ][^ ,\]]+/) {
        src=line;
        sub(/^.*src[=: ]/, "", src);
        sub(/[ ,\]].*$/, "", src);
        u=line;
        sub(/^.*user[=: ]/, "", u);
        sub(/[ ,\]].*$/, "", u);
        mark_active(u, src, ts);
        next;
      }
    }
    END {
      for (s in active) {
        age=now - (s in seen ? seen[s] : now);
        if (age > ttl) continue;
        key=active[s];
        if (key == "") continue;
        uniq[key]=1;
      }
      for (k in uniq) {
        split(k, a, /\|/);
        u=a[1]; ip=a[2];
        if (u != "" && ip != "") print u, ip;
      }
    }' > "${out}" || true
}

show_combined_online() {
  local mode tmp_count tmp_status tmp_ssh_pid_ip tmp_pid_user tmp_ssh_pair tmp_ssh_count tmp_ssh_proc_count tmp_ssh_count_merged tmp_ssh_count_logs tmp_udp_pair tmp_udp_count tmp_db_ports tmp_db_recent tmp_db_recent_loose dropbear_main_port dropbear_alt_port hc_auth_lookback_h
  mode="${1:-realtime}"
  hc_auth_lookback_h="$(get_hc_auth_lookback_hours)"
  dropbear_main_port="$(echo "${DROPBEAR_PORT:-109}" | tr -cd '0-9')"
  dropbear_alt_port="$(echo "${DROPBEAR_ALT_PORT:-143}" | tr -cd '0-9')"
  [[ -z "${dropbear_main_port}" ]] && dropbear_main_port="109"
  [[ -z "${dropbear_alt_port}" ]] && dropbear_alt_port="143"

  tmp_count="$(mktemp)"
  tmp_status="$(mktemp)"
  tmp_ssh_pid_ip="$(mktemp)"
  tmp_pid_user="$(mktemp)"
  tmp_ssh_pair="$(mktemp)"
  tmp_ssh_count="$(mktemp)"
  tmp_ssh_proc_count="$(mktemp)"
  tmp_ssh_count_merged="$(mktemp)"
  tmp_ssh_count_logs="$(mktemp)"
  tmp_udp_pair="$(mktemp)"
  tmp_udp_count="$(mktemp)"
  tmp_db_ports="$(mktemp)"
  tmp_db_recent="$(mktemp)"
  tmp_db_recent_loose="$(mktemp)"
  trap 'rm -f "${tmp_count:-}" "${tmp_status:-}" "${tmp_ssh_pid_ip:-}" "${tmp_pid_user:-}" "${tmp_ssh_pair:-}" "${tmp_ssh_count:-}" "${tmp_ssh_proc_count:-}" "${tmp_ssh_count_merged:-}" "${tmp_ssh_count_logs:-}" "${tmp_udp_pair:-}" "${tmp_udp_count:-}" "${tmp_db_ports:-}" "${tmp_db_recent:-}" "${tmp_db_recent_loose:-}"' RETURN

  # SSH realtime: map pid->user dan pid->remote_ip, lalu pisahkan dari pasangan user+ip UDPHC aktif.
  : > "${tmp_ssh_pair}"
  : > "${tmp_ssh_count}"
  ss -Htnp state established 2>/dev/null | awk '
    {
      l=$3;
      r=$4;
      if (l !~ /:[0-9]+$/ || r !~ /:[0-9]+$/) { l=$4; r=$5; }
      if (l ~ /:22$/ || l ~ /:'"${dropbear_main_port}"'$/ || l ~ /:'"${dropbear_alt_port}"'$/) {
        ip=r;
        gsub(/^\[/, "", ip);
        gsub(/\]$/, "", ip);
        sub(/:[0-9]+$/, "", ip);
        if (ip == "") next;
        s=$0;
        while (match(s, /pid=[0-9]+/)) {
          pid=substr(s, RSTART + 4, RLENGTH - 4);
          if (pid ~ /^[0-9]+$/) print pid, ip;
          s=substr(s, RSTART + RLENGTH);
        }
      }
    }' | sort -u > "${tmp_ssh_pid_ip}" || true

  if [[ -s "${tmp_ssh_pid_ip}" ]]; then
    local pid_csv
    pid_csv="$(awk '{print $1}' "${tmp_ssh_pid_ip}" | sort -u | paste -sd, -)"
    ps -o pid=,args= -p "${pid_csv}" 2>/dev/null | awk '
      {
        pid=$1;
        $1="";
        sub(/^[[:space:]]+/, "", $0);
        u="";
        if ($0 ~ /^sshd:/) {
          u=$0;
          sub(/^sshd:[[:space:]]*/, "", u);
          sub(/[[:space:]].*$/, "", u);
          sub(/@.*$/, "", u);
          sub(/\[.*$/, "", u);
        } else if ($0 ~ /^dropbear[^[:space:]]*[[:space:]]+\[[^]]+\]/ || $0 ~ /\/dropbear-[^[:space:]]+[[:space:]]+\[[^]]+\]/) {
          u=$0;
          if (u !~ /\[[^]]+\]/) next;
          sub(/^.*\[/, "", u);
          sub(/\].*$/, "", u);
        } else next;
        u=tolower(u);
        if (u !~ /^[a-z0-9._-]+$/) next;
        if (u == "root" || u == "priv" || u == "net") next;
        print pid, u;
      }' > "${tmp_pid_user}" || true

    awk '
      NR==FNR { u[$1]=$2; next }
      {
        pid=$1; ip=$2; user=(pid in u ? u[pid] : "");
        if (user != "" && ip != "") print user, ip;
      }' "${tmp_pid_user}" "${tmp_ssh_pid_ip}" | sort -u > "${tmp_ssh_pair}" || true
  fi

  # UDP Custom: pair connected/disconnected by src, lalu expire sesi lama (anti ghost session).
  : > "${tmp_udp_count}"
  collect_udphc_online_pairs "${mode}" "${tmp_udp_pair}"

  awk '{ if ($1 ~ /^[a-z0-9._-]+$/ && $2 != "") cnt[$1]++ } END { for (u in cnt) print u, cnt[u]; }' "${tmp_udp_pair}" > "${tmp_udp_count}" || true

  # Hitung sesi SSH murni dari pair user+ip hasil socket mapping.
  # Jangan dikurangi dari data UDPHC; dua kolom ditampilkan terpisah.
  awk '{ if ($1 ~ /^[a-z0-9._-]+$/ && $2 != "") cnt[$1]++ } END { for (u in cnt) print u, cnt[u]; }' "${tmp_ssh_pair}" > "${tmp_ssh_count}" || true

  # Fallback untuk SSH-WS/HC: ambil sesi dari process list bila mapping socket->user tidak terbaca.
  ps -eo args= 2>/dev/null | awk '
    {
      u="";
      if ($0 ~ /^sshd:[[:space:]]+/) {
        # Hitung hanya sesi user, bukan proses helper seperti [priv].
        if ($0 ~ /\[priv\]/ || $0 ~ /\[preauth\]/ || $0 ~ /\[listener\]/) next;
        u=$0;
        sub(/^sshd:[[:space:]]*/, "", u);
        sub(/[[:space:]].*$/, "", u);
        sub(/@.*$/, "", u);
        sub(/\[.*$/, "", u);
      } else if ($0 ~ /^dropbear[^[:space:]]*[[:space:]]+\[[^]]+\]/ || $0 ~ /\/dropbear-[^[:space:]]+[[:space:]]+\[[^]]+\]/) {
        u=$0;
        sub(/^.*dropbear[^[:space:]]*[[:space:]]+\[/, "", u);
        sub(/\].*$/, "", u);
      } else next;
      u=tolower(u);
      if (u !~ /^[a-z0-9._-]+$/) next;
      if (u == "root" || u == "priv" || u == "net") next;
      cnt[u]++;
    }
    END { for (u in cnt) print u, cnt[u]; }' > "${tmp_ssh_proc_count}" || true

  awk '
    NR==FNR {
      a[$1]=$2 + 0;
      seen[$1]=1;
      next
    }
    {
      b[$1]=$2 + 0;
      seen[$1]=1;
    }
    END {
      for (u in seen) {
        x=(u in a ? a[u] : 0);
        y=(u in b ? b[u] : 0);
        print u, (x > y ? x : y);
      }
    }' "${tmp_ssh_count}" "${tmp_ssh_proc_count}" > "${tmp_ssh_count_merged}" || true
  mv -f "${tmp_ssh_count_merged}" "${tmp_ssh_count}"

  # Fallback tambahan untuk jalur SSH-WS/HTTP Custom:
  # pakai log auth dropbear yang port-nya masih aktif di socket.
  : > "${tmp_db_ports}"
  : > "${tmp_db_recent}"
  ss -Htnp state established 2>/dev/null | awk '
    function p(v,   s,n,a,port) {
      s=v;
      gsub(/^\[/, "", s); gsub(/\]$/, "", s);
      n=split(s, a, ":");
      port=a[n];
      if (port ~ /^[0-9]+$/ && port+0>=1 && port+0<=65535) return port;
      return "";
    }
    {
      l=$3; r=$4;
      if (p(l)=="" || p(r)=="") { l=$4; r=$5; }
      lp=p(l); rp=p(r);
      if (lp == "'"${dropbear_main_port}"'" || lp == "'"${dropbear_alt_port}"'") {
        if (rp ~ /^[0-9]+$/ && rp+0>=1 && rp+0<=65535) act[rp]=1;
      } else if (rp == "'"${dropbear_main_port}"'" || rp == "'"${dropbear_alt_port}"'") {
        if (lp ~ /^[0-9]+$/ && lp+0>=1 && lp+0<=65535) act[lp]=1;
      }
    }
    END { for (k in act) print k; }' > "${tmp_db_ports}" || true

  if [[ -s "${tmp_db_ports}" ]]; then
    journalctl -u dropbear --since "-${hc_auth_lookback_h} hours" -n "${DROPBEAR_LOG_MAX_LINES}" --no-pager 2>/dev/null | awk '
      NR==FNR { ap[$1]=1; next }
      function norm_ip(v) {
        gsub(/[[:space:]]/, "", v);
        gsub(/^\[/, "", v);
        gsub(/\]/, "", v);
        sub(/:[0-9]+$/, "", v);
        return v;
      }
      function is_loopback_ip(v,   t) {
        t=tolower(v);
        return (t=="127.0.0.1" || t=="::1" || t=="localhost");
      }
      function sess_key(u, ip, port) {
        if (is_loopback_ip(ip) && port ~ /^[0-9]+$/ && port+0>=1 && port+0<=65535) return u "|port:" port;
        return u "|ip:" ip;
      }
      function parse_pid(line,   p) {
        if (match(line, /\[[0-9]+\]/)) {
          p=substr(line, RSTART+1, RLENGTH-2);
          if (p ~ /^[0-9]+$/) return p;
        }
        return "";
      }
      /auth succeeded for /{
        pid=parse_pid($0);
        u=$0;
        sub(/^.*auth succeeded for /,"",u);
        sub(/^'\''/,"",u); sub(/^"/,"",u);
        sub(/'\''.*/,"",u); sub(/".*/,"",u);
        sub(/[[:space:]].*$/,"",u);
        u=tolower(u);
        if (u !~ /^[a-z0-9._-]+$/ || u=="root" || u=="priv" || u=="net") next;

        src=$0;
        sub(/^.* from /, "", src);
        gsub(/[[:space:]]+$/, "", src);
        ip=src;
        port=src;
        ip=norm_ip(ip);
        sub(/^.*:/, "", port);
        if (ip == "") next;
        if (port !~ /^[0-9]+$/ || port+0<1 || port+0>65535) next;
        if (!(port in ap)) next;
        k=sess_key(u, ip, port);
        if (pid != "") {
          auth_by_pid[pid]=k;
        } else {
          auth_no_pid[k]=1;
        }
        next;
      }
      /Exit \(|Exit before auth:/{
        pid=parse_pid($0);
        if (pid != "") closed_pid[pid]=1;
      }
      END{
        for (pid in auth_by_pid) {
          if (pid in closed_pid) continue;
          seen[auth_by_pid[pid]]=1;
        }
        for (k in auth_no_pid) seen[k]=1;
        for (k in seen) {
          split(k, a, /\|/);
          cnt[a[1]]++;
        }
        for (u in cnt) print u, cnt[u];
      }' "${tmp_db_ports}" - > "${tmp_db_recent}" || true

    awk '
      NR==FNR { a[$1]=$2+0; seen[$1]=1; next }
      { b[$1]=$2+0; seen[$1]=1; }
      END {
        for (u in seen) {
          x=(u in a ? a[u] : 0);
          y=(u in b ? b[u] : 0);
          n=(x > y ? x : y);
          if (n > 0) print u, n;
        }
      }' "${tmp_ssh_count}" "${tmp_db_recent}" > "${tmp_ssh_count_logs}" || true
    mv -f "${tmp_ssh_count_logs}" "${tmp_ssh_count}"
  fi

  # Fallback longgar untuk HTTP Custom:
  # jika mapping port aktif miss, tetap hitung auth sukses 2 menit terakhir.
  journalctl -u dropbear --since "-2 min" -n "${DROPBEAR_RECENT_LOG_MAX_LINES}" --no-pager 2>/dev/null | awk '
    function norm_ip(v) {
      gsub(/[[:space:]]/, "", v);
      gsub(/^\[/, "", v);
      gsub(/\]/, "", v);
      sub(/:[0-9]+$/, "", v);
      return v;
    }
    function is_loopback_ip(v,   t) {
      t=tolower(v);
      return (t=="127.0.0.1" || t=="::1" || t=="localhost");
    }
    function sess_key(u, ip, port) {
      if (is_loopback_ip(ip) && port ~ /^[0-9]+$/ && port+0>=1 && port+0<=65535) return u "|port:" port;
      return u "|ip:" ip;
    }
    function parse_pid(line,   p) {
      if (match(line, /\[[0-9]+\]/)) {
        p=substr(line, RSTART+1, RLENGTH-2);
        if (p ~ /^[0-9]+$/) return p;
      }
      return "";
    }
    /auth succeeded for /{
      pid=parse_pid($0);
      u=$0;
      sub(/^.*auth succeeded for /,"",u);
      sub(/^'\''/,"",u); sub(/^"/,"",u);
      sub(/'\''.*/,"",u); sub(/".*/,"",u);
      sub(/[[:space:]].*$/,"",u);
      u=tolower(u);
      if (u !~ /^[a-z0-9._-]+$/ || u=="root" || u=="priv" || u=="net" || u=="unknown") next;

      src=$0;
      sub(/^.* from /, "", src);
      gsub(/[[:space:]]+$/, "", src);
      ip=norm_ip(src);
      port=src;
      sub(/^.*:/, "", port);
      if (ip == "") next;
      if (port !~ /^[0-9]+$/ || port+0<1 || port+0>65535) next;
      k=sess_key(u, ip, port);
      if (pid != "") {
        auth_by_pid[pid]=k;
      } else {
        auth_no_pid[k]=1;
      }
      next;
    }
    /Exit \(|Exit before auth:/{
      pid=parse_pid($0);
      if (pid != "") closed_pid[pid]=1;
    }
    END{
      for (pid in auth_by_pid) {
        if (pid in closed_pid) continue;
        seen[auth_by_pid[pid]]=1;
      }
      for (k in auth_no_pid) seen[k]=1;
      for (k in seen) {
        split(k, a, /\|/);
        cnt[a[1]]++;
      }
      for (u in cnt) print u, cnt[u];
    }' > "${tmp_db_recent_loose}" || true

  awk '
    NR==FNR { a[$1]=$2+0; seen[$1]=1; next }
    { b[$1]=$2+0; seen[$1]=1; }
    END {
      for (u in seen) {
        x=(u in a ? a[u] : 0);
        y=(u in b ? b[u] : 0);
        n=(x > y ? x : y);
        if (n > 0) print u, n;
      }
    }' "${tmp_ssh_count}" "${tmp_db_recent_loose}" > "${tmp_ssh_count_logs}" || true
  mv -f "${tmp_ssh_count_logs}" "${tmp_ssh_count}"

  # Sumber stateful sudah memvalidasi ulang seluruh sesi terhadap socket/PID
  # hidup. Jika tersedia, hasil ini menggantikan fallback log agar sesi yang
  # sudah putus tidak ikut dihitung dan sesi lama tidak menghilang.
  if [[ -x /usr/local/sbin/sc-1forcr-ssh-live ]]; then
    if /usr/local/sbin/sc-1forcr-ssh-live list 2>/dev/null | awk '
      match($0, /\([0-9]+\)$/) {
        u=substr($0, 1, RSTART-1);
        n=substr($0, RSTART+1, RLENGTH-2) + 0;
        if (u ~ /^[a-z0-9._-]+$/ && n > 0) print u, n;
      }
    ' > "${tmp_ssh_count_merged}"; then
      mv -f "${tmp_ssh_count_merged}" "${tmp_ssh_count}"
    fi
  fi

  awk '
    NR==FNR {
      u=$1; n=$2 + 0;
      if (u ~ /^[a-z0-9._-]+$/ && n > 0) {
        ssh[u]+=n;
        seen[u]=1;
      }
      next
    }
    {
      u=$1; n=$2 + 0;
      if (u ~ /^[a-z0-9._-]+$/ && n > 0) {
        udp[u]+=n;
        seen[u]=1;
      }
    }
    END {
      for (u in seen) {
        s=ssh[u] + 0;
        d=udp[u] + 0;
        t=s + d;
        if (t > 0) print u, s, d, t;
      }
    }' "${tmp_ssh_count}" "${tmp_udp_count}" > "${tmp_count}" || true

  sqlite3 "${DB_PATH}" "SELECT LOWER(username) || '|' || UPPER(TRIM(COALESCE(status,''))) || '|' || CAST(COALESCE(limitip,0) AS INTEGER) FROM account_sshs;" > "${tmp_status}" 2>/dev/null || true

  echo "Users Login SSH/Dropbear + UDP Custom"

  draw_menu_header "SSH + UDP CUSTOM USER LOGIN"
  if [[ ! -s "${tmp_count}" ]]; then
    echo "Tidak ada user online terdeteksi."
    echo
    echo "Total User : 0"
    echo "Total SESI : 0"
    return
  fi

  printf "%-24s %-12s %-10s %-10s %-10s\n" "USERNAME" "STATUS" "SSH_SESI" "UDPHC" "TOTAL"
  printf "%-24s %-12s %-10s %-10s %-10s\n" "------------------------" "------------" "----------" "----------" "----------"
  awk '
    BEGIN { OFS="|" }
    NR==FNR {
      split($0, a, /\|/);
      st[a[1]]=a[2];
      lim[a[1]]=a[3] + 0;
      next
    }
    {
      n=split($0, b, /[[:space:]]+/);
      u=b[1];
      ssh=(n >= 2 ? b[2] + 0 : 0);
      udp=(n >= 3 ? b[3] + 0 : 0);
      cnt=(n >= 4 ? b[4] + 0 : (ssh + udp));
      s=(u in st ? st[u] : "AMAN");
      l=(u in lim ? lim[u] : 0);
      if (s == "LOCK" || s == "LOCK_TMP" || s == "LOCK_QUOTA") {
        out="KENA_LOCK";
      } else {
        # Tampilan gabungan memuat jumlah sesi SSH/UDP, bukan jumlah IP unik.
        # Jangan menuduh MULTI_LOGIN berdasarkan socket/session count.
        out="ONLINE";
      }
      printf "%-24s %-12s %-10d %-10d %-10d\n", u, out, ssh, udp, cnt;
    }' "${tmp_status}" "${tmp_count}"

  local total_user total_sesi n
  total_user="$(wc -l < "${tmp_count}" | tr -d ' ')"
  total_sesi=0
  while read -r _ _ _ n; do
    [[ -n "${n:-}" ]] || continue
    total_sesi=$((total_sesi + n))
  done < "${tmp_count}"
  echo
  echo "Total User : ${total_user}"
  echo "Total SESI : ${total_sesi}"
}

show_ssh_online() {
  show_combined_online "realtime"
}

show_ssh_online_history() {
  show_combined_online "history"
}

# Data monitor SSH, dipakai layar SSH dan layar SEMUA AKUN ONLINE supaya
# angkanya selalu sama. Menulis "username|status|limit_ip|sesi|ip_aktif" ke $1
# dan mengisi SSH_ONLINE_SOURCE_MODE.
SSH_ONLINE_SOURCE_MODE=""
collect_ssh_online_rows() {
  local out="$1"
  local tmp_status tmp_ip_count tmp_verified_ip_count tmp_db_ports tmp_proc_count tmp_db_pids
  local dropbear_main_port dropbear_alt_port db_recent_log_max hc_auth_lookback_h source_mode ssh_tracker_ready
  tmp_status="$(mktemp)"
  tmp_ip_count="$(mktemp)"
  tmp_verified_ip_count="$(mktemp)"
  tmp_db_ports="$(mktemp)"
  tmp_proc_count="$(mktemp)"
  tmp_db_pids="$(mktemp)"
  trap 'rm -f "${tmp_status:-}" "${tmp_ip_count:-}" "${tmp_verified_ip_count:-}" "${tmp_db_ports:-}" "${tmp_proc_count:-}" "${tmp_db_pids:-}"' RETURN

  dropbear_main_port="$(echo "${DROPBEAR_PORT:-109}" | tr -cd '0-9')"
  dropbear_alt_port="$(echo "${DROPBEAR_ALT_PORT:-143}" | tr -cd '0-9')"
  db_recent_log_max="$(echo "${DROPBEAR_RECENT_LOG_MAX_LINES:-5000}" | tr -cd '0-9')"
  [[ -z "${dropbear_main_port}" ]] && dropbear_main_port="109"
  [[ -z "${dropbear_alt_port}" ]] && dropbear_alt_port="143"
  [[ -z "${db_recent_log_max}" || "${db_recent_log_max}" -lt 500 ]] && db_recent_log_max="5000"
  hc_auth_lookback_h="$(get_hc_auth_lookback_hours)"
  source_mode="REALTIME_ACTIVE_PORT"
  ssh_tracker_ready="0"

  : > "${tmp_ip_count}"
  if [[ -x /usr/local/sbin/sc-1forcr-ssh-live ]]; then
    if /usr/local/sbin/sc-1forcr-ssh-live list 2>/dev/null | awk '
      match($0, /\([0-9]+\)$/) {
        u=substr($0, 1, RSTART-1);
        n=substr($0, RSTART+1, RLENGTH-2) + 0;
        if (u ~ /^[a-z0-9._-]+$/ && n > 0) print u, n;
      }
    ' > "${tmp_ip_count}"; then
      ssh_tracker_ready="1"
      source_mode="REALTIME_STATEFUL_SOCKET"
    fi
  fi

  # Sumber utama: port ssh-mux yang saat ini masih established ke Dropbear,
  # lalu cocokkan port tersebut dengan event autentikasi terakhir.
  if [[ "${ssh_tracker_ready}" != "1" && ! -s "${tmp_ip_count}" ]]; then
    : > "${tmp_db_ports}"
    ss -Htnp state established 2>/dev/null | awk '
      function p(v,   s,n,a,port) {
        s=v;
        gsub(/^\[/, "", s); gsub(/\]$/, "", s);
        n=split(s, a, ":");
        port=a[n];
        if (port ~ /^[0-9]+$/ && port+0>=1 && port+0<=65535) return port;
        return "";
      }
      {
        l=$3; r=$4;
        if (p(l)=="" || p(r)=="") { l=$4; r=$5; }
        lp=p(l); rp=p(r);
        if (lp == "'"${dropbear_main_port}"'" || lp == "'"${dropbear_alt_port}"'") {
          if (rp ~ /^[0-9]+$/ && rp+0>=1 && rp+0<=65535) act[rp]=1;
        } else if (rp == "'"${dropbear_main_port}"'" || rp == "'"${dropbear_alt_port}"'") {
          if (lp ~ /^[0-9]+$/ && lp+0>=1 && lp+0<=65535) act[lp]=1;
        }
      }
      END { for (k in act) print k; }' > "${tmp_db_ports}" || true

  if [[ -s "${tmp_db_ports}" ]]; then
    journalctl -u dropbear --since "-${hc_auth_lookback_h} hours" -n "${DROPBEAR_LOG_MAX_LINES:-12000}" --no-pager 2>/dev/null | awk '
        NR==FNR { ap[$1]=1; next }
        /auth succeeded for /{
          u=$0;
          sub(/^.*auth succeeded for /,"",u);
          sub(/^'\''/,"",u); sub(/^"/,"",u);
          sub(/'\''.*/,"",u); sub(/".*/,"",u);
          sub(/[[:space:]].*$/,"",u);
          u=tolower(u);
          if (u !~ /^[a-z0-9._-]+$/ || u=="root" || u=="priv" || u=="net" || u=="unknown") next;

          src=$0;
          sub(/^.* from /, "", src);
          gsub(/[[:space:]]+$/, "", src);
          port=src;
          sub(/^.*:/, "", port);
          if (!(port in ap)) next;
          last_user[port]=u;
        }
        END {
          for (p in last_user) cnt[last_user[p]]++;
          for (u in cnt) print u, cnt[u];
      }' "${tmp_db_ports}" - > "${tmp_ip_count}" || true
    fi
  fi

  # Fallback terakhir: hitung sesi dari process list aktif.
  # Ini menjaga monitor tetap tampil meski format log dropbear berbeda antar versi distro.
  if [[ "${ssh_tracker_ready}" != "1" && ! -s "${tmp_ip_count}" ]]; then
    source_mode="REALTIME_PROCESS"
    ps -eo args= 2>/dev/null | awk '
      {
        u="";
        if ($0 ~ /^sshd:[[:space:]]+/) {
          if ($0 ~ /\[priv\]/ || $0 ~ /\[preauth\]/ || $0 ~ /\[listener\]/) next;
          u=$0;
          sub(/^sshd:[[:space:]]*/, "", u);
          sub(/[[:space:]].*$/, "", u);
          sub(/@.*$/, "", u);
          sub(/\[.*$/, "", u);
        } else if ($0 ~ /^dropbear[^[:space:]]*[[:space:]]+\[[^]]+\]/ || $0 ~ /\/dropbear-[^[:space:]]+[[:space:]]+\[[^]]+\]/) {
          u=$0;
          sub(/^.*\[/, "", u);
          sub(/\].*$/, "", u);
        } else next;
        u=tolower(u);
        if (u !~ /^[a-z0-9._-]+$/) next;
        if (u=="root" || u=="priv" || u=="net" || u=="unknown") next;
        cnt[u]++;
      }
      END { for (u in cnt) print u, cnt[u]; }' > "${tmp_proc_count}" || true
    if [[ -s "${tmp_proc_count}" ]]; then
      mv -f "${tmp_proc_count}" "${tmp_ip_count}"
    fi
  fi

  # Fallback final: map PID dropbear aktif (dari socket established) ke username auth di log.
  if [[ "${ssh_tracker_ready}" != "1" && ! -s "${tmp_ip_count}" ]]; then
    source_mode="REALTIME_DROPBEAR_PID"
    : > "${tmp_db_pids}"
    ss -Htnp state established 2>/dev/null | awk -v p1="${dropbear_main_port}" -v p2="${dropbear_alt_port}" '
      function p(v,   s,n,a,port) {
        s=v; gsub(/^\[/, "", s); gsub(/\]$/, "", s);
        n=split(s, a, ":"); port=a[n];
        if (port ~ /^[0-9]+$/ && port+0>=1 && port+0<=65535) return port;
        return "";
      }
      {
        l=$3; r=$4;
        if (p(l)=="" || p(r)=="") { l=$4; r=$5; }
        lp=p(l); rp=p(r);
        if (lp==p1 || lp==p2 || rp==p1 || rp==p2) {
          s=$0;
          while (match(s, /pid=[0-9]+/)) {
            pid=substr(s, RSTART+4, RLENGTH-4);
            if (pid ~ /^[0-9]+$/) print pid;
            s=substr(s, RSTART+RLENGTH);
          }
        }
      }' | sort -u > "${tmp_db_pids}" || true

    if [[ -s "${tmp_db_pids}" ]]; then
      journalctl -u dropbear --since "-${hc_auth_lookback_h} hours" -n "${DROPBEAR_LOG_MAX_LINES:-12000}" --no-pager 2>/dev/null | awk '
        NR==FNR { ap[$1]=1; next }
        function parse_pid(line,   p) {
          if (match(line, /\[[0-9]+\]/)) {
            p=substr(line, RSTART+1, RLENGTH-2);
            if (p ~ /^[0-9]+$/) return p;
          }
          return "";
        }
        /auth succeeded for /{
          pid=parse_pid($0);
          if (!(pid in ap)) next;
          u=$0;
          sub(/^.*auth succeeded for /,"",u);
          sub(/^'\''/,"",u); sub(/^"/,"",u);
          sub(/'\''.*/,"",u); sub(/".*/,"",u);
          sub(/[[:space:]].*$/,"",u);
          u=tolower(u);
          if (u !~ /^[a-z0-9._-]+$/ || u=="root" || u=="priv" || u=="net" || u=="unknown") next;
          last_user[pid]=u;
        }
        END {
          for (p in last_user) cnt[last_user[p]]++;
          for (u in cnt) print u, cnt[u];
        }' "${tmp_db_pids}" - > "${tmp_ip_count}" || true
    fi
  fi

  # Fallback paling longgar: auth sukses dropbear terbaru tanpa syarat PID aktif.
  # Berguna untuk pola koneksi HTTP Custom yang sangat cepat reconnect sehingga
  # snapshot socket aktif sering miss di saat monitor dibuka.
  if [[ "${ssh_tracker_ready}" != "1" && ! -s "${tmp_ip_count}" ]]; then
    source_mode="REALTIME_RECENT_AUTH"
    journalctl -u dropbear --since "-3 min" -n "${db_recent_log_max}" --no-pager 2>/dev/null | awk '
      function parse_pid(line,   p) {
        if (match(line, /\[[0-9]+\]/)) {
          p=substr(line, RSTART+1, RLENGTH-2);
          if (p ~ /^[0-9]+$/) return p;
        }
        return "";
      }
      /auth succeeded for /{
        pid=parse_pid($0);
        u=$0;
        sub(/^.*auth succeeded for /,"",u);
        sub(/^'\''/,"",u); sub(/^"/,"",u);
        sub(/'\''.*/,"",u); sub(/".*/,"",u);
        sub(/[[:space:]].*$/,"",u);
        u=tolower(u);
        if (u !~ /^[a-z0-9._-]+$/ || u=="root" || u=="priv" || u=="net" || u=="unknown") next;
        if (pid != "") {
          auth_by_pid[pid]=u;
        } else {
          auth_no_pid[u]=1;
        }
        next;
      }
      /Exit \(|Exit before auth:/{
        pid=parse_pid($0);
        if (pid != "") closed_pid[pid]=1;
      }
      END {
        for (pid in auth_by_pid) {
          if (pid in closed_pid) continue;
          cnt[auth_by_pid[pid]]++;
        }
        # Format log tanpa PID tidak dapat dibedakan per sesi dengan aman;
        # gunakan satu fallback hanya jika belum ada sesi PID untuk user itu.
        for (u in auth_no_pid) if (!(u in cnt)) cnt[u]=1;
        for (u in cnt) if (cnt[u] > 0) print u, cnt[u];
      }' > "${tmp_ip_count}" || true
  fi

  # Hitung IP publik unik yang benar-benar terkait dengan sesi SSHWS aktif.
  # Jumlah socket tetap ditampilkan sebagai informasi, tetapi tidak boleh
  # menentukan status MULTI_LOGIN karena satu aplikasi dapat membuka banyak socket.
  : > "${tmp_verified_ip_count}"
  if [[ -s /run/sc-1forcr/ssh-live.map && -s /var/lib/sc-1forcr/sshws-quota.tsv ]]; then
    awk -F'|' '
      NR==FNR {
        port=$1; user=tolower($3);
        if (port ~ /^[0-9]+$/ && user ~ /^[a-z0-9._-]+$/) port_user[port]=user;
        next;
      }
      {
        n=split($0, a, "\t");
        if (n < 7 || a[6] != "1") next;
        port=a[2]; ip=tolower(a[7]); user=port_user[port];
        if (user !~ /^[a-z0-9._-]+$/ || ip=="" || ip=="-" || ip=="::" || ip=="::1" || ip=="localhost") next;
        if (ip ~ /^127(\.|$)/ || ip ~ /^::ffff:127(\.|$)/) next;
        key=user SUBSEP ip;
        if (!(key in seen_ip)) { seen_ip[key]=1; count[user]++; }
      }
      END { for (user in count) print user, count[user]; }
    ' /run/sc-1forcr/ssh-live.map /var/lib/sc-1forcr/sshws-quota.tsv > "${tmp_verified_ip_count}" || true
    if [[ -s "${tmp_verified_ip_count}" ]]; then
      source_mode="REALTIME_STATEFUL_IP"
    fi
  fi

  sqlite3 "${DB_PATH}" "SELECT LOWER(username) || '|' || UPPER(TRIM(COALESCE(status,''))) || '|' || CAST(COALESCE(limitip,0) AS INTEGER) FROM account_sshs;" > "${tmp_status}" 2>/dev/null || true

  SSH_ONLINE_SOURCE_MODE="${source_mode}"
  : > "${out}"
  if [[ ! -s "${tmp_ip_count}" ]]; then
    return 0
  fi
  awk '
    FILENAME==ARGV[1] {
      split($0,a,/\|/);
      st[a[1]]=a[2];
      lim[a[1]]=(a[3] ~ /^[0-9]+$/ ? a[3] + 0 : 0);
      next
    }
    FILENAME==ARGV[2] {
      u=$1; n=$2+0;
      sessions[u]=n; online[u]=1;
      next
    }
    FILENAME==ARGV[3] {
      u=$1; verified_ip[u]=$2+0;
      next
    }
    END {
      for (u in online) {
      n=sessions[u]+0;
      ipn=(u in verified_ip ? verified_ip[u] : 0);
      s=(u in st ? st[u] : "AMAN");
      l=(u in lim ? lim[u] : 0);
      if (s=="LOCK" || s=="LOCK_TMP" || s=="LOCK_QUOTA") out="KENA_LOCK";
      else if (l > 0 && ipn > l) out="MULTI_LOGIN";
      else if (ipn > 0) out="AMAN";
      else out="ONLINE";
      printf "%s|%s|%d|%d|%d\n", u, out, l, n, ipn;
      }
    }' "${tmp_status}" "${tmp_ip_count}" "${tmp_verified_ip_count}" > "${out}"
}

show_ssh_only_online() {
  local rows
  rows="$(mktemp)"
  collect_ssh_online_rows "${rows}"
  # Dipasang setelah collector: trap RETURN milik collector menimpa trap yang
  # dipasang sebelumnya, sehingga file ini tidak pernah dihapus.
  trap 'rm -f "${rows:-}"' RETURN

  draw_menu_header "SSH USER LOGIN (${SSH_ONLINE_SOURCE_MODE})"
  if [[ ! -s "${rows}" ]]; then
    echo "Tidak ada user SSH yang sedang online."
    echo
    echo "Total User SSH : 0"
    echo "Total Sesi SSH : 0"
    return
  fi

  printf "%-24s %-12s %-10s %-13s %-10s\n" "USERNAME" "STATUS" "LIMIT_IP" "SESI_AKTIF" "IP_AKTIF"
  printf "%-24s %-12s %-10s %-13s %-10s\n" "------------------------" "------------" "----------" "-------------" "----------"
  awk -F'|' '
    {
      printf "%-24s %-12s %-10d %-13d %-10d\n", $1, $2, $3, $4, $5;
      total_user++; total_session+=$4; total_ip+=$5;
    }
    END {
      print "";
      printf "Total User SSH : %d\n", total_user + 0;
      printf "Total Sesi SSH : %d\n", total_session + 0;
      printf "Total IP Aktif : %d\n", total_ip + 0;
    }' "${rows}"
}

xray_log_snapshot() {
  local dst="$1" mode="${2:-normal}"
  local cutoff_ts active_cutoff_ts recent_min active_sec access_log
  access_log="${XRAY_ACCESS_LOG:-/var/log/xray/access.log}"
  recent_min="${xray_recent_window_min}"
  active_sec="${xray_active_window_sec}"
  if [[ "${mode}" == "realtime" ]]; then
    recent_min="${xray_monitor_recent_window_min}"
    active_sec="${xray_monitor_active_window_sec}"
  fi
  cutoff_ts="$(( $(date +%s) - (recent_min * 60) ))"
  active_cutoff_ts="$(( $(date +%s) - active_sec ))"
  if [[ ! -f "${access_log}" ]]; then
    : > "${dst}"
    return
  fi
  # Output: username|socket_aktif|ip_aktif|ip_recent|last_ip|visibility.
  # Fallback log tidak mengetahui socket hidup. Seluruh IP hanya histori recent
  # dan tidak boleh diberi label aktif/online.
  tail -n 5000 "${access_log}" | awk -v cutoff="${cutoff_ts}" -v active_cutoff="${active_cutoff_ts}" -v min_hits="${xray_min_hits_per_ip}" '
    function norm_ip(v) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v);
      sub(/^(tcp|udp):/, "", v);
      if (v ~ /^\[/) {
        sub(/^\[/, "", v);
        sub(/\](:[0-9]+)?$/, "", v);
      } else {
        sub(/:[0-9]+$/, "", v);
      }
      return tolower(v);
    }
    function usable_ip(v) {
      v=tolower(v);
      if (v=="" || v=="::" || v=="::1" || v=="localhost") return 0;
      if (v ~ /^127(\.|$)/ || v ~ /^::ffff:127(\.|$)/) return 0;
      return (v ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ || v ~ /^[0-9a-f:]+$/);
    }
    function network_group(v, parts, n) {
      v=tolower(v);
      if (v ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
        split(v, parts, /\./);
        return "4:" parts[1] "." parts[2] ".0.0/16";
      }
      if (v ~ /^[0-9a-f:]+$/) {
        n=split(v, parts, /:/);
        return "6:" parts[1] ":" parts[2] ":" parts[3] ":" parts[4] "::/64";
      }
      return "";
    }
    function ts_from_line(line, stamp, ts) {
      if (line !~ /^[0-9][0-9][0-9][0-9]\/[0-9][0-9]\/[0-9][0-9][[:space:]]+[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) return 0;
      stamp = substr(line, 1, 19);
      gsub(/\//, " ", stamp);
      gsub(/:/, " ", stamp);
      gsub(/[[:space:]]+/, " ", stamp);
      ts = mktime(stamp);
      if (ts > 0) return ts;
      return 0;
    }
    {
      ts=ts_from_line($0);
      if (ts > 0 && ts < cutoff) next;
      if (ts == 0) ts=systime();

      email=""; src="";
      if (match($0, /"email":"[^"]+"/)) {
        email=substr($0, RSTART+9, RLENGTH-10);
      } else if (match($0, /email:[[:space:]]*[^[:space:]]+/)) {
        t=substr($0, RSTART, RLENGTH); sub(/email:[[:space:]]*/, "", t); email=t;
      } else if (match($0, /"user":"[^"]+"/)) {
        email=substr($0, RSTART+8, RLENGTH-9);
      } else if (match($0, /user:[[:space:]]*[^[:space:]]+/)) {
        t=substr($0, RSTART, RLENGTH); sub(/user:[[:space:]]*/, "", t); email=t;
      }

      if (match($0, /"source":"[^"]+"/)) {
        src=substr($0, RSTART+10, RLENGTH-11);
      } else if (match($0, /from[[:space:]]+[^[:space:]]+/)) {
        t=substr($0, RSTART, RLENGTH); sub(/from[[:space:]]+/, "", t); src=t;
      }

      if (email == "") next;
      gsub(/[[:space:]]/, "", email);
      email=tolower(email);
      if (email !~ /^[a-z0-9._-]+$/) next;

      ip=norm_ip(src);
      seen[email]=1;
      if (!(email in latest_auth_ts) || ts > latest_auth_ts[email]) latest_auth_ts[email]=ts;
      if (!usable_ip(ip)) next;
      key=email "|" ip;
      hits[key]++;
      if (!(key in first_ts) || ts < first_ts[key]) first_ts[key]=ts;
      if (!(key in last_ts) || ts > last_ts[key]) last_ts[key]=ts;
      if (!(email in latest_ts) || ts >= latest_ts[email]) {
        latest_ts[email]=ts;
        lastip[email]=ip;
      }
    }
    END {
      for (k in hits) {
        split(k, a, /\|/);
        u=a[1]; ip=a[2];
        if (last_ts[k] < active_cutoff) continue;
        if (hits[k] < min_hits && lastip[u] != ip) continue;
        recent_raw[u]++;
        if (!(u in newest_ts) || last_ts[k] >= newest_ts[u]) {
          newest_ts[u]=last_ts[k]; newest_ip[u]=ip;
        }
      }
      for (k in hits) {
        split(k, a, /\|/);
        u=a[1]; ip=a[2];
        if (last_ts[k] < active_cutoff || !(u in newest_ip)) continue;
        newest_key=u "|" newest_ip[u];
        if (ip != newest_ip[u] && (hits[k] < min_hits || last_ts[k] < first_ts[newest_key])) continue;
        group=network_group(ip);
        if (group=="") continue;
        group_key=u SUBSEP group;
        if (group_key in group_seen) continue;
        group_seen[group_key]=1;
        if (group ~ /^4:/) active_v4[u]++;
        else active_v6[u]++;
      }
      for (u in seen) {
        raw=(u in recent_raw ? recent_raw[u] : 0);
        v4=(u in active_v4 ? active_v4[u] : 0);
        v6=(u in active_v6 ? active_v6[u] : 0);
        net_active=(v4>0 && v6>0 ? (v4>v6 ? v4 : v6) : v4+v6);
        lip=(u in lastip ? lastip[u] : "TIDAK_TERDETEKSI");
        auth_active=((u in latest_auth_ts) && latest_auth_ts[u] >= active_cutoff ? 1 : 0);
        if (net_active > 0) visibility=(auth_active ? "SOURCE_NET_EST_ACTIVE" : "SOURCE_IP_RECENT");
        else visibility=(auth_active ? "AUTH_ACTIVE" : "AUTH_RECENT");
        printf "%s|0|%d|%d|%s|%s\n", u, net_active, raw, lip, visibility;
      }
    }' > "${dst}"
}

merge_xray_observations() {
  local tracker_file="$1" log_file="$2" output_file="$3"
  awk -F'|' '
    function visibility_rank(v) {
      if (v=="SOURCE_IP_ACTIVE") return 60;
      if (v=="SOURCE_NET_EST_ACTIVE") return 55;
      if (v=="SOURCE_IP_RECENT_ACTIVE") return 50;
      if (v=="AUTH_ACTIVE") return 40;
      if (v=="SOURCE_IP_RECENT") return 30;
      if (v=="AUTH_RECENT") return 20;
      if (v=="PROXY_LOCAL") return 10;
      return 0;
    }
    $1 ~ /^[a-z0-9._-]+$/ {
      u=tolower($1);
      socketc=($2 ~ /^[0-9]+$/ ? $2+0 : 0);
      activec=($3 ~ /^[0-9]+$/ ? $3+0 : 0);
      recentc=($4 ~ /^[0-9]+$/ ? $4+0 : 0);
      lip=$5; visibility=$6; rank=visibility_rank(visibility);
      seen[u]=1;
      if (!(u in sockets) || socketc>sockets[u]) sockets[u]=socketc;
      if (!(u in active_ips) || activec>active_ips[u]) active_ips[u]=activec;
      if (!(u in recent_ips) || recentc>recent_ips[u]) recent_ips[u]=recentc;
      if (rank>visibility_rank(best_visibility[u])) best_visibility[u]=visibility;
      if (lip!="" && lip!="-" && lip!="TIDAK_TERDETEKSI" && rank>=last_ip_rank[u]) {
        last_ip[u]=lip; last_ip_rank[u]=rank;
      }
    }
    END {
      for (u in seen) {
        printf "%s|%d|%d|%d|%s|%s\n", u, sockets[u]+0, active_ips[u]+0, recent_ips[u]+0,
          (u in last_ip ? last_ip[u] : "TIDAK_TERDETEKSI"),
          (best_visibility[u]!="" ? best_visibility[u] : "PROXY_LOCAL");
      }
    }
  ' "${log_file}" "${tracker_file}" | sort -t'|' -k1,1 > "${output_file}"
}

show_xray_online_by_table() {
  local table="$1" label="$2" mode="${3:-normal}" rows rc=0
  rows="$(mktemp)"
  collect_xray_online_rows "${table}" "${label}" "${mode}" "${rows}" || rc=$?
  # Dipasang setelah collector supaya tidak tertimpa trap RETURN miliknya.
  trap 'rm -f "${rows:-}"' RETURN
  if [[ "${rc}" == "2" ]]; then
    draw_menu_header "${label} ONLINE"
    echo "Tidak ada akun ${label} di DB."
    return
  fi

  draw_menu_header "${label} USER LOGIN (${XRAY_ONLINE_SOURCE_MODE})"
  if [[ "${XRAY_ONLINE_OBSERVED}" != "1" ]]; then
    echo "Tidak ada sesi ${label} yang sedang aktif."
    echo
    echo "Total User ${label} : 0"
    echo "Total Socket ${label} : 0"
    echo "Total Jaringan Aktif/Estimasi ${label} : 0"
    echo "Total IP Recent ${label} : 0"
    return
  fi

  printf "%-20s %-10s %-8s %-11s %-12s %-10s %-10s %-22s\n" "USERNAME" "STATUS" "LIMIT_IP" "MODE" "SOCKET_AKTIF" "NET_AKTIF" "IP_RECENT" "LAST_IP"
  printf "%-20s %-10s %-8s %-11s %-12s %-10s %-10s %-22s\n" "--------------------" "----------" "--------" "-----------" "------------" "----------" "----------" "----------------------"
  awk -F'|' '
    {
      printf "%-20s %-10s %-8d %-11s %-12d %-10d %-10d %-22s\n", $1, $2, $3, $4, $5, $6, $7, $8;
      total_user++;
      total_socket+=$5;
      total_ip+=$6;
      total_recent+=$7;
    }
    END {
      print "";
      printf "Total User : %d\n", total_user + 0;
      printf "Total Socket Aktif : %d\n", total_socket + 0;
      printf "Total Jaringan Aktif/Estimasi : %d\n", total_ip + 0;
      printf "Total IP Recent : %d\n", total_recent + 0;
    }' "${rows}"
  echo
  echo "Catatan: SOCKET_AKTIF bukan jumlah perangkat/orang."
  echo "ONLINE berarti ada socket hidup atau autentikasi akun dalam ${xray_active_window_sec} detik terakhir."
  echo "RECENT berarti akun terlihat di log, tetapi tidak ada bukti sesi hidup saat diperiksa."
  echo "NET_AKTIF adalah estimasi jaringan overlap; IPv4/IPv6 dual-stack dan IP satu operator digabung."
  echo "IP_RECENT adalah jumlah IP mentah dalam window aktif dan bukan jumlah perangkat."
  echo "MODE LEGACY memakai satu credential bersama; jumlah perangkat tidak bisa dipastikan dari IP saja."
}

# Output mentah tracker Xray (semua protokol) ke $1. Baris pertama berisi
# format (rows-v3/rows-v2) dan hasil pemanggilan (ok/failed). Baris dari
# tracker yang gagal tetap disimpan, sama seperti dulu saat tracker dipanggil
# langsung per protokol. Tidak menulis apa pun kalau tracker tidak terpasang.
xray_live_rows_raw() {
  local dst="$1" fmt="rows-v2" rows="" state="ok"
  [[ -x /usr/local/sbin/sc-1forcr-xray-live ]] || return 1
  if /usr/local/sbin/sc-1forcr-xray-live capabilities 2>/dev/null | grep -qx 'rows-v3'; then
    fmt="rows-v3"
  fi
  rows="$(/usr/local/sbin/sc-1forcr-xray-live "${fmt}" 2>/dev/null)" || state="failed"
  printf '%s %s\n%s\n' "${fmt}" "${state}" "${rows}" > "${dst}"
  if [[ "${state}" == "ok" ]]; then return 0; fi
  return 1
}

# Baris tracker satu protokol dari output xray_live_rows_raw, dalam format
# yang dibaca merge_xray_observations. Return 0 hanya kalau tracker berhasil.
xray_tracker_rows_for_protocol() {
  local raw="$1" protocol="$2" dst="$3" fmt="" state=""
  : > "${dst}"
  [[ -s "${raw}" ]] || return 1
  read -r fmt state < "${raw}" || true
  if [[ "${fmt}" == "rows-v3" ]]; then
    tail -n +2 "${raw}" | awk -F'|' -v proto="${protocol}" '
      $1==proto && $2 ~ /^[a-z0-9._-]+$/ && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ && $5 ~ /^[0-9]+$/ {
        print $2 "|" $3 "|" $4 "|" $5 "|" ($6!="" ? $6 : "TIDAK_TERDETEKSI") "|" ($7!="" ? $7 : "PROXY_LOCAL");
      }
    ' > "${dst}"
  else
    tail -n +2 "${raw}" | awk -F'|' -v proto="${protocol}" '
      $1==proto && $2 ~ /^[a-z0-9._-]+$/ && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ {
        active=($3+0 > 0 && $4+0 > 0 ? 1 : 0);
        print $2 "|" $3 "|" active "|" $4 "|" ($5!="" ? $5 : "TIDAK_TERDETEKSI") "|" ($6!="" ? $6 : "PROXY_LOCAL");
      }
    ' > "${dst}"
  fi
  if [[ "${state}" == "ok" ]]; then return 0; fi
  return 1
}

# Data monitor VMESS/VLESS/TROJAN, dipakai layar per protokol dan layar SEMUA
# AKUN ONLINE. Menulis "username|status|limit_ip|mode|socket|net|ip_recent|last_ip"
# ke $4, mengisi XRAY_ONLINE_SOURCE_MODE dan XRAY_ONLINE_OBSERVED (1 kalau
# tracker/log melihat sesi). Return 2 kalau tabel akun kosong.
# $5/$6 opsional: output xray_live_rows_raw dan xray_log_snapshot yang sudah
# diambil pemanggil. Kalau diisi, collector tidak mengambil sendiri (file $5
# yang tidak ada berarti tracker tidak tersedia), jadi layar SEMUA AKUN cukup
# memanggil tracker dan membaca log sekali untuk tiga protokol.
XRAY_ONLINE_SOURCE_MODE=""
XRAY_ONLINE_OBSERVED="0"
collect_xray_online_rows() {
  local table="$1" label="$2" mode="${3:-normal}" out="$4" tracker_cache="${5:-}" log_cache="${6:-}"
  local t_users t_seen t_tracker t_log t_raw protocol source_mode tracker_ready
  t_users="$(mktemp)"
  t_seen="$(mktemp)"
  t_tracker="$(mktemp)"
  t_log="$(mktemp)"
  t_raw="$(mktemp)"
  trap 'rm -f "${t_users:-}" "${t_seen:-}" "${t_tracker:-}" "${t_log:-}" "${t_raw:-}"' RETURN
  : > "${out}"
  XRAY_ONLINE_SOURCE_MODE=""
  XRAY_ONLINE_OBSERVED="0"

  case "${table}" in
    account_vmesses) protocol="vmess" ;;
    account_vlesses) protocol="vless" ;;
    account_trojans) protocol="trojan" ;;
    *) protocol="" ;;
  esac

  sqlite3 "${DB_PATH}" "
    SELECT LOWER(a.username) || '|' || UPPER(TRIM(COALESCE(a.status,''))) || '|' ||
           CAST(COALESCE(a.limitip,0) AS INTEGER) || '|' ||
           CASE WHEN EXISTS (
             SELECT 1 FROM xray_device_slots d
             WHERE d.account_type='${protocol}' AND LOWER(d.username)=LOWER(a.username)
               AND d.enabled=1 AND d.slot_no>0 AND UPPER(d.mode)='DEVICE'
           ) THEN 'DEVICE_SLOT' ELSE 'LEGACY' END
    FROM ${table} a ORDER BY LOWER(a.username);
  " > "${t_users}" 2>/dev/null || true
  if [[ ! -s "${t_users}" ]]; then
    return 2
  fi

  source_mode="LOG_WINDOW_FALLBACK"
  tracker_ready="0"
  if [[ -n "${protocol}" ]]; then
    if [[ -n "${tracker_cache}" ]]; then
      cp -f "${tracker_cache}" "${t_raw}" 2>/dev/null || : > "${t_raw}"
    else
      xray_live_rows_raw "${t_raw}" || true
    fi
    if xray_tracker_rows_for_protocol "${t_raw}" "${protocol}" "${t_tracker}"; then
      tracker_ready="1"
    fi
  fi
  if [[ -n "${log_cache}" ]]; then
    cp -f "${log_cache}" "${t_log}" 2>/dev/null || : > "${t_log}"
  else
    xray_log_snapshot "${t_log}" "${mode}"
  fi
  merge_xray_observations "${t_tracker}" "${t_log}" "${t_seen}"
  if [[ -s "${t_tracker}" && -s "${t_log}" ]]; then
    source_mode="SOCKET+AUTH_LOG"
  elif [[ -s "${t_tracker}" ]]; then
    source_mode="REALTIME_SOCKET"
  elif [[ -s "${t_log}" ]]; then
    source_mode="AUTH_LOG_FALLBACK"
  elif [[ "${tracker_ready}" == "1" ]]; then
    source_mode="REALTIME_SOCKET"
  fi
  XRAY_ONLINE_SOURCE_MODE="${source_mode}"
  if [[ ! -s "${t_seen}" ]]; then
    return 0
  fi
  XRAY_ONLINE_OBSERVED="1"

  awk -F'|' '
    NR==FNR {
      db_status[$1]=$2;
      db_limit[$1]=($3 ~ /^[0-9]+$/ ? $3 + 0 : 0);
      db_mode[$1]=($4!="" ? $4 : "LEGACY");
      next
    }
    {
      u=$1;
      sockets=($2 ~ /^[0-9]+$/ ? $2 + 0 : 0);
      ipc=($3 ~ /^[0-9]+$/ ? $3 + 0 : 0);
      recent=($4 ~ /^[0-9]+$/ ? $4 + 0 : 0);
      lip=$5;
      visibility=$6;
      if (!(u in db_status)) next;
      s=db_status[u];
      l=(u in db_limit ? db_limit[u] : 0);
      cm=(u in db_mode ? db_mode[u] : "LEGACY");
      if (s=="LOCK" || s=="LOCK_TMP" || s=="LOCK_QUOTA") out="KENA_LOCK";
      else if (sockets > 0 || visibility=="SOURCE_IP_ACTIVE" || visibility=="SOURCE_NET_EST_ACTIVE" || visibility=="SOURCE_IP_RECENT_ACTIVE" || visibility=="AUTH_ACTIVE") out="ONLINE";
      else if (visibility ~ /RECENT/) out="RECENT";
      else out="OFFLINE";
      if (recent <= 0 || visibility=="PROXY_LOCAL" || lip=="" || lip=="-") lip="TIDAK_TERDETEKSI";
      printf "%s|%s|%d|%s|%d|%d|%d|%s\n", u, out, l, cm, sockets, ipc, recent, lip;
    }' "${t_users}" "${t_seen}" > "${out}"
}

show_xray_online_realtime_by_table() {
  ui_monitor show_xray_online_by_table "$1" "$2" "realtime"
}

show_udpcustom_online() {
  local udpcustom
  udpcustom="$(detect_udpcustom_service)"
  draw_menu_header "UDP CUSTOM ONLINE (log terbaru)"
  journalctl -u "${udpcustom}" -n 600 --no-pager 2>/dev/null | \
    sed -nE '
      s/.*\[src:([^]]+)\][[:space:]]+\[user:([^]]+)\][[:space:]]+Client connected.*/\2|\1/p;
      s/.*user[=: ]([^ ,]+).*src[=: ]([^ ,]+).*/\1|\2/p;
      s/.*src[=: ]([^ ,]+).*user[=: ]([^ ,]+).*/\2|\1/p;
    ' | \
    awk -F'|' '
      {
        user=$1; src=$2;
        cnt[user]++; last[user]=src;
      }
      END {
        if (length(cnt) == 0) {
          print "Tidak ada koneksi terbaru.";
          exit;
        }
        printf "%-20s %-24s %s\n", "username", "last_src", "hits";
        for (u in cnt) {
          printf "%-20s %-24s %d\n", u, last[u], cnt[u];
        }
      }' | sort
}

refresh_zivpn_live_from_api_log_menu() {
  local win lookback has_live_table is_active
  [[ -f "${DB_PATH}" ]] || return 0
  win="$(echo "${ZIVPN_ACTIVE_WINDOW_SECONDS:-90}" | tr -cd '0-9')"
  [[ -z "${win}" || "${win}" -lt 20 ]] && win="90"
  lookback="${win}"
  if [[ "${lookback}" -lt 300 ]]; then lookback="300"; fi
  if [[ "${lookback}" -gt 3600 ]]; then lookback="3600"; fi

  has_live_table="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='zivpn_live_sessions';" 2>/dev/null || echo 0)"
  [[ "${has_live_table}" == "1" ]] || return 0

  journalctl -u sc-1forcr-api --since "-${lookback} seconds" -n 1000 -o short-unix --no-pager 2>/dev/null \
    | awk '
      /\[zivpn-auth\]/ && /result=allow/ {
        ts=0; u=""; ip="";
        if (match($0, /^[0-9]+(\.[0-9]+)?/)) {
          ts_raw=substr($0, RSTART, RLENGTH);
          sub(/\..*$/, "", ts_raw);
          ts=ts_raw+0;
        }
        if (match($0, /user=[^ ]+/)) { u=substr($0, RSTART+5, RLENGTH-5) }
        if (match($0, /ip=[^ ]+/)) { ip=substr($0, RSTART+3, RLENGTH-3) }
        if (u ~ /^[a-zA-Z0-9._-]+$/ && ip ~ /^[0-9a-fA-F:.]+$/ && ip != "127.0.0.1" && ip != "::1" && ts > 0) {
          print tolower(u) "|" ip "|" ts
        }
      }
    ' | awk -F'|' '
      {
        key=$1 "|" $2;
        ts=$3+0;
        if (ts > max[key]) max[key]=ts;
      }
      END {
        for (k in max) print k "|" max[k];
      }
    ' | while IFS='|' read -r u ip ev_ts; do
      [[ -z "${u}" || -z "${ip}" || -z "${ev_ts}" ]] && continue
      is_active="$(sqlite3 "${DB_PATH}" "SELECT COUNT(1) FROM account_sshs WHERE LOWER(username)=LOWER('${u}') AND UPPER(TRIM(COALESCE(status,'')))='AKTIF';" 2>/dev/null || echo 0)"
      [[ "${is_active}" == "1" ]] || continue
      sqlite3 "${DB_PATH}" "
        INSERT INTO zivpn_live_sessions(username, ip, first_seen, last_seen, hits)
        VALUES('${u}', '${ip}', ${ev_ts}, ${ev_ts}, 1)
        ON CONFLICT(username, ip)
        DO UPDATE SET
          first_seen = CASE
            WHEN excluded.first_seen < zivpn_live_sessions.first_seen THEN excluded.first_seen
            ELSE zivpn_live_sessions.first_seen
          END,
          last_seen = CASE
            WHEN excluded.last_seen > zivpn_live_sessions.last_seen THEN excluded.last_seen
            ELSE zivpn_live_sessions.last_seen
          END,
          hits = zivpn_live_sessions.hits + 1;
      " >/dev/null 2>&1 || true
    done
}

# Jendela aktif dan toleransi handoff monitor ZIVPN, dipakai layar ZIVPN dan
# layar SEMUA AKUN ONLINE.
ZIVPN_MONITOR_WIN="90"
ZIVPN_MONITOR_GRACE="20"
zivpn_online_windows() {
  local win handoff_grace
  win="$(echo "${ZIVPN_ACTIVE_WINDOW_SECONDS:-90}" | tr -cd '0-9')"
  [[ -z "${win}" || "${win}" -lt 20 ]] && win="90"
  [[ "${win}" -gt 1800 ]] && win="1800"
  handoff_grace="$(echo "${ZIVPN_HANDOFF_GRACE_SECONDS:-90}" | tr -cd '0-9')"
  [[ -z "${handoff_grace}" || "${handoff_grace}" -lt 3 ]] && handoff_grace="20"
  [[ "${handoff_grace}" -gt 120 ]] && handoff_grace="120"
  ZIVPN_MONITOR_WIN="${win}"
  ZIVPN_MONITOR_GRACE="${handoff_grace}"
}

# Query akun ZIVPN yang aktif: username, status, limit_ip, terhubung_ip,
# last_seen, ip_list. Layar ZIVPN menampilkannya per kolom, layar SEMUA AKUN
# membacanya sebagai baris "|".
zivpn_online_sql() {
  local win="$1" handoff_grace="$2"
  printf '%s\n' "
    WITH active AS (
      SELECT LOWER(username) AS username, ip, last_seen
      FROM zivpn_live_sessions
      WHERE last_seen >= (strftime('%s','now') - ${win})
    ),
    active_filtered AS (
      SELECT a.username, a.ip, a.last_seen
      FROM active a
      JOIN (
        SELECT username, MAX(last_seen) AS max_last_seen
        FROM active
        GROUP BY username
      ) m ON m.username = a.username
      WHERE (m.max_last_seen - a.last_seen) <= ${handoff_grace}
    ),
    agg AS (
      SELECT
        username,
        COUNT(DISTINCT ip) AS connected_ip_raw,
        MAX(last_seen) AS last_seen,
        GROUP_CONCAT(ip, ', ') AS ip_list
      FROM active_filtered
      GROUP BY username
    ),
    normalized AS (
      SELECT
        username,
        CASE
          WHEN connected_ip_raw BETWEEN 1 AND 2 THEN 1
          WHEN connected_ip_raw BETWEEN 3 AND 4 THEN 2
          ELSE connected_ip_raw
        END AS connected_ip,
        connected_ip_raw,
        last_seen,
        ip_list
      FROM agg
    )
    SELECT
      n.username AS username,
      CASE
        WHEN CAST(COALESCE(s.limitip,0) AS INTEGER) > 0 AND n.connected_ip > CAST(COALESCE(s.limitip,0) AS INTEGER) THEN 'MULTI_LOGIN'
        ELSE 'AMAN'
      END AS status,
      CAST(COALESCE(s.limitip,0) AS INTEGER) AS limit_ip,
      n.connected_ip AS terhubung_ip,
      datetime(n.last_seen, 'unixepoch', 'localtime') AS last_seen,
      COALESCE(n.ip_list, '-') AS ip_list
    FROM normalized n
    JOIN account_sshs s ON LOWER(s.username) = n.username
    WHERE UPPER(TRIM(COALESCE(s.status,'')))='AKTIF'
    ORDER BY n.last_seen DESC, n.username ASC;
  "
}

show_zivpn_online() {
  local win handoff_grace has_live_table
  zivpn_online_windows
  win="${ZIVPN_MONITOR_WIN}"
  handoff_grace="${ZIVPN_MONITOR_GRACE}"

  draw_menu_header "ZIVPN ONLINE (LIVE DB)"
  echo "Jendela aktif: ${win} detik"
  echo "Toleransi handoff: ${handoff_grace} detik"
  if [[ ! -f "${DB_PATH}" ]]; then
    echo "DB tidak ditemukan: ${DB_PATH}"
    return
  fi

  has_live_table="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='zivpn_live_sessions';" 2>/dev/null || echo 0)"
  if [[ "${has_live_table}" != "1" ]]; then
    echo "Tabel zivpn_live_sessions belum ada."
    echo "Jalankan update script terbaru lalu restart: sc-1forcr-api dan sc-1forcr-iplimit.service"
    return
  fi
  refresh_zivpn_live_from_api_log_menu

  sqlite3 -header -column "${DB_PATH}" "$(zivpn_online_sql "${win}" "${handoff_grace}")" || true

  echo
  sqlite3 -noheader "${DB_PATH}" "
    WITH active AS (
      SELECT LOWER(username) AS username, ip, last_seen
      FROM zivpn_live_sessions
      WHERE last_seen >= (strftime('%s','now') - ${win})
    ),
    active_filtered AS (
      SELECT a.username, a.ip
      FROM active a
      JOIN (
        SELECT username, MAX(last_seen) AS max_last_seen
        FROM active
        GROUP BY username
      ) m ON m.username = a.username
      WHERE (m.max_last_seen - a.last_seen) <= ${handoff_grace}
    )
    SELECT
      'Total User Aktif : ' || COUNT(DISTINCT username) || char(10) ||
      'Total IP Aktif   : ' || COUNT(DISTINCT ip)
    FROM active_filtered af
    JOIN account_sshs s ON LOWER(s.username)=af.username
    WHERE UPPER(TRIM(COALESCE(s.status,'')))='AKTIF';
  " 2>/dev/null || true
}

show_zivpn_online_realtime() {
  ui_monitor show_zivpn_online
}

# Semua akun yang sedang online dalam satu tabel. Datanya dari collector yang
# sama dengan layar per layanan, jadi angkanya selalu cocok. Tracker dan log
# Xray diambil sekali untuk tiga protokol supaya ringan di VPS 1 GB.
show_all_online() {
  local work rows ssh_mode xray_mode tracker_fmt tracker_state spec table label order rc has_live_table
  work="$(mktemp -d)"
  rows="${work}/rows"
  : > "${rows}"

  # Baris: urutan|layanan|username|status|limit_ip|sesi|ip_aktif
  # Urutan: 1 SSH, 2 UDP Custom, 3 ZIVPN, 4 VMESS, 5 VLESS, 6 TROJAN.
  collect_ssh_online_rows "${work}/ssh"
  ssh_mode="${SSH_ONLINE_SOURCE_MODE:--}"
  awk -F'|' '$1 != "" { print "1|SSH|" $1 "|" $2 "|" $3 "|" $4 "|" $5 }' "${work}/ssh" >> "${rows}"

  # UDP Custom memakai status akun SSH, seperti layar SSH + UDP CUSTOM.
  sqlite3 "${DB_PATH}" "SELECT LOWER(username) || '|' || UPPER(TRIM(COALESCE(status,''))) || '|' || CAST(COALESCE(limitip,0) AS INTEGER) FROM account_sshs;" > "${work}/ssh-status" 2>/dev/null || true
  collect_udphc_online_pairs "realtime" "${work}/udphc"
  awk '
    FILENAME==ARGV[1] {
      split($0, a, /\|/);
      st[a[1]]=a[2];
      lim[a[1]]=(a[3] ~ /^[0-9]+$/ ? a[3] + 0 : 0);
      next
    }
    $1 ~ /^[a-z0-9._-]+$/ && $2 != "" { cnt[$1]++ }
    END {
      for (u in cnt) {
        s=(u in st ? st[u] : "AMAN");
        out=((s == "LOCK" || s == "LOCK_TMP" || s == "LOCK_QUOTA") ? "KENA_LOCK" : "ONLINE");
        printf "2|UDPHC|%s|%s|%d|%d|%d\n", u, out, (u in lim ? lim[u] : 0), cnt[u], cnt[u];
      }
    }' "${work}/ssh-status" "${work}/udphc" >> "${rows}"

  has_live_table="0"
  if [[ -f "${DB_PATH}" ]]; then
    has_live_table="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='zivpn_live_sessions';" 2>/dev/null || echo 0)"
  fi
  if [[ "${has_live_table}" == "1" ]]; then
    refresh_zivpn_live_from_api_log_menu
    zivpn_online_windows
    sqlite3 -noheader -separator '|' "${DB_PATH}" "$(zivpn_online_sql "${ZIVPN_MONITOR_WIN}" "${ZIVPN_MONITOR_GRACE}")" 2>/dev/null \
      | awk -F'|' '$1 != "" { print "3|ZIVPN|" $1 "|" $2 "|" $3 "|-|" $4 }' >> "${rows}" || true
  fi

  xray_live_rows_raw "${work}/xray-raw" || true
  xray_log_snapshot "${work}/xray-log" "realtime"
  order=4
  for spec in "account_vmesses|VMESS" "account_vlesses|VLESS" "account_trojans|TROJAN"; do
    table="${spec%%|*}"
    label="${spec#*|}"
    rc=0
    collect_xray_online_rows "${table}" "${label}" "realtime" "${work}/xray-rows" "${work}/xray-raw" "${work}/xray-log" || rc=$?
    if [[ "${rc}" == "0" ]]; then
      # OFFLINE = terlihat di tracker/log tapi tanpa sesi; bukan akun online.
      awk -F'|' -v o="${order}" -v svc="${label}" '$1 != "" && $2 != "OFFLINE" { print o "|" svc "|" $1 "|" $2 "|" $3 "|" $5 "|" $6 }' \
        "${work}/xray-rows" >> "${rows}"
    fi
    order=$(( order + 1 ))
  done
  tracker_fmt=""
  tracker_state=""
  if [[ -s "${work}/xray-raw" ]]; then
    read -r tracker_fmt tracker_state < "${work}/xray-raw" || true
  fi
  xray_mode="LOG_WINDOW_FALLBACK"
  if [[ "${tracker_state}" == "ok" && -s "${work}/xray-log" ]]; then
    xray_mode="SOCKET+AUTH_LOG"
  elif [[ "${tracker_state}" == "ok" ]]; then
    xray_mode="REALTIME_SOCKET"
  elif [[ -s "${work}/xray-log" ]]; then
    xray_mode="AUTH_LOG_FALLBACK"
  fi

  # Dipasang setelah semua collector: trap RETURN milik collector menimpa trap
  # yang dipasang lebih dulu.
  trap 'rm -rf "${work:-}"' RETURN

  draw_menu_header "SEMUA USER LOGIN"
  echo "Sumber SSH  : ${ssh_mode}"
  echo "Sumber Xray : ${xray_mode}"
  echo
  if [[ ! -s "${rows}" ]]; then
    echo "Tidak ada akun yang sedang online."
    echo
    echo "Total Akun Online : 0"
    return
  fi

  printf "%-20s %-8s %-12s %-9s %-7s %-8s\n" "USERNAME" "LAYANAN" "STATUS" "LIMIT_IP" "SESI" "IP_AKTIF"
  printf "%-20s %-8s %-12s %-9s %-7s %-8s\n" "--------------------" "--------" "------------" "---------" "-------" "--------"
  sort -t'|' -k1,1n -k3,3 "${rows}" | awk -F'|' '
    {
      printf "%-20s %-8s %-12s %-9s %-7s %-8s\n", $3, $2, $4, $5, $6, $7;
      per_service[$2]++;
      account=(($2 == "SSH" || $2 == "UDPHC" || $2 == "ZIVPN") ? "SSH" : $2) SUBSEP $3;
      if (!(account in seen)) { seen[account]=1; accounts++; }
    }
    END {
      print "";
      printf "Total Akun Online : %d\n", accounts + 0;
      printf "SSH               : %d\n", per_service["SSH"] + 0;
      printf "UDP Custom        : %d\n", per_service["UDPHC"] + 0;
      printf "ZIVPN             : %d\n", per_service["ZIVPN"] + 0;
      printf "VMESS             : %d\n", per_service["VMESS"] + 0;
      printf "VLESS             : %d\n", per_service["VLESS"] + 0;
      printf "TROJAN            : %d\n", per_service["TROJAN"] + 0;
    }'
  echo
  echo "Catatan: akun SSH yang dipakai di SSH, UDP Custom, dan ZIVPN dihitung satu akun."
  echo "SESI adalah jumlah sesi/socket, bukan jumlah perangkat."
  echo "IP_AKTIF VMESS/VLESS/TROJAN adalah estimasi jaringan; RECENT berarti hanya terlihat di log."
  echo "Rincian tiap layanan ada di menu 1-6."
}

normalize_downloaded_script_file() {
  local file="$1" tmp_clean bom
  [[ -f "${file}" ]] || return 1
  bom="$(printf '\357\273\277')"
  if [[ "$(head -c 3 "${file}" 2>/dev/null || true)" == "${bom}" ]]; then
    tmp_clean="${file}.nobom.$$"
    if tail -c +4 "${file}" > "${tmp_clean}" 2>/dev/null; then
      mv -f "${tmp_clean}" "${file}"
    else
      rm -f "${tmp_clean}" 2>/dev/null || true
    fi
  fi
  sed -i 's/\r$//' "${file}" 2>/dev/null || true
  return 0
}

validate_downloaded_update_payload() {
  local file="$1" fn missing
  [[ -f "${file}" ]] || return 1
  missing=""
  for fn in mask_secret restart_update_safe_services sync_zivpn_auth_token_with_api_runtime; do
    if ! grep -qE "^[[:space:]]*${fn}[[:space:]]*\\(\\)[[:space:]]*\\{" "${file}" 2>/dev/null; then
      missing="${missing}${missing:+,}${fn}"
    fi
  done
  if [[ -n "${missing}" ]]; then
    echo "Update script tidak lengkap: helper hilang (${missing})."
    return 1
  fi
  return 0
}

update_script_from_repo() {
  local url tmp active_backend downloaded_ok derived_url update_snapshot url_candidates candidate_url
  local udpcustom_svc zstat ustat
  local banner_html banner_txt had_banner_html had_banner_txt
  local new_ver update_log update_tail
  local downloaded_version current_version expected_version downloaded_revision current_revision
  local license_base_url manifest_resp manifest_token
  # Undrop rule burst SSHWS lama saat update agar koneksi tidak nyangkut.
  if declare -F clear_sshws_loop_guard_rules >/dev/null 2>&1; then
    clear_sshws_loop_guard_rules
    fw_persist_rules
  fi
  url="${UPDATE_SCRIPT_URL:-}"
  derived_url=""
  if [[ -n "${LICENSE_API_URL:-}" ]]; then
    derived_url="$(echo "${LICENSE_API_URL}" | sed 's|/sc1forcr/license/activate$||')/sc1forcr/payload/scripts/setup-autoscript-compat.sh"
  fi
  # Local-first: jika URL update kosong/masih default github, pakai endpoint installer VPS bot.
  if [[ -n "${derived_url}" ]] && { [[ -z "${url}" ]] || [[ "${url}" == *"raw.githubusercontent.com/"* ]]; }; then
    url="${derived_url}"
  fi
  if [[ -z "${url}" ]]; then
    echo "UPDATE_SCRIPT_URL belum terdeteksi."
    echo "Pastikan LICENSE_API_URL mengarah ke VPS bot, atau isi UPDATE_SCRIPT_URL ke endpoint VPS bot."
    echo "Contoh: https://<domain-bot>/sc1forcr/payload/scripts/setup-autoscript-compat.sh"
    return 1
  fi

  mkdir -p /var/lib/sc-1forcr >/dev/null 2>&1 || true
  tmp="$(mktemp /var/lib/sc-1forcr/setup-autoscript-compat.XXXXXX.sh)"
  update_log="/var/log/sc-1forcr-update.log"
  banner_html="$(mktemp /var/lib/sc-1forcr/banner-html.XXXXXX.bak)"
  banner_txt="$(mktemp /var/lib/sc-1forcr/banner-txt.XXXXXX.bak)"
  had_banner_html="0"
  had_banner_txt="0"
  downloaded_ok=0
  url_candidates="${UPDATE_SCRIPT_URLS:-},${url},${derived_url}"
  while IFS= read -r candidate_url; do
    candidate_url="$(echo "${candidate_url}" | xargs)"
    [[ "${candidate_url}" =~ ^https?://[^[:space:]]+$ ]] || continue
    echo "Coba download update script dari: ${candidate_url}"
    if { curl -4fsSL --connect-timeout 15 --max-time 120 --retry 3 --retry-delay 2 "${candidate_url}" -o "${tmp}" ||
         curl -fsSL --connect-timeout 15 --max-time 120 --retry 3 --retry-delay 2 "${candidate_url}" -o "${tmp}"; } &&
       head -n 1 "${tmp}" | grep -q '^#!'; then
      downloaded_ok=1
      url="${candidate_url}"
      break
    fi
  done < <(printf '%s' "${url_candidates}" | tr ', ' '\n\n' | awk 'NF && !seen[$0]++')
  if [[ "${downloaded_ok}" != "1" ]]; then
    echo "Gagal download update script."
    telegram_notify_box "UPDATE SCRIPT GAGAL"       "Alasan   : gagal download script update"       "Status   : versi lama tetap berjalan"
    rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
    return 1
  fi
  chmod +x "${tmp}"
  normalize_downloaded_script_file "${tmp}"
  chmod +x "${tmp}"
  if ! bash -n "${tmp}"; then
    echo "Update script gagal validasi syntax (bash -n)."
    telegram_notify_box "UPDATE SCRIPT GAGAL"       "Alasan   : validasi syntax script gagal"       "Status   : versi lama tetap berjalan"
    rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
    return 1
  fi
  if ! validate_downloaded_update_payload "${tmp}"; then
    telegram_notify_box "UPDATE SCRIPT GAGAL"       "Alasan   : payload update tidak lengkap, helper wajib tidak ditemukan"       "Status   : versi lama tetap berjalan"
    rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
    return 1
  fi

  downloaded_version="$(awk -F'SC_SCRIPT_VERSION_OVERRIDE:-' '
    /^SCRIPT_VERSION=/ {
      value=$2;
      sub(/}.*/, "", value);
      print value;
      exit;
    }
  ' "${tmp}" 2>/dev/null || true)"
  if [[ ! "${downloaded_version}" =~ ^V\.1FSC\.[0-9]+$ ]]; then
    echo "Update ditolak: versi payload tidak dapat diverifikasi."
    rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
    return 1
  fi
  current_version="$(tr -d '[:space:]' </opt/sc-1forcr/VERSION 2>/dev/null || true)"
  if [[ -z "${current_version}" ]]; then
    current_version="$(awk -F= '/^SCRIPT_VERSION=/{print $2; exit}' /etc/sc-1forcr-version 2>/dev/null || true)"
  fi
  expected_version="${SC_EXPECTED_UPDATE_VERSION:-}"
  echo "Versi terpasang : ${current_version:-unknown}"
  echo "Versi payload   : ${downloaded_version}"
  if [[ -n "${expected_version}" && "${downloaded_version}" != "${expected_version}" ]]; then
    echo "Update ditolak: trigger meminta ${expected_version}, tetapi VPS bot masih menyajikan ${downloaded_version}."
    rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
    return 1
  fi
  if [[ "${current_version}" =~ ^V\.1FSC\.[0-9]+$ ]]; then
    downloaded_revision="${downloaded_version##*.}"
    current_revision="${current_version##*.}"
    if (( 10#${downloaded_revision} < 10#${current_revision} )) && [[ "${SC_UPDATE_ALLOW_DOWNGRADE:-0}" != "1" ]]; then
      echo "Update ditolak: payload ${downloaded_version} lebih lama dari versi terpasang ${current_version}."
      rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
      return 1
    fi
    if [[ "${downloaded_version}" == "${current_version}" ]]; then
      echo "INFO: payload server masih pada versi yang sama; update dijalankan sebagai repair."
    fi
  fi

  if [[ -f /etc/sc-1forcr-license-required ]]; then
    license_base_url="$(echo "${url:-}" | sed 's|/sc1forcr/payload/scripts/setup-autoscript-compat.sh.*$||')"
    if [[ -z "${license_base_url}" || "${license_base_url}" == "${url:-}" || \
          ! -x /usr/local/sbin/sc-1forcr-license-guard || -z "${SC_UPDATE_KEY:-}" ]]; then
      echo "Update ditolak: verifier atau key signed manifest tidak tersedia."
      rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
      return 1
    fi
    manifest_resp="$(
      curl -4fsS --connect-timeout 10 --max-time 30 \
        -H "X-SC-Key: ${SC_UPDATE_KEY}" \
        -H "Authorization: Bearer ${LICENSE_API_TOKEN:-}" \
        "${license_base_url}/sc1forcr/payload/manifest" 2>/dev/null ||
      curl -fsS --connect-timeout 10 --max-time 30 \
        -H "X-SC-Key: ${SC_UPDATE_KEY}" \
        -H "Authorization: Bearer ${LICENSE_API_TOKEN:-}" \
        "${license_base_url}/sc1forcr/payload/manifest" 2>/dev/null || true
    )"
    manifest_token="$(echo "${manifest_resp}" | jq -r '.manifest // empty' 2>/dev/null || true)"
    if [[ -z "${manifest_token}" ]] || \
       ! /usr/local/sbin/sc-1forcr-license-guard verify-update "${tmp}" "${manifest_token}" >/dev/null; then
      echo "Update ditolak: signature/checksum manifest installer tidak valid."
      rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
      return 1
    fi
    echo "Signed manifest installer: OK"
  fi

  update_snapshot=""
  if [[ -x /usr/local/sbin/sc-1forcr-update-manager ]]; then
    if ! update_snapshot="$(/usr/local/sbin/sc-1forcr-update-manager snapshot "pre-update-${SCRIPT_VERSION:-unknown}")"; then
      echo "Gagal membuat snapshot. Update dibatalkan sebelum ada perubahan."
      rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
      return 1
    fi
    echo "Snapshot rollback: ${update_snapshot}"
  else
    echo "Bootstrap update pertama: installer baru akan membuat snapshot sebelum mengubah runtime."
  fi

  active_backend="$(echo "${ACTIVE_UDP_BACKEND:-zivpn}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${active_backend}" != "zivpn" && "${active_backend}" != "udpcustom" && "${active_backend}" != "udp-custom" && "${active_backend}" != "udphc" ]]; then
    active_backend="zivpn"
  fi
  if [[ "${active_backend}" == "udp-custom" || "${active_backend}" == "udphc" ]]; then
    active_backend="udpcustom"
  fi
  # Prioritaskan kondisi service aktual agar mode sebelum update benar-benar dipertahankan.
  udpcustom_svc="$(detect_udpcustom_service)"
  zstat="$(systemctl is-active "${ZIVPN_SERVICE}" 2>/dev/null || true)"
  ustat="$(systemctl is-active "${udpcustom_svc}" 2>/dev/null || true)"
  if [[ "${ustat}" == "active" && "${zstat}" != "active" ]]; then
    active_backend="udpcustom"
  elif [[ "${zstat}" == "active" && "${ustat}" != "active" ]]; then
    active_backend="zivpn"
  fi

  # Backup banner custom agar tidak tertimpa saat proses update installer.
  rm -f "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
  if [[ -s /etc/sc-1forcr/banner.html ]]; then
    cp -f /etc/sc-1forcr/banner.html "${banner_html}" >/dev/null 2>&1 || true
    [[ -s "${banner_html}" ]] && had_banner_html="1"
  fi
  if [[ -s /etc/sc-1forcr/banner.txt ]]; then
    cp -f /etc/sc-1forcr/banner.txt "${banner_txt}" >/dev/null 2>&1 || true
    [[ -s "${banner_txt}" ]] && had_banner_txt="1"
  fi

  # Migrasi: upgrade default lama ke nilai baru yang lebih optimal.
  # Hanya sentuh jika nilai masih default lama (bukan custom user).
  if [[ "${DROPBEAR_IDLE_TIMEOUT_SECONDS:-0}" == "0" ]]; then
    DROPBEAR_IDLE_TIMEOUT_SECONDS="300"
    update_sc_env_var "DROPBEAR_IDLE_TIMEOUT_SECONDS" "300"
    echo "Migrasi: DROPBEAR_IDLE_TIMEOUT_SECONDS 0 -> 300 (cegah zombie proses)"
  fi
  # IPLIMIT interval: paksa minimal 5 menit untuk cegah CPU spike.
  # Nilai 1-4 terlalu agresif di VPS kecil-menengah.
  local _iplimit_cur
  _iplimit_cur="$(echo "${IPLIMIT_CHECK_INTERVAL_MINUTES:-3}" | tr -cd '0-9')"
  if [[ -z "${_iplimit_cur}" || "${_iplimit_cur}" -lt 5 ]]; then
    IPLIMIT_CHECK_INTERVAL_MINUTES="5"
    update_sc_env_var "IPLIMIT_CHECK_INTERVAL_MINUTES" "5"
    echo "Migrasi: IPLIMIT_CHECK_INTERVAL_MINUTES ${_iplimit_cur:-?} -> 5 (minimal 5 menit, cegah CPU spike)"
  fi
  # XRAY_IP_GROUP_MASK: upgrade default lama 24 -> 16 (CGNAT Indo tolerance).
  # Hanya sentuh jika nilai masih default lama 24 (bukan custom 32/8).
  local _mask_cur
  _mask_cur="$(echo "${XRAY_IP_GROUP_MASK:-24}" | tr -cd '0-9')"
  if [[ "${_mask_cur}" == "24" ]]; then
    XRAY_IP_GROUP_MASK="16"
    update_sc_env_var "XRAY_IP_GROUP_MASK" "16"
    update_app_env_var "XRAY_IP_GROUP_MASK" "16" 2>/dev/null || true
    echo "Migrasi: XRAY_IP_GROUP_MASK 24 -> 16 (toleransi CGNAT Indo, cegah false multi-login)"
  fi

  echo "Menjalankan update installer..."
  : > "${update_log}" 2>/dev/null || true
  if ! DOMAIN="${DOMAIN}" \
    EMAIL="${EMAIL:-}" \
    API_AUTH_TOKEN="${AUTH_TOKEN}" \
    LICENSE_ENFORCE="${LICENSE_ENFORCE:-1}" \
    LICENSE_API_URL="${LICENSE_API_URL:-}" \
    LICENSE_API_TOKEN="${LICENSE_API_TOKEN:-}" \
    LICENSE_KEY="${LICENSE_KEY:-}" \
    SC_UPDATE_KEY="${SC_UPDATE_KEY:-${AUTH_TOKEN:-}}" \
    LICENSE_LEASE_REQUIRED="${LICENSE_LEASE_REQUIRED:-1}" \
    LICENSE_PUBLIC_KEY_B64="${LICENSE_PUBLIC_KEY_B64:-}" \
    LICENSE_LEASE_REFRESH_MINUTES="${LICENSE_LEASE_REFRESH_MINUTES:-15}" \
    WILDCARD_ENABLE="${WILDCARD_ENABLE:-0}" \
    WILDCARD_BASE_DOMAIN="${WILDCARD_BASE_DOMAIN:-}" \
    WILDCARD_CF_API_TOKEN="${WILDCARD_CF_API_TOKEN:-}" \
    WILDCARD_CF_EMAIL="${WILDCARD_CF_EMAIL:-}" \
    WILDCARD_CF_API_KEY="${WILDCARD_CF_API_KEY:-}" \
    WILDCARD_BUG_PREFIX="${WILDCARD_BUG_PREFIX:-}" \
    WILDCARD_BUG_PREFIXES="${WILDCARD_BUG_PREFIXES:-}" \
    WILDCARD_XRAY_HOST="${WILDCARD_XRAY_HOST:-}" \
    WILDCARD_XRAY_HOSTS="${WILDCARD_XRAY_HOSTS:-}" \
    XRAY_PUBLIC_HOST="$(build_xray_public_host)" \
    XRAY_FRONT_DOMAIN="${XRAY_FRONT_DOMAIN:-}" \
    XRAY_FRONT_DOMAINS="${XRAY_FRONT_DOMAINS:-}" \
    UPDATE_SCRIPT_URL="${url}" \
    DB_PATH="${DB_PATH}" \
    APP_DIR="/opt/sc-1forcr" \
    ZIVPN_SERVICE_NAME="${ZIVPN_SERVICE}" \
    UDPCUSTOM_SERVICE_NAME="${UDPCUSTOM_SERVICE}" \
    ZIVPN_DNAT_RANGE="${ZIVPN_DNAT_RANGE}" \
    ZIVPN_EXTRA_UDP_PORTS="${ZIVPN_EXTRA_UDP_PORTS:-553}" \
    UDPCUSTOM_DNAT_RANGE="${UDPCUSTOM_DNAT_RANGE}" \
    UDPCUSTOM_DNAT_AUTO_RANGE="${UDPCUSTOM_DNAT_AUTO_RANGE}" \
    SSHWS_UDPGW_PORTS="${SSHWS_UDPGW_PORTS:-7300,7200}" \
    SSHWS_UDPGW_SINGLE_PROCESS="${SSHWS_UDPGW_SINGLE_PROCESS:-1}" \
    SSHWS_UDPGW_MAX_CLIENTS="${SSHWS_UDPGW_MAX_CLIENTS:-auto}" \
    SSHWS_UDPGW_MAX_CONNECTIONS_PER_CLIENT="${SSHWS_UDPGW_MAX_CONNECTIONS_PER_CLIENT:-auto}" \
    SSHWS_UDPGW_MEMORY_MAX="${SSHWS_UDPGW_MEMORY_MAX:-auto}" \
    SSHWS_UDPGW_BIND_ADDR="${SSHWS_UDPGW_BIND_ADDR:-127.0.0.1}" \
    SSHWS_UDPGW_CLIENT_SNDBUF="${SSHWS_UDPGW_CLIENT_SNDBUF:-262144}" \
    SSHWS_ACCOUNT_SESSION_HARD_LIMIT="${SSHWS_ACCOUNT_SESSION_HARD_LIMIT:-auto}" \
    SSH_TUNNEL_SHELL="${SSH_TUNNEL_SHELL:-/usr/local/sbin/sc-1forcr-tunnel-shell}" \
    SSH_TUNNEL_BLOCK_OUTBOUND_SSH="${SSH_TUNNEL_BLOCK_OUTBOUND_SSH:-1}" \
    SSH_TUNNEL_BLOCK_OUTBOUND_PORTS="${SSH_TUNNEL_BLOCK_OUTBOUND_PORTS:-22,2222}" \
    TUNNEL_ABUSE_GUARD_ENABLE="${TUNNEL_ABUSE_GUARD_ENABLE:-1}" \
    TUNNEL_ABUSE_BLOCK_TCP_PORTS="${TUNNEL_ABUSE_BLOCK_TCP_PORTS:-3389,5900,5901,5902,445,135,139,25,465,587}" \
    DROPBEAR_PORT="${DROPBEAR_PORT}" \
    DROPBEAR_ALT_PORT="${DROPBEAR_ALT_PORT}" \
    DROPBEAR_VERSION="${DROPBEAR_VERSION:-2019.78}" \
    DROPBEAR_KEEPALIVE_SECONDS="${DROPBEAR_KEEPALIVE_SECONDS:-30}" \
    DROPBEAR_IDLE_TIMEOUT_SECONDS="${DROPBEAR_IDLE_TIMEOUT_SECONDS:-300}" \
    IPLIMIT_CHECK_INTERVAL_MINUTES="${IPLIMIT_CHECK_INTERVAL_MINUTES}" \
    IPLIMIT_LOCK_MINUTES="${IPLIMIT_LOCK_MINUTES}" \
    IPLIMIT_LOCK_HISTORY_RETENTION_DAYS="${IPLIMIT_LOCK_HISTORY_RETENTION_DAYS:-90}" \
    IPLIMIT_AUTO_LOCK_ENABLE="${IPLIMIT_AUTO_LOCK_ENABLE:-1}" \
    QUOTA_LOCK_ENABLE="${QUOTA_LOCK_ENABLE:-1}" \
    IPLIMIT_AUTO_TUNE="${IPLIMIT_AUTO_TUNE:-1}" \
    IPLIMIT_DEBUG="${IPLIMIT_DEBUG:-0}" \
    XRAY_BLOCK_TCP_PORTS="${XRAY_BLOCK_TCP_PORTS}" \
    XRAY_RECENT_WINDOW_MINUTES="${XRAY_RECENT_WINDOW_MINUTES}" \
    XRAY_ACTIVE_WINDOW_SECONDS="${XRAY_ACTIVE_WINDOW_SECONDS}" \
    XRAY_MIN_HITS_PER_IP="${XRAY_MIN_HITS_PER_IP}" \
    XRAY_IP_GROUP_MASK="${XRAY_IP_GROUP_MASK:-16}" \
    XRAY_MIRROR_BASE="${XRAY_MIRROR_BASE:-}" \
    XRAY_VERSION="${XRAY_VERSION:-}" \
    XRAY_REAL_IP_ENABLE="${XRAY_REAL_IP_ENABLE:-0}" \
    XRAY_XHTTP_ENABLE="${XRAY_XHTTP_ENABLE:-0}" \
    SERVICE_SSH_ENABLE="${SERVICE_SSH_ENABLE:-1}" \
    SERVICE_VMESS_ENABLE="${SERVICE_VMESS_ENABLE:-1}" \
    SERVICE_VLESS_ENABLE="${SERVICE_VLESS_ENABLE:-1}" \
    SERVICE_TROJAN_ENABLE="${SERVICE_TROJAN_ENABLE:-1}" \
    SERVICE_UDP_ENABLE="${SERVICE_UDP_ENABLE:-1}" \
    XRAY_LIVE_IP_TTL_SECONDS="${XRAY_LIVE_IP_TTL_SECONDS:-90}" \
    XRAY_PATHS_VMESS="${XRAY_PATHS_VMESS}" \
    XRAY_PATHS_VLESS="${XRAY_PATHS_VLESS}" \
    XRAY_PATHS_TROJAN="${XRAY_PATHS_TROJAN}" \
    NETWORK_COMPAT_ENABLE="${NETWORK_COMPAT_ENABLE:-0}" \
    NETWORK_TCP_MSS="${NETWORK_TCP_MSS:-1360}" \
    XRAY_OUTBOUND_DOMAIN_STRATEGY="${XRAY_OUTBOUND_DOMAIN_STRATEGY:-AsIs}" \
    SSHWS_READER_BUFFER_KB="${SSHWS_READER_BUFFER_KB:-auto}" \
    SSHWS_TCP_KEEPALIVE_SECONDS="${SSHWS_TCP_KEEPALIVE_SECONDS:-30}" \
    SSHWS_LOOP_GUARD_ENABLE="${SSHWS_LOOP_GUARD_ENABLE}" \
    SSHWS_LOOP_GUARD_PORTS="${SSHWS_LOOP_GUARD_PORTS}" \
    SSHWS_LOOP_GUARD_NEW_ABOVE="${SSHWS_LOOP_GUARD_NEW_ABOVE}" \
    SSHWS_LOOP_GUARD_BURST="${SSHWS_LOOP_GUARD_BURST}" \
    SSHWS_LOOP_GUARD_CONNLIMIT_ABOVE="${SSHWS_LOOP_GUARD_CONNLIMIT_ABOVE}" \
    HAPROXY_TCPLOG_ENABLE="${HAPROXY_TCPLOG_ENABLE:-0}" \
    HAPROXY_SERVICE_LIMIT_NOFILE="${HAPROXY_SERVICE_LIMIT_NOFILE:-auto}" \
    HAPROXY_MAXCONN="${HAPROXY_MAXCONN:-auto}" \
    HAPROXY_NBTHREAD="${HAPROXY_NBTHREAD:-auto}" \
    SC_API_MEMORY_MAX="${SC_API_MEMORY_MAX:-auto}" \
    SSHWS_SERVICE_MEMORY_MAX="${SSHWS_SERVICE_MEMORY_MAX:-auto}" \
    TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
    TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" \
    BOT_PANEL_ENABLE="${BOT_PANEL_ENABLE:-0}" \
    BOT_PANEL_TOKEN="${BOT_PANEL_TOKEN:-}" \
    BOT_PANEL_ADMIN_IDS="${BOT_PANEL_ADMIN_IDS:-}" \
    BOT_PANEL_MEMORY_MAX="${BOT_PANEL_MEMORY_MAX:-128M}" \
    SLOWDNS_ENABLE="${SLOWDNS_ENABLE:-0}" \
    SLOWDNS_NS_DOMAIN="${SLOWDNS_NS_DOMAIN:-}" \
    SLOWDNS_LISTEN_PORT="${SLOWDNS_LISTEN_PORT:-5300}" \
    SLOWDNS_MTU="${SLOWDNS_MTU:-1232}" \
    SLOWDNS_MEMORY_MAX="${SLOWDNS_MEMORY_MAX:-auto}" \
    SLOWDNS_KCP_WINDOW="${SLOWDNS_KCP_WINDOW:-auto}" \
    SLOWDNS_GOMAXPROCS="${SLOWDNS_GOMAXPROCS:-auto}" \
    SLOWDNS_GOGC="${SLOWDNS_GOGC:-300}" \
    SLOWDNS_AUTO_LOCK_ENABLE="${SLOWDNS_AUTO_LOCK_ENABLE:-1}" \
    SLOWDNS_BIN_URL="${SLOWDNS_BIN_URL:-}" \
    SLOWDNS_BIN_SHA256="${SLOWDNS_BIN_SHA256:-}" \
    BOT_ACCOUNT_EVENT_WEBHOOK_URL="${BOT_ACCOUNT_EVENT_WEBHOOK_URL:-}" \
    BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN="${BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN:-}" \
    AUTO_INSTALL_SUMMARY_API="0" \
    API_DOCS_ENABLE="${API_DOCS_ENABLE:-0}" \
    SUMMARY_API_SETUP_URL="${SUMMARY_API_SETUP_URL:-}" \
    AUTO_BACKUP_ENABLE="${AUTO_BACKUP_ENABLE}" \
    AUTO_BACKUP_DIR="${AUTO_BACKUP_DIR}" \
    AUTO_BACKUP_KEEP_DAYS="${AUTO_BACKUP_KEEP_DAYS}" \
    AUTO_BACKUP_INTERVAL_MINUTES="${AUTO_BACKUP_INTERVAL_MINUTES:-1440}" \
    AUTO_BACKUP_SCHEDULE_MODE="${AUTO_BACKUP_SCHEDULE_MODE:-interval}" \
    AUTO_BACKUP_WIB_HOUR="${AUTO_BACKUP_WIB_HOUR:-2}" \
    AUTO_REBOOT_ENABLE="${AUTO_REBOOT_ENABLE:-0}" \
    AUTO_REBOOT_INTERVAL_MINUTES="${AUTO_REBOOT_INTERVAL_MINUTES:-1440}" \
    AUTO_REBOOT_SCHEDULE_MODE="${AUTO_REBOOT_SCHEDULE_MODE:-interval}" \
    AUTO_REBOOT_WIB_HOUR="${AUTO_REBOOT_WIB_HOUR:-3}" \
    AUTO_PULL_UPDATE_ENABLE="${AUTO_PULL_UPDATE_ENABLE:-1}" \
    AUTO_PULL_UPDATE_INTERVAL_MINUTES="${AUTO_PULL_UPDATE_INTERVAL_MINUTES:-360}" \
    AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES="${AUTO_PULL_UPDATE_FAIL_COOLDOWN_MINUTES:-360}" \
    ONLINE_NOTIFY_ENABLE="${ONLINE_NOTIFY_ENABLE}" \
    ONLINE_NOTIFY_INTERVAL_HOURS="${ONLINE_NOTIFY_INTERVAL_HOURS}" \
    ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS="${ONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS}" \
    RESOURCE_AUTOTUNE_ENABLE="${RESOURCE_AUTOTUNE_ENABLE:-1}" \
    RESOURCE_TARGET_USAGE_PERCENT="${RESOURCE_TARGET_USAGE_PERCENT:-85}" \
    RESOURCE_AUTOTUNE_INTERVAL_MINUTES="${RESOURCE_AUTOTUNE_INTERVAL_MINUTES:-15}" \
    RESOURCE_CAPACITY_STATE_FILE="${RESOURCE_CAPACITY_STATE_FILE:-/var/lib/sc-1forcr/capacity.env}" \
    UPDATE_SAFE_MODE="${UPDATE_SAFE_MODE:-0}" \
    UPDATE_TRANSACTION_SNAPSHOT="${update_snapshot}" \
    ACTIVE_UDP_BACKEND="${active_backend}" \
    bash "${tmp}" 2>&1 | tee "${update_log}"; then
    echo "Update script gagal dijalankan."
    # Cukup ujung log (bagian yang memuat error); log lengkap tetap di VPS.
    update_tail="$(tail -c 600 "${update_log}" 2>/dev/null | tr '\n' ' ' | tr -s ' ')"
    [[ -z "${update_tail}" ]] && update_tail="-"
    telegram_notify_box "UPDATE SCRIPT GAGAL" \
      "Alasan   : installer update exit non-zero" \
      "Log VPS  : ${update_log}" \
      "Akhir log: ${update_tail}"
    rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
    return 1
  fi

  # Restore banner lama (jika sebelumnya ada), atau tetap nonaktif bila sebelumnya memang tidak ada.
  if [[ "${had_banner_html}" == "1" && -s "${banner_html}" ]]; then
    mkdir -p /etc/sc-1forcr
    cp -f "${banner_html}" /etc/sc-1forcr/banner.html >/dev/null 2>&1 || true
    chmod 644 /etc/sc-1forcr/banner.html >/dev/null 2>&1 || true
    apply_html_banner_config "/etc/sc-1forcr/banner.html"
  elif [[ "${had_banner_html}" != "1" ]]; then
    rm -f /etc/sc-1forcr/banner.html >/dev/null 2>&1 || true
    apply_html_banner_config ""
  fi
  if [[ "${had_banner_txt}" == "1" && -s "${banner_txt}" ]]; then
    mkdir -p /etc/sc-1forcr
    cp -f "${banner_txt}" /etc/sc-1forcr/banner.txt >/dev/null 2>&1 || true
    chmod 644 /etc/sc-1forcr/banner.txt >/dev/null 2>&1 || true
  elif [[ "${had_banner_txt}" != "1" ]]; then
    rm -f /etc/sc-1forcr/banner.txt >/dev/null 2>&1 || true
  fi

  # Pastikan mode backend UDP pasca-update sama seperti sebelum update.
  ACTIVE_UDP_BACKEND="${active_backend}"
  update_sc_env_var "ACTIVE_UDP_BACKEND" "${ACTIVE_UDP_BACKEND}"
  update_app_env_var "ACTIVE_UDP_BACKEND" "${ACTIVE_UDP_BACKEND}"
  if [[ "${UPDATE_SAFE_MODE:-0}" == "1" ]]; then
    restart_update_safe_services
    echo "Update mode aman: service SSHWS/Xray/Dropbear/HAProxy tidak direstart penuh."
  else
    if [[ "${ACTIVE_UDP_BACKEND}" == "udpcustom" ]]; then
      switch_udp_to_udpcustom || true
    else
      switch_udp_to_zivpn || true
    fi
    # Terapkan ulang kebijakan loop guard sesuai env terbaru (default nonaktif).
    if declare -F apply_sshws_loop_guard_rules >/dev/null 2>&1; then
      apply_sshws_loop_guard_rules
    fi
    systemctl restart sc-1forcr-udp-bootfix.service >/dev/null 2>&1 || true
    restart_all_services
    echo "Semua service selesai direstart otomatis setelah update."
  fi

  new_ver="-"
  if [[ -f /etc/sc-1forcr-version ]]; then
    new_ver="$(awk -F= '/^SCRIPT_VERSION=/{print $2}' /etc/sc-1forcr-version | head -n1)"
    [[ -z "${new_ver}" ]] && new_ver="-"
  fi
  if [[ "${new_ver}" != "${downloaded_version}" ]]; then
    telegram_notify_box "UPDATE SCRIPT GAGAL" \
      "Alasan   : marker versi ${new_ver} tidak sama dengan payload ${downloaded_version}"
    echo "Update gagal diverifikasi: marker ${new_ver}, payload ${downloaded_version}."
    rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
    return 1
  fi
  telegram_notify_box "UPDATE SCRIPT BERHASIL" \
    "Versi    : ${new_ver}" \
    "Mode     : $([[ "${UPDATE_SAFE_MODE:-0}" == "1" ]] && echo "aman, tanpa restart penuh" || echo "semua service direstart")"

  rm -f "${tmp}" "${banner_html}" "${banner_txt}" >/dev/null 2>&1 || true
  return 0
}

update_script_locked() (
  mkdir -p /run >/dev/null 2>&1 || true
  flock -n 9 || {
    echo "Update lain masih berjalan. Coba lagi setelah proses tersebut selesai."
    exit 1
  }
  update_script_from_repo
) 9>/run/sc-1forcr-update.lock

manual_update_sc() {
  local confirm
  draw_menu_header "UPDATE SC AMAN"
  echo "Mode       : aman (backup + health-check + rollback otomatis)"
  echo "Sumber     : ${UPDATE_SCRIPT_URL:-otomatis dari VPS bot}"
  echo "Database   : ${DB_PATH}"
  echo
  echo "Update tidak akan dimulai jika snapshot gagal dibuat."
  if ! prompt_input confirm "Ketik UPDATE untuk melanjutkan: "; then
    return 0
  fi
  [[ "${confirm}" == "UPDATE" ]] || {
    echo "Update dibatalkan."
    return 0
  }
  if UPDATE_SAFE_MODE=1 update_script_locked; then
    echo
    echo "Update berhasil. Memuat ulang menu dari runtime terbaru..."
    exec /usr/local/sbin/menu-sc-1forcr
  fi
  return 1
}

manual_rollback_latest_update() {
  local confirm latest_snapshot
  draw_menu_header "ROLLBACK UPDATE TERAKHIR"
  if [[ ! -x /usr/local/sbin/sc-1forcr-update-manager ]]; then
    echo "Update manager belum terpasang. Jalankan satu kali update aman terlebih dahulu."
    return 1
  fi
  latest_snapshot="$(/usr/local/sbin/sc-1forcr-update-manager latest 2>/dev/null || true)"
  if [[ -z "${latest_snapshot}" ]]; then
    echo "Belum ada snapshot update yang dapat dipakai."
    return 1
  fi
  echo "Snapshot : ${latest_snapshot}"
  echo
  /usr/local/sbin/sc-1forcr-update-manager list | head -n 7 | ui_fx || true
  echo
  echo "Rollback memulihkan database, konfigurasi, runtime SC, dan unit service."
  echo "SSH utama/network tidak dihentikan agar akses root tetap tersedia."
  if ! prompt_input confirm "Ketik ROLLBACK untuk memulihkan snapshot terbaru: "; then
    return 0
  fi
  [[ "${confirm}" == "ROLLBACK" ]] || {
    echo "Rollback dibatalkan."
    return 0
  }
  /usr/local/sbin/sc-1forcr-update-manager rollback "${latest_snapshot}"
}

update_rollback_menu() {
  local choice latest_snapshot
  while true; do
    latest_snapshot="-"
    if [[ -x /usr/local/sbin/sc-1forcr-update-manager ]]; then
      latest_snapshot="$(/usr/local/sbin/sc-1forcr-update-manager latest 2>/dev/null || echo '-')"
    fi
    draw_menu_panel "UPDATE / ROLLBACK SC" \
      "1) Update SC aman (backup otomatis)" \
      "2) Rollback update terakhir" \
      "3) Daftar snapshot update" \
      "0) Kembali"
    echo "Snapshot terbaru : ${latest_snapshot}"
    echo
    if ! prompt_input choice "Pilih [0-3]: "; then
      return 0
    fi
    case "${choice}" in
      1) manual_update_sc || true ;;
      2) manual_rollback_latest_update || true ;;
      3)
        if [[ -x /usr/local/sbin/sc-1forcr-update-manager ]]; then
          /usr/local/sbin/sc-1forcr-update-manager list | ui_fx || true
        else
          echo "Belum ada snapshot update."
        fi
        ;;
      0) return 0 ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    echo
    menu_pause
    clear >/dev/null 2>&1 || true
  done
}

show_sc_key_info() {
  draw_menu_header "INFORMASI KEY SC"
  echo "Domain        : ${DOMAIN}"
  echo "API Base      : https://${DOMAIN}/vps"
  echo "Auth Token    : ${AUTH_TOKEN}"
}

set_telegram_notif_config() {
  local token chat send_test ans
  draw_menu_header "SETTING NOTIF TELEGRAM"
  echo "Bot Token     : $(mask_secret "${TELEGRAM_BOT_TOKEN:-}")"
  echo "Chat ID       : ${TELEGRAM_CHAT_ID:-"-"}"
  echo
  echo "Kosongkan input untuk mempertahankan nilai lama."
  echo "Ketik 'batal' untuk kembali."

  if ! prompt_input token "TELEGRAM_BOT_TOKEN: "; then
    return
  fi
  [[ "${token,,}" == "batal" ]] && return

  if ! prompt_input chat "TELEGRAM_CHAT_ID: "; then
    return
  fi
  [[ "${chat,,}" == "batal" ]] && return

  if [[ -n "${token}" ]]; then
    TELEGRAM_BOT_TOKEN="${token}"
    update_sc_env_var "TELEGRAM_BOT_TOKEN" "${TELEGRAM_BOT_TOKEN}"
    update_app_env_var "TELEGRAM_BOT_TOKEN" "${TELEGRAM_BOT_TOKEN}"
  fi
  if [[ -n "${chat}" ]]; then
    TELEGRAM_CHAT_ID="${chat}"
    update_sc_env_var "TELEGRAM_CHAT_ID" "${TELEGRAM_CHAT_ID}"
    update_app_env_var "TELEGRAM_CHAT_ID" "${TELEGRAM_CHAT_ID}"
  fi
  systemctl restart sc-1forcr-api >/dev/null 2>&1 || true
  reset_online_notify_retry
  systemctl restart sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
  systemctl start sc-1forcr-online-notify.service >/dev/null 2>&1 || true

  echo "Konfigurasi Telegram tersimpan."
  echo "Bot Token     : $(mask_secret "${TELEGRAM_BOT_TOKEN:-}")"
  echo "Chat ID       : ${TELEGRAM_CHAT_ID:-"-"}"

  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    if prompt_input ans "Kirim pesan test sekarang? [y/N]: "; then
      if [[ "${ans,,}" == "y" || "${ans,,}" == "yes" ]]; then
        if telegram_notify_box "TES NOTIFIKASI" \
          "Status   : notifikasi Telegram VPS ini aktif"; then
          echo "Pesan test dikirim (cek chat Telegram)."
        else
          echo "Gagal kirim pesan test Telegram (token/chat_id/bot permission kemungkinan belum benar)."
        fi
      fi
    fi
  fi
}

# Mode Bot Panel: bot jualan akun (service sc-1forcr-botpanel) dengan token
# sendiri (BOT_PANEL_TOKEN). Bot notifikasi (TELEGRAM_BOT_TOKEN) terpisah dan
# tetap mengirim notif seperti biasa, apa pun status Bot Panel.
bot_panel_enabled() {
  [[ "$(normalize_bool_01 "${BOT_PANEL_ENABLE:-0}")" == "1" ]]
}

bot_panel_admin_ids_text() {
  printf '%s' "${BOT_PANEL_ADMIN_IDS:--}"
}

# Token bot jualan dicek ke Telegram (getMe) sebelum disimpan. Token yang sama
# dengan bot notif ditolak supaya kedua bot benar-benar terpisah.
set_bot_panel_token() {
  local token resp name
  echo "Token Bot Jualan : $(mask_secret "${BOT_PANEL_TOKEN:-}")"
  echo "Buat bot baru di @BotFather khusus untuk jualan, lalu tempel tokennya di sini."
  echo "Kosongkan untuk mempertahankan, ketik 'batal' untuk kembali."
  if ! prompt_input token "Token Bot Jualan: "; then
    return 1
  fi
  [[ "${token,,}" == "batal" ]] && return 1
  [[ -z "${token}" ]] && return 0
  token="$(printf '%s' "${token}" | tr -d '[:space:]')"
  if [[ ! "${token}" =~ ^[0-9]{5,15}:[A-Za-z0-9_-]{30,64}$ ]]; then
    echo "Format token tidak valid. Contoh: 123456789:AAH...(dari @BotFather)."
    return 1
  fi
  if [[ "${token}" == "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    echo "Gagal: token ini sama dengan bot notif. Bot jualan wajib memakai bot lain."
    return 1
  fi
  resp="$(curl -sS --connect-timeout 10 --max-time 20 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null || true)"
  if [[ "${resp}" == *'"ok":false'* ]]; then
    echo "Gagal: token ditolak Telegram. Cek lagi token dari @BotFather."
    return 1
  fi
  name="$(printf '%s' "${resp}" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
  if [[ -z "${name}" ]]; then
    echo "Peringatan: Telegram tidak bisa dihubungi untuk mengecek token; token tetap disimpan."
  fi
  BOT_PANEL_TOKEN="${token}"
  update_sc_env_var "BOT_PANEL_TOKEN" "${BOT_PANEL_TOKEN}"
  update_app_env_var "BOT_PANEL_TOKEN" "${BOT_PANEL_TOKEN}"
  if bot_panel_enabled; then
    systemctl restart sc-1forcr-botpanel.service >/dev/null 2>&1 || true
  fi
  echo "Berhasil: token bot jualan tersimpan${name:+ (@${name})}."
  return 0
}

# Perkiraan dampak dari pengukuran service: proses Node + sqlite3 sekitar
# 40-60 MB RAM, CPU hampir 0% saat sepi (long polling 1 request per 50 detik).
bot_panel_is_small_vps() {
  local ram_kb cores
  ram_kb="$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null || echo 0)"
  cores="$(nproc 2>/dev/null || echo 1)"
  (( ${ram_kb:-0} < 1800000 || ${cores:-1} < 2 ))
}

bot_panel_resource_note() {
  local ram_kb
  ram_kb="$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null || echo 0)"
  echo "Spesifikasi VPS : RAM $(( ${ram_kb:-0} / 1024 )) MiB, $(nproc 2>/dev/null || echo 1) vCPU"
  echo "Pemakaian bot   : sekitar 40-60 MB RAM (batas ${BOT_PANEL_MEMORY_MAX:-128M}), CPU hampir 0% saat sepi"
  if bot_panel_is_small_vps; then
    echo "Peringatan: VPS 1 GB / 1 vCPU cukup untuk toko kecil (puluhan pembeli aktif)."
    echo "Untuk pembeli ramai (ratusan pengguna bot aktif) atau banyak server, disarankan 2 GB / 2 vCPU."
  fi
}

set_bot_panel_admin_ids() {
  local ids clean suggest=""
  if [[ -z "${BOT_PANEL_ADMIN_IDS:-}" && "${TELEGRAM_CHAT_ID:-}" =~ ^[0-9]{4,20}$ ]]; then
    suggest="${TELEGRAM_CHAT_ID}"
  fi
  echo "ID admin sekarang : $(bot_panel_admin_ids_text)"
  echo "Cek ID Telegram Anda lewat @userinfobot (atau kirim /id ke bot jualan saat aktif)."
  echo "Pisahkan beberapa ID dengan koma. Ketik 'batal' untuk kembali."
  if [[ -n "${suggest}" ]]; then
    echo "Kosongkan untuk memakai ID ${suggest} (Chat ID bot notif)."
  else
    echo "Kosongkan untuk mempertahankan."
  fi
  if ! prompt_input ids "ID admin Bot Panel: "; then
    return 1
  fi
  [[ "${ids,,}" == "batal" ]] && return 1
  [[ -z "${ids}" ]] && ids="${suggest}"
  [[ -z "${ids}" ]] && return 0
  clean="$(echo "${ids}" | tr ' ;' ',,' | tr -cd '0-9,' | sed 's/,,*/,/g; s/^,//; s/,$//')"
  if [[ -z "${clean}" ]]; then
    echo "ID admin tidak valid."
    return 1
  fi
  BOT_PANEL_ADMIN_IDS="${clean}"
  update_sc_env_var "BOT_PANEL_ADMIN_IDS" "${BOT_PANEL_ADMIN_IDS}"
  update_app_env_var "BOT_PANEL_ADMIN_IDS" "${BOT_PANEL_ADMIN_IDS}"
  if bot_panel_enabled; then
    systemctl restart sc-1forcr-botpanel.service >/dev/null 2>&1 || true
  fi
  echo "Berhasil: ID admin Bot Panel = ${BOT_PANEL_ADMIN_IDS}"
  return 0
}

toggle_bot_panel() {
  local ans
  if bot_panel_enabled; then
    BOT_PANEL_ENABLE="0"
    update_sc_env_var "BOT_PANEL_ENABLE" "0"
    update_app_env_var "BOT_PANEL_ENABLE" "0"
    systemctl disable --now sc-1forcr-botpanel.service >/dev/null 2>&1 || true
    echo "Berhasil: Bot Panel dinonaktifkan. Bot kembali hanya mengirim notifikasi."
    return 0
  fi
  if [[ ! -f /etc/systemd/system/sc-1forcr-botpanel.service || ! -f "${APP_DIR:-/opt/sc-1forcr}/bot-panel.js" ]]; then
    echo "Gagal: Bot Panel belum terpasang di VPS ini. Jalankan Update SC dulu."
    return 1
  fi
  if [[ -z "${BOT_PANEL_TOKEN:-}" ]]; then
    echo "Peringatan: token bot jualan belum diisi. Bot jualan memakai bot terpisah dari bot notif."
    set_bot_panel_token || return 1
    [[ -n "${BOT_PANEL_TOKEN:-}" ]] || return 1
  fi
  if [[ -z "${BOT_PANEL_ADMIN_IDS:-}" ]]; then
    echo "Peringatan: ID admin bot jualan belum diisi."
    set_bot_panel_admin_ids || return 1
    [[ -n "${BOT_PANEL_ADMIN_IDS:-}" ]] || return 1
  fi
  if bot_panel_is_small_vps; then
    if ! prompt_input ans "VPS ini kecil. Tetap aktifkan Bot Panel? [y/N]: "; then
      return 1
    fi
    if [[ "${ans,,}" != "y" && "${ans,,}" != "yes" ]]; then
      echo "Dibatalkan."
      return 0
    fi
  fi
  BOT_PANEL_ENABLE="1"
  update_sc_env_var "BOT_PANEL_ENABLE" "1"
  update_app_env_var "BOT_PANEL_ENABLE" "1"
  systemctl enable --no-reload sc-1forcr-botpanel.service >/dev/null 2>&1 || true
  systemctl restart sc-1forcr-botpanel.service >/dev/null 2>&1 || true
  sleep 3
  if systemctl is-active --quiet sc-1forcr-botpanel.service; then
    echo "Berhasil: Bot Panel aktif. Kirim /start ke bot jualan, lalu buka Menu Admin untuk"
    echo "mengisi harga server ini, payment gateway, dan menambah server lain."
  else
    echo "Gagal: Bot Panel tidak berjalan. Cek log:"
    journalctl -u sc-1forcr-botpanel.service -n 20 --no-pager -o cat 2>/dev/null || true
    return 1
  fi
  return 0
}

set_bot_panel_menu() {
  local choice state
  state="NONAKTIF (bot hanya kirim notifikasi)"
  bot_panel_enabled && state="AKTIF (bot jualan akun)"
  draw_menu_header "MODE BOT PANEL (JUALAN AKUN)"
  echo "Status           : ${state}"
  echo "Service          : $(systemctl is-active sc-1forcr-botpanel.service 2>/dev/null || echo inactive)"
  echo "Token Bot Jualan : $(mask_secret "${BOT_PANEL_TOKEN:-}")"
  echo "Admin Bot Jualan : $(bot_panel_admin_ids_text)"
  echo "Bot Notif        : $(mask_secret "${TELEGRAM_BOT_TOKEN:-}") (terpisah, tetap kirim notif)"
  bot_panel_resource_note
  echo
  echo "Bot jualan memakai bot Telegram sendiri. Saat aktif, /start di bot jualan"
  echo "menampilkan info toko dan saldo, menu buat, trial, perpanjang akun, dan top up"
  echo "QRIS GoPay/ShopeePay (AutoGoPay). Menu Admin di bot dipakai menambah server SC"
  echo "lain (domain + Auth Token), mengatur harga, dan saldo. Kabar toko (top up,"
  echo "penjualan) dikirim bot jualan ke admin; notif server tetap lewat bot notif."
  echo "Satu token bot jualan hanya untuk satu Bot Panel; VPS lain cukup didaftarkan."
  echo
  if bot_panel_enabled; then
    echo "1) Nonaktifkan Bot Panel"
  else
    echo "1) Aktifkan Bot Panel"
  fi
  echo "2) Set Token Bot Jualan"
  echo "3) Set ID Admin Bot Jualan"
  echo "4) Lihat Log Bot Panel"
  echo "5) Tes Koneksi Telegram"
  echo "0) Kembali"
  if ! prompt_input choice "Pilih [0-5]: "; then
    return 0
  fi
  case "${choice}" in
    1) toggle_bot_panel || true ;;
    2) set_bot_panel_token || true ;;
    3) set_bot_panel_admin_ids || true ;;
    4) journalctl -u sc-1forcr-botpanel.service -n 40 --no-pager -o cat 2>/dev/null || echo "Log Bot Panel belum tersedia." ;;
    5) check_bot_panel_telegram || true ;;
    *) return 0 ;;
  esac
  return 0
}

# Tes koneksi VPS ini ke api.telegram.org lewat IPv4 dan IPv6, lalu getMe
# dengan token bot jualan. Token tidak pernah dicetak. Log "getUpdates gagal"
# berarti bot tidak bisa menjangkau Telegram; layar ini menunjukkan jalurnya.
check_bot_panel_telegram() {
  local v res err ok_any=0 slow=0 code connect
  draw_menu_header "TES KONEKSI TELEGRAM BOT JUALAN"
  echo "Node.js          : $(node -v 2>/dev/null || echo "-")"
  for v in 4 6; do
    err="$(mktemp)"
    res="$(curl -"${v}" -sS -m 15 -o /dev/null -w '%{http_code} %{time_connect}' https://api.telegram.org 2>"${err}" || true)"
    code="${res%% *}"
    connect="${res##* }"
    if [[ -n "${code}" && "${code}" != "000" ]]; then
      ok_any=1
      echo "IPv${v}             : Berhasil (HTTP ${code}, sambung ${connect} detik)"
      if [[ "${connect}" =~ ^0\.(2[5-9]|[3-9]) || "${connect}" =~ ^[1-9] ]]; then slow=1; fi
    else
      echo "IPv${v}             : Gagal ($(tr -d '\n' <"${err}" | head -c 100))"
    fi
    rm -f "${err}"
  done
  if [[ -n "${BOT_PANEL_TOKEN:-}" ]]; then
    res="$(curl -sS -m 15 "https://api.telegram.org/bot${BOT_PANEL_TOKEN}/getMe" 2>/dev/null || true)"
    if [[ "${res}" == *'"ok":true'* ]]; then
      echo "Token bot jualan : Berhasil (@$(sed -n 's/.*"username":"\([^"]*\)".*/\1/p' <<<"${res}"))"
    elif [[ -n "${res}" ]]; then
      echo "Token bot jualan : Gagal ($(sed -n 's/.*"description":"\([^"]*\)".*/\1/p' <<<"${res}" | head -c 100))"
    else
      echo "Token bot jualan : Gagal (tidak ada respons dari Telegram)"
    fi
  else
    echo "Token bot jualan : belum diisi"
  fi
  echo
  if [[ "${ok_any}" != "1" ]]; then
    echo "Peringatan: VPS ini tidak bisa menjangkau api.telegram.org lewat IPv4 maupun IPv6."
    echo "Bot jualan tidak bisa jalan sampai provider atau firewall VPS membuka akses ke Telegram."
  elif [[ "${slow}" == "1" ]]; then
    echo "Koneksi ke Telegram lambat (lebih dari 0,25 detik). Bot Panel V.1FSC.110 ke atas"
    echo "sudah menyesuaikan diri; versi lama bisa gagal polling di jalur seperti ini."
  else
    echo "Koneksi ke Telegram normal."
  fi
  return 0
}

set_account_event_webhook_config() {
  local webhook_url webhook_token
  draw_menu_header "SETTING WEBHOOK BOT AKUN (MULTI-LOGIN)"
  echo "Webhook URL   : ${BOT_ACCOUNT_EVENT_WEBHOOK_URL:-"-"}"
  echo "Webhook Token : $(mask_secret "${BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN:-}")"
  echo
  echo "Kosongkan input untuk mempertahankan nilai lama."
  echo "Ketik 'batal' untuk kembali."
  echo "Contoh URL: http://IP_BOTVPN:PORT/sc1forcr/events/multi-login"

  if ! prompt_input webhook_url "BOT_ACCOUNT_EVENT_WEBHOOK_URL: "; then
    return
  fi
  [[ "${webhook_url,,}" == "batal" ]] && return

  if ! prompt_input webhook_token "BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN: "; then
    return
  fi
  [[ "${webhook_token,,}" == "batal" ]] && return

  if [[ -n "${webhook_url}" ]]; then
    BOT_ACCOUNT_EVENT_WEBHOOK_URL="${webhook_url}"
    update_sc_env_var "BOT_ACCOUNT_EVENT_WEBHOOK_URL" "${BOT_ACCOUNT_EVENT_WEBHOOK_URL}"
    update_app_env_var "BOT_ACCOUNT_EVENT_WEBHOOK_URL" "${BOT_ACCOUNT_EVENT_WEBHOOK_URL}"
  fi
  if [[ -n "${webhook_token}" ]]; then
    BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN="${webhook_token}"
    update_sc_env_var "BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN" "${BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN}"
    update_app_env_var "BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN" "${BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN}"
  fi

  systemctl restart sc-1forcr-iplimit.timer >/dev/null 2>&1 || true
  systemctl start sc-1forcr-iplimit.service >/dev/null 2>&1 || true

  echo "Konfigurasi webhook bot akun tersimpan."
  echo "Webhook URL   : ${BOT_ACCOUNT_EVENT_WEBHOOK_URL:-"-"}"
  echo "Webhook Token : $(mask_secret "${BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN:-}")"
}

install_summary_api_1forcr() {
  local url tmp derived_url manifest_base manifest_resp manifest_token url_candidates candidate_url downloaded_ok
  url="${SUMMARY_API_SETUP_URL:-}"
  derived_url=""
  if [[ -n "${LICENSE_API_URL:-}" ]]; then
    derived_url="$(echo "${LICENSE_API_URL}" | sed 's|/sc1forcr/license/activate$||')/sc1forcr/payload/scripts/setup-summary-api.sh"
  fi
  # Local-first: jika URL summary kosong/masih default github, pakai endpoint installer VPS bot.
  if [[ -n "${derived_url}" ]] && { [[ -z "${url}" ]] || [[ "${url}" == *"raw.githubusercontent.com/"* ]]; }; then
    url="${derived_url}"
  fi
  if [[ -z "${url}" ]]; then
    echo "SUMMARY_API_SETUP_URL belum terdeteksi."
    echo "Pastikan LICENSE_API_URL mengarah ke VPS bot, atau isi SUMMARY_API_SETUP_URL ke endpoint VPS bot."
    echo "Contoh: https://<domain-bot>/sc1forcr/payload/scripts/setup-summary-api.sh"
    return 1
  fi
  tmp="/tmp/setup-summary-api.sh"
  echo "Install Summary API 1FORCR..."
  downloaded_ok="0"
  url_candidates="${SUMMARY_API_SETUP_URLS:-},${url},${derived_url}"
  while IFS= read -r candidate_url; do
    candidate_url="$(echo "${candidate_url}" | xargs)"
    [[ "${candidate_url}" =~ ^https?://[^[:space:]]+$ ]] || continue
    echo "Coba download Summary API dari: ${candidate_url}"
    if { curl -4fL --connect-timeout 15 --max-time 120 --retry 3 --retry-delay 2 "${candidate_url}" -o "${tmp}" ||
         curl -fL --connect-timeout 15 --max-time 120 --retry 3 --retry-delay 2 "${candidate_url}" -o "${tmp}"; } &&
       head -n 1 "${tmp}" | grep -q '^#!'; then
      downloaded_ok="1"
      url="${candidate_url}"
      break
    fi
  done < <(printf '%s' "${url_candidates}" | tr ', ' '\n\n' | awk 'NF && !seen[$0]++')
  if [[ "${downloaded_ok}" != "1" ]]; then
    echo "Gagal download script summary API."
    return 1
  fi
  sed -i 's/\r$//' "${tmp}"
  if ! bash -n "${tmp}"; then
    echo "Installer Summary API gagal validasi syntax."
    rm -f "${tmp}" >/dev/null 2>&1 || true
    return 1
  fi
  if [[ -f /etc/sc-1forcr-license-required ]]; then
    manifest_base="$(echo "${url:-}" | sed 's|/sc1forcr/payload/scripts/setup-summary-api.sh.*$||')"
    if [[ -z "${manifest_base}" || "${manifest_base}" == "${url:-}" || \
          -z "${SC_UPDATE_KEY:-}" || ! -x /usr/local/sbin/sc-1forcr-license-guard ]]; then
      echo "Update Summary API ditolak: verifier/key signed manifest tidak tersedia."
      rm -f "${tmp}" >/dev/null 2>&1 || true
      return 1
    fi
    manifest_resp="$(curl -4fsS --connect-timeout 10 --max-time 30 \
      -H "X-SC-Key: ${SC_UPDATE_KEY}" -H "Authorization: Bearer ${LICENSE_API_TOKEN:-}" \
      "${manifest_base}/sc1forcr/payload/summary-manifest" 2>/dev/null || \
      curl -fsS --connect-timeout 10 --max-time 30 \
      -H "X-SC-Key: ${SC_UPDATE_KEY}" -H "Authorization: Bearer ${LICENSE_API_TOKEN:-}" \
      "${manifest_base}/sc1forcr/payload/summary-manifest" 2>/dev/null || true)"
    manifest_token="$(echo "${manifest_resp}" | jq -r '.manifest // empty' 2>/dev/null || true)"
    if [[ -z "${manifest_token}" ]] || \
       ! /usr/local/sbin/sc-1forcr-license-guard verify-update "${tmp}" "${manifest_token}" >/dev/null; then
      echo "Update Summary API ditolak: signature/checksum manifest tidak valid."
      rm -f "${tmp}" >/dev/null 2>&1 || true
      return 1
    fi
    echo "Signed manifest Summary API: OK"
  fi
  chmod 700 "${tmp}"
  SUMMARY_UPDATE_SAFE_MODE=1 APP_DIR="/root/tunnel-sync" POTATO_DB="${DB_PATH}" bash "${tmp}"
  return 0
}

write_default_banner_html() {
  local banner_file
  banner_file="/etc/sc-1forcr/banner.html"
  mkdir -p /etc/sc-1forcr
  cat > "${banner_file}" <<'EOF'
<div style="text-align:center; line-height:1.6; font-family: monospace;">

<font color="#00ffff">=======================</font><br>
<font color="#17e8ff">SECURE SSH SERVICE</font><br>
<font color="#00ffff">=======================</font><br>


<!-- ATURAN PAKAI -->
<font color="#ff45ba"><b>ATURAN PEMAKAIAN</b></font><br>
<font color="#84ecdb">
Gunakan akun sesuai limit perangkat.<br>
Jangan membagikan akun ke pengguna lain.<br>
Hubungi admin layanan jika butuh bantuan.<br>
</font><br>

<font color="red"><b>Akun dapat dikunci otomatis jika melanggar limit.</b></font><br><br>
<font color="#84ecdb"><i>Terima kasih telah menggunakan layanan kami.</i></font><br>
<font color="#00ffff">=========================</font><br>

</div>
EOF
  chmod 644 "${banner_file}" >/dev/null 2>&1 || true
}

apply_html_banner_config() {
  local banner_file="$1" main_port alt_port dropbear_bin dropbear_args

  main_port="$(echo "${DROPBEAR_PORT:-109}" | tr -cd '0-9')"
  alt_port="$(echo "${DROPBEAR_ALT_PORT:-143}" | tr -cd '0-9')"
  [[ -z "${main_port}" ]] && main_port="109"
  [[ -z "${alt_port}" ]] && alt_port="143"
  if [[ "${main_port}" -lt 1 || "${main_port}" -gt 65535 ]]; then main_port="109"; fi
  if [[ "${alt_port}" -lt 1 || "${alt_port}" -gt 65535 ]]; then alt_port="143"; fi

  # Prioritaskan binary custom build, fallback ke dropbear bawaan sistem.
  dropbear_bin="$(ls -1 /usr/local/sbin/dropbear-* 2>/dev/null | head -n1 || true)"
  [[ -z "${dropbear_bin}" || ! -x "${dropbear_bin}" ]] && dropbear_bin="/usr/sbin/dropbear"
  dropbear_args="$(dropbear_runtime_args)"

  if [[ -n "${banner_file}" && -f "${banner_file}" ]]; then
    if grep -qE '^[[:space:]]*Banner[[:space:]]+' /etc/ssh/sshd_config 2>/dev/null; then
      sed -i "s|^[[:space:]]*Banner[[:space:]].*|Banner ${banner_file}|g" /etc/ssh/sshd_config
    else
      echo "Banner ${banner_file}" >> /etc/ssh/sshd_config
    fi
    # Dropbear punya batas ukuran banner sendiri; sshd tetap memakai file asli.
    local sshd_banner_file="${banner_file}"
    banner_file="$(dropbear_safe_banner "${banner_file}")"
    if [[ -f /etc/default/dropbear ]]; then
      if grep -q '^DROPBEAR_BANNER=' /etc/default/dropbear; then
        sed -i "s|^DROPBEAR_BANNER=.*|DROPBEAR_BANNER=\"${banner_file}\"|g" /etc/default/dropbear
      else
        echo "DROPBEAR_BANNER=\"${banner_file}\"" >> /etc/default/dropbear
      fi
    fi
    mkdir -p /etc/systemd/system/dropbear.service.d
    cat > /etc/systemd/system/dropbear.service.d/override.conf <<EOF
[Service]
Type=simple
KillMode=control-group
TimeoutStopSec=5
Restart=on-failure
LimitNOFILE=65536
TasksMax=8192
ExecStart=
ExecStart=${dropbear_bin} -R -E -F ${dropbear_args} -p ${main_port} -p ${alt_port}${banner_file:+ -b ${banner_file}}
EOF
    echo "Banner aktif: ${sshd_banner_file}"
  else
    if grep -qE '^[[:space:]]*Banner[[:space:]]+' /etc/ssh/sshd_config 2>/dev/null; then
      sed -i "s|^[[:space:]]*Banner[[:space:]].*|Banner none|g" /etc/ssh/sshd_config
    else
      echo "Banner none" >> /etc/ssh/sshd_config
    fi
    if [[ -f /etc/default/dropbear ]] && grep -q '^DROPBEAR_BANNER=' /etc/default/dropbear; then
      sed -i 's|^DROPBEAR_BANNER=.*|DROPBEAR_BANNER=""|g' /etc/default/dropbear
    fi
    mkdir -p /etc/systemd/system/dropbear.service.d
    cat > /etc/systemd/system/dropbear.service.d/override.conf <<EOF
[Service]
Type=simple
KillMode=control-group
TimeoutStopSec=5
Restart=on-failure
LimitNOFILE=65536
TasksMax=8192
ExecStart=
ExecStart=${dropbear_bin} -R -E -F ${dropbear_args} -p ${main_port} -p ${alt_port}
EOF
    echo "Banner dinonaktifkan."
  fi

  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart ssh >/dev/null 2>&1 || true
  systemctl restart dropbear >/dev/null 2>&1 || true
}

resolve_dropbear_release_from_menu() {
  case "${1:-}" in
    2018) echo "2018.76" ;;
    2019) echo "2019.78" ;;
    2020) echo "2020.81" ;;
    2022) echo "2022.83" ;;
    *) echo "" ;;
  esac
}

apply_dropbear_version_with_lock() {
  local major="$1" ver src_dir archive_url archive_path build_dir custom_bin main_port alt_port banner_file dropbear_args
  ver="$(resolve_dropbear_release_from_menu "${major}")"
  if [[ -z "${ver}" ]]; then
    echo "Versi tidak didukung. Pilih: 2018, 2019, 2020, 2022."
    return 1
  fi

  main_port="$(echo "${DROPBEAR_PORT:-109}" | tr -cd '0-9')"
  alt_port="$(echo "${DROPBEAR_ALT_PORT:-143}" | tr -cd '0-9')"
  [[ -z "${main_port}" ]] && main_port="109"
  [[ -z "${alt_port}" ]] && alt_port="143"
  if [[ "${main_port}" -lt 1 || "${main_port}" -gt 65535 ]]; then main_port="109"; fi
  if [[ "${alt_port}" -lt 1 || "${alt_port}" -gt 65535 ]]; then alt_port="143"; fi

  src_dir="/usr/local/src"
  archive_url="https://matt.ucc.asn.au/dropbear/releases/dropbear-${ver}.tar.bz2"
  archive_path="${src_dir}/dropbear-${ver}.tar.bz2"
  build_dir="${src_dir}/dropbear-${ver}"
  custom_bin="/usr/local/sbin/dropbear-${ver}"
  banner_file="/etc/sc-1forcr/banner.html"
  [[ -s "${banner_file}" ]] || banner_file=""
  banner_file="$(dropbear_safe_banner "${banner_file}")"
  dropbear_args="$(dropbear_runtime_args)"

  mkdir -p "${src_dir}"
  rm -rf "${build_dir}"
  echo "Download & build Dropbear ${ver}..."
  local dl_ok=0 dl_url
  while IFS= read -r dl_url; do
    [[ -n "${dl_url}" ]] || continue
    echo "Coba download: ${dl_url}"
    if curl -fL --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 "${dl_url}" -o "${archive_path}"; then
      dl_ok=1
      break
    fi
    rm -f "${archive_path}" >/dev/null 2>&1 || true
  done < <(dropbear_fallback_urls "${ver}")
  if [[ "${dl_ok}" != "1" ]]; then
    echo "Gagal download source Dropbear ${ver} dari semua mirror."
    return 1
  fi
  if ! tar -xjf "${archive_path}" -C "${src_dir}"; then
    echo "Gagal extract archive Dropbear ${ver}."
    return 1
  fi

  if ! (
    cd "${build_dir}"
    ./configure --prefix=/usr/local --sysconfdir=/etc/dropbear
    make -j"$(nproc || echo 1)"
    cp -f dropbear "${custom_bin}"
    if [[ -x ./dropbearkey ]]; then
      cp -f ./dropbearkey /usr/local/bin/dropbearkey-sc1
    fi
  ); then
    echo "Build Dropbear ${ver} gagal. Versi lama belum tentu cocok dengan toolchain sistem ini."
    return 1
  fi
  chmod 755 "${custom_bin}"

  mkdir -p /etc/dropbear
  if [[ -x /usr/local/bin/dropbearkey-sc1 ]]; then
    [[ -s /etc/dropbear/dropbear_rsa_host_key ]] || /usr/local/bin/dropbearkey-sc1 -t rsa -f /etc/dropbear/dropbear_rsa_host_key >/dev/null 2>&1 || true
    [[ -s /etc/dropbear/dropbear_ecdsa_host_key ]] || /usr/local/bin/dropbearkey-sc1 -t ecdsa -f /etc/dropbear/dropbear_ecdsa_host_key >/dev/null 2>&1 || true
    [[ -s /etc/dropbear/dropbear_ed25519_host_key ]] || /usr/local/bin/dropbearkey-sc1 -t ed25519 -f /etc/dropbear/dropbear_ed25519_host_key >/dev/null 2>&1 || true
  fi

  cat > /etc/default/dropbear <<EOF
NO_START=0
DROPBEAR_PORT=${main_port}
DROPBEAR_EXTRA_ARGS="${dropbear_args} -p ${alt_port}"
DROPBEAR_BANNER="${banner_file}"
DROPBEAR_RECEIVE_WINDOW=65536
EOF

  mkdir -p /etc/systemd/system/dropbear.service.d
  if [[ -n "${banner_file}" ]]; then
    cat > /etc/systemd/system/dropbear.service.d/override.conf <<EOF
[Service]
Type=simple
KillMode=control-group
TimeoutStopSec=5
Restart=on-failure
LimitNOFILE=65536
TasksMax=8192
ExecStart=
ExecStart=${custom_bin} -R -E -F ${dropbear_args} -p ${main_port} -p ${alt_port} -b ${banner_file}
EOF
  else
    cat > /etc/systemd/system/dropbear.service.d/override.conf <<EOF
[Service]
Type=simple
KillMode=control-group
TimeoutStopSec=5
Restart=on-failure
LimitNOFILE=65536
TasksMax=8192
ExecStart=
ExecStart=${custom_bin} -R -E -F ${dropbear_args} -p ${main_port} -p ${alt_port}
EOF
  fi

  update_sc_env_var "DROPBEAR_VERSION" "${ver}"
  apt-mark hold dropbear dropbear-bin >/dev/null 2>&1 || true
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable dropbear >/dev/null 2>&1 || true
  systemctl restart dropbear >/dev/null 2>&1 || true
  systemctl restart ssh >/dev/null 2>&1 || true

  echo "Dropbear aktif di versi ${ver} (locked)."
  echo "Cek: ${custom_bin} -V"
}

set_dropbear_version_menu() {
  while true; do
    local cur="(tidak diketahui)"
    local major_choice
    if [[ -n "${DROPBEAR_VERSION:-}" ]]; then
      cur="${DROPBEAR_VERSION}"
    elif command -v dropbear >/dev/null 2>&1; then
      cur="$(dropbear -V 2>&1 | head -n1 | sed 's/.*Dropbear v//; s/ .*//')"
      [[ -z "${cur}" ]] && cur="(runtime)"
    fi
    clear
    draw_menu_panel "SETTING VERSI DROPBEAR (CURRENT: ${cur})" \
      "1) Pakai Dropbear 2018 (v2018.76)" \
      "2) Pakai Dropbear 2019 (v2019.78)" \
      "3) Pakai Dropbear 2020 (v2020.81)" \
      "4) Pakai Dropbear 2022 (v2022.83)" \
      "0) Kembali"
    echo
    if ! prompt_input dv "Pilih menu [0-4]: "; then
      return
    fi
    case "${dv}" in
      1) major_choice="2018" ;;
      2) major_choice="2019" ;;
      3) major_choice="2020" ;;
      4) major_choice="2022" ;;
      0) return ;;
      *) echo "Pilihan tidak valid."; menu_pause; continue ;;
    esac
    if apply_dropbear_version_with_lock "${major_choice}"; then
      DROPBEAR_VERSION="$(resolve_dropbear_release_from_menu "${major_choice}")"
      echo "Sukses. Versi Dropbear sudah dikunci agar aman saat reboot/update."
    else
      echo "Gagal set versi Dropbear ${major_choice}."
    fi
    echo
    menu_pause
  done
}

set_html_banner_menu() {
  local banner_file
  banner_file="/etc/sc-1forcr/banner.html"
  mkdir -p /etc/sc-1forcr

  while true; do
    draw_menu_panel "SETTING BANNER HTML" \
      "1) Set/Edit banner via GNU nano" \
      "2) Lihat banner aktif" \
      "3) Nonaktifkan banner" \
      "4) Pakai template default umum" \
      "0) Kembali"
    echo
    if ! prompt_input bm "Pilih menu [0-4]: "; then
      return
    fi
    case "${bm}" in
      1)
        if ! command -v nano >/dev/null 2>&1; then
          echo "GNU nano belum ada, install nano..."
          # Mandiri: runtime menu tidak memuat helper apt milik installer.
          # Kegagalan update (mis. repo pihak ketiga rusak) tidak boleh
          # menggagalkan pemasangan nano dari repo resmi yang masih sehat.
          DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 ||             echo "Catatan: apt-get update tidak bersih, repo bermasalah diabaikan."
          if ! DEBIAN_FRONTEND=noninteractive apt-get install -y nano >/dev/null 2>&1; then
            echo "Gagal memasang nano. Pasang manual: apt-get install -y nano"
            return
          fi
        fi
        [[ -s "${banner_file}" ]] || write_default_banner_html
        echo "GNU nano akan dibuka."
        echo "Simpan banner: tekan Ctrl+X, lalu Y, lalu Enter."
        sleep 1
        nano "${banner_file}"
        if [[ -s "${banner_file}" ]]; then
          chmod 644 "${banner_file}" >/dev/null 2>&1 || true
          apply_html_banner_config "${banner_file}"
        else
          echo "Banner kosong, tidak diterapkan."
        fi
        ;;
      2)
        if [[ -f "${banner_file}" ]]; then
          draw_menu_header "BANNER AKTIF (${banner_file})"
          cat "${banner_file}"
        else
          echo "Belum ada banner aktif."
        fi
        ;;
      3)
        rm -f "${banner_file}" >/dev/null 2>&1 || true
        apply_html_banner_config ""
        ;;
      4)
        write_default_banner_html
        apply_html_banner_config "${banner_file}"
        echo "Template default umum berhasil diterapkan."
        ;;
      0)
        return
        ;;
      *)
        echo "Pilihan tidak valid."
        ;;
    esac
    echo
    menu_pause
    clear
  done
}

monitor_online_menu() {
  while true; do
    clear
    draw_menu_panel "MONITOR USER ONLINE" \
      "1) SSH" \
      "2) SSH + UDP CUSTOM" \
      "3) VMESS" \
      "4) VLESS" \
      "5) TROJAN" \
      "6) ZIVPN" \
      "7) SEMUA AKUN ONLINE" \
      "0) Kembali"
    echo
    if ! prompt_input o "Pilih menu [0-7]: "; then
      return
    fi
    clear
    case "${o}" in
      # Monitor punya tombol keluar sendiri ([q]/Enter), jadi tanpa jeda "Enter untuk lanjut".
      1) ui_monitor show_ssh_only_online; continue ;;
      2) ui_monitor show_ssh_online; continue ;;
      3) show_xray_online_realtime_by_table "account_vmesses" "VMESS"; continue ;;
      4) show_xray_online_realtime_by_table "account_vlesses" "VLESS"; continue ;;
      5) show_xray_online_realtime_by_table "account_trojans" "TROJAN"; continue ;;
      6) show_zivpn_online_realtime; continue ;;
      # Mengumpulkan semua layanan sekaligus, jadi mode live-nya dibuat lebih jarang.
      7) UI_MONITOR_LIVE_SECONDS=10 ui_monitor show_all_online; continue ;;
      0) return ;;
      *) echo "Pilihan tidak valid." ;;
    esac
    echo
    menu_pause
  done
}

SHOW_FULL_MENU=1
MENU_ESC=$'\033'
MENU_C="${MENU_ESC}[36m"    # cyan
MENU_DIM="${MENU_ESC}[2m"
MENU_BOLD="${MENU_ESC}[1m"
MENU_NC="${MENU_ESC}[0m"

# ── Mesin tampilan: warna gradasi dan kotak responsif ───────────────────────
# Mode warna: truecolor (24-bit), 256, 16, none. Klien SSH jarang meneruskan
# COLORTERM, jadi mode otomatis memakai 256 warna untuk TERM modern dan 16
# warna untuk konsol lama. Pilihan manual (Tools > Tema Warna Menu) disimpan di
# MENU_COLOR_FILE, bukan di env, jadi tidak perlu ikut dump env lintas update.
MENU_COLOR_FILE="/etc/sc-1forcr/menu-color"
UI_MODE=""
UI_NC="${MENU_NC}"
UI_BOLD="${MENU_BOLD}"
UI_LABEL=""; UI_VAL=""; UI_MUTED=""; UI_OK=""; UI_WARN=""; UI_BAD=""; UI_ACC=""; UI_ACC2=""; UI_INK=""
UI_BW=0
UI_IW=0
UI_W=0
UI_R=0; UI_G=0; UI_B=0; UI_L=0; UI_N16=37
UI_OUT=""
UI_TMP=""
UI_GRAD=()
UI_GRAD_BG=()
UI_GRAD_KEY=""
# Jumlah baris yang sudah dicetak mesin tampilan sejak layar dibersihkan.
# Dashboard live memakainya untuk tahu posisi baris dan apakah layar muat.
UI_ROWS=0
# UI_ROW_SINK=buf: ui_row menulis ke UI_BUF, tidak ke layar.
UI_ROW_SINK=""
UI_BUF=""
# Dashboard live: baris CPU/RAM/UPTIME/TIME diperbarui tiap N detik selama
# menu utama menunggu pilihan. 0 = mati (contoh: DASHBOARD_LIVE_SECONDS=0 menu).
DASHBOARD_LIVE_SECONDS="${DASHBOARD_LIVE_SECONDS:-2}"
DASHBOARD_LIVE_IDLE_MINUTES="${DASHBOARD_LIVE_IDLE_MINUTES:-10}"
DASH_LIVE_ON=0
DASH_WINCH=0
DASH_K=""
DASH_CAP_AGE=""
DASH_CAP_REREAD_SECONDS=30
DASH_CAP_READ_AT=0
declare -A DASH_KEYS=()
# Titik gradasi neon: cyan -> biru -> ungu -> magenta.
UI_SR=(0 41 150 255)
UI_SG=(229 121 70 64)
UI_SB=(255 255 255 170)
UI_16_CODE=(31 32 33 34 35 36 37 90 91 92 93 94 95 96 97)
UI_16_R=(205 0 205 0 205 0 229 127 255 0 255 92 255 0 255)
UI_16_G=(0 205 205 0 0 205 229 127 0 255 255 92 0 255 255)
UI_16_B=(0 0 0 238 205 205 229 127 0 0 0 255 255 255 255)

# Default truecolor (gradasi paling halus, beban VPS sama dengan 256 warna).
# Hanya terminal yang jelas tidak mendukungnya yang turun: konsol teks
# provider/VNC ke 16 warna, GNU screen ke 256 (tmux mengonversi sendiri).
# Pilihan manual di Tools > Tema Warna Menu selalu menang.
ui_color_mode_auto() {
  if [[ -n "${NO_COLOR:-}" ]]; then printf 'none'; return 0; fi
  case "${TERM:-}" in
    ''|dumb|linux|vt100|vt102|vt220|ansi|cons25) printf '16' ;;
    screen*) if [[ -n "${TMUX:-}" ]]; then printf 'truecolor'; else printf '256'; fi ;;
    *) printf 'truecolor' ;;
  esac
}

ui_color_mode() {
  local forced=""
  if [[ -r "${MENU_COLOR_FILE}" ]]; then
    forced="$(tr -cd 'a-z0-9' < "${MENU_COLOR_FILE}" 2>/dev/null || true)"
  fi
  case "${forced}" in
    truecolor|256|16|none) printf '%s' "${forced}" ;;
    *) ui_color_mode_auto ;;
  esac
}

# Level kubus xterm-256 (0,95,135,175,215,255) terdekat untuk satu kanal.
ui_cube_level() {
  local v="$1"
  if (( v < 48 )); then UI_L=0; elif (( v < 115 )); then UI_L=1; else UI_L=$(( (v - 35) / 40 )); fi
}

ui_nearest16() {
  local r="$1" g="$2" b="$3" i d dr dg db best=0 bestd=-1
  for ((i=0; i<${#UI_16_CODE[@]}; i++)); do
    dr=$(( r - UI_16_R[i] )); dg=$(( g - UI_16_G[i] )); db=$(( b - UI_16_B[i] ))
    d=$(( dr * dr + dg * dg + db * db ))
    if (( bestd < 0 || d < bestd )); then bestd="${d}"; best="${i}"; fi
  done
  UI_N16="${UI_16_CODE[best]}"
}

# ui_color_to NAMA_VAR r g b [38=teks|48=latar]
ui_color_to() {
  local __var="$1" r="$2" g="$3" b="$4" layer="${5:-38}" lr lg lb
  case "${UI_MODE}" in
    truecolor) printf -v "${__var}" '\033[%d;2;%d;%d;%dm' "${layer}" "${r}" "${g}" "${b}" ;;
    256)
      ui_cube_level "${r}"; lr="${UI_L}"
      ui_cube_level "${g}"; lg="${UI_L}"
      ui_cube_level "${b}"; lb="${UI_L}"
      printf -v "${__var}" '\033[%d;5;%dm' "${layer}" "$(( 16 + 36 * lr + 6 * lg + lb ))" ;;
    16)
      ui_nearest16 "${r}" "${g}" "${b}"
      if [[ "${layer}" == "48" ]]; then
        printf -v "${__var}" '\033[%dm' "$(( UI_N16 + 10 ))"
      else
        printf -v "${__var}" '\033[%dm' "${UI_N16}"
      fi ;;
    *) printf -v "${__var}" '%s' '' ;;
  esac
}

# Warna gradasi pada posisi 0..1000 -> UI_R UI_G UI_B.
ui_grad_rgb() {
  local pos="$1" nseg seg f
  nseg=$(( ${#UI_SR[@]} - 1 ))
  seg=$(( pos * nseg / 1000 ))
  if (( seg >= nseg )); then seg=$(( nseg - 1 )); fi
  f=$(( pos * nseg - seg * 1000 ))
  UI_R=$(( UI_SR[seg] + (UI_SR[seg + 1] - UI_SR[seg]) * f / 1000 ))
  UI_G=$(( UI_SG[seg] + (UI_SG[seg + 1] - UI_SG[seg]) * f / 1000 ))
  UI_B=$(( UI_SB[seg] + (UI_SB[seg + 1] - UI_SB[seg]) * f / 1000 ))
}

ui_init() {
  UI_MODE="$(ui_color_mode)"
  if [[ "${UI_MODE}" == "none" ]]; then
    UI_NC=""; UI_BOLD=""
  else
    UI_NC=$'\033[0m'; UI_BOLD=$'\033[1m'
  fi
  ui_color_to UI_LABEL 128 146 178
  ui_color_to UI_VAL 236 242 255
  ui_color_to UI_MUTED 88 100 128
  ui_color_to UI_OK 0 230 118
  ui_color_to UI_WARN 255 196 0
  ui_color_to UI_BAD 255 82 82
  ui_color_to UI_ACC 0 229 255
  ui_color_to UI_ACC2 190 110 255
  ui_color_to UI_INK 12 14 32
  # Di mode 16 warna, teks gelap di atas latar gradasi cukup hitam biasa.
  if [[ "${UI_MODE}" == "16" ]]; then UI_INK=$'\033[30m'; fi
  UI_GRAD_KEY=""
  return 0
}

# Siapkan gradasi untuk kotak selebar bw kolom (termasuk kedua bingkai).
ui_prepare() {
  local bw="$1" i pos key
  if (( bw < 12 )); then bw=12; fi
  if [[ -z "${UI_MODE}" ]]; then ui_init; fi
  UI_BW="${bw}"
  UI_IW=$(( bw - 2 ))
  key="${UI_MODE}:${bw}"
  if [[ "${UI_GRAD_KEY}" == "${key}" ]]; then return 0; fi
  UI_GRAD=(); UI_GRAD_BG=()
  for ((i=0; i<bw; i++)); do
    pos=$(( i * 1000 / (bw - 1) ))
    ui_grad_rgb "${pos}"
    ui_color_to "UI_GRAD[${i}]" "${UI_R}" "${UI_G}" "${UI_B}"
    ui_color_to "UI_GRAD_BG[${i}]" "${UI_R}" "${UI_G}" "${UI_B}" 48
  done
  UI_GRAD_KEY="${key}"
  return 0
}

# Lebar kotak mengikuti terminal: 3 kolom menu di layar lebar, 2 di HP.
ui_layout() {
  local cols="${MENU_COLS:-}"
  # stty membaca /dev/tty langsung, jadi tetap benar saat output sedang
  # dilewatkan ke filter atau ditangkap; tput cols gagal di kondisi itu.
  if [[ ! "${cols}" =~ ^[0-9]+$ ]]; then ui_tty_size; cols="${UI_TTY_COLS}"; fi
  if [[ ! "${cols}" =~ ^[0-9]+$ || "${cols}" -lt 30 ]]; then cols="$(tput cols 2>/dev/null || true)"; fi
  if [[ ! "${cols}" =~ ^[0-9]+$ || "${cols}" -lt 30 ]]; then cols=62; fi
  cols=$(( cols - 2 ))
  if (( cols > 78 )); then cols=78; fi
  if (( cols < 40 )); then cols=40; fi
  ui_prepare "${cols}"
}

# Lebar tampak: kode warna dibuang, byte lanjutan UTF-8 tidak dihitung.
# Tidak bergantung locale VPS (sering POSIX) dan tanpa subshell.
ui_width() {
  local LC_ALL=C s="$1" re=$'\033''\[[0-9;]*m' cont
  while [[ "${s}" =~ ${re} ]]; do s="${s//"${BASH_REMATCH[0]}"/}"; done
  cont="${s//[^$'\x80'-$'\xbf']/}"
  UI_W=$(( ${#s} - ${#cont} ))
}

# Teks bebas (OS, ISP, kota, nama klien) dibatasi ASCII tercetak supaya lebar
# dan pemotongan selalu tepat, lalu dipotong ke max kolom.
ui_fit() {
  local LC_ALL=C s="$1" max="$2"
  s="${s//[^[:print:]]/}"
  if (( ${#s} > max )); then
    if (( max > 2 )); then s="${s:0:max-2}.."; else s="${s:0:max}"; fi
  fi
  UI_OUT="${s}"
}

ui_pad() {
  local n="$1"
  if (( n < 0 )); then n=0; fi
  printf -v UI_TMP '%*s' "${n}" ''
}

# Garis bingkai: kiri kanan [judul] [center]
ui_line() {
  local left="$1" right="$2" title="${3:-}" align="${4:-left}" out col=1 i seg start
  out=" ${UI_GRAD[0]}${left}"
  if [[ -n "${title}" ]]; then
    seg="[ ${title} ]"
    if (( ${#seg} > UI_BW - 4 )); then seg=""; fi
  else
    seg=""
  fi
  start=2
  if [[ -n "${seg}" && "${align}" == "center" ]]; then start=$(( (UI_BW - ${#seg}) / 2 )); fi
  while (( col < UI_BW - 1 )); do
    if [[ -n "${seg}" ]] && (( col == start )); then
      for ((i=0; i<${#seg}; i++)); do
        out+="${UI_GRAD[col]}${UI_BOLD}${seg:i:1}${UI_NC}"
        col=$(( col + 1 ))
      done
      continue
    fi
    out+="${UI_GRAD[col]}─"
    col=$(( col + 1 ))
  done
  out+="${UI_GRAD[UI_BW - 1]}${right}${UI_NC}"
  printf '%s\n' "${out}"
  UI_ROWS=$(( UI_ROWS + 1 ))
}
ui_line_top() { ui_line '╭' '╮' "${1:-}" "${2:-left}"; }
ui_line_sep() { ui_line '├' '┤' "${1:-}" "${2:-left}"; }
ui_line_bot() { ui_line '╰' '╯'; }

ui_row() {
  local content="$1" line
  ui_width "${content}"
  ui_pad "$(( UI_IW - 2 - UI_W ))"
  printf -v line ' %s│%s %s%s %s│%s' "${UI_GRAD[0]}" "${UI_NC}" "${content}" "${UI_TMP}" "${UI_GRAD[UI_BW - 1]}" "${UI_NC}"
  if [[ "${UI_ROW_SINK:-}" == "buf" ]]; then
    UI_BUF+="${line}"
    return 0
  fi
  printf '%s\n' "${line}"
  UI_ROWS=$(( UI_ROWS + 1 ))
}

ui_center() {
  local content="$1" left right
  ui_width "${content}"
  left=$(( (UI_IW - 2 - UI_W) / 2 ))
  if (( left < 0 )); then left=0; fi
  right=$(( UI_IW - 2 - UI_W - left ))
  if (( right < 0 )); then right=0; fi
  printf ' %s│%s %*s%s%*s %s│%s\n' "${UI_GRAD[0]}" "${UI_NC}" "${left}" '' "${content}" "${right}" '' "${UI_GRAD[UI_BW - 1]}" "${UI_NC}"
  UI_ROWS=$(( UI_ROWS + 1 ))
}

# Teks ASCII diwarnai mengikuti gradasi mulai kolom start -> UI_OUT.
ui_gtext() {
  local text="$1" start="${2:-0}" i col out=""
  for ((i=0; i<${#text}; i++)); do
    col=$(( start + i ))
    if (( col > UI_BW - 1 )); then col=$(( UI_BW - 1 )); fi
    out+="${UI_GRAD[col]}${text:i:1}"
  done
  UI_OUT="${out}${UI_NC}"
}

# Banner judul: latar gradasi penuh dengan tepi setengah blok atas-bawah.
ui_banner() {
  local text=" $1 " out col start len ch top="" bottom=""
  len=${#text}
  start=$(( (UI_BW - len) / 2 ))
  if (( start < 0 )); then start=0; fi
  out=" "
  for ((col=0; col<UI_BW; col++)); do
    ch=" "
    if [[ "${UI_MODE}" == "none" ]]; then ch="="; fi
    if (( col >= start && col < start + len )); then ch="${text:col-start:1}"; fi
    out+="${UI_GRAD_BG[col]}${UI_INK}${UI_BOLD}${ch}"
    top+="${UI_GRAD[col]}▄"
    bottom+="${UI_GRAD[col]}▀"
  done
  if [[ "${UI_MODE}" != "none" ]]; then printf ' %s%s\n' "${top}" "${UI_NC}"; UI_ROWS=$(( UI_ROWS + 1 )); fi
  printf '%s%s\n' "${out}" "${UI_NC}"
  UI_ROWS=$(( UI_ROWS + 1 ))
  if [[ "${UI_MODE}" != "none" ]]; then printf ' %s%s\n' "${bottom}" "${UI_NC}"; UI_ROWS=$(( UI_ROWS + 1 )); fi
}

# Bar pemakaian: hijau -> kuning -> merah sepanjang bar -> UI_OUT. Hasilnya
# disimpan per mode/panjang/isi, karena dashboard live menggambar bar yang
# sama berulang kali.
declare -A UI_BAR_CACHE=()
ui_bar() {
  local pct="$1" len="$2" fill i pos r g out="" key
  if [[ ! "${pct}" =~ ^[0-9]+$ ]]; then pct=0; fi
  if (( pct > 100 )); then pct=100; fi
  if (( len < 1 )); then len=1; fi
  fill=$(( (pct * len + 50) / 100 ))
  if (( pct > 0 && fill == 0 )); then fill=1; fi
  key="${UI_MODE}:${len}:${fill}"
  if [[ -n "${UI_BAR_CACHE[${key}]:-}" ]]; then
    UI_OUT="${UI_BAR_CACHE[${key}]}"
    return 0
  fi
  for ((i=0; i<fill; i++)); do
    pos=$(( i * 1000 / (len > 1 ? len - 1 : 1) ))
    if (( pos < 500 )); then r=$(( pos * 255 / 500 )); g=230; else r=255; g=$(( 230 - (pos - 500) * 170 / 500 )); fi
    ui_color_to UI_TMP "${r}" "${g}" 90
    out+="${UI_TMP}█"
  done
  if (( fill < len )); then
    out+="${UI_MUTED}"
    for ((i=fill; i<len; i++)); do out+="░"; done
  fi
  UI_OUT="${out}${UI_NC}"
  UI_BAR_CACHE[${key}]="${UI_OUT}"
}

# Label rata kiri + nilai berwarna. Ruang nilai = UI_IW - 2 - 11.
ui_kv() {
  local label="$1" value="$2" key
  printf -v key '%-8s' "${label}"
  ui_row "${UI_LABEL}${key}${UI_NC} ${UI_ACC}›${UI_NC} ${value}"
}

# Label + teks bebas yang dibersihkan dan dipotong agar muat.
ui_kv_text() {
  ui_fit "$2" "$(( UI_IW - 2 - 11 ))"
  ui_kv "$1" "${UI_VAL}${UI_OUT}${UI_NC}"
}

# Label + beberapa potongan info berwarna. Potongan yang tidak muat di layar
# sempit dilewati, jadi info utama tetap tampil dan bingkai tidak jebol.
ui_kv_parts() {
  local label="$1" part value="" used=0 room
  shift
  room=$(( UI_IW - 2 - 11 ))
  for part in "$@"; do
    if [[ -z "${part}" ]]; then continue; fi
    ui_width "${part}"
    if (( used > 0 )); then
      if (( used + 2 + UI_W > room )); then continue; fi
      value+="  "
      used=$(( used + 2 ))
    fi
    value+="${part}"
    used=$(( used + UI_W ))
  done
  ui_kv "${label}" "${value}"
}

# Susun potongan berwarna berjajar dan pindah baris bila penuh.
ui_flow() {
  local gap="$1" item line="" line_w=0
  shift
  for item in "$@"; do
    ui_width "${item}"
    if (( line_w > 0 && line_w + gap + UI_W > UI_IW - 2 )); then
      ui_row "${line}"
      line=""; line_w=0
    fi
    if (( line_w > 0 )); then
      ui_pad "${gap}"
      line+="${UI_TMP}"
      line_w=$(( line_w + gap ))
    fi
    line+="${item}"
    line_w=$(( line_w + UI_W ))
  done
  if (( line_w > 0 )); then ui_row "${line}"; fi
  return 0
}

# Mesin gaya untuk teks biasa (tabel, detail akun, layar setting, pesan):
# isi dan lebar kolom tidak berubah, hanya diwarnai. Header beraksen, garis
# ---- dan ==== jadi garis gradasi, "Label : nilai" dibedakan, status
# AKTIF/LOCK/GAGAL berwarna, pesan gagal merah, peringatan kuning, pesan
# berhasil hijau, catatan dan petunjuk diredupkan. Baris yang sudah berwarna
# dilewatkan. Satu aturan dipakai dua jalur: ui_fx (blok, dengan lookahead
# header tabel) dan echo ke layar (per baris). Hasil di UI_SAY.
#
# Hemat CPU: bash mengompilasi ulang regex di setiap [[ =~ ]], jadi setiap
# aturan dijaga dulu oleh pencocokan glob yang murah dan regex hanya jalan
# kalau kata kuncinya ada. Baris tabel lewat jalur pendek (hanya warna
# status). Ukuran kasar: ±0,7 ms per baris tabel di mesin uji, jadi daftar
# ratusan akun tidak terasa; jangan tambah aturan regex tanpa penjaga glob.
UI_NOTE=0
UI_SAY=""
UI_TOK=""
UI_KV_LAB=""
UI_WORDS=()
UI_RE_NOTE='^[[:space:]]*(Catatan|Keterangan|Note)'
UI_RE_BANNER='^[[:space:]]*(===+|---+) (.*) (===+|---+)[[:space:]]*$'
UI_RE_BRACKET='^[[:space:]]*\[ .* \][[:space:]]*$'
UI_RE_CAPSTOK='^[[:upper:][:digit:]_/()%+.#&-]+:?$'
UI_RE_KV='^[[:space:]]*(- )?[[:alpha:]][[:alnum:] /()._-]*[[:alnum:])][[:space:]]*: '
UI_RE_ITEM='^([[:space:]]*)([[:digit:]]{1,2}|[xXmMqQ])\)( .*)$'
UI_RE_SECTION='^[[:space:]]*[[:alnum:]][^:]{0,46}:$'
UI_RE_EMPTY='^[[:space:]]*(\(kosong\)|Tidak ada|Belum ada|Data .* tidak ditemukan)'
UI_RE_HINT='^[[:space:]]*(Kosongkan input|Ketik .batal.|Tekan Enter|Enter untuk|Dibatalkan)'
# Pesan diawali "Gagal"/"Peringatan"/"Berhasil" diwarnai utuh, kecuali
# penghitung seperti "Gagal : 0". Pesan lain dikenali dari isinya ("Xray
# gagal restart", "tidak boleh kosong", "belum tersedia", "Akun X berhasil
# dihapus"), tapi bukan pada label rata ("Cooldown gagal    : 15 menit"),
# kalimat petunjuk ("Jika ... gagal", "Pastikan ... berhasil"), atau
# kalimat negatif ("belum berhasil").
UI_RE_MSG_WARN_START='^[[:space:]]*(Peringatan|PERINGATAN|Warning|WARNING)([^[:alpha:]]|$)'
UI_RE_MSG_BAD_START='^[[:space:]]*(Gagal|GAGAL|Error|ERROR)([^[:alpha:]]|$)'
UI_RE_MSG_OK_START='^[[:space:]]*(Berhasil|BERHASIL|Sukses|SUKSES|Selesai)([^[:alpha:]]|$)'
UI_RE_MSG_HINTWORD='^[[:space:]]*(Jika|Kalau|Bila|Apabila|Pastikan|Tunggu|Coba|Setelah|Sebelum)[[:space:]]'
UI_RE_MSG_NEG='(belum|tidak|gagal|akan|bisa) (berhasil|selesai|tersimpan)'
UI_RE_MSG_BAD='tidak valid|harus (angka|[[:digit:]])|tidak boleh|terlalu (panjang|pendek)|hanya boleh|sudah ada di database|tidak ditemukan|ada yang gagal|[[:space:]]invalid([^[:alpha:]]|$)|^[[:space:]]*([^[:space:]]+[[:space:]]+){1,3}(gagal|ditolak)([.,:;!)]|[[:space:]]+[^[:space:]:]|$)'
UI_RE_MSG_WARN='(belum|tidak) (tersedia|terdeteksi|terpasang|terjadwal|valid|aktif)|belum ada|belum berhasil|dilewati'
UI_RE_MSG_OK='^[[:space:]]*([^[:space:]]+[[:space:]]+){1,6}(berhasil|selesai|tersimpan)([^[:alpha:]]|$)'

# Garis: hanya spasi, "-" dan "=", dengan minimal "---" atau "===".
ui_is_rule() {
  [[ "$1" != *[![:space:]=-]* && ( "$1" == *---* || "$1" == *===* ) ]]
}

ui_is_kv() {
  UI_KV_LAB=""
  if [[ "$1" == *": "* && "$1" =~ ${UI_RE_KV} ]] && (( ${#BASH_REMATCH[0]} <= 44 )); then
    UI_KV_LAB="${BASH_REMATCH[0]}"
    return 0
  fi
  return 1
}

# Pecah $1 per spasi ke UI_WORDS tanpa ekspansi nama file. Jauh lebih murah
# daripada memotong string kata demi kata dengan ${var%%pola}.
ui_split_words() {
  local IFS=$' \t\n' keepf=0
  if [[ "$-" == *f* ]]; then keepf=1; fi
  set -f
  UI_WORDS=($1)
  if (( ! keepf )); then set +f; fi
  return 0
}

ui_is_caps_header() {
  local tok caps=0
  if [[ "$1" == *[[:lower:]]* ]]; then return 1; fi
  ui_split_words "$1"
  for tok in ${UI_WORDS[@]+"${UI_WORDS[@]}"}; do
    if [[ ! "${tok}" =~ ${UI_RE_CAPSTOK} ]]; then return 1; fi
    if [[ "${tok}" == *[[:upper:]][[:upper:]]* ]]; then caps=$(( caps + 1 )); fi
  done
  (( caps >= 2 ))
}

# Garis ---- / ==== menjadi ─ bergradasi (kolom demi kolom seperti bingkai).
ui_rule_line() {
  local s="$1" out="" i n c ng="${#UI_GRAD[@]}"
  n="${#s}"
  for ((i=0; i<n; i++)); do
    c="${s:i:1}"
    if [[ "${c}" == "-" || "${c}" == "=" ]]; then
      if (( ng > 0 )); then out+="${UI_GRAD[i < ng ? i : ng - 1]}─"; else out+="─"; fi
    else
      out+="${c}"
    fi
  done
  UI_SAY="${out}${UI_NC}"
}

# Warnai kata status utuh (boleh diakhiri , . ; :), sisanya dibiarkan.
# $2 = warna yang dipasang lagi sesudah kata status (warna nilai). Kata
# diganti di tempat (dibatasi spasi), jadi spasi kolom tabel tidak berubah;
# kata yang sama berulang terganti sekali per kemunculan di UI_WORDS.
ui_paint_tokens() {
  local src="$1" base="${2:-}" s tok core color
  UI_TOK="${src}"
  # Semua kata status minimal dua huruf kapital berurutan.
  if [[ "${src}" != *[[:upper:]][[:upper:]]* ]]; then return 0; fi
  ui_split_words "${src}"
  s=" ${src} "
  for tok in ${UI_WORDS[@]+"${UI_WORDS[@]}"}; do
    core="${tok%[,.;:]}"; color=""
    # Username dan angka dilewati sebelum case yang panjang.
    if [[ -z "${core}" || "${core}" == *[![:upper:]_]* ]]; then continue; fi
    case "${core}" in
      AMAN|ONLINE|AKTIF|ACTIVE|ON|OK|GOOD|SEHAT|SUKSES|BERHASIL|YA|IN_CONFIG|RUNNING) color="${UI_OK}" ;;
      LOCK|LOCK_TMP|LOCK_QUOTA|LOCKED|EXPIRED|OFFLINE|OFF|DELETED|BLOCKED|FAIL|FAILED|GAGAL|ERROR|MATI|STOPPED|TIDAK_TERDETEKSI|DENY|DITOLAK) color="${UI_BAD}" ;;
      RECENT|WAIT|WARN|WARNING|IDLE|PENDING|TRIAL|CHECK|MISMATCH|LEGACY|WATCH|FULL|UNKNOWN) color="${UI_WARN}" ;;
      NONAKTIF|INACTIVE|DISABLED) color="${UI_MUTED}" ;;
    esac
    if [[ -n "${color}" ]]; then
      s="${s/" ${tok} "/" ${color}${core}${UI_NC}${base}${tok:${#core}} "}"
    fi
  done
  s="${s# }"
  UI_TOK="${s% }"
  return 0
}

ui_style_line() {
  local s="$1" lab hintword=0
  UI_SAY="${s}"
  if [[ "${s}" == *$'\033'* ]]; then return 0; fi
  if [[ "${s}" != *[![:space:]]* ]]; then UI_NOTE=0; return 0; fi
  if (( UI_NOTE )); then UI_SAY="${UI_MUTED}${s}${UI_NC}"; return 0; fi
  if [[ ( "${s}" == *Catatan* || "${s}" == *Keterangan* || "${s}" == *Note* ) && "${s}" =~ ${UI_RE_NOTE} ]]; then
    UI_NOTE=1; UI_SAY="${UI_MUTED}${s}${UI_NC}"; return 0
  fi
  if ui_is_rule "${s}"; then ui_rule_line "${s}"; return 0; fi
  if [[ ( "${s}" == *===* || "${s}" == *---* ) && "${s}" =~ ${UI_RE_BANNER} ]]; then
    UI_SAY="${UI_ACC}${UI_BOLD}◆ ${BASH_REMATCH[2]}${UI_NC}"; return 0
  fi
  if [[ "${s}" == *"[ "*" ]"* && "${s}" =~ ${UI_RE_BRACKET} ]] || ui_is_caps_header "${s}"; then
    UI_SAY="${UI_ACC}${UI_BOLD}${s}${UI_NC}"; return 0
  fi
  # Baris tabel (kolom dipisah spasi ganda, bukan "Label : nilai") cukup
  # diwarnai statusnya; aturan pesan di bawah hanya untuk kalimat. Ini jalur
  # utama tabel besar, jadi dibuat sependek mungkin.
  if [[ "${s}" == *[![:space:]]"  "*[![:space:]]* && "${s}" != *": "* ]]; then
    ui_paint_tokens "${s}" ""
    UI_SAY="${UI_TOK}"
    return 0
  fi
  if [[ ( "${s}" == *kosong* || "${s}" == *"Tidak ada"* || "${s}" == *"Belum ada"* || "${s}" == *"tidak ditemukan"* ) && "${s}" =~ ${UI_RE_EMPTY} ]] ||
     [[ ( "${s}" == *Kosongkan* || "${s}" == *batal* || "${s}" == *Enter* || "${s}" == *Dibatalkan* ) && "${s}" =~ ${UI_RE_HINT} ]]; then
    UI_SAY="${UI_MUTED}${s}${UI_NC}"; return 0
  fi
  if [[ ( "${s}" == *Peringatan* || "${s}" == *PERINGATAN* || "${s}" == *Warning* || "${s}" == *WARNING* ) && "${s}" =~ ${UI_RE_MSG_WARN_START} ]]; then
    UI_SAY="${UI_WARN}${s}${UI_NC}"; return 0
  fi
  if [[ "${s}" == *Gagal* || "${s}" == *GAGAL* || "${s}" == *Error* || "${s}" == *ERROR* ]] && [[ "${s}" =~ ${UI_RE_MSG_BAD_START} ]]; then
    if ! ui_is_kv "${s}" || [[ "${s:${#UI_KV_LAB}}" == *[![:space:][:digit:]]* ]]; then
      UI_SAY="${UI_BAD}${s}${UI_NC}"; return 0
    fi
  fi
  if [[ "${s}" == *Berhasil* || "${s}" == *BERHASIL* || "${s}" == *Sukses* || "${s}" == *SUKSES* || "${s}" == *Selesai* ]] && [[ "${s}" =~ ${UI_RE_MSG_OK_START} ]]; then
    if ! ui_is_kv "${s}" || [[ "${s:${#UI_KV_LAB}}" == *[![:space:][:digit:]]* ]]; then
      UI_SAY="${UI_OK}${s}${UI_NC}"; return 0
    fi
  fi
  if [[ ( "${s}" == Jika* || "${s}" == Kalau* || "${s}" == Bila* || "${s}" == Apabila* || "${s}" == Pastikan* || "${s}" == Tunggu* || "${s}" == Coba* || "${s}" == Setelah* || "${s}" == Sebelum* || "${s}" == [[:space:]]* ) && "${s}" =~ ${UI_RE_MSG_HINTWORD} ]]; then
    hintword=1
  fi
  if (( ! hintword )) && [[ "${s}" == *tidak* || "${s}" == *harus* || "${s}" == *terlalu* || "${s}" == *boleh* || "${s}" == *database* || "${s}" == *gagal* || "${s}" == *ditolak* || "${s}" == *invalid* ]] && [[ "${s}" =~ ${UI_RE_MSG_BAD} ]]; then
    UI_SAY="${UI_BAD}${s}${UI_NC}"; return 0
  fi
  if ui_is_kv "${s}"; then
    lab="${UI_KV_LAB}"
    ui_paint_tokens "${s:${#lab}}" "${UI_VAL}"
    UI_SAY="${UI_LABEL}${lab%%:*}${UI_NC}${UI_ACC}:${UI_NC}${lab#*:}${UI_VAL}${UI_TOK}${UI_NC}"
    return 0
  fi
  if (( ! hintword )); then
    if [[ "${s}" == *belum* || "${s}" == *tidak* || "${s}" == *dilewati* ]] && [[ "${s}" =~ ${UI_RE_MSG_WARN} ]]; then
      UI_SAY="${UI_WARN}${s}${UI_NC}"; return 0
    fi
    if [[ "${s}" == *berhasil* || "${s}" == *selesai* || "${s}" == *tersimpan* ]] && [[ "${s}" =~ ${UI_RE_MSG_OK} && ! "${s}" =~ ${UI_RE_MSG_NEG} ]]; then
      # "X tersimpan, tapi Y gagal" = berhasil sebagian.
      if [[ "${s}" == *gagal* ]]; then UI_SAY="${UI_WARN}${s}${UI_NC}"; else UI_SAY="${UI_OK}${s}${UI_NC}"; fi
      return 0
    fi
  fi
  if [[ "${s}" == *")"* && "${s}" =~ ${UI_RE_ITEM} ]]; then
    UI_SAY="${BASH_REMATCH[1]}${UI_ACC}${UI_BOLD}${BASH_REMATCH[2]})${UI_NC}${BASH_REMATCH[3]}"; return 0
  fi
  if [[ "${s}" == *: && "${s}" =~ ${UI_RE_SECTION} ]]; then
    UI_SAY="${UI_ACC}${UI_BOLD}${s}${UI_NC}"; return 0
  fi
  ui_paint_tokens "${s}" ""
  UI_SAY="${UI_TOK}"
  return 0
}

# Filter untuk blok output yang sudah ada (tabel, detail akun, layar info).
# Baris tepat di atas garis dianggap header tabel/judul blok, jadi header
# huruf kecil dari sqlite -column tetap beraksen. Hanya mewarnai kalau
# keluarannya terminal, supaya output yang ditangkap ke variabel atau file
# (misalnya untuk dikirim ke Telegram) tetap polos.
ui_fx() {
  if [[ "${UI_FX_FORCE:-0}" != "1" && ! -t 1 ]]; then cat; return 0; fi
  if [[ -z "${UI_MODE}" ]]; then ui_init; fi
  if [[ "${UI_BW:-0}" -lt 12 ]]; then ui_layout; fi
  local line prev="" have=0
  UI_NOTE=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if ui_is_rule "${line}"; then
      # Kecuali baris kosong atau "Label : nilai" (garis penutup detail akun).
      if (( have )); then
        if [[ "${prev}" != *[![:space:]]* || "${prev}" == *$'\033'* ]] || ui_is_kv "${prev}"; then
          ui_style_line "${prev}"
        else
          UI_SAY="${UI_ACC}${UI_BOLD}${prev}${UI_NC}"
        fi
        printf '%s\n' "${UI_SAY}"
        have=0
      fi
      UI_NOTE=0
      ui_rule_line "${line}"
      printf '%s\n' "${UI_SAY}"
      continue
    fi
    if (( have )); then ui_style_line "${prev}"; printf '%s\n' "${UI_SAY}"; fi
    prev="${line}"; have=1
  done
  if (( have )); then ui_style_line "${prev}"; printf '%s\n' "${UI_SAY}"; fi
  UI_NOTE=0
  return 0
}

# echo ke layar ikut gaya menu, jadi layar setting, pesan berhasil/gagal,
# dan submenu lama seragam tanpa mengubah ratusan baris echo. Hanya berlaku
# kalau keluarannya terminal: echo ke file, pipe, atau $(...) tetap builtin
# polos, jadi data yang dibaca skrip lain tidak tersentuh. Opsi -n/-e/-E
# diteruskan apa adanya, dan tema warna "none" mematikan gayanya.
# UI_SAY_FORCE=1 hanya untuk test (stdout test bukan terminal).
ui_say() {
  local msg part
  printf -v msg '%s ' "$@"
  msg="${msg% }"
  if [[ -z "${UI_MODE:-}" ]]; then ui_init; fi
  if [[ -z "${UI_NC}" ]]; then printf '%s\n' "${msg}"; return 0; fi
  if [[ "${UI_BW:-0}" -lt 12 ]]; then ui_layout; fi
  UI_NOTE=0
  while [[ "${msg}" == *$'\n'* ]]; do
    part="${msg%%$'\n'*}"; msg="${msg#*$'\n'}"
    ui_style_line "${part}"
    printf '%s\n' "${UI_SAY}"
  done
  ui_style_line "${msg}"
  UI_NOTE=0
  printf '%s\n' "${UI_SAY}"
}

# Cek terminal lebih dulu: echo ke file/pipe (pengumpulan data monitor, jalur
# update God Mode) langsung ke builtin tanpa regex, jadi tambahannya hanya
# satu pemanggilan fungsi.
menu_styled_echo_enable() {
  echo() {
    if [[ ! -t 1 && "${UI_SAY_FORCE:-0}" != "1" ]] || (( $# == 0 )); then
      builtin echo "$@"
      return
    fi
    # Opsi echo (-n, -e, -E, -ne, ...) diteruskan apa adanya.
    if [[ "${1}" == -?* && -z "${1//[-neE]/}" && "${1:1}" != *-* ]]; then
      builtin echo "$@"
      return
    fi
    ui_say "$@"
  }
}

# Layar monitor tanpa kedip. Dulu monitor login di-clear lalu seluruh data
# (tracker Xray, ss, journal) dikumpulkan ulang tiap 1 detik, jadi layar
# terlihat loading terus dan VPS kecil terbebani. Sekarang data diambil sekali
# saat dibuka; [r] ambil ulang, [l] live ringan tiap 5 detik, [q]/Enter kembali.
# Saat menggambar ulang, data dikumpulkan dulu lalu layar ditimpa dari atas.
UI_MONITOR_LIVE_SECONDS=5
ui_tty_size() {
  local size=""
  size="$(stty size </dev/tty 2>/dev/null || true)"
  if [[ "${size}" =~ ^([0-9]+)\ ([0-9]+)$ ]]; then
    UI_TTY_ROWS="${BASH_REMATCH[1]}"; UI_TTY_COLS="${BASH_REMATCH[2]}"
  else
    UI_TTY_ROWS=0; UI_TTY_COLS=0
  fi
}

ui_monitor() {
  local key="" live=0 frame footer stamp line lines cols_before="${MENU_COLS:-}"
  ui_tty_size
  if (( UI_TTY_COLS > 0 )); then MENU_COLS="${UI_TTY_COLS}"; fi
  ui_layout
  clear
  while true; do
    frame="$(UI_FX_FORCE=1 "$@" 2>&1 | UI_FX_FORCE=1 ui_fx || true)"
    stamp="$(date '+%H:%M:%S' 2>/dev/null || true)"
    if (( live )); then
      footer=" ${UI_OK}●${UI_NC} ${UI_VAL}LIVE${UI_NC} ${UI_MUTED}tiap ${UI_MONITOR_LIVE_SECONDS} detik · ${stamp}${UI_NC}   ${UI_ACC}[l]${UI_NC} jeda   ${UI_ACC}[r]${UI_NC} ambil ulang   ${UI_ACC}[q]${UI_NC} kembali"
    else
      footer=" ${UI_ACC2}◆${UI_NC} ${UI_VAL}Data ${stamp}${UI_NC}   ${UI_ACC}[r]${UI_NC} ambil ulang   ${UI_ACC}[l]${UI_NC} live ${UI_MONITOR_LIVE_SECONDS} detik   ${UI_ACC}[q]${UI_NC} kembali"
    fi
    ui_tty_size
    lines="$(printf '%s\n' "${frame}" | wc -l)"
    if (( UI_TTY_ROWS > 0 && lines + 2 <= UI_TTY_ROWS )); then
      printf '\033[H'
      while IFS= read -r line; do printf '%s\033[K\n' "${line}"; done <<< "${frame}"
      printf '\033[K\n%s\033[K\n\033[J' "${footer}"
    else
      clear
      printf '%s\n\n%s\n' "${frame}" "${footer}"
    fi
    key=""
    if (( live )); then
      if ! read -r -s -n 1 -t "${UI_MONITOR_LIVE_SECONDS}" key </dev/tty; then key="__tick__"; fi
    else
      read -r -s -n 1 key </dev/tty || key="q"
    fi
    case "${key}" in
      q|Q|''|$'\033') break ;;
      l|L) live=$(( 1 - live )) ;;
      *) ;;
    esac
  done
  MENU_COLS="${cols_before}"
  clear
  return 0
}

menu_hline() {
  local char="${1:--}" count="${2:-58}" i
  for ((i=0; i<count; i++)); do printf '%s' "$char"; done
}

menu_visible_len() {
  ui_width "${1}"
  echo "${UI_W}"
}

menu_pad_right() {
  local text="$1" width="$2" vlen pad
  vlen="$(menu_visible_len "${text}")"
  pad=$((width - vlen))
  (( pad < 0 )) && pad=0
  printf '%s%*s' "${text}" "${pad}" ""
}

menu_print_line() {
  local text="$1" width="${2:-58}" padded
  ui_prepare "$(( width + 2 ))"
  padded="$(menu_pad_right "${text}" "${width}")"
  printf ' %s│%s%s%s│%s\n' "${UI_GRAD[0]}" "${UI_NC}" "${padded}" "${UI_GRAD[UI_BW - 1]}" "${UI_NC}"
}

# Judul submenu: kotak tertutup dengan judul bergradasi. Isi submenu dicetak
# pemanggil di bawahnya tanpa bingkai.
draw_menu_header() {
  local title="$1" width="${2:-}"
  if [[ -z "${width}" ]]; then ui_layout; width=$(( UI_BW - 2 )); if (( width > 58 )); then width=58; fi; fi
  ui_width "  ${title}"
  if (( UI_W > width )); then width="${UI_W}"; fi
  ui_prepare "$(( width + 2 ))"
  ui_line_top
  ui_gtext "${title}" 3
  menu_print_line "  ${UI_BOLD}${UI_OUT}" "${width}"
  ui_line_bot
}

# Nomor pilihan ("1)", "0)", "a)") diberi warna aksen supaya mudah dipindai.
menu_panel_item() {
  local item="$1" re='^([0-9]+|[a-zA-Z])\)(.*)$'
  if [[ "${item}" =~ ${re} ]]; then
    UI_OUT="${UI_ACC}${UI_BOLD}${BASH_REMATCH[1]})${UI_NC}${BASH_REMATCH[2]}"
  else
    UI_OUT="${item}"
  fi
}

# Lebar dasar 58 (seperti dulu), menyempit di layar HP, dan tetap melebar
# mengikuti item terpanjang supaya teks tidak terpotong.
draw_menu_panel() {
  local title="$1" width item
  shift || true
  ui_layout
  width=$(( UI_BW - 2 ))
  if (( width > 58 )); then width=58; fi
  ui_width "    ${title}"
  if (( UI_W > width )); then width="${UI_W}"; fi
  for item in "$@"; do
    ui_width "  ${item}"
    if (( UI_W > width )); then width="${UI_W}"; fi
  done
  ui_prepare "$(( width + 2 ))"
  ui_line_top "${title}"
  for item in "$@"; do
    menu_panel_item "${item}"
    menu_print_line "  ${UI_OUT}" "${width}"
  done
  ui_line_bot
}

draw_main_options() {
  local -a items=(
    "01|MENU AKUN" "02|SERVICE MENU" "03|BACKUP/RESTORE"
    "04|CHANGE DOMAIN" "05|MONITOR USER LOCK" "06|MONITOR USER LOGIN"
    "07|TOOLS MENU" "08|ON/OFF LAYANAN" " M|MENU UTAMA" " X|EXIT"
  )
  local colw=24 per rows r c idx key label key_color line cell
  ui_layout
  per=$(( (UI_IW - 2) / colw ))
  if (( per > 3 )); then per=3; fi
  if (( per < 1 )); then per=1; fi
  rows=$(( (${#items[@]} + per - 1) / per ))
  ui_line_top "MAIN MENU" center
  for ((r=0; r<rows; r++)); do
    line=""
    for ((c=0; c<per; c++)); do
      idx=$(( c * rows + r ))
      if (( idx >= ${#items[@]} )); then continue; fi
      key="${items[idx]%%|*}"
      label="${items[idx]#*|}"
      case "${key}" in
        " M") key_color="${UI_WARN}" ;;
        " X") key_color="${UI_BAD}" ;;
        *) key_color="${UI_ACC}" ;;
      esac
      cell="${UI_MUTED}[${UI_NC}${key_color}${UI_BOLD}${key}${UI_NC}${UI_MUTED}]${UI_NC} ${UI_VAL}${label}${UI_NC}"
      if (( c < per - 1 )); then
        ui_pad "$(( colw - 5 - ${#label} ))"
        cell+="${UI_TMP}"
      fi
      line+="${cell}"
    done
    ui_row "${line}"
  done
  ui_line_bot
}

menu_styled_echo_enable

if [[ "${1:-}" == "update" ]]; then
  clear >/dev/null 2>&1 || true
  UPDATE_SAFE_MODE="${UPDATE_SAFE_MODE:-1}" update_script_locked
  exit $?
fi

if [[ "${1:-}" == "rollback" ]]; then
  [[ -x /usr/local/sbin/sc-1forcr-update-manager ]] || {
    echo "Update manager belum tersedia."
    exit 1
  }
  /usr/local/sbin/sc-1forcr-update-manager rollback "${2:-latest}"
  exit $?
fi

if [[ "${1:-}" == "update-summary" || "${1:-}" == "summary-update" ]]; then
  clear >/dev/null 2>&1 || true
  install_summary_api_1forcr
  exit $?
fi

if [[ "${1:-}" == "apply-api-docs" || "${1:-}" == "api-docs-apply" ]]; then
  apply_api_docs_site
  exit $?
fi

while true; do
  normalize_pending_operation
  if has_pending_install_only; then
    pending_install_gate_menu
    continue
  else
    resume_pending_operation_prompt
  fi
  if ! enforce_menu_license_access; then
    echo
    echo "Status lisensi belum aktif. Tekan Enter untuk cek ulang atau ketik x untuk keluar."
    if [[ -z "${UI_MODE:-}" ]]; then ui_init; fi
    read -r -p " ${UI_ACC2}◆${UI_NC} ${UI_ACC}›${UI_NC} " _sc_expired_choice || true
    [[ "${_sc_expired_choice:-}" =~ ^[xX]$ ]] && exit 0
    SHOW_FULL_MENU=1
    continue
  fi
  clear
  UI_ROWS=0
  D_ROW_CPU=0
  if [[ "${SHOW_FULL_MENU}" == "1" ]]; then
    draw_dashboard
    echo
    UI_ROWS=$(( UI_ROWS + 1 ))
  fi

  draw_main_options
  echo
  UI_ROWS=$(( UI_ROWS + 1 ))
  printf -v menu_prompt ' %s◆%s %sSelect From Options%s %s[1-8, m, x]%s %s›%s ' \
    "${UI_ACC2}" "${UI_NC}" "${UI_VAL}" "${UI_NC}" "${UI_MUTED}" "${UI_NC}" "${UI_ACC}" "${UI_NC}"
  menu_rc=0
  if [[ "${SHOW_FULL_MENU}" == "1" ]] && dashboard_live_allowed; then
    menu_read_choice_live m "${menu_prompt}" || menu_rc=$?
  else
    prompt_input m "${menu_prompt}" || menu_rc=$?
  fi
  if (( menu_rc != 0 )); then
    SHOW_FULL_MENU=0
    continue
  fi
  # Menu menampilkan nomor dua digit ([01]..[08]); keduanya diterima.
  m="${m//[[:space:]]/}"
  if [[ "${m}" =~ ^0[1-8]$ ]]; then m="${m#0}"; fi
  clear
  case "$m" in
    1) akun_menu || true ;;
    2) service_menu || true ;;
    3) backup_restore_menu || true ;;
    4) change_domain_menu || true ;;
    5) ui_monitor monitor_temp_lock_menu || true; SHOW_FULL_MENU=0; continue ;;
    6) monitor_online_menu || true ;;
    7) tools_menu || true ;;
    8) service_toggle_menu || true ;;
    m|M)
      SHOW_FULL_MENU=1
      continue
      ;;
    x|X) exit 0 ;;
    *) echo "Pilihan tidak valid." ;;
  esac
  SHOW_FULL_MENU=0
  echo
  menu_pause
done

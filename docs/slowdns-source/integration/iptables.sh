#!/usr/bin/env bash
# Helper contoh untuk integrator SC berbasis iptables. Jalankan sebagai root.
set -euo pipefail

die() { printf 'Gagal: %s\n' "$*" >&2; exit 1; }
(( EUID == 0 )) || die 'helper firewall memerlukan root'
config="${DNSTT_ENV_FILE:-/etc/dnstt-portable/server.env}"
[[ -r "${config}" ]] || die "konfigurasi tidak terbaca: ${config}"
# File ini harus dimiliki root dan hanya berisi konfigurasi milik administrator.
# shellcheck disable=SC1090
source "${config}"
port="${DNS_UDP_PORT:-5300}"
[[ "${port}" =~ ^[0-9]{1,5}$ ]] || die 'DNS_UDP_PORT tidak valid'
port="$((10#${port}))"
(( port >= 1 && port <= 65535 && port != 53 )) || die 'port internal harus 1-65535 dan berbeda dari 53'
action="${1:-apply}"
[[ "${action}" == apply || "${action}" == remove ]] || die 'gunakan apply atau remove'
[[ "${DNS_ENABLE_IPV6:-0}" == 0 || "${DNS_ENABLE_IPV6:-0}" == 1 ]] || die 'DNS_ENABLE_IPV6 harus 0 atau 1'

# Hanya menghapus spesifikasi rule milik helper ini, maksimum 32 duplikat.
remove_rule() {
  local tool="$1" table="$2" chain="$3" i
  shift 3
  for ((i=0; i<32; i++)); do
    if "${tool}" -w 5 -t "${table}" -C "${chain}" "$@" 2>/dev/null; then
      "${tool}" -w 5 -t "${table}" -D "${chain}" "$@"
    else
      return 0
    fi
  done
  if "${tool}" -w 5 -t "${table}" -C "${chain}" "$@" 2>/dev/null; then
    die 'lebih dari 32 duplikat; hentikan dan periksa konfigurasi firewall'
  fi
}

ensure_first() {
  local tool="$1" table="$2" chain="$3" line first='' expected
  shift 3
  while IFS= read -r line; do
    if [[ "${line}" == '-A '* ]]; then first="${line//\"/}"; break; fi
  done <<< "$("${tool}" -w 5 -t "${table}" -S "${chain}")"
  expected="-A ${chain} $*"
  if [[ "${first}" == "${expected}" ]] &&
      "${tool}" -w 5 -t "${table}" -C "${chain}" "$@" 2>/dev/null; then
    return 0
  fi
  remove_rule "${tool}" "${table}" "${chain}" "$@"
  "${tool}" -w 5 -t "${table}" -I "${chain}" 1 "$@"
}

apply_family() {
  local tool="$1" op=ensure_first
  command -v "${tool}" >/dev/null 2>&1 || die "${tool} tidak tersedia"
  "${tool}" -w 5 -t nat -S PREROUTING >/dev/null
  [[ "${action}" == remove ]] && op=remove_rule
  "${op}" "${tool}" nat PREROUTING -p udp -m udp --dport 53 \
    -m addrtype --dst-type LOCAL -m comment --comment dnstt-portable \
    -j REDIRECT --to-ports "${port}"
  "${op}" "${tool}" filter INPUT -p udp -m udp --dport "${port}" \
    -m comment --comment dnstt-portable -j ACCEPT
  "${op}" "${tool}" filter OUTPUT -p udp -m udp --sport "${port}" \
    -m comment --comment dnstt-portable -j ACCEPT
}

apply_family iptables
if [[ "${DNS_ENABLE_IPV6:-0}" == 1 ]]; then apply_family ip6tables; fi
printf 'Berhasil: firewall SlowDNS %s untuk UDP 53 -> %s.\n' "${action}" "${port}"

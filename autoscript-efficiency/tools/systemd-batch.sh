# Helpers for one setup function at a time. The caller declares these locals:
# SC_UNIT_CHANGED=0 SC_MANAGER_STALE=0; arrays SC_WRITTEN_UNITS SC_CHANGED_UNITS.
# Do not export: independent child scripts keep their own systemd lifecycle.
sc_write_unit_if_changed() {
  local dest="$1" tmp unit="${1##*/}"
  SC_WRITTEN_UNITS+=("${unit}")
  if [[ -L "${dest}" ]]; then
    echo "Refusing to replace symlink unit: ${dest}" >&2
    return 1
  fi
  tmp="$(mktemp "${dest}.XXXXXX")" || return 1
  if ! cat > "${tmp}"; then rm -f "${tmp}"; return 1; fi
  if [[ -f "${dest}" ]] && cmp -s "${tmp}" "${dest}"; then
    rm -f "${tmp}"
    return 0
  fi
  if ! chmod 644 "${tmp}" || ! mv -f "${tmp}" "${dest}"; then
    rm -f "${tmp}"
    return 1
  fi
  SC_UNIT_CHANGED=1
  SC_CHANGED_UNITS+=("${unit}")
}

sc_set_unit_enabled() {
  local unit="$1" desired="$2" state
  state="$(systemctl is-enabled "${unit}" 2>/dev/null)" || true
  if [[ "${desired}" == 1 ]]; then
    if [[ "${state}" != enabled ]]; then
      systemctl enable --no-reload "${unit}" || return 1
      SC_UNIT_CHANGED=1
    fi
  else
    case "${state}" in
      disabled|masked|not-found|'') return 0 ;;
    esac
    systemctl disable --no-reload "${unit}" || return 1
    SC_UNIT_CHANGED=1
  fi
}

sc_reload_changed_units() {
  local status
  # Detect a previous interrupted write, including a new unit not yet loaded.
  if (( SC_UNIT_CHANGED == 0 && ${#SC_WRITTEN_UNITS[@]} > 0 )); then
    if ! status="$(systemctl show --property=LoadState --property=NeedDaemonReload "${SC_WRITTEN_UNITS[@]}" 2>/dev/null)" ||
       [[ "${status}" == *NeedDaemonReload=yes* || "${status}" == *LoadState=not-found* ]]; then
      SC_MANAGER_STALE=1
    fi
  fi
  if (( SC_UNIT_CHANGED || SC_MANAGER_STALE )); then
    systemctl daemon-reload || return 1
    SC_UNIT_CHANGED=0
  fi
}

sc_start_timer_if_changed() {
  local timer="$1" unit
  for unit in "${SC_CHANGED_UNITS[@]}"; do
    if [[ "${unit}" == "${timer}" ]]; then
      systemctl restart "${timer}"
      return $?
    fi
  done
  if (( SC_MANAGER_STALE )); then
    systemctl restart "${timer}"
  else
    # start is a no-op for an already active timer: its deadline is preserved.
    systemctl start "${timer}"
  fi
}

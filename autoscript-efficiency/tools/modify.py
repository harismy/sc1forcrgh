from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / 'original/setup-autoscript-compat.sh').read_text()

def once(text, old, new):
    assert text.count(old) == 1, (old[:100], text.count(old))
    return text.replace(old, new, 1)

def edit_function(name, next_name, edit):
    global source
    start = source.index(name + '() {\n')
    end = source.index(next_name + '() {\n', start)
    source = source[:start] + edit(source[start:end]) + source[end:]

locals_ = ('  local SC_UNIT_CHANGED=0 SC_MANAGER_STALE=0\n'
           '  local -a SC_WRITTEN_UNITS=() SC_CHANGED_UNITS=()\n')

def unit_writes(block):
    block = block.replace('() {\n', '() {\n' + locals_, 1)
    return re.sub(r'  cat > (/etc/systemd/system/[^\s]+) (<<[^\n]+)',
                  r'  sc_write_unit_if_changed \1 \2 || return 1', block)

def auto_pull(block):
    block = unit_writes(block)
    start = block.index('  systemctl daemon-reload', block.index('god_interval="'))
    block = block[:start] + '''  # Batch enablement and unit writes before a single reload. Preserve timer
  # deadlines on an unchanged update; restart only changed timer definitions.
  sc_set_unit_enabled sc-1forcr-god-update.timer 1 || return 1
  sc_set_unit_enabled sc-1forcr-pull-update.timer "${AUTO_PULL_UPDATE_ENABLE}" || return 1
  sc_set_unit_enabled sc-1forcr-pull-summary-update.timer "${AUTO_PULL_UPDATE_ENABLE}" || return 1
  sc_reload_changed_units || return 1
  sc_start_timer_if_changed sc-1forcr-god-update.timer || return 1
  if [[ "${AUTO_PULL_UPDATE_ENABLE}" == "1" ]]; then
    sc_start_timer_if_changed sc-1forcr-pull-update.timer || return 1
    sc_start_timer_if_changed sc-1forcr-pull-summary-update.timer || return 1
  else
    systemctl stop sc-1forcr-pull-update.timer sc-1forcr-pull-summary-update.timer || return 1
  fi
}

'''
    return block

def notify(block):
    block = unit_writes(block)
    old = '''  systemctl daemon-reload
  if [[ "${ONLINE_NOTIFY_ENABLE}" == "1" ]]; then
    systemctl enable --now sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
    systemctl start sc-1forcr-online-notify.service >/dev/null 2>&1 || true
  else
    systemctl disable --now sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
  fi
'''
    new = '''  sc_set_unit_enabled sc-1forcr-online-notify.timer "${ONLINE_NOTIFY_ENABLE}" || return 1
  sc_reload_changed_units || return 1
  if [[ "${ONLINE_NOTIFY_ENABLE}" == "1" ]]; then
    sc_start_timer_if_changed sc-1forcr-online-notify.timer || return 1
    systemctl start sc-1forcr-online-notify.service >/dev/null 2>&1 || true
  else
    systemctl stop sc-1forcr-online-notify.timer >/dev/null 2>&1 || true
  fi
'''
    return once(block, old, new)

def dns_guard(block):
    block = unit_writes(block)
    # Disabled branch retains native systemctl semantics, including absent units.
    return once(block, '''  systemctl daemon-reload
  systemctl enable --now sc-1forcr-dns-guard.timer >/dev/null
''', '''  sc_set_unit_enabled sc-1forcr-dns-guard.timer 1 || return 1
  sc_reload_changed_units || return 1
  sc_start_timer_if_changed sc-1forcr-dns-guard.timer || return 1
''')

def postboot(block):
    block = unit_writes(block)
    block = once(block, '''  systemctl daemon-reload >/dev/null
  systemctl enable --now sc-1forcr-postboot-health.timer >/dev/null
  systemctl restart sc-1forcr-postboot-health.timer >/dev/null
''', '''  sc_set_unit_enabled sc-1forcr-postboot-health.timer 1 || return 1
  sc_reload_changed_units || return 1
  sc_start_timer_if_changed sc-1forcr-postboot-health.timer || return 1
''')
    old = '''  local port
  for port in "$@"; do
    listener_present "${port}" || return 1
  done
'''
    new = '''  # One fresh snapshot per health attempt, shared by this unit's ports.
  # Never reuse it after sleep/restart: recovery must observe current listeners.
  local port listeners
  (( $# > 0 )) || return 0
  listeners="$(ss -H -lnt 2>/dev/null)" || return 1
  for port in "$@"; do
    listener_present "${port}" "${listeners}" || return 1
  done
'''
    block = once(block, old, new)
    block = once(block, "  ss -H -lnt 2>/dev/null | awk -v want=\"${port}\" '",
                 "  awk -v want=\"${port}\" '")
    block = once(block, "    END { exit(found ? 0 : 1) }\n  '\n}",
                 "    END { exit(found ? 0 : 1) }\n  ' <<< \"$2\"\n}")
    return block

edit_function('setup_auto_pull_update_timer', 'install_xray_realip_manager', auto_pull)
edit_function('setup_online_notify_timer', 'setup_auto_pull_update_timer', notify)
edit_function('setup_postboot_health_guard', 'setup_auto_reboot_timer', postboot)
edit_function('setup_dns_resolver_guard', 'install_optional_pkg_if_available', dns_guard)
source = once(source, 'setup_dns_resolver_guard() {\n',
              '# SC_EFFICIENCY_PATCH=2026-11-07.1\n' +
              (ROOT/'tools/systemd-batch.sh').read_text() + '\nsetup_dns_resolver_guard() {\n')

# The drain runs periodically: collect all local TCP endpoint counts once,
# lazily, and never interpret a failed ss command as an empty connection list.
marker = "  cat > /usr/local/sbin/sc-1forcr-udpgw-drain <<'EOF'\n"
start = source.index(marker) + len(marker)
end = source.index('\nEOF\n', start)
drain = source[start:end]
drain = once(drain, 'for alias_port in "${ports[@]:1}"; do\n', '''declare -A established_by_port=()
snapshot_ready=0
for alias_port in "${ports[@]:1}"; do
''')
begin = drain.index('  if ! systemctl is-active --quiet')
finish = drain.index('  if [[ "${established}" == "0" ]]; then', begin)
drain = drain[:begin] + '''  active_state="$(systemctl show "${unit}" --property=ActiveState --value 2>/dev/null)" || active_state=unknown
  if [[ "${active_state}" != active ]]; then
    if [[ "${active_state}" == failed ]]; then
      systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
    fi
    continue
  fi
  if (( snapshot_ready == 0 )); then
    if ! sockets="$(ss -Htn state established 2>/dev/null)"; then
      logger -t sc-1forcr-udpgw "Drain ditunda: snapshot koneksi gagal; proses aktif dipertahankan." || true
      exit 1
    fi
    while read -r endpoint_port endpoint_count; do
      [[ "${endpoint_port}" =~ ^[0-9]+$ ]] || continue
      established_by_port["${endpoint_port}"]="${endpoint_count}"
    done < <(awk '
      function p(v,   n,a,port) { n=split(v,a,":"); port=a[n]; return (port ~ /^[0-9]+$/ && port+0>=1 && port+0<=65535 ? port : ""); }
      { port=p($3); if (port=="") port=p($4); if (port!="") count[port]++; }
      END {for (port in count) print port, count[port]}
    ' <<< "${sockets}")
    snapshot_ready=1
  fi
  established="${established_by_port[${alias_port}]:-0}"
''' + drain[finish:]
source = source[:start] + drain + source[end:]

# Both the installed CLI and installer have this final update function.
# These four timer definitions are reconciled by setup above; restarting them
# again here would undo the idempotent setup. Other service lifecycle stays put.
def preserve_update_timers(block):
    for unit in ['online-notify', 'pull-update', 'pull-summary-update', 'god-update']:
        block = block.replace(f'systemctl restart sc-1forcr-{unit}.timer',
                              f'systemctl start sc-1forcr-{unit}.timer')
    block = block.replace('systemctl enable --now sc-1forcr-god-update.timer',
        'systemctl is-enabled --quiet sc-1forcr-god-update.timer 2>/dev/null || systemctl enable --now sc-1forcr-god-update.timer')
    return block

pattern = r'restart_update_safe_services\(\) \{\n.*?\n\}\n(?=\nsync_xray_runtime_after_update)'
assert len(re.findall(pattern, source, re.S)) == 2
source = re.sub(pattern, lambda m: preserve_update_timers(m[0]), source, flags=re.S)
shim = "  cat > /usr/local/sbin/restart_update_safe_services <<'EOF'\n"
start = source.index(shim) + len(shim)
end = source.index('\nEOF\n', start)
source = source[:start] + preserve_update_timers(source[start:end]) + source[end:]
(ROOT/'src/setup-autoscript-compat.sh').write_text(source)
print('Updated installer source, four timer setup paths and two runtime collectors.')

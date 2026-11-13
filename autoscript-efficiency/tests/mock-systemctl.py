#!/usr/bin/python3
import hashlib, json, os, sys
from pathlib import Path

root = Path(os.environ['SC_TEST_ROOT'])
args = sys.argv[1:]
with (root/'calls').open('a') as f:
    f.write(json.dumps(args)+'\n')
statefile = root/'systemd.json'
state = json.loads(statefile.read_text()) if statefile.exists() else {'enabled':{}, 'active':{}, 'loaded':{}}
cmd = args[0]
units = [a for a in args[1:] if not a.startswith('-')]
unitdir = root/'etc/systemd/system'

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def reload():
    with (root/'reloads').open('a') as f: f.write('reload\n')
    state['loaded'] = {p.name:digest(p) for p in unitdir.iterdir() if p.is_file()}

def save():
    statefile.write_text(json.dumps(state))

if cmd == 'is-enabled':
    value=state['enabled'].get(units[0], 'disabled')
    print(value)
    sys.exit(0 if value == 'enabled' else 1)
elif cmd in ['enable', 'disable']:
    for u in units: state['enabled'][u] = 'enabled' if cmd=='enable' else 'disabled'
    if '--no-reload' not in args: reload()
    if '--now' in args:
        for u in units: state['active'][u] = 'active' if cmd=='enable' else 'inactive'
elif cmd == 'daemon-reload':
    if os.environ.get('SC_TEST_FAIL_RELOAD') == '1': sys.exit(1)
    reload()
elif cmd == 'show':
    if '--property=ActiveState' in args:
        print(state['active'].get(units[0], 'inactive'))
    else:
        for u in units:
            p=unitdir/u
            print('LoadState='+('loaded' if u in state['loaded'] else 'not-found'))
            print('NeedDaemonReload='+('yes' if p.exists() and state['loaded'].get(u)!=digest(p) else 'no'))
elif cmd in ['start','restart','stop']:
    for u in units: state['active'][u]='inactive' if cmd=='stop' else 'active'
elif cmd == 'reset-failed':
    for u in units:
        if state['active'].get(u)=='failed': state['active'][u]='inactive'
elif cmd == 'is-active':
    sys.exit(0 if state['active'].get(units[0]) == 'active' else 3)
else:
    print('Unexpected systemctl command '+repr(args),file=sys.stderr)
    sys.exit(99)
save()

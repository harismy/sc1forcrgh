#!/usr/bin/env python3
"""Apply the reviewed runtime scripts with version guards and backups.

Default: read-only validation. No installer, service restart, or network call.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile

BASE = Path(__file__).resolve().parent
TARGETS = {
    '/usr/local/sbin/sc-1forcr-udpgw-drain',
    '/usr/local/sbin/sc-1forcr-postboot-health',
    '/usr/local/sbin/restart_update_safe_services',
    '/opt/sc-1forcr/menu-sc-1forcr.sh',
}
LOCKS = ['sc-efficiency-runtime.lock', 'sc-1forcr-god-update.lock',
         'sc-1forcr-pull-update.lock', 'sc-1forcr-update.lock']

def sha(data):
    return hashlib.sha256(data).hexdigest()

def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError(f'Target bukan file reguler: {path}')
    return info

def atomic_write(path, data, info):
    fd, tmp = tempfile.mkstemp(prefix='.'+path.name+'.eff-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)

def payloads(base):
    package = base/'runtime-package'
    manifest = json.loads((package/'manifest.json').read_text())
    if len(manifest) != len(TARGETS) or {m['path'] for m in manifest} != TARGETS:
        raise RuntimeError('Manifest target tidak valid')
    for m in manifest:
        if '/' in m['name'] or m['name'] in ['.', '..']:
            raise RuntimeError('Nama payload tidak valid')
        for side in ['before','after']:
            data=(package/(side+'-'+m['name'])).read_bytes()
            if sha(data) != m[side]:
                raise RuntimeError('Checksum payload tidak cocok: '+m['name'])
            subprocess.run(['bash','-n'],input=data,check=True)
    return manifest

def execute(action, base=BASE, root=Path('/')):
    manifest=payloads(base)
    held=[]
    try:
        if action != 'check':
            if os.geteuid() != 0:
                raise RuntimeError('Jalankan sebagai root di terminal VPS')
            for name in LOCKS:
                lock=open(root/'run'/name, 'a')
                held.append(lock)
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise RuntimeError('Updater/patch sedang berjalan: '+name)
        changes=[]
        for m in manifest:
            path=root/m['path'].lstrip('/')
            info=regular(path)
            data=path.read_bytes()
            current=sha(data)
            if current not in [m['before'],m['after']]:
                raise RuntimeError('Versi file berubah; hentikan agar perubahan lain tidak tertimpa: '+str(path))
            side='before' if action == 'rollback' else 'after'
            if current != m[side]:
                changes.append((m,path,data,info,side))
            print(('PATCHED' if current == m['after'] else 'BASE')+' '+m['path'])
        if action == 'check':
            print(f'CHECK OK: {len(changes)} file siap diperbarui. Belum ada penerapan.')
            return
        if not changes:
            print('Tidak ada perubahan yang perlu diterapkan.')
            return
        backup_root=base/'runtime-backups'
        backup_root.mkdir(mode=0o700,exist_ok=True)
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        backup=backup_root/(stamp+'-'+action)
        backup.mkdir(mode=0o700)
        for m,path,data,info,side in changes:
            saved=backup/m['name']
            saved.write_bytes(data)
            os.chown(saved,info.st_uid,info.st_gid)
            saved.chmod(stat.S_IMODE(info.st_mode))
        record={'action':action,'status':'prepared','files':[m['path'] for m,_,_,_,_ in changes]}
        (backup/'state.json').write_text(json.dumps(record,indent=2)+'\n')
        installed=[]
        try:
            for m,path,data,info,side in changes:
                regular(path)
                if sha(path.read_bytes()) != sha(data):
                    raise RuntimeError('File berubah selama penerapan: '+str(path))
                wanted=(base/'runtime-package'/(side+'-'+m['name'])).read_bytes()
                atomic_write(path,wanted,info)
                installed.append((m,path,data,info,side))
            record['status']='complete'
        except BaseException:
            record['status']='failed'
            for m,path,data,info,side in reversed(installed):
                # Do not overwrite a concurrent edit while recovering.
                if sha(path.read_bytes()) == m[side]:
                    atomic_write(path,data,info)
            raise
        finally:
            (backup/'state.json').write_text(json.dumps(record,indent=2)+'\n')
        print(f'{action.upper()} OK: {len(changes)} file. Cadangan: {backup}')
        print('Skrip timer memakai versi ini pada eksekusi berikutnya; tidak ada restart layanan tunnel.')
    finally:
        for lock in reversed(held):
            lock.close()

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    modes=parser.add_mutually_exclusive_group()
    modes.add_argument('--apply',action='store_true')
    modes.add_argument('--rollback',action='store_true')
    args=parser.parse_args()
    try:
        execute('apply' if args.apply else 'rollback' if args.rollback else 'check')
    except (OSError,RuntimeError,subprocess.CalledProcessError) as exc:
        raise SystemExit('GAGAL: '+str(exc))

import contextlib
import importlib.util
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BASE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('runtime_apply',BASE/'apply-runtime.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)

class RuntimeApply(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='sc-runtime-test-')
        self.base=Path(self.temp.name)/'package';self.base.mkdir()
        shutil.copytree(BASE/'runtime-package',self.base/'runtime-package')
        self.root=Path(self.temp.name)/'host';(self.root/'run').mkdir(parents=True)
        self.manifest=json.loads((self.base/'runtime-package/manifest.json').read_text())
        for m in self.manifest:
            dest=self.root/m['path'].lstrip('/');dest.parent.mkdir(parents=True,exist_ok=True)
            dest.write_bytes((self.base/'runtime-package'/('before-'+m['name'])).read_bytes())
            dest.chmod(0o750)
    def tearDown(self):self.temp.cleanup()
    def run_action(self,action):
        with contextlib.redirect_stdout(io.StringIO()):mod.execute(action,self.base,self.root)
    def assert_version(self,side):
        for m in self.manifest:
            target=self.root/m['path'].lstrip('/')
            self.assertEqual(mod.sha(target.read_bytes()),m[side])
            self.assertEqual(target.stat().st_mode & 0o777,0o750)
    def test_check_has_no_writes(self):
        self.run_action('check');self.assert_version('before')
        self.assertFalse((self.base/'runtime-backups').exists())
        self.assertFalse(list((self.root/'run').iterdir()))
    def test_apply_idempotent_and_rollback(self):
        self.run_action('apply');self.assert_version('after')
        count=len(list((self.base/'runtime-backups').iterdir()))
        self.run_action('apply');self.assertEqual(len(list((self.base/'runtime-backups').iterdir())),count)
        self.run_action('rollback');self.assert_version('before')
    def test_changed_live_file_aborts_before_writes(self):
        m=self.manifest[-1];p=self.root/m['path'].lstrip('/');p.write_bytes(p.read_bytes()+b'\n# external update\n')
        with self.assertRaisesRegex(RuntimeError,'Versi file berubah'):self.run_action('apply')
        for m in self.manifest[:-1]:self.assertEqual(mod.sha((self.root/m['path'].lstrip('/')).read_bytes()),m['before'])
        self.assertFalse((self.base/'runtime-backups').exists())
    def test_corrupt_payload_aborts(self):
        p=self.base/'runtime-package'/('after-'+self.manifest[0]['name']);p.write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'Checksum'):self.run_action('apply')
        self.assert_version('before')
    def test_partial_write_failure_restores_prior_file(self):
        real=mod.atomic_write;calls=0
        def fail_second(*args):
            nonlocal calls
            calls+=1
            if calls==2:raise OSError('simulated disk error')
            return real(*args)
        with patch.object(mod,'atomic_write',side_effect=fail_second):
            with self.assertRaisesRegex(OSError,'simulated disk error'):self.run_action('apply')
        self.assert_version('before')
    def test_active_updater_lock_aborts(self):
        with (self.root/'run/sc-1forcr-update.lock').open('a') as lock:
            mod.fcntl.flock(lock,mod.fcntl.LOCK_EX|mod.fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError,'sedang berjalan'):self.run_action('apply')
        self.assert_version('before')

if __name__=='__main__':unittest.main(verbosity=2)

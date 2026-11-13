import json, os, subprocess, tempfile, unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SRC=(ROOT/'src/setup-autoscript-compat.sh').read_text()
OLD=(ROOT/'original/setup-autoscript-compat.sh').read_text()
HELPERS=(ROOT/'tools/systemd-batch.sh').read_text()
BOUNDS={
 'setup_auto_pull_update_timer':'install_xray_realip_manager',
 'setup_online_notify_timer':'setup_auto_pull_update_timer',
 'setup_dns_resolver_guard':'install_optional_pkg_if_available',
 'setup_postboot_health_guard':'setup_auto_reboot_timer',
}

def function(text,name):
    start=text.index(name+'() {\n')
    return text[start:text.index(BOUNDS[name]+'() {\n',start)]

def embedded(text,name,delimiter):
    marker=f"  cat > /usr/local/sbin/{name} <<'{delimiter}'\n"
    start=text.index(marker)+len(marker)
    return text[start:text.index('\n'+delimiter+'\n',start)]+'\n'

class Efficiency(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='sc-eff-test-')
        self.r=Path(self.tmp.name)
        for p in ['etc/systemd/system','usr/local/sbin','var/lib/systemd/timers','opt/sc-1forcr','bin']:
            (self.r/p).mkdir(parents=True)
        (self.r/'bin/systemctl').symlink_to(ROOT/'tests/mock-systemctl.py')
        ss=self.r/'bin/ss'
        ss.write_text('#!/bin/bash\nprintf "ss\\n" >> "$SC_TEST_ROOT/ss-calls"\n[[ "${SC_TEST_SS_FAIL:-0}" == 1 ]] && exit 1\ncat "$SC_TEST_ROOT/sockets"\n')
        ss.chmod(0o755)
        logger=self.r/'bin/logger'
        logger.write_text('#!/bin/bash\nexit 0\n');logger.chmod(0o755)
        (self.r/'sockets').write_text('')
        self.env={**os.environ,'SC_TEST_ROOT':str(self.r),'PATH':str(self.r/'bin')+':/usr/bin:/bin'}
    def tearDown(self): self.tmp.cleanup()
    def calls(self):
        f=self.r/'calls'
        return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []
    def clear(self):
        for name in ['calls','reloads','ss-calls']:
            (self.r/name).unlink(missing_ok=True)
    def reloads(self):
        p=self.r/'reloads';return len(p.read_text().splitlines()) if p.exists() else 0
    def runbash(self,code,extra=None):
        # Redirect absolute paths in selected functions; never source the installer.
        for prefix in ['/usr/local/sbin','/etc/','/var/lib/','/opt/']:
            code=code.replace(prefix,str(self.r)+prefix)
        return subprocess.run(['bash','-c','set -euo pipefail\n'+code],env={**self.env,**(extra or {})},text=True,capture_output=True)
    def setup(self,name='setup_auto_pull_update_timer',old=False,extra=None):
        code=HELPERS+'\n'+function(OLD if old else SRC,name)+'''
log() { :; }
flag_enabled() { [[ "$1" == 1 ]]; }
write_dns_resolver_guard() { :; }
setup_ssh_live_tracker() { :; }
setup_xray_live_tracker() { :; }
AUTO_PULL_UPDATE_ENABLE="${AUTO_PULL_UPDATE_ENABLE:-1}"
ONLINE_NOTIFY_ENABLE="${ONLINE_NOTIFY_ENABLE:-1}"
DNS_GUARD_INTERVAL_MINUTES=5
'''+name+'\n'
        return self.runbash(code,extra)
    def good(self,result): self.assertEqual(result.returncode,0,result.stderr)
    def test_installer_syntax(self):
        self.good(subprocess.run(['bash','-n',str(ROOT/'src/setup-autoscript-compat.sh')],capture_output=True,text=True))
    def test_first_install_single_reload(self):
        self.good(self.setup());self.assertEqual(self.reloads(),1)
        self.assertEqual(len(list((self.r/'etc/systemd/system').glob('*'))),6)
        self.assertEqual(len([c for c in self.calls() if c[0]=='enable']),3)
        for c in self.calls():
            if c[0]=='enable':self.assertIn('--no-reload',c)
        actions=[c[0] for c in self.calls()]
        self.assertLess(actions.index('daemon-reload'),actions.index('restart'))
    def test_unchanged_update_preserves_files_and_deadlines(self):
        self.good(self.setup())
        before={p.name:p.stat().st_mtime_ns for p in (self.r/'etc/systemd/system').iterdir()}
        self.clear();self.good(self.setup())
        self.assertEqual(self.reloads(),0)
        self.assertFalse(any(c[0] in ['enable','disable','restart'] for c in self.calls()))
        self.assertEqual(before,{p.name:p.stat().st_mtime_ns for p in (self.r/'etc/systemd/system').iterdir()})
    def test_changed_interval_restarts_only_affected_timer(self):
        self.good(self.setup());self.clear()
        self.good(self.setup(extra={'GOD_UPDATE_CHECK_INTERVAL_MINUTES':'9'}))
        self.assertEqual(self.reloads(),1)
        self.assertEqual([c for c in self.calls() if c[0]=='restart'],[['restart','sc-1forcr-god-update.timer']])
    def test_disable_optional_updates_keeps_mandatory(self):
        self.good(self.setup());self.clear()
        self.good(self.setup(extra={'AUTO_PULL_UPDATE_ENABLE':'0'}))
        state=json.loads((self.r/'systemd.json').read_text())
        self.assertEqual(state['active']['sc-1forcr-god-update.timer'],'active')
        for name in ['sc-1forcr-pull-update.timer','sc-1forcr-pull-summary-update.timer']:
            self.assertEqual(state['active'][name],'inactive');self.assertEqual(state['enabled'][name],'disabled')
        self.assertEqual(self.reloads(),1)
    def test_reload_failure_aborts_activation_and_retry_recovers(self):
        result=self.setup(extra={'SC_TEST_FAIL_RELOAD':'1'})
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(c[0] in ['start','restart'] for c in self.calls()))
        self.clear();self.good(self.setup());self.assertEqual(self.reloads(),1)
        self.assertEqual(len([c for c in self.calls() if c[0]=='restart']),3)
    def test_symlink_unit_is_not_overwritten(self):
        target=self.r/'custom-unit';target.write_text('custom\n')
        (self.r/'etc/systemd/system/sc-1forcr-pull-update.service').symlink_to(target)
        self.assertNotEqual(self.setup().returncode,0)
        self.assertEqual(target.read_text(),'custom\n');self.assertEqual(self.reloads(),0)
    def test_other_timer_paths_idempotent(self):
        for name in ['setup_dns_resolver_guard','setup_online_notify_timer','setup_postboot_health_guard']:
            with self.subTest(name=name):
                self.clear();self.good(self.setup(name));self.assertEqual(self.reloads(),1)
                self.clear();self.good(self.setup(name));self.assertEqual(self.reloads(),0)
                self.assertFalse(any(c[0]=='restart' for c in self.calls()))
    def test_original_update_reload_baseline(self):
        self.good(self.setup(old=True));self.assertEqual(self.reloads(),4)
        self.clear();self.good(self.setup(old=True));self.assertEqual(self.reloads(),4)
    def drain(self,sockets='',fail=False,active=True):
        (self.r/'etc/sc-1forcr.env').write_text('SSHWS_UDPGW_PORTS=7300,7200,7100\nSSHWS_UDPGW_SINGLE_PROCESS=1\n')
        (self.r/'sockets').write_text(sockets)
        state={'enabled':{},'loaded':{},'active':{f'sc-1forcr-udpgw@{p}.service':'active' if active else 'inactive' for p in [7200,7100]}}
        (self.r/'systemd.json').write_text(json.dumps(state))
        return self.runbash(embedded(SRC,'sc-1forcr-udpgw-drain','EOF'),{'SC_TEST_SS_FAIL':'1' if fail else '0'})
    def test_drain_shares_snapshot_and_keeps_connected_alias(self):
        self.good(self.drain('0 0 127.0.0.1:7200 127.0.0.1:40000\n'))
        self.assertEqual((self.r/'ss-calls').read_text().splitlines(),['ss'])
        self.assertEqual([c for c in self.calls() if c[0]=='stop'],[['stop','sc-1forcr-udpgw@7100.service']])
    def test_drain_handles_ipv6_and_state_column(self):
        self.good(self.drain('ESTAB 0 0 [::1]:7200 [::1]:40000\n0 0 [::1]:7100 [::1]:40002\n'))
        self.assertFalse(any(c[0]=='stop' for c in self.calls()))
    def test_drain_snapshot_failure_keeps_services(self):
        self.assertNotEqual(self.drain(fail=True).returncode,0)
        self.assertFalse(any(c[0]=='stop' for c in self.calls()))
    def test_drain_skips_scan_when_aliases_inactive(self):
        self.good(self.drain(active=False));self.assertFalse((self.r/'ss-calls').exists())
        self.assertFalse(any(c[0]=='reset-failed' for c in self.calls()))
    def test_health_snapshot_once_per_attempt_and_refreshed(self):
        text=embedded(SRC,'sc-1forcr-postboot-health','POSTBOOT_HEALTH_EOF')
        code=text[text.index('listener_present() {'):text.index('config_valid_for_unit() {')]
        state={'enabled':{},'loaded':{},'active':{'test.service':'active'}}
        (self.r/'systemd.json').write_text(json.dumps(state))
        (self.r/'sockets').write_text('LISTEN 0 128 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 128 [::]:443 [::]:*\n')
        self.good(self.runbash(code+'\nunit_healthy test.service 80 443\n'))
        (self.r/'sockets').write_text('')
        self.assertNotEqual(self.runbash(code+'\nunit_healthy test.service 80 443\n').returncode,0)
        self.assertEqual((self.r/'ss-calls').read_text().splitlines(),['ss','ss'])
    def test_generated_shell_syntax(self):
        for name,delimiter in [('sc-1forcr-postboot-health','POSTBOOT_HEALTH_EOF'),('sc-1forcr-udpgw-drain','EOF'),('sc-1forcr-slowdns','SLOWDNS_EOF')]:
            result=subprocess.run(['bash','-n'],input=embedded(SRC,name,delimiter),text=True,capture_output=True)
            self.good(result)

    def test_final_update_paths_do_not_restart_reconciled_timers(self):
        import re
        blocks=re.findall(r'restart_update_safe_services\(\) \{\n.*?\n\}\n(?=\nsync_xray_runtime_after_update)',SRC,re.S)
        self.assertEqual(len(blocks),2)
        blocks.append(embedded(SRC,'restart_update_safe_services','EOF'))
        for block in blocks:
            for unit in ['online-notify','pull-update','pull-summary-update','god-update']:
                self.assertNotIn(f'systemctl restart sc-1forcr-{unit}.timer',block)
                self.assertIn(f'systemctl start sc-1forcr-{unit}.timer',block)
            self.assertIn('systemctl restart sc-1forcr-api',block)

    def test_failed_write_propagates_when_caller_uses_if(self):
        target=self.r/'unit';target.write_text('preserve\n')
        (self.r/'etc/systemd/system/sc-1forcr-dns-guard.service').symlink_to(target)
        code=HELPERS+'\n'+function(SRC,'setup_dns_resolver_guard')+'''
flag_enabled() { return 0; }
write_dns_resolver_guard() { :; }
DNS_GUARD_INTERVAL_MINUTES=5
if setup_dns_resolver_guard; then exit 90; else exit 0; fi
'''
        self.good(self.runbash(code));self.assertEqual(target.read_text(),'preserve\n')
        self.assertFalse(any(c[0] in ['start','restart','daemon-reload'] for c in self.calls()))

if __name__=='__main__':unittest.main(verbosity=2)

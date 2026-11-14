"""Exercise generated backup code with real files/SQLite and simulated VPS services."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone

REPO = Path(__file__).resolve().parent.parent
INSTALLER = (REPO / "scripts/setup-autoscript-compat.sh").read_text(encoding="utf-8")
OPENSSL = shutil.which("openssl") or r"C:\Program Files\Git\usr\bin\openssl.exe"
SOURCE_NOTIFY_TOKEN = "123456789:source_notify_token_for_tests_only"
SOURCE_NOTIFY_CHAT = "-1001234567890"


def extract(text, start, end):
    return text.split(start, 1)[1].split(end, 1)[0]


HELPER = extract(INSTALLER, "<<'BACKUP_STATE_PY'\n", "\nBACKUP_STATE_PY\n")
EXPORT_SH = extract(INSTALLER, "cat > /usr/local/sbin/sc-1forcr-auto-backup <<'EOF'\n", "\nEOF\n")
RESTORE_SH = extract(INSTALLER, "cat > /usr/local/sbin/sc-1forcr-restore-backup <<'EOF'\n", "\nEOF\n  chmod +x /usr/local/sbin/sc-1forcr-restore-backup")
EXPORT = extract(EXPORT_SH, "<<'PY'\n", "\nPY\n")
IMPORT = extract(RESTORE_SH, "<<'PY'\n", "\nPY\n")
SCHEMA = extract(RESTORE_SH, "<<'SQL'\n", "\nSQL\n")


def mapped(source, root):
    for prefix in ("/usr/local/", "/etc/", "/opt/", "/var/lib/"):
        source = source.replace(prefix, root.as_posix() + prefix)
    return source


def prepare(root):
    module_path = root / "usr/local/lib/sc-1forcr/backup-state.py"
    module_path.parent.mkdir(parents=True, exist_ok=True)
    shim = '''
# Test isolation: only OpenSSL runs on the host; system users/services are simulated.
import types
_real_command = command
_test_calls = []
_test_users = {}
def _test_command(args, data=None, required=True):
    if args[0] == "openssl":
        args = [OPENSSL] + args[1:]
        return _real_command(args, data, required)
    _test_calls.append(args)
    if os.environ.get("SC_TEST_FAIL") == os.path.basename(args[0]) or (os.environ.get("SC_TEST_FAIL") == "setup" and args[-1] == "setup"):
        if required:
            raise RuntimeError("simulated service/config failure")
        return types.SimpleNamespace(returncode=1, stdout=b"", stderr=b"")
    return types.SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
command = _test_command
def _getpwnam(name):
    if name not in _test_users:
        raise KeyError(name)
    return _test_users[name]
sys.modules["pwd"] = types.SimpleNamespace(getpwnam=_getpwnam)
'''
    # Python on Windows lacks these POSIX calls; actual filesystem/SQLite is retained.
    shim = "\nimport sys\nOPENSSL = " + repr(OPENSSL) + "\n" + shim
    if os.name == "nt":
        shim += "\nos.fchmod = lambda fd, mode: None\nos.chown = lambda path, uid, gid: None\n"
    module_path.write_text(mapped(HELPER, root) + shim, encoding="utf-8")
    for directory in ("etc/sc-1forcr/slowdns", "etc/haproxy/certs", "etc/nginx/sites-available", "opt/sc-1forcr", "etc/systemd/system/dropbear.service.d", "etc/default", "etc/ssh", "var/lib/sc-1forcr"):
        (root / directory).mkdir(parents=True, exist_ok=True)
    fixtures = {
        "etc/ssh/sshd_config": "Port 2222\nPermitRootLogin yes\nAllowTcpForwarding local\nBanner /etc/sc-1forcr/banner.html\n",
        "etc/default/dropbear": 'NO_START=0\nDROPBEAR_PORT=109\nDROPBEAR_EXTRA_ARGS="-w -k -p 143 -b /etc/sc-1forcr/banner.html"\n',
        "etc/systemd/system/dropbear.service.d/override.conf": "[Service]\nExecStart=\nExecStart=/usr/sbin/dropbear -R -E -F -w -k -p 109 -p 143 -b /etc/sc-1forcr/banner.html\n",
    }
    for name, text in fixtures.items():
        file = root / name
        if not file.exists():
            file.write_text(text, encoding="utf-8")
    (root / "usr/local/sbin").mkdir(parents=True, exist_ok=True)
    (root / "usr/local/sbin/sc-1forcr-slowdns").write_text("test helper", encoding="utf-8")
    db = sqlite3.connect(root / "accounts.db")
    db.executescript(SCHEMA)
    db.close()
    return module_path


def load_state(root):
    spec = importlib.util.spec_from_file_location("backup_state_test", root / "usr/local/lib/sc-1forcr/backup-state.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_code(source, root, args):
    old = sys.argv
    sys.argv = ["generated.py"] + [str(v) for v in args]
    try:
        exec(compile(mapped(source, root), "generated.py", "exec"), {})
    finally:
        sys.argv = old


def run_engine(mode, root, input_path, output_path):
    root = Path(root)
    prepare(root)
    if mode == "export":
        run_code(EXPORT, root, [root / "accounts.db", "old.example.com", output_path])
    else:
        # Argumen ke-3 opsional: file ringkasan JSON yang dibaca API.
        extra = [output_path] if output_path and output_path != "-" else []
        run_code(IMPORT, root, [input_path, root / "accounts.db"] + extra)


def seed_notifier_state(root):
    files = {root / "var/lib/sc-1forcr/online-notify.status": b"retry=12\nbackoff_until=9999999999\n",
             root / "var/lib/sc-1forcr/online-notify.last": b"9999999999\n"}
    for file, content in files.items():
        file.write_bytes(content)
    return files


class BackupRestoreTest(unittest.TestCase):
    def assert_banner_runtime(self, root, enabled):
        sshd = (root / "etc/ssh/sshd_config").read_text(encoding="utf-8")
        self.assertIn("Port 2222", sshd)
        self.assertIn("PermitRootLogin yes", sshd)
        self.assertIn("AllowTcpForwarding local", sshd)
        self.assertRegex(sshd, r"(?m)^\s*Banner\s+" + (r"(?!none\s*$)\S+" if enabled else r"none\s*$"))
        override = (root / "etc/systemd/system/dropbear.service.d/override.conf").read_text(encoding="utf-8")
        command = next(line.partition("=")[2] for line in override.splitlines() if line.startswith("ExecStart=") and line.partition("=")[2])
        args = shlex.split(command)
        for flag in ("-w", "-k"):
            self.assertIn(flag, args)
        self.assertIn("-p 109", command)
        self.assertIn("-p 143", command)
        defaults = load_state(root).read_env(str(root / "etc/default/dropbear"))
        extra = shlex.split(defaults["DROPBEAR_EXTRA_ARGS"])
        self.assertEqual(defaults["DROPBEAR_PORT"], "109")
        self.assertIn("-w", extra)
        self.assertIn("-k", extra)
        self.assertIn("143", extra)
        inline_target = extra[extra.index("-b") + 1] if "-b" in extra else ""
        default_targets = [value for value in (inline_target, defaults.get("DROPBEAR_BANNER", "")) if value]
        targets = [args[args.index("-b") + 1]] if "-b" in args else []
        if enabled:
            self.assertTrue(targets, "small restored banner is enabled in the Dropbear override")
            self.assertTrue(default_targets, "small restored banner is enabled in Dropbear defaults")
            for value in targets + default_targets:
                target = Path(value)
                if not target.is_file() and str(target).replace("\\", "/").startswith("/etc/"):
                    target = root / str(target).lstrip("/")
                self.assertEqual(target.name, "banner.html")
                self.assertLessEqual(len(target.read_bytes()), 1990)
        else:
            self.assertEqual(targets + default_targets, [])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sc-backup-test-")
        self.root = Path(self.temp.name)
        prepare(self.root)
        self.state = load_state(self.root)
        self.env = self.root / "etc/sc-1forcr.env"
        self.app_env = self.root / "opt/sc-1forcr/.env"
        self.env.write_text("DOMAIN=new.example.com\nAUTH_TOKEN=keep-new-api\nVPS_PUBLIC_IP=203.0.113.9\nSLOWDNS_ENABLE=0\nAUTO_BACKUP_WIB_HOUR=2\n", encoding="utf-8")
        self.app_env.write_text("DOMAIN=new.example.com\nAUTH_TOKEN=keep-new-api\n", encoding="utf-8")
        self.private = secrets.token_hex(32)
        der = bytes.fromhex("302e020100300506032b656e04220420" + self.private)
        public = subprocess.run([OPENSSL, "pkey", "-inform", "DER", "-pubout", "-outform", "DER"], input=der, capture_output=True, check=True).stdout[-32:].hex()
        self.slowdns = {"enabled": True, "private_key": self.private, "public_key": public,
                        "settings": {"SLOWDNS_NS_DOMAIN": "ns-old.example.com", "SLOWDNS_MTU": "1232", "SLOWDNS_KCP_WINDOW": "2048"}}
        self.key_path = self.root / "domain.key"
        self.cert_path = self.root / "domain.crt"
        config = self.root / "openssl.cnf"
        config.write_text("[req]\ndistinguished_name=dn\n[dn]\n", encoding="utf-8")
        subprocess.run([OPENSSL, "req", "-config", config.as_posix(), "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", self.key_path.as_posix(), "-out", self.cert_path.as_posix(), "-days", "2", "-subj", "/CN=old.example.com", "-addext", "subjectAltName=DNS:old.example.com"], capture_output=True, check=True)
        self.pem = self.cert_path.read_text() + self.key_path.read_text()
        self.identity = {"version": 1, "domain": "old.example.com", "slowdns": self.slowdns,
                         "tls": {"cert_domain": "old.example.com", "pem": self.pem}}
        (self.root / "etc/haproxy/haproxy.cfg").write_text("frontend tls\n    bind *:443 ssl crt /etc/haproxy/certs/new.example.com.pem\nbackend x\n    server local 127.0.0.1:8083\n", encoding="utf-8")
        (self.root / "etc/nginx/sites-available/sc-1forcr.conf").write_text("server {\n server_name new.example.com *.new.example.com;\n location / { proxy_pass http://127.0.0.1:2082; }\n}\n", encoding="utf-8")

    def tearDown(self):
        os.environ.pop("SC_TEST_FAIL", None)
        self.temp.cleanup()

    def test_identity_restore_and_round_trip(self):
        restore = self.state.IdentityRestore(self.identity)
        restore.apply()
        env = self.state.read_env()
        self.assertEqual(env["DOMAIN"], "old.example.com")
        self.assertEqual(env["AUTH_TOKEN"], "keep-new-api")
        self.assertEqual(env["VPS_PUBLIC_IP"], "203.0.113.9")
        self.assertEqual(env["SLOWDNS_ENABLE"], "1")
        self.assertEqual(self.state.read_text(self.state.KEY_DIR + "/server.key").strip(), self.private)
        self.assertEqual(self.state.export_identity(), self.identity)
        commands = self.state._test_calls
        self.assertTrue(any(c[:2] == ["nginx", "-t"] for c in commands))
        self.assertTrue(any(c[:2] == ["haproxy", "-c"] for c in commands))
        self.assertFalse(any("xray" in c or "ssh" in c or "dropbear" in c for c in commands))
        self.assertIn("server local 127.0.0.1:8083", self.state.read_text(self.state.HAPROXY))

    def test_invalid_keys_domain_and_certificate_do_not_modify_files(self):
        before = self.env.read_bytes()
        variants = []
        bad = copy.deepcopy(self.identity); bad["slowdns"]["public_key"] = "ab" * 32; variants.append(bad)
        bad = copy.deepcopy(self.identity); bad["slowdns"]["private_key"] = ""; variants.append(bad)
        bad = copy.deepcopy(self.identity); bad["domain"] = "bad.example.com\nAUTH_TOKEN=oops"; variants.append(bad)
        bad = copy.deepcopy(self.identity); bad["tls"]["cert_domain"] = "../../escape"; variants.append(bad)
        bad = copy.deepcopy(self.identity); bad["domain"] = "unrelated.example.com"; variants.append(bad)
        bad = copy.deepcopy(self.identity); bad["tls"]["pem"] = "not a certificate"; variants.append(bad)
        for value in variants:
            with self.assertRaises((ValueError, RuntimeError)):
                self.state.IdentityRestore(value)
            self.assertEqual(self.env.read_bytes(), before)
        self.assertEqual(self.state._test_calls, [])

    def test_runtime_failure_rolls_back_keys_domain_and_units(self):
        before = self.env.read_bytes()
        private_path = Path(self.state.KEY_DIR + "/server.key")
        private_path.write_text("previous key", encoding="utf-8")
        os.environ["SC_TEST_FAIL"] = "setup"
        restore = self.state.IdentityRestore(self.identity)
        with self.assertRaises(RuntimeError):
            try:
                restore.apply()
            except Exception:
                restore.rollback()
                raise
        self.assertEqual(self.env.read_bytes(), before)
        self.assertEqual(private_path.read_text(), "previous key")
        self.assertFalse((self.root / "etc/haproxy/certs/old.example.com.pem").exists())

    def test_expiry_boundary_and_linux_restore(self):
        today = datetime.now().strftime("%Y-%m-%d")
        future = (datetime.now() + timedelta(days=10)).strftime("%Y-%m-%d %H:%M:%S")
        self.assertFalse(self.state.expired(today))
        self.assertEqual(self.state.normalize_expiry(None), "")
        self.assertEqual(self.state.normalize_expiry("unlimited"), "")
        for value in ("nonsense", "2026-02-30", "2030-99-10"):
            with self.assertRaises(ValueError):
                self.state.normalize_expiry(value)
        self.state.sync_ssh([
            {"username": "valid", "password": "password1", "status": "AKTIF", "date_exp": future},
            {"username": "today", "password": "password2", "status": "AKTIF", "date_exp": today},
            {"username": "unlimited", "password": "password3", "status": "AKTIF", "date_exp": ""},
            {"username": "expired", "password": "password4", "status": "EXPIRED", "date_exp": "2000-01-01"},
            {"username": "locked", "password": "password5", "status": "LOCK_QUOTA", "date_exp": future},
        ])
        calls = self.state._test_calls
        created = [c[-1] for c in calls if c[0] == "useradd"]
        self.assertEqual(created, ["valid", "today", "unlimited"])
        tomorrow = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        self.assertIn(["chage", "-E", tomorrow, "today"], calls)
        self.assertIn(["chage", "-E", "-1", "unlimited"], calls)

    def test_native_export_import_real_sqlite(self):
        # Source identity matches source files; all protocol credentials survive.
        restore = self.state.IdentityRestore(self.identity); restore.apply()
        self.env.write_text(self.env.read_text() + f"TELEGRAM_BOT_TOKEN={SOURCE_NOTIFY_TOKEN}\nTELEGRAM_CHAT_ID={SOURCE_NOTIFY_CHAT}\nONLINE_NOTIFY_ENABLE=1\nONLINE_NOTIFY_INTERVAL_HOURS=9\nONLINE_NOTIFY_ACTIVE_WINDOW_SECONDS=240\nBOT_PANEL_TOKEN=source-seller-token\nBOT_PANEL_ADMIN_IDS=112233\n", encoding="utf-8")
        self.app_env.write_text(self.app_env.read_text() + f"TELEGRAM_BOT_TOKEN={SOURCE_NOTIFY_TOKEN}\nTELEGRAM_CHAT_ID={SOURCE_NOTIFY_CHAT}\nBOT_PANEL_TOKEN=source-seller-token\nBOT_PANEL_ADMIN_IDS=112233\n", encoding="utf-8")
        source_html = "<h1>Banner sumber</h1><p>Selamat datang — uji</p>"
        source_txt = "Banner sumber\nAkun premium\n"
        (self.root / "etc/sc-1forcr/banner.html").write_bytes(source_html.encode("utf-8"))
        (self.root / "etc/sc-1forcr/banner.txt").write_bytes(source_txt.encode("utf-8"))
        db = sqlite3.connect(self.root / "accounts.db")
        today = datetime.now().strftime("%Y-%m-%d")
        rows = [("valid", "pass1", "2099-12-31 22:00:00", "AKTIF"), ("today", "pass2", today, "AKTIF"),
                ("unlimited", "pass3", None, "AKTIF"), ("expired", "pass4", "2000-01-01", "AKTIF"),
                ("locked", "pass5", "2099-12-31", "LOCK_QUOTA")]
        db.executemany("INSERT INTO account_sshs(username,password,date_exp,status,quota,limitip) VALUES(?,?,?,?,50,2)", rows)
        for table in ("account_vmesses", "account_vlesses"):
            db.execute(f"INSERT INTO {table}(username,uuid,date_exp,status) VALUES('xuser','10000000-0000-4000-8000-000000000001','2099-12-31','AKTIF')")
        db.execute("INSERT INTO account_trojans(username,password,date_exp,status) VALUES('tuser','trojan-secret','2099-12-31','AKTIF')")
        db.execute("INSERT INTO account_quota_usage VALUES('ssh','valid',12345,9876,1)")
        db.execute("INSERT INTO account_quota_locks VALUES('ssh','locked',1000,1200,1)")
        db.commit(); db.close()
        output = self.root / "backup.json"
        run_code(EXPORT, self.root, [self.root / "accounts.db", "old.example.com", output])
        backup = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(backup["meta"]["format"], "sc1forcr-accounts-backup-v3")
        self.assertEqual(backup["data"]["identity"]["slowdns"]["public_key"], self.slowdns["public_key"])
        self.assertEqual(backup["data"]["settings"]["TELEGRAM_BOT_TOKEN"], SOURCE_NOTIFY_TOKEN)
        self.assertEqual(backup["data"]["settings"]["TELEGRAM_CHAT_ID"], SOURCE_NOTIFY_CHAT)
        self.assertEqual(backup["data"]["settings"]["ONLINE_NOTIFY_INTERVAL_HOURS"], "9")
        self.assertEqual(backup["data"]["banner_html"], source_html)
        self.assertEqual(backup["data"]["banner_txt"], source_txt)
        for key in ("AUTH_TOKEN", "BOT_PANEL_TOKEN", "BOT_PANEL_ADMIN_IDS"):
            self.assertNotIn(key, backup["data"]["settings"])
        self.assertNotIn("source-seller-token", json.dumps(backup))
        with tempfile.TemporaryDirectory(prefix="sc-backup-dst-") as dest:
            dst = Path(dest); prepare(dst)
            (dst / "etc/sc-1forcr.env").write_text("DOMAIN=new.example.com\nAUTH_TOKEN=target-secret\nVPS_PUBLIC_IP=203.0.113.10\nTELEGRAM_BOT_TOKEN=destination-notify-token\nTELEGRAM_CHAT_ID=987654\nBOT_PANEL_TOKEN=destination-seller-token\nBOT_PANEL_ADMIN_IDS=998877\n", encoding="utf-8")
            (dst / "opt/sc-1forcr/.env").write_text("AUTH_TOKEN=target-secret\nTELEGRAM_BOT_TOKEN=destination-notify-token\nTELEGRAM_CHAT_ID=987654\nBOT_PANEL_TOKEN=destination-seller-token\nBOT_PANEL_ADMIN_IDS=998877\n", encoding="utf-8")
            notifier_files = seed_notifier_state(dst)
            shutil.copy(self.root / "etc/haproxy/haproxy.cfg", dst / "etc/haproxy/haproxy.cfg")
            shutil.copy(self.root / "etc/nginx/sites-available/sc-1forcr.conf", dst / "etc/nginx/sites-available/sc-1forcr.conf")
            for _ in range(2):  # Retry is idempotent.
                run_code(IMPORT, dst, [output, dst / "accounts.db"])
            db = sqlite3.connect(dst / "accounts.db")
            got = dict(db.execute("SELECT username,status FROM account_sshs"))
            self.assertEqual(got, {"valid": "AKTIF", "today": "AKTIF", "unlimited": "AKTIF", "expired": "EXPIRED", "locked": "LOCK_QUOTA"})
            self.assertIsNone(db.execute("SELECT 1 FROM account_sshs WHERE date_exp='None'").fetchone())
            self.assertEqual(db.execute("SELECT used_bytes FROM account_quota_usage WHERE username='valid'").fetchone()[0], 12345)
            self.assertEqual(db.execute("SELECT password FROM account_trojans").fetchone()[0], "trojan-secret")
            db.close()
            self.assertIn("AUTH_TOKEN=target-secret", (dst / "etc/sc-1forcr.env").read_text())
            self.assertIn("DOMAIN=old.example.com", (dst / "etc/sc-1forcr.env").read_text())
            self.assertEqual((dst / "etc/sc-1forcr/slowdns/server.pub").read_text().strip(), self.slowdns["public_key"])
            for env_file in (dst / "etc/sc-1forcr.env", dst / "opt/sc-1forcr/.env"):
                text = env_file.read_text()
                self.assertIn("TELEGRAM_BOT_TOKEN=" + SOURCE_NOTIFY_TOKEN, text)
                self.assertIn("TELEGRAM_CHAT_ID=" + SOURCE_NOTIFY_CHAT, text)
                self.assertIn("BOT_PANEL_TOKEN=destination-seller-token", text)
                self.assertIn("BOT_PANEL_ADMIN_IDS=998877", text)
                self.assertIn("AUTH_TOKEN=target-secret", text)
            self.assertEqual((dst / "etc/sc-1forcr/banner.html").read_text(encoding="utf-8"), source_html)
            self.assertEqual((dst / "etc/sc-1forcr/banner.txt").read_text(encoding="utf-8"), source_txt)
            self.assert_banner_runtime(dst, True)
            self.assertEqual([file.read_bytes() for file in notifier_files], [b"", b""])

    def test_legacy_backup_does_not_replace_identity(self):
        payload = {"data": {"ssh": [{"username": "legacy", "password": "legacy1", "date_exp": "2099-01-01", "status": "ACTIVE"}]}}
        self.env.write_text(self.env.read_text() + "TELEGRAM_BOT_TOKEN=keep-notify-token\nTELEGRAM_CHAT_ID=12345\n", encoding="utf-8")
        html = self.root / "etc/sc-1forcr/banner.html"
        txt = self.root / "etc/sc-1forcr/banner.txt"
        html.write_text("<p>Keep destination banner</p>", encoding="utf-8")
        txt.write_text("Keep destination text banner", encoding="utf-8")
        config_paths = [self.root / name for name in ("etc/ssh/sshd_config", "etc/default/dropbear", "etc/systemd/system/dropbear.service.d/override.conf")]
        configs_before = [file.read_bytes() for file in config_paths]
        notifier_files = seed_notifier_state(self.root)
        path = self.root / "legacy.json"; path.write_text(json.dumps(payload))
        before = self.env.read_bytes()
        run_code(IMPORT, self.root, [path, self.root / "accounts.db"])
        self.assertEqual(self.env.read_bytes(), before)
        self.assertEqual(html.read_text(), "<p>Keep destination banner</p>")
        self.assertEqual(txt.read_text(), "Keep destination text banner")
        self.assertEqual([file.read_bytes() for file in config_paths], configs_before)
        self.assertEqual({file: file.read_bytes() for file in notifier_files}, notifier_files)
        db = sqlite3.connect(self.root / "accounts.db")
        self.assertEqual(db.execute("SELECT status FROM account_sshs").fetchone()[0], "AKTIF")
        db.close()

    def test_linux_failure_and_admin_protection(self):
        rows = [{"username": "newuser", "password": "password1", "status": "AKTIF", "date_exp": "2099-01-01"}]
        os.environ["SC_TEST_FAIL"] = "chage"
        with self.assertRaises(RuntimeError):
            self.state.sync_ssh(rows)
        self.assertIn(["userdel", "newuser"], self.state._test_calls)
        os.environ.pop("SC_TEST_FAIL")
        self.state._test_calls.clear()
        self.state._test_users["newuser"] = types.SimpleNamespace(pw_uid=1000, pw_shell="/bin/bash", pw_gid=1000)
        with self.assertRaisesRegex(ValueError, "di luar database"):
            self.state.sync_ssh(rows, set())
        self.assertEqual(self.state._test_calls, [])

    def test_import_rejects_bad_dates_and_rolls_back_service_failure(self):
        self.env.write_text(self.env.read_text() + "TELEGRAM_BOT_TOKEN=keep-notify-token\nTELEGRAM_CHAT_ID=12345\n", encoding="utf-8")
        self.app_env.write_text(self.app_env.read_text() + "TELEGRAM_BOT_TOKEN=keep-notify-token\nTELEGRAM_CHAT_ID=12345\n", encoding="utf-8")
        html = self.root / "etc/sc-1forcr/banner.html"
        txt = self.root / "etc/sc-1forcr/banner.txt"
        html.write_text("<p>Previous banner</p>", encoding="utf-8")
        txt.write_text("Previous text banner", encoding="utf-8")
        notifier_files = seed_notifier_state(self.root)
        before = self.env.read_bytes()
        app_before = self.app_env.read_bytes()
        payload = {"data": {"identity": self.identity, "settings": {"TELEGRAM_BOT_TOKEN": SOURCE_NOTIFY_TOKEN, "TELEGRAM_CHAT_ID": SOURCE_NOTIFY_CHAT}, "banner_html": "<p>Incoming banner</p>", "banner_txt": "Incoming text banner", "ssh": [{"username": "newuser", "password": "pass1", "date_exp": "not-a-date", "status": "AKTIF"}]}}
        file = self.root / "bad.json"; file.write_text(json.dumps(payload))
        with self.assertRaises(ValueError):
            run_code(IMPORT, self.root, [file, self.root / "accounts.db"])
        self.assertEqual(self.env.read_bytes(), before)
        self.assertEqual(self.app_env.read_bytes(), app_before)
        self.assertEqual(html.read_text(), "<p>Previous banner</p>")
        self.assertEqual(txt.read_text(), "Previous text banner")
        self.assertEqual({file: file.read_bytes() for file in notifier_files}, notifier_files)
        payload["data"]["ssh"][0]["date_exp"] = "2099-12-31"
        file.write_text(json.dumps(payload))
        os.environ["SC_TEST_FAIL"] = "setup"
        with self.assertRaises(RuntimeError):
            run_code(IMPORT, self.root, [file, self.root / "accounts.db"])
        self.assertEqual(self.env.read_bytes(), before)
        self.assertEqual(self.app_env.read_bytes(), app_before)
        self.assertEqual(html.read_text(), "<p>Previous banner</p>")
        self.assertEqual(txt.read_text(), "Previous text banner")
        self.assertEqual({file: file.read_bytes() for file in notifier_files}, notifier_files)
        db = sqlite3.connect(self.root / "accounts.db")
        self.assertEqual(db.execute("SELECT COUNT(*) FROM account_sshs").fetchone()[0], 0)
        db.close()

    def test_disabled_slowdns_without_keys(self):
        Path(self.state.HAPROXY).unlink()
        exported = self.state.export_identity()
        self.assertFalse(exported["slowdns"]["enabled"])
        self.assertNotIn("private_key", exported["slowdns"])
        key = Path(self.state.KEY_DIR + "/server.key")
        key.write_text("keep destination key")
        self.state.IdentityRestore(exported).apply()
        self.assertEqual(key.read_text(), "keep destination key")
        self.assertEqual(self.state.read_env()["SLOWDNS_ENABLE"], "0")

    def test_explicit_empty_notification_and_banner_values_clear_destination(self):
        self.env.write_text(self.env.read_text() + "TELEGRAM_BOT_TOKEN=old-notify-token\nTELEGRAM_CHAT_ID=12345\nBOT_PANEL_TOKEN=keep-seller-token\nBOT_PANEL_ADMIN_IDS=7777\n", encoding="utf-8")
        self.app_env.write_text(self.app_env.read_text() + "TELEGRAM_BOT_TOKEN=old-notify-token\nTELEGRAM_CHAT_ID=12345\nBOT_PANEL_TOKEN=keep-seller-token\nBOT_PANEL_ADMIN_IDS=7777\n", encoding="utf-8")
        html = self.root / "etc/sc-1forcr/banner.html"
        txt = self.root / "etc/sc-1forcr/banner.txt"
        html.write_text("<p>Old banner</p>", encoding="utf-8")
        txt.write_text("Old text banner", encoding="utf-8")
        payload = {"data": {"settings": {"TELEGRAM_BOT_TOKEN": "", "TELEGRAM_CHAT_ID": "", "AUTH_TOKEN": "must-not-import", "BOT_PANEL_TOKEN": "must-not-import", "BOT_PANEL_ADMIN_IDS": "1111"}, "banner_html": "", "banner_txt": ""}}
        file = self.root / "clear.json"; file.write_text(json.dumps(payload))
        run_code(IMPORT, self.root, [file, self.root / "accounts.db"])
        state = load_state(self.root)
        for env_file in (self.env, self.app_env):
            settings = state.read_env(str(env_file))
            self.assertEqual(settings["TELEGRAM_BOT_TOKEN"], "")
            self.assertEqual(settings["TELEGRAM_CHAT_ID"], "")
            self.assertEqual(settings["BOT_PANEL_TOKEN"], "keep-seller-token")
            self.assertEqual(settings["BOT_PANEL_ADMIN_IDS"], "7777")
            self.assertEqual(settings["AUTH_TOKEN"], "keep-new-api")
        self.assertEqual(html.read_text(), "")
        self.assertEqual(txt.read_text(), "")
        self.assert_banner_runtime(self.root, False)

    def test_same_notification_identity_preserves_retry_state(self):
        settings = {"TELEGRAM_BOT_TOKEN": SOURCE_NOTIFY_TOKEN, "TELEGRAM_CHAT_ID": SOURCE_NOTIFY_CHAT}
        for env_file in (self.env, self.app_env):
            env_file.write_text(env_file.read_text() + f"TELEGRAM_BOT_TOKEN={SOURCE_NOTIFY_TOKEN}\nTELEGRAM_CHAT_ID={SOURCE_NOTIFY_CHAT}\n", encoding="utf-8")
        notifier_files = seed_notifier_state(self.root)
        payload = {"data": {"settings": {**settings, "ONLINE_NOTIFY_INTERVAL_HOURS": "6"}}}
        file = self.root / "same-notifier.json"; file.write_text(json.dumps(payload))
        run_code(IMPORT, self.root, [file, self.root / "accounts.db"])
        self.assertEqual({file: file.read_bytes() for file in notifier_files}, notifier_files)

    def test_oversize_compactable_banner_uses_safe_dropbear_file(self):
        html = "<h1>Welcome</h1>" + (" " * 12000) + "<p>Premium account</p>"
        payload = {"data": {"banner_html": html, "banner_txt": "Welcome\nPremium account"}}
        file = self.root / "compact.json"; file.write_text(json.dumps(payload))
        run_code(IMPORT, self.root, [file, self.root / "accounts.db"])
        self.assertEqual((self.root / "etc/sc-1forcr/banner.html").read_text(), html)
        compact = self.root / "etc/sc-1forcr/banner-dropbear.html"
        self.assertTrue(compact.is_file())
        self.assertLessEqual(len(compact.read_bytes()), 1990)
        for config in (self.root / "etc/default/dropbear", self.root / "etc/systemd/system/dropbear.service.d/override.conf"):
            self.assertIn("banner-dropbear.html", config.read_text())


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "engine":
        run_engine(*sys.argv[2:])
    else:
        unittest.main()

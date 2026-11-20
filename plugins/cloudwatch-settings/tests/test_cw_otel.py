"""cw_otel.py のテスト。偽の aws コマンドと一時 HOME で動かす（POSIX のみ）。

    python3 -m unittest discover -s plugins/cloudwatch-settings/tests -v
"""

import http.server
import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path

try:
    import tomllib
except Exception:  # pragma: no cover
    tomllib = None

SCRIPT = (Path(__file__).resolve().parents[1]
          / "skills" / "cloudwatch-settings" / "scripts" / "cw_otel.py")
SECRET = "cwsecretAAAABBBBCCCCDDDDEEEEFFFF0123456789"

FAKE_AWS = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys
    db_path = os.environ["FAKE_AWS_DB"]
    db = json.load(open(db_path)) if os.path.exists(db_path) else {"users": {}, "calls": [], "n": 0}
    a = [x for x in sys.argv[1:]]
    def opt(name):
        return a[a.index(name) + 1] if name in a else None
    db["calls"].append(a)
    def done(out=None, code=0, err=""):
        json.dump(db, open(db_path, "w"))
        if out is not None:
            print(json.dumps(out))
        if err:
            sys.stderr.write(err)
        sys.exit(code)
    if os.environ.get("FAKE_AWS_NO_CREDS") and a[:2] == ["sts", "get-caller-identity"]:
        done(code=255, err="Unable to locate credentials")
    if a[:2] == ["sts", "get-caller-identity"]:
        done({"Account": "123456789012", "Arn": "arn:aws:iam::123456789012:user/me"})
    user = opt("--user-name")
    if a[:2] == ["iam", "create-user"]:
        if user in db["users"]:
            done(code=254, err="An error occurred (EntityAlreadyExists) when calling CreateUser")
        db["users"][user] = {"creds": [], "policy": False}
        done({"User": {"UserName": user}})
    if a[:2] == ["iam", "attach-user-policy"]:
        db["users"][user]["policy"] = True
        done()
    if a[:2] == ["iam", "detach-user-policy"]:
        db["users"][user]["policy"] = False
        done()
    if a[:2] == ["iam", "delete-user"]:
        db["users"].pop(user, None)
        done()
    if a[:2] == ["iam", "list-service-specific-credentials"]:
        if user not in db["users"]:
            done(code=254, err="An error occurred (NoSuchEntity)")
        done({"ServiceSpecificCredentials": [
            {"ServiceSpecificCredentialId": c["id"], "CreateDate": c["created"], "Status": "Active"}
            for c in db["users"][user]["creds"]]})
    if a[:2] == ["iam", "create-service-specific-credential"]:
        db["n"] += 1
        cid = "ACCA%04d" % db["n"]
        secret = os.environ["FAKE_AWS_SECRET"] + str(db["n"])
        db["users"][user]["creds"].append({"id": cid, "created": "2026-01-%02dT00:00:00+00:00" % db["n"]})
        cred = {"ServiceSpecificCredentialId": cid, "ServiceCredentialSecret": secret,
                "UserName": user, "Status": "Active"}
        if opt("--credential-age-days"):
            cred["ExpirationDate"] = "2099-01-01T00:00:00+00:00"
        done({"ServiceSpecificCredential": cred})
    if a[:2] == ["iam", "delete-service-specific-credential"]:
        cid = opt("--service-specific-credential-id")
        db["users"][user]["creds"] = [c for c in db["users"][user]["creds"] if c["id"] != cid]
        done()
    if a[:2] == ["cloudwatch", "put-dashboard"]:
        body = opt("--dashboard-body")
        db.setdefault("dashboards", {})[opt("--dashboard-name")] = open(body[len("file://"):]).read()
        done({"DashboardValidationMessages": []})
    done(code=2, err="fake aws: unsupported " + " ".join(a))
''')


@unittest.skipIf(os.name == "nt", "POSIX のみ")
class CwOtelTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        aws = self.bin / "aws"
        aws.write_text(FAKE_AWS)
        aws.chmod(0o755)
        self.db = self.tmp / "aws-db.json"
        self.env = {
            "HOME": str(self.home),
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "SHELL": "/bin/zsh",
            "FAKE_AWS_DB": str(self.db),
            "FAKE_AWS_SECRET": SECRET,
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
        self.settings = self.home / ".claude" / "settings.json"
        self.codex = self.home / ".codex" / "config.toml"
        self.token_file = self.tmp / "token.txt"

    def tearDown(self):
        self._tmp.cleanup()

    def run_cli(self, *args, env=None, expect_ok=True):
        e = dict(self.env)
        e.update(env or {})
        cp = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=e)
        self.assertNotIn(SECRET, cp.stdout, "秘密の値が標準出力に出ている")
        self.assertNotIn(SECRET, cp.stderr, "秘密の値が標準エラーに出ている")
        try:
            out = json.loads(cp.stdout)
        except Exception:
            self.fail(f"JSON でない出力: {cp.stdout!r} / {cp.stderr!r}")
        if expect_ok:
            self.assertTrue(out.get("ok"), out)
            self.assertEqual(cp.returncode, 0)
        else:
            self.assertFalse(out.get("ok"), out)
            self.assertNotEqual(cp.returncode, 0)
        return out

    def apply_file(self, *extra, **kw):
        self.token_file.write_text(SECRET + "\n")
        return self.run_cli("apply", "--region", "ap-northeast-1", "--targets", "claude,codex",
                            "--token-source", "file", "--token-file", str(self.token_file),
                            "--label", "macbook", *extra, **kw)

    def calls(self):
        return json.loads(self.db.read_text())["calls"] if self.db.exists() else []

    # ---- apply

    def test_apply_from_file_writes_both_and_keeps_existing_content(self):
        self.settings.parent.mkdir()
        self.settings.write_text(json.dumps({"model": "x", "env": {"FOO": "bar"}}))
        self.codex.parent.mkdir()
        self.codex.write_text('model = "gpt"\n\n[otel]\nlog_user_prompt = false\n')
        out = self.apply_file()
        self.assertTrue(out["token_file_deleted"])
        self.assertFalse(self.token_file.exists())

        s = json.loads(self.settings.read_text())
        self.assertEqual(s["model"], "x")
        env = s["env"]
        self.assertEqual(env["FOO"], "bar")
        self.assertEqual(env["CLAUDE_CODE_ENABLE_TELEMETRY"], "1")
        self.assertEqual(env["OTEL_METRICS_EXPORTER"], "otlp")
        self.assertEqual(env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"],
                         "https://monitoring.ap-northeast-1.amazonaws.com/v1/metrics")
        self.assertEqual(env["OTEL_EXPORTER_OTLP_METRICS_HEADERS"], f"Authorization=Bearer {SECRET}")
        self.assertIn("host.name=macbook", env["OTEL_RESOURCE_ATTRIBUTES"])
        self.assertIn("team.id=macbook", env["OTEL_RESOURCE_ATTRIBUTES"])
        self.assertNotIn("OTEL_EXPORTER_OTLP_ENDPOINT", env)

        text = self.codex.read_text()
        self.assertIn('model = "gpt"', text)
        if tomllib:
            t = tomllib.loads(text)
            self.assertEqual(t["otel"]["log_user_prompt"], False)
            exp = t["otel"]["metrics_exporter"]["otlp-http"]
            self.assertEqual(exp["endpoint"], "https://monitoring.ap-northeast-1.amazonaws.com/v1/metrics")
            self.assertEqual(exp["protocol"], "binary")
            self.assertEqual(exp["headers"]["Authorization"], f"Bearer {SECRET}")
        for f in (self.settings, self.codex):
            self.assertEqual(stat.S_IMODE(f.stat().st_mode), 0o600, f)

        rc = (self.home / ".zshrc").read_text()
        self.assertIn("export OTEL_RESOURCE_ATTRIBUTES='host.name=macbook", rc)
        self.assertEqual(self.calls(), [], "file からの取り込みでは AWS を呼ばない")

    def test_apply_is_idempotent(self):
        self.apply_file()
        self.apply_file("--attr", "department=home")
        text = self.codex.read_text()
        self.assertEqual(text.count("[otel.metrics_exporter.otlp-http]"), 1)
        self.assertEqual((self.home / ".zshrc").read_text().count("OTEL_RESOURCE_ATTRIBUTES"), 1)
        attrs = json.loads(self.settings.read_text())["env"]["OTEL_RESOURCE_ATTRIBUTES"]
        self.assertIn("department=home", attrs)
        self.assertEqual(attrs.count("host.name="), 1)
        for f in list(self.settings.parent.iterdir()) + list(self.codex.parent.iterdir()):
            if f.name not in ("settings.json", "config.toml"):
                self.assertNotIn(SECRET, f.read_text(), f"キーの写しが残っている: {f.name}")

    def test_dry_run_changes_nothing(self):
        self.token_file.write_text(SECRET)
        out = self.run_cli("apply", "--region", "us-east-1", "--targets", "claude,codex",
                           "--token-source", "file", "--token-file", str(self.token_file), "--dry-run")
        self.assertTrue(out["dry_run"])
        self.assertFalse(self.settings.exists())
        self.assertFalse(self.codex.exists())
        self.assertTrue(self.token_file.exists())

    def test_shell_env_skip(self):
        self.apply_file("--shell-env", "skip")
        self.assertFalse((self.home / ".zshrc").exists())

    def test_rejects_bad_token_and_region(self):
        self.token_file.write_text("short")
        out = self.run_cli("apply", "--region", "ap-northeast-1", "--token-source", "file",
                           "--token-file", str(self.token_file), "--targets", "claude", expect_ok=False)
        self.assertEqual(out["error"]["code"], "bad_token")
        out = self.run_cli("apply", "--region", "tokyo", "--token-source", "existing", expect_ok=False)
        self.assertEqual(out["error"]["code"], "bad_region")

    # ---- 衝突

    def test_conflict_claude_requires_overwrite(self):
        self.settings.parent.mkdir()
        self.settings.write_text(json.dumps({"env": {
            "OTEL_METRICS_EXPORTER": "otlp",
            "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "https://otlp.example.com/v1/metrics"}}))
        out = self.apply_file(expect_ok=False)
        self.assertEqual(out["error"]["code"], "conflict_claude")
        self.assertNotIn("amazonaws", self.settings.read_text())
        self.assertFalse(self.codex.exists(), "衝突時はどのファイルも書かない")
        self.apply_file("--overwrite")
        self.assertIn("monitoring.ap-northeast-1.amazonaws.com", self.settings.read_text())

    def test_conflict_codex_unmanaged_exporter(self):
        self.codex.parent.mkdir()
        self.codex.write_text('[otel.metrics_exporter.otlp-http]\nendpoint = "https://x/v1/metrics"\n'
                              'protocol = "binary"\n')
        out = self.apply_file(expect_ok=False)
        self.assertEqual(out["error"]["code"], "conflict_codex")
        self.assertFalse(self.settings.exists(), "衝突時はどのファイルも書かない")

    def test_git_tracked_settings_are_refused(self):
        dot = self.tmp / "dotfiles"
        (dot / "claude").mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(dot)], check=True)
        (dot / "claude" / "settings.json").write_text("{}")
        (self.home / ".claude").symlink_to(dot / "claude")
        out = self.apply_file(expect_ok=False)
        self.assertEqual(out["error"]["code"], "git_tracked")
        self.assertEqual((dot / "claude" / "settings.json").read_text(), "{}")
        (dot / ".gitignore").write_text("claude/settings.json\n")
        self.apply_file()

    # ---- AWS CLI でキーを作る

    def aws_apply(self, *extra, **kw):
        return self.run_cli("apply", "--region", "ap-northeast-1", "--targets", "claude,codex",
                            "--token-source", "aws-cli", "--label", "evo-x2", *extra, **kw)

    def test_aws_cli_creates_key_and_rotates(self):
        out = self.aws_apply(expect_ok=False)
        self.assertEqual(out["error"]["code"], "need_expiry")
        self.assertEqual(self.calls(), [], "事前確認で止まるときは AWS を呼ばない")

        out = self.aws_apply("--age-days", "90")
        self.assertEqual(out["key"]["iam_user"], "coding-agents-otel-evo-x2")
        self.assertTrue(out["key"]["credential_expires"])
        env = json.loads(self.settings.read_text())["env"]
        self.assertEqual(env["OTEL_EXPORTER_OTLP_METRICS_HEADERS"], f"Authorization=Bearer {SECRET}1")
        create = [c for c in self.calls() if c[:2] == ["iam", "create-service-specific-credential"]][0]
        self.assertIn("cloudwatch.amazonaws.com", create)
        self.assertEqual(create[create.index("--credential-age-days") + 1], "90")

        out = self.aws_apply("--age-days", "90", expect_ok=False)
        self.assertEqual(out["error"]["code"], "existing_key")
        self.assertEqual(len(out["error"]["credentials"]), 1)

        out = self.aws_apply("--no-expiry", "--rotate")
        self.assertEqual(out["old_keys_deleted"], ["ACCA0001"])
        self.assertIsNone(out["key"]["credential_expires"])
        self.assertIn(f"Bearer {SECRET}2", self.codex.read_text())
        db = json.loads(self.db.read_text())
        self.assertEqual([c["id"] for c in db["users"]["coding-agents-otel-evo-x2"]["creds"]], ["ACCA0002"])
        self.assertTrue(db["users"]["coding-agents-otel-evo-x2"]["policy"])

        st = self.run_cli("status")
        self.assertTrue(st["claude"]["configured"])
        self.assertTrue(st["codex"]["configured"])
        self.assertTrue(st["same_token_in_both"])
        self.assertEqual(st["state"]["credential_id"], "ACCA0002")
        self.assertEqual(st["aws_identity"]["account"], "123456789012")

    def test_aws_not_logged_in(self):
        out = self.aws_apply("--age-days", "90", env={"FAKE_AWS_NO_CREDS": "1"}, expect_ok=False)
        self.assertEqual(out["error"]["code"], "aws_not_ready")
        self.assertFalse(self.settings.exists())

    def test_conflict_is_detected_before_key_creation(self):
        self.codex.parent.mkdir()
        self.codex.write_text('[otel]\nmetrics_exporter = "none"\n')
        out = self.aws_apply("--age-days", "90", expect_ok=False)
        self.assertEqual(out["error"]["code"], "conflict_codex")
        self.assertEqual(self.calls(), [])

    # ---- existing / remove / verify / dashboards

    def test_existing_token_can_be_reapplied_to_another_region(self):
        self.apply_file("--targets", "claude")
        self.run_cli("apply", "--region", "us-east-1", "--targets", "claude,codex",
                     "--token-source", "existing", "--label", "macbook")
        self.assertIn("monitoring.us-east-1.amazonaws.com", self.codex.read_text())
        self.assertIn(SECRET, self.codex.read_text())

    def test_remove_restores_files(self):
        self.settings.parent.mkdir()
        self.settings.write_text(json.dumps({"env": {"FOO": "bar"}}))
        self.codex.parent.mkdir()
        self.codex.write_text('model = "gpt"\n')
        self.aws_apply("--age-days", "30")
        out = self.run_cli("remove", "--delete-key")
        self.assertEqual(json.loads(self.settings.read_text()), {"env": {"FOO": "bar"}})
        self.assertEqual(self.codex.read_text(), 'model = "gpt"\n')
        self.assertNotIn("OTEL_RESOURCE_ATTRIBUTES", (self.home / ".zshrc").read_text())
        self.assertTrue(out["key"]["iam_user_deleted"])
        self.assertEqual(json.loads(self.db.read_text())["users"], {})
        self.assertFalse((self.home / ".config" / "cloudwatch-settings" / "state.json").exists())

    def test_verify_posts_a_datapoint_with_the_token(self):
        seen = {}

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen["auth"] = self.headers.get("Authorization")
                seen["path"] = self.path
                seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            self.apply_file("--targets", "claude")
            # 本物の CloudWatch には送らない：宛先をローカルのサーバーに差し替えてから verify する
            s = json.loads(self.settings.read_text())
            s["env"]["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"] = f"http://127.0.0.1:{srv.server_port}/v1/metrics"
            self.settings.write_text(json.dumps(s))
            out = self.run_cli("verify", expect_ok=False)
            self.assertIn("送らない", out["results"]["claude"]["error"])
            self.assertEqual(seen, {}, "CloudWatch 以外の宛先にはトークンを送らない")
            out = self.run_cli("verify", env={"CW_OTEL_ALLOW_ANY_ENDPOINT": "1"})
            self.assertEqual(out["results"]["claude"]["http_status"], 200)
            self.assertEqual(seen["auth"], f"Bearer {SECRET}")
            self.assertEqual(seen["path"], "/v1/metrics")
            metric = seen["body"]["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]
            self.assertEqual(metric["name"], "cloudwatch_settings.setup.check")
        finally:
            srv.shutdown()
            srv.server_close()

    def test_status_reports_nothing_configured(self):
        st = self.run_cli("status", env={"FAKE_AWS_NO_CREDS": "1"})
        self.assertFalse(st["claude"]["configured"])
        self.assertFalse(st["codex"]["configured"])
        self.assertFalse(st["aws_identity"]["ready"])


if __name__ == "__main__":
    unittest.main()

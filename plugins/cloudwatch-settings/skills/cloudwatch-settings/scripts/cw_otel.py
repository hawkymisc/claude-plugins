#!/usr/bin/env python3
"""Claude Code と Codex の OpenTelemetry メトリクスを Amazon CloudWatch へ送る設定を行う。

標準ライブラリだけで動く（Python 3.8 以降）。結果は標準出力に JSON で1つ出す。
ベアラートークン（CloudWatch メトリクス API キー）は、標準出力・標準エラー・例外メッセージの
どこにも出さない。出すのは SHA-256 の先頭8桁（fingerprint）だけ。

サブコマンド:
  status      現状を調べる（何も変更しない）
  apply       設定を書き込む（--dry-run で計画だけ表示）
  verify      設定済みのトークンでテスト用データポイントを1つ送り、認証と宛先を確かめる
  dashboards  AWS 提供のダッシュボード定義を取得して put-dashboard する
  remove      このスクリプトが入れた設定を取り除く
"""

from __future__ import annotations

import argparse
import datetime as _dt
import getpass
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

try:  # Python 3.11+
    import tomllib  # type: ignore
except Exception:  # pragma: no cover - 古い Python
    tomllib = None  # type: ignore

VERSION = "0.1.0"
SERVICE_NAME = "cloudwatch.amazonaws.com"
POLICY_ARN = "arn:aws:iam::aws:policy/CloudWatchAPIKeyAccess"
BLOCK_BEGIN = "# >>> cloudwatch-settings (managed; do not edit by hand) >>>"
BLOCK_END = "# <<< cloudwatch-settings <<<"
BLOCK_RE = re.compile(
    r"(?ms)^# >>> cloudwatch-settings.*?^# <<< cloudwatch-settings[^\n]*\n?"
)
REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d+$")
CW_ENDPOINT_RE = re.compile(
    r"^https://monitoring\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?/v1/metrics$"
)
DASHBOARDS = {
    "claude": (
        "ClaudeCodeDashboard",
        "https://raw.githubusercontent.com/aws-observability/aws-observability-accelerator/"
        "main/artifacts/cloudwatch-dashboards/claude-code/claude-code.json",
    ),
    "codex": (
        "CodexDashboard",
        "https://raw.githubusercontent.com/aws-observability/aws-observability-accelerator/"
        "main/artifacts/cloudwatch-dashboards/codex/codex.json",
    ),
}
CLAUDE_KEYS = (
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_METRICS_EXPORTER",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
    "OTEL_RESOURCE_ATTRIBUTES",
)
IS_WINDOWS = os.name == "nt"


class Fail(Exception):
    """利用者（エージェント）に返すエラー。code で対処を引き分ける。"""

    def __init__(self, code: str, message: str, **extra):
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra


# ---------------------------------------------------------------- 共通

_SECRETS: set = set()


def remember_secret(token: str) -> str:
    """出力から必ず伏せる値として覚える。"""
    if token:
        _SECRETS.add(token)
    return token


def emit(obj: dict, exit_code: int = 0) -> None:
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    for secret in _SECRETS:  # 念のための最終防壁。通常はここに来る前に含めていない
        text = text.replace(secret, "***")
    sys.stdout.write(text + "\n")
    sys.exit(exit_code)


def fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:8]


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def home() -> Path:
    return Path.home()


def claude_settings_path() -> Path:
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(base) if base else home() / ".claude") / "settings.json"


def codex_config_path() -> Path:
    base = os.environ.get("CODEX_HOME")
    return (Path(base) if base else home() / ".codex") / "config.toml"


def state_path() -> Path:
    return home() / ".config" / "cloudwatch-settings" / "state.json"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def real_path(path: Path) -> Path:
    """シンボリックリンクをたどった先。書き込み・削除は必ずここに対して行う。"""
    return Path(os.path.realpath(str(path)))


def write_private(path: Path, text: str, backup: bool = True) -> None:
    """実体と同じディレクトリの一時ファイル経由で置き換える。POSIX では 0600 にする。

    path がシンボリックリンクなら、リンクは残してリンク先を書き換える（リンクを通常ファイルに
    置き換えると、リンクのある場所＝別のリポジトリなどにキーが書かれてしまう）。
    """
    path = real_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 控えを取るのは、まだキーが入っていない版だけ（キーの写しを増やさない）
    if backup and path.exists() and "Bearer " not in read_text(path):
        bak = path.with_name(path.name + ".bak-cloudwatch-settings")
        shutil.copyfile(path, bak)
        if not IS_WINDOWS:
            os.chmod(bak, 0o600)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        if not IS_WINDOWS:
            os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_state() -> dict:
    p = state_path()
    if not p.exists():
        return {}
    try:
        return json.loads(read_text(p))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    state["version"] = VERSION
    state["updated"] = now_iso()
    write_private(state_path(), json.dumps(state, ensure_ascii=False, indent=2) + "\n", backup=False)


def run(cmd: list, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=timeout)


def tool_info(name: str) -> dict:
    path = shutil.which(name)
    if not path:
        return {"found": False}
    info = {"found": True, "path": path}
    try:
        cp = run([path, "--version"], timeout=20)
        out = (cp.stdout or cp.stderr or "").strip().splitlines()
        if out:
            info["version"] = out[0][:120]
    except Exception:
        pass
    return info


def git_tracked(path: Path) -> dict | None:
    """設定ファイルの実体が git の作業ツリー内にあり、ignore されていなければ情報を返す。"""
    try:
        real = real_path(path)
    except OSError:
        return None
    for parent in real.parents:
        if (parent / ".git").exists():
            git = shutil.which("git")
            if git:
                try:
                    cp = run([git, "-C", str(parent), "check-ignore", "-q", str(real)], timeout=20)
                    if cp.returncode == 0:
                        return None
                except Exception:
                    pass
            return {"file": str(path), "real_path": str(real), "repo_root": str(parent)}
    return None


# ---------------------------------------------------------------- 属性

_ATTR_KEY_RE = re.compile(r"^[A-Za-z0-9_.]+$")
_ATTR_BAD_VALUE_RE = re.compile(r"[^\x21-\x7e]|[\",;\\=]")


def sanitize_value(value: str) -> str:
    cleaned = _ATTR_BAD_VALUE_RE.sub("-", value.strip())
    return cleaned or "unknown"


def default_label() -> str:
    return sanitize_value(socket.gethostname().split(".")[0])


def parse_attrs(text: str) -> dict:
    out = {}
    for part in (text or "").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip():
                out[k.strip()] = v.strip()
    return out


def format_attrs(attrs: dict) -> str:
    return ",".join(f"{k}={v}" for k, v in attrs.items())


def build_attrs(label: str, extra: list) -> dict:
    attrs = {
        "host.name": label,
        "team.id": label,
        "user.id": sanitize_value(getpass.getuser()),
        "environment": "personal",
    }
    for item in extra or []:
        if "=" not in item:
            raise Fail("bad_attr", f"--attr は key=value の形で指定する: {item!r}")
        k, v = item.split("=", 1)
        if not _ATTR_KEY_RE.match(k):
            raise Fail("bad_attr", f"属性名に使えない文字がある: {k!r}")
        attrs[k] = sanitize_value(v)
    return attrs


# ---------------------------------------------------------------- Claude Code

def load_claude_settings() -> dict:
    p = claude_settings_path()
    if not p.exists():
        return {}
    try:
        data = json.loads(read_text(p) or "{}")
    except json.JSONDecodeError as e:
        raise Fail("invalid_settings_json", f"{p} が JSON として読めない: {e}")
    if not isinstance(data, dict):
        raise Fail("invalid_settings_json", f"{p} の最上位がオブジェクトではない")
    return data


def header_token(headers: str) -> str | None:
    for part in (headers or "").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip().lower() == "authorization":
                m = re.match(r"^\s*Bearer\s+(\S+)\s*$", v)
                if m:
                    return remember_secret(m.group(1))
    return None


def claude_view(settings: dict) -> dict:
    env = settings.get("env") if isinstance(settings.get("env"), dict) else {}
    endpoint = env.get("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
    m = CW_ENDPOINT_RE.match(endpoint or "")
    token = header_token(env.get("OTEL_EXPORTER_OTLP_METRICS_HEADERS", ""))
    view = {
        "path": str(claude_settings_path()),
        "exists": claude_settings_path().exists(),
        "telemetry_enabled": env.get("CLAUDE_CODE_ENABLE_TELEMETRY") == "1",
        "metrics_exporter": env.get("OTEL_METRICS_EXPORTER"),
        "metrics_endpoint": endpoint,
        "region": m.group(1) if m else None,
        "has_token": bool(token),
        "token_fingerprint": fingerprint(token) if token else None,
        "resource_attributes": env.get("OTEL_RESOURCE_ATTRIBUTES"),
        "configured": bool(m and token and env.get("CLAUDE_CODE_ENABLE_TELEMETRY") == "1"
                           and "otlp" in (env.get("OTEL_METRICS_EXPORTER") or "")),
    }
    conflicts, warnings = [], []
    if endpoint and not m:
        conflicts.append("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT が CloudWatch 以外を指している")
    exporter = env.get("OTEL_METRICS_EXPORTER")
    if exporter and exporter != "otlp":
        conflicts.append(f"OTEL_METRICS_EXPORTER が {exporter!r}（このスキルは 'otlp' にする）")
    proto = env.get("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL")
    if proto and proto not in ("http/protobuf", "http/json"):
        conflicts.append(f"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL が {proto!r}（CloudWatch は HTTP のみ）")
    if env.get("OTEL_EXPORTER_OTLP_METRICS_HEADERS") and not token:
        conflicts.append("OTEL_EXPORTER_OTLP_METRICS_HEADERS に Bearer 以外のヘッダーがある")
    for k in ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_PROTOCOL"):
        if k in env:
            warnings.append(
                f"{k} が設定済み。メトリクスは信号別の変数が優先されるが、"
                "共通ヘッダーは CloudWatch へのリクエストにも付く"
            )
    if settings.get("otelHeadersHelper"):
        warnings.append("otelHeadersHelper が設定済み。そのヘッダーは CloudWatch へのリクエストにも付く")
    view["conflicts"] = conflicts
    view["warnings"] = warnings
    return view


def claude_apply(settings: dict, region: str, token: str, attrs: dict) -> dict:
    env = settings.get("env")
    if not isinstance(env, dict):
        env = {}
        settings["env"] = env
    merged = parse_attrs(env.get("OTEL_RESOURCE_ATTRIBUTES", ""))
    merged.update(attrs)
    env["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
    env["OTEL_METRICS_EXPORTER"] = "otlp"
    env["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"] = "http/protobuf"
    env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"] = endpoint_for(region)
    env["OTEL_EXPORTER_OTLP_METRICS_HEADERS"] = f"Authorization=Bearer {token}"
    env["OTEL_RESOURCE_ATTRIBUTES"] = format_attrs(merged)
    return settings


def overridden_attrs(settings: dict, attrs: dict, state: dict) -> dict:
    """このスキルが上書きすることになる、利用者の元の属性値（remove で戻すために覚えておく）。"""
    env = settings.get("env") if isinstance(settings.get("env"), dict) else {}
    before = parse_attrs(env.get("OTEL_RESOURCE_ATTRIBUTES", ""))
    prev_managed = parse_attrs(state.get("resource_attributes", ""))
    prev_overridden = state.get("claude_attrs_overridden") or {}
    out = {}
    for k in attrs:
        ours_already = k in prev_managed and before.get(k) == prev_managed[k]
        if k in before and not ours_already:
            if before[k] != attrs[k]:
                out[k] = before[k]
        elif k in prev_overridden:
            out[k] = prev_overridden[k]
    return out


def claude_remove(settings: dict, state: dict) -> bool:
    env = settings.get("env")
    if not isinstance(env, dict):
        return False
    if not CW_ENDPOINT_RE.match(env.get("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "")):
        return False
    for k in ("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
              "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "OTEL_METRICS_EXPORTER"):
        env.pop(k, None)
    other = [k for k in env if k in ("OTEL_LOGS_EXPORTER", "OTEL_TRACES_EXPORTER")]
    if not other:
        env.pop("CLAUDE_CODE_ENABLE_TELEMETRY", None)
    # 属性は、このスキルが入れた値のままのものだけを外し、上書きした元の値があれば戻す。
    # 記録（state）がなければ、どれが自分のものか分からないので触らない
    managed = parse_attrs(state.get("resource_attributes", ""))
    overridden = state.get("claude_attrs_overridden") or {}
    if managed and "OTEL_RESOURCE_ATTRIBUTES" in env:
        current = parse_attrs(env["OTEL_RESOURCE_ATTRIBUTES"])
        for k, v in managed.items():
            if current.get(k) == v:
                if k in overridden:
                    current[k] = overridden[k]
                else:
                    del current[k]
        if current:
            env["OTEL_RESOURCE_ATTRIBUTES"] = format_attrs(current)
        else:
            env.pop("OTEL_RESOURCE_ATTRIBUTES", None)
    if not env:
        settings.pop("env", None)
    return True


def dump_settings(settings: dict) -> str:
    return json.dumps(settings, ensure_ascii=False, indent=2) + "\n"


# ---------------------------------------------------------------- Codex

def endpoint_for(region: str) -> str:
    return f"https://monitoring.{region}.amazonaws.com/v1/metrics"


def toml_str(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def codex_block(region: str, token: str) -> str:
    return "\n".join([
        BLOCK_BEGIN,
        "[otel.metrics_exporter.otlp-http]",
        f"endpoint = {toml_str(endpoint_for(region))}",
        'protocol = "binary"',
        "",
        "[otel.metrics_exporter.otlp-http.headers]",
        f"Authorization = {toml_str('Bearer ' + token)}",
        BLOCK_END,
        "",
    ])


def codex_split(text: str):
    m = BLOCK_RE.search(text)
    block = m.group(0) if m else ""
    rest = BLOCK_RE.sub("", text)
    return rest, block


def codex_unmanaged_conflict(rest: str, path: Path) -> str | None:
    if tomllib is not None:
        try:
            data = tomllib.loads(rest)
        except Exception as e:
            raise Fail("invalid_codex_toml", f"{path} が TOML として読めない: {e}")
        otel = data.get("otel")
        if isinstance(otel, dict) and "metrics_exporter" in otel:
            return "[otel] の metrics_exporter がすでに定義されている"
        return None
    if re.search(r"(?m)^\s*\[otel\.metrics_exporter", rest) or re.search(
        r"(?m)^\s*(otel\.)?metrics_exporter\s*[=.]", rest
    ):
        return "[otel] の metrics_exporter がすでに定義されているように見える"
    return None


def codex_view() -> dict:
    p = codex_config_path()
    view = {"path": str(p), "exists": p.exists(), "configured": False, "has_token": False,
            "token_fingerprint": None, "region": None, "metrics_endpoint": None,
            "conflicts": [], "warnings": []}
    if not p.exists():
        return view
    rest, block = codex_split(read_text(p))
    if block:
        m = re.search(r'(?m)^endpoint\s*=\s*"([^"]+)"', block)
        t = re.search(r'(?m)^Authorization\s*=\s*"Bearer ([^"]+)"', block)
        if m:
            view["metrics_endpoint"] = m.group(1)
            em = CW_ENDPOINT_RE.match(m.group(1))
            view["region"] = em.group(1) if em else None
        if t:
            view["has_token"] = True
            view["token_fingerprint"] = fingerprint(t.group(1))
        view["configured"] = bool(m and t)
    try:
        conflict = codex_unmanaged_conflict(rest, p)
    except Fail as e:
        conflict = e.message
    if conflict:
        view["conflicts"].append(conflict)
    if re.search(r"(?m)^\s*environment\s*=", rest) and "[otel]" in rest:
        view["warnings"].append(
            "[otel] environment が設定されている場合、ラベルは @resource.env になり、"
            "AWS のダッシュボード（@resource.environment）とは別になる"
        )
    return view


def codex_existing_token() -> str | None:
    p = codex_config_path()
    if not p.exists():
        return None
    _, block = codex_split(read_text(p))
    t = re.search(r'(?m)^Authorization\s*=\s*"Bearer ([^"]+)"', block)
    return remember_secret(t.group(1)) if t else None


def codex_new_text(region: str, token: str) -> str:
    p = codex_config_path()
    rest = ""
    if p.exists():
        rest, _ = codex_split(read_text(p))
    rest = rest.rstrip("\n")
    text = (rest + "\n\n" if rest else "") + codex_block(region, token)
    if tomllib is not None:
        try:
            tomllib.loads(text)
        except Exception as e:  # トークンを含みうるので詳細は出さない
            raise Fail("invalid_codex_toml", f"書き込み後の {p} が TOML として不正になる（{type(e).__name__}）")
    return text


# ---------------------------------------------------------------- シェルの環境変数（Codex 用）

def shell_rc_path() -> Path | None:
    shell = os.path.basename(os.environ.get("SHELL", ""))
    if shell == "zsh":
        return Path(os.environ.get("ZDOTDIR") or home()) / ".zshrc"
    if shell == "bash":
        if platform.system() == "Darwin" and (home() / ".bash_profile").exists():
            return home() / ".bash_profile"
        return home() / ".bashrc"
    return None


def shell_env_view() -> dict:
    if IS_WINDOWS:
        value = None
        try:
            cp = run(["reg", "query", r"HKCU\Environment", "/v", "OTEL_RESOURCE_ATTRIBUTES"], timeout=20)
            if cp.returncode == 0:
                m = re.search(r"OTEL_RESOURCE_ATTRIBUTES\s+REG_\w+\s+(.*)", cp.stdout)
                value = m.group(1).strip() if m else None
        except Exception:
            pass
        return {"kind": "windows-user-env", "value": value, "configured": bool(value)}
    rc = shell_rc_path()
    if rc is None:
        return {"kind": "unsupported-shell", "shell": os.environ.get("SHELL"), "configured": False}
    configured = rc.exists() and bool(BLOCK_RE.search(read_text(rc)))
    return {"kind": "rc-file", "path": str(rc), "configured": configured}


def shell_env_apply(attrs: dict) -> dict:
    value = format_attrs(attrs)
    if IS_WINDOWS:
        cp = run(["setx", "OTEL_RESOURCE_ATTRIBUTES", value], timeout=30)
        if cp.returncode != 0:
            raise Fail("shell_env_failed", f"setx に失敗: {cp.stderr.strip()[:300]}")
        return {"kind": "windows-user-env", "note": "新しく開いたターミナルから有効"}
    rc = shell_rc_path()
    if rc is None:
        return {"kind": "unsupported-shell", "skipped": True,
                "manual_line": f"export OTEL_RESOURCE_ATTRIBUTES={shlex.quote(value)}"}
    rest = BLOCK_RE.sub("", read_text(rc)) if rc.exists() else ""
    rest = rest.rstrip("\n")
    block = f"{BLOCK_BEGIN}\nexport OTEL_RESOURCE_ATTRIBUTES={shlex.quote(value)}\n{BLOCK_END}\n"
    mode = (rc.stat().st_mode & 0o777) if rc.exists() else 0o644
    rc.parent.mkdir(parents=True, exist_ok=True)
    rc.write_text((rest + "\n\n" if rest else "") + block, encoding="utf-8")
    os.chmod(rc, mode)
    return {"kind": "rc-file", "path": str(rc), "note": "新しく開いたシェルから有効"}


def shell_env_remove() -> dict:
    if IS_WINDOWS:
        cp = run(["reg", "delete", r"HKCU\Environment", "/v", "OTEL_RESOURCE_ATTRIBUTES", "/f"], timeout=30)
        return {"kind": "windows-user-env", "removed": cp.returncode == 0}
    rc = shell_rc_path()
    if rc is None or not rc.exists():
        return {"removed": False}
    text = read_text(rc)
    if not BLOCK_RE.search(text):
        return {"removed": False}
    mode = rc.stat().st_mode & 0o777
    rc.write_text(BLOCK_RE.sub("", text).rstrip("\n") + "\n", encoding="utf-8")
    os.chmod(rc, mode)
    return {"kind": "rc-file", "path": str(rc), "removed": True}


# ---------------------------------------------------------------- AWS

class Aws:
    def __init__(self, profile: str | None):
        self.bin = shutil.which("aws")
        self.profile = profile

    def call(self, *args: str, timeout: int = 90) -> subprocess.CompletedProcess:
        if not self.bin:
            raise Fail("aws_not_ready", "AWS CLI（aws）が見つからない")
        cmd = [self.bin]
        if self.profile:
            cmd += ["--profile", self.profile]
        cmd += list(args) + ["--output", "json"]
        try:
            return run(cmd, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise Fail("aws_failed", f"aws {' '.join(args[:2])} が時間内に終わらなかった")

    def ok(self, *args: str) -> dict:
        cp = self.call(*args)
        if cp.returncode != 0:
            raise Fail("aws_failed", f"aws {' '.join(args[:2])} に失敗: {cp.stderr.strip()[:500]}")
        return json.loads(cp.stdout) if cp.stdout.strip() else {}

    def identity(self) -> dict:
        if not self.bin:
            return {"ready": False, "reason": "AWS CLI が見つからない"}
        try:
            cp = self.call("sts", "get-caller-identity", timeout=30)
        except Fail as e:
            return {"ready": False, "reason": e.message}
        if cp.returncode != 0:
            return {"ready": False, "reason": cp.stderr.strip()[:300] or "認証情報がない"}
        try:
            d = json.loads(cp.stdout)
        except Exception:
            return {"ready": False, "reason": "sts の応答を読めない"}
        return {"ready": True, "account": d.get("Account"), "arn": d.get("Arn")}

    def list_credentials(self, user: str) -> list:
        cp = self.call("iam", "list-service-specific-credentials", "--user-name", user,
                       "--service-name", SERVICE_NAME)
        if cp.returncode != 0:
            if "NoSuchEntity" in cp.stderr:
                return []
            raise Fail("aws_failed", f"既存の API キーを一覧できない: {cp.stderr.strip()[:500]}")
        creds = json.loads(cp.stdout or "{}").get("ServiceSpecificCredentials", [])
        return sorted(creds, key=lambda c: str(c.get("CreateDate", "")))

    def delete_credential(self, user: str, cred_id: str) -> None:
        self.ok("iam", "delete-service-specific-credential", "--user-name", user,
                "--service-specific-credential-id", cred_id)

    def create_key(self, user: str, age_days: int | None, rotate: bool):
        """IAM ユーザーと API キーを作り、(secret, 情報, 消すべき旧キーID) を返す。secret は表示しない。"""
        cp = self.call("iam", "create-user", "--user-name", user)
        created_user = cp.returncode == 0
        if not created_user and "EntityAlreadyExists" not in cp.stderr:
            raise Fail("aws_failed", f"IAM ユーザーを作れない: {cp.stderr.strip()[:500]}")
        self.ok("iam", "attach-user-policy", "--user-name", user, "--policy-arn", POLICY_ARN)
        existing = self.list_credentials(user)
        if existing and not rotate:
            raise Fail(
                "existing_key",
                f"IAM ユーザー {user} にはすでに CloudWatch の API キーがある。"
                "シークレットは作成時にしか取得できない。作り直すなら --rotate を付ける",
                credentials=[{"id": c.get("ServiceSpecificCredentialId"),
                              "created": str(c.get("CreateDate")), "status": c.get("Status"),
                              "expires": str(c.get("ExpirationDate")) if c.get("ExpirationDate") else None}
                             for c in existing],
            )
        old_ids = [c.get("ServiceSpecificCredentialId") for c in existing]
        while len(old_ids) >= 2:  # 1ユーザーあたりの上限に当たらないよう、古いものから空ける
            self.delete_credential(user, old_ids.pop(0))
        args = ["iam", "create-service-specific-credential", "--user-name", user,
                "--service-name", SERVICE_NAME]
        if age_days:
            args += ["--credential-age-days", str(age_days)]
        cp = self.call(*args)
        if cp.returncode != 0:
            raise Fail("aws_failed", f"API キーを作れない: {cp.stderr.strip()[:500]}")
        try:
            cred = json.loads(cp.stdout)["ServiceSpecificCredential"]
            secret = remember_secret(cred["ServiceCredentialSecret"])
        except Exception:
            raise Fail("aws_failed", "API キー作成の応答に ServiceCredentialSecret がない（AWS CLI が古い可能性）")
        info = {
            "iam_user": user,
            "iam_user_created": created_user,
            "credential_id": cred.get("ServiceSpecificCredentialId"),
            "credential_expires": str(cred["ExpirationDate"]) if cred.get("ExpirationDate") else None,
        }
        return secret, info, old_ids


def iam_user_name(label: str) -> str:
    name = "coding-agents-otel-" + re.sub(r"[^A-Za-z0-9+=,.@_-]", "-", label)
    return name[:64]


# ---------------------------------------------------------------- トークンの取得

def validate_token(token: str, source: str) -> str:
    token = remember_secret((token or "").strip())
    if not token:
        raise Fail("no_token", f"{source} からトークンを取得できなかった（空）")
    if re.search(r"\s", token) or not re.match(r"^[\x21-\x7e]+$", token):
        raise Fail("bad_token", f"{source} の内容が API キーに見えない（空白や改行、非 ASCII 文字を含む）")
    if len(token) < 20:
        raise Fail("bad_token", f"{source} の内容が API キーにしては短すぎる（{len(token)} 文字）")
    if token.lower().startswith("bearer"):
        raise Fail("bad_token", "先頭の 'Bearer ' を除いた値だけを渡す")
    return token


def clipboard_commands() -> list:
    if IS_WINDOWS:
        return [["powershell", "-NoProfile", "-Command", "Get-Clipboard"]]
    if platform.system() == "Darwin":
        return [["pbpaste"]]
    return [["wl-paste", "-n"], ["xclip", "-selection", "clipboard", "-o"], ["xsel", "-b", "-o"]]


def clipboard_available() -> bool:
    return any(shutil.which(c[0]) for c in clipboard_commands())


def read_clipboard() -> str:
    for cmd in clipboard_commands():
        if not shutil.which(cmd[0]):
            continue
        try:
            cp = run(cmd, timeout=15)
        except Exception:
            continue
        if cp.returncode == 0:
            return cp.stdout
    raise Fail("no_clipboard", "クリップボードを読めない。--token-source file を使う")


def existing_token() -> str | None:
    try:
        env = load_claude_settings().get("env") or {}
    except Fail:
        env = {}
    tok = header_token(env.get("OTEL_EXPORTER_OTLP_METRICS_HEADERS", "")) if isinstance(env, dict) else None
    return tok or codex_existing_token()


# ---------------------------------------------------------------- サブコマンド

def detect_targets() -> list:
    out = []
    if shutil.which("claude") or claude_settings_path().parent.exists():
        out.append("claude")
    if shutil.which("codex") or codex_config_path().parent.exists():
        out.append("codex")
    return out


def parse_targets(value: str) -> list:
    if value == "auto":
        return detect_targets()
    targets = [t.strip() for t in value.split(",") if t.strip()]
    for t in targets:
        if t not in ("claude", "codex"):
            raise Fail("bad_target", f"--targets は claude / codex / auto: {t!r}")
    return targets


def expiry_note(expires: str | None) -> dict | None:
    if not expires:
        return None
    try:
        dt = _dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
    except Exception:
        return {"expires": expires}
    days = (dt - _dt.datetime.now(_dt.timezone.utc)).days
    return {"expires": expires, "days_left": days, "expired": days < 0, "expiring_soon": 0 <= days <= 14}


def cmd_status(args) -> None:
    try:
        settings = load_claude_settings()
        claude = claude_view(settings)
    except Fail as e:
        claude = {"path": str(claude_settings_path()), "exists": True, "configured": False,
                  "conflicts": [e.message], "warnings": []}
    codex = codex_view()
    state = load_state()
    tracked = [t for t in (git_tracked(claude_settings_path()), git_tracked(codex_config_path())) if t]
    fps = {v for v in (claude.get("token_fingerprint"), codex.get("token_fingerprint")) if v}
    emit({
        "ok": True,
        "script_version": VERSION,
        "platform": {"system": platform.system(), "release": platform.release(),
                     "machine": platform.machine(), "python": platform.python_version(),
                     "wsl": "microsoft" in platform.release().lower()},
        "default_label": default_label(),
        "tools": {"aws": tool_info("aws"), "claude": tool_info("claude"), "codex": tool_info("codex")},
        "aws_identity": Aws(args.aws_profile).identity(),
        "detected_targets": detect_targets(),
        "claude": claude,
        "codex": codex,
        "codex_shell_env": shell_env_view(),
        "same_token_in_both": (len(fps) == 1) if (claude.get("has_token") and codex.get("has_token")) else None,
        "git_tracked": tracked,
        "clipboard_available": clipboard_available(),
        "state": state,
        "key_expiry": expiry_note(state.get("credential_expires")),
    })


def cmd_apply(args) -> None:
    if not REGION_RE.match(args.region):
        raise Fail("bad_region", f"リージョン名の形ではない: {args.region!r}")
    targets = parse_targets(args.targets)
    if not targets:
        raise Fail("no_targets", "Claude Code も Codex も見つからない。--targets で明示する")
    label = sanitize_value(args.label) if args.label else default_label()
    attrs = build_attrs(label, args.attr)

    # 1. 事前確認（AWS にもクリップボードにも触る前）
    plan = {"region": args.region, "endpoint": endpoint_for(args.region), "targets": targets,
            "label": label, "resource_attributes": format_attrs(attrs),
            "token_source": args.token_source, "files": []}
    conflicts = {}
    settings = None
    if "claude" in targets:
        settings = load_claude_settings()
        view = claude_view(settings)
        if view["conflicts"]:
            conflicts["claude"] = view["conflicts"]
        plan["files"].append(str(claude_settings_path()))
        plan["claude_warnings"] = view["warnings"]
    if "codex" in targets:
        p = codex_config_path()
        if p.exists():
            rest, _ = codex_split(read_text(p))
            c = codex_unmanaged_conflict(rest, p)
            if c:
                conflicts["codex"] = [c]
            else:  # 追記後も TOML として正しいかを、仮の値で先に確かめる（キーを作る前）
                codex_new_text(args.region, "placeholder-token-0000000000")
        plan["files"].append(str(p))
    if conflicts.get("codex"):
        raise Fail("conflict_codex",
                   "Codex の config.toml に、このスキルの管理外の metrics_exporter がある。"
                   "利用者に確認のうえ手で取り除いてからやり直す", conflicts=conflicts)
    if conflicts.get("claude") and not args.overwrite:
        raise Fail("conflict_claude",
                   "Claude Code の settings.json に、別の送信先向けと思われる OTel 設定がある。"
                   "上書きしてよいか利用者に確認し、よければ --overwrite を付ける", conflicts=conflicts)
    tracked = []
    for t in targets:
        info = git_tracked(claude_settings_path() if t == "claude" else codex_config_path())
        if info:
            tracked.append(info)
    if tracked and not args.allow_git_tracked:
        raise Fail("git_tracked",
                   "設定ファイルの実体が git の作業ツリー内にあり、ignore されていない。"
                   "このまま書くと API キーがコミットされうる", files=tracked)

    shell_mode = args.shell_env
    if "codex" not in targets:
        shell_mode = "skip"
    plan["codex_shell_env"] = shell_mode
    if shell_mode == "auto":
        plan["codex_shell_env_target"] = shell_env_view()

    if args.token_source == "aws-cli":
        if not (args.age_days or args.no_expiry):
            raise Fail("need_expiry", "--age-days N か --no-expiry のどちらかを指定する")
        iam_user = args.iam_user or iam_user_name(label)
        plan["iam_user"] = iam_user
        plan["key_age_days"] = args.age_days
    if args.token_source == "file" and not args.token_file:
        raise Fail("need_token_file", "--token-source file には --token-file が要る")

    if args.dry_run:
        emit({"ok": True, "dry_run": True, "plan": plan})

    # 2. トークンを得る
    aws = Aws(args.aws_profile)
    key_info, old_ids = {}, []
    if args.token_source == "aws-cli":
        ident = aws.identity()
        if not ident.get("ready"):
            raise Fail("aws_not_ready", f"AWS CLI が使える状態ではない: {ident.get('reason')}")
        token, key_info, old_ids = aws.create_key(plan["iam_user"], args.age_days, args.rotate)
        key_info["account"] = ident.get("account")
    elif args.token_source == "clipboard":
        token = validate_token(read_clipboard(), "クリップボード")
    elif args.token_source == "file":
        tf = Path(os.path.expanduser(args.token_file))
        if not tf.exists():
            raise Fail("no_token", f"トークンファイルがない: {tf}")
        token = validate_token(read_text(tf), "トークンファイル")
    else:  # existing
        tok = existing_token()
        if not tok:
            raise Fail("no_token", "設定済みのトークンが見つからない")
        token = validate_token(tok, "既存の設定")

    # 3. 書き込む。全ファイルの新しい内容を先に作り、途中で失敗したら書いた分を元に戻す
    attrs_overridden = overridden_attrs(settings, attrs, load_state()) if "claude" in targets else None
    written, originals = [], {}
    try:
        pending = []
        if "claude" in targets:
            pending.append((claude_settings_path(),
                            dump_settings(claude_apply(settings, args.region, token, attrs))))
        if "codex" in targets:
            pending.append((codex_config_path(), codex_new_text(args.region, token)))
        for path, _ in pending:
            originals[path] = read_text(path) if path.exists() else None
        for path, text in pending:
            write_private(path, text)
            written.append(str(path))
    except Exception as e:
        restored = []
        for path_str in written:
            path = Path(path_str)
            try:
                if originals.get(path) is None:
                    real_path(path).unlink()
                else:
                    write_private(path, originals[path], backup=False)
                restored.append(path_str)
            except Exception:
                pass
        rolled_back = False
        if key_info.get("credential_id"):
            try:
                aws.delete_credential(key_info["iam_user"], key_info["credential_id"])
                rolled_back = True
            except Exception:
                pass
        msg = e.message if isinstance(e, Fail) else f"{type(e).__name__}"
        raise Fail("write_failed", f"設定ファイルを書けなかった: {msg}",
                   written=written, restored=restored, new_key_deleted=rolled_back)

    shell_result = None
    if shell_mode == "auto":
        try:
            shell_result = shell_env_apply(attrs)
        except Fail as e:
            shell_result = {"error": e.message}

    deleted_old = []
    for cid in old_ids:
        try:
            aws.delete_credential(key_info["iam_user"], cid)
            deleted_old.append(cid)
        except Fail:
            pass

    if args.token_source == "file" and not args.keep_token_file:
        try:
            Path(os.path.expanduser(args.token_file)).unlink()
        except OSError:
            pass

    state = load_state()
    state.update({"region": args.region, "label": label, "targets": targets,
                  "token_fingerprint": fingerprint(token), "token_source": args.token_source,
                  "resource_attributes": format_attrs(attrs)})
    if attrs_overridden is not None:
        state["claude_attrs_overridden"] = attrs_overridden
    if key_info:
        state.update({k: key_info.get(k) for k in
                      ("iam_user", "credential_id", "credential_expires", "account")})
        if args.aws_profile:
            state["aws_profile"] = args.aws_profile
    elif args.token_source != "existing":
        for k in ("iam_user", "credential_id", "credential_expires", "account"):
            state.pop(k, None)
    save_state(state)

    emit({
        "ok": True,
        "written": written,
        "token_fingerprint": fingerprint(token),
        "key": key_info or None,
        "old_keys_deleted": deleted_old,
        "codex_shell_env": shell_result,
        "token_file_deleted": args.token_source == "file" and not args.keep_token_file,
        "next": ["Claude Code と Codex は、次に起動したセッションから送信を始める",
                 "verify で認証と宛先を確かめる"],
    })


def cmd_verify(args) -> None:
    targets = {}
    try:
        env = load_claude_settings().get("env") or {}
    except Fail:
        env = {}
    tok = header_token(env.get("OTEL_EXPORTER_OTLP_METRICS_HEADERS", "")) if isinstance(env, dict) else None
    if tok and env.get("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"):
        targets["claude"] = (env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"], tok)
    cv = codex_view()
    ctok = codex_existing_token()
    if ctok and cv.get("metrics_endpoint"):
        targets["codex"] = (cv["metrics_endpoint"], ctok)
    if not targets:
        raise Fail("no_token", "設定済みのトークンが見つからない。先に apply する")
    allow_any = os.environ.get("CW_OTEL_ALLOW_ANY_ENDPOINT") == "1"  # テスト用
    results, seen = {}, {}
    for name, (endpoint, token) in targets.items():
        if not allow_any and not CW_ENDPOINT_RE.match(endpoint):
            results[name] = {"ok": False, "endpoint": endpoint,
                             "error": "CloudWatch の OTLP メトリクスの宛先ではないので送らない"}
            continue
        key = (endpoint, token)
        if key in seen:
            results[name] = dict(results[seen[key]], same_as=seen[key])
            continue
        seen[key] = name
        results[name] = dict(send_check(endpoint, token), endpoint=endpoint,
                             token_fingerprint=fingerprint(token))
    emit({"ok": all(r.get("ok") for r in results.values()), "results": results,
          "note": "ok はテスト用データポイント cloudwatch_settings.setup.check が受理されたことを示す。"
                  "各ツールの実データは、新しいセッションを動かした数分後に Query Studio で確かめる"},
         0 if all(r.get("ok") for r in results.values()) else 1)


def send_check(endpoint: str, token: str) -> dict:
    body = json.dumps({"resourceMetrics": [{
        "resource": {"attributes": [
            {"key": "service.name", "value": {"stringValue": "cloudwatch-settings"}},
            {"key": "host.name", "value": {"stringValue": default_label()}},
        ]},
        "scopeMetrics": [{"scope": {"name": "cloudwatch-settings", "version": VERSION}, "metrics": [{
            "name": "cloudwatch_settings.setup.check", "unit": "1",
            "gauge": {"dataPoints": [{"asInt": "1", "timeUnixNano": str(time.time_ns())}]},
        }]}],
    }]}).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read(2000).decode("utf-8", "replace")
            return {"ok": 200 <= resp.status < 300, "http_status": resp.status, "response": text[:500]}
    except urllib.error.HTTPError as e:
        text = e.read(2000).decode("utf-8", "replace")
        hint = None
        if e.code in (401, 403):
            hint = "トークンが無効・失効・期限切れか、リージョンが違う"
        return {"ok": False, "http_status": e.code, "response": text[:500], "hint": hint}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}".replace(token, "***")}


def cmd_dashboards(args) -> None:
    if not REGION_RE.match(args.region):
        raise Fail("bad_region", f"リージョン名の形ではない: {args.region!r}")
    aws = Aws(args.aws_profile)
    ident = aws.identity()
    if not ident.get("ready"):
        raise Fail("aws_not_ready", f"AWS CLI が使える状態ではない: {ident.get('reason')}")
    results = {}
    for target in parse_targets(args.targets) if args.targets != "auto" else ["claude", "codex"]:
        name, url = DASHBOARDS[target]
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                text = resp.read().decode("utf-8")
        except Exception as e:
            results[target] = {"ok": False, "error": f"定義を取得できない: {type(e).__name__}: {str(e)[:200]}"}
            continue
        text = text.replace("${REGION}", args.region)
        text = re.sub(r'("region"\s*:\s*)"[^"]*"', lambda m: f'{m.group(1)}"{args.region}"', text)
        try:
            json.loads(text)
        except Exception:
            results[target] = {"ok": False, "error": "取得した定義が JSON ではない"}
            continue
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / f"{name}.json"
            f.write_text(text, encoding="utf-8")
            cp = aws.call("cloudwatch", "put-dashboard", "--dashboard-name", name,
                          "--dashboard-body", f"file://{f}", "--region", args.region)
        if cp.returncode != 0:
            results[target] = {"ok": False, "error": cp.stderr.strip()[:500]}
        else:
            msgs = (json.loads(cp.stdout or "{}") or {}).get("DashboardValidationMessages", [])
            results[target] = {
                "ok": True, "dashboard": name, "validation_messages": msgs,
                "url": f"https://{args.region}.console.aws.amazon.com/cloudwatch/home"
                       f"?region={args.region}#dashboards/dashboard/{name}"}
    ok = all(r.get("ok") for r in results.values())
    emit({"ok": ok, "account": ident.get("account"), "results": results}, 0 if ok else 1)


def cmd_remove(args) -> None:
    targets = parse_targets(args.targets) if args.targets != "auto" else ["claude", "codex"]
    state = load_state()
    out = {"ok": True, "removed": {}}
    if "claude" in targets and claude_settings_path().exists():
        settings = load_claude_settings()
        if claude_remove(settings, state):
            write_private(claude_settings_path(), dump_settings(settings))
            out["removed"]["claude"] = True
    if "codex" in targets and codex_config_path().exists():
        text = read_text(codex_config_path())
        if BLOCK_RE.search(text):
            rest, _ = codex_split(text)
            write_private(codex_config_path(), rest.rstrip("\n") + "\n" if rest.strip() else "")
            out["removed"]["codex"] = True
        out["removed"]["codex_shell_env"] = shell_env_remove()
    aws = Aws(args.aws_profile or state.get("aws_profile"))
    if args.delete_key:
        user = args.iam_user or state.get("iam_user")
        if not user:
            out["key"] = {"deleted": False, "reason": "IAM ユーザー名が分からない（--iam-user で指定する）"}
        else:
            deleted = []
            for c in aws.list_credentials(user):
                aws.delete_credential(user, c["ServiceSpecificCredentialId"])
                deleted.append(c["ServiceSpecificCredentialId"])
            aws.call("iam", "detach-user-policy", "--user-name", user, "--policy-arn", POLICY_ARN)
            cp = aws.call("iam", "delete-user", "--user-name", user)
            out["key"] = {"credentials_deleted": deleted, "iam_user": user,
                          "iam_user_deleted": cp.returncode == 0,
                          "error": None if cp.returncode == 0 else cp.stderr.strip()[:300]}
    if args.delete_dashboards:
        region = args.region or state.get("region")
        if not region:
            out["dashboards"] = {"deleted": False, "reason": "リージョンが分からない（--region で指定する）"}
        else:
            cp = aws.call("cloudwatch", "delete-dashboards", "--dashboard-names",
                          *[DASHBOARDS[t][0] for t in ("claude", "codex")], "--region", region)
            out["dashboards"] = {"deleted": cp.returncode == 0,
                                 "error": None if cp.returncode == 0 else cp.stderr.strip()[:300]}
    if set(targets) >= {"claude", "codex"} and state_path().exists():
        if args.delete_key or not state.get("credential_id"):
            state_path().unlink()
        else:
            out["note"] = ("IAM の API キーは残っている。不要なら --delete-key を付けて実行するか、"
                           "CloudWatch コンソールの Settings > API keys から消す")
    emit(out)


# ---------------------------------------------------------------- main

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("status", help="現状を調べる")
    s.add_argument("--aws-profile")
    s.set_defaults(func=cmd_status)

    a = sub.add_parser("apply", help="設定を書き込む")
    a.add_argument("--region", required=True)
    a.add_argument("--targets", default="auto", help="claude,codex / auto（既定）")
    a.add_argument("--token-source", required=True, choices=["aws-cli", "clipboard", "file", "existing"])
    a.add_argument("--token-file")
    a.add_argument("--keep-token-file", action="store_true", help="取り込み後もトークンファイルを残す")
    a.add_argument("--label", help="このマシンの呼び名（既定：ホスト名）")
    a.add_argument("--attr", action="append", default=[], help="追加のリソース属性 key=value（複数可）")
    a.add_argument("--iam-user", help="aws-cli のとき：IAM ユーザー名（既定 coding-agents-otel-<label>）")
    a.add_argument("--age-days", type=int, help="aws-cli のとき：API キーの有効日数")
    a.add_argument("--no-expiry", action="store_true", help="aws-cli のとき：期限を付けない")
    a.add_argument("--rotate", action="store_true", help="aws-cli のとき：既存キーを新しいものに取り替える")
    a.add_argument("--aws-profile")
    a.add_argument("--shell-env", default="auto", choices=["auto", "skip"],
                   help="Codex 用に OTEL_RESOURCE_ATTRIBUTES をシェルへ設定するか")
    a.add_argument("--overwrite", action="store_true", help="Claude Code 側の別宛先の OTel 設定を上書きする")
    a.add_argument("--allow-git-tracked", action="store_true")
    a.add_argument("--dry-run", action="store_true")
    a.set_defaults(func=cmd_apply)

    v = sub.add_parser("verify", help="テスト用データポイントを送る")
    v.set_defaults(func=cmd_verify)

    d = sub.add_parser("dashboards", help="ダッシュボードをデプロイする")
    d.add_argument("--region", required=True)
    d.add_argument("--targets", default="auto")
    d.add_argument("--aws-profile")
    d.set_defaults(func=cmd_dashboards)

    r = sub.add_parser("remove", help="設定を取り除く")
    r.add_argument("--targets", default="auto")
    r.add_argument("--delete-key", action="store_true", help="IAM の API キーとユーザーも消す")
    r.add_argument("--delete-dashboards", action="store_true")
    r.add_argument("--iam-user")
    r.add_argument("--region")
    r.add_argument("--aws-profile")
    r.set_defaults(func=cmd_remove)
    return p


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except Fail as e:
        emit({"ok": False, "error": dict({"code": e.code, "message": e.message}, **e.extra)}, 1)
    except subprocess.TimeoutExpired:
        emit({"ok": False, "error": {"code": "timeout", "message": "外部コマンドが時間内に終わらなかった"}}, 1)
    except Exception as e:
        emit({"ok": False, "error": {"code": "internal",
                                     "message": f"{type(e).__name__}: {str(e)[:300]}"}}, 1)


if __name__ == "__main__":
    main()

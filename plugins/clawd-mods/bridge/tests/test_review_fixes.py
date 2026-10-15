"""レビュー指摘 (2026-10-15) の再発防止テスト。"""

import shutil
import socket
import tempfile
from pathlib import Path

import pytest

from clawd_bridge.main import socket_is_live
from clawd_bridge.registry import STALE_SEC, TOTAL_MAX, Registry, parse_event
from clawd_bridge.server import REGISTRY_KEY, make_app


def test_app_uses_the_given_empty_registry():
    # 空の Registry は len()==0 で falsy。`or` で差し替えると prune が別インスタンスに効く (SPEC §4)
    r = Registry()
    app = make_app(link=object(), registry=r)  # type: ignore[arg-type]
    assert app[REGISTRY_KEY] is r


@pytest.mark.parametrize(
    "bad",
    [
        {"v": True, "session": "A", "state": "idle"},  # True == 1 を通さない
        {"v": 1, "session": "A", "state": ["idle"]},
        {"v": 1, "session": "A", "state": "tool", "category": {"x": 1}},
        {"v": 1, "session": "A" * 65, "state": "idle"},
        [],
    ],
)
def test_parse_event_rejects_wrong_types(bad):
    with pytest.raises(ValueError):
        parse_event(bad)


def test_total_is_clamped_for_firmware():
    # FW は total>99 を拒否する (snapshot.h)
    r = Registry()
    for i in range(TOTAL_MAX + 5):
        r.apply(parse_event({"v": 1, "session": f"s{i}", "state": "idle"}), now=i)
    assert r.snapshot().split("|")[1] == str(TOTAL_MAX)


def test_end_for_unknown_session_is_noop():
    r = Registry()
    r.apply(parse_event({"v": 1, "session": "ghost", "state": "end"}), now=0)
    assert r.snapshot() == "1|0"


def test_prune_boundary_keeps_exactly_stale_sec():
    r = Registry()
    r.apply(parse_event({"v": 1, "session": "A", "state": "idle"}), now=0)
    assert r.prune(now=STALE_SEC) is False
    assert r.prune(now=STALE_SEC + 0.001) is True


def test_socket_is_live_detects_running_server():
    # macOS の AF_UNIX パスは 104 byte 制限。pytest の tmp_path は長すぎるので /tmp 直下を使う
    tmp = Path(tempfile.mkdtemp(prefix="cb", dir="/tmp"))
    path = tmp / "b.sock"
    assert socket_is_live(path) is False
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv:
        srv.bind(str(path))
        srv.listen(1)
        assert socket_is_live(path) is True
    assert socket_is_live(path) is False  # 残骸ファイルだけなら stale 扱い
    shutil.rmtree(tmp)

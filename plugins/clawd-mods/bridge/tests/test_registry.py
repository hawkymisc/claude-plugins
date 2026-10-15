"""SPEC §4 スナップショット / セッション管理の仕様テスト。"""

import pytest

from clawd_bridge.registry import MAX_SLOTS, STALE_SEC, Registry, parse_event


def ev(session, state, category=None, tool=None):
    e = {"v": 1, "session": session, "label": "p", "state": state}
    if category:
        e["category"] = category
    if tool:
        e["tool"] = tool
    return parse_event(e)


def test_empty_snapshot():
    assert Registry().snapshot() == "1|0"


def test_single_session_snapshot():
    r = Registry()
    r.apply(ev("A", "tool", "write", "Edit"), now=0)
    assert r.snapshot() == "1|1|tool,write,Edit"


def test_missing_fields_are_dashes():
    r = Registry()
    r.apply(ev("A", "thinking"), now=0)
    assert r.snapshot() == "1|1|thinking,-,-"


def test_order_is_first_seen_and_stable():
    r = Registry()
    r.apply(ev("A", "idle"), now=0)
    r.apply(ev("B", "idle"), now=1)
    r.apply(ev("A", "tool", "bash", "Bash"), now=2)  # A の更新で順番は変わらない
    assert r.snapshot() == "1|2|tool,bash,Bash|idle,-,-"


def test_max_three_slots_and_total_counts_all():
    r = Registry()
    for i, s in enumerate("ABCD"):
        r.apply(ev(s, "idle"), now=i)
    snap = r.snapshot()
    assert snap.startswith("1|4|")
    assert snap.count("|") == 1 + MAX_SLOTS


def test_end_removes_session():
    r = Registry()
    r.apply(ev("A", "idle"), now=0)
    r.apply(ev("A", "end"), now=1)
    assert r.snapshot() == "1|0"


def test_prune_stale_sessions():
    r = Registry()
    r.apply(ev("A", "idle"), now=0)
    r.apply(ev("B", "idle"), now=STALE_SEC - 1)
    assert r.prune(now=STALE_SEC + 1) is True
    assert r.snapshot() == "1|1|idle,-,-"
    assert r.prune(now=STALE_SEC + 2) is False


def test_snapshot_fits_ble_payload():
    r = Registry()
    for s in "ABC":
        r.apply(ev(s, "waiting", "other", "x" * 12), now=0)
    assert len(r.snapshot().encode()) <= 180


@pytest.mark.parametrize(
    "bad",
    [
        {},
        {"v": 2, "session": "A", "state": "idle"},
        {"v": 1, "session": "", "state": "idle"},
        {"v": 1, "session": "A", "state": "dance"},
        {"v": 1, "session": "A", "state": "tool", "category": "nope"},
        {"v": 1, "session": "A", "state": "tool", "tool": "a|b"},
    ],
)
def test_parse_event_rejects_invalid(bad):
    with pytest.raises(ValueError):
        parse_event(bad)


def test_tool_name_truncated_to_12():
    e = parse_event({"v": 1, "session": "A", "state": "tool", "tool": "abcdefghijklmnop"})
    assert e.tool == "abcdefghijkl"

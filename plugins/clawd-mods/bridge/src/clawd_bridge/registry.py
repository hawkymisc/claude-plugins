"""セッション表とスナップショット生成 (SPEC §4)。

BLE には全セッションのスナップショットを毎回送る。取りこぼしても次で回復する。
"""

import re
from dataclasses import dataclass

MAX_SLOTS = 3
STALE_SEC = 10 * 60
TOOL_MAX = 12
SESSION_MAX = 64
TOTAL_MAX = 99  # FW (snapshot.h) が受け付ける total の上限

STATES = {"idle", "thinking", "tool", "done", "error", "waiting", "end"}
CATEGORIES = {"read", "write", "bash", "web", "agent", "other"}
# スナップショットの区切り文字 (| ,) を含むツール名は受け付けない
TOOL_RE = re.compile(r"^[A-Za-z0-9_.\-]+$")


@dataclass(frozen=True)
class Event:
    session: str
    state: str
    category: str | None
    tool: str | None


def parse_event(data: object) -> Event:
    if not isinstance(data, dict):
        raise ValueError("event must be an object")
    v = data.get("v")
    if type(v) is not int or v != 1:  # bool は int の派生なので type で比較する
        raise ValueError(f"unsupported version: {v!r}")
    session = data.get("session")
    if not isinstance(session, str) or not session or len(session) > SESSION_MAX:
        raise ValueError("session must be a non-empty string up to 64 chars")
    state = data.get("state")
    if not isinstance(state, str) or state not in STATES:
        raise ValueError(f"unknown state: {state!r}")
    category = data.get("category")
    if category is not None and (not isinstance(category, str) or category not in CATEGORIES):
        raise ValueError(f"unknown category: {category!r}")
    tool = data.get("tool")
    if tool is not None:
        if not isinstance(tool, str) or not TOOL_RE.match(tool):
            raise ValueError(f"invalid tool name: {tool!r}")
        tool = tool[:TOOL_MAX]
    return Event(session=session, state=state, category=category, tool=tool)


@dataclass
class Slot:
    state: str
    category: str | None
    tool: str | None
    first_seen: float
    last_seen: float


class Registry:
    def __init__(self) -> None:
        self._slots: dict[str, Slot] = {}

    def apply(self, event: Event, now: float) -> None:
        if event.state == "end":
            self._slots.pop(event.session, None)
            return
        slot = self._slots.get(event.session)
        if slot is None:
            self._slots[event.session] = Slot(event.state, event.category, event.tool, now, now)
            return
        slot.state, slot.category, slot.tool, slot.last_seen = event.state, event.category, event.tool, now

    def prune(self, now: float) -> bool:
        """STALE_SEC 無イベントのセッションを消す。消えたら True。"""
        stale = [k for k, s in self._slots.items() if now - s.last_seen > STALE_SEC]
        for k in stale:
            del self._slots[k]
        return bool(stale)

    def __len__(self) -> int:
        return len(self._slots)

    def snapshot(self) -> str:
        ordered = sorted(self._slots.values(), key=lambda s: s.first_seen)
        parts = ["1", str(min(len(ordered), TOTAL_MAX))]
        for s in ordered[:MAX_SLOTS]:
            parts.append(f"{s.state},{s.category or '-'},{s.tool or '-'}")
        return "|".join(parts)

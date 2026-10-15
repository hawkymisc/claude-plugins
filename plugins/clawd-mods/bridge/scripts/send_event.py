"""bridge へテストイベントを送る (実機確認用)。

usage:
  uv run python scripts/send_event.py status
  uv run python scripts/send_event.py demo            # 各アニメを 3 秒ずつ順に送る
  uv run python scripts/send_event.py <session> <state> [category] [tool]
"""

import asyncio
import sys
from pathlib import Path

import aiohttp

SOCKET = Path.home() / ".clawd-bridge" / "bridge.sock"

DEMO = [
    ("idle", None, None),
    ("thinking", None, None),
    ("tool", "read", "Read"),
    ("tool", "write", "Edit"),
    ("tool", "bash", "Bash"),
    ("tool", "web", "WebFetch"),
    ("tool", "agent", "Agent"),
    ("tool", "other", "create_issue"),
    ("waiting", None, "Bash"),
    ("error", None, None),
    ("done", None, None),
    ("idle", None, None),
]


async def post(session: aiohttp.ClientSession, body: dict) -> None:
    async with session.post("http://clawd/event", json=body) as r:
        print(r.status, body["state"], body.get("category"), body.get("tool"), await r.text())


def event(sid: str, state: str, category: str | None, tool: str | None) -> dict:
    body = {"v": 1, "session": sid, "label": "demo", "state": state}
    if category:
        body["category"] = category
    if tool:
        body["tool"] = tool
    return body


async def main(argv: list[str]) -> None:
    async with aiohttp.ClientSession(connector=aiohttp.UnixConnector(path=str(SOCKET))) as s:
        if argv[:1] == ["status"]:
            async with s.get("http://clawd/status") as r:
                print(await r.text())
        elif argv[:1] == ["demo"]:
            for state, cat, tool in DEMO:
                await post(s, event("demo-1", state, cat, tool))
                await asyncio.sleep(3)
        elif len(argv) >= 2:
            await post(
                s, event(argv[0], argv[1], argv[2] if len(argv) > 2 else None, argv[3] if len(argv) > 3 else None)
            )
        else:
            sys.exit(__doc__)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))

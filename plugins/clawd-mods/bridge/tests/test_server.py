"""SPEC §3 IPC の仕様テスト (BLE はフェイク)。"""

import pytest
from aiohttp.test_utils import TestClient, TestServer

from clawd_bridge.server import make_app


class FakeLink:
    def __init__(self) -> None:
        self.state = "scanning"
        self.pushed: list[str] = []

    def push(self, snapshot: str) -> None:
        self.pushed.append(snapshot)


@pytest.fixture
async def client():
    link = FakeLink()
    async with TestClient(TestServer(make_app(link, clock=lambda: 0.0))) as c:
        c.link = link
        yield c


async def test_event_pushes_snapshot(client):
    r = await client.post(
        "/event", json={"v": 1, "session": "S", "label": "p", "state": "tool", "category": "read", "tool": "Read"}
    )
    assert r.status == 200
    assert client.link.pushed == ["1|1|tool,read,Read"]


async def test_bad_event_is_400_and_not_pushed(client):
    r = await client.post("/event", data="not json")
    assert r.status == 400
    r = await client.post("/event", json={"v": 1, "session": "S", "state": "dance"})
    assert r.status == 400
    assert client.link.pushed == []


async def test_status_reports_link_and_sessions(client):
    await client.post("/event", json={"v": 1, "session": "S", "label": "p", "state": "idle"})
    r = await client.get("/status")
    assert await r.json() == {"ble": "scanning", "sessions": 1}

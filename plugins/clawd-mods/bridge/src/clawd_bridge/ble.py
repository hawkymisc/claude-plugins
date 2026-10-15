"""Cardputer への BLE リンク (SPEC §4)。

最新スナップショットだけを保持し、変化した時と接続直後に書き込む。
切断時は 2s → 30s の指数バックオフで再スキャン・再接続する。
"""

import asyncio
import logging
from typing import Protocol

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice
from bleak.exc import BleakError

log = logging.getLogger(__name__)

DEVICE_NAME = "Clawd-Cardputer"
SERVICE_UUID = "c1a0d000-7c1e-4b6e-9a55-0c1a0d000001"
SNAPSHOT_UUID = "c1a0d000-7c1e-4b6e-9a55-0c1a0d000002"
SCAN_TIMEOUT = 10.0
BACKOFF_MIN = 2.0
BACKOFF_MAX = 30.0


class Link(Protocol):
    state: str  # "connected" | "scanning" | "disconnected"

    def push(self, snapshot: str) -> None: ...


class BleLink:
    def __init__(self) -> None:
        self.state = "disconnected"
        self._latest = "1|0"
        self._dirty = asyncio.Event()

    def push(self, snapshot: str) -> None:
        if snapshot == self._latest:
            return
        self._latest = snapshot
        self._dirty.set()

    async def _find(self) -> BLEDevice | None:
        def match(dev: BLEDevice, adv) -> bool:
            return dev.name == DEVICE_NAME or SERVICE_UUID in (adv.service_uuids or [])

        return await BleakScanner.find_device_by_filter(match, timeout=SCAN_TIMEOUT)

    async def _session(self, device: BLEDevice) -> None:
        disconnected = asyncio.Event()

        def on_disconnect(_: BleakClient) -> None:
            disconnected.set()
            self._dirty.set()  # 書き込み待ちを起こしてループを抜けさせる

        async with BleakClient(device, disconnected_callback=on_disconnect) as client:
            self.state = "connected"
            log.info("connected: %s (%s) mtu=%s", device.name, device.address, client.mtu_size)
            self._dirty.set()  # 接続直後に現在値を送る
            while not disconnected.is_set():
                await self._dirty.wait()
                self._dirty.clear()
                if disconnected.is_set():
                    break
                data = self._latest.encode()
                await client.write_gatt_char(SNAPSHOT_UUID, data, response=True)
                log.debug("wrote %d bytes: %s", len(data), self._latest)

    async def run(self) -> None:
        backoff = BACKOFF_MIN
        while True:
            self.state = "scanning"
            try:
                device = await self._find()
                if device is None:
                    log.info("%s not found; retry in %.0fs", DEVICE_NAME, backoff)
                else:
                    await self._session(device)
                    backoff = BACKOFF_MIN  # 一度つながったらバックオフを戻す
                    log.warning("disconnected; reconnecting")
            except (BleakError, OSError, asyncio.TimeoutError) as e:
                log.warning("ble error: %r; retry in %.0fs", e, backoff)
            except Exception:
                # 想定外でもデーモンは落とさない (落ちると Mod の送信先ごと消える)。原因は必ず残す
                log.exception("unexpected ble failure; retry in %.0fs", backoff)
            self.state = "disconnected"
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX)

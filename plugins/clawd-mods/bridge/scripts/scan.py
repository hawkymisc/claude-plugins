"""周囲の BLE を 8 秒スキャンして一覧表示する (Terminal.app から実行すること)。"""

import asyncio

from bleak import BleakScanner

from clawd_bridge.ble import DEVICE_NAME, SERVICE_UUID


async def main() -> None:
    found = await BleakScanner.discover(timeout=8.0, return_adv=True)
    for dev, adv in sorted(found.values(), key=lambda x: -x[1].rssi):
        mark = "  <== Cardputer" if dev.name == DEVICE_NAME or SERVICE_UUID in adv.service_uuids else ""
        print(f"{adv.rssi:4d} dBm  {dev.address}  {dev.name or adv.local_name or '-'}{mark}")


asyncio.run(main())

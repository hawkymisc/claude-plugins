"""clawd-bridge エントリポイント: Unix ソケット HTTP + BLE リンク + 古いセッション掃除。"""

import argparse
import asyncio
import logging
import os
import socket
import sys
import time
from pathlib import Path

from aiohttp import web

from .ble import BleLink
from .registry import Registry
from .server import make_app

log = logging.getLogger("clawd_bridge")

DEFAULT_SOCKET = Path.home() / ".clawd-bridge" / "bridge.sock"
DEFAULT_LOG = Path.home() / ".clawd-bridge" / "bridge.log"
PRUNE_EVERY = 30.0


async def prune_loop(registry: Registry, link: BleLink) -> None:
    while True:
        await asyncio.sleep(PRUNE_EVERY)
        if registry.prune(now=time.monotonic()):
            link.push(registry.snapshot())
            log.info("pruned stale sessions -> %s", registry.snapshot())


def socket_is_live(path: Path) -> bool:
    """別の bridge がこのソケットで応答しているか。"""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        try:
            s.connect(str(path))
        except (ConnectionRefusedError, FileNotFoundError):
            return False
        except OSError as e:
            log.warning("socket probe failed (%s); treating as stale: %r", path, e)
            return False
    return True


async def serve(socket_path: Path) -> None:
    if socket_path.exists():
        if socket_is_live(socket_path):
            # launchd 常駐と手動起動の二重起動で BLE を奪い合わないよう、後から来た方が退く
            log.error("another clawd-bridge is already serving %s; exiting", socket_path)
            sys.exit(1)
        socket_path.unlink()  # 前回異常終了の残骸
    registry = Registry()
    link = BleLink()
    runner = web.AppRunner(make_app(link, registry))
    await runner.setup()
    site = web.UnixSite(runner, str(socket_path))
    await site.start()
    os.chmod(socket_path, 0o600)
    log.info("listening on %s", socket_path)
    try:
        await asyncio.gather(link.run(), prune_loop(registry, link))
    finally:
        await runner.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description="Clawd BLE bridge for Claude Code")
    parser.add_argument("--socket", type=Path, default=DEFAULT_SOCKET)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)  # ログ・ソケットを他ユーザーに読ませない (ツール名が載る)
    DEFAULT_LOG.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(DEFAULT_LOG.parent, 0o700)  # 既存ディレクトリ (install_agent.sh が先に作る) も絞る
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s.%(msecs)03d %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        # 端末とファイルの両方へ。ファイルは Claude 側から実機ログを読むため
        handlers=[logging.StreamHandler(), logging.FileHandler(DEFAULT_LOG)],
    )
    os.chmod(DEFAULT_LOG, 0o600)  # umask 以前に作られた既存ログも絞る
    logging.getLogger("bleak").setLevel(logging.INFO)
    asyncio.run(serve(args.socket))


if __name__ == "__main__":
    main()

"""Mod から受ける Unix ソケット HTTP (SPEC §3)。"""

import json
import logging
import time
from collections.abc import Callable

from aiohttp import web

from .ble import Link
from .registry import Registry, parse_event

log = logging.getLogger(__name__)

REGISTRY_KEY = web.AppKey("registry", Registry)
LINK_KEY = web.AppKey("link", Link)
CLOCK_KEY = web.AppKey("clock", Callable[[], float])


async def post_event(request: web.Request) -> web.Response:
    try:
        event = parse_event(json.loads(await request.text()))
    except (ValueError, json.JSONDecodeError) as e:
        log.warning("bad event: %s", e)
        return web.json_response({"error": str(e)}, status=400)
    registry = request.app[REGISTRY_KEY]
    registry.apply(event, now=request.app[CLOCK_KEY]())
    snapshot = registry.snapshot()
    request.app[LINK_KEY].push(snapshot)
    log.info("event %s %s/%s/%s -> %s", event.session[:8], event.state, event.category, event.tool, snapshot)
    return web.json_response({"ok": True})


async def get_status(request: web.Request) -> web.Response:
    return web.json_response({"ble": request.app[LINK_KEY].state, "sessions": len(request.app[REGISTRY_KEY])})


def make_app(
    link: Link, registry: Registry | None = None, clock: Callable[[], float] = time.monotonic
) -> web.Application:
    app = web.Application()
    app[REGISTRY_KEY] = registry if registry is not None else Registry()  # 空 Registry は falsy
    app[LINK_KEY] = link
    app[CLOCK_KEY] = clock
    app.router.add_post("/event", post_event)
    app.router.add_get("/status", get_status)
    return app

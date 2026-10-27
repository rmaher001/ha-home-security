"""Shared fixtures: a fake Home Security engine on a local aiohttp server."""

from __future__ import annotations

import asyncio
import copy
from collections.abc import AsyncGenerator
from typing import Any

import pytest
from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestServer
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_security.const import (
    CONF_TOKEN,
    CONF_URL,
    CONF_WEBHOOK_ID,
    CONF_WEBHOOK_SECRET,
    DOMAIN,
)

TOKEN = "engine-token"
PAIR_CODE = "ABCD-EF23"
WEBHOOK_ID = "test-webhook-id"
WEBHOOK_SECRET = "test-webhook-secret"
PICTURE = b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9"

STATE: dict[str, Any] = {
    "version": "0.1.0",
    "mode": {"chosen": "auto", "effective": "night"},
    "home": {"Alex": True, "Sam": False},
    "alerts": True,
    "health": {
        "ok": False,
        "problems": ["1 of 10 cameras aren't connected"],
        "home_assistant": True,
        "protect": None,
        "cameras": {"connected": 9, "total": 10},
        "listener": "on",
        "ai": {"ok": True, "seconds": 7.5, "last": "2026-10-27T22:01:00+00:00"},
    },
    "stories": 42,
}

STORY = {
    "id": "01JBSTORY",
    "title": "Person at the front door",
    "why": "A stranger waited at the door at 2 AM.",
    "level": "high",
    "kind": "person",
    "cameras": ["Front Door"],
    "started": "2026-10-27T09:14:00Z",
    "updated": "2026-10-27T09:16:30Z",
    "fine": False,
    "live": True,
}


class FakeEngine:
    """A tiny in-process stand-in for the engine's LAN API."""

    def __init__(self) -> None:
        self.state: dict[str, Any] = copy.deepcopy(STATE)
        self.stories: list[dict[str, Any]] = [copy.deepcopy(STORY)]
        self.token = TOKEN
        self.calls: list[tuple[str, str, Any]] = []
        self.paired: list[dict[str, Any]] = []
        self.sockets: list[web.WebSocketResponse] = []
        self.ws_connects = 0
        self.ws_refuse_auth = False
        self.server: TestServer | None = None

        app = web.Application()
        app.router.add_post("/api/v1/pair", self._pair)
        app.router.add_get("/api/v1/state", self._state)
        app.router.add_get("/api/v1/ws", self._ws)
        app.router.add_get("/api/v1/stories", self._stories)
        app.router.add_get("/api/v1/stories/{id}/picture.jpg", self._picture)
        app.router.add_post("/api/v1/stories/{id}/fine", self._fine)
        app.router.add_put("/api/v1/mode", self._mode)
        app.router.add_put("/api/v1/alerts", self._alerts)
        self.app = app

    @property
    def url(self) -> str:
        assert self.server is not None
        return str(self.server.make_url("")).rstrip("/")

    def _authorized(self, request: web.Request) -> bool:
        return request.headers.get("Authorization") == f"Bearer {self.token}"

    @staticmethod
    def _refuse() -> web.Response:
        return web.json_response({"error": "pair first"}, status=401)

    async def push(self, state: dict[str, Any] | None = None) -> None:
        """Send the current (or a new) state to every connected socket."""
        if state is not None:
            self.state = state
        for ws in list(self.sockets):
            await ws.send_json({"type": "state", "state": self.state})

    async def drop_sockets(self) -> None:
        for ws in list(self.sockets):
            await ws.close()

    async def _pair(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.paired.append(body)
        if not all(body.get(k) for k in ("code", "name", "webhook_url", "webhook_secret")):
            return web.json_response({"error": "missing"}, status=400)
        if body["code"] != PAIR_CODE:
            return web.json_response({"error": "bad code"}, status=403)
        return web.json_response({"token": self.token})

    async def _state(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._refuse()
        return web.json_response(self.state)

    async def _ws(self, request: web.Request) -> web.StreamResponse:
        if self.ws_refuse_auth or not self._authorized(request):
            return self._refuse()
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.ws_connects += 1
        self.sockets.append(ws)
        await ws.send_json({"type": "state", "state": self.state})
        try:
            async for msg in ws:
                if msg.type == WSMsgType.ERROR:
                    break
        finally:
            self.sockets.remove(ws)
        return ws

    async def _stories(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._refuse()
        self.calls.append(("GET", "stories", request.query.get("days")))
        return web.json_response(self.stories)

    async def _picture(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._refuse()
        if request.match_info["id"] != STORY["id"]:
            return web.json_response({"error": "not found"}, status=404)
        return web.Response(body=PICTURE, content_type="image/jpeg")

    async def _fine(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._refuse()
        story_id = request.match_info["id"]
        self.calls.append(("POST", "fine", story_id))
        if story_id != STORY["id"]:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response({"result": "ok"})

    async def _mode(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._refuse()
        body = await request.json()
        self.calls.append(("PUT", "mode", body))
        if body.get("mode") not in ("auto", "home", "night", "away"):
            return web.json_response({"error": "bad mode"}, status=400)
        return web.json_response({"result": "ok"})

    async def _alerts(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._refuse()
        body = await request.json()
        self.calls.append(("PUT", "alerts", body))
        if not isinstance(body.get("on"), bool):
            return web.json_response({"error": "bad"}, status=400)
        return web.json_response({"result": "ok"})


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Let Home Assistant load the integration from custom_components."""


@pytest.fixture
async def engine(socket_enabled: None) -> AsyncGenerator[FakeEngine]:
    fake = FakeEngine()
    server = TestServer(fake.app, host="127.0.0.1")
    await server.start_server()
    fake.server = server
    yield fake
    await fake.drop_sockets()
    await server.close()


@pytest.fixture
def config_entry(engine: FakeEngine) -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        title="Home Security",
        data={
            CONF_URL: engine.url,
            CONF_TOKEN: TOKEN,
            CONF_WEBHOOK_ID: WEBHOOK_ID,
            CONF_WEBHOOK_SECRET: WEBHOOK_SECRET,
        },
        options={},
    )


async def wait_for(predicate, limit: float = 3.0) -> None:
    """Poll until predicate() is true (for socket-driven updates)."""
    async with asyncio.timeout(limit):
        while not predicate():
            await asyncio.sleep(0.01)


async def setup_integration(hass, entry: MockConfigEntry) -> None:
    """Add the entry, set it up and wait for the websocket's first state."""
    if hass.config_entries.async_get_entry(entry.entry_id) is None:
        entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    coordinator = entry.runtime_data.coordinator
    await wait_for(lambda: coordinator.connected)
    await hass.async_block_till_done()

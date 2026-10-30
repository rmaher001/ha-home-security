"""Job 1: the engine's app in the sidebar, behind the Home Assistant login."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from aiohttp import ClientError, ClientResponse, WSMsgType, WSServerHandshakeError
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import (
    ClientSessionGenerator,
    WebSocketGenerator,
)

from custom_components.home_security.app_proxy import (
    AppAccess,
    _rewrite_location,
    _route_for,
    async_get_app_access,
)

from .conftest import STORY, TOKEN, FakeEngine, setup_integration

BASE = "/api/home_security/app"
HOUR = 3600
ID = STORY["id"]


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
async def clock(hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry) -> Clock:
    await setup_integration(hass, config_entry)
    fake = Clock()
    async_get_app_access(hass).clock = fake
    engine.echoes.clear()
    return fake


async def ticket(hass: HomeAssistant, hass_ws_client: WebSocketGenerator, **kwargs: Any) -> str:
    client = await hass_ws_client(hass, **kwargs)
    await client.send_json_auto_id({"type": "home_security/app_session"})
    msg = await client.receive_json()
    assert msg["success"], msg
    assert msg["result"]["expires_in"] == 60
    await client.close()  # the ticket outlives the connection that asked for it
    return msg["result"]["ticket"]


@pytest.fixture
def sign_in(
    hass: HomeAssistant,
    clock: Clock,
    hass_client_no_auth: ClientSessionGenerator,
    hass_ws_client: WebSocketGenerator,
):
    """A browser that traded a ticket for the session cookie (as whoever owns the token)."""

    async def go(**kwargs: Any):
        client = await hass_client_no_auth()
        t = await ticket(hass, hass_ws_client, **kwargs)
        resp = await client.get(
            f"{BASE}/_session", params={"ticket": t, "next": ""}, allow_redirects=False
        )
        assert resp.status == 302
        return client

    return go


@pytest.fixture
async def browser(sign_in):
    return await sign_in()


@pytest.fixture
async def member(sign_in, hass_read_only_access_token: str):
    """A signed-in browser for a user who is not an administrator."""
    return await sign_in(access_token=hass_read_only_access_token)


async def raw(client, method: str, path: str, headers: dict[str, str] | None = None) -> int:
    """Send a request line exactly as written (no client-side tidying of %2e or ..)."""
    cookies = client.session.cookie_jar.filter_cookies(client.make_url(f"{BASE}/"))
    lines = [f"{method} {BASE}/{path} HTTP/1.1", f"Host: {client.host}:{client.port}"]
    lines += [f"Cookie: {c.key}={c.value}" for c in cookies.values()]
    lines += [f"{k}: {v}" for k, v in (headers or {}).items()]
    reader, writer = await asyncio.open_connection(client.host, client.port)
    writer.write(
        ("\r\n".join(lines) + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").encode()
    )
    await writer.drain()
    status = int((await reader.readline()).split()[1])
    writer.close()
    return status


# --- the panel ------------------------------------------------------------------------------


async def test_the_panel_is_in_the_sidebar(hass: HomeAssistant, clock: Clock) -> None:
    panel = hass.data["frontend_panels"]["home-security"]
    assert panel.sidebar_title == "Home Security"
    assert panel.sidebar_icon == "mdi:shield-home"
    assert panel.require_admin is False
    assert panel.config["_panel_custom"]["name"] == "home-security-panel"


async def test_the_panel_leaves_with_the_entry(
    hass: HomeAssistant, clock: Clock, config_entry: MockConfigEntry
) -> None:
    await hass.config_entries.async_unload(config_entry.entry_id)
    assert "home-security" not in hass.data["frontend_panels"]
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    assert "home-security" in hass.data["frontend_panels"]


async def test_the_panel_script_is_served(
    hass: HomeAssistant, clock: Clock, hass_client_no_auth: ClientSessionGenerator
) -> None:
    panel = hass.data["frontend_panels"]["home-security"]
    url = panel.config["_panel_custom"]["module_url"]
    resp = await (await hass_client_no_auth()).get(url)
    assert resp.status == 200
    assert "home-security-panel" in await resp.text()


# --- tickets and sessions -------------------------------------------------------------------


async def test_a_ticket_is_minted_for_any_logged_in_user(
    hass: HomeAssistant,
    clock: Clock,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_access_token: str,
) -> None:
    assert await ticket(hass, hass_ws_client, access_token=hass_read_only_access_token)


async def test_minting_tickets_is_rate_limited(
    hass: HomeAssistant, clock: Clock, hass_ws_client: WebSocketGenerator
) -> None:
    client = await hass_ws_client(hass)
    for _ in range(10):
        await client.send_json_auto_id({"type": "home_security/app_session"})
        assert (await client.receive_json())["success"]
    await client.send_json_auto_id({"type": "home_security/app_session"})
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "rate_limited"
    clock.now += 61
    await client.send_json_auto_id({"type": "home_security/app_session"})
    assert (await client.receive_json())["success"]


async def test_the_ticket_opens_a_scoped_cookie_and_burns(
    hass: HomeAssistant,
    clock: Clock,
    hass_client_no_auth: ClientSessionGenerator,
    hass_ws_client: WebSocketGenerator,
) -> None:
    client = await hass_client_no_auth()
    t = await ticket(hass, hass_ws_client)
    resp = await client.get(
        f"{BASE}/_session", params={"ticket": t, "next": "?story=01JBSTORY"}, allow_redirects=False
    )
    assert resp.status == 302
    assert resp.headers["Location"] == f"{BASE}/?story=01JBSTORY"
    cookie = resp.headers["Set-Cookie"]
    assert "HttpOnly" in cookie
    assert "SameSite=Strict" in cookie
    assert f"Path={BASE}/" in cookie
    assert TOKEN not in cookie + resp.headers["Location"]

    again = await client.get(f"{BASE}/_session", params={"ticket": t}, allow_redirects=False)
    assert again.status == 403


async def test_a_ticket_dies_after_a_minute(
    hass: HomeAssistant,
    clock: Clock,
    hass_client_no_auth: ClientSessionGenerator,
    hass_ws_client: WebSocketGenerator,
) -> None:
    t = await ticket(hass, hass_ws_client)
    clock.now += 61
    resp = await (await hass_client_no_auth()).get(
        f"{BASE}/_session", params={"ticket": t}, allow_redirects=False
    )
    assert resp.status == 403


@pytest.mark.parametrize(
    "bad",
    [
        "https://evil.example/x",
        "//evil.example",
        "/../x",
        "a\\b",
        "%2e%2e/x",
        "%2E%2E%2Fx",
        "a%2fb",
        "a%5cb",
        "%252e%252e/x",
    ],
)
async def test_next_must_stay_inside_the_app(
    hass: HomeAssistant,
    clock: Clock,
    hass_client_no_auth: ClientSessionGenerator,
    hass_ws_client: WebSocketGenerator,
    bad: str,
) -> None:
    t = await ticket(hass, hass_ws_client)
    resp = await (await hass_client_no_auth()).get(
        f"{BASE}/_session", params={"ticket": t, "next": bad}, allow_redirects=False
    )
    assert resp.status == 400
    assert "Set-Cookie" not in resp.headers


async def test_no_ticket_no_session(
    hass: HomeAssistant, clock: Clock, hass_client_no_auth: ClientSessionGenerator
) -> None:
    client = await hass_client_no_auth()
    for params in ({}, {"ticket": "guess"}):
        resp = await client.get(f"{BASE}/_session", params=params, allow_redirects=False)
        assert resp.status == 403


async def test_the_bare_app_address_gets_its_slash(
    hass: HomeAssistant, clock: Clock, hass_client_no_auth: ClientSessionGenerator
) -> None:
    """The engine's page uses relative links, so it must be served from a path ending in /."""
    client = await hass_client_no_auth()
    resp = await client.get("/api/home_security/app?story=01JB", allow_redirects=False)
    assert resp.status == 308
    assert resp.headers["Location"] == f"{BASE}/?story=01JB"
    resp = await client.get("/api/home_security/app", allow_redirects=False)
    assert resp.headers["Location"] == f"{BASE}/"


async def test_the_session_lands_on_the_slash_form(
    hass: HomeAssistant,
    clock: Clock,
    hass_client_no_auth: ClientSessionGenerator,
    hass_ws_client: WebSocketGenerator,
) -> None:
    for nxt, want in (("", f"{BASE}/"), ("?story=01JB", f"{BASE}/?story=01JB")):
        t = await ticket(hass, hass_ws_client)
        resp = await (await hass_client_no_auth()).get(
            f"{BASE}/_session", params={"ticket": t, "next": nxt}, allow_redirects=False
        )
        assert resp.headers["Location"] == want


async def test_the_held_tickets_and_sessions_are_capped(hass: HomeAssistant, clock: Clock) -> None:
    access = AppAccess(hass, clock)
    tickets = [access.new_ticket("u", "r") for _ in range(500)]
    assert len(access._tickets) < 500
    assert tickets[-1] in access._tickets  # the oldest go first
    assert tickets[0] not in access._tickets


# --- who may come in --------------------------------------------------------------------------


async def test_without_the_cookie_nothing_passes(
    hass: HomeAssistant,
    engine: FakeEngine,
    clock: Clock,
    hass_client_no_auth: ClientSessionGenerator,
    hass_client: ClientSessionGenerator,
) -> None:
    for client in (await hass_client_no_auth(), await hass_client()):  # even a logged-in header
        resp = await client.get(f"{BASE}/api/v1/state")
        assert resp.status == 403
    assert engine.echoes == []


async def test_a_session_ends_after_twelve_idle_hours(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    for _ in range(2):  # use keeps it alive
        clock.now += 11 * HOUR
        assert (await browser.get(f"{BASE}/api/v1/state")).status == 200
    clock.now += 12 * HOUR + 1
    assert (await browser.get(f"{BASE}/api/v1/state")).status == 403


async def test_a_session_ends_after_a_day_however_busy(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    for _ in range(2):
        clock.now += 11 * HOUR
        assert (await browser.get(f"{BASE}/api/v1/state")).status == 200
    clock.now += 3 * HOUR  # 25 hours in, though never idle for 12
    assert (await browser.get(f"{BASE}/api/v1/state")).status == 403


async def test_a_removed_user_loses_the_session(
    hass: HomeAssistant, engine: FakeEngine, member, hass_read_only_user
) -> None:
    assert (await member.get(f"{BASE}/api/v1/state")).status == 200
    await hass.auth.async_remove_user(hass_read_only_user)
    assert (await member.get(f"{BASE}/api/v1/state")).status == 403


async def test_a_deactivated_user_loses_the_session(
    hass: HomeAssistant, engine: FakeEngine, member, hass_read_only_user
) -> None:
    assert (await member.get(f"{BASE}/api/v1/state")).status == 200
    await hass.auth.async_update_user(hass_read_only_user, is_active=False)
    assert (await member.get(f"{BASE}/api/v1/state")).status == 403


async def test_a_revoked_login_loses_the_session(
    hass: HomeAssistant, engine: FakeEngine, member, hass_read_only_access_token: str
) -> None:
    assert (await member.get(f"{BASE}/api/v1/state")).status == 200
    refresh = hass.auth.async_validate_access_token(hass_read_only_access_token)
    hass.auth.async_remove_refresh_token(refresh)
    assert (await member.get(f"{BASE}/api/v1/state")).status == 403


async def test_unloading_ends_every_session(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock, config_entry: MockConfigEntry
) -> None:
    await hass.config_entries.async_unload(config_entry.entry_id)
    assert (await browser.get(f"{BASE}/api/v1/state")).status == 403
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    assert (await browser.get(f"{BASE}/api/v1/state")).status == 403  # the old cookie is dead


async def test_unloading_closes_a_live_websocket(
    hass: HomeAssistant, engine: FakeEngine, browser, config_entry: MockConfigEntry
) -> None:
    async with browser.ws_connect(f"{BASE}/api/v1/ws") as ws:
        assert (await ws.receive_json())["type"] == "state"
        await hass.config_entries.async_unload(config_entry.entry_id)
        async with asyncio.timeout(3):
            msg = await ws.receive()
        assert msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED)


async def test_unloading_cuts_a_streaming_response(
    hass: HomeAssistant, engine: FakeEngine, browser, config_entry: MockConfigEntry
) -> None:
    resp = await browser.get(f"{BASE}/page/home-security-cards-slow.js")
    assert await resp.content.readany() == b"first"
    await hass.config_entries.async_unload(config_entry.entry_id)
    async with asyncio.timeout(3):
        try:
            rest = await resp.content.read()
        except ClientError, OSError:  # a cut stream may raise or just end; either way it stops
            rest = b""
    assert rest == b""


# --- what may pass --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", ""),
        ("GET", "page/home-security-cards-3.js"),
        ("GET", "page/home-security-cards-0.1.0-abc123.js"),
        ("GET", "api/v1/state"),
        ("GET", "api/v1/stories"),
        ("GET", f"api/v1/stories/{ID}/picture.jpg"),
        ("POST", f"api/v1/stories/{ID}/fine"),
        ("PUT", "api/v1/mode"),
        ("PUT", "api/v1/alerts"),
        ("GET", "api/v1/ws"),
    ],
)
def test_ordinary_routes_are_open_to_any_signed_in_user(method: str, path: str) -> None:
    assert _route_for(method, path) == "open"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "page/setup"),
        ("POST", "page/setup"),
        ("POST", "page/restore"),
        ("POST", "page/pair"),
    ],
)
def test_settings_routes_are_for_admins(method: str, path: str) -> None:
    assert _route_for(method, path) == "admin"


BLOCKED = [
    ("POST", "api/v1/pair"),
    ("POST", "api/v1/sensors"),
    ("GET", "metrics"),
    ("GET", "candidates"),
    ("GET", "setup"),
    ("GET", "snap/abc"),
    ("GET", "reply/abc"),
    ("GET", "page/password"),
    ("POST", "page/password"),
    ("GET", "page/sign-in"),
    ("POST", "page/sign-in"),
    ("POST", "page/sign-out"),
    ("GET", "page/restore"),  # wrong method
    ("DELETE", "api/v1/state"),  # wrong method
    ("POST", "api/v1/state"),
    ("GET", "api/v1/mode"),
    ("GET", "API/v1/state"),  # case matters
    ("GET", "api/v1/state/"),  # trailing slash variants of API routes
    ("GET", "api/v1/stories/"),
    ("GET", "page/setup/"),
    ("GET", "api/v1/stories//picture.jpg"),
    ("GET", f"api/v1/stories/{ID}/extra/picture.jpg"),
    ("GET", "api/v1/stories/a%20b/picture.jpg"),
    ("GET", "page/home-security-cards-x.html"),
    ("GET", "page/home-security-cards-/../password.js"),
    ("GET", "api/v1/./state"),
    ("GET", "api/v1/../v1/state"),
    ("GET", "api/v1/state/.."),
    ("POST", "api/v1/state/../pair"),
    ("POST", "api/v1/%2e%2e/v1/pair"),
    ("POST", "api/v1/%2E%2E/v1/pair"),
    ("POST", "api/v1/%252e%252e/v1/pair"),
    ("POST", "api/v1%2fpair"),
    ("POST", "api%2Fv1%2Fpair"),
    ("POST", "api/v1%5cpair"),
    ("POST", "api\\v1\\pair"),
    ("GET", "page//setup"),
    ("GET", "//api/v1/state"),
    ("GET", "api/v1/state%00"),
    ("GET", "%2e"),
]


@pytest.mark.parametrize(("method", "path"), BLOCKED)
def test_everything_else_is_blocked(method: str, path: str) -> None:
    assert _route_for(method, path) is None


@pytest.mark.parametrize(
    "path",
    [
        "api/v1/pair",
        "api/v1/sensors",
        "metrics",
        "page/password",
        "page/sign-in",
        "api/v1/%2e%2e/v1/pair",
        "api/v1/%2E%2E/v1/pair",
        "api/v1/%252e%252e/v1/pair",
        "api%2Fv1%2Fpair",
        "api/v1%5cpair",
        "API/v1/state",
        "api/v1/state/",
        "page//setup",
    ],
)
async def test_blocked_routes_never_reach_the_engine(
    hass: HomeAssistant, engine: FakeEngine, browser, path: str
) -> None:
    engine.echoes.clear()
    for method in ("GET", "POST", "PUT"):
        status = await raw(
            browser, method, path, {"Origin": f"http://{browser.host}:{browser.port}"}
        )
        # (Home Assistant itself turns away some encoded forms with a 400 before we see them.)
        assert status in (400, 404), (method, path)
    assert engine.echoes == []


async def test_settings_pages_need_an_administrator(
    hass: HomeAssistant, engine: FakeEngine, browser, member
) -> None:
    for client, want in ((member, 403), (browser, 200)):
        origin = {"Origin": f"http://{client.host}:{client.port}"}
        engine.echoes.clear()
        assert (await client.get(f"{BASE}/page/setup")).status == want
        assert (await client.post(f"{BASE}/page/setup", data="x", headers=origin)).status == want
        assert (await client.post(f"{BASE}/page/restore", data="x", headers=origin)).status == want
        assert (await client.post(f"{BASE}/page/pair", data="x", headers=origin)).status == want
        assert bool(engine.echoes) == (want == 200)
    # the everyday routes are open to the member
    assert (await member.get(f"{BASE}/")).status == 200
    assert (await member.get(f"{BASE}/api/v1/state")).status == 200


# --- how a request is passed on -------------------------------------------------------------


async def read_json(resp: ClientResponse) -> Any:
    assert resp.status == 200, await resp.text()
    return await resp.json()


async def test_a_request_is_passed_on_with_the_key_added_here(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    resp = await browser.get(
        f"{BASE}/api/v1/stories?days=2&x=a%20b",
        headers={
            "Authorization": "Bearer browser-ha-token",
            "Accept": "application/json",
            "X-Custom": "dropped",
        },
    )
    assert await read_json(resp) == engine.stories
    seen = engine.echoes[-1]
    assert seen["method"] == "GET"
    assert seen["path"] == "/api/v1/stories"
    assert seen["query"] == "days=2&x=a b"
    assert seen["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert "browser-ha-token" not in str(seen["headers"])
    assert "Cookie" not in seen["headers"]
    assert "X-Custom" not in seen["headers"]
    assert seen["headers"]["Accept"] == "application/json"
    assert resp.headers["X-Engine"] == "yes"
    assert "Set-Cookie" not in resp.headers  # the engine can't plant cookies in the browser
    assert "Keep-Alive" not in resp.headers


async def test_the_key_never_reaches_the_browser(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    engine.redirect_root = True
    resp = await browser.get(f"{BASE}/", allow_redirects=False)
    assert resp.status == 302
    assert resp.headers["Location"] == f"{BASE}/page/setup"
    blob = "".join(f"{k}: {v}" for k, v in resp.headers.items()) + await resp.text()
    assert TOKEN not in blob
    assert all(TOKEN not in str(c) for c in browser.session.cookie_jar)


async def test_changes_need_the_same_origin(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    host = f"{browser.host}:{browser.port}"
    for headers in ({}, {"Origin": "https://evil.example"}, {"Origin": "null"}):
        resp = await browser.put(f"{BASE}/api/v1/mode", json={"mode": "home"}, headers=headers)
        assert resp.status == 403
    assert ("PUT", "mode", {"mode": "home"}) not in engine.calls

    resp = await browser.put(
        f"{BASE}/api/v1/mode", json={"mode": "home"}, headers={"Origin": f"http://{host}"}
    )
    assert resp.status == 200
    assert ("PUT", "mode", {"mode": "home"}) in engine.calls
    assert json.loads(engine.echoes[-1]["body"]) == {"mode": "home"}


async def test_a_big_body_is_refused_by_its_declared_size(
    hass: HomeAssistant, engine: FakeEngine, browser
) -> None:
    origin = {"Origin": f"http://{browser.host}:{browser.port}"}
    engine.echoes.clear()
    resp = await browser.post(f"{BASE}/page/pair", data=b"x" * (1024 * 1024 + 1), headers=origin)
    assert resp.status == 413
    assert engine.echoes == []
    resp = await browser.post(f"{BASE}/page/pair", data=b"x" * 1024, headers=origin)
    assert resp.status == 200


async def test_a_big_streamed_body_is_cut_off(
    hass: HomeAssistant, engine: FakeEngine, browser
) -> None:
    origin = {"Origin": f"http://{browser.host}:{browser.port}"}

    async def chunks():
        for _ in range(8):  # 2 MB, no Content-Length
            yield b"x" * (256 * 1024)

    resp = await browser.post(f"{BASE}/page/pair", data=chunks(), headers=origin)
    assert resp.status == 413


async def test_the_websocket_goes_through(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    async with browser.ws_connect(f"{BASE}/api/v1/ws") as ws:
        msg = await ws.receive_json()
        assert msg["type"] == "state"
        assert msg["state"]["mode"]["chosen"] == "auto"
        await engine.push({**engine.state, "alerts": False})
        msg = await ws.receive_json()
        assert msg["state"]["alerts"] is False


async def test_the_websocket_needs_the_cookie(
    hass: HomeAssistant, clock: Clock, hass_client_no_auth: ClientSessionGenerator
) -> None:
    client = await hass_client_no_auth()
    with pytest.raises(WSServerHandshakeError) as err:
        await client.ws_connect(f"{BASE}/api/v1/ws")
    assert err.value.status == 403


async def test_an_engine_that_is_down_answers_502(
    hass: HomeAssistant, browser, clock: Clock, config_entry: MockConfigEntry
) -> None:
    config_entry.runtime_data.client.url = "http://127.0.0.1:1"  # nothing listens there
    assert (await browser.get(f"{BASE}/api/v1/state")).status == 502


# --- redirects ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("location", "want"),
    [
        ("/page/setup", f"{BASE}/page/setup"),
        ("http://engine.test:8780/page/setup?a=1", f"{BASE}/page/setup?a=1"),
        ("http://engine.test:8780", f"{BASE}/"),
        # not the engine, though it starts with the engine's address
        ("http://engine.test:87801/x", "http://engine.test:87801/x"),
        ("http://engine.test:8780.evil.example/x", "http://engine.test:8780.evil.example/x"),
        ("http://engine.test@evil.example/x", "http://engine.test@evil.example/x"),
        ("//evil.example/x", "//evil.example/x"),
        ("https://elsewhere.example/x", "https://elsewhere.example/x"),
        ("page/setup", "page/setup"),
    ],
)
def test_a_redirect_is_rewritten_by_its_parsed_address(location: str, want: str) -> None:
    assert _rewrite_location(location, "http://engine.test:8780") == want

"""Job 1: the engine's app in the sidebar, behind the Home Assistant login."""

from __future__ import annotations

from typing import Any

import pytest
from aiohttp import ClientResponse, WSServerHandshakeError
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import (
    ClientSessionGenerator,
    WebSocketGenerator,
)

from custom_components.home_security.app_proxy import async_get_app_access

from .conftest import TOKEN, FakeEngine, setup_integration

BASE = "/api/home_security/app"


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
    return fake


async def ticket(hass: HomeAssistant, hass_ws_client: WebSocketGenerator, **kwargs: Any) -> str:
    client = await hass_ws_client(hass, **kwargs)
    await client.send_json_auto_id({"type": "home_security/app_session"})
    msg = await client.receive_json()
    assert msg["success"], msg
    assert msg["result"]["expires_in"] == 60
    return msg["result"]["ticket"]


@pytest.fixture
async def browser(
    hass: HomeAssistant,
    clock: Clock,
    hass_client_no_auth: ClientSessionGenerator,
    hass_ws_client: WebSocketGenerator,
):
    """A signed-in browser: it traded a ticket for the session cookie."""
    client = await hass_client_no_auth()
    t = await ticket(hass, hass_ws_client)
    resp = await client.get(
        f"{BASE}/_session", params={"ticket": t, "next": ""}, allow_redirects=False
    )
    assert resp.status == 302
    return client


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


async def test_a_ticket_is_minted_for_any_logged_in_user(
    hass: HomeAssistant,
    clock: Clock,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_access_token: str,
) -> None:
    assert await ticket(hass, hass_ws_client, access_token=hass_read_only_access_token)


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


@pytest.mark.parametrize("bad", ["https://evil.example/x", "//evil.example", "/../x", "a\\b"])
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


async def test_without_the_cookie_nothing_passes(
    hass: HomeAssistant,
    engine: FakeEngine,
    clock: Clock,
    hass_client_no_auth: ClientSessionGenerator,
    hass_client: ClientSessionGenerator,
) -> None:
    for client in (await hass_client_no_auth(), await hass_client()):  # even a logged-in header
        resp = await client.get(f"{BASE}/echo/x")
        assert resp.status == 403
    assert engine.echoes == []


async def read_json(resp: ClientResponse) -> dict[str, Any]:
    assert resp.status == 200, await resp.text()
    return await resp.json()


async def test_a_request_is_passed_on_with_the_key_added_here(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    resp = await browser.get(
        f"{BASE}/echo/a%20b/c?story=01JB&x=1",
        headers={
            "Authorization": "Bearer browser-ha-token",
            "Accept": "application/json",
            "X-Custom": "dropped",
        },
    )
    seen = await read_json(resp)
    assert seen["method"] == "GET"
    assert seen["path"] == "/echo/a b/c"
    assert seen["query"] == "story=01JB&x=1"
    assert seen["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert "browser-ha-token" not in str(seen["headers"])
    assert "Cookie" not in seen["headers"]
    assert seen["headers"]["Accept"] == "application/json"
    assert resp.headers["X-Engine"] == "yes"
    assert "Set-Cookie" not in resp.headers  # the engine can't plant cookies in the browser
    assert "Keep-Alive" not in resp.headers


async def test_the_key_never_reaches_the_browser(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    resp = await browser.get(f"{BASE}/redirect", allow_redirects=False)
    assert resp.status == 302
    assert resp.headers["Location"] == f"{BASE}/echo/landed?x=1"
    blob = "".join(f"{k}: {v}" for k, v in resp.headers.items()) + await resp.text()
    assert TOKEN not in blob
    assert all(TOKEN not in str(c) for c in browser.session.cookie_jar)


async def test_changes_need_the_same_origin(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    host = f"{browser.make_url('/').host}:{browser.make_url('/').port}"
    for headers in ({}, {"Origin": "https://evil.example"}, {"Origin": "null"}):
        resp = await browser.post(f"{BASE}/echo/x", data="hi", headers=headers)
        assert resp.status == 403
    assert engine.echoes == []

    resp = await browser.put(f"{BASE}/echo/x", data="hi", headers={"Origin": f"http://{host}"})
    seen = await read_json(resp)
    assert seen["method"] == "PUT"
    assert seen["body"] == "hi"


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


async def test_a_session_ends_after_twelve_idle_hours(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock
) -> None:
    hour = 3600
    for _ in range(3):  # use keeps it alive
        clock.now += 11 * hour
        assert (await browser.get(f"{BASE}/echo/x")).status == 200
    clock.now += 12 * hour + 1
    assert (await browser.get(f"{BASE}/echo/x")).status == 403


async def test_unloading_ends_every_session(
    hass: HomeAssistant, engine: FakeEngine, browser, clock: Clock, config_entry: MockConfigEntry
) -> None:
    await hass.config_entries.async_unload(config_entry.entry_id)
    assert (await browser.get(f"{BASE}/echo/x")).status == 403
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    assert (await browser.get(f"{BASE}/echo/x")).status == 403  # the old cookie is dead


async def test_an_engine_that_is_down_answers_502(
    hass: HomeAssistant, browser, clock: Clock, config_entry: MockConfigEntry
) -> None:
    config_entry.runtime_data.client.url = "http://127.0.0.1:1"  # nothing listens there
    assert (await browser.get(f"{BASE}/echo/x")).status == 502


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

"""The mark_fine service and the websocket commands the cards use."""

from __future__ import annotations

import copy

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import (
    ClientSessionGenerator,
    WebSocketGenerator,
)

from custom_components.home_security.const import DOMAIN

from .conftest import PICTURE, STORY, FakeEngine, setup_integration, wait_for


async def test_mark_fine_service(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    await hass.services.async_call(DOMAIN, "mark_fine", {"story_id": STORY["id"]}, blocking=True)
    assert ("POST", "fine", STORY["id"]) in engine.calls


async def test_mark_fine_service_errors(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    for bad in ("../x", f"{STORY['id']}\n", ""):
        with pytest.raises(ServiceValidationError):
            await hass.services.async_call(DOMAIN, "mark_fine", {"story_id": bad}, blocking=True)
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            DOMAIN, "mark_fine", {"story_id": "01JBNOSUCH"}, blocking=True
        )
    assert ("POST", "fine", "../x") not in engine.calls


async def test_mark_fine_service_not_loaded(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    await hass.config_entries.async_unload(config_entry.entry_id)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            DOMAIN, "mark_fine", {"story_id": STORY["id"]}, blocking=True
        )


async def test_ws_state_and_stories(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": "home_security/state"})
    msg = await client.receive_json()
    assert msg["success"]
    assert msg["result"] == engine.state

    await client.send_json_auto_id({"type": "home_security/stories"})
    msg = await client.receive_json()
    assert msg["success"]
    assert msg["result"] == engine.stories

    await client.send_json_auto_id({"type": "home_security/stories", "days": 30})
    msg = await client.receive_json()
    assert msg["success"]
    assert ("GET", "stories", "30") in engine.calls

    await client.send_json_auto_id({"type": "home_security/stories", "days": 99})
    msg = await client.receive_json()
    assert not msg["success"]


async def test_ws_actions(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": "home_security/mark_fine", "story_id": STORY["id"]})
    assert (await client.receive_json())["success"]
    assert ("POST", "fine", STORY["id"]) in engine.calls

    await client.send_json_auto_id({"type": "home_security/mark_fine", "story_id": "01JBNOSUCH"})
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"

    await client.send_json_auto_id({"type": "home_security/set_mode", "mode": "away"})
    assert (await client.receive_json())["success"]
    assert ("PUT", "mode", {"mode": "away"}) in engine.calls

    await client.send_json_auto_id({"type": "home_security/set_mode", "mode": "party"})
    assert not (await client.receive_json())["success"]


async def test_ws_not_loaded(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    await hass.config_entries.async_unload(config_entry.entry_id)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "home_security/state"})
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_loaded"


async def test_ws_subscribe(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": "home_security/subscribe"})
    msg = await client.receive_json()
    assert msg["success"]
    sub_id = msg["id"]
    msg = await client.receive_json()
    assert msg["type"] == "event"
    assert msg["id"] == sub_id
    assert msg["event"] == {"state": engine.state, "stories": engine.stories, "connected": True}

    state = copy.deepcopy(engine.state)
    state["mode"] = {"chosen": "home", "effective": "home"}
    await engine.push(state)
    msg = await client.receive_json()
    assert msg["id"] == sub_id
    assert msg["event"]["state"]["mode"]["chosen"] == "home"
    assert msg["event"]["stories"] == engine.stories

    # Unloading tells the cards the engine is gone, rather than leaving them stale.
    await hass.config_entries.async_unload(config_entry.entry_id)
    msg = await client.receive_json()
    assert msg["id"] == sub_id
    assert msg["event"]["connected"] is False

    await client.send_json_auto_id({"type": "unsubscribe_events", "subscription": sub_id})
    assert (await client.receive_json())["success"]

    # Nothing more arrives on the subscription once it is closed.
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await wait_for(lambda: config_entry.runtime_data.coordinator.connected)
    await hass.async_block_till_done()
    await client.send_json_auto_id({"type": "ping"})
    assert (await client.receive_json())["type"] == "pong"


async def test_ws_picture_url(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
    hass_client_no_auth: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "home_security/picture_url", "story_id": STORY["id"]})
    msg = await client.receive_json()
    assert msg["success"]
    url = msg["result"]["url"]
    assert url.startswith(f"/api/home_security/picture/{STORY['id']}?authSig=")

    # The signed path loads without a login, as an <img> tag needs.
    http = await hass_client_no_auth()
    resp = await http.get(url)
    assert resp.status == 200
    assert await resp.read() == PICTURE

    for bad in ("../x", f"{STORY['id']}\n"):
        await client.send_json_auto_id({"type": "home_security/picture_url", "story_id": bad})
        assert not (await client.receive_json())["success"]


async def test_picture_view(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
    hass_client_no_auth: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    path = f"/api/home_security/picture/{STORY['id']}"

    anonymous = await hass_client_no_auth()
    assert (await anonymous.get(path)).status == 401

    http = await hass_client()
    resp = await http.get(path)
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "image/jpeg"
    assert await resp.read() == PICTURE

    assert (await http.get("/api/home_security/picture/01JBNOSUCH")).status == 404
    assert (await http.get("/api/home_security/picture/bad.id")).status == 400


async def test_cards_file_served_under_versioned_name(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    url = "/home_security_frontend/home-security-cards-0.1.0.js"
    assert url in hass.data["frontend_extra_module_url"].urls

    http = await hass_client()
    resp = await http.get(url)
    assert resp.status == 200
    assert 'customElements.define("home-security-card"' in await resp.text()

    # A reload doesn't register the static path twice (that would raise).
    assert await hass.config_entries.async_reload(config_entry.entry_id)
    await hass.async_block_till_done()
    assert list(hass.data["frontend_extra_module_url"].urls).count(url) == 1

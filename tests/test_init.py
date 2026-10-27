"""Setting up, the engine's websocket, and unloading."""

from __future__ import annotations

import copy
from unittest.mock import patch

import pytest
from homeassistant.components import webhook
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_security.const import CONF_URL, DOMAIN

from .conftest import WEBHOOK_ID, FakeEngine, setup_integration, wait_for


@pytest.fixture(autouse=True)
def fast_backoff():
    with (
        patch("custom_components.home_security.coordinator.BACKOFF_START", 0.01),
        patch("custom_components.home_security.coordinator.BACKOFF_MAX", 0.02),
    ):
        yield


async def test_setup_and_state(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    assert config_entry.state is ConfigEntryState.LOADED
    coordinator = config_entry.runtime_data.coordinator
    assert coordinator.state == engine.state
    assert coordinator.stories == engine.stories
    assert ("GET", "stories", "7") in engine.calls


async def test_device(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    device = dr.async_get(hass).async_get_device_by_identifier(
        (DOMAIN, config_entry.entry_id), config_entry.entry_id
    )
    assert device is not None
    assert device.name == "Home Security"
    assert device.manufacturer == "Home Security"
    assert device.sw_version == "0.1.0"
    assert device.configuration_url == config_entry.data[CONF_URL]

    state = copy.deepcopy(engine.state)
    state["version"] = "0.2.0"
    await engine.push(state)
    await wait_for(lambda: config_entry.runtime_data.coordinator.state["version"] == "0.2.0")
    device = dr.async_get(hass).async_get_device_by_identifier(
        (DOMAIN, config_entry.entry_id), config_entry.entry_id
    )
    assert device.sw_version == "0.2.0"


async def test_engine_unreachable_retries(hass: HomeAssistant, socket_enabled) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={
            CONF_URL: "http://127.0.0.1:1",
            "token": "x",
            "webhook_id": WEBHOOK_ID,
            "webhook_secret": "s",
        },
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_token_refused_starts_reauth(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    engine.token = "another-token"
    config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    assert config_entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert [f["context"]["source"] for f in flows] == ["reauth"]


async def test_stories_refetched_when_counter_moves(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    coordinator = config_entry.runtime_data.coordinator
    fetches = engine.calls.count(("GET", "stories", "7"))

    # Same counter: no refetch.
    await engine.push(copy.deepcopy(engine.state))
    await hass.async_block_till_done()

    engine.stories = [*engine.stories, {**engine.stories[0], "id": "01JBOTHER"}]
    state = copy.deepcopy(engine.state)
    state["stories"] = 43
    await engine.push(state)
    await wait_for(lambda: len(coordinator.stories) == 2)
    assert engine.calls.count(("GET", "stories", "7")) == fetches + 1


async def test_unavailable_while_disconnected_then_reconnects(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    coordinator = config_entry.runtime_data.coordinator
    assert hass.states.get("switch.home_security_alerts").state == "on"

    engine.ws_refuse_auth = False
    with patch("custom_components.home_security.coordinator.BACKOFF_START", 0.3):
        await engine.drop_sockets()
        await wait_for(lambda: not coordinator.connected)
        await hass.async_block_till_done()
        assert hass.states.get("switch.home_security_alerts").state == STATE_UNAVAILABLE

    await wait_for(lambda: coordinator.connected)
    await hass.async_block_till_done()
    assert engine.ws_connects == 2
    assert hass.states.get("switch.home_security_alerts").state == "on"


async def test_websocket_refused_starts_reauth(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    engine.ws_refuse_auth = True
    await engine.drop_sockets()
    await wait_for(lambda: bool(hass.config_entries.flow.async_progress_by_handler(DOMAIN)))
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert flows[0]["context"]["source"] == "reauth"


async def test_unload(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    assert WEBHOOK_ID in hass.data[webhook.DOMAIN]
    assert await hass.config_entries.async_unload(config_entry.entry_id)
    await hass.async_block_till_done()
    assert config_entry.state is ConfigEntryState.NOT_LOADED
    await wait_for(lambda: not engine.sockets)
    assert WEBHOOK_ID not in hass.data[webhook.DOMAIN]
    assert hass.states.get("switch.home_security_alerts").state == STATE_UNAVAILABLE


async def test_reload(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    """A reload re-registers everything without tripping over the first setup."""
    await setup_integration(hass, config_entry)
    assert await hass.config_entries.async_reload(config_entry.entry_id)
    await hass.async_block_till_done()
    assert config_entry.state is ConfigEntryState.LOADED
    await wait_for(lambda: config_entry.runtime_data.coordinator.connected)

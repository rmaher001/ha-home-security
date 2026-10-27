"""Entities: their states from the engine's state, and their actions."""

from __future__ import annotations

import copy

import pytest
from homeassistant.const import ATTR_ENTITY_ID, STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from .conftest import FakeEngine, setup_integration, wait_for


async def test_states(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)

    mode = hass.states.get("select.home_security_mode")
    assert mode.state == "auto"
    assert mode.attributes["options"] == ["auto", "home", "night", "away"]
    assert mode.attributes["in_force"] == "night"
    assert mode.attributes["set_by_hand"] is False

    assert hass.states.get("switch.home_security_alerts").state == "on"

    problem = hass.states.get("binary_sensor.home_security_problem")
    assert problem.state == "on"
    assert problem.attributes["device_class"] == "problem"
    assert problem.attributes["problems"] == ["1 of 10 cameras aren't connected"]

    ai = hass.states.get("sensor.home_security_ai")
    assert ai.state == "answering"
    assert ai.attributes["seconds"] == 7.5
    assert ai.attributes["options"] == ["answering", "not_answering"]

    speed = hass.states.get("sensor.home_security_ai_speed")
    assert float(speed.state) == 7.5
    assert speed.attributes["unit_of_measurement"] == "s"
    assert speed.attributes["device_class"] == "duration"
    assert speed.attributes["state_class"] == "measurement"

    cameras = hass.states.get("sensor.home_security_cameras_connected")
    assert cameras.state == "9"
    assert cameras.attributes["total"] == 10

    assert hass.states.get("sensor.home_security_sound_listener").state == "on"

    # The engine isn't set up to use Protect: null means unavailable, not off.
    assert hass.states.get("binary_sensor.home_security_protect").state == STATE_UNAVAILABLE
    link = hass.states.get("binary_sensor.home_security_home_assistant_link")
    assert link.state == "on"
    assert link.attributes["device_class"] == "connectivity"

    registry = er.async_get(hass)
    for entity_id in (
        "binary_sensor.home_security_problem",
        "sensor.home_security_ai",
        "sensor.home_security_ai_speed",
        "sensor.home_security_cameras_connected",
        "sensor.home_security_sound_listener",
        "binary_sensor.home_security_protect",
        "binary_sensor.home_security_home_assistant_link",
    ):
        assert registry.async_get(entity_id).entity_category == "diagnostic", entity_id
    assert registry.async_get("select.home_security_mode").entity_category is None
    assert registry.async_get("select.home_security_mode").unique_id == (
        f"{config_entry.entry_id}_mode"
    )


async def test_states_follow_pushes(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    state = copy.deepcopy(engine.state)
    state["mode"] = {"chosen": "away", "effective": "away"}
    state["alerts"] = False
    state["health"].update(
        ok=True,
        problems=[],
        protect=True,
        listener="off",
        ai={"ok": False, "seconds": None, "last": None},
    )
    await engine.push(state)
    await wait_for(lambda: hass.states.get("select.home_security_mode").state == "away")
    await hass.async_block_till_done()

    mode = hass.states.get("select.home_security_mode")
    assert mode.attributes["set_by_hand"] is True
    assert mode.attributes["in_force"] == "away"
    assert hass.states.get("switch.home_security_alerts").state == "off"
    assert hass.states.get("binary_sensor.home_security_problem").state == "off"
    assert hass.states.get("binary_sensor.home_security_protect").state == "on"
    assert hass.states.get("sensor.home_security_sound_listener").state == "off"
    assert hass.states.get("sensor.home_security_ai").state == "not_answering"
    assert hass.states.get("sensor.home_security_ai_speed").state == "unknown"


async def test_select_mode(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    await hass.services.async_call(
        "select",
        "select_option",
        {ATTR_ENTITY_ID: "select.home_security_mode", "option": "night"},
        blocking=True,
    )
    assert ("PUT", "mode", {"mode": "night"}) in engine.calls


async def test_alerts_switch(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    await hass.services.async_call(
        "switch", "turn_off", {ATTR_ENTITY_ID: "switch.home_security_alerts"}, blocking=True
    )
    await hass.services.async_call(
        "switch", "turn_on", {ATTR_ENTITY_ID: "switch.home_security_alerts"}, blocking=True
    )
    assert ("PUT", "alerts", {"on": False}) in engine.calls
    assert ("PUT", "alerts", {"on": True}) in engine.calls


async def test_engine_refusal_is_an_error(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    engine.token = "rotated"
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            "switch", "turn_off", {ATTR_ENTITY_ID: "switch.home_security_alerts"}, blocking=True
        )

"""Job 2: the integration pushes the house's doors, locks and people to the engine."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)

from .conftest import FakeEngine, setup_integration, wait_for


@pytest.fixture
def house(hass: HomeAssistant) -> None:
    """A few entities that matter and a few that don't."""
    hass.states.async_set(
        "binary_sensor.front_door", "off", {"device_class": "door", "friendly_name": "Front Door"}
    )
    hass.states.async_set("binary_sensor.den_window", "on", {"device_class": "window"})
    hass.states.async_set("binary_sensor.hall_motion", "on", {"device_class": "motion"})
    hass.states.async_set("binary_sensor.plain", "on", {})
    hass.states.async_set("lock.front", "locked", {"friendly_name": "Front Lock"})
    hass.states.async_set("person.alex", "home", {"friendly_name": "Alex"})
    hass.states.async_set("sensor.temperature", "21", {"device_class": "temperature"})


def by_id(post: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {s["entity_id"]: s for s in post["states"]}


async def flush(hass: HomeAssistant, seconds: float = 1.0) -> None:
    """Let the one-second batching window pass."""
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=seconds + 0.5))
    await hass.async_block_till_done()


async def test_setup_sends_a_snapshot_of_what_matters(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, house: None
) -> None:
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    post = engine.sensor_posts[0]
    assert post["snapshot"] is True
    states = by_id(post)
    assert set(states) == {
        "binary_sensor.front_door",
        "binary_sensor.den_window",
        "lock.front",
        "person.alex",
    }
    assert states["binary_sensor.front_door"] == {
        "entity_id": "binary_sensor.front_door",
        "state": "off",
        "domain": "binary_sensor",
        "device_class": "door",
        "name": "Front Door",
        "changed": hass.states.get("binary_sensor.front_door").last_changed.isoformat(),
    }
    assert states["lock.front"]["device_class"] is None
    assert states["binary_sensor.den_window"]["name"] is None
    assert states["person.alex"]["state"] == "home"


async def test_every_wanted_device_class_is_sent(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    wanted = [
        "door",
        "window",
        "garage_door",
        "opening",
        "lock",
        "smoke",
        "carbon_monoxide",
        "gas",
        "moisture",
    ]
    for device_class in wanted:
        hass.states.async_set(
            f"binary_sensor.{device_class}", "off", {"device_class": device_class}
        )
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    assert {s["device_class"] for s in engine.sensor_posts[0]["states"]} == set(wanted)


async def test_changes_are_batched(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, house: None
) -> None:
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    engine.sensor_posts.clear()

    hass.states.async_set("binary_sensor.front_door", "on", {"device_class": "door"})
    hass.states.async_set("lock.front", "unlocked")
    hass.states.async_set("binary_sensor.front_door", "off", {"device_class": "door"})
    hass.states.async_set("binary_sensor.hall_motion", "off", {"device_class": "motion"})
    hass.states.async_set("sensor.temperature", "22", {"device_class": "temperature"})
    await hass.async_block_till_done()
    assert engine.sensor_posts == []  # still inside the one-second window

    await flush(hass)
    await wait_for(lambda: engine.sensor_posts)
    [post] = engine.sensor_posts
    assert post["snapshot"] is False
    states = by_id(post)
    assert set(states) == {"binary_sensor.front_door", "lock.front"}
    assert states["binary_sensor.front_door"]["state"] == "off"  # the latest wins
    assert states["lock.front"]["state"] == "unlocked"


async def test_a_change_to_something_else_sends_nothing(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, house: None
) -> None:
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    engine.sensor_posts.clear()
    hass.states.async_set("sensor.temperature", "30", {"device_class": "temperature"})
    hass.states.async_set("binary_sensor.hall_motion", "off", {"device_class": "motion"})
    await flush(hass)
    assert engine.sensor_posts == []


async def test_a_new_door_is_picked_up(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, house: None
) -> None:
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    engine.sensor_posts.clear()
    hass.states.async_set("binary_sensor.shed", "on", {"device_class": "door"})
    await flush(hass)
    await wait_for(lambda: engine.sensor_posts)
    assert set(by_id(engine.sensor_posts[0])) == {"binary_sensor.shed"}


async def test_a_snapshot_after_every_reconnect(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, house: None
) -> None:
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    await hass.async_block_till_done()
    engine.sensor_posts.clear()
    connects = engine.ws_connects
    await engine.drop_sockets()
    await wait_for(lambda: engine.ws_connects > connects, limit=5)
    await wait_for(lambda: any(p["snapshot"] for p in engine.sensor_posts))
    assert len(by_id(next(p for p in engine.sensor_posts if p["snapshot"]))) == 4


async def test_a_snapshot_every_five_minutes(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, house: None
) -> None:
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    await hass.async_block_till_done()
    engine.sensor_posts.clear()
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=301))
    await hass.async_block_till_done()
    await wait_for(lambda: engine.sensor_posts)
    assert engine.sensor_posts[0]["snapshot"] is True


async def test_a_failure_is_logged_once_and_the_next_snapshot_retries(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    house: None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    engine.sensors_status = 500
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    await hass.async_block_till_done()
    for _ in range(3):
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=301))
        await hass.async_block_till_done()
    await wait_for(lambda: len(engine.sensor_posts) >= 3)
    assert caplog.text.count("Couldn't send the house's sensors") == 1

    engine.sensors_status = 204
    before = len(engine.sensor_posts)
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=700))
    await hass.async_block_till_done()
    await wait_for(lambda: len(engine.sensor_posts) > before)
    assert engine.sensor_posts[-1]["snapshot"] is True


async def test_nothing_is_sent_after_unload(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, house: None
) -> None:
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    await hass.config_entries.async_unload(config_entry.entry_id)
    engine.sensor_posts.clear()
    hass.states.async_set("lock.front", "unlocked")
    await flush(hass)
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=400))
    await hass.async_block_till_done()
    assert engine.sensor_posts == []


async def test_a_failed_change_push_is_followed_by_a_snapshot_soon(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, house: None
) -> None:
    """A door opened while the engine was down must not wait five minutes to be known."""
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    await hass.async_block_till_done()
    engine.sensor_posts.clear()

    engine.sensors_status = 500
    hass.states.async_set("binary_sensor.front_door", "on", {"device_class": "door"})
    await flush(hass)
    await wait_for(lambda: engine.sensor_posts)
    assert engine.sensor_posts[-1]["snapshot"] is False

    engine.sensors_status = 204
    engine.sensor_posts.clear()
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=15))
    await hass.async_block_till_done()
    await wait_for(lambda: engine.sensor_posts)
    assert engine.sensor_posts[0]["snapshot"] is True
    assert by_id(engine.sensor_posts[0])["binary_sensor.front_door"]["state"] == "on"


async def test_a_409_gets_a_snapshot_at_once(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    house: None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The engine restarted and wants everything again before it takes changes."""
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    await hass.async_block_till_done()
    engine.sensor_posts.clear()

    engine.want_snapshot = True
    hass.states.async_set("lock.front", "unlocked")
    await flush(hass)
    await wait_for(lambda: any(p["snapshot"] for p in engine.sensor_posts))
    assert [p["snapshot"] for p in engine.sensor_posts] == [False, True]
    assert by_id(engine.sensor_posts[1])["lock.front"]["state"] == "unlocked"
    assert "Couldn't send" not in caplog.text


async def test_a_409_on_a_snapshot_does_not_start_another_at_once(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, house: None
) -> None:
    """Only a change push turns a 409 into a snapshot; a refused snapshot waits for the retry."""
    engine.sensors_status = 409
    await setup_integration(hass, config_entry)
    await wait_for(lambda: engine.sensor_posts)
    await hass.async_block_till_done()
    await asyncio.sleep(0.3)
    before = len(engine.sensor_posts)  # the start-up snapshot and the connect one
    await asyncio.sleep(0.3)
    assert len(engine.sensor_posts) == before  # no snapshot chasing its own refusal
    assert all(p["snapshot"] for p in engine.sensor_posts)

    engine.sensors_status = 204
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=15))
    await hass.async_block_till_done()
    await wait_for(lambda: len(engine.sensor_posts) == before + 1)
    assert engine.sensor_posts[-1]["snapshot"] is True

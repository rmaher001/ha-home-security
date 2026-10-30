"""Job 2: tells the engine about the house's doors, windows, locks, alarms and people.

A full snapshot goes out on setup, on every engine reconnect and every five minutes; changes
follow within a second, batched. A failed push is logged once, and a snapshot follows ten
seconds later; the engine can also ask for one at once (409).
Nothing here waits on the engine: sends run as background tasks.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, State, callback
from homeassistant.helpers.event import async_call_later, async_track_time_interval

from .api import EngineError, EngineWantsSnapshot
from .const import (
    SENSOR_BATCH_SECONDS,
    SENSOR_DEVICE_CLASSES,
    SENSOR_DOMAINS,
    SENSOR_RETRY_SECONDS,
    SENSOR_SNAPSHOT_SECONDS,
)

if TYPE_CHECKING:
    from . import HomeSecurityConfigEntry

_LOGGER = logging.getLogger(__name__)


def _wanted(state: State) -> bool:
    if state.domain in ("lock", "person"):
        return True
    return (
        state.domain == "binary_sensor"
        and state.attributes.get("device_class") in SENSOR_DEVICE_CLASSES
    )


@callback
def _domain_filter(data: Any) -> bool:
    return data["entity_id"].split(".", 1)[0] in SENSOR_DOMAINS


def _payload(state: State) -> dict[str, Any]:
    changed: datetime = state.last_changed
    return {
        "entity_id": state.entity_id,
        "state": state.state,
        "domain": state.domain,
        "device_class": state.attributes.get("device_class"),
        "name": state.attributes.get("friendly_name"),
        "changed": changed.isoformat(),
    }


class SensorPusher:
    """Keeps the engine's picture of the house current."""

    def __init__(self, hass: HomeAssistant, entry: HomeSecurityConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self._pending: dict[str, State] = {}
        self._timer: CALLBACK_TYPE | None = None
        self._retry: CALLBACK_TYPE | None = None
        self._unsubs: list[CALLBACK_TYPE] = []
        self._failing = False
        self._lock = asyncio.Lock()
        self._stopped = False

    @callback
    def async_start(self) -> None:
        coordinator = self.entry.runtime_data.coordinator
        was_connected = coordinator.connected

        @callback
        def on_coordinator() -> None:
            nonlocal was_connected
            connected = coordinator.connected
            if connected and not was_connected:
                self._async_snapshot()
            was_connected = connected

        self._unsubs = [
            self.hass.bus.async_listen(
                EVENT_STATE_CHANGED,
                self._async_state_changed,
                event_filter=_domain_filter,
            ),
            async_track_time_interval(
                self.hass,
                self._async_tick,
                timedelta(seconds=SENSOR_SNAPSHOT_SECONDS),
            ),
            coordinator.async_add_listener(on_coordinator),
        ]
        self._async_snapshot()

    @callback
    def async_stop(self) -> None:
        self._stopped = True
        for unsub in self._unsubs:
            unsub()
        self._unsubs = []
        for timer in (self._timer, self._retry):
            if timer:
                timer()
        self._timer = self._retry = None
        self._pending.clear()

    @callback
    def _async_tick(self, _now: datetime) -> None:
        self._async_snapshot()

    @callback
    def _async_snapshot(self) -> None:
        """A snapshot says everything, so it makes any waiting change redundant."""
        if self._stopped:
            return
        self._pending.clear()
        for timer in (self._timer, self._retry):
            if timer:
                timer()
        self._timer = self._retry = None
        self.entry.async_create_background_task(
            self.hass, self._async_send(snapshot=True), "home_security sensor snapshot"
        )

    @callback
    def _async_state_changed(self, event: Event) -> None:
        new_state: State | None = event.data.get("new_state")
        if new_state is None or not _wanted(new_state):
            return
        self._pending[new_state.entity_id] = new_state
        if self._timer is None:
            self._timer = async_call_later(self.hass, SENSOR_BATCH_SECONDS, self._async_flush)

    @callback
    def _async_flush(self, _now: datetime) -> None:
        self._timer = None
        if self._stopped or not self._pending:
            return
        self.entry.async_create_background_task(
            self.hass, self._async_send(snapshot=False), "home_security sensor changes"
        )

    @callback
    def _async_retry_soon(self) -> None:
        """A change that didn't get through is made good by a snapshot a few seconds on."""
        if self._retry is None and not self._stopped:
            self._retry = async_call_later(self.hass, SENSOR_RETRY_SECONDS, self._async_retry)

    @callback
    def _async_retry(self, _now: datetime) -> None:
        self._retry = None
        self._async_snapshot()

    async def _async_send(self, *, snapshot: bool) -> None:
        if snapshot:
            states = [_payload(s) for s in self.hass.states.async_all() if _wanted(s)]
        else:
            states = [_payload(s) for s in self._pending.values()]
            self._pending.clear()
        client = self.entry.runtime_data.client
        async with self._lock:
            try:
                await client.async_post_sensors(snapshot=snapshot, states=states)
            except EngineWantsSnapshot:
                # The engine restarted and has nothing to merge changes into: tell it all.
                self._async_snapshot()
            except EngineError as err:
                if not snapshot:
                    self._async_retry_soon()
                if not self._failing:
                    _LOGGER.warning(
                        "Couldn't send the house's sensors to the engine (will retry with "
                        "the next snapshot): %s",
                        err,
                    )
                self._failing = True
            else:
                self._failing = False


@callback
def async_setup_sensors(hass: HomeAssistant, entry: HomeSecurityConfigEntry) -> None:
    pusher = SensorPusher(hass, entry)
    pusher.async_start()
    entry.async_on_unload(pusher.async_stop)

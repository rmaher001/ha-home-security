"""Keeps the engine's state live over its websocket."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import aiohttp
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .api import EngineAuthError, EngineClient, EngineError
from .const import DOMAIN, SIGNAL_UPDATE, STORY_DAYS

if TYPE_CHECKING:
    from . import HomeSecurityConfigEntry

_LOGGER = logging.getLogger(__name__)

BACKOFF_START = 1.0
BACKOFF_MAX = 60.0


class HomeSecurityCoordinator:
    """Holds one websocket to the engine and the latest state and stories."""

    def __init__(
        self, hass: HomeAssistant, entry: HomeSecurityConfigEntry, client: EngineClient
    ) -> None:
        self.hass = hass
        self.entry = entry
        self.client = client
        self.state: dict[str, Any] | None = None
        self.stories: list[dict[str, Any]] = []
        self.connected = False
        self._listeners: list[Callable[[], None]] = []
        self._task: asyncio.Task[None] | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None

    @callback
    def async_add_listener(self, update: Callable[[], None]) -> CALLBACK_TYPE:
        """Call update whenever the state, the stories or the connection change."""
        self._listeners.append(update)

        @callback
        def remove() -> None:
            self._listeners.remove(update)

        return remove

    @callback
    def _notify(self) -> None:
        for update in list(self._listeners):
            update()
        async_dispatcher_send(self.hass, SIGNAL_UPDATE)

    async def async_start(self) -> None:
        """Read the state once (raising if the engine is unreachable), then go live."""
        self.state = await self.client.async_get_state()
        await self._async_refresh_stories()
        self._task = self.entry.async_create_background_task(
            self.hass, self._async_run(), f"{DOMAIN} websocket"
        )

    async def async_stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        if self._ws and not self._ws.closed:
            await self._ws.close()
        self._set_connected(False)

    async def _async_run(self) -> None:
        backoff = BACKOFF_START
        while True:
            try:
                self._ws = await self.client.async_ws_connect()
            except EngineAuthError:
                _LOGGER.warning("The engine refused the token; pair again")
                self._set_connected(False)
                self.entry.async_start_reauth(self.hass)
                return
            except EngineError as err:
                _LOGGER.debug("Engine websocket unavailable: %s", err)
            else:
                backoff = BACKOFF_START
                await self._async_read(self._ws)
            self._set_connected(False)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX)

    async def _async_read(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        first = True
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                break
            try:
                data = msg.json()
            except ValueError:
                _LOGGER.warning("Ignoring a malformed message from the engine")
                continue
            if not isinstance(data, dict) or data.get("type") != "state":
                continue
            state = data.get("state")
            if not isinstance(state, dict):
                continue
            # Anything may have changed while the socket was down: refetch on reconnect.
            await self._async_apply(state, refetch=first)
            first = False

    async def _async_apply(self, state: dict[str, Any], *, refetch: bool) -> None:
        previous = self.state or {}
        self.state = state
        if refetch or state.get("stories") != previous.get("stories"):
            await self._async_refresh_stories()
        if state.get("version") != previous.get("version"):
            self._update_device_version()
        self.connected = True
        self._notify()

    async def _async_refresh_stories(self) -> None:
        try:
            self.stories = await self.client.async_get_stories(STORY_DAYS)
        except EngineError as err:
            _LOGGER.warning("Could not fetch the stories: %s", err)

    @callback
    def _set_connected(self, connected: bool) -> None:
        if self.connected != connected:
            self.connected = connected
            self._notify()

    @callback
    def _update_device_version(self) -> None:
        registry = dr.async_get(self.hass)
        device = registry.async_get_device_by_identifier(
            (DOMAIN, self.entry.entry_id), self.entry.entry_id
        )
        if device and self.state:
            registry.async_update_device(device.id, sw_version=self.state.get("version"))


@callback
def async_get_coordinator(hass: HomeAssistant) -> HomeSecurityCoordinator | None:
    """The loaded entry's coordinator (there is at most one entry)."""
    for entry in hass.config_entries.async_loaded_entries(DOMAIN):
        return entry.runtime_data.coordinator
    return None

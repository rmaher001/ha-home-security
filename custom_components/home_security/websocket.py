"""Websocket commands for the integration's cards."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.components.http.auth import async_sign_path
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .api import EngineError, EngineNotFound
from .const import MODES, PICTURE_URL, SIGNAL_UPDATE, STORY_DAYS, STORY_ID_RE
from .coordinator import HomeSecurityCoordinator, async_get_coordinator

STORY_ID = vol.All(str, vol.Match(STORY_ID_RE))
PICTURE_URL_LIFETIME = timedelta(hours=1)


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    for command in (
        ws_state,
        ws_stories,
        ws_mark_fine,
        ws_set_mode,
        ws_subscribe,
        ws_picture_url,
    ):
        websocket_api.async_register_command(hass, command)


def _coordinator(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> HomeSecurityCoordinator | None:
    if (coordinator := async_get_coordinator(hass)) is None:
        connection.send_error(msg["id"], "not_loaded", "Home Security isn't set up")
    return coordinator


def _send_engine_error(
    connection: websocket_api.ActiveConnection, msg: dict[str, Any], err: EngineError
) -> None:
    if isinstance(err, EngineNotFound):
        connection.send_error(msg["id"], "not_found", "The engine has no such story")
    else:
        connection.send_error(msg["id"], "engine_error", str(err) or "The engine refused")


@websocket_api.websocket_command({vol.Required("type"): "home_security/state"})
@callback
def ws_state(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    if coordinator := _coordinator(hass, connection, msg):
        connection.send_result(msg["id"], coordinator.state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_security/stories",
        vol.Optional("days", default=STORY_DAYS): vol.All(int, vol.Range(min=1, max=31)),
    }
)
@websocket_api.async_response
async def ws_stories(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    if not (coordinator := _coordinator(hass, connection, msg)):
        return
    if msg["days"] == STORY_DAYS:
        connection.send_result(msg["id"], coordinator.stories)
        return
    try:
        stories = await coordinator.client.async_get_stories(msg["days"])
    except EngineError as err:
        _send_engine_error(connection, msg, err)
        return
    connection.send_result(msg["id"], stories)


@websocket_api.websocket_command(
    {vol.Required("type"): "home_security/mark_fine", vol.Required("story_id"): STORY_ID}
)
@websocket_api.async_response
async def ws_mark_fine(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    if not (coordinator := _coordinator(hass, connection, msg)):
        return
    try:
        await coordinator.client.async_mark_fine(msg["story_id"])
    except EngineError as err:
        _send_engine_error(connection, msg, err)
        return
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "home_security/set_mode", vol.Required("mode"): vol.In(MODES)}
)
@websocket_api.async_response
async def ws_set_mode(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    if not (coordinator := _coordinator(hass, connection, msg)):
        return
    try:
        await coordinator.client.async_set_mode(msg["mode"])
    except EngineError as err:
        _send_engine_error(connection, msg, err)
        return
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): "home_security/subscribe"})
@callback
def ws_subscribe(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Send the state and stories now and on every change.

    Follows whichever entry is loaded, so a reload doesn't strand the cards.
    """

    @callback
    def forward() -> None:
        coordinator = async_get_coordinator(hass)
        event: dict[str, Any] = {
            "state": coordinator.state if coordinator else None,
            "stories": coordinator.stories if coordinator else [],
            "connected": bool(coordinator and coordinator.connected),
        }
        connection.send_message(websocket_api.event_message(msg["id"], event))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_UPDATE, forward)
    connection.send_result(msg["id"])
    forward()


@websocket_api.websocket_command(
    {vol.Required("type"): "home_security/picture_url", vol.Required("story_id"): STORY_ID}
)
@callback
def ws_picture_url(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """A signed picture path an <img> tag can load without a login header."""
    path = PICTURE_URL.format(story_id=msg["story_id"])
    connection.send_result(msg["id"], {"url": async_sign_path(hass, path, PICTURE_URL_LIFETIME)})

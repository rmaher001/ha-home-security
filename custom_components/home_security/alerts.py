"""Cards from the engine become phone notifications."""

from __future__ import annotations

from typing import TYPE_CHECKING

from aiohttp import web
from homeassistant.components import webhook
from homeassistant.core import HomeAssistant

from .const import CONF_WEBHOOK_ID, DOMAIN, NAME

if TYPE_CHECKING:
    from . import HomeSecurityConfigEntry


def async_setup_alerts(hass: HomeAssistant, entry: HomeSecurityConfigEntry) -> None:
    """Register the webhook; everything is undone when the entry unloads."""
    webhook_id = entry.data[CONF_WEBHOOK_ID]

    async def handle(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response:
        return web.Response(status=200)

    webhook.async_register(
        hass, DOMAIN, NAME, webhook_id, handle, local_only=True, allowed_methods=["POST"]
    )
    entry.async_on_unload(lambda: webhook.async_unregister(hass, webhook_id))

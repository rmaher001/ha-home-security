"""The Home Security integration."""

from __future__ import annotations

from dataclasses import dataclass

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import (
    ConfigEntryAuthFailed,
    ConfigEntryNotReady,
    HomeAssistantError,
    ServiceValidationError,
)
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .alerts import async_setup_alerts
from .api import EngineAuthError, EngineClient, EngineError, EngineNotFound
from .app_proxy import AppProxyView, AppRootView, SessionView, async_get_app_access
from .const import (
    ATTR_STORY_ID,
    CONF_TOKEN,
    CONF_URL,
    DOMAIN,
    PANEL_MODULE_KEY,
    SERVICE_MARK_FINE,
    STORY_ID_RE,
)
from .coordinator import HomeSecurityCoordinator, async_get_coordinator
from .frontend import (
    async_register_cards,
    async_register_panel,
    async_remove_panel,
    async_serve_panel,
)
from .sensors import async_setup_sensors
from .views import PictureView
from .websocket import async_register_commands

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SELECT, Platform.SENSOR, Platform.SWITCH]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


@dataclass
class HomeSecurityData:
    client: EngineClient
    coordinator: HomeSecurityCoordinator


type HomeSecurityConfigEntry = ConfigEntry[HomeSecurityData]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Things that live once per Home Assistant run, across entry reloads."""
    hass.services.async_register(
        DOMAIN,
        SERVICE_MARK_FINE,
        _async_mark_fine,
        schema=vol.Schema({vol.Required(ATTR_STORY_ID): str}),
    )
    async_register_commands(hass)
    hass.http.register_view(PictureView())
    hass.http.register_view(SessionView())  # before the catch-all, which would swallow it
    hass.http.register_view(AppRootView())
    hass.http.register_view(AppProxyView())
    await async_register_cards(hass)
    hass.data[PANEL_MODULE_KEY] = await async_serve_panel(hass)
    return True


async def _async_mark_fine(call: ServiceCall) -> None:
    story_id = call.data[ATTR_STORY_ID]
    if not STORY_ID_RE.match(story_id):
        raise ServiceValidationError(translation_domain=DOMAIN, translation_key="invalid_story")
    if (coordinator := async_get_coordinator(call.hass)) is None:
        raise ServiceValidationError(translation_domain=DOMAIN, translation_key="not_loaded")
    try:
        await coordinator.client.async_mark_fine(story_id)
    except EngineNotFound as err:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="story_not_found",
            translation_placeholders={"story_id": story_id},
        ) from err
    except EngineError as err:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="engine_error",
            translation_placeholders={"error": str(err)},
        ) from err


async def async_setup_entry(hass: HomeAssistant, entry: HomeSecurityConfigEntry) -> bool:
    client = EngineClient(
        async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_TOKEN]
    )
    coordinator = HomeSecurityCoordinator(hass, entry, client)
    try:
        await coordinator.async_start()
    except EngineAuthError as err:
        raise ConfigEntryAuthFailed("The engine refused the token; pair again") from err
    except EngineError as err:
        raise ConfigEntryNotReady(f"The engine can't be reached: {err}") from err

    entry.runtime_data = HomeSecurityData(client, coordinator)
    entry.async_on_unload(coordinator.async_stop)
    async_setup_alerts(hass, entry)
    async_setup_sensors(hass, entry)
    await async_register_panel(hass, hass.data[PANEL_MODULE_KEY])
    entry.async_on_unload(lambda: async_remove_panel(hass))
    # Sessions end with the entry: an unload, a reload or pairing again all close the app.
    entry.async_on_unload(async_get_app_access(hass).clear)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: HomeSecurityConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

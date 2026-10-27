"""The Home Security integration."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .alerts import async_setup_alerts
from .api import EngineAuthError, EngineClient, EngineError
from .const import CONF_TOKEN, CONF_URL, DOMAIN
from .coordinator import HomeSecurityCoordinator

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SELECT, Platform.SENSOR, Platform.SWITCH]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


@dataclass
class HomeSecurityData:
    client: EngineClient
    coordinator: HomeSecurityCoordinator


type HomeSecurityConfigEntry = ConfigEntry[HomeSecurityData]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Things that live once per Home Assistant run, across entry reloads."""
    return True


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
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: HomeSecurityConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

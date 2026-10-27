"""Base entity for the engine's device."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, NAME
from .coordinator import HomeSecurityCoordinator


class HomeSecurityEntity(Entity):
    """An entity fed by the coordinator's pushes."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, coordinator: HomeSecurityCoordinator, key: str) -> None:
        self.coordinator = coordinator
        entry = coordinator.entry
        self._attr_translation_key = key
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=NAME,
            manufacturer=NAME,
            sw_version=(coordinator.state or {}).get("version"),
            configuration_url=coordinator.client.url,
        )

    @property
    def engine_state(self) -> dict[str, Any]:
        return self.coordinator.state or {}

    @property
    def health(self) -> dict[str, Any]:
        return self.engine_state.get("health") or {}

    @property
    def available(self) -> bool:
        return self.coordinator.connected and self.coordinator.state is not None

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.coordinator.async_add_listener(self.async_write_ha_state))

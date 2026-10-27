"""The Alerts switch."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import HomeSecurityConfigEntry
from .entity import HomeSecurityEntity

PARALLEL_UPDATES = 1


async def async_setup_entry(
    hass: HomeAssistant,
    entry: HomeSecurityConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([AlertsSwitch(entry.runtime_data.coordinator, "alerts")])


class AlertsSwitch(HomeSecurityEntity, SwitchEntity):
    """Off keeps cards coming, quietly; safety cards always ring."""

    @property
    def is_on(self) -> bool | None:
        return self.engine_state.get("alerts")

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.async_engine_call(self.coordinator.client.async_set_alerts(True))

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.async_engine_call(self.coordinator.client.async_set_alerts(False))

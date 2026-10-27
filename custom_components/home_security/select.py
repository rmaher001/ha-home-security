"""The Mode select."""

from __future__ import annotations

from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import HomeSecurityConfigEntry
from .const import MODES
from .entity import HomeSecurityEntity

PARALLEL_UPDATES = 1


async def async_setup_entry(
    hass: HomeAssistant,
    entry: HomeSecurityConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([ModeSelect(entry.runtime_data.coordinator, "mode")])


class ModeSelect(HomeSecurityEntity, SelectEntity):
    """The chosen mode; Auto lets the engine pick from who is home."""

    _attr_options = MODES

    @property
    def _mode(self) -> dict[str, Any]:
        return self.engine_state.get("mode") or {}

    @property
    def current_option(self) -> str | None:
        return self._mode.get("chosen")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        chosen = self._mode.get("chosen")
        return {"in_force": self._mode.get("effective"), "set_by_hand": chosen != "auto"}

    async def async_select_option(self, option: str) -> None:
        await self.async_engine_call(self.coordinator.client.async_set_mode(option))

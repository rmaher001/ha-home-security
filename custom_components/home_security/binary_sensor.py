"""Diagnostic binary sensors: problem and connections."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import HomeSecurityConfigEntry
from .coordinator import HomeSecurityCoordinator
from .entity import HomeSecurityEntity

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: HomeSecurityConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data.coordinator
    async_add_entities(
        [
            ProblemSensor(coordinator, "problem"),
            LinkSensor(coordinator, "protect", "protect"),
            LinkSensor(coordinator, "home_assistant_link", "home_assistant"),
        ]
    )


class ProblemSensor(HomeSecurityEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def is_on(self) -> bool | None:
        ok = self.health.get("ok")
        return None if ok is None else not ok

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"problems": list(self.health.get("problems") or [])}


class LinkSensor(HomeSecurityEntity, BinarySensorEntity):
    """A connection the engine uses; null means the engine isn't set up to use it."""

    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: HomeSecurityCoordinator, key: str, field: str) -> None:
        super().__init__(coordinator, key)
        self._field = field

    @property
    def available(self) -> bool:
        return super().available and self.health.get(self._field) is not None

    @property
    def is_on(self) -> bool | None:
        return self.health.get(self._field)

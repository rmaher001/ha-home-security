"""Diagnostic sensors: the AI, cameras and the sound listener."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.const import EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import HomeSecurityConfigEntry
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
            AiSensor(coordinator, "ai"),
            AiSpeedSensor(coordinator, "ai_speed"),
            CamerasSensor(coordinator, "cameras_connected"),
            ListenerSensor(coordinator, "sound_listener"),
        ]
    )


class _Diagnostic(HomeSecurityEntity, SensorEntity):
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def ai(self) -> dict[str, Any]:
        return self.health.get("ai") or {}


class AiSensor(_Diagnostic):
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["answering", "not_answering"]

    @property
    def native_value(self) -> str | None:
        ok = self.ai.get("ok")
        if ok is None:
            return None
        return "answering" if ok else "not_answering"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"seconds": self.ai.get("seconds")}


class AiSpeedSensor(_Diagnostic):
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_suggested_display_precision = 1

    @property
    def native_value(self) -> float | None:
        return self.ai.get("seconds")


class CamerasSensor(_Diagnostic):
    _attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def native_value(self) -> int | None:
        return (self.health.get("cameras") or {}).get("connected")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"total": (self.health.get("cameras") or {}).get("total")}


class ListenerSensor(_Diagnostic):
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["on", "off"]

    @property
    def native_value(self) -> str | None:
        return self.health.get("listener")

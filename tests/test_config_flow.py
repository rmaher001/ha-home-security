"""Config, reauth and options flows."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from homeassistant import config_entries
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.core_config import async_process_ha_core_config
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_security.const import (
    CONF_CODE,
    CONF_DASHBOARD,
    CONF_PHONES,
    CONF_TOKEN,
    CONF_URL,
    CONF_WEBHOOK_ID,
    CONF_WEBHOOK_SECRET,
    DOMAIN,
)

from .conftest import PAIR_CODE, WEBHOOK_ID, WEBHOOK_SECRET, FakeEngine

INTERNAL_URL = "http://192.0.2.20:8123"


@pytest.fixture
async def internal_url(hass: HomeAssistant) -> None:
    await async_process_ha_core_config(hass, {"internal_url": INTERNAL_URL})


@pytest.fixture(autouse=True)
def no_setup():
    with patch("custom_components.home_security.async_setup_entry", return_value=True) as m:
        yield m


async def _start(hass: HomeAssistant):
    return await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )


async def test_pairing_success(hass: HomeAssistant, engine: FakeEngine, internal_url) -> None:
    result = await _start(hass)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: engine.url + "/", CONF_CODE: PAIR_CODE}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Home Security"
    data = result["data"]
    assert data[CONF_URL] == engine.url
    assert data[CONF_TOKEN] == engine.token
    assert data[CONF_WEBHOOK_ID]
    assert len(data[CONF_WEBHOOK_SECRET]) >= 32

    sent = engine.paired[0]
    assert sent["name"] == "Home Assistant"
    assert sent["code"] == PAIR_CODE
    assert sent["webhook_url"] == f"{INTERNAL_URL}/api/webhook/{data[CONF_WEBHOOK_ID]}"
    assert sent["webhook_secret"] == data[CONF_WEBHOOK_SECRET]


async def test_cannot_connect(hass: HomeAssistant, internal_url, socket_enabled) -> None:
    result = await _start(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: "http://127.0.0.1:1", CONF_CODE: PAIR_CODE}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_wrong_code(hass: HomeAssistant, engine: FakeEngine, internal_url) -> None:
    result = await _start(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: engine.url, CONF_CODE: "WRONG-123"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_code"}

    # The form can be retried with the right code.
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: engine.url, CONF_CODE: PAIR_CODE}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_no_internal_url(hass: HomeAssistant, engine: FakeEngine) -> None:
    result = await _start(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: engine.url, CONF_CODE: PAIR_CODE}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "no_internal_url"}
    assert engine.paired == []


async def test_single_instance(hass: HomeAssistant, config_entry: MockConfigEntry) -> None:
    config_entry.add_to_hass(hass)
    result = await _start(hass)
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_reauth(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, internal_url
) -> None:
    config_entry.add_to_hass(hass)
    engine.token = "fresh-token"
    result = await config_entry.start_reauth_flow(hass)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "reauth_confirm"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_CODE: "WRONG-123"}
    )
    assert result["errors"] == {"base": "invalid_code"}

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_CODE: PAIR_CODE}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert config_entry.data[CONF_TOKEN] == "fresh-token"
    assert config_entry.data[CONF_WEBHOOK_ID] == WEBHOOK_ID
    assert config_entry.data[CONF_WEBHOOK_SECRET] == WEBHOOK_SECRET
    sent = engine.paired[-1]
    assert sent["webhook_url"] == f"{INTERNAL_URL}/api/webhook/{WEBHOOK_ID}"
    assert sent["webhook_secret"] == WEBHOOK_SECRET


async def test_options(hass: HomeAssistant, config_entry: MockConfigEntry) -> None:
    async def _noop(call: ServiceCall) -> None:
        return None

    hass.services.async_register("notify", "mobile_app_alex_phone", _noop)
    hass.services.async_register("notify", "mobile_app_sam_tablet", _noop)
    hass.services.async_register("notify", "persistent_notification", _noop)
    config_entry.add_to_hass(hass)

    result = await hass.config_entries.options.async_init(config_entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    schema = result["data_schema"].schema
    phones_key = next(k for k in schema if k == CONF_PHONES)
    options = schema[phones_key].config["options"]
    values = sorted(o["value"] if isinstance(o, dict) else o for o in options)
    assert values == ["mobile_app_alex_phone", "mobile_app_sam_tablet"]

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {CONF_PHONES: ["mobile_app_alex_phone"], CONF_DASHBOARD: "/lovelace/security"},
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert config_entry.options == {
        CONF_PHONES: ["mobile_app_alex_phone"],
        CONF_DASHBOARD: "/lovelace/security",
    }


async def test_options_defaults(hass: HomeAssistant, config_entry: MockConfigEntry) -> None:
    config_entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(config_entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert config_entry.options == {CONF_PHONES: [], CONF_DASHBOARD: "/security"}

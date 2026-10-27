"""Config flow: pair with the engine; options: phones and dashboard."""

from __future__ import annotations

import logging
import secrets
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.components import webhook
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.network import NoURLAvailableError
from homeassistant.helpers.selector import (
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .api import EngineCodeRefused, EngineConnectionError, EngineError, async_pair
from .const import (
    CONF_CODE,
    CONF_DASHBOARD,
    CONF_PHONES,
    CONF_TOKEN,
    CONF_URL,
    CONF_WEBHOOK_ID,
    CONF_WEBHOOK_SECRET,
    DEFAULT_DASHBOARD,
    DOMAIN,
    NAME,
    PAIR_NAME,
)

_LOGGER = logging.getLogger(__name__)

USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_URL): TextSelector(TextSelectorConfig(type=TextSelectorType.URL)),
        vol.Required(CONF_CODE): str,
    }
)
REAUTH_SCHEMA = vol.Schema({vol.Required(CONF_CODE): str})


def _webhook_url(hass: HomeAssistant, webhook_id: str) -> str:
    """The URL the engine, on the LAN, posts cards to. Raises NoURLAvailableError.

    Only a configured local network URL counts: a guessed IP can be a container address
    the engine cannot reach, and an external URL would send cards off the LAN.
    """
    if not hass.config.internal_url:
        raise NoURLAvailableError
    return webhook.async_generate_url(
        hass,
        webhook_id,
        allow_internal=True,
        allow_external=False,
        prefer_external=False,
    )


async def _pair(
    hass: HomeAssistant, url: str, code: str, webhook_id: str, secret: str
) -> tuple[str | None, str | None]:
    """Pair with the engine. Returns (token, error key)."""
    try:
        webhook_url = _webhook_url(hass, webhook_id)
    except NoURLAvailableError:
        return None, "no_internal_url"
    try:
        token = await async_pair(
            async_get_clientsession(hass),
            url,
            code=code.strip(),
            name=PAIR_NAME,
            webhook_url=webhook_url,
            webhook_secret=secret,
        )
    except EngineConnectionError:
        return None, "cannot_connect"
    except EngineCodeRefused:
        return None, "invalid_code"
    except EngineError:
        _LOGGER.exception("Pairing with the engine failed")
        return None, "unknown"
    return token, None


class HomeSecurityConfigFlow(ConfigFlow, domain=DOMAIN):
    """Pair Home Assistant with the engine."""

    VERSION = 1

    def __init__(self) -> None:
        self._webhook_id = webhook.async_generate_id()
        self._secret = secrets.token_urlsafe(32)

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            token, error = await _pair(
                self.hass, url, user_input[CONF_CODE], self._webhook_id, self._secret
            )
            if token:
                return self.async_create_entry(
                    title=NAME,
                    data={
                        CONF_URL: url,
                        CONF_TOKEN: token,
                        CONF_WEBHOOK_ID: self._webhook_id,
                        CONF_WEBHOOK_SECRET: self._secret,
                    },
                )
            errors["base"] = error or "unknown"
        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(USER_SCHEMA, user_input),
            errors=errors,
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """A new code gives a new token; the webhook and its secret stay."""
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()
        if user_input is not None:
            token, error = await _pair(
                self.hass,
                entry.data[CONF_URL],
                user_input[CONF_CODE],
                entry.data[CONF_WEBHOOK_ID],
                entry.data[CONF_WEBHOOK_SECRET],
            )
            if token:
                return self.async_update_reload_and_abort(entry, data_updates={CONF_TOKEN: token})
            errors["base"] = error or "unknown"
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=REAUTH_SCHEMA,
            errors=errors,
            description_placeholders={"url": entry.data[CONF_URL]},
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """A new engine address, or pairing again on purpose: a new code, same webhook."""
        errors: dict[str, str] = {}
        entry = self._get_reconfigure_entry()
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            token, error = await _pair(
                self.hass,
                url,
                user_input[CONF_CODE],
                entry.data[CONF_WEBHOOK_ID],
                entry.data[CONF_WEBHOOK_SECRET],
            )
            if token:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_URL: url, CONF_TOKEN: token}
                )
            errors["base"] = error or "unknown"
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=self.add_suggested_values_to_schema(
                USER_SCHEMA, user_input or {CONF_URL: entry.data[CONF_URL]}
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return HomeSecurityOptionsFlow()


class HomeSecurityOptionsFlow(OptionsFlow):
    """Which phones get alerts, and where a tap on one leads."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(
                data={
                    CONF_PHONES: list(user_input.get(CONF_PHONES, [])),
                    CONF_DASHBOARD: user_input.get(CONF_DASHBOARD) or DEFAULT_DASHBOARD,
                }
            )

        chosen = list(self.config_entry.options.get(CONF_PHONES, []))
        services = self.hass.services.async_services_for_domain("notify")
        # Keep earlier choices selectable even if that phone is currently gone.
        phones = sorted({s for s in services if s.startswith("mobile_app_")} | set(chosen))
        schema = vol.Schema(
            {
                vol.Optional(CONF_PHONES, default=chosen): SelectSelector(
                    SelectSelectorConfig(
                        options=phones, multiple=True, mode=SelectSelectorMode.LIST
                    )
                ),
                vol.Optional(
                    CONF_DASHBOARD,
                    default=self.config_entry.options.get(CONF_DASHBOARD, DEFAULT_DASHBOARD),
                ): str,
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)

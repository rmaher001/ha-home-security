"""Serves the cards file and loads it on every dashboard."""

from __future__ import annotations

import hashlib
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import CARDS_FILE, DOMAIN, FRONTEND_URL_BASE

CARDS_PATH = Path(__file__).parent / "frontend" / CARDS_FILE


def _file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


async def async_register_cards(hass: HomeAssistant) -> str:
    """Serve the cards under a name that carries the version and the file's hash.

    Browsers cache the file; any change to it gives a new name, so it is never served
    stale, even when the version wasn't bumped.
    """
    integration = await async_get_integration(hass, DOMAIN)
    digest = await hass.async_add_executor_job(_file_digest, CARDS_PATH)
    url = f"{FRONTEND_URL_BASE}/{CARDS_PATH.stem}-{integration.version}-{digest}.js"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(url, str(CARDS_PATH), cache_headers=True)]
    )
    add_extra_js_url(hass, url)
    return url

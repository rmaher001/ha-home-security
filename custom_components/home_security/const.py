"""Constants for the Home Security integration."""

from __future__ import annotations

import re
from typing import Final

DOMAIN: Final = "home_security"
NAME: Final = "Home Security"

CONF_URL: Final = "url"
CONF_CODE: Final = "code"
CONF_TOKEN: Final = "token"
CONF_WEBHOOK_ID: Final = "webhook_id"
CONF_WEBHOOK_SECRET: Final = "webhook_secret"
CONF_PHONES: Final = "phones"

PAIR_NAME: Final = "Home Assistant"
STORY_DAYS: Final = 7

MODES: Final = ["auto", "home", "night", "away"]

# Story ids from the engine are ULIDs; anything else never reaches a URL we build.
# \Z, not $: $ also matches before a trailing newline.
STORY_ID_RE: Final = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")

ATTR_STORY_ID: Final = "story_id"
SERVICE_MARK_FINE: Final = "mark_fine"

PICTURE_URL: Final = "/api/home_security/picture/{story_id}"
PANEL_URL_PATH_PREFIX: Final = "/home-security"
FRONTEND_URL_BASE: Final = "/home_security_frontend"
CARDS_FILE: Final = "home-security-cards.js"

FINE_ACTION_PREFIX: Final = "HS_FINE::"
NOTIFY_TAG_PREFIX: Final = "hs-"
NOTIFY_GROUP: Final = "home-security"

SIGNAL_UPDATE: Final = f"{DOMAIN}_update"

# Job 2: the house facts pushed to the engine.
SENSOR_DEVICE_CLASSES: Final = frozenset(
    {
        "door",
        "window",
        "garage_door",
        "opening",
        "lock",
        "smoke",
        "carbon_monoxide",
        "gas",
        "moisture",
    }
)
SENSOR_DOMAINS: Final = frozenset({"binary_sensor", "lock", "person"})
SENSOR_SNAPSHOT_SECONDS: Final = 300
SENSOR_BATCH_SECONDS: Final = 1

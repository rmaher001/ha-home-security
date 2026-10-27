"""Cards from the engine become phone notifications."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from datetime import timedelta
from enum import StrEnum
from http import HTTPStatus
from typing import TYPE_CHECKING, Any

from aiohttp import web
from homeassistant.components import webhook
from homeassistant.components.http.auth import async_sign_path
from homeassistant.core import Event, HomeAssistant
from homeassistant.util import slugify

from .api import EngineError
from .const import (
    CONF_DASHBOARD,
    CONF_PHONES,
    CONF_WEBHOOK_ID,
    CONF_WEBHOOK_SECRET,
    DEFAULT_DASHBOARD,
    DOMAIN,
    FINE_ACTION_PREFIX,
    NAME,
    NOTIFY_GROUP,
    NOTIFY_TAG_PREFIX,
    PICTURE_URL,
    STORY_ID_RE,
)

if TYPE_CHECKING:
    from . import HomeSecurityConfigEntry

_LOGGER = logging.getLogger(__name__)

MAX_SKEW = 300
IMAGE_LIFETIME = timedelta(days=1)
EVENT_NOTIFICATION_ACTION = "mobile_app_notification_action"
EVENT_LOGBOOK_ENTRY = "logbook_entry"
QUIET_NAME = "Home security (quiet)"
FINE_TITLE = "That's fine"


class Loudness(StrEnum):
    """How hard a notification interrupts (named after iOS interruption levels)."""

    PASSIVE = "passive"
    ACTIVE = "active"
    CRITICAL = "critical"


ANDROID_CHANNELS: dict[Loudness, dict[str, Any]] = {
    Loudness.PASSIVE: {"channel": "Home security updates", "importance": "low"},
    Loudness.ACTIVE: {"channel": "Home security", "importance": "default"},
    Loudness.CRITICAL: {
        "channel": "alarm_stream",
        "importance": "high",
        "priority": "high",
        "ttl": 0,
    },
}
IOS_CRITICAL_SOUND = {"name": "default", "critical": 1, "volume": 1.0}


def verify_signature(secret: str, headers: Any, body: bytes, now: float) -> bool:
    """HMAC-SHA256 over `<timestamp>.<body>`, and the timestamp within five minutes."""
    timestamp = headers.get("X-HS-Timestamp", "")
    signature = headers.get("X-HS-Signature", "")
    try:
        sent_at = int(timestamp)
    except ValueError:
        return False
    if abs(now - sent_at) > MAX_SKEW or not signature.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), f"{sent_at}.".encode() + body, hashlib.sha256)
    return hmac.compare_digest(expected.hexdigest(), signature.removeprefix("sha256="))


def loudness(level: str | None, alert: bool) -> Loudness:
    # Safety (smoke, CO, leak) always rings, whatever the alerts switch says.
    if level == "safety":
        return Loudness.CRITICAL
    if not alert:
        return Loudness.PASSIVE
    if level == "high":
        return Loudness.CRITICAL
    if level == "watch":
        return Loudness.ACTIVE
    return Loudness.PASSIVE


def _is_android(hass: HomeAssistant, service: str) -> bool:
    """Read the phone's OS from the mobile_app entry behind its notify service."""
    for entry in hass.config_entries.async_entries("mobile_app"):
        if f"mobile_app_{slugify(entry.data.get('device_name', ''))}" == service:
            return entry.data.get("os_name") == "Android"
    return False


def build_notification(
    hass: HomeAssistant, service: str, card: dict[str, Any], dashboard: str
) -> dict[str, Any]:
    story = card["story"]
    level = card.get("level")
    loud = loudness(level, bool(card.get("alert")))
    separator = "&" if "?" in dashboard else "?"
    link = f"{dashboard}{separator}story={story}"

    data: dict[str, Any] = {"tag": f"{NOTIFY_TAG_PREFIX}{story}", "group": NOTIFY_GROUP}
    if level != "safety":
        # The phone app loads this relative path from Home Assistant; the signature
        # stands in for the login header it can't send.
        data["image"] = async_sign_path(
            hass,
            PICTURE_URL.format(story_id=story),
            IMAGE_LIFETIME,
            use_content_user=True,
        )
        data["actions"] = [{"action": f"{FINE_ACTION_PREFIX}{story}", "title": FINE_TITLE}]

    if _is_android(hass, service):
        data["clickAction"] = link
        data.update(ANDROID_CHANNELS[loud])
    else:
        data["url"] = link
        push: dict[str, Any] = {"interruption-level": str(loud)}
        if loud is Loudness.CRITICAL:
            push["sound"] = dict(IOS_CRITICAL_SOUND)
        data["push"] = push

    return {
        "title": card.get("title") or NAME,
        "message": card.get("message") or "",
        "data": data,
    }


async def _async_notify(hass: HomeAssistant, service: str, data: dict[str, Any]) -> bool:
    try:
        await hass.services.async_call("notify", service, data, blocking=True)
    except Exception:  # one phone failing must not stop the others
        _LOGGER.warning("Couldn't send a Home Security alert to notify.%s", service, exc_info=True)
        return False
    return True


async def async_handle_card(
    hass: HomeAssistant, entry: HomeSecurityConfigEntry, card: dict[str, Any]
) -> int:
    """Hand one card to the phones. Returns the HTTP status for the engine."""
    story = card.get("story")
    if not isinstance(story, str) or not STORY_ID_RE.match(story):
        _LOGGER.warning("Ignoring a card without a valid story id")
        return HTTPStatus.OK

    if card.get("shadow"):
        hass.bus.async_fire(
            EVENT_LOGBOOK_ENTRY,
            {
                "name": QUIET_NAME,
                "message": f"{card.get('title') or ''}: {card.get('message') or ''}",
                "domain": DOMAIN,
            },
        )
        return HTTPStatus.OK

    phones: list[str] = list(entry.options.get(CONF_PHONES, []))
    dashboard: str = entry.options.get(CONF_DASHBOARD) or DEFAULT_DASHBOARD
    sends = [
        _async_notify(hass, phone, build_notification(hass, phone, card, dashboard))
        for phone in phones
    ]
    for joined in card.get("joined") or []:
        if isinstance(joined, str) and STORY_ID_RE.match(joined):
            clear = {
                "message": "clear_notification",
                "data": {"tag": f"{NOTIFY_TAG_PREFIX}{joined}"},
            }
            sends.extend(_async_notify(hass, phone, clear) for phone in phones)

    results = await asyncio.gather(*sends)
    # Answering 500 makes the engine resend; only worth it when nothing got through.
    if results and not any(results):
        return HTTPStatus.INTERNAL_SERVER_ERROR
    return HTTPStatus.OK


def async_setup_alerts(hass: HomeAssistant, entry: HomeSecurityConfigEntry) -> None:
    """Register the webhook and the That's fine action; both go when the entry unloads."""
    webhook_id = entry.data[CONF_WEBHOOK_ID]
    secret = entry.data[CONF_WEBHOOK_SECRET]

    async def handle(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response:
        body = await request.read()
        if not verify_signature(secret, request.headers, body, time.time()):
            return web.Response(status=HTTPStatus.UNAUTHORIZED)
        try:
            message = json.loads(body)
        except ValueError:
            return web.Response(status=HTTPStatus.BAD_REQUEST)
        # Sound requests are for a receiver that plays sounds; this one doesn't.
        if not isinstance(message, dict) or message.get("type") != "card":
            return web.Response(status=HTTPStatus.OK)
        return web.Response(status=await async_handle_card(hass, entry, message))

    webhook.async_register(
        hass, DOMAIN, NAME, webhook_id, handle, local_only=True, allowed_methods=["POST"]
    )
    entry.async_on_unload(lambda: webhook.async_unregister(hass, webhook_id))

    async def on_action(event: Event) -> None:
        action = event.data.get("action")
        if not isinstance(action, str) or not action.startswith(FINE_ACTION_PREFIX):
            return
        story = action.removeprefix(FINE_ACTION_PREFIX)
        if not STORY_ID_RE.match(story):
            return
        try:
            await entry.runtime_data.client.async_mark_fine(story)
        except EngineError as err:
            _LOGGER.warning("Couldn't mark story %s fine: %s", story, err)

    entry.async_on_unload(hass.bus.async_listen(EVENT_NOTIFICATION_ACTION, on_action))

"""Cards from the engine become phone notifications."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
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
    CONF_PHONES,
    CONF_WEBHOOK_ID,
    CONF_WEBHOOK_SECRET,
    DOMAIN,
    FINE_ACTION_PREFIX,
    NAME,
    NOTIFY_GROUP,
    NOTIFY_TAG_PREFIX,
    PANEL_URL_PATH_PREFIX,
    PICTURE_URL,
    STORY_ID_RE,
)

if TYPE_CHECKING:
    from . import HomeSecurityConfigEntry

_LOGGER = logging.getLogger(__name__)

MAX_SKEW = 300
MAX_BODY = 64 * 1024
SIGNATURE_RE = re.compile(r"\Asha256=([0-9a-f]{64})\Z")
# One spelling per number: "0123", "+123" would verify after int() as a new message.
TIMESTAMP_RE = re.compile(r"\A[1-9][0-9]{0,11}\Z")
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
    if not TIMESTAMP_RE.match(timestamp):
        return False
    sent_at = int(timestamp)
    if abs(now - sent_at) > MAX_SKEW or not (match := SIGNATURE_RE.match(signature)):
        return False
    expected = hmac.new(secret.encode(), f"{sent_at}.".encode() + body, hashlib.sha256)
    return hmac.compare_digest(expected.hexdigest().encode(), match.group(1).encode())


class Seen(StrEnum):
    NEW = "new"
    HANDLING = "handling"
    TAKEN = "taken"


class ReplayGuard:
    """Remembers the cards of the last five minutes by signature, to act on each once.

    Older ones need no memory: the timestamp check already refuses them. A card is held
    from the moment it arrives and let go if it wasn't taken, so the engine's resend after
    a 500 still gets through.
    """

    def __init__(self) -> None:
        self._seen: dict[str, tuple[float, Seen]] = {}

    def hold(self, signature: str, sent_at: float, now: float) -> Seen:
        """NEW (and now held), or what an earlier copy's state is."""
        self._seen = {
            key: seen for key, seen in self._seen.items() if abs(now - seen[0]) <= MAX_SKEW
        }
        if (seen := self._seen.get(signature)) is not None:
            return seen[1]
        self._seen[signature] = (sent_at, Seen.HANDLING)
        return Seen.NEW

    def done(self, signature: str, taken: bool) -> None:
        if not taken:
            self._seen.pop(signature, None)
        elif signature in self._seen:
            self._seen[signature] = (self._seen[signature][0], Seen.TAKEN)


async def _async_read_capped(request: web.Request) -> bytes | None:
    """The body, or None when it is over MAX_BODY (with or without a Content-Length)."""
    if request.content_length is not None and request.content_length > MAX_BODY:
        return None
    body = bytearray()
    while chunk := await request.content.read(MAX_BODY + 1 - len(body)):
        body.extend(chunk)
        if len(body) > MAX_BODY:
            return None
    return bytes(body)


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


def build_notification(hass: HomeAssistant, service: str, card: dict[str, Any]) -> dict[str, Any]:
    story = card["story"]
    level = card.get("level")
    loud = loudness(level, bool(card.get("alert")))
    link = f"{PANEL_URL_PATH_PREFIX}?story={story}"

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

    phones: list[str] = list(entry.options.get(CONF_PHONES, []))
    to_clear = [
        joined
        for joined in card.get("joined") or []
        if isinstance(joined, str) and STORY_ID_RE.match(joined)
    ]

    if card.get("shadow"):
        # Alerts are off: the logbook and the dashboard only. The story's own earlier
        # alert comes off the phones too, so none is left showing stale news.
        hass.bus.async_fire(
            EVENT_LOGBOOK_ENTRY,
            {
                "name": QUIET_NAME,
                "message": f"{card.get('title') or ''}: {card.get('message') or ''}",
                "domain": DOMAIN,
            },
        )
        sends = []
        to_clear.insert(0, story)
    else:
        sends = [
            _async_notify(hass, phone, build_notification(hass, phone, card)) for phone in phones
        ]
    for clear_id in to_clear:
        clear = {"message": "clear_notification", "data": {"tag": f"{NOTIFY_TAG_PREFIX}{clear_id}"}}
        sends.extend(_async_notify(hass, phone, clear) for phone in phones)

    results = await asyncio.gather(*sends)
    # Answering 500 makes the engine resend; only worth it when nothing got through.
    if results and not any(results):
        return HTTPStatus.INTERNAL_SERVER_ERROR
    return HTTPStatus.OK


async def _async_take(hass: HomeAssistant, entry: HomeSecurityConfigEntry, body: bytes) -> int:
    """Handle one verified message. Returns the HTTP status for the engine."""
    try:
        message = json.loads(body)
    except ValueError:
        return HTTPStatus.BAD_REQUEST
    # Sound requests are for a receiver that plays sounds; this one doesn't.
    if not isinstance(message, dict) or message.get("type") != "card":
        return HTTPStatus.OK
    try:
        return await async_handle_card(hass, entry, message)
    except Exception:
        # Home Assistant's webhook handler would answer 200 and the card would be lost;
        # 500 makes the engine send it again.
        _LOGGER.exception("Couldn't handle a card from the engine")
        return HTTPStatus.INTERNAL_SERVER_ERROR


def async_setup_alerts(hass: HomeAssistant, entry: HomeSecurityConfigEntry) -> None:
    """Register the webhook and the That's fine action; both go when the entry unloads."""
    webhook_id = entry.data[CONF_WEBHOOK_ID]
    secret = entry.data[CONF_WEBHOOK_SECRET]
    replays = ReplayGuard()

    async def handle(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response:
        if (body := await _async_read_capped(request)) is None:
            return web.Response(status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        now = time.time()
        timestamp = request.headers.get("X-HS-Timestamp", "")
        signature = request.headers.get("X-HS-Signature", "")
        if not verify_signature(secret, request.headers, body, now):
            return web.Response(status=HTTPStatus.UNAUTHORIZED)
        match replays.hold(signature, int(timestamp), now):
            case Seen.TAKEN:
                # Already done. The engine treats 401 as final, so a repeat is simply a no-op.
                return web.Response(status=HTTPStatus.OK)
            case Seen.HANDLING:
                return web.Response(status=HTTPStatus.CONFLICT)
        status = await _async_take(hass, entry, body)
        replays.done(signature, taken=status < HTTPStatus.MULTIPLE_CHOICES)
        return web.Response(status=status)

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

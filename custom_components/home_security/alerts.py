"""Cards from the engine become phone notifications."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
from collections.abc import Coroutine
from datetime import timedelta
from enum import StrEnum
from http import HTTPStatus
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from aiohttp import web
from homeassistant.components import webhook
from homeassistant.components.http.auth import async_sign_path
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import Event, HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.util import slugify

from .api import EngineError
from .const import (
    CONF_PHONES,
    CONF_SCRIPT,
    CONF_SCRIPT_SOURCE,
    CONF_WEBHOOK_ID,
    CONF_WEBHOOK_SECRET,
    DEFAULT_SCRIPT_SOURCE,
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
GUARD_KIND = "guard"
PROTECT_DOMAIN = "unifiprotect"
# Protect camera ids are short alphanumeric strings (24 characters in practice); anything
# of another shape is never looked up.
CAMERA_ID_RE = re.compile(r"\A[A-Za-z0-9]{1,64}\Z")
# The unifiprotect integration's package camera is its channel 3 (unique id `<mac>_3`).
PROTECT_PACKAGE_CHANNEL = "3"


class Loudness(StrEnum):
    """How hard a notification interrupts (named after iOS interruption levels)."""

    PASSIVE = "passive"
    ACTIVE = "active"
    TIME_SENSITIVE = "time-sensitive"
    CRITICAL = "critical"


ANDROID_CHANNELS: dict[Loudness, dict[str, Any]] = {
    Loudness.PASSIVE: {"channel": "Home security updates", "importance": "low"},
    Loudness.ACTIVE: {"channel": "Home security", "importance": "default"},
    # Urgent but not an alarm: breaks through quiet settings, doesn't ring like one.
    Loudness.TIME_SENSITIVE: {
        "channel": "Home security urgent",
        "importance": "high",
        "priority": "high",
    },
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


def loudness(level: str | None, alert: bool, kind: str | None = None) -> Loudness:
    # A guard card is replaced when its description arrives, and iOS can't replace a
    # critical notification, so it is never critical.
    if kind == GUARD_KIND:
        return Loudness.TIME_SENSITIVE if alert else Loudness.PASSIVE
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


def camera_entity_for(hass: HomeAssistant, camera_id: Any) -> str | None:
    """The Home Assistant camera entity of a UniFi Protect camera, or None.

    The live view is decoration: whatever goes wrong, the card goes out without it.
    """
    try:
        return _find_camera_entity(hass, camera_id)
    except Exception:
        _LOGGER.warning("Couldn't find a live view for a Home Security alert", exc_info=True)
        return None


def _find_camera_entity(hass: HomeAssistant, camera_id: Any) -> str | None:
    """The unifiprotect integration registers a camera's device with only a network
    connection (no identifiers) and `configuration_url` = `<console>/protect/devices/<id>`,
    where <id> is Protect's own camera id. Each camera device holds one camera entity per
    stream quality (unique id `<mac>_<channel>`), plus a package camera on channel 3, which
    is not what we want. Only enabled entities count (a disabled one has no state to show);
    the lowest channel (the best quality) wins.
    """
    if not isinstance(camera_id, str) or not CAMERA_ID_RE.match(camera_id):
        return None
    wanted = f"/protect/devices/{camera_id}"
    devices = dr.async_get(hass)
    entities = er.async_get(hass)
    candidates: list[tuple[str, str]] = []
    for device in devices.devices.values():
        if not device.configuration_url:
            continue
        if urlparse(str(device.configuration_url)).path.rstrip("/") != wanted:
            continue
        for entry in er.async_entries_for_device(entities, device.id):
            if entry.domain != "camera" or entry.platform != PROTECT_DOMAIN:
                continue
            channel = str(entry.unique_id).rpartition("_")[2]
            if channel == PROTECT_PACKAGE_CHANNEL:
                continue
            candidates.append((channel, entry.entity_id))
    return min(candidates)[1] if candidates else None


def _alert_payload(hass: HomeAssistant, card: dict[str, Any]) -> dict[str, Any]:
    """What every route (phone or script) carries: the signed picture and the button."""
    story = card["story"]
    if card.get("level") == "safety":
        return {}
    return {
        # The phone app loads this relative path from Home Assistant; the signature
        # stands in for the login header it can't send.
        "image": async_sign_path(
            hass,
            PICTURE_URL.format(story_id=story),
            IMAGE_LIFETIME,
            use_content_user=True,
        ),
        "actions": [{"action": f"{FINE_ACTION_PREFIX}{story}", "title": FINE_TITLE}],
    }


def build_notification(hass: HomeAssistant, service: str, card: dict[str, Any]) -> dict[str, Any]:
    story = card["story"]
    level = card.get("level")
    is_guard = card.get("kind") == GUARD_KIND
    loud = loudness(level, bool(card.get("alert")), card.get("kind"))
    link = f"{PANEL_URL_PATH_PREFIX}?story={story}"

    data: dict[str, Any] = {"tag": f"{NOTIFY_TAG_PREFIX}{story}", "group": NOTIFY_GROUP}
    data.update(_alert_payload(hass, card))

    if _is_android(hass, service):
        data["clickAction"] = link
        data.update(ANDROID_CHANNELS[loud])
    else:
        data["url"] = link
        push: dict[str, Any] = {"interruption-level": str(loud)}
        if loud is Loudness.CRITICAL:
            push["sound"] = dict(IOS_CRITICAL_SOUND)
        data["push"] = push
        # iOS shows a live view of this camera when the notification is expanded.
        if is_guard and (camera := camera_entity_for(hass, card.get("camera_id"))):
            data["entity_id"] = camera

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


def build_script_variables(
    hass: HomeAssistant, entry: HomeSecurityConfigEntry, card: dict[str, Any]
) -> dict[str, Any]:
    """The variables a notification script is started with."""
    story = card["story"]
    variables: dict[str, Any] = {
        "source": entry.options.get(CONF_SCRIPT_SOURCE) or DEFAULT_SCRIPT_SOURCE,
        "title": card.get("title") or NAME,
        "message": card.get("message") or "",
        "click_action": f"{PANEL_URL_PATH_PREFIX}?story={story}",
        "tag": f"{NOTIFY_TAG_PREFIX}{story}",
        **_alert_payload(hass, card),
    }
    if camera := camera_entity_for(hass, card.get("camera_id")):
        variables["camera"] = camera
    return variables


def _script_ready(hass: HomeAssistant, script: str) -> bool:
    """Whether the script exists and is usable. Home Assistant's own script.turn_on only
    logs for a missing entity and returns normally, so an alert would vanish."""
    state = hass.states.get(script)
    return state is not None and state.state != STATE_UNAVAILABLE


async def _async_run_script(hass: HomeAssistant, script: str, variables: dict[str, Any]) -> bool:
    try:
        await hass.services.async_call(
            "script",
            "turn_on",
            {"entity_id": script, "variables": variables},
            blocking=True,
        )
    except Exception:  # the caller sends the card another way
        _LOGGER.warning("Couldn't send a Home Security alert through %s", script, exc_info=True)
        return False
    return True


async def _async_guard_via_script(
    hass: HomeAssistant,
    entry: HomeSecurityConfigEntry,
    card: dict[str, Any],
    script: str,
    phones: list[str],
) -> bool:
    """Send a guard card through the script; if that fails, to the phones. True if it got out."""
    if await _async_run_script(hass, script, build_script_variables(hass, entry, card)):
        return True
    # A guard alert is never lost to its hub failing.
    _LOGGER.warning("Sending the Home Security alert straight to the phones instead")
    results = await asyncio.gather(
        *(_async_notify(hass, phone, build_notification(hass, phone, card)) for phone in phones)
    )
    return any(results)


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

    # `card_sends` is the card's own delivery; `clear_sends` take earlier alerts off the
    # phones. Only the first decides whether the engine should resend.
    card_sends: list[Coroutine[Any, Any, bool]] = []
    clear_sends: list[Coroutine[Any, Any, bool]] = []
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
        to_clear.insert(0, story)
    elif (
        (script := entry.options.get(CONF_SCRIPT))
        and card.get("kind") == GUARD_KIND
        # A quiet re-send would take the hub's level for its source and buzz as if new.
        and card.get("alert")
    ):
        if _script_ready(hass, script):
            # Through the user's notification hub, which decides who hears and how loudly.
            card_sends.append(_async_guard_via_script(hass, entry, card, script, phones))
        else:
            # Calling a missing script only logs, and the alert would be lost.
            _LOGGER.warning(
                "%s isn't available; sending the Home Security alert straight to the phones", script
            )
    if not card.get("shadow") and not card_sends:
        card_sends = [
            _async_notify(hass, phone, build_notification(hass, phone, card)) for phone in phones
        ]
    for clear_id in to_clear:
        clear = {"message": "clear_notification", "data": {"tag": f"{NOTIFY_TAG_PREFIX}{clear_id}"}}
        clear_sends.extend(_async_notify(hass, phone, clear) for phone in phones)

    # Together, so a slow clear never holds up the card; the answer waits for the slower.
    outcomes = await asyncio.gather(*card_sends, *clear_sends)
    results, clears = outcomes[: len(card_sends)], outcomes[len(card_sends) :]
    # Answering 500 makes the engine resend; only worth it when nothing got through. The
    # card's own delivery decides; a card with none (alerts off) is judged on its clears.
    judged = results or clears
    if judged and not any(judged):
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

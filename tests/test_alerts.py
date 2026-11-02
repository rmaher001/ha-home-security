"""Cards from the engine's webhook become phone notifications."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from typing import Any
from unittest.mock import patch

import pytest
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.home_security.const import CONF_PHONES, CONF_SCRIPT, CONF_SCRIPT_SOURCE

from .conftest import STORY, WEBHOOK_ID, WEBHOOK_SECRET, FakeEngine, setup_integration, wait_for

IPHONE = "mobile_app_alex_phone"
ANDROID = "mobile_app_sam_pixel"
STORY_ID = STORY["id"]


def card(**changes: Any) -> dict[str, Any]:
    base = {
        "version": 1,
        "type": "card",
        "story": STORY_ID,
        "event": "opened",
        "alert": True,
        "level": "high",
        "kind": "person",
        "title": "Person at the front door",
        "message": "A stranger waited at the door at 2 AM.",
        "time": "2026-10-27T09:14:05Z",
        "cameras": ["Front Door"],
        "snapshot": "http://192.0.2.10:8780/ignored",
        "joined": [],
        "buttons": [],
        "reply": "http://192.0.2.10:8780/ignored",
        "shadow": False,
    }
    base.update(changes)
    return base


def signed_headers(body: bytes, ts: int | None = None, secret: str = WEBHOOK_SECRET) -> dict:
    ts = int(time.time()) if ts is None else ts
    digest = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return {
        "X-HS-Timestamp": str(ts),
        "X-HS-Signature": f"sha256={digest}",
        "Content-Type": "application/json",
    }


class Phones:
    """Fake notify services for one iPhone and one Android phone."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.failing: set[str] = set()
        # Services whose alerts fail while taking an alert away (a clear) still works.
        self.failing_cards: set[str] = set()
        self.on_clear = None
        for service in (IPHONE, ANDROID):
            hass.services.async_register("notify", service, self._handler(service))

    def _handler(self, service: str):
        async def handle(call: ServiceCall) -> None:
            if service in self.failing:
                raise HomeAssistantError("phone unreachable")
            is_clear = call.data.get("message") == "clear_notification"
            if service in self.failing_cards and not is_clear:
                raise HomeAssistantError("phone unreachable")
            if is_clear and self.on_clear is not None:
                await self.on_clear()
            self.calls.append((service, dict(call.data)))

        return handle

    def to(self, service: str) -> list[dict[str, Any]]:
        return [data for name, data in self.calls if name == service]


@pytest.fixture
async def phones(hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry) -> Phones:
    MockConfigEntry(
        domain="mobile_app",
        title="Alex Phone",
        data={"device_name": "Alex Phone", "os_name": "iOS", "webhook_id": "m1"},
    ).add_to_hass(hass)
    MockConfigEntry(
        domain="mobile_app",
        title="Sam Pixel",
        data={"device_name": "Sam Pixel", "os_name": "Android", "webhook_id": "m2"},
    ).add_to_hass(hass)
    fake = Phones(hass)
    config_entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(
        config_entry, options={CONF_PHONES: [IPHONE, ANDROID], "dashboard": "/security"}
    )
    await setup_integration(hass, config_entry)
    return fake


@pytest.fixture
async def post(hass: HomeAssistant, hass_client_no_auth: ClientSessionGenerator):
    async def send(payload: dict[str, Any], headers: dict | None = None) -> int:
        # The client is made on first use: Home Assistant's HTTP app exists only after setup.
        client = await hass_client_no_auth()
        body = json.dumps(payload).encode()
        resp = await client.post(
            f"/api/webhook/{WEBHOOK_ID}", data=body, headers=headers or signed_headers(body)
        )
        await hass.async_block_till_done()
        return resp.status

    return send


async def test_bad_signature_refused(phones: Phones, post) -> None:
    body = json.dumps(card()).encode()
    headers = signed_headers(body, secret="not-the-secret")
    assert await post(card(), headers) == 401
    assert phones.calls == []


async def test_missing_signature_refused(phones: Phones, post) -> None:
    assert await post(card(), {"Content-Type": "application/json"}) == 401
    assert phones.calls == []


async def test_stale_timestamp_refused(phones: Phones, post) -> None:
    body = json.dumps(card()).encode()
    assert await post(card(), signed_headers(body, ts=int(time.time()) - 301)) == 401
    assert phones.calls == []


async def test_shadow_card_goes_to_logbook_only(hass: HomeAssistant, phones: Phones, post) -> None:
    events = async_capture_events(hass, "logbook_entry")
    assert await post(card(shadow=True)) == 200
    assert len(events) == 1
    assert events[0].data["name"] == "Home security (quiet)"
    assert "Person at the front door" in events[0].data["message"]
    # No alert; only the story's own earlier alert is taken off the phones.
    for phone in (IPHONE, ANDROID):
        assert phones.to(phone) == [
            {"message": "clear_notification", "data": {"tag": f"hs-{STORY_ID}"}}
        ]


async def test_shadow_card_clears_joined_stories(phones: Phones, post) -> None:
    assert await post(card(shadow=True, joined=["01JBOLDER"])) == 200
    for phone in (IPHONE, ANDROID):
        tags = [d["data"]["tag"] for d in phones.to(phone)]
        assert all(d["message"] == "clear_notification" for d in phones.to(phone))
        assert sorted(tags) == sorted([f"hs-{STORY_ID}", "hs-01JBOLDER"])


async def test_repeat_of_taken_card_is_a_no_op(phones: Phones, post) -> None:
    """The engine treats 401 as final, so a repeat answers 200 and does nothing."""
    body = json.dumps(card()).encode()
    headers = signed_headers(body)
    assert await post(card(), headers) == 200
    assert await post(card(), headers) == 200
    assert len(phones.to(IPHONE)) == 1


@pytest.mark.parametrize("variant", ["0{ts}", "+{ts}", "00{ts}", "{ts}.0", "-{ts}"])
async def test_timestamp_variants_refused(phones: Phones, post, variant: str) -> None:
    """Spellings of the same number would verify after int() and dodge the replay guard."""
    body = json.dumps(card()).encode()
    headers = signed_headers(body)
    assert await post(card(), headers) == 200
    headers["X-HS-Timestamp"] = variant.format(ts=headers["X-HS-Timestamp"])
    assert await post(card(), headers) == 401
    assert len(phones.to(IPHONE)) == 1


async def test_padded_timestamp_refused_on_first_sight(phones: Phones, post) -> None:
    body = json.dumps(card()).encode()
    ts = int(time.time())
    digest = hmac.new(WEBHOOK_SECRET.encode(), f"{ts}.".encode() + body, hashlib.sha256)
    headers = {
        "X-HS-Timestamp": f"0{ts}",
        "X-HS-Signature": f"sha256={digest.hexdigest()}",
        "Content-Type": "application/json",
    }
    assert await post(card(), headers) == 401
    assert phones.calls == []


@pytest.mark.parametrize(
    "signature",
    [
        "sha256=" + "A" * 64,  # uppercase hex
        "sha256=" + "a" * 63,  # short
        "sha256=" + "a" * 65,  # long
        "sha256=" + "g" * 64,  # not hex
        "a" * 64,  # no prefix
    ],
)
async def test_malformed_signature_refused(phones: Phones, post, signature: str) -> None:
    body = json.dumps(card()).encode()
    headers = signed_headers(body)
    headers["X-HS-Signature"] = signature
    assert await post(card(), headers) == 401


async def test_uppercase_copy_of_valid_signature_refused(phones: Phones, post) -> None:
    body = json.dumps(card()).encode()
    headers = signed_headers(body)
    headers["X-HS-Signature"] = "sha256=" + headers["X-HS-Signature"][7:].upper()
    assert await post(card(), headers) == 401
    assert phones.calls == []


async def test_oversized_body_refused(
    hass: HomeAssistant, phones: Phones, hass_client_no_auth: ClientSessionGenerator
) -> None:
    client = await hass_client_no_auth()
    body = json.dumps(card(message="x" * 70_000)).encode()
    resp = await client.post(f"/api/webhook/{WEBHOOK_ID}", data=body, headers=signed_headers(body))
    assert resp.status == 413
    assert phones.calls == []


async def test_oversized_chunked_body_refused(
    hass: HomeAssistant, phones: Phones, hass_client_no_auth: ClientSessionGenerator
) -> None:
    """Without a Content-Length the read itself is capped."""
    client = await hass_client_no_auth()
    body = json.dumps(card(message="x" * 70_000)).encode()

    async def chunks():
        for start in range(0, len(body), 8192):
            yield body[start : start + 8192]

    resp = await client.post(
        f"/api/webhook/{WEBHOOK_ID}", data=chunks(), headers=signed_headers(body)
    )
    assert resp.status == 413
    assert phones.calls == []


async def test_unexpected_error_answers_500(
    phones: Phones, post, caplog: pytest.LogCaptureFixture
) -> None:
    with patch(
        "custom_components.home_security.alerts.build_notification",
        side_effect=RuntimeError("boom"),
    ):
        assert await post(card()) == 500
    assert caplog.text.count("boom") == 1


async def test_urgent_card_ios(phones: Phones, post) -> None:
    assert await post(card(level="high", alert=True)) == 200
    [sent] = phones.to(IPHONE)
    assert sent["title"] == "Person at the front door"
    assert sent["message"] == "A stranger waited at the door at 2 AM."
    data = sent["data"]
    assert data["tag"] == f"hs-{STORY_ID}"
    assert data["group"] == "home-security"
    assert data["url"] == f"/home-security?story={STORY_ID}"
    assert data["image"].startswith(f"/api/home_security/picture/{STORY_ID}?authSig=")
    assert data["actions"] == [{"action": f"HS_FINE::{STORY_ID}", "title": "That's fine"}]
    assert data["push"] == {
        "interruption-level": "critical",
        "sound": {"name": "default", "critical": 1, "volume": 1.0},
    }
    assert "channel" not in data


async def test_urgent_card_android(phones: Phones, post) -> None:
    assert await post(card(level="high", alert=True)) == 200
    [sent] = phones.to(ANDROID)
    data = sent["data"]
    assert data["tag"] == f"hs-{STORY_ID}"
    assert data["group"] == "home-security"
    assert data["clickAction"] == f"/home-security?story={STORY_ID}"
    assert data["channel"] == "alarm_stream"
    assert data["importance"] == "high"
    assert data["priority"] == "high"
    assert data["ttl"] == 0
    assert data["actions"] == [{"action": f"HS_FINE::{STORY_ID}", "title": "That's fine"}]
    assert "push" not in data
    assert "url" not in data


async def test_signed_image_loads(
    phones: Phones, post, hass_client_no_auth: ClientSessionGenerator
) -> None:
    await post(card())
    image = phones.to(IPHONE)[0]["data"]["image"]
    client = await hass_client_no_auth()
    assert (await client.get(image)).status == 200


async def test_safety_card(phones: Phones, post) -> None:
    # Safety rings even when the engine says not to alert, and has nothing to dismiss.
    assert await post(card(level="safety", kind="smoke", alert=False)) == 200
    ios = phones.to(IPHONE)[0]["data"]
    android = phones.to(ANDROID)[0]["data"]
    assert ios["push"]["interruption-level"] == "critical"
    assert android["channel"] == "alarm_stream"
    for data in (ios, android):
        assert "image" not in data
        assert "actions" not in data


async def test_watch_card_is_active(phones: Phones, post) -> None:
    assert await post(card(level="watch", alert=True)) == 200
    ios = phones.to(IPHONE)[0]["data"]
    android = phones.to(ANDROID)[0]["data"]
    assert ios["push"] == {"interruption-level": "active"}
    assert android["channel"] == "Home security"
    assert android["importance"] == "default"
    assert "ttl" not in android


async def test_quiet_card_is_passive(phones: Phones, post) -> None:
    assert await post(card(level="high", alert=False)) == 200
    ios = phones.to(IPHONE)[0]["data"]
    android = phones.to(ANDROID)[0]["data"]
    assert ios["push"] == {"interruption-level": "passive"}
    assert android["channel"] == "Home security updates"
    assert android["importance"] == "low"


async def test_joined_stories_are_cleared(phones: Phones, post) -> None:
    assert await post(card(joined=["01JBOLDER"])) == 200
    for phone in (IPHONE, ANDROID):
        clears = [d for d in phones.to(phone) if d["message"] == "clear_notification"]
        assert clears == [{"message": "clear_notification", "data": {"tag": "hs-01JBOLDER"}}]


async def test_sound_and_unknown_types_ignored(phones: Phones, post) -> None:
    assert await post({"version": 1, "type": "sound", "sound": "chime"}) == 200
    assert await post({"version": 1, "type": "whatever"}) == 200
    assert phones.calls == []


async def test_one_phone_failing_still_answers_200(phones: Phones, post) -> None:
    phones.failing.add(ANDROID)
    assert await post(card()) == 200
    assert len(phones.to(IPHONE)) == 1


async def test_every_phone_failing_answers_500(phones: Phones, post) -> None:
    phones.failing.update({IPHONE, ANDROID})
    assert await post(card()) == 500


async def test_no_phones_chosen(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry, post
) -> None:
    await setup_integration(hass, config_entry)
    assert await post(card()) == 200


async def test_thats_fine_action(hass: HomeAssistant, engine: FakeEngine, phones: Phones) -> None:
    hass.bus.async_fire("mobile_app_notification_action", {"action": f"HS_FINE::{STORY_ID}"})
    await wait_for(lambda: ("POST", "fine", STORY_ID) in engine.calls)

    hass.bus.async_fire("mobile_app_notification_action", {"action": "HS_FINE::../x"})
    hass.bus.async_fire("mobile_app_notification_action", {"action": f"HS_FINE::{STORY_ID}\n"})
    hass.bus.async_fire("mobile_app_notification_action", {"action": "SOMETHING_ELSE"})
    await hass.async_block_till_done()
    assert [c for c in engine.calls if c[1] == "fine"] == [("POST", "fine", STORY_ID)]


async def test_tap_opens_the_sidebar_panel(
    hass: HomeAssistant, phones: Phones, config_entry: MockConfigEntry, post
) -> None:
    """An entry saved with the old dashboard option still opens the panel, not that page."""
    hass.config_entries.async_update_entry(
        config_entry, options={CONF_PHONES: [IPHONE], "dashboard": "/my-dashboard/security"}
    )
    assert await post(card()) == 200
    assert phones.to(IPHONE)[0]["data"]["url"] == f"/home-security?story={STORY_ID}"


async def test_resend_after_500_is_taken(phones: Phones, post) -> None:
    """A card answered 500 isn't remembered, so the engine's identical resend gets through."""
    body = json.dumps(card()).encode()
    headers = signed_headers(body)
    with patch(
        "custom_components.home_security.alerts.build_notification",
        side_effect=RuntimeError("boom"),
    ):
        assert await post(card(), headers) == 500
    assert await post(card(), headers) == 200
    assert len(phones.to(IPHONE)) == 1


async def test_concurrent_copies_handled_once(
    hass: HomeAssistant, phones: Phones, hass_client_no_auth: ClientSessionGenerator
) -> None:
    client = await hass_client_no_auth()
    body = json.dumps(card()).encode()
    headers = signed_headers(body)
    url = f"/api/webhook/{WEBHOOK_ID}"
    first, second = await asyncio.gather(
        client.post(url, data=body, headers=headers), client.post(url, data=body, headers=headers)
    )
    assert sorted([first.status, second.status]) == [200, 409]
    assert len(phones.to(IPHONE)) == 1


# --- guard cards: through a script, live camera, time-sensitive -------------------------

SCRIPT = "script.send_notification"
CAMERA_ID = "663a1c2d00e1f2a3b4c5d6e7"
NVR_URL = "https://nvr.example.test"


class Script:
    """A fake `script.turn_on` that records what it was asked to run."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.calls: list[dict[str, Any]] = []
        self.failing = False
        self.before = None
        hass.services.async_register("script", "turn_on", self._handle)

    async def _handle(self, call: ServiceCall) -> None:
        if self.before is not None:
            await self.before()
        if self.failing:
            raise HomeAssistantError("script is gone")
        self.calls.append(dict(call.data))


def guard(**changes: Any) -> dict[str, Any]:
    base = {"kind": "guard", "level": "watch", "alert": True, "camera_id": CAMERA_ID}
    return card(**{**base, **changes})


def use_script(hass: HomeAssistant, entry: MockConfigEntry, source: str | None = None) -> Script:
    options = {**entry.options, CONF_SCRIPT: SCRIPT}
    if source is not None:
        options[CONF_SCRIPT_SOURCE] = source
    hass.config_entries.async_update_entry(entry, options=options)
    # The script exists and is ready (a missing or unavailable one is a separate case).
    hass.states.async_set(SCRIPT, "off")
    return Script(hass)


def add_protect_camera(
    hass: HomeAssistant,
    camera_id: str = CAMERA_ID,
    mac: str = "AA:BB:CC:00:00:01",
    base_url: str = NVR_URL,
    channels: tuple[tuple[int, str | None], ...] = ((0, None),),
    config_url: str | None = None,
    others: tuple[tuple[str, str], ...] = (),
) -> dict[int, str]:
    """A Protect camera device (as the unifiprotect integration registers it) and its entities.

    channels is (channel id, disabled_by) pairs; channel 3 is the package camera. config_url
    replaces the device's link. Returns the entity id of each channel.
    """
    protect = MockConfigEntry(domain="unifiprotect", title="Protect", data={})
    protect.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=protect.entry_id,
        connections={(dr.CONNECTION_NETWORK_MAC, mac)},
        name=f"Cam {camera_id[-4:]}",
        configuration_url=config_url or f"{base_url}/protect/devices/{camera_id}",
    )
    registry = er.async_get(hass)
    out = {}
    # Other unifiprotect entities on the same device: (domain, unique id suffix).
    for domain, suffix in others:
        registry.async_get_or_create(
            domain,
            "unifiprotect",
            f"{mac}_{suffix}",
            config_entry=protect,
            device_id=device.id,
            suggested_object_id=f"cam_{camera_id[-4:]}_other",
        )
    for channel, disabled_by in channels:
        entry = registry.async_get_or_create(
            "camera",
            "unifiprotect",
            f"{mac}_{channel}",
            config_entry=protect,
            device_id=device.id,
            suggested_object_id=f"cam_{camera_id[-4:]}_{channel}",
            disabled_by=disabled_by,
        )
        out[channel] = entry.entity_id
    return out


async def test_guard_card_goes_through_the_script(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    cams = add_protect_camera(hass)
    assert await post(guard()) == 200
    [call] = script.calls
    assert call["entity_id"] == SCRIPT
    variables = call["variables"]
    assert variables["source"] == "security.guard.alert"
    assert variables["title"] == "Person at the front door"
    assert variables["message"] == "A stranger waited at the door at 2 AM."
    assert variables["tag"] == f"hs-{STORY_ID}"
    assert variables["click_action"] == f"/home-security?story={STORY_ID}"
    assert variables["image"].startswith(f"/api/home_security/picture/{STORY_ID}?authSig=")
    assert variables["actions"] == [{"action": f"HS_FINE::{STORY_ID}", "title": "That's fine"}]
    assert variables["camera"] == cams[0]
    # The script is the one route: no phone is notified directly.
    assert phones.calls == []


async def test_script_source_is_the_one_set(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry, source="front.guard")
    assert await post(guard()) == 200
    assert script.calls[0]["variables"]["source"] == "front.guard"


async def test_other_kinds_skip_the_script(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    assert await post(card(kind="person")) == 200
    assert await post(card(kind="smoke", level="safety", story="01JBSAFETY")) == 200
    assert script.calls == []
    assert len(phones.to(IPHONE)) == 2


async def test_guard_card_without_a_script_goes_to_phones(phones: Phones, post) -> None:
    assert await post(guard()) == 200
    assert len(phones.to(IPHONE)) == 1
    assert len(phones.to(ANDROID)) == 1


async def test_guard_card_with_script_ignores_the_phone_list(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    hass.config_entries.async_update_entry(
        config_entry, options={**config_entry.options, CONF_PHONES: []}
    )
    assert await post(guard()) == 200
    assert len(script.calls) == 1


async def test_script_raising_falls_back_to_the_phones(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    script.failing = True
    cams = add_protect_camera(hass)
    assert await post(guard()) == 200
    assert script.calls == []
    data = phones.to(IPHONE)[0]["data"]
    assert data["push"] == {"interruption-level": "time-sensitive"}
    assert data["entity_id"] == cams[0]
    assert len(phones.to(ANDROID)) == 1


async def test_script_raising_and_phones_failing_answers_500(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    script.failing = True
    phones.failing.update({IPHONE, ANDROID})
    assert await post(guard()) == 500


async def test_script_raising_with_one_phone_getting_it_answers_200(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    script.failing = True
    phones.failing.add(ANDROID)
    assert await post(guard()) == 200
    assert len(phones.to(IPHONE)) == 1


async def test_script_raising_with_no_phones_chosen_answers_500(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    script.failing = True
    hass.config_entries.async_update_entry(
        config_entry, options={**config_entry.options, CONF_PHONES: []}
    )
    assert await post(guard()) == 500


async def test_guard_card_replaces_by_tag_and_clears_joined(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    assert await post(guard(joined=["01JBOLDER"])) == 200
    assert script.calls[0]["variables"]["tag"] == f"hs-{STORY_ID}"
    # A joined story's earlier alert still comes off the phones directly.
    for phone in (IPHONE, ANDROID):
        assert phones.to(phone) == [
            {"message": "clear_notification", "data": {"tag": "hs-01JBOLDER"}}
        ]


async def test_shadow_guard_card_skips_the_script(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    assert await post(guard(shadow=True)) == 200
    assert script.calls == []


async def test_guard_card_without_camera_id_has_no_camera(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    add_protect_camera(hass)
    payload = guard()
    del payload["camera_id"]
    assert await post(payload) == 200
    assert "camera" not in script.calls[0]["variables"]


async def test_unresolvable_camera_id_is_left_out(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    add_protect_camera(hass, camera_id="ffffffffffffffffffffffff", mac="AA:BB:CC:00:00:09")
    assert await post(guard()) == 200
    assert "camera" not in script.calls[0]["variables"]


@pytest.mark.parametrize("bad", [None, 7, "", "../../x", "a b", "x" * 200, ["a"]])
async def test_odd_camera_ids_never_fail_the_card(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post, bad: Any
) -> None:
    script = use_script(hass, config_entry)
    assert await post(guard(camera_id=bad)) == 200
    assert "camera" not in script.calls[0]["variables"]


async def test_camera_is_the_main_one_not_the_package_camera(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    # The package camera is registered first, so order alone cannot pick the right one.
    cams = add_protect_camera(hass, channels=((3, None), (0, None)))
    assert await post(guard()) == 200
    assert script.calls[0]["variables"]["camera"] == cams[0]


async def test_camera_prefers_an_enabled_entity(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    cams = add_protect_camera(
        hass, channels=((0, er.RegistryEntryDisabler.INTEGRATION), (1, None), (3, None))
    )
    assert await post(guard()) == 200
    assert script.calls[0]["variables"]["camera"] == cams[1]


async def test_camera_that_is_only_disabled_is_left_out(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    """A disabled entity has no state, so a live view of it would fail."""
    script = use_script(hass, config_entry)
    add_protect_camera(hass, channels=((0, er.RegistryEntryDisabler.INTEGRATION), (3, None)))
    assert await post(guard()) == 200
    assert "camera" not in script.calls[0]["variables"]


async def test_disabled_camera_is_not_in_the_phone_live_view(
    hass: HomeAssistant, phones: Phones, post
) -> None:
    add_protect_camera(hass, channels=((0, er.RegistryEntryDisabler.USER),))
    assert await post(guard()) == 200
    assert "entity_id" not in phones.to(IPHONE)[0]["data"]


async def test_package_camera_alone_is_not_used(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    add_protect_camera(hass, channels=((3, None),))
    assert await post(guard()) == 200
    assert "camera" not in script.calls[0]["variables"]


async def test_camera_picks_the_device_with_that_id(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    add_protect_camera(hass, camera_id="aaaaaaaaaaaaaaaaaaaaaaaa", mac="AA:BB:CC:00:00:02")
    cams = add_protect_camera(hass)
    assert await post(guard()) == 200
    assert script.calls[0]["variables"]["camera"] == cams[0]


async def test_camera_must_belong_to_unifiprotect(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    """Another integration's device with a look-alike link is not a Protect camera."""
    script = use_script(hass, config_entry)
    other = MockConfigEntry(domain="other", title="Other", data={})
    other.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=other.entry_id,
        connections={(dr.CONNECTION_NETWORK_MAC, "AA:BB:CC:00:00:77")},
        configuration_url=f"{NVR_URL}/protect/devices/{CAMERA_ID}",
    )
    er.async_get(hass).async_get_or_create(
        "camera", "other", "x", config_entry=other, device_id=device.id
    )
    assert await post(guard()) == 200
    assert "camera" not in script.calls[0]["variables"]


async def test_guard_card_ios_alert_is_time_sensitive_with_live_view(
    phones: Phones, post, hass: HomeAssistant
) -> None:
    cams = add_protect_camera(hass)
    assert await post(guard()) == 200
    data = phones.to(IPHONE)[0]["data"]
    assert data["push"] == {"interruption-level": "time-sensitive"}
    assert data["entity_id"] == cams[0]
    assert data["tag"] == f"hs-{STORY_ID}"
    assert data["actions"] == [{"action": f"HS_FINE::{STORY_ID}", "title": "That's fine"}]
    assert data["image"].startswith(f"/api/home_security/picture/{STORY_ID}?authSig=")


async def test_guard_card_android_alert_is_urgent_not_alarm(
    phones: Phones, post, hass: HomeAssistant
) -> None:
    add_protect_camera(hass)
    assert await post(guard()) == 200
    data = phones.to(ANDROID)[0]["data"]
    assert data["channel"] == "Home security urgent"
    assert data["importance"] == "high"
    assert data["priority"] == "high"
    assert "ttl" not in data
    assert "entity_id" not in data
    assert "push" not in data


async def test_guard_card_without_alert_is_passive(
    phones: Phones, post, hass: HomeAssistant
) -> None:
    add_protect_camera(hass)
    assert await post(guard(alert=False)) == 200
    ios = phones.to(IPHONE)[0]["data"]
    android = phones.to(ANDROID)[0]["data"]
    assert ios["push"] == {"interruption-level": "passive"}
    assert android["channel"] == "Home security updates"


@pytest.mark.parametrize("level", ["high", "safety", None])
async def test_guard_card_is_never_critical(phones: Phones, post, level: str | None) -> None:
    """iOS can't replace a critical notification, and the guard replaces its card."""
    assert await post(guard(level=level)) == 200
    ios = phones.to(IPHONE)[0]["data"]
    android = phones.to(ANDROID)[0]["data"]
    assert ios["push"]["interruption-level"] == "time-sensitive"
    assert "sound" not in ios["push"]
    assert android["channel"] != "alarm_stream"


async def test_guard_card_unresolvable_camera_still_notifies(phones: Phones, post) -> None:
    assert await post(guard()) == 200
    assert "entity_id" not in phones.to(IPHONE)[0]["data"]


async def test_non_guard_cards_never_get_a_live_view(
    phones: Phones, post, hass: HomeAssistant
) -> None:
    add_protect_camera(hass)
    assert await post(card(camera_id=CAMERA_ID)) == 200
    assert "entity_id" not in phones.to(IPHONE)[0]["data"]


# --- a script that is gone must not lose the alert ----------------------------------------


def set_script_option(hass: HomeAssistant, entry: MockConfigEntry, script: str = SCRIPT) -> None:
    hass.config_entries.async_update_entry(entry, options={**entry.options, CONF_SCRIPT: script})


async def test_missing_script_falls_back_to_the_phones(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    phones: Phones,
    post,
    caplog: pytest.LogCaptureFixture,
) -> None:
    script = Script(hass)
    set_script_option(hass, config_entry)  # no such entity in the state machine
    assert await post(guard()) == 200
    assert script.calls == []
    assert len(phones.to(IPHONE)) == 1
    assert len(phones.to(ANDROID)) == 1
    assert SCRIPT in caplog.text


async def test_unavailable_script_falls_back_to_the_phones(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = Script(hass)
    set_script_option(hass, config_entry)
    hass.states.async_set(SCRIPT, "unavailable")
    assert await post(guard()) == 200
    assert script.calls == []
    assert len(phones.to(IPHONE)) == 1


async def test_fallback_card_is_a_normal_phone_guard_card(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    set_script_option(hass, config_entry)
    cams = add_protect_camera(hass)
    assert await post(guard()) == 200
    data = phones.to(IPHONE)[0]["data"]
    assert data["push"] == {"interruption-level": "time-sensitive"}
    assert data["entity_id"] == cams[0]


async def test_real_script_integration_runs_the_script(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    ran = async_capture_events(hass, "hs_test_ran")
    assert await async_setup_component(
        hass,
        "script",
        {
            "script": {
                "send_notification": {
                    "sequence": [
                        {
                            "event": "hs_test_ran",
                            "event_data_template": {
                                "source": "{{ source }}",
                                "tag": "{{ tag }}",
                                "has_camera": "{{ camera is defined }}",
                            },
                        }
                    ]
                }
            }
        },
    )
    set_script_option(hass, config_entry)
    assert await post(guard()) == 200
    await hass.async_block_till_done()
    assert [e.data for e in ran] == [
        {"source": "security.guard.alert", "tag": f"hs-{STORY_ID}", "has_camera": False}
    ]
    assert phones.calls == []


async def test_real_script_integration_missing_script_falls_back(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    """The real script.turn_on only logs for an unknown entity and returns, so the alert
    would be lost; the integration must notice and use the phones."""
    assert await async_setup_component(hass, "script", {"script": {}})
    set_script_option(hass, config_entry, "script.renamed_away")
    assert await post(guard()) == 200
    assert len(phones.to(IPHONE)) == 1
    assert len(phones.to(ANDROID)) == 1


async def test_failed_delivery_with_a_successful_clear_still_answers_500(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    script.failing = True
    phones.failing_cards.update({IPHONE, ANDROID})
    assert await post(guard(joined=["01JBOLDER"])) == 500
    # The clear still went out.
    assert phones.to(IPHONE) == [{"message": "clear_notification", "data": {"tag": "hs-01JBOLDER"}}]


async def test_delivered_card_with_failing_clears_answers_200(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    use_script(hass, config_entry)
    phones.failing.update({IPHONE, ANDROID})
    assert await post(guard(joined=["01JBOLDER"])) == 200


async def test_shadow_card_whose_clears_all_fail_answers_500(phones: Phones, post) -> None:
    phones.failing.update({IPHONE, ANDROID})
    assert await post(card(shadow=True)) == 500


# --- a quiet re-send is not a new alert -----------------------------------------------------


async def test_quiet_guard_card_skips_the_script_and_goes_to_phones_passive(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    """The hub applies its source's level, so a re-send marked quiet would buzz as new."""
    script = use_script(hass, config_entry)
    assert await post(guard(alert=False)) == 200
    assert script.calls == []
    assert phones.to(IPHONE)[0]["data"]["push"] == {"interruption-level": "passive"}
    assert phones.to(ANDROID)[0]["data"]["channel"] == "Home security updates"


async def test_alerting_guard_card_still_uses_the_script(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    assert await post(guard(alert=True)) == 200
    assert len(script.calls) == 1
    assert phones.calls == []


# --- the live view is decoration -----------------------------------------------------------


async def test_a_failing_camera_lookup_does_not_lose_the_card(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    phones: Phones,
    post,
    caplog: pytest.LogCaptureFixture,
) -> None:
    script = use_script(hass, config_entry)
    add_protect_camera(hass)
    with patch(
        "custom_components.home_security.alerts.er.async_entries_for_device",
        side_effect=RuntimeError("registry broke"),
    ):
        assert await post(guard()) == 200
        # Through the phones as well.
        hass.config_entries.async_update_entry(config_entry, options={CONF_PHONES: [IPHONE]})
        hass.states.async_set(SCRIPT, "unavailable")
        assert await post(guard(story="01JBSTORY2")) == 200
    assert "camera" not in script.calls[0]["variables"]
    assert "entity_id" not in phones.to(IPHONE)[0]["data"]
    assert "registry broke" in caplog.text


# --- pins for the camera lookup's guards ----------------------------------------------------


async def test_a_non_camera_entity_on_the_camera_device_is_not_the_live_view(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    """Same channel number and sorts first by name, yet it is a sensor, not a camera."""
    script = use_script(hass, config_entry)
    cams = add_protect_camera(hass, others=(("binary_sensor", "0"),))
    assert await post(guard()) == 200
    assert script.calls[0]["variables"]["camera"] == cams[0]
    assert cams[0].startswith("camera.")


async def test_a_camera_id_with_a_slash_is_never_looked_up(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    """Even a device whose link ends the same odd way is not matched."""
    script = use_script(hass, config_entry)
    add_protect_camera(
        hass, camera_id="aaaa", config_url=f"{NVR_URL}/protect/devices/x/y", mac="AA:BB:CC:00:00:05"
    )
    assert await post(guard(camera_id="x/y")) == 200
    assert "camera" not in script.calls[0]["variables"]


async def test_an_empty_camera_id_never_matches_a_bare_devices_link(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    add_protect_camera(hass, config_url=f"{NVR_URL}/protect/devices/", mac="AA:BB:CC:00:00:06")
    assert await post(guard(camera_id="")) == 200
    assert "camera" not in script.calls[0]["variables"]


async def test_a_link_with_a_trailing_slash_still_matches(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    cams = add_protect_camera(hass, config_url=f"{NVR_URL}/protect/devices/{CAMERA_ID}/")
    assert await post(guard()) == 200
    assert script.calls[0]["variables"]["camera"] == cams[0]


@pytest.mark.parametrize(
    "path",
    [f"/protect/liveview/{CAMERA_ID}", f"/other/protect/devices/{CAMERA_ID}", f"/x/{CAMERA_ID}"],
)
async def test_a_link_that_only_ends_in_the_id_does_not_match(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post, path: str
) -> None:
    script = use_script(hass, config_entry)
    add_protect_camera(hass, config_url=f"{NVR_URL}{path}")
    assert await post(guard()) == 200
    assert "camera" not in script.calls[0]["variables"]


async def test_a_guard_card_without_title_or_message_still_goes_out(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)
    assert await post(guard(title=None, message=None)) == 200
    variables = script.calls[0]["variables"]
    assert variables["title"] == "Home Security"
    assert variables["message"] == ""
    payload = guard()
    del payload["title"]
    del payload["message"]
    assert await post(payload) == 200
    assert script.calls[1]["variables"]["title"] == "Home Security"
    assert script.calls[1]["variables"]["message"] == ""


# --- the card and the clears go out together -------------------------------------------------


async def test_the_card_and_the_clears_are_sent_concurrently(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    """The script waits to see a clear start: sent one after the other, it never would."""
    script = use_script(hass, config_entry)
    clear_started = asyncio.Event()
    seen: list[bool] = []

    async def clear_hook() -> None:
        clear_started.set()

    async def wait_for_clear() -> None:
        try:
            async with asyncio.timeout(1):
                await clear_started.wait()
            seen.append(True)
        except TimeoutError:
            seen.append(False)

    phones.on_clear = clear_hook
    script.before = wait_for_clear
    assert await post(guard(joined=["01JBOLDER"])) == 200
    assert seen == [True]


async def test_a_slow_clear_does_not_hold_the_answer_beyond_the_slower_send(
    hass: HomeAssistant, config_entry: MockConfigEntry, phones: Phones, post
) -> None:
    script = use_script(hass, config_entry)

    async def slow() -> None:
        await asyncio.sleep(0.4)

    phones.on_clear = slow
    script.before = slow
    started = time.monotonic()
    assert await post(guard(joined=["01JBOLDER"])) == 200
    assert time.monotonic() - started < 0.7  # one wait of 0.4 s, not two

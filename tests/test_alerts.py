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
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.home_security.const import CONF_DASHBOARD, CONF_PHONES

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
        for service in (IPHONE, ANDROID):
            hass.services.async_register("notify", service, self._handler(service))

    def _handler(self, service: str):
        async def handle(call: ServiceCall) -> None:
            if service in self.failing:
                raise HomeAssistantError("phone unreachable")
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
        config_entry, options={CONF_PHONES: [IPHONE, ANDROID], CONF_DASHBOARD: "/security"}
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


async def test_replayed_card_refused(phones: Phones, post) -> None:
    body = json.dumps(card()).encode()
    headers = signed_headers(body)
    assert await post(card(), headers) == 200
    assert await post(card(), headers) == 401
    assert len(phones.to(IPHONE)) == 1


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
    assert data["url"] == f"/security?story={STORY_ID}"
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
    assert data["clickAction"] == f"/security?story={STORY_ID}"
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


async def test_default_dashboard_link(
    hass: HomeAssistant, phones: Phones, config_entry: MockConfigEntry, post
) -> None:
    hass.config_entries.async_update_entry(config_entry, options={CONF_PHONES: [IPHONE]})
    assert await post(card()) == 200
    assert phones.to(IPHONE)[0]["data"]["url"] == f"/my-dashboard/security?story={STORY_ID}"


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
    assert sorted([first.status, second.status]) == [200, 401]
    assert len(phones.to(IPHONE)) == 1

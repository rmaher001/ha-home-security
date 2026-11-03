"""The mark_fine service and the websocket commands the cards use."""

from __future__ import annotations

import copy
import hashlib
from pathlib import Path
from unittest.mock import patch

import pytest
from aiohttp import ClientError
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import (
    ClientSessionGenerator,
    WebSocketGenerator,
)

from custom_components.home_security.api import CLIP_TIMEOUT
from custom_components.home_security.const import DOMAIN

from .conftest import CLIP, PICTURE, REFUSAL, STORY, FakeEngine, setup_integration, wait_for


async def test_mark_fine_service(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    await hass.services.async_call(DOMAIN, "mark_fine", {"story_id": STORY["id"]}, blocking=True)
    assert ("POST", "fine", STORY["id"]) in engine.calls


async def test_mark_fine_service_errors(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    for bad in ("../x", f"{STORY['id']}\n", ""):
        with pytest.raises(ServiceValidationError):
            await hass.services.async_call(DOMAIN, "mark_fine", {"story_id": bad}, blocking=True)
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            DOMAIN, "mark_fine", {"story_id": "01JBNOSUCH"}, blocking=True
        )
    assert ("POST", "fine", "../x") not in engine.calls


async def test_mark_fine_service_not_loaded(
    hass: HomeAssistant, engine: FakeEngine, config_entry: MockConfigEntry
) -> None:
    await setup_integration(hass, config_entry)
    await hass.config_entries.async_unload(config_entry.entry_id)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            DOMAIN, "mark_fine", {"story_id": STORY["id"]}, blocking=True
        )


async def test_ws_state_and_stories(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": "home_security/state"})
    msg = await client.receive_json()
    assert msg["success"]
    assert msg["result"] == engine.state

    await client.send_json_auto_id({"type": "home_security/stories"})
    msg = await client.receive_json()
    assert msg["success"]
    assert msg["result"] == engine.stories

    await client.send_json_auto_id({"type": "home_security/stories", "days": 30})
    msg = await client.receive_json()
    assert msg["success"]
    assert ("GET", "stories", "30") in engine.calls

    await client.send_json_auto_id({"type": "home_security/stories", "days": 99})
    msg = await client.receive_json()
    assert not msg["success"]


async def test_ws_actions(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": "home_security/mark_fine", "story_id": STORY["id"]})
    assert (await client.receive_json())["success"]
    assert ("POST", "fine", STORY["id"]) in engine.calls

    await client.send_json_auto_id({"type": "home_security/mark_fine", "story_id": "01JBNOSUCH"})
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"

    await client.send_json_auto_id({"type": "home_security/set_mode", "mode": "away"})
    assert (await client.receive_json())["success"]
    assert ("PUT", "mode", {"mode": "away"}) in engine.calls

    await client.send_json_auto_id({"type": "home_security/set_mode", "mode": "party"})
    assert not (await client.receive_json())["success"]


async def test_ws_not_loaded(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    await hass.config_entries.async_unload(config_entry.entry_id)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "home_security/state"})
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_loaded"


async def test_ws_subscribe(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": "home_security/subscribe"})
    msg = await client.receive_json()
    assert msg["success"]
    sub_id = msg["id"]
    msg = await client.receive_json()
    assert msg["type"] == "event"
    assert msg["id"] == sub_id
    assert msg["event"] == {"state": engine.state, "stories": engine.stories, "connected": True}

    state = copy.deepcopy(engine.state)
    state["mode"] = {"chosen": "home", "effective": "home"}
    await engine.push(state)
    msg = await client.receive_json()
    assert msg["id"] == sub_id
    assert msg["event"]["state"]["mode"]["chosen"] == "home"
    assert msg["event"]["stories"] == engine.stories

    # Unloading tells the cards the engine is gone, rather than leaving them stale.
    await hass.config_entries.async_unload(config_entry.entry_id)
    msg = await client.receive_json()
    assert msg["id"] == sub_id
    assert msg["event"]["connected"] is False

    await client.send_json_auto_id({"type": "unsubscribe_events", "subscription": sub_id})
    assert (await client.receive_json())["success"]

    # Nothing more arrives on the subscription once it is closed.
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await wait_for(lambda: config_entry.runtime_data.coordinator.connected)
    await hass.async_block_till_done()
    await client.send_json_auto_id({"type": "ping"})
    assert (await client.receive_json())["type"] == "pong"


async def test_ws_picture_url(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
    hass_client_no_auth: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "home_security/picture_url", "story_id": STORY["id"]})
    msg = await client.receive_json()
    assert msg["success"]
    url = msg["result"]["url"]
    assert url.startswith(f"/api/home_security/picture/{STORY['id']}?authSig=")

    # The signed path loads without a login, as an <img> tag needs.
    http = await hass_client_no_auth()
    resp = await http.get(url)
    assert resp.status == 200
    assert await resp.read() == PICTURE

    for bad in ("../x", f"{STORY['id']}\n"):
        await client.send_json_auto_id({"type": "home_security/picture_url", "story_id": bad})
        assert not (await client.receive_json())["success"]


async def test_picture_view(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
    hass_client_no_auth: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    path = f"/api/home_security/picture/{STORY['id']}"

    anonymous = await hass_client_no_auth()
    assert (await anonymous.get(path)).status == 401

    http = await hass_client()
    resp = await http.get(path)
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "image/jpeg"
    assert await resp.read() == PICTURE

    assert (await http.get("/api/home_security/picture/01JBNOSUCH")).status == 404
    assert (await http.get("/api/home_security/picture/bad.id")).status == 400


async def test_ws_clip_url(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
    hass_client_no_auth: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {"type": "home_security/clip_url", "story_id": STORY["id"], "stop": 1}
    )
    msg = await client.receive_json()
    assert msg["success"]
    url = msg["result"]["url"]
    assert url.startswith(f"/api/home_security/clip/{STORY['id']}/1?authSig=")

    # The signed path loads without a login, as a <video> tag needs.
    http = await hass_client_no_auth()
    resp = await http.get(url)
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "video/mp4"
    assert await resp.read() == CLIP

    for bad in (
        {"story_id": "../x", "stop": 1},
        {"story_id": f"{STORY['id']}\n", "stop": 1},
        {"story_id": STORY["id"], "stop": -1},
        {"story_id": STORY["id"], "stop": 1000},
        {"story_id": STORY["id"], "stop": "1"},
        {"story_id": STORY["id"], "stop": True},  # JSON true is not a stop number
    ):
        await client.send_json_auto_id({"type": "home_security/clip_url", **bad})
        assert not (await client.receive_json())["success"]


async def test_clip_view(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
    hass_client_no_auth: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    path = f"/api/home_security/clip/{STORY['id']}/1"

    anonymous = await hass_client_no_auth()
    assert (await anonymous.get(path)).status == 401

    http = await hass_client()
    resp = await http.get(path)
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "video/mp4"
    assert resp.headers["Accept-Ranges"] == "bytes"
    assert await resp.read() == CLIP

    # A player seeking asks for a range; the engine's partial answer goes through.
    part = await http.get(path, headers={"Range": "bytes=10-19"})
    assert part.status == 206
    assert part.headers["Content-Range"] == f"bytes 10-19/{len(CLIP)}"
    assert await part.read() == CLIP[10:20]

    assert (await http.get(f"/api/home_security/clip/{STORY['id']}/2")).status == 404
    assert (await http.get("/api/home_security/clip/01JBNOSUCH/1")).status == 404
    assert (await http.get("/api/home_security/clip/bad.id/1")).status == 400
    assert (await http.get(f"/api/home_security/clip/{STORY['id']}/x")).status == 400
    assert (await http.get(f"/api/home_security/clip/{STORY['id']}/1234")).status == 400


async def test_clip_view_passes_an_unsatisfiable_range_through_as_416(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    http = await hass_client()
    resp = await http.get(
        f"/api/home_security/clip/{STORY['id']}/1", headers={"Range": f"bytes={len(CLIP) + 5}-"}
    )
    assert resp.status == 416
    assert resp.headers["Content-Range"] == f"bytes */{len(CLIP)}"


async def test_clip_view_passes_if_range_on_and_never_asks_for_compression(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    http = await hass_client()
    resp = await http.get(
        f"/api/home_security/clip/{STORY['id']}/1",
        headers={"Range": "bytes=0-9", "If-Range": '"abc"'},
    )
    assert resp.status == 206
    seen = engine.echoes[-1]["headers"]
    assert seen["Range"] == "bytes=0-9"
    assert seen["If-Range"] == '"abc"'
    assert seen["Accept-Encoding"] == "identity"


def test_a_recording_gets_as_long_as_the_engine_needs_to_fetch_it() -> None:
    # The engine fetches the recording from Protect before it sends its headers.
    assert CLIP_TIMEOUT.total is None
    assert CLIP_TIMEOUT.sock_read == 120


async def test_clip_view_survives_an_engine_that_breaks_off_midway(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
    caplog: pytest.LogCaptureFixture,
) -> None:
    await setup_integration(hass, config_entry)
    http = await hass_client()
    engine.clip_mode = "broken"
    resp = await http.get(f"/api/home_security/clip/{STORY['id']}/1")
    with pytest.raises(ClientError):
        await resp.read()  # cut short: the browser sees a broken video, not a crash
    assert "Traceback" not in caplog.text
    engine.clip_mode = None
    assert await (await http.get(f"/api/home_security/clip/{STORY['id']}/1")).read() == CLIP


async def test_clip_view_lets_go_of_the_engine_when_the_browser_hangs_up(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
    caplog: pytest.LogCaptureFixture,
) -> None:
    await setup_integration(hass, config_entry)
    http = await hass_client()
    engine.clip_mode = "slow"
    resp = await http.get(f"/api/home_security/clip/{STORY['id']}/1")
    assert len(await resp.content.readexactly(2048)) == 2048
    resp.close()  # the browser gives up
    await wait_for(lambda: engine.clip_stopped)
    assert "Traceback" not in caplog.text


async def test_clip_view_refuses_a_recording_the_engine_compressed(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    http = await hass_client()
    engine.clip_mode = "gzip"
    # Passed on as it came, the body would not match the headers: a bad gateway, not bad video.
    assert (await http.get(f"/api/home_security/clip/{STORY['id']}/1")).status == 502


async def test_the_engine_is_asked_for_a_recording_with_the_recording_timeouts(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    session = config_entry.runtime_data.coordinator.client.session
    http = await hass_client()
    with patch.object(session, "get", wraps=session.get) as get:
        assert (await http.get(f"/api/home_security/clip/{STORY['id']}/1")).status == 200
    kwargs = get.call_args.kwargs
    assert kwargs["timeout"] is CLIP_TIMEOUT
    assert kwargs["auto_decompress"] is False
    assert kwargs["headers"]["Accept-Encoding"] == "identity"


async def test_cards_file_served_under_versioned_name(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_client: ClientSessionGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    # Any change to the file gives it a new name, version bump or not.
    cards = Path(__file__).parents[1] / "custom_components/home_security/frontend"
    digest = hashlib.sha256((cards / "home-security-cards.js").read_bytes()).hexdigest()[:12]
    url = f"/home_security_frontend/home-security-cards-0.1.0-{digest}.js"
    assert url in hass.data["frontend_extra_module_url"].urls

    http = await hass_client()
    resp = await http.get(url)
    assert resp.status == 200
    assert 'customElements.define("home-security-card"' in await resp.text()

    # A reload doesn't register the static path twice (that would raise).
    assert await hass.config_entries.async_reload(config_entry.entry_id)
    await hass.async_block_till_done()
    assert list(hass.data["frontend_extra_module_url"].urls).count(url) == 1


async def test_ws_learn(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id(
        {"type": "home_security/learn", "story_id": STORY["id"], "choice": "learn"}
    )
    assert (await client.receive_json())["success"]
    assert ("POST", "learn", (STORY["id"], {"choice": "learn", "text": None})) in engine.calls

    await client.send_json_auto_id(
        {
            "type": "home_security/learn",
            "story_id": STORY["id"],
            "choice": "keep",
            "text": "the courier comes at noon",
        }
    )
    assert (await client.receive_json())["success"]
    expected = (STORY["id"], {"choice": "keep", "text": "the courier comes at noon"})
    assert ("POST", "learn", expected) in engine.calls


async def test_ws_learn_errors(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id(
        {"type": "home_security/learn", "story_id": "01JBNOSUCH", "choice": "learn"}
    )
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"

    bad = [
        {"story_id": "bad.id", "choice": "learn"},
        {"story_id": STORY["id"], "choice": "Learn"},
        {"story_id": STORY["id"], "choice": "a" * 17},
        {"story_id": STORY["id"], "choice": ""},
        {"story_id": STORY["id"]},
        {"story_id": STORY["id"], "choice": "keep", "text": "x" * 501},
        {"story_id": STORY["id"], "choice": "keep", "text": 5},
    ]
    for fields in bad:
        await client.send_json_auto_id({"type": "home_security/learn", **fields})
        assert not (await client.receive_json())["success"], fields
    assert [c for c in engine.calls if c[1] == "learn" and c[2][0] != "01JBNOSUCH"] == []


async def test_ws_learn_accepts_the_longest_text(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {
            "type": "home_security/learn",
            "story_id": STORY["id"],
            "choice": "keep",
            "text": "x" * 500,
        }
    )
    assert (await client.receive_json())["success"]


async def test_ws_learn_is_for_administrators(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_access_token: str,
) -> None:
    """A kept note changes what the guard reads at every look, so not just anyone may keep one."""
    await setup_integration(hass, config_entry)
    member = await hass_ws_client(hass, hass_read_only_access_token)
    await member.send_json_auto_id(
        {"type": "home_security/learn", "story_id": STORY["id"], "choice": "learn"}
    )
    msg = await member.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "unauthorized"
    assert [c for c in engine.calls if c[1] == "learn"] == []


@pytest.mark.parametrize(
    ("story", "message"),
    [
        ("01JBREFUSED", REFUSAL),
        ("01JBCONFLICT", "not now"),
        # No reason (not JSON, or not text): the generic words.
        ("01JBPLAIN", "the engine answered 400"),
        ("01JBODD", "the engine isn't taking that now"),
    ],
)
async def test_ws_learn_carries_the_engines_reason(
    hass: HomeAssistant,
    engine: FakeEngine,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
    story: str,
    message: str,
) -> None:
    await setup_integration(hass, config_entry)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {"type": "home_security/learn", "story_id": story, "choice": "keep", "text": "a note"}
    )
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "engine_error"
    assert msg["error"]["message"] == message

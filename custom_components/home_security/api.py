"""Client for the Home Security engine's LAN API."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from typing import Any

import aiohttp

TIMEOUT = aiohttp.ClientTimeout(total=15)
# A recording is a long body: no overall limit, but the engine must keep sending. It fetches
# the recording from Protect before it sends its headers, which can take tens of seconds.
CLIP_TIMEOUT = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=120)


class EngineError(Exception):
    """The engine answered with an error, or could not be asked."""


class EngineConnectionError(EngineError):
    """The engine could not be reached."""


class EngineAuthError(EngineError):
    """The engine refused the token (401)."""


class EngineWantsSnapshot(EngineError):
    """The engine took no change (409): it wants the whole picture first."""


class EngineCodeRefused(EngineError):
    """The pairing code was wrong, spent or expired (403)."""


class EngineNotFound(EngineError):
    """The engine has no such story or picture (404)."""


class EngineConflict(EngineError):
    """The engine isn't taking that now, for example an answer already given (409)."""


REASON_MAX = 200


def _raise_for_status(status: int, reason: str | None = None) -> None:
    """Raise for an error status; `reason` is the engine's own words for a 400 or 409."""
    if status == 401:
        raise EngineAuthError("the engine refused the token")
    if status == 403:
        raise EngineCodeRefused("the pairing code was refused")
    if status == 404:
        raise EngineNotFound("not found")
    if status == 409:
        raise EngineConflict(reason or "the engine isn't taking that now")
    if status >= 400:
        raise EngineError(reason or f"the engine answered {status}")


async def _async_reason(resp: aiohttp.ClientResponse) -> str | None:
    """The engine's `error` text on a 400 or 409, when it gave one (for the person to read)."""
    if resp.status not in (400, 409):
        return None
    try:
        body = await resp.json(content_type=None)
    except aiohttp.ClientError, ValueError:
        return None
    reason = body.get("error") if isinstance(body, dict) else None
    return reason.strip()[:REASON_MAX] or None if isinstance(reason, str) else None


async def async_pair(
    session: aiohttp.ClientSession,
    url: str,
    *,
    code: str,
    name: str,
    webhook_url: str,
    webhook_secret: str,
) -> str:
    """Trade a pairing code for a token."""
    payload = {
        "code": code,
        "name": name,
        "webhook_url": webhook_url,
        "webhook_secret": webhook_secret,
    }
    try:
        async with session.post(f"{url}/api/v1/pair", json=payload, timeout=TIMEOUT) as resp:
            _raise_for_status(resp.status)
            data = await resp.json()
    except (aiohttp.ClientError, TimeoutError) as err:
        raise EngineConnectionError(str(err)) from err
    token = data.get("token") if isinstance(data, dict) else None
    if not isinstance(token, str) or not token:
        raise EngineError("the engine answered without a token")
    return token


class EngineClient:
    """Talks to one paired engine."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        self._session = session
        self.url = url.rstrip("/")
        self._token = token

    @property
    def session(self) -> aiohttp.ClientSession:
        return self._session

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            async with self._session.request(
                method, f"{self.url}{path}", headers=self.headers, timeout=TIMEOUT, **kwargs
            ) as resp:
                _raise_for_status(resp.status, await _async_reason(resp))
                return await resp.json()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise EngineConnectionError(str(err)) from err

    async def async_get_state(self) -> dict[str, Any]:
        return await self._request("GET", "/api/v1/state")

    async def async_get_stories(self, days: int = 7) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/v1/stories", params={"days": str(days)})

    async def async_set_mode(self, mode: str) -> None:
        await self._request("PUT", "/api/v1/mode", json={"mode": mode})

    async def async_set_alerts(self, on: bool) -> None:
        await self._request("PUT", "/api/v1/alerts", json={"on": on})

    async def async_mark_fine(self, story_id: str) -> None:
        await self._request("POST", f"/api/v1/stories/{story_id}/fine")

    async def async_learn(self, story_id: str, choice: str, text: str | None) -> None:
        """Answer the guard's offer to learn from a story: a choice, and maybe the owner's words."""
        await self._request(
            "POST", f"/api/v1/stories/{story_id}/learn", json={"choice": choice, "text": text}
        )

    async def async_post_sensors(self, *, snapshot: bool, states: list[dict[str, Any]]) -> None:
        """Tell the engine about the house's doors, locks and people (it answers 204)."""
        try:
            async with self._session.post(
                f"{self.url}/api/v1/sensors",
                json={"snapshot": snapshot, "states": states},
                headers=self.headers,
                timeout=TIMEOUT,
            ) as resp:
                if resp.status == 409:
                    raise EngineWantsSnapshot("the engine wants a full snapshot")
                _raise_for_status(resp.status)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise EngineConnectionError(str(err)) from err

    @asynccontextmanager
    async def async_picture(self, story_id: str) -> AsyncIterator[aiohttp.ClientResponse]:
        """Open the story's picture; the caller reads the body inside the block."""
        try:
            async with self._session.get(
                f"{self.url}/api/v1/stories/{story_id}/picture.jpg",
                headers=self.headers,
                timeout=TIMEOUT,
            ) as resp:
                _raise_for_status(resp.status)
                yield resp
        except (aiohttp.ClientError, TimeoutError) as err:
            raise EngineConnectionError(str(err)) from err

    @asynccontextmanager
    async def async_clip(
        self, story_id: str, stop: int, forward: Mapping[str, str] | None = None
    ) -> AsyncIterator[aiohttp.ClientResponse]:
        """Open the recording around one stop of a visit; the caller reads it inside the block.

        `forward` holds the browser's Range and If-Range headers, passed on so a player can
        seek. A 416 (a range the recording can't satisfy) is handed back for the caller to
        pass on; other errors raise.
        """
        headers = {**self.headers, "Accept-Encoding": "identity", **(forward or {})}
        try:
            async with self._session.get(
                f"{self.url}/api/v1/stories/{story_id}/clip/{stop}.mp4",
                headers=headers,
                timeout=CLIP_TIMEOUT,
                auto_decompress=False,  # the bytes are passed on as they come, with their length
            ) as resp:
                if resp.status != 416:
                    _raise_for_status(resp.status)
                if resp.headers.get("Content-Encoding", "identity").lower() != "identity":
                    # Passed on with its own length, the bytes would not play.
                    raise EngineError("the engine compressed the recording")
                yield resp
        except (aiohttp.ClientError, TimeoutError) as err:
            raise EngineConnectionError(str(err)) from err

    async def async_ws_connect(self) -> aiohttp.ClientWebSocketResponse:
        """Open the state websocket. A refused token raises EngineAuthError."""
        try:
            # A bounded connect, so an engine that never answers can't stall a retry.
            async with asyncio.timeout(15):
                return await self._session.ws_connect(
                    f"{self.url}/api/v1/ws", headers=self.headers, heartbeat=30
                )
        except aiohttp.WSServerHandshakeError as err:
            if err.status == 401:
                raise EngineAuthError("the engine refused the token") from err
            raise EngineConnectionError(str(err)) from err
        except (aiohttp.ClientError, TimeoutError) as err:
            raise EngineConnectionError(str(err)) from err

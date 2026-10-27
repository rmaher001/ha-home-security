"""Client for the Home Security engine's LAN API."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import aiohttp

TIMEOUT = aiohttp.ClientTimeout(total=15)


class EngineError(Exception):
    """The engine answered with an error, or could not be asked."""


class EngineConnectionError(EngineError):
    """The engine could not be reached."""


class EngineAuthError(EngineError):
    """The engine refused the token (401)."""


class EngineCodeRefused(EngineError):
    """The pairing code was wrong, spent or expired (403)."""


class EngineNotFound(EngineError):
    """The engine has no such story or picture (404)."""


def _raise_for_status(status: int) -> None:
    if status == 401:
        raise EngineAuthError("the engine refused the token")
    if status == 403:
        raise EngineCodeRefused("the pairing code was refused")
    if status == 404:
        raise EngineNotFound("not found")
    if status >= 400:
        raise EngineError(f"the engine answered {status}")


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
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            async with self._session.request(
                method, f"{self.url}{path}", headers=self.headers, timeout=TIMEOUT, **kwargs
            ) as resp:
                _raise_for_status(resp.status)
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

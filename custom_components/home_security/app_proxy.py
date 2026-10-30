"""The engine's app, passed through Home Assistant.

The sidebar panel asks Home Assistant (over its logged-in websocket) for a one-time ticket,
good for a minute. The panel's iframe trades the ticket for a session cookie scoped to this
path (like the add-on ingress session). From then on every request under /api/home_security/app/
is passed to the engine with the paired key added here, server-side. The key never reaches the
browser, and the browser's own cookies and Authorization header never reach the engine.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from collections.abc import Callable
from http import HTTPStatus
from typing import Any
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.core import HomeAssistant
from yarl import URL

from .const import (
    APP_BASE,
    APP_COOKIE,
    APP_SESSION_IDLE_SECONDS,
    APP_TICKET_SECONDS,
    DOMAIN,
)
from .coordinator import async_get_coordinator

_LOGGER = logging.getLogger(__name__)

CHUNK = 64 * 1024
MAX_OUTSTANDING = 200  # tickets or sessions held at once; the oldest go first
UPSTREAM_TIMEOUT = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=120)
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# What the browser may tell the engine. Everything else (cookies, the Home Assistant
# Authorization header, Host, hop-by-hop headers) stays here.
FORWARD_REQUEST_HEADERS = (
    "Accept",
    "Accept-Language",
    "Content-Type",
    "If-Modified-Since",
    "If-None-Match",
    "If-Range",
    "Range",
    "User-Agent",
)
# What never goes back to the browser: hop-by-hop headers and the engine's cookies.
DROP_RESPONSE_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "set-cookie",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)
APP_KEY = f"{DOMAIN}_app_access"


class AppAccess:
    """One-time tickets and path-scoped sessions, kept in memory only."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self._tickets: dict[str, float] = {}  # ticket -> expires
        self._sessions: dict[str, float] = {}  # session id -> last used

    def new_ticket(self) -> str:
        now = self.clock()
        self._prune(now)
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = now + APP_TICKET_SECONDS
        return ticket

    def redeem(self, ticket: str | None) -> str | None:
        """Burn the ticket; a live one gives a new session id."""
        now = self.clock()
        expires = self._tickets.pop(ticket, None) if ticket else None
        if expires is None or expires < now:
            return None
        self._prune(now)
        session = secrets.token_urlsafe(32)
        self._sessions[session] = now
        return session

    def valid(self, session: str | None) -> bool:
        """True while the session was used in the last twelve hours; using it renews it."""
        now = self.clock()
        last = self._sessions.get(session) if session else None
        if last is None:
            return False
        if now - last > APP_SESSION_IDLE_SECONDS:
            del self._sessions[session]
            return False
        self._sessions[session] = now
        return True

    def clear(self) -> None:
        self._tickets.clear()
        self._sessions.clear()

    def _prune(self, now: float) -> None:
        for ticket in [t for t, expires in self._tickets.items() if expires < now]:
            del self._tickets[ticket]
        for session in [
            s for s, last in self._sessions.items() if now - last > APP_SESSION_IDLE_SECONDS
        ]:
            del self._sessions[session]
        for held in (self._tickets, self._sessions):
            while len(held) >= MAX_OUTSTANDING:
                del held[next(iter(held))]


def async_get_app_access(hass: HomeAssistant) -> AppAccess:
    return hass.data.setdefault(APP_KEY, AppAccess())


def _safe_next(value: str) -> bool:
    """Only a path inside the app: no scheme, no host, no backslash, no climbing out."""
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        return False
    path = value.split("?", 1)[0]
    return not (
        "\\" in value or "://" in value or value.startswith("//") or ".." in path.split("/")
    )


def _same_origin(request: web.Request) -> bool:
    """True when the request's Origin names the host it was sent to."""
    origin = request.headers.get("Origin")
    return bool(origin) and urlsplit(origin).netloc == request.host


class SessionView(HomeAssistantView):
    """GET /api/home_security/app/_session: trade a ticket for the cookie."""

    url = f"{APP_BASE}_session"
    name = "api:home_security:app_session"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        hass = request.app[KEY_HASS]
        access = async_get_app_access(hass)
        nxt = request.query.get("next", "")
        if not _safe_next(nxt):
            return web.Response(status=HTTPStatus.BAD_REQUEST)
        if (session := access.redeem(request.query.get("ticket"))) is None:
            return web.Response(status=HTTPStatus.FORBIDDEN, text="This link has expired.")
        response = web.Response(
            status=HTTPStatus.FOUND,
            headers={
                "Location": f"{APP_BASE}{nxt.lstrip('/')}",
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
            },
        )
        response.set_cookie(
            APP_COOKIE,
            session,
            max_age=APP_SESSION_IDLE_SECONDS,
            path=APP_BASE,
            httponly=True,
            samesite="Strict",
            secure=request.secure,
        )
        return response


class AppProxyView(HomeAssistantView):
    """Every method under /api/home_security/app/, passed to the engine."""

    url = f"{APP_BASE}{{path:.*}}"
    name = "api:home_security:app"
    requires_auth = False  # the session cookie is the check

    async def handle(self, request: web.Request, path: str) -> web.StreamResponse:
        hass = request.app[KEY_HASS]
        if not async_get_app_access(hass).valid(request.cookies.get(APP_COOKIE)):
            return web.Response(
                status=HTTPStatus.FORBIDDEN,
                text="Your Home Security session has ended. Reload the page.",
            )
        if (coordinator := async_get_coordinator(hass)) is None:
            return web.Response(status=HTTPStatus.SERVICE_UNAVAILABLE)
        client = coordinator.client

        is_socket = request.headers.get("Upgrade", "").lower() == "websocket"
        if request.method not in SAFE_METHODS and not _same_origin(request):
            return web.Response(status=HTTPStatus.FORBIDDEN, text="Cross-site request refused.")
        if is_socket and "Origin" in request.headers and not _same_origin(request):
            return web.Response(status=HTTPStatus.FORBIDDEN, text="Cross-site request refused.")

        # The raw (still encoded) path and query, exactly as the browser sent them.
        rest = request.rel_url.raw_path[len(APP_BASE) :]
        target = f"{client.url}/{rest}"
        if request.rel_url.raw_query_string:
            target += f"?{request.rel_url.raw_query_string}"
        upstream_url = URL(target, encoded=True)
        headers = {
            name: value for name in FORWARD_REQUEST_HEADERS if (value := request.headers.get(name))
        }
        headers.update(client.headers)  # the paired key, added here

        if is_socket:
            return await self._socket(request, client, upstream_url, headers)
        return await self._plain(request, client, upstream_url, headers)

    get = post = put = patch = delete = head = handle

    async def _plain(
        self,
        request: web.Request,
        client: Any,
        upstream_url: URL,
        headers: dict[str, str],
    ) -> web.StreamResponse:
        session: aiohttp.ClientSession = client.session
        data = request.content if request.can_read_body else None
        response: web.StreamResponse | None = None
        try:
            async with session.request(
                request.method,
                upstream_url,
                headers=headers,
                data=data,
                allow_redirects=False,
                auto_decompress=False,
                timeout=UPSTREAM_TIMEOUT,
            ) as upstream:
                out_headers = {
                    k: v
                    for k, v in upstream.headers.items()
                    if k.lower() not in DROP_RESPONSE_HEADERS
                }
                if location := out_headers.get("Location"):
                    out_headers["Location"] = _rewrite_location(location, client.url)
                response = web.StreamResponse(status=upstream.status, headers=out_headers)
                await response.prepare(request)
                if request.method != "HEAD":
                    async for chunk in upstream.content.iter_chunked(CHUNK):
                        await response.write(chunk)
                await response.write_eof()
        except (aiohttp.ClientError, TimeoutError) as err:
            if response is not None and response.prepared:
                _LOGGER.debug("The engine broke off a response: %s", err)
                return response
            return web.Response(status=HTTPStatus.BAD_GATEWAY, text="The engine can't be reached.")
        return response

    async def _socket(
        self,
        request: web.Request,
        client: Any,
        upstream_url: URL,
        headers: dict[str, str],
    ) -> web.StreamResponse:
        session: aiohttp.ClientSession = client.session
        headers = {k: v for k, v in headers.items() if k == "Authorization"}
        try:
            async with asyncio.timeout(15):
                upstream = await session.ws_connect(upstream_url, headers=headers, heartbeat=30)
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.debug("The engine's websocket is unavailable: %s", err)
            return web.Response(status=HTTPStatus.BAD_GATEWAY, text="The engine can't be reached.")

        downstream = web.WebSocketResponse(heartbeat=30)
        await downstream.prepare(request)

        async def pump(source: Any, sink: Any) -> None:
            async for msg in source:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await sink.send_str(msg.data)
                elif msg.type == aiohttp.WSMsgType.BINARY:
                    await sink.send_bytes(msg.data)
                else:
                    break

        tasks = [
            asyncio.ensure_future(pump(upstream, downstream)),
            asyncio.ensure_future(pump(downstream, upstream)),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
            await upstream.close()
            await downstream.close()
        return downstream


def _rewrite_location(location: str, engine_url: str) -> str:
    """Keep a redirect inside the app: the engine's own paths live under the app path."""
    if location.startswith(engine_url):
        location = location[len(engine_url) :] or "/"
    if location.startswith("/") and not location.startswith("//"):
        return f"{APP_BASE}{location[1:]}"
    return location

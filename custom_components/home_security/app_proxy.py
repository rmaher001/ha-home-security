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
import re
import secrets
import time
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any
from urllib.parse import unquote, urlsplit

import aiohttp
from aiohttp import web
from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.core import HomeAssistant
from yarl import URL

from .const import (
    APP_BASE,
    APP_COOKIE,
    APP_SESSION_IDLE_SECONDS,
    APP_SESSION_MAX_SECONDS,
    APP_TICKET_RATE,
    APP_TICKET_SECONDS,
    DOMAIN,
)
from .coordinator import async_get_coordinator

_LOGGER = logging.getLogger(__name__)

CHUNK = 64 * 1024
MAX_OUTSTANDING = 200  # tickets or sessions held at once; the oldest go first
MAX_PER_USER = 20  # sessions or tickets one person may hold at once
RECHECK_SECONDS = 60  # how often an open connection is checked against its session
MAX_BODY = 1024 * 1024  # the most a browser may send through
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


@dataclass
class Session:
    """Who the cookie belongs to: the Home Assistant user and the login they came in with."""

    user_id: str
    refresh_token_id: str | None
    created: float
    last: float


class AppAccess:
    """One-time tickets and path-scoped sessions, kept in memory only."""

    def __init__(self, hass: HomeAssistant, clock: Callable[[], float] = time.monotonic) -> None:
        self.hass = hass
        self.clock = clock
        # Oldest first: tickets by expiry, sessions by last use (use moves one to the end).
        self._tickets: OrderedDict[str, tuple[float, str, str | None]] = OrderedDict()
        self._sessions: OrderedDict[str, Session] = OrderedDict()
        self._asks: dict[int, deque[float]] = {}  # by id of the websocket connection
        self._live: set[Callable[[], None]] = set()

    def allow_ticket(self, connection: Any) -> bool:
        """At most APP_TICKET_RATE tickets a minute per websocket connection."""
        now = self.clock()
        for key in [k for k, a in self._asks.items() if not a or now - a[-1] > 60]:
            del self._asks[key]  # connections that have gone quiet are forgotten
        asks = self._asks.setdefault(id(connection), deque())
        while asks and now - asks[0] > 60:
            asks.popleft()
        if len(asks) >= APP_TICKET_RATE:
            return False
        asks.append(now)
        return True

    def new_ticket(self, user_id: str, refresh_token_id: str | None) -> str:
        now = self.clock()
        self._prune(now)
        _make_room(self._tickets, user_id, lambda held: held[1])
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = (now + APP_TICKET_SECONDS, user_id, refresh_token_id)
        return ticket

    def redeem(self, ticket: str | None) -> str | None:
        """Burn the ticket; a live one gives a new session id for the same user and login."""
        now = self.clock()
        held = self._tickets.pop(ticket, None) if ticket else None
        if held is None or held[0] < now:
            return None
        self._prune(now)
        _make_room(self._sessions, held[1], lambda one: one.user_id)
        session = secrets.token_urlsafe(32)
        self._sessions[session] = Session(held[1], held[2], now, now)
        return session

    async def valid(self, session_id: str | None, *, live: bool = False) -> Session | None:
        """The session, if it is still good; using it renews its idle time.

        Good means: used within 12 hours, younger than 24, and the person still exists, is
        active, and the login they came in with hasn't been revoked. With live=True (an open
        connection being checked) idle time doesn't count and nothing is renewed.
        """
        now = self.clock()
        session = self._sessions.get(session_id) if session_id else None
        if session is None:
            return None
        if (not live and now - session.last > APP_SESSION_IDLE_SECONDS) or (
            now - session.created > APP_SESSION_MAX_SECONDS
        ):
            del self._sessions[session_id]
            return None
        user = await self.hass.auth.async_get_user(session.user_id)
        revoked = session.refresh_token_id is not None and (
            self.hass.auth.async_get_refresh_token(session.refresh_token_id) is None
        )
        if user is None or not user.is_active or revoked:
            self._sessions.pop(session_id, None)
            return None
        if not live and session_id in self._sessions:
            session.last = now
            self._sessions.move_to_end(session_id)
        return session

    @contextlib.contextmanager
    def track(self, session_id: str, close: Callable[[], None]) -> Iterator[None]:
        """Note a relay or a streaming answer, so it can be cut off.

        Ending the sessions cuts it, and so does its own session going bad: it is re-checked
        about every minute, and no later than the session's absolute end.
        """
        self._live.add(close)
        watcher = asyncio.ensure_future(self._watch(session_id, close))
        try:
            yield
        finally:
            watcher.cancel()
            self._live.discard(close)

    async def _watch(self, session_id: str, close: Callable[[], None]) -> None:
        while True:
            session = self._sessions.get(session_id)
            remaining = session.created + APP_SESSION_MAX_SECONDS - self.clock() if session else 0.0
            await asyncio.sleep(max(0.01, min(RECHECK_SECONDS, remaining)))
            if await self.valid(session_id, live=True) is None:
                with contextlib.suppress(Exception):
                    close()
                return

    def clear(self) -> None:
        """End every session and ticket, and cut every live connection."""
        self._tickets.clear()
        self._sessions.clear()
        for close in list(self._live):
            with contextlib.suppress(Exception):
                close()

    def _prune(self, now: float) -> None:
        while self._tickets and next(iter(self._tickets.values()))[0] < now:
            self._tickets.popitem(last=False)
        while self._sessions and (
            now - next(iter(self._sessions.values())).last > APP_SESSION_IDLE_SECONDS
        ):
            self._sessions.popitem(last=False)
        for held in (self._tickets, self._sessions):
            while len(held) >= MAX_OUTSTANDING:
                held.popitem(last=False)


def _make_room(held: OrderedDict[str, Any], user_id: str, owner: Callable[[Any], str]) -> None:
    """Drop a person's oldest entries so they hold fewer than MAX_PER_USER."""
    mine = [key for key, value in held.items() if owner(value) == user_id]
    for key in mine[: max(0, len(mine) - MAX_PER_USER + 1)]:
        del held[key]


def async_get_app_access(hass: HomeAssistant) -> AppAccess:
    if (access := hass.data.get(APP_KEY)) is None:
        access = hass.data[APP_KEY] = AppAccess(hass)
    return access


# What the engine's app may do through here, and nothing else. Matched on the decoded path,
# case-sensitively and exactly (no trailing-slash variants).
_ID = r"[A-Za-z0-9_-]{1,64}"
_ROUTES: tuple[tuple[str, re.Pattern[str], str], ...] = tuple(
    (method, re.compile(pattern), kind)
    for method, pattern, kind in (
        ("GET", r"", "open"),
        ("GET", r"page/home-security-cards-[^/]+\.js", "open"),
        ("GET", r"api/v1/state", "open"),
        ("GET", r"api/v1/stories", "open"),
        ("GET", rf"api/v1/stories/{_ID}/picture\.jpg", "open"),
        ("POST", rf"api/v1/stories/{_ID}/fine", "open"),
        ("PUT", r"api/v1/mode", "open"),
        ("PUT", r"api/v1/alerts", "open"),
        ("GET", r"api/v1/ws", "open"),
        # These change the engine's settings: administrators only.
        ("GET", r"page/setup", "admin"),
        ("POST", r"page/setup", "admin"),
        ("POST", r"page/restore", "admin"),
        ("POST", r"page/pair", "admin"),
    )
)
# Encoded dots, slashes and backslashes (also encoded twice), and NUL: never in a path here.
_BAD_ENCODING = re.compile(r"%(2e|2f|5c|25|00)", re.IGNORECASE)


def _route_for(method: str, rest: str) -> str | None:
    """ "open", "admin" or None (blocked) for a request; rest is the raw path after the app base."""
    if _BAD_ENCODING.search(rest) or "\\" in rest or "//" in rest:
        return None
    if any(segment in (".", "..") for segment in rest.split("/")):
        return None
    path = unquote(rest)
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in path):
        return None
    for allowed, pattern, kind in _ROUTES:
        if allowed == method and pattern.fullmatch(path):
            return kind
    return None


def _safe_next(value: str) -> bool:
    """Only a path inside the app: no scheme, no host, no backslash, no climbing out.

    The path part is checked again after one more decoding, so %2e%2e or %2f can't sneak by.
    """
    path = value.split("?", 1)[0]
    if _BAD_ENCODING.search(path):
        return False
    for text in (value, unquote(value)):
        if any(ord(c) < 0x20 or ord(c) == 0x7F for c in text):
            return False
        before_query = text.split("?", 1)[0]
        if (
            "\\" in text
            or "://" in text
            or text.startswith("//")
            or ".." in before_query.split("/")
        ):
            return False
    return True


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


class AppRootView(HomeAssistantView):
    """/api/home_security/app → /api/home_security/app/ (the page's links are relative)."""

    url = APP_BASE.rstrip("/")
    name = "api:home_security:app_root"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        query = request.rel_url.raw_query_string
        return web.Response(
            status=HTTPStatus.PERMANENT_REDIRECT,
            headers={"Location": f"{APP_BASE}?{query}" if query else APP_BASE},
        )


class AppProxyView(HomeAssistantView):
    """Every method under /api/home_security/app/, passed to the engine."""

    url = f"{APP_BASE}{{path:.*}}"
    name = "api:home_security:app"
    requires_auth = False  # the session cookie is the check

    async def handle(self, request: web.Request, path: str) -> web.StreamResponse:
        hass = request.app[KEY_HASS]
        access = async_get_app_access(hass)
        session_id = request.cookies.get(APP_COOKIE)
        session = await access.valid(session_id)
        if session is None:
            return web.Response(
                status=HTTPStatus.FORBIDDEN,
                text="Your Home Security session has ended. Reload the page.",
            )

        # The raw (still encoded) path and query, exactly as the browser sent them.
        rest = request.rel_url.raw_path[len(APP_BASE) :]
        kind = _route_for(request.method, rest)
        if kind is None:
            return web.Response(status=HTTPStatus.NOT_FOUND)
        if kind == "admin":
            user = await hass.auth.async_get_user(session.user_id)
            if user is None or not user.is_admin:
                return web.Response(
                    status=HTTPStatus.FORBIDDEN, text="Only an administrator can do that."
                )
        if (coordinator := async_get_coordinator(hass)) is None:
            return web.Response(status=HTTPStatus.SERVICE_UNAVAILABLE)
        client = coordinator.client

        is_socket = request.headers.get("Upgrade", "").lower() == "websocket"
        if is_socket and rest != "api/v1/ws":
            return web.Response(status=HTTPStatus.NOT_FOUND)  # only the engine's socket route
        if request.method not in SAFE_METHODS and not _same_origin(request):
            return web.Response(status=HTTPStatus.FORBIDDEN, text="Cross-site request refused.")
        if is_socket and "Origin" in request.headers and not _same_origin(request):
            return web.Response(status=HTTPStatus.FORBIDDEN, text="Cross-site request refused.")
        if (request.content_length or 0) > MAX_BODY:
            return web.Response(status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)

        target = f"{client.url}/{rest}"
        if request.rel_url.raw_query_string:
            target += f"?{request.rel_url.raw_query_string}"
        upstream_url = URL(target, encoded=True)
        headers = {
            name: value for name in FORWARD_REQUEST_HEADERS if (value := request.headers.get(name))
        }
        if request.content_length is not None:
            headers["Content-Length"] = str(request.content_length)
        headers.update(client.headers)  # the paired key, added here

        if is_socket:
            return await self._socket(request, access, session_id, client, upstream_url, headers)
        return await self._plain(request, access, session_id, client, upstream_url, headers)

    get = post = put = patch = delete = head = handle

    async def _plain(
        self,
        request: web.Request,
        access: AppAccess,
        session_id: str | None,
        client: Any,
        upstream_url: URL,
        headers: dict[str, str],
    ) -> web.StreamResponse:
        session: aiohttp.ClientSession = client.session
        too_large = False

        async def limited() -> AsyncIterator[bytes]:
            nonlocal too_large
            total = 0
            async for chunk in request.content.iter_chunked(CHUNK):
                total += len(chunk)
                if total > MAX_BODY:
                    too_large = True
                    raise _TooLarge
                yield chunk

        data = limited() if request.can_read_body else None
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
                transport = request.transport
                with access.track(session_id or "", lambda: transport and transport.close()):
                    if request.method != "HEAD":
                        async for chunk in upstream.content.iter_chunked(CHUNK):
                            await response.write(chunk)
                    await response.write_eof()
        except (aiohttp.ClientError, TimeoutError, _TooLarge) as err:
            if too_large:
                return web.Response(status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            if response is not None and response.prepared:
                _LOGGER.debug("The engine broke off a response: %s", err)
                return response
            return web.Response(status=HTTPStatus.BAD_GATEWAY, text="The engine can't be reached.")
        return response

    async def _socket(
        self,
        request: web.Request,
        access: AppAccess,
        session_id: str | None,
        client: Any,
        upstream_url: URL,
        headers: dict[str, str],
    ) -> web.StreamResponse:
        hass = request.app[KEY_HASS]
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
            with access.track(session_id or "", lambda: hass.async_create_task(downstream.close())):
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


class _TooLarge(Exception):
    """The browser sent more than MAX_BODY."""


def _rewrite_location(location: str, engine_url: str) -> str:
    """Keep a redirect inside the app: the engine's own paths live under the app path.

    Compares the parsed scheme and host, never a string prefix, so an address that merely
    starts like the engine's isn't taken for it.
    """
    parts = urlsplit(location)
    if parts.scheme or parts.netloc:
        engine = urlsplit(engine_url)
        if (parts.scheme.lower(), parts.netloc.lower()) != (
            engine.scheme.lower(),
            engine.netloc.lower(),
        ):
            return location
        tail = parts._replace(scheme="", netloc="").geturl()
        return f"{APP_BASE}{tail.lstrip('/')}"
    if location.startswith("/") and not location.startswith("//"):
        return f"{APP_BASE}{location[1:]}"
    return location

"""The story picture, proxied from the engine for logged-in users and signed paths."""

from __future__ import annotations

import logging
from http import HTTPStatus

from aiohttp import web
from homeassistant.components.http import KEY_HASS, HomeAssistantView

from .api import EngineError, EngineNotFound
from .const import CLIP_URL, PICTURE_URL, STOP_RE, STORY_ID_RE
from .coordinator import async_get_coordinator

_LOGGER = logging.getLogger(__name__)

CHUNK = 64 * 1024


class PictureView(HomeAssistantView):
    """GET /api/home_security/picture/{story_id}."""

    url = PICTURE_URL
    name = "api:home_security:picture"
    requires_auth = True

    async def get(self, request: web.Request, story_id: str) -> web.StreamResponse:
        if not STORY_ID_RE.match(story_id):
            return web.Response(status=HTTPStatus.BAD_REQUEST)
        if (coordinator := async_get_coordinator(request.app[KEY_HASS])) is None:
            return web.Response(status=HTTPStatus.SERVICE_UNAVAILABLE)

        response: web.StreamResponse | None = None
        try:
            async with coordinator.client.async_picture(story_id) as upstream:
                response = web.StreamResponse(
                    headers={
                        "Content-Type": upstream.headers.get("Content-Type", "image/jpeg"),
                        "Cache-Control": "private, max-age=3600",
                    }
                )
                await response.prepare(request)
                async for chunk in upstream.content.iter_chunked(CHUNK):
                    await response.write(chunk)
                await response.write_eof()
        except EngineNotFound:
            return web.Response(status=HTTPStatus.NOT_FOUND)
        except EngineError as err:
            if response is not None:
                _LOGGER.debug("The picture stream for %s broke off: %s", story_id, err)
                return response
            return web.Response(status=HTTPStatus.BAD_GATEWAY)
        return response


# What a player needs from the engine's answer to seek in a recording.
CLIP_HEADERS = ("Content-Length", "Content-Range", "Accept-Ranges")


class ClipView(HomeAssistantView):
    """GET /api/home_security/clip/{story_id}/{stop}: the recording around one stop."""

    url = CLIP_URL
    name = "api:home_security:clip"
    requires_auth = True

    async def get(self, request: web.Request, story_id: str, stop: str) -> web.StreamResponse:
        if not STORY_ID_RE.match(story_id) or not STOP_RE.match(stop):
            return web.Response(status=HTTPStatus.BAD_REQUEST)
        if (coordinator := async_get_coordinator(request.app[KEY_HASS])) is None:
            return web.Response(status=HTTPStatus.SERVICE_UNAVAILABLE)

        response: web.StreamResponse | None = None
        try:
            async with coordinator.client.async_clip(
                story_id, int(stop), request.headers.get("Range")
            ) as upstream:
                headers = {
                    "Content-Type": upstream.headers.get("Content-Type", "video/mp4"),
                    "Cache-Control": "private, max-age=3600",
                }
                for name in CLIP_HEADERS:
                    if value := upstream.headers.get(name):
                        headers[name] = value
                response = web.StreamResponse(status=upstream.status, headers=headers)
                await response.prepare(request)
                async for chunk in upstream.content.iter_chunked(CHUNK):
                    await response.write(chunk)
                await response.write_eof()
        except EngineNotFound:
            return web.Response(status=HTTPStatus.NOT_FOUND)
        except EngineError as err:
            if response is not None:
                _LOGGER.debug("The clip stream for %s broke off: %s", story_id, err)
                return response
            return web.Response(status=HTTPStatus.BAD_GATEWAY)
        return response

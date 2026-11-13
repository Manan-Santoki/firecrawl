"""FastAPI application implementing Firecrawl's AVGRAB_SERVICE_URL contract.

Endpoints consumed by the Firecrawl API (upstream v2.11.739):

* GET  /supported-urls  -> {"regex": str, "resolve_regex": str}
* POST /download        {url, cookies?}            -> {"public_url": str, ...}
* POST /download-video  {url, cookies?}            -> {"public_url": str, ...}
* POST /videos          {url, html?}               -> {"videos": [VideoItem]}
* POST /metadata        {url, transcript_language, cookies?} -> YouTube metadata
* POST /resolve         {url, limit}               -> {"username": str, "posts": [...]}

Community additions: GET /health, GET /files/{id}/{name} (signed links).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import Settings, load_settings
from .errors import ServiceError
from .media import MediaService
from .patterns import (
    DEFAULT_RESOLVE_REGEX,
    DEFAULT_SUPPORTED_REGEX,
    NEVER_MATCH,
    assert_js_compatible,
)
from .runner import YtDlp
from .security import constant_time_equals, validate_target_url, verify
from .storage import Storage
from .videos import discover_videos

logger = logging.getLogger("avgrab")

MAX_URL_LENGTH = 4096


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class DownloadRequest(_Model):
    url: str = Field(min_length=1, max_length=MAX_URL_LENGTH)
    cookies: list[dict[str, Any]] | None = Field(default=None, max_length=1000)


class MetadataRequest(DownloadRequest):
    transcript_language: str = "en"


class VideosRequest(_Model):
    url: str = Field(min_length=1, max_length=MAX_URL_LENGTH)
    html: str | None = None


class ResolveRequest(_Model):
    url: str = Field(min_length=1, max_length=MAX_URL_LENGTH)
    limit: int = Field(default=100, ge=1)


class AuthMiddleware:
    """Optional shared-secret auth.

    The upstream API client sends no auth header, so besides
    ``Authorization: Bearer <key>`` / ``X-API-Key: <key>`` the key is accepted
    as a path prefix: ``AVGRAB_SERVICE_URL=http://avgrab:8080/k/<key>``. The
    prefix is stripped before routing. ``/health`` and signed ``/files`` links
    are always reachable without the key.
    """

    PUBLIC_PREFIXES = ("/health", "/files/")

    def __init__(self, app: ASGIApp, api_key: str | None):
        self.app = app
        self.api_key = api_key

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope["path"]
        authorized = self.api_key is None
        match = re.match(r"^/k/([^/]+)(/.*)?$", path)
        if match:
            if self.api_key is not None and constant_time_equals(match.group(1), self.api_key):
                authorized = True
            path = match.group(2) or "/"
            scope = dict(scope, path=path, raw_path=path.encode())
        if not authorized:
            headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
            bearer = headers.get("authorization", "")
            token = bearer[7:].strip() if bearer.lower().startswith("bearer ") else headers.get("x-api-key", "")
            if token and constant_time_equals(token, self.api_key or ""):
                authorized = True
        if not authorized and not path.startswith(self.PUBLIC_PREFIXES):
            response = JSONResponse({"detail": "Unauthorized"}, status_code=401)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _ffmpeg_version() -> str | None:
    binary = shutil.which("ffmpeg")
    if not binary:
        return None
    try:
        out = subprocess.run([binary, "-version"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return out.split("\n", 1)[0] or None


def create_app(settings: Settings | None = None, ytdlp: YtDlp | None = None) -> FastAPI:
    settings = settings or load_settings()
    storage = Storage(settings)
    ytdlp = ytdlp or YtDlp(settings.ytdlp_binary, settings.ytdlp_extra_args)
    service = MediaService(settings, storage, ytdlp)

    supported_regex = assert_js_compatible(settings.supported_regex or DEFAULT_SUPPORTED_REGEX)
    if not settings.resolve_enabled:
        resolve_regex = NEVER_MATCH
    else:
        resolve_regex = assert_js_compatible(settings.resolve_regex or DEFAULT_RESOLVE_REGEX)
    supported_re = re.compile(supported_regex)
    resolve_re = re.compile(resolve_regex)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI):
        storage.prepare()

        async def janitor() -> None:
            while True:
                await asyncio.sleep(60)
                try:
                    removed = await asyncio.to_thread(storage.sweep)
                    if removed:
                        logger.info("janitor removed %d expired entries", removed)
                except Exception:  # pragma: no cover - defensive
                    logger.exception("janitor sweep failed")

        task = asyncio.create_task(janitor())
        try:
            yield
        finally:
            task.cancel()

    app = FastAPI(title="Firecrawl Community avgrab", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.service = service
    app.state.storage = storage

    @app.exception_handler(ServiceError)
    async def _service_error(_: Request, exc: ServiceError) -> JSONResponse:
        return JSONResponse(exc.body(), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", []) if p != "body")
        return JSONResponse({"detail": f"Invalid request: {loc or 'body'} {first.get('msg', '')}".strip()}, status_code=400)

    async def check_supported(url: str) -> None:
        if not supported_re.search(url):
            raise ServiceError(400, "Unsupported URL")
        await validate_target_url(url, settings.allow_private_networks)

    def download_response(stored, info: dict[str, Any]) -> dict[str, Any]:
        return {
            "public_url": stored.public_url,
            "filename": stored.filename,
            "mime_type": stored.mime_type,
            "size_bytes": stored.size_bytes,
            "expires_at": datetime.fromtimestamp(stored.expires_at, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            "title": info.get("title"),
            "duration": info.get("duration"),
            "source_url": info.get("webpage_url") or info.get("original_url"),
        }

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "storage": storage.backend,
            "active": service.limiter.active,
            "max_concurrency": service.limiter.limit,
            "ffmpeg": _ffmpeg_version(),
        }

    @app.get("/supported-urls")
    async def supported_urls() -> dict[str, str]:
        return {"regex": supported_regex, "resolve_regex": resolve_regex}

    @app.post("/download")
    async def download_audio(body: DownloadRequest) -> dict[str, Any]:
        await check_supported(body.url)
        stored, info = await service.download(body.url, body.cookies, "audio")
        return download_response(stored, info)

    @app.post("/download-video")
    async def download_video(body: DownloadRequest) -> dict[str, Any]:
        await check_supported(body.url)
        stored, info = await service.download(body.url, body.cookies, "video")
        return download_response(stored, info)

    @app.post("/metadata")
    async def metadata(body: MetadataRequest) -> dict[str, Any]:
        await check_supported(body.url)
        lang = body.transcript_language.lower()
        if not re.fullmatch(r"[a-z]{2,3}", lang):
            lang = "en"
        return await service.metadata(body.url, lang, body.cookies)

    @app.post("/videos")
    async def videos(body: VideosRequest) -> dict[str, Any]:
        # Syntax check only: /videos parses the supplied HTML and never fetches.
        await validate_target_url(body.url, allow_private=True)
        html = body.html
        if html is not None and len(html) > settings.max_html_bytes:
            html = html[: settings.max_html_bytes]
        page_is_provider = bool(supported_re.search(body.url))
        items = await asyncio.to_thread(discover_videos, body.url, html, page_is_provider, settings.max_videos)
        return {"videos": items}

    @app.post("/resolve")
    async def resolve(body: ResolveRequest) -> dict[str, Any]:
        if not resolve_re.search(body.url):
            raise ServiceError(400, "URL is not supported by resolve")
        await validate_target_url(body.url, settings.allow_private_networks)
        try:
            return await service.resolve(body.url, body.limit)
        except ServiceError as exc:
            # The API reads only a string detail on /resolve failures.
            if isinstance(exc.detail, dict):
                raise ServiceError(exc.status, exc.detail.get("message", "Resolve failed")) from exc
            raise

    @app.get("/files/{file_id}/{name}")
    async def files(file_id: str, name: str, expires: int = 0, sig: str = "") -> FileResponse:
        if storage.backend != "local" or not verify(settings.signing_key, file_id, expires, sig):
            raise ServiceError(403, "Invalid or expired link")
        found = storage.lookup(file_id)
        if found is None:
            raise ServiceError(404, "File not found")
        path, meta = found
        return FileResponse(
            path,
            media_type=meta.get("mime_type"),
            filename=meta.get("filename"),
            headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"},
        )

    app.add_middleware(AuthMiddleware, api_key=settings.api_key)
    return app


def build() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    return create_app()

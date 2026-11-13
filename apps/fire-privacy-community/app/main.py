"""HTTP surface compatible with Firecrawl's fire-privacy `/redact` contract.

Request (as sent by apps/api/src/lib/fire-privacy-client.ts):
    {"text": str, "mode": "model"|"both"|"heuristics", "operator":
     "replace"|"mask"|"redact", "language": "en", "data_region"?: "us"}
Response 200:
    {"redacted_text": str, "spans": [{start, end, kind, score, source}],
     "model_status": "ok"|"skipped", "data_region"?: str}
Failure statuses the client distinguishes: 503 -> service_unavailable,
anything else non-2xx -> error, a body with code=region_unavailable ->
region refusal for pinned requests.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import Literal, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError
from starlette.concurrency import run_in_threadpool

from . import engine
from .config import Settings
from .redaction import render, resolve_overlaps, to_wire_spans

logger = logging.getLogger("fire_privacy_community")

# Room for JSON framing and \uXXXX escapes (up to 6 bytes per UTF-8 byte).
_BODY_OVERHEAD = 64 * 1024
_BODY_EXPANSION = 6


class RedactRequest(BaseModel):
    # Unknown fields are ignored so newer API builds keep working.
    model_config = ConfigDict(extra="ignore")

    text: str
    mode: Literal["model", "both", "heuristics", "precise"] = "model"
    operator: Literal["replace", "mask", "redact"] = "replace"
    language: str = "en"
    data_region: Optional[str] = None


def _error(status: int, code: str, message: str, **extra) -> JSONResponse:
    return JSONResponse(
        status_code=status, content={"code": code, "error": message, **extra}
    )


class _Limiter:
    """Bounded concurrency with a bounded, time-limited wait queue."""

    def __init__(self, concurrency: int, max_queue: int, timeout_s: float) -> None:
        self._semaphore = asyncio.Semaphore(concurrency)
        self._concurrency = concurrency
        self._max_queue = max_queue
        self._timeout_s = timeout_s
        self._waiting = 0
        self.active = 0

    async def acquire(self) -> bool:
        if self.active >= self._concurrency and self._waiting >= self._max_queue:
            return False
        self._waiting += 1
        try:
            await asyncio.wait_for(self._semaphore.acquire(), self._timeout_s)
        except asyncio.TimeoutError:
            return False
        finally:
            self._waiting -= 1
        self.active += 1
        return True

    def release(self) -> None:
        self.active -= 1
        self._semaphore.release()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    state: dict = {}
    if not logger.handlers:
        # Only sizes, modes and timings are logged, never request text.
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s:     %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        started = time.monotonic()
        analyzer = engine.build_analyzer(settings.spacy_model)
        engine.load_extra_recognizers(analyzer, settings.extra_entities)
        entities = engine.DEFAULT_ENTITIES + settings.extra_entities
        # Warm lazy spaCy/Presidio initialisation before readiness passes.
        engine.detect(analyzer, "Warm up Jane Doe at jane@example.com.", "both", 0.3, entities)
        state["analyzer"] = analyzer
        state["entities"] = entities
        state["limiter"] = _Limiter(
            settings.max_concurrency,
            settings.max_queue,
            settings.queue_timeout_ms / 1000,
        )
        logger.info(
            "analyzer ready in %.1fs (model=%s, auth=%s, region=%s)",
            time.monotonic() - started,
            settings.spacy_model,
            "on" if settings.api_key else "off",
            settings.data_region or "unset",
        )
        yield
        state.clear()

    app = FastAPI(
        title="fire-privacy-community",
        version="1.0.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    def authorized(request: Request) -> bool:
        if not settings.api_key:
            return True
        supplied = request.headers.get("x-api-key")
        auth = request.headers.get("authorization", "")
        if supplied is None and auth[:7].lower() == "bearer ":
            supplied = auth[7:].strip()
        if not supplied:
            return False
        return hmac.compare_digest(supplied.encode(), settings.api_key.encode())

    async def read_body(request: Request) -> bytes | None:
        limit = settings.max_text_bytes * _BODY_EXPANSION + _BODY_OVERHEAD
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            return None
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > limit:
                return None
        return bytes(body)

    @app.get("/health")
    @app.get("/health/liveness")
    async def liveness() -> dict:
        return {"status": "ok"}

    @app.get("/health/readiness")
    async def readiness() -> JSONResponse:
        if "analyzer" not in state:
            return _error(503, "not_ready", "analyzer is loading")
        return JSONResponse({"status": "ok", "model": settings.spacy_model})

    @app.post("/redact")
    async def redact(request: Request) -> JSONResponse:
        if not authorized(request):
            return _error(401, "unauthorized", "missing or invalid API key")
        if "analyzer" not in state:
            return _error(503, "not_ready", "analyzer is loading")

        raw = await read_body(request)
        if raw is None:
            return _error(413, "too_large", "request body exceeds the limit")
        try:
            payload = RedactRequest.model_validate(json.loads(raw))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return _error(400, "invalid_json", "request body is not valid JSON")
        except ValidationError as exc:
            return _error(
                422,
                "invalid_request",
                "request body does not match the /redact schema",
                details=json.loads(exc.json(include_input=False, include_url=False)),
            )

        if payload.language.lower() != "en":
            return _error(
                422, "unsupported_language", "only language 'en' is supported"
            )

        pinned = (payload.data_region or "").strip().lower() or None
        if pinned is not None and pinned != settings.data_region:
            # Same refusal shape fire-privacy uses; the API turns it into a
            # US-only error rather than redacting outside the region.
            return _error(
                503,
                "region_unavailable",
                "this deployment does not process data in the requested region",
                data_region=pinned,
            )

        text = payload.text
        size = len(text.encode("utf-8", "surrogatepass"))
        if size > settings.max_text_bytes:
            return _error(
                413,
                "too_large",
                f"text is {size} bytes; the limit is {settings.max_text_bytes}",
            )

        region_echo = {"data_region": pinned} if pinned else {}
        if text.strip() == "":
            return JSONResponse(
                {
                    "redacted_text": text,
                    "spans": [],
                    "model_status": "skipped",
                    **region_echo,
                }
            )

        limiter: _Limiter = state["limiter"]
        if not await limiter.acquire():
            return _error(503, "overloaded", "redaction capacity is saturated")
        started = time.monotonic()
        try:
            detections = await run_in_threadpool(
                engine.detect,
                state["analyzer"],
                text,
                payload.mode,
                settings.threshold(payload.mode),
                state["entities"],
                settings.noisy_floor(payload.mode),
            )
        except Exception:  # noqa: BLE001 - never echo input in errors
            logger.exception("analysis failed (bytes=%d mode=%s)", size, payload.mode)
            return _error(500, "analysis_failed", "PII analysis failed")
        finally:
            limiter.release()

        kept = resolve_overlaps(detections)
        logger.info(
            "redacted bytes=%d mode=%s spans=%d ms=%d",
            size,
            payload.mode,
            len(kept),
            int((time.monotonic() - started) * 1000),
        )
        return JSONResponse(
            {
                "redacted_text": render(text, kept, payload.operator),
                "spans": to_wire_spans(text, kept),
                "model_status": "ok",
                **region_echo,
            }
        )

    return app

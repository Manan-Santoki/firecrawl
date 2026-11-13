"""Error types and yt-dlp failure classification.

Firecrawl distinguishes two error body shapes (see `throwIfMediaAccessDenied`
in apps/api/src/scraper/scrapeURL/error.ts):

* ``{"detail": "<string>"}`` -- internal/operational failure; the API wraps it
  as ``Audio download failed: <detail>``.
* ``{"detail": {"code": str, "message": str}}`` -- terminal, user-facing
  denial; the API relays ``message`` verbatim as SCRAPE_MEDIA_ACCESS_DENIED.
"""

from __future__ import annotations

import re
from typing import Any


class ServiceError(Exception):
    def __init__(self, status: int, detail: str | dict[str, str]):
        super().__init__(detail if isinstance(detail, str) else detail.get("message", ""))
        self.status = status
        self.detail = detail

    def body(self) -> dict[str, Any]:
        return {"detail": self.detail}


def access_denied(code: str, message: str, status: int = 403) -> ServiceError:
    return ServiceError(status, {"code": code, "message": message})


# (pattern, code, user-facing message, http status)
_ACCESS_RULES: tuple[tuple[re.Pattern[str], str, str, int], ...] = (
    (
        re.compile(r"confirm you.?re not a bot|not a robot|captcha", re.I),
        "bot_check",
        "The content provider requested verification that the request is not automated. Retry later or supply authenticated cookies.",
        403,
    ),
    (
        re.compile(r"private video|this video is private|is private\b|private account", re.I),
        "private",
        "This content is private and cannot be retrieved.",
        403,
    ),
    (
        re.compile(r"confirm your age|age[- ]restricted|inappropriate for some users", re.I),
        "age_restricted",
        "This content is age-restricted and requires an authenticated session to access.",
        403,
    ),
    (
        re.compile(r"members[- ]only|join this channel|premium|requires (?:a )?(?:paid )?subscription|purchase", re.I),
        "paywalled",
        "This content requires a paid membership or subscription to access.",
        403,
    ),
    (
        re.compile(r"geo.?restrict|available in your country|available from your location", re.I),
        "geo_restricted",
        "This content is not available in the service's region.",
        403,
    ),
    (
        re.compile(r"sign in|log ?in|login required|authentication|cookies.{0,40}(?:required|needed)|use --cookies", re.I),
        "content_unavailable",
        "This content requires an authenticated session to access.",
        403,
    ),
    (
        re.compile(r"video unavailable|has been removed|no longer available|does not exist|HTTP Error 404|account.{0,20}terminated|copyright", re.I),
        "not_found",
        "This content is unavailable or has been removed.",
        404,
    ),
)


def last_error_line(stderr: str) -> str:
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    errors = [line for line in lines if line.startswith("ERROR:")]
    line = (errors or lines or ["unknown error"])[-1]
    line = re.sub(r"^ERROR:\s*", "", line)
    # Strip extractor prefix like "[youtube] abc123: "
    line = re.sub(r"^\[[^\]]+\]\s*[^:]{0,64}:\s*", "", line)
    return line[:500]


def classify_ytdlp_failure(stderr: str) -> ServiceError:
    message = last_error_line(stderr)
    if re.search(r"Unsupported URL", message, re.I):
        return ServiceError(400, "Unsupported URL")
    for pattern, code, user_message, status in _ACCESS_RULES:
        if pattern.search(message):
            return access_denied(code, user_message, status)
    return ServiceError(502, f"Extraction failed: {message}")

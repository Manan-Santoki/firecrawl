"""Convert Firecrawl BrowserCookie objects to a Netscape cookie jar for yt-dlp."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

MAX_COOKIES = 300


def _clean(value: Any) -> str:
    return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def write_cookie_file(cookies: Iterable[dict[str, Any]] | None, path: Path) -> Path | None:
    if not cookies:
        return None
    lines = ["# Netscape HTTP Cookie File"]
    for cookie in list(cookies)[:MAX_COOKIES]:
        if not isinstance(cookie, dict):
            continue
        name = cookie.get("name")
        value = cookie.get("value")
        domain = cookie.get("domain")
        if not isinstance(name, str) or not name or value is None or not isinstance(domain, str) or not domain:
            continue
        include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
        cookie_path = cookie.get("path") if isinstance(cookie.get("path"), str) else "/"
        secure = "TRUE" if cookie.get("secure") else "FALSE"
        expires = cookie.get("expires")
        try:
            expires_int = int(float(expires)) if expires is not None else 0
        except (TypeError, ValueError):
            expires_int = 0
        if expires_int < 0:
            expires_int = 0  # session cookie (Playwright uses -1)
        prefix = "#HttpOnly_" if cookie.get("httpOnly") else ""
        lines.append(
            "\t".join(
                [
                    prefix + _clean(domain),
                    include_subdomains,
                    _clean(cookie_path),
                    secure,
                    str(expires_int),
                    _clean(name),
                    _clean(value),
                ]
            )
        )
    if len(lines) == 1:
        return None
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)
    return path

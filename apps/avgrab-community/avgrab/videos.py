"""Generic video discovery from page HTML (POST /videos).

Pure parsing: the service never fetches the page. Items follow Firecrawl's
``VideoItem`` shape (apps/api/src/controllers/v2/types.ts):

* ``source``: ``html`` (<video>/<source> tags), ``metadata`` (Open Graph,
  Twitter cards, JSON-LD VideoObject) or ``provider`` (known video provider).
* ``kind``: ``file`` (direct media), ``stream`` (HLS/DASH manifest), ``embed``
  (embedded provider player) or ``page`` (the scraped page itself is a
  provider video page).

The API only falls back to a full download (``/download-video``) when every
item is a provider ``page``; anything richer is returned as-is.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

_FILE_EXT = re.compile(r"\.(mp4|m4v|webm|mov|mkv|ogv|ogg|avi|flv|3gp)(?:$|[?#])", re.I)
_STREAM_EXT = re.compile(r"\.(m3u8|mpd)(?:$|[?#])", re.I)
_MIME_BY_EXT = {
    "mp4": "video/mp4", "m4v": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
    "mkv": "video/x-matroska", "ogv": "video/ogg", "ogg": "video/ogg", "avi": "video/x-msvideo",
    "flv": "video/x-flv", "3gp": "video/3gpp", "m3u8": "application/vnd.apple.mpegurl",
    "mpd": "application/dash+xml",
}

_YT_ID = r"([A-Za-z0-9_-]{11})"
_PROVIDER_EMBEDS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("youtube", re.compile(r"^https?://(?:www\.)?(?:youtube\.com|youtube-nocookie\.com)/embed/" + _YT_ID), "https://www.youtube.com/watch?v={0}"),
    ("youtube", re.compile(r"^https?://(?:www\.|m\.)?youtube\.com/watch\?(?:.*&)?v=" + _YT_ID), "https://www.youtube.com/watch?v={0}"),
    ("youtube", re.compile(r"^https?://youtu\.be/" + _YT_ID), "https://www.youtube.com/watch?v={0}"),
    ("vimeo", re.compile(r"^https?://player\.vimeo\.com/video/(\d+)"), "https://vimeo.com/{0}"),
    ("vimeo", re.compile(r"^https?://(?:www\.)?vimeo\.com/(\d+)"), "https://vimeo.com/{0}"),
    ("dailymotion", re.compile(r"^https?://(?:www\.)?dailymotion\.com/(?:embed/)?video/([A-Za-z0-9]+)"), "https://www.dailymotion.com/video/{0}"),
    ("dailymotion", re.compile(r"^https?://geo\.dailymotion\.com/player[^?]*\?(?:.*&)?video=([A-Za-z0-9]+)"), "https://www.dailymotion.com/video/{0}"),
    ("wistia", re.compile(r"^https?://fast\.wistia\.(?:net|com)/embed/(?:iframe|medias)/([A-Za-z0-9]+)"), "https://fast.wistia.net/embed/iframe/{0}"),
    ("loom", re.compile(r"^https?://(?:www\.)?loom\.com/(?:embed|share)/([A-Za-z0-9]+)"), "https://www.loom.com/share/{0}"),
    ("streamable", re.compile(r"^https?://(?:www\.)?streamable\.com/(?:e/|o/)?([A-Za-z0-9]+)"), "https://streamable.com/{0}"),
    ("twitch", re.compile(r"^https?://player\.twitch\.tv/\?(?:.*&)?video=v?(\d+)"), "https://www.twitch.tv/videos/{0}"),
    ("tiktok", re.compile(r"^https?://(?:www\.)?tiktok\.com/(?:embed/v2/|embed/|@[^/]+/video/)(\d+)"), "https://www.tiktok.com/embed/v2/{0}"),
)


def _clean_url(value: Any, base: str) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or value.startswith(("data:", "blob:", "javascript:", "about:")):
        return None
    absolute = urljoin(base, value)
    if urlsplit(absolute).scheme not in {"http", "https"}:
        return None
    return absolute


def _mime_for(url: str, declared: str | None = None) -> str | None:
    if declared and "/" in declared:
        return declared.split(";")[0].strip()
    match = _FILE_EXT.search(url) or _STREAM_EXT.search(url)
    return _MIME_BY_EXT.get(match.group(1).lower()) if match else None


def _kind_for(url: str, mime: str | None) -> str:
    if _STREAM_EXT.search(url) or (mime and ("mpegurl" in mime or "dash" in mime)):
        return "stream"
    if _FILE_EXT.search(url) or (mime and mime.startswith("video/")):
        return "file"
    return "embed"


def match_provider(url: str) -> tuple[str, str] | None:
    for provider, pattern, canonical in _PROVIDER_EMBEDS:
        match = pattern.match(url)
        if match:
            return provider, canonical.format(match.group(1))
    return None


def _int(value: Any) -> int | None:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _str(value: Any) -> str | None:
    if isinstance(value, list):
        value = next((v for v in value if isinstance(v, (str, dict))), None)
    if isinstance(value, dict):
        value = value.get("url") or value.get("contentUrl") or value.get("@id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _iter_jsonld(node: Any) -> Iterable[dict[str, Any]]:
    if isinstance(node, list):
        for item in node:
            yield from _iter_jsonld(item)
    elif isinstance(node, dict):
        types = node.get("@type")
        types = types if isinstance(types, list) else [types]
        if any(isinstance(t, str) and t.lower() == "videoobject" for t in types):
            yield node
        for key in ("@graph", "video", "mainEntity", "hasPart", "subjectOf", "associatedMedia"):
            if key in node:
                yield from _iter_jsonld(node[key])


class _Collector:
    def __init__(self, source_url: str, limit: int):
        self.source_url = source_url
        self.limit = limit
        self.items: list[dict[str, Any]] = []
        self._index: dict[str, dict[str, Any]] = {}

    def add(self, item: dict[str, Any]) -> None:
        url = item["url"]
        existing = self._index.get(url)
        if existing is not None:
            for key, value in item.items():
                if value is not None and existing.get(key) is None:
                    existing[key] = value
            return
        if len(self.items) >= self.limit:
            return
        clean = {k: v for k, v in item.items() if v is not None}
        clean["sourceURL"] = self.source_url
        self._index[url] = clean
        self.items.append(clean)

    def add_media(self, raw_url: Any, source: str, base: str, **extra: Any) -> None:
        url = _clean_url(raw_url, base)
        if not url:
            return
        provider = match_provider(url)
        if provider:
            name, canonical = provider
            self.add({"url": canonical, "source": "provider", "kind": "embed", "provider": name, **extra, "metadata": {**(extra.get("metadata") or {}), "embedUrl": url}})
            return
        mime = _mime_for(url, extra.pop("mimeType", None))
        kind = _kind_for(url, mime)
        if kind == "embed" and source == "html":
            return  # a <video src> without a recognizable media URL
        self.add({"url": url, "source": source, "kind": kind, "provider": urlsplit(url).hostname, "mimeType": mime, **extra})


def discover_videos(source_url: str, html: str | None, page_is_provider: bool, limit: int = 50) -> list[dict[str, Any]]:
    collector = _Collector(source_url, limit)
    soup = BeautifulSoup(html or "", "html.parser")
    base_tag = soup.find("base", href=True)
    base = urljoin(source_url, base_tag["href"]) if base_tag else source_url

    def meta(*names: str) -> str | None:
        for name in names:
            tag = soup.find("meta", attrs={"property": name}) or soup.find("meta", attrs={"name": name})
            if tag and tag.get("content"):
                return tag["content"].strip()
        return None

    page_title = meta("og:title", "twitter:title") or (soup.title.string.strip() if soup.title and soup.title.string else None)
    page_thumb = _clean_url(meta("og:image", "twitter:image"), base)
    page_desc = meta("og:description", "twitter:description", "description")

    if page_is_provider:
        provider = match_provider(source_url)
        collector.add({
            "url": provider[1] if provider else source_url,
            "source": "provider",
            "kind": "page",
            "provider": provider[0] if provider else urlsplit(source_url).hostname,
            "title": page_title,
            "thumbnail": page_thumb,
            "description": page_desc,
        })

    # JSON-LD VideoObject
    for script in soup.find_all("script", attrs={"type": re.compile(r"ld\+json", re.I)}):
        try:
            data = json.loads(script.string or script.get_text() or "")
        except (ValueError, TypeError):
            continue
        for video in _iter_jsonld(data):
            details = {
                "title": _str(video.get("name")),
                "thumbnail": _clean_url(_str(video.get("thumbnailUrl") or video.get("thumbnail")), base),
                "description": _str(video.get("description")),
                "duration": _str(video.get("duration")),
                "width": _int(video.get("width")),
                "height": _int(video.get("height")),
                "metadata": {k: v for k, v in {"uploadDate": _str(video.get("uploadDate"))}.items() if v},
            }
            if not details["metadata"]:
                details["metadata"] = None
            content = _str(video.get("contentUrl"))
            embed = _str(video.get("embedUrl"))
            if content:
                collector.add_media(content, "metadata", base, mimeType=_str(video.get("encodingFormat")), **details)
            elif embed:
                collector.add_media(embed, "metadata", base, **details)

    # Open Graph / Twitter player
    og_video = meta("og:video:secure_url", "og:video:url", "og:video")
    if og_video:
        collector.add_media(
            og_video, "metadata", base,
            mimeType=meta("og:video:type"),
            title=page_title, thumbnail=page_thumb, description=page_desc,
            width=_int(meta("og:video:width")), height=_int(meta("og:video:height")),
        )
    tw_stream = meta("twitter:player:stream")
    if tw_stream:
        collector.add_media(tw_stream, "metadata", base, mimeType=meta("twitter:player:stream:content_type"), title=page_title, thumbnail=page_thumb)
    tw_player = meta("twitter:player")
    if tw_player:
        collector.add_media(tw_player, "metadata", base, title=page_title, thumbnail=page_thumb,
                            width=_int(meta("twitter:player:width")), height=_int(meta("twitter:player:height")))

    # <video> and <source>
    for video in soup.find_all("video"):
        poster = _clean_url(video.get("poster"), base)
        details = {"thumbnail": poster, "title": video.get("title") or video.get("aria-label"),
                   "width": _int(video.get("width")), "height": _int(video.get("height"))}
        srcs = [(video.get("src") or video.get("data-src"), video.get("type"))]
        srcs += [(s.get("src") or s.get("data-src"), s.get("type")) for s in video.find_all("source")]
        for src, mime in srcs:
            if src:
                collector.add_media(src, "html", base, mimeType=mime, **details)

    # Provider iframes / embeds
    for frame in soup.find_all(["iframe", "embed"]):
        src = _clean_url(frame.get("src") or frame.get("data-src"), base)
        if src and match_provider(src):
            collector.add_media(src, "provider", base, title=frame.get("title"),
                                width=_int(frame.get("width")), height=_int(frame.get("height")))

    # Direct links to video files
    for link in soup.find_all("a", href=True):
        href = _clean_url(link["href"], base)
        if href and _FILE_EXT.search(href):
            collector.add_media(href, "html", base, title=link.get_text(strip=True) or None)

    return collector.items


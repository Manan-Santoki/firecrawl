"""yt-dlp backed operations: download, metadata, resolve."""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from .config import Settings
from .cookies import write_cookie_file
from .errors import ServiceError
from .patterns import normalize_resolve_url
from .runner import YtDlp
from .storage import Storage, StoredFile
from .transcripts import choose_transcript, subtitle_lang_selector

_IGNORED_SUFFIXES = {".part", ".ytdl", ".json", ".temp", ".txt"}


class Limiter:
    """Bounded concurrency with a bounded wait; overflow becomes HTTP 503."""

    def __init__(self, limit: int, queue_timeout: float):
        self._sem = asyncio.Semaphore(limit)
        self.limit = limit
        self.queue_timeout = queue_timeout
        self.active = 0

    @contextlib.asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        try:
            await asyncio.wait_for(self._sem.acquire(), timeout=self.queue_timeout or 0.001)
        except asyncio.TimeoutError as exc:
            raise ServiceError(503, "Media service is at capacity; retry later") from exc
        self.active += 1
        try:
            yield
        finally:
            self.active -= 1
            self._sem.release()


def _iso_date(yyyymmdd: Any) -> str | None:
    if isinstance(yyyymmdd, str) and re.fullmatch(r"\d{8}", yyyymmdd):
        return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:]}"
    return None


def _iso_ts(ts: Any) -> str | None:
    if isinstance(ts, (int, float)) and ts > 0:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return None


def format_duration(seconds: Any) -> str | None:
    if not isinstance(seconds, (int, float)) or seconds < 0:
        return None
    total = int(round(seconds))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def best_thumbnail(info: dict[str, Any]) -> dict[str, Any] | None:
    thumbs = [t for t in (info.get("thumbnails") or []) if isinstance(t, dict) and isinstance(t.get("url"), str)]
    sized = [t for t in thumbs if isinstance(t.get("width"), int) and isinstance(t.get("height"), int)]
    if sized:
        best = max(sized, key=lambda t: (t["width"] * t["height"], t.get("preference") or 0))
        return {"url": best["url"], "width": best["width"], "height": best["height"]}
    if isinstance(info.get("thumbnail"), str):
        return {"url": info["thumbnail"], "width": None, "height": None}
    if thumbs:
        return {"url": thumbs[-1]["url"], "width": None, "height": None}
    return None


def build_metadata(info: dict[str, Any], transcript: str | None) -> dict[str, Any]:
    thumbnail = best_thumbnail(info)
    if thumbnail is None:
        vid = info.get("id")
        thumbnail = {
            "url": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if info.get("extractor_key", "").startswith("Youtube") and vid else "",
            "width": None,
            "height": None,
        }
    categories = info.get("categories") or []
    published = _iso_ts(info.get("release_timestamp")) or _iso_date(info.get("release_date")) or _iso_ts(info.get("timestamp"))
    return {
        "thumbnail_image": thumbnail,
        "title": info.get("title") or info.get("fulltitle") or "",
        "visibility": info.get("availability"),
        "uploaded_by": {
            "name": info.get("channel") or info.get("uploader"),
            "url": info.get("channel_url") or info.get("uploader_url"),
        },
        "uploaded_at": _iso_date(info.get("upload_date")) or _iso_ts(info.get("timestamp")),
        "published_at": published,
        "length": format_duration(info.get("duration")) or info.get("duration_string"),
        "views": info.get("view_count"),
        "likes": info.get("like_count"),
        "category": categories[0] if categories else None,
        "description": info.get("description"),
        "transcript": transcript,
        # Community extensions (ignored by the Firecrawl API):
        "id": info.get("id"),
        "duration_seconds": info.get("duration"),
        "extractor": info.get("extractor_key"),
        "webpage_url": info.get("webpage_url"),
    }


def _post_type(entry: dict[str, Any]) -> str:
    url = str(entry.get("url") or "")
    if "/shorts/" in url:
        return "short"
    if entry.get("live_status") in {"is_live", "was_live", "is_upcoming", "post_live"}:
        return "live"
    return "video"


def build_resolve(info: dict[str, Any], limit: int) -> dict[str, Any]:
    entries = info.get("entries") or []
    posts = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = entry.get("webpage_url") or entry.get("url")
        if not isinstance(url, str) or not url:
            continue
        if entry.get("ie_key") == "Youtube" and entry.get("id") and not url.startswith("http"):
            url = f"https://www.youtube.com/watch?v={entry['id']}"
        thumb = best_thumbnail(entry)
        posts.append(
            {
                "url": url,
                "title": entry.get("title") or "",
                "date": _iso_date(entry.get("upload_date")) or _iso_ts(entry.get("timestamp")) or "",
                "type": _post_type(entry),
                "media": [thumb["url"]] if thumb else [],
            }
        )
        if len(posts) >= limit:
            break
    return {
        "username": info.get("channel") or info.get("uploader") or info.get("uploader_id") or info.get("title") or "",
        "posts": posts,
    }


class MediaService:
    def __init__(self, settings: Settings, storage: Storage, ytdlp: YtDlp):
        self.settings = settings
        self.storage = storage
        self.ytdlp = ytdlp
        self.limiter = Limiter(settings.max_concurrency, settings.queue_timeout_seconds)

    @contextlib.contextmanager
    def workspace(self):
        self.settings.work_dir.mkdir(parents=True, exist_ok=True)
        path = Path(tempfile.mkdtemp(prefix="job-", dir=self.settings.work_dir))
        try:
            yield path
        finally:
            shutil.rmtree(path, ignore_errors=True)

    def _check_single(self, info: dict[str, Any]) -> None:
        if info.get("_type") in {"playlist", "multi_video"} or info.get("entries"):
            raise ServiceError(400, "URL refers to a playlist or collection, not a single media item")
        if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
            raise ServiceError(400, "Live and upcoming streams are not supported")
        duration = info.get("duration")
        if isinstance(duration, (int, float)) and duration > self.settings.max_duration_seconds:
            raise ServiceError(
                413,
                f"Media duration {int(duration)}s exceeds the limit of {self.settings.max_duration_seconds}s",
            )

    async def download(self, url: str, cookies: list[dict[str, Any]] | None, kind: str) -> tuple[StoredFile, dict[str, Any]]:
        async with self.limiter.slot():
            with self.workspace() as work:
                cookie_file = write_cookie_file(cookies, work / "cookies.txt")
                timeout = float(self.settings.download_timeout_seconds)
                loop = asyncio.get_running_loop()
                started = loop.time()
                info = await self.ytdlp.info(url, timeout, work, cookie_file)
                self._check_single(info)
                info_path = work / "source.info.json"
                info_path.write_text(json.dumps(info))
                limit = self.settings.max_filesize_bytes
                args = self.ytdlp.base_args(cookie_file) + [
                    "--load-info-json", str(info_path),
                    "--paths", str(work),
                    "-o", "media.%(ext)s",
                    "--max-filesize", str(limit),
                    "--no-mtime",
                    "--no-write-info-json",
                ]
                if kind == "audio":
                    args += ["-f", "ba/b", "-x", "--audio-format", self.settings.audio_format, "--audio-quality", "5"]
                else:
                    args += [
                        "-f", f"bv*[filesize<?{limit}]+ba/b[filesize<?{limit}]/bv*+ba/b",
                        "-S", f"res:{self.settings.video_max_height},ext:mp4:m4a",
                        "--merge-output-format", "mp4",
                    ]
                remaining = max(5.0, timeout - (loop.time() - started))
                result = await self.ytdlp.run(args, remaining, work, "download")
                output = self._find_output(work)
                if output is None:
                    combined = result.stdout + result.stderr
                    if "max-filesize" in combined or "larger than" in combined:
                        raise ServiceError(413, f"Media exceeds the maximum file size of {self.settings.max_filesize_mb} MB")
                    raise ServiceError(502, "Download produced no media file")
                if output.stat().st_size > limit:
                    raise ServiceError(413, f"Media exceeds the maximum file size of {self.settings.max_filesize_mb} MB")
                if output.stat().st_size == 0:
                    raise ServiceError(502, "Download produced an empty media file")
                stored = await asyncio.to_thread(self.storage.store, output, info.get("title"))
                return stored, info

    @staticmethod
    def _find_output(work: Path) -> Path | None:
        candidates = [
            p for p in work.iterdir()
            if p.is_file() and p.name.startswith("media.") and p.suffix not in _IGNORED_SUFFIXES
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda p: p.stat().st_size)

    async def metadata(self, url: str, lang: str, cookies: list[dict[str, Any]] | None) -> dict[str, Any]:
        async with self.limiter.slot():
            with self.workspace() as work:
                cookie_file = write_cookie_file(cookies, work / "cookies.txt")
                extra = [
                    "--no-simulate",
                    "--skip-download",
                    "--write-subs",
                    "--write-auto-subs",
                    "--sub-langs", subtitle_lang_selector(lang),
                    "--sub-format", "json3/vtt/srt/best",
                    "--paths", str(work),
                    "-o", "subs.%(ext)s",
                    "--ignore-no-formats-error",
                    # A failed caption download must not fail the metadata call.
                    "--ignore-errors",
                ]
                info = await self.ytdlp.info(
                    url, float(self.settings.metadata_timeout_seconds), work, cookie_file, extra, tolerate_errors=True
                )
                if info.get("_type") in {"playlist", "multi_video"}:
                    raise ServiceError(400, "URL refers to a playlist or collection, not a single media item")
                transcript = choose_transcript(info, lang, work)
                return build_metadata(info, transcript)

    async def resolve(self, url: str, limit: int) -> dict[str, Any]:
        limit = max(1, min(limit, self.settings.max_resolve_items))
        async with self.limiter.slot():
            with self.workspace() as work:
                args = self.ytdlp.base_args(None, playlist=True) + [
                    "--dump-single-json",
                    "--flat-playlist",
                    "--playlist-end", str(limit),
                    "--", normalize_resolve_url(url),
                ]
                result = await self.ytdlp.run(args, float(self.settings.resolve_timeout_seconds), work, "resolve")
                try:
                    info = json.loads(result.stdout)
                except json.JSONDecodeError as exc:
                    raise ServiceError(502, "Resolve failed: extractor returned invalid JSON") from exc
                return build_resolve(info, limit)

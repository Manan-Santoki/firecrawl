"""Runtime configuration read from environment variables.

Every knob has a conservative default so the service is safe to start with no
configuration on a private Compose network.
"""

from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("avgrab")


def _int(name: str, default: int, minimum: int = 0) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {value}")
    return value


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _str(name: str, default: str | None = None) -> str | None:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip()


@dataclass(frozen=True)
class Settings:
    # Authentication. Upstream Firecrawl sends no auth header to avgrab, so the
    # key may also be supplied as a path prefix: AVGRAB_SERVICE_URL=http://host/k/<key>
    api_key: str | None = None
    # Base URL clients use to fetch produced media files.
    public_url: str = "http://localhost:8080"
    signing_key: bytes = field(default_factory=lambda: secrets.token_bytes(32))
    signing_key_is_ephemeral: bool = True
    data_dir: Path = Path("/data")
    file_ttl_seconds: int = 3600
    max_concurrency: int = 2
    queue_timeout_seconds: int = 30
    max_filesize_mb: int = 200
    max_duration_seconds: int = 3 * 60 * 60
    download_timeout_seconds: int = 220
    metadata_timeout_seconds: int = 40
    resolve_timeout_seconds: int = 270
    max_resolve_items: int = 1000
    max_html_bytes: int = 5 * 1024 * 1024
    max_videos: int = 50
    allow_private_networks: bool = False
    supported_regex: str | None = None
    resolve_regex: str | None = None
    resolve_enabled: bool = True
    audio_format: str = "mp3"
    video_max_height: int = 1080
    ytdlp_binary: str = "yt-dlp"
    ytdlp_extra_args: tuple[str, ...] = ()
    # Optional S3-compatible object storage (AWS S3, MinIO, R2, GCS interop...).
    s3_bucket: str | None = None
    s3_endpoint_url: str | None = None
    s3_region: str | None = None
    s3_prefix: str = "avgrab/"

    @property
    def max_filesize_bytes(self) -> int:
        return self.max_filesize_mb * 1024 * 1024

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def work_dir(self) -> Path:
        return self.data_dir / "work"


def load_settings() -> Settings:
    signing = _str("AVGRAB_SIGNING_KEY")
    api_key = _str("AVGRAB_API_KEY")
    if api_key is not None and not all(c.isalnum() or c in "-_.~" for c in api_key):
        raise ValueError(
            "AVGRAB_API_KEY must contain only URL-safe characters (A-Z a-z 0-9 - _ . ~)"
        )
    extra = _str("AVGRAB_YTDLP_EXTRA_ARGS")
    settings = Settings(
        api_key=api_key,
        public_url=(_str("AVGRAB_PUBLIC_URL", "http://localhost:8080") or "").rstrip("/"),
        signing_key=signing.encode() if signing else secrets.token_bytes(32),
        signing_key_is_ephemeral=signing is None,
        data_dir=Path(_str("AVGRAB_DATA_DIR", "/data") or "/data"),
        file_ttl_seconds=_int("AVGRAB_FILE_TTL_SECONDS", 3600, 60),
        max_concurrency=_int("AVGRAB_MAX_CONCURRENCY", 2, 1),
        queue_timeout_seconds=_int("AVGRAB_QUEUE_TIMEOUT_SECONDS", 30, 0),
        max_filesize_mb=_int("AVGRAB_MAX_FILESIZE_MB", 200, 1),
        max_duration_seconds=_int("AVGRAB_MAX_DURATION_SECONDS", 3 * 60 * 60, 1),
        download_timeout_seconds=_int("AVGRAB_DOWNLOAD_TIMEOUT_SECONDS", 220, 5),
        metadata_timeout_seconds=_int("AVGRAB_METADATA_TIMEOUT_SECONDS", 40, 5),
        resolve_timeout_seconds=_int("AVGRAB_RESOLVE_TIMEOUT_SECONDS", 270, 5),
        max_resolve_items=_int("AVGRAB_MAX_RESOLVE_ITEMS", 1000, 1),
        max_html_bytes=_int("AVGRAB_MAX_HTML_BYTES", 5 * 1024 * 1024, 1024),
        max_videos=_int("AVGRAB_MAX_VIDEOS", 50, 1),
        allow_private_networks=_bool("AVGRAB_ALLOW_PRIVATE_NETWORKS", False),
        supported_regex=_str("AVGRAB_SUPPORTED_REGEX"),
        resolve_regex=_str("AVGRAB_RESOLVE_REGEX"),
        resolve_enabled=_bool("AVGRAB_RESOLVE_ENABLED", True),
        audio_format=_str("AVGRAB_AUDIO_FORMAT", "mp3") or "mp3",
        video_max_height=_int("AVGRAB_VIDEO_MAX_HEIGHT", 1080, 144),
        ytdlp_binary=_str("AVGRAB_YTDLP_BINARY", "yt-dlp") or "yt-dlp",
        ytdlp_extra_args=tuple(extra.split()) if extra else (),
        s3_bucket=_str("AVGRAB_S3_BUCKET"),
        s3_endpoint_url=_str("AVGRAB_S3_ENDPOINT_URL"),
        s3_region=_str("AVGRAB_S3_REGION"),
        s3_prefix=_str("AVGRAB_S3_PREFIX", "avgrab/") or "",
    )
    if settings.audio_format not in {"mp3", "m4a", "opus", "wav", "flac", "aac", "vorbis"}:
        raise ValueError(f"Unsupported AVGRAB_AUDIO_FORMAT {settings.audio_format!r}")
    if settings.signing_key_is_ephemeral and settings.s3_bucket is None:
        logger.warning(
            "AVGRAB_SIGNING_KEY is unset; file links will be invalidated on restart"
        )
    return settings

"""Delivery of produced media files.

Two provider-neutral backends:

* local (default): files live on the service volume and are served by this
  service at ``GET /files/{id}/{name}?expires=..&sig=..`` with an HMAC-signed,
  expiring URL rooted at ``AVGRAB_PUBLIC_URL``. A janitor deletes them after
  ``AVGRAB_FILE_TTL_SECONDS``.
* s3: any S3-compatible object store (AWS S3, MinIO, Cloudflare R2, Backblaze,
  GCS interoperability). The file is uploaded and a presigned GET URL valid
  for ``AVGRAB_FILE_TTL_SECONDS`` is returned. Object expiry is the bucket
  lifecycle policy's responsibility.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import re
import secrets
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from .config import Settings
from .security import sign

logger = logging.getLogger("avgrab")

FILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/ogg", ".opus")
mimetypes.add_type("audio/flac", ".flac")
mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("video/x-matroska", ".mkv")


@dataclass
class StoredFile:
    public_url: str
    file_id: str
    filename: str
    mime_type: str
    size_bytes: int
    expires_at: int


def safe_filename(title: str | None, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", (title or "media")).strip("-._")[:80] or "media"
    return f"{base}.{ext}"


class Storage:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._s3 = None
        if settings.s3_bucket:
            import boto3  # imported lazily: optional backend

            self._s3 = boto3.client(
                "s3",
                endpoint_url=settings.s3_endpoint_url,
                region_name=settings.s3_region,
            )

    @property
    def backend(self) -> str:
        return "s3" if self._s3 is not None else "local"

    def prepare(self) -> None:
        self.settings.files_dir.mkdir(parents=True, exist_ok=True)
        self.settings.work_dir.mkdir(parents=True, exist_ok=True)
        # Work directories never survive a restart; anything there is debris.
        for child in self.settings.work_dir.iterdir():
            shutil.rmtree(child, ignore_errors=True)

    def store(self, source: Path, title: str | None) -> StoredFile:
        ext = source.suffix.lstrip(".") or "bin"
        filename = safe_filename(title, ext)
        mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        size = source.stat().st_size
        file_id = secrets.token_urlsafe(24)
        expires = int(time.time()) + self.settings.file_ttl_seconds

        if self._s3 is not None:
            key = f"{self.settings.s3_prefix}{file_id}/{filename}"
            self._s3.upload_file(
                str(source),
                self.settings.s3_bucket,
                key,
                ExtraArgs={
                    "ContentType": mime_type,
                    "ContentDisposition": f"attachment; filename=\"{filename}\"",
                },
            )
            url = self._s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.settings.s3_bucket, "Key": key},
                ExpiresIn=self.settings.file_ttl_seconds,
            )
            source.unlink(missing_ok=True)
            return StoredFile(url, file_id, filename, mime_type, size, expires)

        target_dir = self.settings.files_dir / file_id
        target_dir.mkdir(parents=True)
        target = target_dir / filename
        shutil.move(str(source), target)
        (target_dir / "meta.json").write_text(
            json.dumps({"filename": filename, "mime_type": mime_type, "expires_at": expires})
        )
        signature = sign(self.settings.signing_key, file_id, expires)
        url = (
            f"{self.settings.public_url}/files/{file_id}/{quote(filename)}"
            f"?expires={expires}&sig={signature}"
        )
        return StoredFile(url, file_id, filename, mime_type, size, expires)

    def lookup(self, file_id: str) -> tuple[Path, dict] | None:
        if not FILE_ID_RE.match(file_id):
            return None
        target_dir = self.settings.files_dir / file_id
        meta_path = target_dir / "meta.json"
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, ValueError):
            return None
        path = target_dir / meta.get("filename", "")
        if not path.is_file():
            return None
        return path, meta

    def sweep(self, now: float | None = None) -> int:
        """Delete expired local files and stale work directories."""
        now = now if now is not None else time.time()
        removed = 0
        if self.settings.files_dir.exists():
            for entry in self.settings.files_dir.iterdir():
                try:
                    meta = json.loads((entry / "meta.json").read_text())
                    expired = meta.get("expires_at", 0) < now
                except (OSError, ValueError):
                    # Missing/corrupt metadata: remove once clearly abandoned.
                    expired = entry.stat().st_mtime < now - self.settings.file_ttl_seconds
                if expired:
                    shutil.rmtree(entry, ignore_errors=True)
                    removed += 1
        if self.settings.work_dir.exists():
            stale_after = 2 * max(
                self.settings.download_timeout_seconds,
                self.settings.resolve_timeout_seconds,
            )
            for entry in self.settings.work_dir.iterdir():
                if entry.stat().st_mtime < now - stale_after:
                    shutil.rmtree(entry, ignore_errors=True)
                    removed += 1
        return removed

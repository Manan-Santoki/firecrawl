from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from avgrab.config import Settings
from avgrab.main import create_app
from avgrab.runner import ProcessResult, YtDlp

SAMPLE_INFO: dict[str, Any] = {
    "id": "abc123def45",
    "title": "Sample clip",
    "extractor_key": "Youtube",
    "webpage_url": "https://www.youtube.com/watch?v=abc123def45",
    "duration": 125,
    "duration_string": "2:05",
    "availability": "public",
    "channel": "Sample Channel",
    "channel_url": "https://www.youtube.com/channel/UC123",
    "upload_date": "20240102",
    "timestamp": 1704153600,
    "view_count": 42,
    "like_count": 7,
    "categories": ["Education"],
    "description": "A description",
    "thumbnails": [
        {"url": "https://i.ytimg.com/small.jpg", "width": 120, "height": 90},
        {"url": "https://i.ytimg.com/large.jpg", "width": 1280, "height": 720},
    ],
}


class FakeYtDlp:
    """Scriptable stand-in for the yt-dlp subprocess."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.info: dict[str, Any] = dict(SAMPLE_INFO)
        self.info_error: str | None = None
        self.download_bytes: bytes = b"ID3" + b"\x00" * 2048
        self.download_ext = "mp3"
        self.download_stdout = ""
        self.subtitles: dict[str, tuple[str, str]] = {}  # key -> (ext, content)
        self.manual: set[str] = set()
        self.playlist: dict[str, Any] | None = None
        self.hook: Callable[[list[str]], None] | None = None

    async def __call__(self, argv, timeout, cwd: Path) -> ProcessResult:
        argv = list(argv)
        self.calls.append(argv)
        if self.hook:
            self.hook(argv)
        if self.info_error:
            return ProcessResult(1, "", f"ERROR: [youtube] abc: {self.info_error}\n")
        if "--load-info-json" in argv:
            target = Path(argv[argv.index("--paths") + 1]) / f"media.{self.download_ext}"
            if self.download_bytes is not None:
                target.write_bytes(self.download_bytes)
            return ProcessResult(0, self.download_stdout, "")
        if "--flat-playlist" in argv:
            return ProcessResult(0, json.dumps(self.playlist or {}), "")
        info = dict(self.info)
        if "--write-subs" in argv:
            work = Path(argv[argv.index("--paths") + 1])
            requested = {}
            for key, (ext, content) in self.subtitles.items():
                path = work / f"subs.{key}.{ext}"
                path.write_text(content, encoding="utf-8")
                requested[key] = {"ext": ext, "filepath": path.name}
            info["requested_subtitles"] = requested or None
            info["subtitles"] = {k: [] for k in self.manual}
        return ProcessResult(0, json.dumps(info), "")


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        public_url="http://media.test",
        signing_key=b"k" * 32,
        signing_key_is_ephemeral=False,
        data_dir=tmp_path / "data",
        allow_private_networks=True,
        max_filesize_mb=1,
        max_duration_seconds=3600,
    )


@pytest.fixture
def fake() -> FakeYtDlp:
    return FakeYtDlp()


@pytest.fixture
def make_client(settings: Settings, fake: FakeYtDlp):
    clients = []

    def _make(**overrides: Any) -> TestClient:
        app = create_app(replace(settings, **overrides), YtDlp("yt-dlp", runner=fake))
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield _make
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()

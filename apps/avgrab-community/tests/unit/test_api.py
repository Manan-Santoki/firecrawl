"""HTTP contract tests using request bodies shaped exactly like the Firecrawl API client.

Request shapes mirror upstream v2.11.739:
  transformers/audio.ts       POST /download        {url, cookies?}
  transformers/video.ts       POST /videos          {url, html?}
                              POST /download-video  {url, cookies?}
  postprocessors/youtube.ts   POST /metadata        {url, transcript_language, cookies?}
  lib/avgrab-resolve.ts       POST /resolve         {url, limit}
  all of the above            GET  /supported-urls
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from urllib.parse import urlsplit

import pytest

YT = "https://www.youtube.com/watch?v=abc123def45"
COOKIES = [
    {
        "name": "VISITOR_INFO1_LIVE",
        "value": "visitor",
        "domain": ".youtube.com",
        "path": "/",
        "secure": True,
        "httpOnly": True,
    }
]


def _local_path(public_url: str) -> str:
    parts = urlsplit(public_url)
    return f"{parts.path}?{parts.query}"


def test_supported_urls_shape(client):
    body = client.get("/supported-urls").json()
    assert isinstance(body["regex"], str) and isinstance(body["resolve_regex"], str)
    assert re.search(body["regex"], YT)
    assert not re.search(body["regex"], "https://example.com/blog/post")
    assert re.search(body["resolve_regex"], "https://www.youtube.com/@blender")
    assert not re.search(body["resolve_regex"], YT)


def test_resolve_can_be_disabled(make_client):
    client = make_client(resolve_enabled=False)
    body = client.get("/supported-urls").json()
    assert body["resolve_regex"] == "(?!)"
    assert client.post("/resolve", json={"url": "https://www.youtube.com/@blender", "limit": 5}).status_code == 400


def test_download_audio_returns_public_url_that_serves_the_file(client, fake):
    res = client.post("/download", json={"url": YT, "cookies": COOKIES})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["public_url"].startswith("http://media.test/files/")
    assert body["mime_type"] == "audio/mpeg"
    assert body["filename"] == "Sample-clip.mp3"
    # cookies were converted into a Netscape jar and passed to every yt-dlp call
    assert all("--cookies" in call for call in fake.calls)
    download_call = next(c for c in fake.calls if "--load-info-json" in c)
    assert "-x" in download_call and "mp3" in download_call
    assert "--max-filesize" in download_call

    served = client.get(_local_path(body["public_url"]))
    assert served.status_code == 200
    assert served.headers["content-type"] == "audio/mpeg"
    assert served.content.startswith(b"ID3")


def test_download_omits_cookie_flag_without_cookies(client, fake):
    assert client.post("/download", json={"url": YT}).status_code == 200
    assert not any("--cookies" in call for call in fake.calls)


def test_work_directory_is_cleaned_up(client, settings):
    assert client.post("/download", json={"url": YT, "cookies": COOKIES}).status_code == 200
    assert list(settings.work_dir.iterdir()) == []


def test_download_video_merges_to_mp4(client, fake):
    fake.download_ext = "mp4"
    res = client.post("/download-video", json={"url": YT})
    assert res.status_code == 200, res.text
    assert res.json()["mime_type"] == "video/mp4"
    call = next(c for c in fake.calls if "--load-info-json" in c)
    assert call[call.index("--merge-output-format") + 1] == "mp4"
    assert "-x" not in call


def test_tampered_or_expired_links_are_rejected(client):
    url = _local_path(client.post("/download", json={"url": YT}).json()["public_url"])
    assert client.get(url.replace("sig=", "sig=0")).status_code == 403
    expired = re.sub(r"expires=\d+", f"expires={int(time.time()) - 10}", url)
    assert client.get(expired).status_code == 403


def test_unsupported_url_returns_string_detail(client):
    res = client.post("/download", json={"url": "https://example.com/blog/post"})
    assert res.status_code == 400
    assert res.json() == {"detail": "Unsupported URL"}


def test_access_denied_returns_structured_detail(client, fake):
    fake.info_error = "Sign in to confirm your age. This video may be inappropriate for some users."
    res = client.post("/download", json={"url": YT})
    assert res.status_code == 403
    detail = res.json()["detail"]
    assert detail["code"] == "age_restricted"
    assert isinstance(detail["message"], str) and detail["message"]


def test_private_video_is_structured(client, fake):
    fake.info_error = "Private video. Sign in if you've been granted access to this video"
    detail = client.post("/download-video", json={"url": YT}).json()["detail"]
    assert detail["code"] == "private"


def test_generic_failure_is_string_detail(client, fake):
    fake.info_error = "Something exploded in the extractor"
    res = client.post("/download", json={"url": YT})
    assert res.status_code == 502
    assert res.json() == {"detail": "Extraction failed: Something exploded in the extractor"}


def test_duration_limit(client, fake):
    fake.info["duration"] = 99999
    res = client.post("/download", json={"url": YT})
    assert res.status_code == 413
    assert isinstance(res.json()["detail"], str)
    assert not any("--load-info-json" in c for c in fake.calls)


def test_filesize_limit_after_download(client, fake, settings):
    fake.download_bytes = b"\x00" * (2 * 1024 * 1024)  # limit is 1 MB in tests
    res = client.post("/download", json={"url": YT})
    assert res.status_code == 413
    assert list(settings.work_dir.iterdir()) == []


def test_filesize_limit_reported_by_ytdlp(client, fake):
    fake.download_bytes = None
    fake.download_stdout = "[download] File is larger than max-filesize (5 bytes > 1 bytes). Aborting."
    assert client.post("/download", json={"url": YT}).status_code == 413


def test_live_streams_rejected(client, fake):
    fake.info["is_live"] = True
    assert client.post("/download", json={"url": YT}).status_code == 400


def test_playlists_rejected_for_download(client, fake):
    fake.info = {"_type": "playlist", "entries": [{"id": "x"}]}
    assert client.post("/download", json={"url": YT}).status_code == 400


def test_timeout_returns_504(client, fake):
    async def slow(argv, timeout, cwd):
        raise asyncio.TimeoutError

    client.app.state.service.ytdlp.runner = slow
    res = client.post("/download", json={"url": YT})
    assert res.status_code == 504
    assert "timed out" in res.json()["detail"]


def test_private_networks_blocked_by_default(make_client):
    client = make_client(allow_private_networks=False)
    res = client.post("/download", json={"url": "http://127.0.0.1/clip.mp3"})
    assert res.status_code == 400
    assert "not publicly routable" in res.json()["detail"]


def test_validation_errors_use_string_detail(client):
    res = client.post("/download", json={"cookies": []})
    assert res.status_code == 400
    assert isinstance(res.json()["detail"], str)


def test_capacity_returns_503(make_client, fake):
    client = make_client(max_concurrency=1, queue_timeout_seconds=0)
    limiter = client.app.state.service.limiter

    async def hold():
        async with limiter.slot():
            async with limiter.slot():
                pass

    with pytest.raises(Exception) as excinfo:
        asyncio.run(hold())
    assert getattr(excinfo.value, "status", None) == 503


def test_metadata_matches_youtube_postprocessor_contract(client, fake):
    fake.subtitles = {
        "en": ("json3", json.dumps({"events": [{"segs": [{"utf8": "Hello"}]}, {"segs": [{"utf8": " world"}]}]})),
    }
    fake.manual = {"en"}
    res = client.post(
        "/metadata",
        json={"url": YT, "transcript_language": "en", "cookies": COOKIES},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # Fields read by apps/api/src/scraper/scrapeURL/postprocessors/youtube.ts
    assert body["title"] == "Sample clip"
    assert body["thumbnail_image"] == {"url": "https://i.ytimg.com/large.jpg", "width": 1280, "height": 720}
    assert body["visibility"] == "public"
    assert body["uploaded_by"] == {"name": "Sample Channel", "url": "https://www.youtube.com/channel/UC123"}
    assert body["uploaded_at"] == "2024-01-02"
    assert body["published_at"] == "2024-01-02T00:00:00Z"
    assert body["length"] == "2:05"
    assert body["views"] == 42
    assert body["likes"] == 7
    assert body["category"] == "Education"
    assert body["description"] == "A description"
    assert body["transcript"] == "Hello\nworld"
    call = fake.calls[0]
    assert call[call.index("--sub-langs") + 1] == "en,en-orig,.*-orig"


def test_metadata_without_captions_has_null_transcript(client):
    body = client.post("/metadata", json={"url": YT, "transcript_language": "de"}).json()
    assert body["transcript"] is None


def test_metadata_rejects_bad_language_codes(client, fake):
    client.post("/metadata", json={"url": YT, "transcript_language": "e$n,.*"})
    call = fake.calls[0]
    assert call[call.index("--sub-langs") + 1].startswith("en,")


def test_resolve_contract(client, fake):
    fake.playlist = {
        "_type": "playlist",
        "channel": "Blender",
        "entries": [
            {"ie_key": "Youtube", "id": "aaaaaaaaaaa", "url": "https://www.youtube.com/watch?v=aaaaaaaaaaa", "title": "One",
             "thumbnails": [{"url": "https://i.ytimg.com/a.jpg", "width": 10, "height": 10}]},
            {"ie_key": "Youtube", "id": "bbbbbbbbbbb", "url": "https://www.youtube.com/shorts/bbbbbbbbbbb", "title": "Two"},
            {"ie_key": "Youtube", "id": "ccccccccccc", "url": "https://www.youtube.com/watch?v=ccccccccccc", "title": "Three"},
        ],
    }
    res = client.post("/resolve", json={"url": "https://www.youtube.com/@blender", "limit": 2})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["username"] == "Blender"
    assert body["posts"] == [
        {"url": "https://www.youtube.com/watch?v=aaaaaaaaaaa", "title": "One", "date": "", "type": "video", "media": ["https://i.ytimg.com/a.jpg"]},
        {"url": "https://www.youtube.com/shorts/bbbbbbbbbbb", "title": "Two", "date": "", "type": "short", "media": []},
    ]
    call = fake.calls[0]
    assert call[-1] == "https://www.youtube.com/@blender/videos"
    assert "--yes-playlist" in call and "--flat-playlist" in call
    assert call[call.index("--playlist-end") + 1] == "2"


def test_resolve_errors_use_string_detail(client, fake):
    fake.info_error = "This channel does not exist."
    res = client.post("/resolve", json={"url": "https://www.youtube.com/@nope", "limit": 5})
    assert res.status_code == 404
    assert isinstance(res.json()["detail"], str)


def test_videos_contract(client):
    html = """
    <html><head>
      <meta property="og:title" content="Product">
      <meta property="og:video" content="https://cdn.example.com/product.mp4">
      <meta property="og:video:type" content="video/mp4">
    </head><body>
      <video poster="/poster.jpg"><source src="/media/clip.webm" type="video/webm"></video>
      <iframe src="https://www.youtube.com/embed/abc123def45"></iframe>
    </body></html>"""
    res = client.post("/videos", json={"url": "https://example.com/product", "html": html})
    assert res.status_code == 200
    videos = res.json()["videos"]
    by_url = {v["url"]: v for v in videos}
    assert by_url["https://cdn.example.com/product.mp4"]["source"] == "metadata"
    assert by_url["https://cdn.example.com/product.mp4"]["kind"] == "file"
    assert by_url["https://example.com/media/clip.webm"]["thumbnail"] == "https://example.com/poster.jpg"
    assert by_url[YT]["source"] == "provider" and by_url[YT]["kind"] == "embed"
    for video in videos:
        assert video["sourceURL"] == "https://example.com/product"
        assert {"url", "sourceURL", "source"} <= video.keys()


def test_videos_without_html_on_provider_page_triggers_legacy_path(client):
    videos = client.post("/videos", json={"url": "https://vimeo.com/76979871"}).json()["videos"]
    assert videos == [
        {"url": "https://vimeo.com/76979871", "source": "provider", "kind": "page", "provider": "vimeo",
         "sourceURL": "https://vimeo.com/76979871"}
    ]


def test_videos_without_html_on_plain_page_is_empty(client):
    assert client.post("/videos", json={"url": "https://example.com/"}).json() == {"videos": []}


class TestAuth:
    def test_open_when_no_key(self, client):
        assert client.get("/supported-urls").status_code == 200

    def test_rejects_without_key(self, make_client):
        client = make_client(api_key="s3cret-key")
        res = client.get("/supported-urls")
        assert res.status_code == 401
        assert res.json() == {"detail": "Unauthorized"}

    def test_path_prefix_key_matches_upstream_url_concatenation(self, make_client):
        # The API builds `${AVGRAB_SERVICE_URL}/supported-urls` with no headers.
        client = make_client(api_key="s3cret-key")
        assert client.get("/k/s3cret-key/supported-urls").status_code == 200
        assert client.get("/k/wrong/supported-urls").status_code == 401
        res = client.post("/k/s3cret-key/download", json={"url": YT})
        assert res.status_code == 200
        # The signed file link must work without the key.
        assert client.get(_local_path(res.json()["public_url"])).status_code == 200

    def test_header_key(self, make_client):
        client = make_client(api_key="s3cret-key")
        assert client.get("/supported-urls", headers={"Authorization": "Bearer s3cret-key"}).status_code == 200
        assert client.get("/supported-urls", headers={"X-API-Key": "s3cret-key"}).status_code == 200
        assert client.get("/supported-urls", headers={"X-API-Key": "nope"}).status_code == 401

    def test_health_is_public(self, make_client):
        assert make_client(api_key="s3cret-key").get("/health").status_code == 200

"""Black-box contract tests against a running avgrab-community container.

Run through scripts/contract.sh, which builds the image, starts the service on
a private Docker network next to a fixture server, and exports:

  AVGRAB_CONTRACT_URL   service base URL exactly as Firecrawl would use it
                        as AVGRAB_SERVICE_URL (including the /k/<key> prefix)
  AVGRAB_FIXTURE_BASE   fixture server base URL as seen from the service
  AVGRAB_LIVE_TESTS=1   optionally also exercise a real public YouTube video

Request bodies are byte-for-byte what the upstream API client sends
(JSON.stringify of the objects built in transformers/audio.ts, video.ts,
postprocessors/youtube.ts and lib/avgrab-resolve.ts).
"""

from __future__ import annotations

import json
import os
import re
from urllib.parse import urlsplit, urlunsplit

import httpx
import pytest

BASE = os.environ.get("AVGRAB_CONTRACT_URL")
FIXTURES = os.environ.get("AVGRAB_FIXTURE_BASE", "http://avgrab-fixture:8000")
LIVE = os.environ.get("AVGRAB_LIVE_TESTS") == "1"
# Creative Commons (CC BY 3.0) Big Buck Bunny upload by the Blender Foundation.
LIVE_VIDEO = os.environ.get("AVGRAB_LIVE_VIDEO", "https://www.youtube.com/watch?v=aqz-KE-bpKQ")

pytestmark = pytest.mark.skipif(not BASE, reason="AVGRAB_CONTRACT_URL not set")


def post(path: str, payload: dict, timeout: float = 240) -> httpx.Response:
    # Mirror the API: fetch(`${AVGRAB_SERVICE_URL}${path}`, {method: "POST",
    # headers: {"Content-Type": "application/json"}, body: JSON.stringify(...)})
    return httpx.post(
        f"{BASE}{path}",
        content=json.dumps(payload, separators=(",", ":")),
        headers={"Content-Type": "application/json"},
        timeout=timeout,
    )


def reachable(public_url: str) -> str:
    """The service advertises AVGRAB_PUBLIC_URL; rewrite onto the published port."""
    base = urlsplit(BASE)
    target = urlsplit(public_url)
    return urlunsplit((base.scheme, base.netloc, target.path, target.query, ""))


def test_unauthenticated_requests_are_rejected():
    base = urlsplit(BASE)
    unauth = urlunsplit((base.scheme, base.netloc, "/supported-urls", "", ""))
    assert httpx.get(unauth).status_code == 401


def test_supported_urls_regexes_are_usable():
    res = httpx.get(f"{BASE}/supported-urls")
    assert res.status_code == 200
    data = res.json()
    regex = re.compile(data["regex"])
    assert regex.search("https://www.youtube.com/watch?v=aqz-KE-bpKQ")
    assert regex.search(f"{FIXTURES}/tone.mp3")
    assert not regex.search("https://example.com/about")
    assert isinstance(data["resolve_regex"], str)


def test_audio_download_happy_path():
    res = post("/download", {"url": f"{FIXTURES}/tone.mp3"})
    assert res.status_code == 200, res.text
    public_url = res.json()["public_url"]
    assert isinstance(public_url, str)
    media = httpx.get(reachable(public_url), timeout=30)
    assert media.status_code == 200
    assert media.headers["content-type"] == "audio/mpeg"
    assert len(media.content) > 1000
    assert media.content[:3] == b"ID3" or media.content[0] == 0xFF
    # Range requests let players seek.
    partial = httpx.get(reachable(public_url), headers={"Range": "bytes=0-99"}, timeout=30)
    assert partial.status_code == 206 and len(partial.content) == 100


def test_audio_extracted_from_video_file():
    res = post("/download", {"url": f"{FIXTURES}/clip.mp4"})
    assert res.status_code == 200, res.text
    assert res.json()["mime_type"] == "audio/mpeg"


def test_video_download_happy_path():
    res = post("/download-video", {"url": f"{FIXTURES}/clip.mp4"})
    assert res.status_code == 200, res.text
    body = res.json()
    media = httpx.get(reachable(body["public_url"]), timeout=30)
    assert media.status_code == 200
    assert media.headers["content-type"] == "video/mp4"
    assert media.content[4:8] == b"ftyp"


def test_tampered_link_is_forbidden():
    res = post("/download", {"url": f"{FIXTURES}/tone.mp3"})
    url = reachable(res.json()["public_url"]).replace("sig=", "sig=00")
    assert httpx.get(url).status_code == 403


def test_missing_media_is_a_failure():
    res = post("/download", {"url": f"{FIXTURES}/missing.mp3"})
    assert res.status_code in {404, 502}
    detail = res.json()["detail"]
    assert detail  # string for internal failures, {code,message} for denials


def test_unsupported_url_fails_cleanly():
    res = post("/download", {"url": "https://example.com/about"})
    assert res.status_code == 400
    assert res.json() == {"detail": "Unsupported URL"}


def test_oversized_media_is_rejected():
    # The contract stack runs with AVGRAB_MAX_FILESIZE_MB=1; big.mp4 is ~3 MB.
    res = post("/download-video", {"url": f"{FIXTURES}/big.mp4"})
    assert res.status_code == 413, res.text
    assert isinstance(res.json()["detail"], str)


def test_cookies_are_accepted():
    cookies = [{"name": "session", "value": "abc", "domain": "avgrab-fixture", "path": "/", "secure": False, "httpOnly": True, "expires": -1, "sameSite": "Lax"}]
    res = post("/download", {"url": f"{FIXTURES}/tone.mp3", "cookies": cookies})
    assert res.status_code == 200, res.text


def test_generic_video_discovery():
    html = (
        '<html><head><meta property="og:video" content="https://cdn.example.com/a.mp4"></head>'
        '<body><iframe src="https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ"></iframe></body></html>'
    )
    res = post("/videos", {"url": "https://example.com/product", "html": html})
    assert res.status_code == 200
    urls = {v["url"] for v in res.json()["videos"]}
    assert urls == {"https://cdn.example.com/a.mp4", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"}


def test_metadata_on_non_media_page_fails_cleanly():
    res = post("/metadata", {"url": f"{FIXTURES}/missing.mp4", "transcript_language": "en"})
    assert res.status_code >= 400
    assert "detail" in res.json()


def test_resolve_rejects_non_collection_urls():
    res = post("/resolve", {"url": "https://example.com/", "limit": 10})
    assert res.status_code == 400
    assert isinstance(res.json()["detail"], str)


@pytest.mark.skipif(not LIVE, reason="AVGRAB_LIVE_TESTS != 1")
def test_live_youtube_metadata():
    res = post("/metadata", {"url": LIVE_VIDEO, "transcript_language": "en"}, timeout=60)
    assert res.status_code == 200, res.text
    data = res.json()
    assert "Big Buck Bunny" in data["title"]
    assert data["thumbnail_image"]["url"].startswith("https://")
    assert data["uploaded_by"]["name"]


@pytest.mark.skipif(not LIVE, reason="AVGRAB_LIVE_TESTS != 1")
def test_live_youtube_resolve():
    res = post("/resolve", {"url": "https://www.youtube.com/@BlenderOfficial", "limit": 3}, timeout=120)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["username"]
    assert 1 <= len(data["posts"]) <= 3
    assert all(p["url"].startswith("https://www.youtube.com/") for p in data["posts"])

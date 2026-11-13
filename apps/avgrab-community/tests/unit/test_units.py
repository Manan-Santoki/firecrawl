from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from dataclasses import replace
from pathlib import Path

import pytest

from avgrab.cookies import write_cookie_file
from avgrab.errors import classify_ytdlp_failure
from avgrab.patterns import (
    DEFAULT_RESOLVE_REGEX,
    DEFAULT_SUPPORTED_REGEX,
    NEVER_MATCH,
    assert_js_compatible,
    normalize_resolve_url,
)
from avgrab.security import sign, verify
from avgrab.storage import Storage
from avgrab.transcripts import choose_transcript, parse_json3, parse_vtt
from avgrab.videos import discover_videos

SUPPORTED = [
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://youtu.be/jNQXAC9IVRw",
    "https://m.youtube.com/watch?v=jNQXAC9IVRw",
    "https://vimeo.com/76979871",
    "https://soundcloud.com/artist/track",
    "https://archive.org/details/BigBuckBunny_124",
    "https://cdn.example.com/podcast/episode.mp3",
    "https://cdn.example.com/video.mp4?token=abc",
    "http://fixture:8000/tone.m4a",
]
UNSUPPORTED = [
    "https://example.com/",
    "https://example.com/blog/post.html",
    "https://notyoutube.com.evil.example/watch",
    "https://evilyoutube.com/watch?v=x",
    "ftp://cdn.example.com/a.mp3",
]


@pytest.mark.parametrize("url", SUPPORTED)
def test_supported_regex_matches(url):
    assert re.search(DEFAULT_SUPPORTED_REGEX, url)


@pytest.mark.parametrize("url", UNSUPPORTED)
def test_supported_regex_rejects(url):
    assert not re.search(DEFAULT_SUPPORTED_REGEX, url)


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://www.youtube.com/@blender", True),
        ("https://www.youtube.com/@blender/videos", True),
        ("https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg", True),
        ("https://www.youtube.com/playlist?list=PL123", True),
        ("https://www.youtube.com/watch?v=jNQXAC9IVRw", False),
        ("https://www.youtube.com/@blender/about", False),
        ("https://vimeo.com/76979871", False),
    ],
)
def test_resolve_regex(url, expected):
    assert bool(re.search(DEFAULT_RESOLVE_REGEX, url)) is expected


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_patterns_are_valid_javascript_regexes():
    """The Firecrawl API compiles these with `new RegExp(pattern)`; behaviour must match Python."""
    cases = {p: SUPPORTED + UNSUPPORTED for p in (DEFAULT_SUPPORTED_REGEX, DEFAULT_RESOLVE_REGEX, NEVER_MATCH)}
    script = (
        "const cases = JSON.parse(process.argv[1]);"
        "const out = {};"
        "for (const [p, urls] of Object.entries(cases)) { const r = new RegExp(p); out[p] = urls.map(u => r.test(u)); }"
        "console.log(JSON.stringify(out));"
    )
    result = subprocess.run(["node", "-e", script, json.dumps(cases)], capture_output=True, text=True, check=True)
    js = json.loads(result.stdout)
    for pattern, urls in cases.items():
        assert js[pattern] == [bool(re.search(pattern, u)) for u in urls], pattern


def test_python_only_syntax_rejected():
    with pytest.raises(ValueError):
        assert_js_compatible(r"(?P<id>\d+)")
    with pytest.raises(ValueError):
        assert_js_compatible(r"(?i)youtube")


def test_normalize_resolve_url():
    assert normalize_resolve_url("https://www.youtube.com/@blender") == "https://www.youtube.com/@blender/videos"
    assert normalize_resolve_url("https://www.youtube.com/@blender/shorts") == "https://www.youtube.com/@blender/shorts"
    assert normalize_resolve_url("https://www.youtube.com/playlist?list=PL1") == "https://www.youtube.com/playlist?list=PL1"


@pytest.mark.parametrize(
    "stderr,status,code",
    [
        ("ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser", 403, "bot_check"),
        ("ERROR: [youtube] x: Private video. Sign in if you've been granted access", 403, "private"),
        ("ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader", 404, "not_found"),
        ("ERROR: [youtube] x: The uploader has not made this video available in your country", 403, "geo_restricted"),
        ("ERROR: [youtube] x: Join this channel to get access to members-only content", 403, "paywalled"),
    ],
)
def test_access_classification(stderr, status, code):
    err = classify_ytdlp_failure(stderr)
    assert err.status == status
    assert err.detail["code"] == code


def test_unsupported_and_generic_classification():
    assert classify_ytdlp_failure("ERROR: Unsupported URL: https://x").detail == "Unsupported URL"
    err = classify_ytdlp_failure("WARNING: foo\nERROR: [generic] x: Connection reset by peer")
    assert err.status == 502 and err.detail == "Extraction failed: Connection reset by peer"


def test_cookie_file(tmp_path: Path):
    path = write_cookie_file(
        [
            {"name": "a", "value": "1", "domain": ".youtube.com", "path": "/", "secure": True, "httpOnly": True, "expires": -1},
            {"name": "b", "value": "x\ty", "domain": "www.example.com", "expires": 1900000000.5},
            {"name": "", "value": "skip", "domain": "x"},
            {"name": "nodomain", "value": "skip"},
            "garbage",
        ],
        tmp_path / "c.txt",
    )
    lines = path.read_text().splitlines()
    assert lines[0] == "# Netscape HTTP Cookie File"
    assert lines[1] == "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\ta\t1"
    assert lines[2] == "www.example.com\tFALSE\t/\tFALSE\t1900000000\tb\tx y"
    assert len(lines) == 3
    assert write_cookie_file([], tmp_path / "d.txt") is None
    assert write_cookie_file(None, tmp_path / "e.txt") is None


def test_parse_json3_dedupes_rolling_captions():
    data = {"events": [
        {"segs": [{"utf8": "hello"}]},
        {"segs": [{"utf8": "\n"}]},
        {"segs": [{"utf8": "hello"}, {"utf8": " there"}]},
        {"tStartMs": 1},
        {"segs": [{"utf8": "general\nkenobi"}]},
    ]}
    assert parse_json3(json.dumps(data)) == "hello there\ngeneral kenobi"


def test_parse_vtt():
    vtt = """WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:01.000 align:start
<c>Hello</c> &amp; welcome

00:00:01.000 --> 00:00:02.000
Hello &amp; welcome

2
00:00:02.000 --> 00:00:03.000
Next line
"""
    assert parse_vtt(vtt) == "Hello & welcome\nNext line"


def test_choose_transcript_prefers_manual_then_orig(tmp_path: Path):
    (tmp_path / "s.en.vtt").write_text("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nmanual\n")
    (tmp_path / "s.en-orig.vtt").write_text("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nauto\n")
    (tmp_path / "s.de-orig.vtt").write_text("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhallo\n")
    info = {
        "subtitles": {"en": []},
        "requested_subtitles": {
            "de-orig": {"filepath": "s.de-orig.vtt"},
            "en-orig": {"filepath": "s.en-orig.vtt"},
            "en": {"filepath": "s.en.vtt"},
        },
    }
    assert choose_transcript(info, "en", tmp_path) == "manual"
    info["subtitles"] = {}
    del info["requested_subtitles"]["en"]
    assert choose_transcript(info, "en", tmp_path) == "auto"
    assert choose_transcript(info, "fr", tmp_path) == "hallo"
    # Paths escaping the work directory are ignored.
    info["requested_subtitles"] = {"en": {"filepath": "../../etc/passwd"}}
    assert choose_transcript(info, "en", tmp_path) is None


def test_discover_jsonld_and_dedupe():
    html = """
    <script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[{"@type":"VideoObject","name":"Demo","contentUrl":"https://cdn.example.com/demo.mp4",
     "thumbnailUrl":["https://cdn.example.com/t.jpg"],"duration":"PT1M30S","uploadDate":"2024-01-01","description":"d"}]}
    </script>
    <script type="application/ld+json">not json</script>
    <video src="https://cdn.example.com/demo.mp4" width="640" height="360"></video>
    <video src="blob:https://example.com/123"></video>
    <video><source src="https://cdn.example.com/live/index.m3u8"></video>
    <iframe src="https://player.vimeo.com/video/76979871?h=abc"></iframe>
    <iframe src="https://ads.example.com/frame"></iframe>
    <a href="/downloads/raw.mov">Raw</a>
    """
    videos = discover_videos("https://example.com/page", html, page_is_provider=False)
    by_url = {v["url"]: v for v in videos}
    demo = by_url["https://cdn.example.com/demo.mp4"]
    assert demo["source"] == "metadata" and demo["kind"] == "file" and demo["title"] == "Demo"
    assert demo["duration"] == "PT1M30S" and demo["thumbnail"] == "https://cdn.example.com/t.jpg"
    assert demo["width"] == 640 and demo["metadata"] == {"uploadDate": "2024-01-01"}
    assert demo["mimeType"] == "video/mp4"
    assert by_url["https://cdn.example.com/live/index.m3u8"]["kind"] == "stream"
    vimeo = by_url["https://vimeo.com/76979871"]
    assert vimeo["provider"] == "vimeo" and vimeo["kind"] == "embed"
    assert by_url["https://example.com/downloads/raw.mov"]["title"] == "Raw"
    assert len(videos) == 4


def test_discover_limit():
    html = "".join(f'<video src="https://cdn.example.com/{i}.mp4"></video>' for i in range(100))
    assert len(discover_videos("https://example.com/", html, False, limit=5)) == 5


def test_format_duration():
    from avgrab.media import format_duration

    assert format_duration(19) == "0:19"
    assert format_duration(3725.4) == "1:02:05"
    assert format_duration(None) is None


def test_signing():
    expires = int(time.time()) + 60
    sig = sign(b"key", "fileid", expires)
    assert verify(b"key", "fileid", expires, sig)
    assert not verify(b"other", "fileid", expires, sig)
    assert not verify(b"key", "fileid2", expires, sig)
    assert not verify(b"key", "fileid", expires, sig, now=expires + 1)


def test_local_storage_store_lookup_sweep(settings, tmp_path: Path):
    storage = Storage(settings)
    storage.prepare()
    src = tmp_path / "media.mp3"
    src.write_bytes(b"abc")
    stored = storage.store(src, "My / Title?")
    assert stored.filename == "My-Title.mp3"
    assert not src.exists()
    path, meta = storage.lookup(stored.file_id)
    assert path.read_bytes() == b"abc" and meta["mime_type"] == "audio/mpeg"
    assert storage.lookup("../../etc") is None
    assert storage.sweep(now=time.time()) == 0
    assert storage.sweep(now=time.time() + settings.file_ttl_seconds + 1) == 1
    assert storage.lookup(stored.file_id) is None


def test_prepare_removes_stale_work(settings):
    settings.work_dir.mkdir(parents=True)
    (settings.work_dir / "job-old").mkdir()
    Storage(settings).prepare()
    assert list(settings.work_dir.iterdir()) == []


def test_s3_storage_presigns(settings, tmp_path: Path, monkeypatch):
    moto = pytest.importorskip("moto")
    import boto3

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    with moto.mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="media")
        storage = Storage(replace(settings, s3_bucket="media", s3_region="us-east-1"))
        assert storage.backend == "s3"
        src = tmp_path / "media.mp4"
        src.write_bytes(b"video")
        stored = storage.store(src, "clip")
        assert "X-Amz-Signature=" in stored.public_url or "Signature=" in stored.public_url
        assert "media" in stored.public_url and stored.filename == "clip.mp4"
        obj = boto3.client("s3", region_name="us-east-1").get_object(Bucket="media", Key=f"avgrab/{stored.file_id}/clip.mp4")
        assert obj["Body"].read() == b"video" and obj["ContentType"] == "video/mp4"
        assert not src.exists()

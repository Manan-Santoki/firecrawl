"""URL patterns advertised through GET /supported-urls.

The Firecrawl API compiles these strings with JavaScript `new RegExp(...)` (no
flags), so they must use syntax valid in both JavaScript and Python `re`: no
inline flags, no `(?P<name>...)`, no possessive quantifiers.
"""

from __future__ import annotations

import re

# Providers with mature, maintained yt-dlp extractors. Keep this list curated:
# the regex gates which URLs the API will route to this service at all.
PROVIDER_HOSTS: tuple[str, ...] = (
    r"youtube\.com",
    r"youtu\.be",
    r"youtube-nocookie\.com",
    r"vimeo\.com",
    r"soundcloud\.com",
    r"dailymotion\.com",
    r"dai\.ly",
    r"twitch\.tv",
    r"tiktok\.com",
    r"x\.com",
    r"twitter\.com",
    r"instagram\.com",
    r"facebook\.com",
    r"fb\.watch",
    r"reddit\.com",
    r"v\.redd\.it",
    r"bandcamp\.com",
    r"mixcloud\.com",
    r"archive\.org",
    r"ted\.com",
    r"commons\.wikimedia\.org",
    r"bilibili\.com",
    r"rumble\.com",
    r"streamable\.com",
    r"loom\.com",
    r"podcasts\.apple\.com",
)

MEDIA_EXTENSIONS: tuple[str, ...] = (
    "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus",
    "mp4", "m4v", "webm", "mov", "mkv", "m3u8",
)

DEFAULT_SUPPORTED_REGEX = (
    r"^https?://(?:[a-z0-9-]+\.)*(?:"
    + "|".join(PROVIDER_HOSTS)
    + r")(?::[0-9]+)?(?:[/?#]|$)"
    + r"|^https?://[^?#]+\.(?:"
    + "|".join(MEDIA_EXTENSIONS)
    + r")(?:[?#].*)?$"
)

# URLs that /resolve expands into a list of posts (used by v2 /map).
DEFAULT_RESOLVE_REGEX = (
    r"^https?://(?:www\.|m\.)?youtube\.com/"
    r"(?:playlist\?(?:[^#]*&)?list=|@[^/?#]+(?:/(?:videos|shorts|streams))?/?(?:[?#]|$)"
    r"|channel/[^/?#]+(?:/(?:videos|shorts|streams))?/?(?:[?#]|$)"
    r"|c/[^/?#]+(?:/(?:videos|shorts|streams))?/?(?:[?#]|$)"
    r"|user/[^/?#]+(?:/(?:videos|shorts|streams))?/?(?:[?#]|$))"
)

# A pattern that never matches; valid in JS and Python.
NEVER_MATCH = r"(?!)"

DIRECT_MEDIA_RE = re.compile(
    r"^https?://[^?#]+\.(?:" + "|".join(MEDIA_EXTENSIONS) + r")(?:[?#].*)?$"
)

_YOUTUBE_CHANNEL_ROOT = re.compile(
    r"^(https?://(?:www\.|m\.)?youtube\.com/(?:@[^/?#]+|channel/[^/?#]+|c/[^/?#]+|user/[^/?#]+))/?(?:[?#].*)?$"
)

_JS_INCOMPATIBLE = re.compile(r"\(\?P<|\(\?[aiLmsux]+\)|\(\?#|\\A|\\Z|\*\+|\+\+|\?\+")


def assert_js_compatible(pattern: str) -> str:
    """Reject obvious Python-only constructs and verify the pattern compiles."""
    if _JS_INCOMPATIBLE.search(pattern):
        raise ValueError(f"Pattern uses Python-only regex syntax: {pattern!r}")
    re.compile(pattern)
    return pattern


def normalize_resolve_url(url: str) -> str:
    """Point a bare YouTube channel URL at its uploads tab."""
    match = _YOUTUBE_CHANNEL_ROOT.match(url)
    if match:
        return match.group(1) + "/videos"
    return url


def is_youtube_url(url: str) -> bool:
    return bool(
        re.match(r"^https?://(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)(?:[:/?#]|$)", url)
    )

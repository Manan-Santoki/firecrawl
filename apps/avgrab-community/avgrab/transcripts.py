"""Subtitle/caption parsing into plain-text transcripts."""

from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any

_TAG_RE = re.compile(r"<[^>]+>")
_TIMING_RE = re.compile(r"^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3}\s*-->")


def _normalize_lines(lines: list[str]) -> str:
    out: list[str] = []
    for line in lines:
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        # Auto-generated captions repeat the previous line as a rolling window.
        if out and (line == out[-1] or out[-1].endswith(line)):
            continue
        if out and line.startswith(out[-1]) and len(line) > len(out[-1]):
            out[-1] = line
            continue
        out.append(line)
    return "\n".join(out)


def parse_json3(text: str) -> str:
    data = json.loads(text)
    lines: list[str] = []
    for event in data.get("events", []) or []:
        segs = event.get("segs")
        if not segs:
            continue
        line = "".join(seg.get("utf8", "") for seg in segs if isinstance(seg, dict))
        if line.strip():
            lines.append(line)
    return _normalize_lines(lines)


def parse_vtt(text: str) -> str:
    lines: list[str] = []
    in_header = True
    for raw in text.splitlines():
        line = raw.strip("﻿")
        if in_header:
            if not line.strip():
                in_header = False
            continue
        if not line.strip() or _TIMING_RE.match(line) or line.strip().isdigit():
            continue
        if line.startswith(("NOTE", "STYLE", "REGION")):
            continue
        lines.append(html.unescape(_TAG_RE.sub("", line)))
    return _normalize_lines(lines)


def parse_srt(text: str) -> str:
    lines = []
    for raw in text.splitlines():
        if not raw.strip() or raw.strip().isdigit() or _TIMING_RE.match(raw):
            continue
        lines.append(html.unescape(_TAG_RE.sub("", raw)))
    return _normalize_lines(lines)


def parse_subtitle_file(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    ext = path.suffix.lower().lstrip(".")
    if ext == "json3":
        return parse_json3(text)
    if ext == "srt":
        return parse_srt(text)
    return parse_vtt(text)


def subtitle_lang_selector(lang: str) -> str:
    # Deliberately narrow: broad selectors (e.g. "en-.*") match dozens of
    # machine-translated tracks and trigger provider rate limits (HTTP 429).
    return f"{lang},{lang}-orig,.*-orig"


def choose_transcript(info: dict[str, Any], lang: str, base_dir: Path) -> str | None:
    """Pick the best written subtitle: manual > auto original > auto translated > any original."""
    requested = info.get("requested_subtitles") or {}
    manual = set((info.get("subtitles") or {}).keys())
    candidates: list[tuple[int, str, dict[str, Any]]] = []
    for key, sub in requested.items():
        if not isinstance(sub, dict) or not sub.get("filepath"):
            continue
        base = key.split("-")[0].lower()
        if key in manual and base == lang:
            rank = 0
        elif key.lower() == f"{lang}-orig":
            rank = 1
        elif base == lang:
            rank = 2 if key not in manual else 0
        elif key.endswith("-orig"):
            rank = 3
        else:
            rank = 4
        candidates.append((rank, key, sub))
    for _, _, sub in sorted(candidates, key=lambda c: (c[0], c[1])):
        path = Path(sub["filepath"])
        if not path.is_absolute():
            path = base_dir / path
        try:
            path.resolve().relative_to(base_dir.resolve())
        except ValueError:
            continue
        if not path.is_file():
            continue
        try:
            text = parse_subtitle_file(path)
        except (ValueError, OSError):
            continue
        if text.strip():
            return text
    return None

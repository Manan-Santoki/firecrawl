"""Pure span handling: overlap resolution, UTF-16 offsets and rendering.

Spans are returned in the coordinate system the Firecrawl API uses: UTF-16
code-unit offsets into the request text, because the API slices the same
string with JavaScript `String.prototype.slice`. Python indexes by code point,
so text containing astral characters (emoji, some CJK) needs translation.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
from typing import Iterable, Sequence


@dataclass(frozen=True)
class Detection:
    """A detection in Python code-point coordinates."""

    start: int
    end: int
    kind: str
    score: float
    source: str


def resolve_overlaps(detections: Iterable[Detection]) -> list[Detection]:
    """Keep a non-overlapping subset, preferring higher score then longer span.

    The API applies spans left to right and skips any span that starts before
    the previous one ended, so overlapping spans would make its re-rendered
    output diverge from `redacted_text`. Resolving here keeps both identical.
    """
    ranked = sorted(
        (d for d in detections if d.end > d.start),
        key=lambda d: (-d.score, -(d.end - d.start), d.start, d.kind),
    )
    kept: list[Detection] = []
    starts: list[int] = []
    for det in ranked:
        i = bisect_left(starts, det.start)
        if i > 0 and kept[i - 1].end > det.start:
            continue
        if i < len(kept) and kept[i].start < det.end:
            continue
        kept.insert(i, det)
        starts.insert(i, det.start)
    return kept


class Utf16Offsets:
    """Maps Python code-point offsets to UTF-16 code-unit offsets."""

    def __init__(self, text: str) -> None:
        self._astral = [i for i, ch in enumerate(text) if ord(ch) > 0xFFFF]

    def __call__(self, index: int) -> int:
        if not self._astral:
            return index
        # Every astral code point before `index` occupies one extra unit.
        return index + bisect_left(self._astral, index)


def utf16_len(text: str) -> int:
    return len(text) + sum(1 for ch in text if ord(ch) > 0xFFFF)


def render(text: str, detections: Sequence[Detection], operator: str) -> str:
    """Render redacted text with fire-privacy operator semantics.

    replace -> `<KIND>` placeholder
    mask    -> one `*` per UTF-16 code unit (matches the API's re-render)
    redact  -> characters removed
    """
    out: list[str] = []
    cursor = 0
    for det in sorted(detections, key=lambda d: d.start):
        if det.start < cursor:
            continue
        out.append(text[cursor : det.start])
        if operator == "replace":
            out.append(f"<{det.kind}>")
        elif operator == "mask":
            out.append("*" * utf16_len(text[det.start : det.end]))
        elif operator == "redact":
            pass
        else:  # pragma: no cover - validated at the API boundary
            raise ValueError(f"unknown operator {operator!r}")
        cursor = det.end
    out.append(text[cursor:])
    return "".join(out)


def to_wire_spans(text: str, detections: Sequence[Detection]) -> list[dict]:
    """Serialize detections as fire-privacy spans in UTF-16 coordinates.

    The matched text is deliberately not echoed back.
    """
    offsets = Utf16Offsets(text)
    return [
        {
            "start": offsets(d.start),
            "end": offsets(d.end),
            "kind": d.kind,
            "score": round(float(d.score), 4),
            "source": d.source,
        }
        for d in sorted(detections, key=lambda d: d.start)
    ]

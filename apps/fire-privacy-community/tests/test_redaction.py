import asyncio

import pytest

from app.main import _Limiter
from app.redaction import (
    Detection,
    Utf16Offsets,
    render,
    resolve_overlaps,
    to_wire_spans,
    utf16_len,
)


def det(start, end, kind="PERSON", score=0.85, source="SpacyRecognizer"):
    return Detection(start, end, kind, score, source)


def test_resolve_overlaps_prefers_score_then_length():
    kept = resolve_overlaps(
        [
            det(0, 10, "PHONE_NUMBER", 0.4),
            det(0, 11, "US_SSN", 0.85),
            det(20, 25, "PERSON", 0.85),
            det(18, 30, "LOCATION", 0.85),
            det(40, 40, "EMPTY", 1.0),
        ]
    )
    assert [(d.kind, d.start, d.end) for d in kept] == [
        ("US_SSN", 0, 11),
        ("LOCATION", 18, 30),
    ]


def test_resolve_overlaps_keeps_adjacent_spans():
    kept = resolve_overlaps([det(0, 5), det(5, 9), det(9, 12)])
    assert [(d.start, d.end) for d in kept] == [(0, 5), (5, 9), (9, 12)]


def test_utf16_offsets_account_for_astral_characters():
    text = "\U0001F600 Bob \U0001F389 x"
    offsets = Utf16Offsets(text)
    assert offsets(0) == 0
    assert offsets(1) == 2  # after one emoji
    assert offsets(2) == 3
    assert offsets(7) == 9  # after both emoji
    assert utf16_len(text) == len(text) + 2


def test_render_operators():
    text = "Alice Smith - email alice@example.com"
    spans = [det(0, 11, "PERSON"), det(20, 37, "EMAIL_ADDRESS", 1.0)]
    assert render(text, spans, "replace") == "<PERSON> - email <EMAIL_ADDRESS>"
    assert render(text, spans, "mask") == "*" * 11 + " - email " + "*" * 17
    assert render(text, spans, "redact") == " - email "


def test_mask_counts_utf16_units():
    text = "x \U0001F600\U0001F600 y"
    assert render(text, [det(2, 4)], "mask") == "x **** y"


def test_wire_spans_never_echo_matched_text():
    text = "Hi Alice"
    spans = to_wire_spans(text, [det(3, 8, score=0.123456)])
    assert spans == [
        {"start": 3, "end": 8, "kind": "PERSON", "score": 0.1235, "source": "SpacyRecognizer"}
    ]


def test_limiter_rejects_when_queue_full():
    async def scenario():
        limiter = _Limiter(concurrency=1, max_queue=0, timeout_s=5)
        assert await limiter.acquire()
        assert not await limiter.acquire()  # no queue room
        limiter.release()
        assert await limiter.acquire()
        limiter.release()

    asyncio.run(scenario())


def test_limiter_times_out_waiting():
    async def scenario():
        limiter = _Limiter(concurrency=1, max_queue=4, timeout_s=0.05)
        assert await limiter.acquire()
        assert not await limiter.acquire()
        limiter.release()

    asyncio.run(scenario())


@pytest.mark.parametrize("mode", ["model", "both", "heuristics", "precise"])
def test_settings_thresholds_cover_every_mode(mode):
    from app.config import Settings

    assert 0 <= Settings().threshold(mode) <= 1

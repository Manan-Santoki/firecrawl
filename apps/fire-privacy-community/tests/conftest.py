from __future__ import annotations

import functools
import re
import sys
from pathlib import Path
from typing import Callable

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import engine  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

# Building the analyzer loads spaCy; share one per model across apps. Tests
# that enable extra recognizers get their own uncached instance.
_cached_build = functools.lru_cache(maxsize=None)(engine.build_analyzer)


@pytest.fixture(autouse=True)
def _share_analyzer(monkeypatch):
    original = engine.build_analyzer
    monkeypatch.setattr(engine, "build_analyzer", _cached_build)
    yield
    monkeypatch.setattr(engine, "build_analyzer", original)


@pytest.fixture
def make_client() -> Callable[..., TestClient]:
    clients: list[TestClient] = []

    def factory(**overrides) -> TestClient:
        client = TestClient(create_app(Settings(**overrides)))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


# ---- Python port of the API client's response handling ------------------
# Mirrors apps/api/src/lib/fire-privacy-client.ts (upstream v2.11.739) so the
# tests assert what the API will actually do with a response.

KIND_TO_ENTITY = {
    "PRIVATE_PERSON": "PERSON",
    "PERSON": "PERSON",
    "PRIVATE_EMAIL": "EMAIL",
    "EMAIL_ADDRESS": "EMAIL",
    "PRIVATE_PHONE": "PHONE",
    "PHONE_NUMBER": "PHONE",
    "PHONEIMEI": "PHONE",
    "PRIVATE_ADDRESS": "LOCATION",
    "LOCATION": "LOCATION",
    "ACCOUNT_NUMBER": "FINANCIAL",
    "CREDIT_CARD": "FINANCIAL",
    "IBAN_CODE": "FINANCIAL",
    "US_BANK_NUMBER": "FINANCIAL",
    "US_SSN": "FINANCIAL",
    "US_ITIN": "FINANCIAL",
    "CRYPTO": "FINANCIAL",
    "SECRET": "SECRET",
    "API_KEY": "SECRET",
    "PASSWORD": "SECRET",
    "US_DRIVER_LICENSE": "SECRET",
    "US_PASSPORT": "SECRET",
    "MEDICAL_LICENSE": "SECRET",
}


def classify_source(raw) -> str:
    if not isinstance(raw, str):
        return "unknown"
    if raw == "openai-privacy-filter":
        return "model"
    if raw.endswith("Recognizer"):
        return "heuristics"
    return "unknown"


def utf16(text: str) -> bytes:
    return text.encode("utf-16-le", "surrogatepass")


def js_slice(text: str, start: int, end: int) -> str:
    """`String.prototype.slice` on UTF-16 code units."""
    return utf16(text)[start * 2 : end * 2].decode("utf-16-le", "surrogatepass")


def js_render(text: str, spans: list[dict], replace_style: str) -> str:
    """Port of renderRedacted(): the API's re-render after entity filtering."""
    units = utf16(text)
    length = len(units) // 2
    out = b""
    cursor = 0
    for span in sorted(spans, key=lambda s: s["start"]):
        if span["start"] < cursor:
            continue
        if span["start"] > length:
            break
        out += units[cursor * 2 : span["start"] * 2]
        if replace_style == "tag":
            out += utf16(f"<{span['kind']}>")
        elif replace_style == "mask":
            out += utf16("*" * max(0, span["end"] - span["start"]))
        cursor = min(span["end"], length)
    out += units[cursor * 2 :]
    return out.decode("utf-16-le", "surrogatepass")


REPLACE_STYLE = {"replace": "tag", "mask": "mask", "redact": "remove"}

KIND_RE = re.compile(r"^[A-Z_]+$")

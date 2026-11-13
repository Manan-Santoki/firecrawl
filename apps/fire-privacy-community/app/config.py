"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    value = int(raw)
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum} (got {value})")
    return value


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    value = float(raw)
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1 (got {value})")
    return value


def _list(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "")
    return tuple(item.strip().upper() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    # Optional shared secret. When set, /redact requires either
    # `Authorization: Bearer <key>` or `X-API-Key: <key>`. The stock Firecrawl
    # API client sends neither header, so leave this unset when the API talks
    # to the service directly over a private network.
    api_key: str | None = None
    # Per-request ceiling. Mirrors fire-privacy's `max_text_bytes` (100 KB);
    # the API chunker keeps every chunk under 95 KB.
    max_text_bytes: int = 100_000
    # Concurrent analyses per process. spaCy is CPU-bound and holds the GIL,
    # so one per process is the efficient default; scale with PRIVACY_WORKERS.
    max_concurrency: int = 1
    # Requests allowed to wait for a slot before new ones get 503.
    max_queue: int = 16
    # How long a request may wait for a slot before it gets 503.
    queue_timeout_ms: int = 20_000
    # Minimum Presidio score per internal mode.
    threshold_model: float = 0.4
    threshold_both: float = 0.3
    threshold_heuristics: float = 0.4
    threshold_precise: float = 0.6
    # Floor for noisy identifier kinds (driver license, passport, bank
    # account, ITIN, medical license) in every mode except `both`.
    threshold_noisy_ids: float = 0.5
    # Region this deployment processes data in (for example `us`). Requests
    # pinned to a region are refused unless it matches.
    data_region: str | None = None
    # spaCy pipeline used for PERSON / LOCATION named-entity recognition.
    spacy_model: str = "en_core_web_sm"
    # Extra Presidio entity names to detect beyond the default set (for
    # example IP_ADDRESS). They have no Firecrawl entity bucket, so the API
    # redacts them only when no `entities` allowlist is supplied.
    extra_entities: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_env(cls) -> "Settings":
        api_key = os.environ.get("PRIVACY_API_KEY") or None
        region = (os.environ.get("PRIVACY_DATA_REGION") or "").strip().lower()
        return cls(
            api_key=api_key,
            max_text_bytes=_int("PRIVACY_MAX_TEXT_BYTES", 100_000),
            max_concurrency=_int("PRIVACY_MAX_CONCURRENCY", 1),
            max_queue=_int("PRIVACY_MAX_QUEUE", 16, minimum=0),
            queue_timeout_ms=_int("PRIVACY_QUEUE_TIMEOUT_MS", 20_000),
            threshold_model=_float("PRIVACY_THRESHOLD_MODEL", 0.4),
            threshold_both=_float("PRIVACY_THRESHOLD_BOTH", 0.3),
            threshold_heuristics=_float("PRIVACY_THRESHOLD_HEURISTICS", 0.4),
            threshold_precise=_float("PRIVACY_THRESHOLD_PRECISE", 0.6),
            threshold_noisy_ids=_float("PRIVACY_THRESHOLD_NOISY_IDS", 0.5),
            data_region=region or None,
            spacy_model=os.environ.get("PRIVACY_SPACY_MODEL") or "en_core_web_sm",
            extra_entities=_list("PRIVACY_EXTRA_ENTITIES"),
        )

    def noisy_floor(self, mode: str) -> float:
        return 0.0 if mode == "both" else self.threshold_noisy_ids

    def threshold(self, mode: str) -> float:
        return {
            "model": self.threshold_model,
            "both": self.threshold_both,
            "heuristics": self.threshold_heuristics,
            "precise": self.threshold_precise,
        }[mode]

"""Presidio analyzer wiring for the community fire-privacy service.

Every recognizer name ends in `Recognizer` so the Firecrawl API classifies
spans as `heuristics`. Every default kind is one the API maps onto its public
entity buckets (PERSON, EMAIL, PHONE, LOCATION, FINANCIAL, SECRET).
"""

from __future__ import annotations

import re
from typing import List, Optional

import tldextract
import tldextract.tldextract as _tldextract_module
from presidio_analyzer import (
    AnalyzerEngine,
    EntityRecognizer,
    RecognizerRegistry,
    RecognizerResult,
)
from presidio_analyzer.nlp_engine import NlpArtifacts, SpacyNlpEngine
from presidio_analyzer.predefined_recognizers import (
    CreditCardRecognizer,
    CryptoRecognizer,
    EmailRecognizer,
    IbanRecognizer,
    MedicalLicenseRecognizer,
    PhoneRecognizer,
    SpacyRecognizer,
    UsBankRecognizer,
    UsItinRecognizer,
    UsLicenseRecognizer,
    UsPassportRecognizer,
    UsSsnRecognizer,
)

from .redaction import Detection

# Kinds emitted by default, each mapped by the API's KIND_TO_ENTITY table.
DEFAULT_ENTITIES: tuple[str, ...] = (
    "PERSON",  # PERSON
    "EMAIL_ADDRESS",  # EMAIL
    "PHONE_NUMBER",  # PHONE
    "LOCATION",  # LOCATION
    "CREDIT_CARD",  # FINANCIAL
    "IBAN_CODE",
    "US_BANK_NUMBER",
    "US_SSN",
    "US_ITIN",
    "CRYPTO",
    "API_KEY",  # SECRET
    "SECRET",
    "PASSWORD",
    "US_DRIVER_LICENSE",
    "US_PASSPORT",
    "MEDICAL_LICENSE",
)

# Recognizers that need the statistical NER model. `heuristics` mode drops
# their results so it stays pattern/checksum only.
NER_RECOGNIZERS = frozenset({"SpacyRecognizer"})

# Identifier patterns that match many ordinary numbers. Outside `both`
# (recall) mode they need surrounding context words (for example "passport")
# to clear this floor.
NOISY_KINDS = frozenset(
    {"US_DRIVER_LICENSE", "US_PASSPORT", "US_BANK_NUMBER", "US_ITIN", "MEDICAL_LICENSE"}
)


def _make_tldextract_offline() -> None:
    """Presidio's email validator calls `tldextract.extract`, whose default
    extractor downloads the public suffix list. Use the bundled snapshot so the
    service never makes outbound requests."""
    _tldextract_module.TLD_EXTRACTOR = tldextract.TLDExtract(
        suffix_list_urls=(), cache_dir=None, fallback_to_snapshot=True
    )


class _RegexRecognizer(EntityRecognizer):
    """Case-sensitive regex recognizer that can redact only a capture group."""

    PATTERNS: tuple[tuple[str, str, float, int], ...] = ()

    def __init__(self) -> None:
        self._compiled = [
            (kind, re.compile(pattern), score, group)
            for kind, pattern, score, group in self.PATTERNS
        ]
        super().__init__(
            supported_entities=sorted({kind for kind, *_ in self.PATTERNS}),
            supported_language="en",
            name=type(self).__name__,
        )

    def load(self) -> None:  # noqa: D102 - nothing to load
        pass

    def analyze(
        self,
        text: str,
        entities: List[str],
        nlp_artifacts: Optional[NlpArtifacts] = None,
    ) -> List[RecognizerResult]:
        results: List[RecognizerResult] = []
        for kind, regex, score, group in self._compiled:
            if entities and kind not in entities:
                continue
            for match in regex.finditer(text):
                start, end = match.span(group)
                if end <= start:
                    continue
                results.append(
                    RecognizerResult(
                        entity_type=kind,
                        start=start,
                        end=end,
                        score=score,
                        recognition_metadata={
                            RecognizerResult.RECOGNIZER_NAME_KEY: self.name,
                            RecognizerResult.RECOGNIZER_IDENTIFIER_KEY: self.id,
                        },
                    )
                )
        return results


class SecretRecognizer(_RegexRecognizer):
    """Well-known credential formats plus `password: value` assignments."""

    PATTERNS = (
        ("API_KEY", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", 0.9, 0),
        ("API_KEY", r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b", 0.95, 0),
        ("API_KEY", r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b", 0.95, 0),
        ("API_KEY", r"\bglpat-[A-Za-z0-9_\-]{20,}\b", 0.95, 0),
        ("API_KEY", r"\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_\-]{20,}\b", 0.85, 0),
        ("API_KEY", r"\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b", 0.9, 0),
        ("API_KEY", r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b", 0.9, 0),
        ("API_KEY", r"\bAIza[0-9A-Za-z_\-]{35}\b", 0.9, 0),
        ("API_KEY", r"\bfc-[0-9a-f]{32}\b", 0.85, 0),
        (
            "SECRET",
            r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
            0.85,
            0,
        ),
        (
            "SECRET",
            r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]+?"
            r"-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----",
            1.0,
            0,
        ),
        (
            "PASSWORD",
            r"(?i:\b(?:password|passwd|passcode|pwd)\b)[\"']?\s*[:=]\s*[\"']?"
            # Value only; trailing sentence punctuation is not part of it.
            r"([^\s\"'`<>]{3,127}[^\s\"'`<>.,;:!?)\]])",
            0.7,
            1,
        ),
    )


class StreetAddressRecognizer(_RegexRecognizer):
    """US/UK-style street lines such as `221B Baker Street` or `1 Main St.`"""

    _SUFFIX = (
        r"(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|"
        r"Court|Ct|Way|Place|Pl|Terrace|Parkway|Pkwy|Highway|Hwy|Square|Sq)"
    )
    PATTERNS = (
        (
            "LOCATION",
            r"\b\d{1,6}[A-Z]?\s+(?:[A-Z][A-Za-z0-9.'\-]*\s+){1,4}"
            + _SUFFIX
            + r"\b\.?(?:,?\s+(?:Apt|Apartment|Suite|Ste|Unit|Floor|#)\.?\s*[A-Za-z0-9\-]+)?",
            0.6,
            0,
        ),
    )


def build_analyzer(spacy_model: str) -> AnalyzerEngine:
    _make_tldextract_offline()
    nlp_engine = SpacyNlpEngine(models=[{"lang_code": "en", "model_name": spacy_model}])
    nlp_engine.load()
    # Presidio uses tokens, lemmas and entities only; the dependency parser
    # is roughly 10% of CPU time and contributes nothing here.
    for nlp in nlp_engine.nlp.values():
        if "parser" in nlp.pipe_names:
            nlp.disable_pipe("parser")

    registry = RecognizerRegistry(supported_languages=["en"])
    for recognizer in (
        SpacyRecognizer(supported_entities=["PERSON", "LOCATION"]),
        EmailRecognizer(),
        PhoneRecognizer(),
        CreditCardRecognizer(),
        IbanRecognizer(),
        UsBankRecognizer(),
        UsSsnRecognizer(),
        UsItinRecognizer(),
        CryptoRecognizer(),
        UsLicenseRecognizer(),
        UsPassportRecognizer(),
        MedicalLicenseRecognizer(),
        SecretRecognizer(),
        StreetAddressRecognizer(),
    ):
        registry.add_recognizer(recognizer)

    return AnalyzerEngine(
        registry=registry, nlp_engine=nlp_engine, supported_languages=["en"]
    )


def load_extra_recognizers(analyzer: AnalyzerEngine, entities: tuple[str, ...]) -> None:
    """Enable Presidio's predefined recognizers for operator-requested extras."""
    if not entities:
        return
    from presidio_analyzer.predefined_recognizers import (
        DateRecognizer,
        IpRecognizer,
        UrlRecognizer,
    )

    by_entity = {
        "IP_ADDRESS": IpRecognizer,
        "URL": UrlRecognizer,
        "DATE_TIME": DateRecognizer,
    }
    unknown = [e for e in entities if e not in by_entity]
    if unknown:
        raise ValueError(
            "PRIVACY_EXTRA_ENTITIES supports only "
            + ", ".join(sorted(by_entity))
            + f" (got {', '.join(unknown)})"
        )
    for entity in entities:
        analyzer.registry.add_recognizer(by_entity[entity]())


def detect(
    analyzer: AnalyzerEngine,
    text: str,
    mode: str,
    threshold: float,
    entities: tuple[str, ...],
    noisy_floor: float = 0.0,
) -> list[Detection]:
    results = analyzer.analyze(
        text=text,
        language="en",
        entities=list(entities),
        score_threshold=threshold,
    )
    detections: list[Detection] = []
    for result in results:
        metadata = result.recognition_metadata or {}
        source = metadata.get(RecognizerResult.RECOGNIZER_NAME_KEY) or "UnknownRecognizer"
        if mode == "heuristics" and source in NER_RECOGNIZERS:
            continue
        if result.entity_type in NOISY_KINDS and result.score < noisy_floor:
            continue
        detections.append(
            Detection(
                start=result.start,
                end=result.end,
                kind=result.entity_type,
                score=float(result.score),
                source=str(source),
            )
        )
    return detections

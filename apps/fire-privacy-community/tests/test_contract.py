"""Contract tests: request bodies shaped exactly like the Firecrawl API client
(apps/api/src/lib/fire-privacy-client.ts, upstream v2.11.739) and assertions
on what that client does with each response."""

import json

import pytest

from conftest import (
    KIND_RE,
    KIND_TO_ENTITY,
    REPLACE_STYLE,
    classify_source,
    js_render,
    js_slice,
)

ALICE = "Hi, my name is Alice Smith. Email me at alice@example.com."


def body(text, mode="model", operator="replace", **extra):
    # JSON.stringify({ text, mode, operator, language, ...(usOnly && {...}) })
    return {"text": text, "mode": mode, "operator": operator, "language": "en", **extra}


def post(client, payload, **kwargs):
    return client.post(
        "/redact",
        content=json.dumps(payload),
        headers={"content-type": "application/json", **kwargs.pop("headers", {})},
        **kwargs,
    )


def assert_client_compatible(text, payload, result):
    """Everything coerceSpans / renderRedacted rely on."""
    assert isinstance(result["redacted_text"], str)
    assert result["model_status"] in ("ok", "skipped")
    previous_end = 0
    for span in result["spans"]:
        assert isinstance(span["start"], int) and isinstance(span["end"], int)
        assert isinstance(span["kind"], str) and KIND_RE.match(span["kind"])
        assert isinstance(span["score"], (int, float))
        assert classify_source(span["source"]) == "heuristics"
        assert span["kind"] in KIND_TO_ENTITY, span["kind"]
        assert span["start"] >= previous_end, "spans must be sorted, non-overlapping"
        assert span["end"] > span["start"]
        previous_end = span["end"]
    # With no entity filter the API returns redacted_text verbatim; with a
    # filter it re-renders from the spans. Both must agree.
    style = REPLACE_STYLE[payload["operator"]]
    assert js_render(text, result["spans"], style) == result["redacted_text"]


# ---- happy paths ----------------------------------------------------------


def test_redacts_person_and_email_like_upstream_fixture(client):
    payload = body(ALICE)
    res = post(client, payload)
    assert res.status_code == 200
    out = res.json()
    assert out["redacted_text"] == "Hi, my name is <PERSON>. Email me at <EMAIL_ADDRESS>."
    assert out["model_status"] == "ok"
    assert "data_region" not in out
    assert [(s["start"], s["end"], s["kind"]) for s in out["spans"]] == [
        (15, 26, "PERSON"),
        (40, 57, "EMAIL_ADDRESS"),
    ]
    assert_client_compatible(ALICE, payload, out)


@pytest.mark.parametrize("mode", ["model", "both", "heuristics"])
@pytest.mark.parametrize("operator", ["replace", "mask", "redact"])
def test_every_mode_and_operator_the_client_sends(client, mode, operator):
    text = (
        "Contact Alice Carter at alice@example.com or (415) 555-0132.\n\n"
        "Card 4111 1111 1111 1111. Key AKIAIOSFODNN7EXAMPLE."
    )
    payload = body(text, mode, operator)
    res = post(client, payload)
    assert res.status_code == 200
    out = res.json()
    assert_client_compatible(text, payload, out)
    kinds = {s["kind"] for s in out["spans"]}
    assert {"EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "API_KEY"} <= kinds
    assert ("PERSON" in kinds) == (mode != "heuristics")
    for secret in ("alice@example.com", "4111 1111 1111 1111", "AKIAIOSFODNN7EXAMPLE"):
        assert secret not in out["redacted_text"]


def test_entity_filter_rerender_matches_upstream_expectation(client):
    # Mirrors "filters spans to the requested entities and re-renders markdown".
    payload = body(ALICE)
    out = post(client, payload).json()
    email_only = [s for s in out["spans"] if KIND_TO_ENTITY[s["kind"]] == "EMAIL"]
    assert js_render(ALICE, email_only, "tag") == (
        "Hi, my name is Alice Smith. Email me at <EMAIL_ADDRESS>."
    )


def test_offsets_are_utf16_code_units(client):
    text = "\U0001F600 Reach Bob at bob@example.org \U0001F389 or 4111-1111-1111-1111."
    payload = body(text, "heuristics", "mask")
    out = post(client, payload).json()
    assert_client_compatible(text, payload, out)
    sliced = {js_slice(text, s["start"], s["end"]) for s in out["spans"]}
    assert {"bob@example.org", "4111-1111-1111-1111"} <= sliced


@pytest.mark.parametrize(
    "snippet,kind",
    [
        ("IBAN GB82 WEST 1234 5698 7654 32 for wires", "IBAN_CODE"),
        ("My SSN is 536-22-1234.", "US_SSN"),
        ("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked", "API_KEY"),
        ("db password: hunter22secret", "PASSWORD"),
        ("Ship to 1600 Pennsylvania Avenue, Washington.", "LOCATION"),
        ("BTC 1BoatSLRHtKNngkdXEeobR76b53LETtpyT please", "CRYPTO"),
    ],
)
def test_detects_each_category(client, snippet, kind):
    out = post(client, body(snippet, "both")).json()
    assert kind in {s["kind"] for s in out["spans"]}, out


def test_password_redacts_value_not_label(client):
    out = post(client, body("db password: hunter22secret")).json()
    assert out["redacted_text"] == "db password: <PASSWORD>"
    out = post(client, body('Set PASSWORD="hunter22secret". Done')).json()
    assert out["redacted_text"] == 'Set PASSWORD="<PASSWORD>". Done'


def test_benign_markdown_is_untouched(client):
    text = (
        "## Pricing\n\n- [Docs](https://docs.example.com) | [Blog](/blog)\n\n"
        "Plans start at $10/month. Version 2.11.0 shipped. All rights reserved."
    )
    out = post(client, body(text)).json()
    assert out == {"redacted_text": text, "spans": [], "model_status": "ok"}


def test_noisy_identifiers_need_context_outside_both_mode(client):
    text = "Order number 123456789 shipped."
    assert post(client, body(text, "model")).json()["spans"] == []


def test_whitespace_input_is_skipped(client):
    out = post(client, body("   \n\t")).json()
    assert out == {"redacted_text": "   \n\t", "spans": [], "model_status": "skipped"}


def test_defaults_when_optional_fields_omitted_and_unknown_fields_ignored(client):
    res = post(client, {"text": ALICE, "future_field": True})
    assert res.status_code == 200
    assert res.json()["redacted_text"].startswith("Hi, my name is <PERSON>")


# ---- region pinning (usOnly teams) -----------------------------------------


def test_pinned_request_refused_when_region_not_configured(client):
    res = post(client, body(ALICE, data_region="us"))
    assert res.status_code == 503
    assert res.json()["code"] == "region_unavailable"  # isRegionUnavailable()


def test_pinned_request_echoes_configured_region(make_client):
    c = make_client(data_region="us")
    out = post(c, body(ALICE, data_region="us")).json()
    assert out["data_region"] == "us"
    assert out["model_status"] == "ok"
    assert "data_region" not in post(c, body(ALICE)).json()


# ---- failure paths ----------------------------------------------------------


def test_text_over_byte_limit_is_413(make_client):
    c = make_client(max_text_bytes=1000)
    res = post(c, body("é" * 501))  # 1002 UTF-8 bytes
    assert res.status_code == 413
    assert res.json()["code"] == "too_large"


def test_body_over_transport_limit_is_413(make_client):
    c = make_client(max_text_bytes=10)
    res = post(c, body("x" * 200_000))
    assert res.status_code == 413


def test_invalid_json_is_400(client):
    res = client.post("/redact", content="{not json", headers={"content-type": "application/json"})
    assert res.status_code == 400


@pytest.mark.parametrize(
    "payload",
    [
        {"mode": "model"},
        {"text": 42},
        {"text": "x", "mode": "accurate"},
        {"text": "x", "operator": "tag"},
        {"text": "x", "language": "fr"},
    ],
)
def test_invalid_requests_are_422_without_echoing_input(client, payload):
    res = post(client, payload)
    assert res.status_code == 422
    assert "input" not in json.dumps(res.json().get("details", []))


def test_overload_is_503_service_unavailable(make_client, monkeypatch):
    c = make_client(max_queue=0)

    async def refuse(self):
        return False

    from app import main

    monkeypatch.setattr(main._Limiter, "acquire", refuse)
    res = post(c, body(ALICE))
    assert res.status_code == 503
    assert res.json()["code"] == "overloaded"


def test_analysis_error_is_500_without_text(make_client, monkeypatch):
    c = make_client()
    from app import engine

    def boom(*_args, **_kwargs):
        raise RuntimeError("Alice Smith leaked")

    monkeypatch.setattr(engine, "detect", boom)
    res = post(c, body(ALICE))
    assert res.status_code == 500
    assert "Alice" not in res.text


# ---- auth -------------------------------------------------------------------


def test_api_key_required_when_configured(make_client):
    c = make_client(api_key="s3cret")
    assert post(c, body(ALICE)).status_code == 401
    assert post(c, body(ALICE), headers={"authorization": "Bearer wrong"}).status_code == 401
    assert post(c, body(ALICE), headers={"authorization": "Bearer s3cret"}).status_code == 200
    assert post(c, body(ALICE), headers={"x-api-key": "s3cret"}).status_code == 200
    assert c.get("/health/liveness").status_code == 200
    assert c.get("/health/readiness").status_code == 200


def test_no_auth_by_default_matches_stock_client(client):
    # The stock API client sends only content-type.
    assert post(client, body(ALICE)).status_code == 200


def test_extra_entities_are_opt_in(make_client, monkeypatch):
    from app import engine
    from conftest import _cached_build

    # Extras mutate the registry; use a fresh analyzer.
    monkeypatch.setattr(engine, "build_analyzer", _cached_build.__wrapped__)
    c = make_client(extra_entities=("IP_ADDRESS",))
    out = post(c, body("Server at 192.168.10.24 is down.")).json()
    assert [s["kind"] for s in out["spans"]] == ["IP_ADDRESS"]

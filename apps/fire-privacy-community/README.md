# fire-privacy-community

A provider-neutral replacement for Firecrawl's private `fire-privacy` service, which backs `redactPII` on scrape and parse. It implements the `POST /redact` contract the API client (`apps/api/src/lib/fire-privacy-client.ts`) calls, using [Microsoft Presidio](https://github.com/microsoft/presidio) pattern recognizers and a CPU-sized spaCy English pipeline. It needs no GPU, no model API and no outbound network access at runtime.

## Run with the community stack

```bash
docker compose \
  -f docker-compose.yaml \
  -f community/docker-compose.privacy.yaml \
  up --build
```

The overlay sets `FIRE_PRIVACY_URL=http://fire-privacy-community:3010` and `FIRE_PRIVACY_TIMEOUT_MS=30000` on the `api` service. The `api` service also runs the workers, so no other service needs the variable. The privacy service is reachable only on the Compose `backend` network.

## API

### `POST /redact`

The request matches what the API client sends:

```json
{ "text": "Hi, my name is Alice Smith.", "mode": "model", "operator": "replace", "language": "en" }
```

| Field | Values | Notes |
| --- | --- | --- |
| `text` | string | At most `PRIVACY_MAX_TEXT_BYTES` UTF-8 bytes. The API chunks Markdown into pieces of 28K characters or fewer. |
| `mode` | `model` (from `accurate`), `both` (from `aggressive`), `heuristics` (from `fast`), `precise` | See [Modes](#modes). The default is `model`. |
| `operator` | `replace` (from `tag`), `mask`, `redact` (from `remove`) | The default is `replace`. |
| `language` | `en` | Any other language gets 422. |
| `data_region` | for example `us` | Sent only for US-only teams. See [Region pinning](#region-pinning). |

Unknown fields are ignored. The response has this shape:

```json
{
  "redacted_text": "Hi, my name is <PERSON>.",
  "spans": [{ "start": 15, "end": 26, "kind": "PERSON", "score": 0.85, "source": "SpacyRecognizer" }],
  "model_status": "ok"
}
```

- Span offsets are UTF-16 code units, the same units JavaScript uses to slice the string the API holds. Spans are sorted and never overlap, so the API's own re-render after an `entities` filter matches `redacted_text`.
- Matched text is never echoed in responses or logs.
- Every `source` ends in `Recognizer`, so the API labels spans `heuristics`.
- Whitespace-only text returns `model_status: "skipped"` with the text unchanged.

| Status | When | What the API does |
| --- | --- | --- |
| 200 | Success | Uses `redacted_text` and the spans |
| 400 / 422 | Invalid JSON, schema or language | `failed` / `error` |
| 401 | `PRIVACY_API_KEY` is set and the key is missing or wrong | `failed` / `error` |
| 413 | Text or body is too large | `failed` / `error` |
| 503 `overloaded` | The queue is full or the wait timed out | `failed` / `service_unavailable` |
| 503 `region_unavailable` | The pinned region does not match `PRIVACY_DATA_REGION` | US-only error |
| 500 | Analyzer failure | `failed` / `error` |

The API is all-or-nothing. If any chunk fails, it returns empty Markdown rather than partially redacted content.

### Health

- `GET /health` and `GET /health/liveness` report that the process is up.
- `GET /health/readiness` returns 200 after the analyzer has loaded and warmed up. The image healthcheck uses it.

## Entities

Each default kind maps to one of the API's public entity buckets.

| API entity | Kinds emitted | Detector |
| --- | --- | --- |
| `PERSON` | `PERSON` | spaCy NER |
| `EMAIL` | `EMAIL_ADDRESS` | Presidio pattern with TLD validation (bundled suffix list, offline) |
| `PHONE` | `PHONE_NUMBER` | Presidio / libphonenumber (US, GB, DE, FR, IL, IN, CA, BR formats) |
| `LOCATION` | `LOCATION` | spaCy NER (GPE/LOC/FAC) plus a street-address pattern |
| `FINANCIAL` | `CREDIT_CARD`, `IBAN_CODE`, `US_SSN`, `US_ITIN`, `US_BANK_NUMBER`, `CRYPTO` | Presidio patterns with checksums |
| `SECRET` | `API_KEY`, `SECRET`, `PASSWORD`, `US_DRIVER_LICENSE`, `US_PASSPORT`, `MEDICAL_LICENSE` | Credential formats (AWS, GitHub, GitLab, OpenAI/Anthropic-style `sk-`, Stripe, Slack, Google, Firecrawl `fc-`, JWT, PEM private keys), `password:` values, and Presidio ID patterns |

`PRIVACY_EXTRA_ENTITIES` can also enable `IP_ADDRESS`, `URL` or `DATE_TIME`. These have no API entity bucket, so they are redacted only when the request has no `entities` allowlist.

### Modes

| Mode | Detectors | Minimum score |
| --- | --- | --- |
| `model` (`accurate`, default) | All detectors | 0.4. Noisy ID kinds need 0.5, which in practice means a context word such as "passport" nearby. |
| `both` (`aggressive`) | All detectors | 0.3, with no extra floor for noisy IDs |
| `heuristics` (`fast`) | Patterns and checksums only, with no NER, so no names or NER locations | 0.4. Noisy IDs need 0.5. |
| `precise` | All detectors | 0.6 |

## Differences from Firecrawl Cloud

- Cloud's `accurate` mode uses a hosted privacy model (`openai-privacy-filter`). Here every mode runs Presidio and spaCy `en_core_web_sm`. Name and location recall is lower, especially for short or unusual names and text with heavy Markdown. Expect different spans from Cloud for the same input.
- Only English is supported.
- There is no organization, URL or date redaction by default. Cloud's model may cover categories this service does not.
- The service runs on CPU. A 28K-character chunk takes about 1-3 s on one core, which is why the overlay raises `FIRE_PRIVACY_TIMEOUT_MS`. The API's default budget is 5 s per chunk, and three chunks are sent in parallel.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3010` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `PRIVACY_WORKERS` | `2` | Uvicorn worker processes. Each loads its own pipeline, using about 150 MB. The API sends up to three chunks in parallel per document. |
| `PRIVACY_MAX_CONCURRENCY` | `1` | Concurrent analyses per worker. spaCy is CPU-bound, so scale with workers instead. |
| `PRIVACY_MAX_QUEUE` | `16` | Requests allowed to wait per worker before new ones get 503 |
| `PRIVACY_QUEUE_TIMEOUT_MS` | `20000` | Longest a request may wait for a slot before it gets 503 |
| `PRIVACY_MAX_TEXT_BYTES` | `100000` | Per-request text ceiling, matching fire-privacy's `max_text_bytes` |
| `PRIVACY_API_KEY` | unset | Optional shared secret, sent as `Authorization: Bearer <key>` or `X-API-Key`. The stock API client sends no credentials, so set this only if a proxy between the API and this service injects the header. Otherwise keep the service on a private network. |
| `PRIVACY_DATA_REGION` | unset | Region this deployment processes data in, for example `us`. Requests pinned to another region, or any pinned request while this is unset, get `region_unavailable`. |
| `PRIVACY_THRESHOLD_MODEL` / `_BOTH` / `_HEURISTICS` / `_PRECISE` | `0.4` / `0.3` / `0.4` / `0.6` | Minimum Presidio score per mode |
| `PRIVACY_THRESHOLD_NOISY_IDS` | `0.5` | Floor for driver license, passport, bank account, ITIN and medical license kinds outside `both` mode |
| `PRIVACY_EXTRA_ENTITIES` | unset | Comma-separated list from `IP_ADDRESS`, `URL`, `DATE_TIME` |
| `PRIVACY_SPACY_MODEL` | `en_core_web_sm` | Installed spaCy pipeline. Build with `SPACY_MODEL`, `SPACY_MODEL_VERSION` and `SPACY_MODEL_SHA256` to bake in another one, such as `en_core_web_md`. |

These variables are set on the API side:

| Variable | Purpose |
| --- | --- |
| `FIRE_PRIVACY_URL` | Base URL of this service. The API calls `${FIRE_PRIVACY_URL}/redact`. |
| `FIRE_PRIVACY_TIMEOUT_MS` | Per-chunk budget. The API default is 5000; the overlay sets 30000. |

## Development

```bash
cd apps/fire-privacy-community
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pip install --no-deps https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
python -m pytest -q          # unit tests plus in-process contract tests

docker build -t firecrawl-privacy-community .
docker run --rm -p 127.0.0.1:3010:3010 firecrawl-privacy-community
FIRE_PRIVACY_URL=http://127.0.0.1:3010 node --test test/contract.mjs   # black-box test, Node >= 20
```

`test/contract.mjs` sends requests built the same way the API client builds them and runs the client's own span handling (`coerceSpans`, `renderRedacted`, `isRegionUnavailable`) on the responses, using real JavaScript string offsets.

## License

This service is part of this repository and is licensed under AGPL-3.0. Its dependencies are open source: Presidio and FastAPI under MIT, spaCy and `en_core_web_sm` under MIT, and Uvicorn under BSD-3-Clause.

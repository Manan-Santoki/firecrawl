# Firecrawl Community avgrab service

Provider-neutral implementation of the private media service that upstream Firecrawl calls through `AVGRAB_SERVICE_URL`. It is built on open-source components only: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), ffmpeg (LGPL/GPL), FastAPI (MIT), Beautiful Soup (MIT) and optionally boto3 (Apache-2.0). It never contacts Firecrawl Cloud.

## What it enables in the API

| Firecrawl feature | API code (upstream v2.11.739) | Endpoint |
| --- | --- | --- |
| `audio` scrape format | `scraper/scrapeURL/transformers/audio.ts` | `GET /supported-urls`, `POST /download` |
| `video` scrape format (provider download) | `transformers/video.ts` | `GET /supported-urls`, `POST /download-video` |
| Generic video discovery (`videos` on the document) | `transformers/video.ts` | `POST /videos` |
| YouTube metadata and transcript markdown | `postprocessors/youtube.ts` | `POST /metadata` |
| YouTube channel/playlist expansion in `/v2/map` | `lib/avgrab-resolve.ts`, `controllers/v2/map.ts` | `GET /supported-urls`, `POST /resolve` |

Upstream only routes the `audio`/`video` formats through fire-engine engines (so browser cookies can be forwarded). This fork marks the self-hosted `playwright` and `fetch` engines as audio/video-capable when fire-engine is not configured (`apps/api/src/scraper/scrapeURL/engines/index.ts`); without that, self-hosted scrapes requesting those formats fail with an empty engine list. Requests from those engines carry no cookies.

Without `AVGRAB_SERVICE_URL` the API returns a warning for `audio`/`video`, skips YouTube enrichment and uses the standard map path.

## Contract

The API sends JSON with `Content-Type: application/json` and **no authentication header**.

| Endpoint | Request | Success response |
| --- | --- | --- |
| `GET /supported-urls` | – | `{"regex": str, "resolve_regex": str}` – compiled by the API with JavaScript `new RegExp()` |
| `POST /download` | `{"url", "cookies"?}` | `{"public_url", "filename", "mime_type", "size_bytes", "expires_at", "title", "duration", "source_url"}` (API reads `public_url`) |
| `POST /download-video` | `{"url", "cookies"?}` | same as `/download`, an MP4 when possible |
| `POST /videos` | `{"url", "html"?}` | `{"videos": [VideoItem]}` |
| `POST /metadata` | `{"url", "transcript_language", "cookies"?}` | `{"thumbnail_image": {url,width,height}, "title", "visibility", "uploaded_by": {name,url}, "uploaded_at", "published_at", "length", "views", "likes", "category", "description", "transcript"}` |
| `POST /resolve` | `{"url", "limit"}` | `{"username", "posts": [{url,title,date,type,media[]}]}` |
| `GET /health` | – | liveness, storage backend, active jobs (no auth) |
| `GET /files/{id}/{name}?expires&sig` | – | the media file (HMAC-signed, expiring, supports `Range`) |

`cookies` are Firecrawl `BrowserCookie` objects (`name`, `value`, `domain`, `path`, `expires`, `secure`, `httpOnly`, …); they are written to a per-request Netscape cookie jar and deleted with the request.

### Errors

The API understands two error bodies (`throwIfMediaAccessDenied` in `scrapeURL/error.ts`):

- `{"detail": "string"}` – operational failure. The API reports `Audio download failed: <detail>` (or the video/metadata equivalent). Used for unsupported URLs (400), size/duration limits (413), capacity (503), timeouts (504) and extractor failures (502).
- `{"detail": {"code", "message"}}` – terminal, user-facing denial relayed verbatim as `SCRAPE_MEDIA_ACCESS_DENIED`. Codes: `private`, `age_restricted`, `paywalled`, `geo_restricted`, `content_unavailable` (login required), `bot_check`, `not_found`.

`/resolve` always uses string details, because the map controller only reads strings; it maps 403/404/503 through and turns other statuses into 502.

### Media delivery (provider-neutral)

Firecrawl Cloud uploads to its own bucket; this service supports two portable options:

1. **Local (default).** The file is stored on the service volume and `public_url` is `AVGRAB_PUBLIC_URL/files/<random id>/<name>?expires=<unix>&sig=<HMAC-SHA256>`. Links expire after `AVGRAB_FILE_TTL_SECONDS`; a janitor deletes expired files every minute. Tampered or expired links return 403. `AVGRAB_PUBLIC_URL` must be reachable by whoever consumes scrape results (expose only `/files/` through your TLS reverse proxy).
2. **S3-compatible object storage.** Set `AVGRAB_S3_BUCKET` (plus endpoint/region/credentials) to upload to AWS S3, MinIO, Cloudflare R2, Backblaze B2, GCS interoperability, etc. `public_url` is then a presigned GET URL valid for `AVGRAB_FILE_TTL_SECONDS`. Configure a bucket lifecycle rule to delete objects under `AVGRAB_S3_PREFIX`.

### Supported URLs

`/supported-urls` advertises a curated regex: YouTube, Vimeo, SoundCloud, Dailymotion, Twitch, TikTok, X/Twitter, Instagram, Facebook, Reddit, Bandcamp, Mixcloud, Internet Archive, TED, Wikimedia Commons, Bilibili, Rumble, Streamable, Loom and Apple Podcasts, plus direct media file URLs (`.mp3 .m4a .aac .wav .flac .ogg .oga .opus .mp4 .m4v .webm .mov .mkv .m3u8`). yt-dlp supports far more sites; extend with `AVGRAB_SUPPORTED_REGEX` (must be valid in both JavaScript and Python, no inline flags or named groups). The resolve regex matches YouTube `@handle`, `/channel/`, `/c/`, `/user/` (optionally `/videos|/shorts|/streams`) and `playlist?list=` URLs; bare channel URLs are expanded from their uploads tab.

### Transcripts

`/metadata` asks yt-dlp for subtitles in `transcript_language` (first subtag, default `en`): manual captions first, then the auto-generated original-language track, then auto-translated captions, then the original-language track of any language. The transcript is plain text, one caption line per row, with rolling auto-caption duplicates removed. Caption download failures never fail the metadata call; `transcript` is `null` when no captions exist.

## Authentication

Upstream's client sends no header, so the key travels as a path prefix:

```
AVGRAB_SERVICE_URL=http://avgrab-community:8080/k/<AVGRAB_API_KEY>
```

`Authorization: Bearer <key>` and `X-API-Key: <key>` are also accepted for other clients. `/health` and signed `/files/` links are reachable without the key. The key must use URL-safe characters (`A-Z a-z 0-9 - _ . ~`). Without `AVGRAB_API_KEY` every endpoint is open – only do that on an isolated network.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. |
| `AVGRAB_API_KEY` | unset (open) | Shared secret (path prefix or header). Required by the Compose overlay. |
| `AVGRAB_SIGNING_KEY` | random per process | HMAC key for file links. Set it so links survive restarts. Required by the overlay. |
| `AVGRAB_PUBLIC_URL` | `http://localhost:8080` | Base URL embedded in `public_url` for local storage. |
| `AVGRAB_DATA_DIR` | `/data` | Volume for `files/` and per-request `work/` directories. |
| `AVGRAB_FILE_TTL_SECONDS` | `3600` | Link lifetime and local retention. |
| `AVGRAB_MAX_CONCURRENCY` | `2` | Simultaneous yt-dlp jobs (download, metadata, resolve). |
| `AVGRAB_QUEUE_TIMEOUT_SECONDS` | `30` | Wait for a slot before answering 503. |
| `AVGRAB_MAX_FILESIZE_MB` | `200` | Hard cap on produced files (413 above). |
| `AVGRAB_MAX_DURATION_SECONDS` | `10800` | Reject longer media before downloading (413). Live/upcoming streams are always rejected. |
| `AVGRAB_DOWNLOAD_TIMEOUT_SECONDS` | `220` | Whole-job budget for `/download*`; below the API's 240 s client timeout. |
| `AVGRAB_METADATA_TIMEOUT_SECONDS` | `40` | Below the API's 45 s `/metadata` timeout. |
| `AVGRAB_RESOLVE_TIMEOUT_SECONDS` | `270` | Below the API's 5 min `/resolve` timeout. |
| `AVGRAB_MAX_RESOLVE_ITEMS` | `1000` | Upper bound applied to the map `limit`. |
| `AVGRAB_RESOLVE_ENABLED` | `true` | `false` advertises a never-matching `resolve_regex`, keeping the standard map path. |
| `AVGRAB_RESOLVE_REGEX` | built-in | Override the resolve pattern. |
| `AVGRAB_SUPPORTED_REGEX` | built-in | Override the supported-URL pattern. |
| `AVGRAB_ALLOW_PRIVATE_NETWORKS` | `false` | Allow targets resolving to private, loopback or link-local addresses (tests only). |
| `AVGRAB_AUDIO_FORMAT` | `mp3` | `mp3`, `m4a`, `opus`, `wav`, `flac`, `aac` or `vorbis`. |
| `AVGRAB_VIDEO_MAX_HEIGHT` | `1080` | Preferred maximum video resolution. |
| `AVGRAB_MAX_HTML_BYTES` | `5242880` | `/videos` HTML is truncated beyond this. |
| `AVGRAB_MAX_VIDEOS` | `50` | Maximum items returned by `/videos`. |
| `AVGRAB_YTDLP_EXTRA_ARGS` | unset | Extra yt-dlp flags, e.g. `--proxy socks5://proxy:1080`. |
| `AVGRAB_S3_BUCKET` | unset | Enables the S3-compatible backend. |
| `AVGRAB_S3_ENDPOINT_URL` | AWS | Endpoint for MinIO/R2/etc. |
| `AVGRAB_S3_REGION` | unset | Bucket region. |
| `AVGRAB_S3_PREFIX` | `avgrab/` | Object key prefix. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | – | S3 credentials (the overlay maps `AVGRAB_S3_ACCESS_KEY_ID` / `AVGRAB_S3_SECRET_ACCESS_KEY`). Any standard boto3 credential source works. |

## Safety limits

- Bounded concurrency with a bounded queue; overflow returns 503.
- Every yt-dlp invocation runs as a subprocess in its own process group and is killed (with ffmpeg children) on timeout.
- Each request uses a private work directory that is always removed; leftovers from crashes are purged on startup and by the janitor.
- Duration is checked before downloading; `--max-filesize` and a post-download size check enforce the size cap.
- Target URLs must match the supported regex and, unless `AVGRAB_ALLOW_PRIVATE_NETWORKS=true`, resolve to public addresses. This pre-flight check does not stop redirects or DNS rebinding performed by the extractor, so run the service on a network segment that cannot reach sensitive internal endpoints.
- `/videos` only parses the HTML the API already fetched; it never fetches the page.
- The container runs as an unprivileged user; the overlay drops all capabilities and sets CPU, memory and PID limits.

## Operational notes

- Providers change frequently. Rebuild with a current `yt-dlp` release regularly (`requirements.txt`). The image includes Deno, which yt-dlp needs for YouTube's JavaScript challenges.
- YouTube and others may challenge datacenter IP ranges ("confirm you're not a bot"). That surfaces as the `bot_check` denial. Mitigations are operator choices: residential/egress proxies via `AVGRAB_YTDLP_EXTRA_ARGS`, or cookies supplied by the API's browser session.
- Respect the terms of service and copyright of the sites you process.

## Development

```bash
cd apps/avgrab-community
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest                      # unit + in-process HTTP contract tests
scripts/contract.sh                   # build image, run black-box tests against the container
AVGRAB_LIVE_TESTS=1 scripts/contract.sh   # additionally hit public YouTube (Big Buck Bunny, CC BY)
```

`scripts/contract.sh` starts the service on an isolated Docker network beside an ffmpeg-generated fixture server, uses the `/k/<key>` URL form exactly as the API would, and fails if any work directory is left behind.

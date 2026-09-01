# Portable application database

These PostgreSQL files provide the application-database contract required by API-key authentication, browser sessions, monitoring, change tracking, webhooks and related stateful routes. They are provider-neutral and intentionally live in the public distribution.

`migrate.mjs` is the only supported schema entry point. It verifies the checksummed, ordered `manifest.json`, takes a PostgreSQL advisory lock, and records successful versions in `public.schema_migrations`. Transaction-safe migrations run with `ON_ERROR_STOP` inside a transaction. A migration marked `irreversible` is rejected unless the operator explicitly passes `--allow-irreversible` (or sets `ALLOW_IRREVERSIBLE_MIGRATIONS=true`).

The authenticated Compose overlay runs the migrator as a one-shot service before the parameterized seed and API. `090-seed.sql` remains a repeatable support script rather than a schema migration; it requires `org_id`, `team_id`, and `api_key` UUID values through `psql -v`. Clients present the key as `fc-` followed by the UUID without dashes.

## Operator commands

Run from a host with Node 22 and `psql`, using either normal `PG*` variables or `DATABASE_URL`:

```bash
node community/migrations/migrate.mjs status
node community/migrations/migrate.mjs dry-run
node community/migrations/migrate.mjs apply
```

`status` and `dry-run` are read-only and report `pending`, `applied`, `baselined`, or `checksum-mismatch`. Applied SQL files are immutable: changing one without a new version fails both manifest validation and database checksum validation.

### Adopting an existing community volume

Never replay the current-schema bundle over a populated database. Back up and inspect the database, verify that it was initialized from this community schema, and run exactly once:

```bash
node community/migrations/migrate.mjs baseline --confirm-existing
```

For the Compose overlay, set `COMMUNITY_MIGRATIONS_BASELINE_EXISTING=true` for one deployment and remove it immediately afterward. Baseline mode checks required relations/functions before writing checksummed ledger rows. Normal apply fails closed when it finds application tables without a ledger.

Automated platform adapters adopting the original four-file community schema may additionally pin `COMMUNITY_MIGRATIONS_BASELINE_THROUGH=040-selfhost-rpcs`. This keeps the reviewed adoption boundary fixed: migrations added in later releases are executed normally and can never be silently baselined.

Every future schema change must be a new numbered SQL file plus manifest entry. Declare whether it is transactional and irreversible, update its SHA-256 before review, and never edit an applied file. Non-transactional migrations must be narrowly justified in the pull request.

The schema source of truth is [`apps/api/src/db/schema/public.ts`](../../apps/api/src/db/schema/public.ts). Community release CI checks this bundle before publishing images; schema changes are treated as high-risk and never auto-promoted to production.

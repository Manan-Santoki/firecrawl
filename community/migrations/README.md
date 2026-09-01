# Portable application database

These PostgreSQL files provide the application-database contract required by API-key authentication, browser sessions, monitoring, change tracking, webhooks and related stateful routes. They are provider-neutral and intentionally live in the public distribution.

Run the files in lexical order against a dedicated PostgreSQL database. `090-seed.sql` is a parameterized seed and requires `org_id`, `team_id`, and `api_key` UUID values through `psql -v`; clients present the key as `fc-` followed by the UUID without dashes.

The schema is idempotent at the container-bootstrap level: PostgreSQL's entrypoint runs it only for an empty data volume, while the constraints/RPC/seed layers use guarded or upsert operations. Existing installations must use reviewed forward migrations rather than replaying a fresh-install schema over live data.

The schema source of truth is [`apps/api/src/db/schema/public.ts`](../../apps/api/src/db/schema/public.ts). Community release CI checks this bundle before publishing images; schema changes are treated as high-risk and never auto-promoted to production.

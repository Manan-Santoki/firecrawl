# Community release and promotion policy

## Current release status

- **Verified:** `community-v2.11.267.4` at source commit `3313474d2f6d597c963a45e1a9d43ad80ebb3876`.
- **Published artifacts:** API, Playwright, NuQ PostgreSQL, browser service and migrations images, each pinned by digest and carrying GitHub build-provenance attestations.
- **Qualification:** authenticated compatibility smoke plus a 30-minute concurrency-2 browser soak with 112 sessions created and closed, zero transient close failures and zero leaks.
- **Deployment scope:** isolated managed staging only. Production remains an explicit, separately audited manual promotion.
- **Superseded candidate:** `.3` failed browser-soak qualification and was not promoted; `.4` contains the public teardown/process-lifecycle repair.

## Update classes

| Class | Default action |
| --- | --- |
| Upstream patch release | Resolve and merge the exact semantic upstream tag commit, open a sync PR, run full community CI, deploy isolated staging, and run the compatibility suite. Production promotion is always manual. |
| Upstream minor or major release | Resolve the exact semantic tag commit, open a sync PR carrying `manual-release-review`, and require manual approval before staging and production. |
| Database, authentication, billing, rate-limit, queue or browser lifecycle change | Treat as high risk and require manual approval regardless of version number. |
| Documentation-only update | Merge after static validation; no production deployment. |

## Promotion invariants

1. Production deploys an immutable image digest, never a floating tag.
2. Staging and production use separate databases, queues, Redis namespaces, browser sessions, secrets and domains.
3. A database backup and a tested restore target exist before promotion. Database migrations are expand-only and forward-compatible with the previously verified application image; image rollback never claims to reverse schema state.
4. The compatibility report is attached to the release and records unavailable or degraded capabilities.
5. Failure preserves the previous production digest and opens an incident issue; it never retries an unsafe migration automatically.
6. A release name is derived only from an annotated or lightweight semantic upstream tag. The moving upstream `main` branch is never published under an older release name.
7. The hosted-v2 OpenAPI comparison has no missing operations. Extra community administration routes are informational and must remain outside hosted namespaces.

The private operations repository implements the provider-specific mechanics. This public policy remains the auditable contract.

# Community release and promotion policy

## Update classes

| Class | Default action |
| --- | --- |
| Upstream patch release | Resolve and merge the exact semantic upstream tag commit, open a sync PR, run full community CI, deploy isolated staging, run compatibility suite, then auto-promote only when no high-risk path changed. |
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

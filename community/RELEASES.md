# Community release and promotion policy

## Update classes

| Class | Default action |
| --- | --- |
| Upstream patch release | Open sync PR, run full community CI, deploy isolated staging, run compatibility suite, then auto-promote if every required check passes. |
| Upstream minor or major release | Open sync PR and require manual approval before staging and production. |
| Database, authentication, billing, rate-limit, queue or browser lifecycle change | Treat as high risk and require manual approval regardless of version number. |
| Documentation-only update | Merge after static validation; no production deployment. |

## Promotion invariants

1. Production deploys an immutable image digest, never a floating tag.
2. Staging and production use separate databases, queues, Redis namespaces, browser sessions, secrets and domains.
3. A database backup and a tested rollback target exist before promotion.
4. The compatibility report is attached to the release and records unavailable or degraded capabilities.
5. Failure preserves the previous production digest and opens an incident issue; it never retries an unsafe migration automatically.

The private operations repository implements the provider-specific mechanics. This public policy remains the auditable contract.

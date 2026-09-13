# Community release and promotion policy

## Current release status

- **Verified:** `community-v2.11.267.4` at source commit `3313474d2f6d597c963a45e1a9d43ad80ebb3876`.
- **Published artifacts:** API, Playwright, NuQ PostgreSQL, browser service and migrations images, each pinned by digest and carrying GitHub build-provenance attestations.
- **Qualification:** authenticated compatibility smoke plus a 30-minute concurrency-2 browser soak with 112 sessions created and closed, zero transient close failures and zero leaks.
- **Deployment scope:** isolated managed staging only. Production remains an explicit, separately audited manual promotion.
- **Superseded candidate:** `.3` failed browser-soak qualification and was not promoted; `.4` contains the public teardown/process-lifecycle repair.

## Sync configuration and provenance

Set the public repository secret `UPSTREAM_SYNC_TOKEN` to a fine-grained personal access token scoped only to `Manan-Santoki/firecrawl`, with **Contents: read/write** and **Workflows: read/write**. The checkout uses this credential for Git pushes, including the exact upstream mirror. The built-in `GITHUB_TOKEN` still handles issues, pull requests and explicit CI dispatch. Adding `actions: write` to workflow permissions does not grant permission to import workflow files. An absent credential fails early with setup instructions; an expired or insufficient token must be replaced in repository settings.

`community/upstream.json` records the exact integrated canonical tag and commit. Its initial `v2.11.289` entry records the source already integrated by PR #10 (and repeated by #11). Both were squash merges, which discarded canonical ancestry. Sync and release naming validate this record against the canonical tag, so squashing no longer causes duplicate imports or stale version labels. On the next sync branch, automation restores the recorded ancestor without changing the tree, then merges only the newer upstream changes and advances the record. Prefer **Create a merge commit** for sync PRs; never advance provenance for code that has not been integrated.

Community owns `.github/workflows`: sync preserves the workflow directory from community `main`, including its repository guards. Newly introduced upstream workflows are not imported into the community sync branch. The `upstream` mirror still points at the unmodified canonical release. Port useful upstream CI changes deliberately into community workflows. Source conflicts outside this directory remain blocking and produce one issue per upstream tag.

Existing release tags remain immutable. New releases use the recorded upstream version when runtime inputs change; a provenance-only correction does not rebuild runtime images.

The compatibility checker ignores the OpenAPI `bearerFormat` documentation hint when comparing HTTP authentication, but still rejects changed schemes, removed authentication, missing operations and incompatible schemas. The September 13 report also contains a missing `GET /agent` operation and other contract differences; correcting the hint does not certify hosted parity or authorize staging/production promotion.

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
8. An automated sync PR must have an executable `Community CI` run for its exact head commit. Because GitHub suppresses or approval-blocks workflows created by its own token, the sync workflow explicitly dispatches the check and deduplicates it by commit SHA.

The private operations repository implements the provider-specific mechanics. This public policy remains the auditable contract.

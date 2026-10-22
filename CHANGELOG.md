# Changelog

## 0.2.0 — 2026-10-22

Published as [GitHub release `v0.2.0`](https://github.com/qa-test-automation-frameworks/quality-reference-application/releases/tag/v0.2.0) from source [`e005b4415865c4029857a1066adf9b0f2474298e`](https://github.com/qa-test-automation-frameworks/quality-reference-application/commit/e005b4415865c4029857a1066adf9b0f2474298e). The immutable image digest, build receipt, and consumer evidence are in [Target identity](docs/target-identity.md).

### Added

- API v2 with a policy-advertised 500,000-cent claim limit while preserving the v1 1,000,000-cent limit.
- A first-party browser flow that reads the v2 limit and converts decimal amounts to integer cents.
- PostgreSQL-backed checks for row-lock contention, atomic audit writes, session expiry, readiness recovery, and in-process namespace reset admission.
- A scheduled and pull-request advisory disposition for production npm dependencies and both published Linux image architectures.
- Exact-image security exception records that require an owner, human approval, expiry, and evidence URL.

### Compatibility

- The seed fixture remains `v0.1.0`; no fixture data or initialization semantics changed.
- Published images are immutable, multi-platform targets. Consumers must pin the exact image digest and fixture version they verified.
- The current package version, source revision, image digest, build receipt, and consumer evidence are recorded in [Target identity](docs/target-identity.md).

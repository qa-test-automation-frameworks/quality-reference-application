# Changelog

## 0.2.0 — 2026-10-22

### Added

- API v2 with a policy-advertised 500,000-cent claim limit while preserving the v1 1,000,000-cent limit.
- A first-party browser flow that reads the v2 limit and converts decimal amounts to integer cents.
- PostgreSQL-backed checks for row-lock contention, atomic audit writes, session expiry, readiness recovery, and in-process namespace reset admission.

### Compatibility

- The seed fixture remains `v0.1.0`; no fixture data or initialization semantics changed.
- Published images are immutable, multi-platform targets. Consumers must pin the exact image digest and fixture version they verified.
- The current package version, source revision, image digest, build receipt, and consumer evidence are recorded in [Target identity](docs/target-identity.md).

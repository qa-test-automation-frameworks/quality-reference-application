# Quality Reference Application

A small synthetic policy-and-claims application used as an independently testable target by the QA portfolio. It exists to demonstrate complementary API, UI, browser-grid, performance, and evaluation checks across a versioned product change.

This is a local reference target, not an insurance service. It makes no real claim, coverage, financial, or production-security decisions. All identities, policies, claims, credentials, and amounts are fictional.

## Runtime and data boundaries

- Node.js `24.21.0` and npm `10.9.4` are pinned and checked before project tests. The container uses the official Node 24.21.0 Alpine image pinned to digest `sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2`.
- PostgreSQL `18.6` uses the official Alpine image pinned to digest `sha256:885cf05d376c7cf27afef02073e6bdac3841252537f16e244fd1c1e6a7c99fb1`.
- Each run must use a unique `COMPOSE_PROJECT_NAME`, `APP_NAMESPACE`, `APP_PORT`, and random test-control token. Compose keeps PostgreSQL on an internal data network and a dedicated volume; the app also joins a bridge network with only its port published to host loopback at `127.0.0.1`.
- Every data access includes the server-configured namespace. The reset route accepts no namespace in its request and deletes only the current run's records.
- Reset admission coordinates requests inside one application process only. Run one application instance per `APP_NAMESPACE`; separate instances must use different namespace values.
- Readiness recovery is checked with an injected query facade that fails and resumes `SELECT 1`; this does not claim recovery from an actual PostgreSQL process restart.
- Synthetic session and seed/reset endpoints return 404 unless `TEST_MODE=true`. Test mode assigns role server-side from the seeded identity; clients cannot set or elevate roles. The session token is random, expires, and is stored only as a SHA-256 digest. This mechanism is a local test fixture, not production authentication.
- `sourceRevision` is baked into the image at build time and included in readiness. The main-branch workflow publishes a multi-platform GitHub Container Registry image with SBOM/provenance and writes its immutable digest to the workflow summary. Consumer repositories pin that image digest and the fixture version; they do not follow a mutable tag or the app's default branch.

## Start one isolated local instance

Requirements: Node.js `24.21.0`, npm `10.9.4`, Docker Engine with Compose v2, and OpenSSL. Do not reuse the sample values below across runs.

```bash
export COMPOSE_PROJECT_NAME="qra-$(openssl rand -hex 6)"
export APP_NAMESPACE="run-$(openssl rand -hex 8)"
export APP_PORT=4300
export APP_SOURCE_SHA=working-tree
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export TEST_CONTROL_TOKEN="$(openssl rand -hex 32)"
npm ci
docker compose up --build -d
curl --fail http://127.0.0.1:${APP_PORT}/health/ready
```

Open `http://127.0.0.1:4300/`. Sign in as member A or B to view only that member's policy and submit a fictional claim. Sign in as reviewer to view claims and advance valid states. The API exposes status/audit events for deterministic assertions. Stop and remove the instance, network, and data volume with:

```bash
docker compose down --volumes --remove-orphans
unset COMPOSE_PROJECT_NAME APP_NAMESPACE APP_PORT APP_SOURCE_SHA POSTGRES_PASSWORD TEST_CONTROL_TOKEN
```

Run logs are structured JSON on stdout/stderr. Request bodies, authorization headers, cookies, and bearer tokens are never logged. Application shutdown closes HTTP and PostgreSQL resources with a five-second bound.

## Contract and verification

The API contract is [OpenAPI 3.1](openapi.yaml). API v1 preserves its 10,000 USD claim limit; additive API v2 caps claims at 5,000 USD and reports the limit with each policy. The browser UI uses v2 while existing v1 clients remain supported. Stable fields are status, error `code`, `correlationId`, IDs, claim state, version, and integer USD minor-unit amounts. Error `message` text is diagnostic and is not a compatibility key. The domain transition rules are independently tested in `tests/domain.test.js`; PostgreSQL-backed tests cover ownership, role assignment, audit persistence and rollback, same-version row-lock contention, optimistic version checks, session expiry, readiness recovery, namespace isolation and reset admission, control-token enforcement, and test-mode route disabling.

```bash
npm run check:runtime
npm run check:openapi
npm run test:unit
npm run test:integration
npm run verify
```

For local integration tests, export a disposable PostgreSQL `DATABASE_URL`, unique `APP_NAMESPACE`, and at least 32-byte `TEST_CONTROL_TOKEN`. The tests migrate and write only to that configured database and clean up their unique namespace. Never point them at a shared or production database.

The [CI and image workflow](.github/workflows/ci.yml) verifies two independent paths: PostgreSQL-backed API/domain checks and a Docker Compose smoke journey. After a successful push to `main`, it publishes `ghcr.io/qa-test-automation-frameworks/quality-reference-application` for `linux/amd64` and `linux/arm64`; use the `@sha256:…` digest in the workflow summary as the consumer target. The `sha-<commit>` tag is a lookup convenience, not the immutable identity.

The [security policy](SECURITY.md) points to the organization reporting route and defines the npm/image scan scope. The [advisory disposition guide](docs/security-advisories.md) explains the exact-digest gate, time-bounded exceptions, and evidence retained by CI.

The reference slice owns migrations, seed identities, OpenAPI, authorization and domain invariants. Consumers own their independently written expectations and test adapters. See [ADR 007](https://github.com/qa-test-automation-frameworks/.github/blob/main/docs/adr/007-shared-reference-application.md) for coverage boundaries and non-goals. App version `0.2.0` and fixture version `v0.1.0` are separate identifiers; every consumer must pin both the app image digest and fixture version. See [Target identity](docs/target-identity.md) for the published source, immutable image, readiness contract, and consumer evidence, the [A07 compatibility guide](docs/a07-policy-limit-compatibility.md) for the deliberate breaking control, compatible API change, cross-layer assertions, and rollback steps, and the [keyboard navigation contract](docs/keyboard-navigation.md) for the supported UI focus sequence.

The runtime image installs only production dependencies and removes the npm CLI and root lock/manifests after installation; the application runs with Node only.

Original application code is licensed under MIT; dependencies retain their own licenses. See [LICENSE](LICENSE) and the package metadata.

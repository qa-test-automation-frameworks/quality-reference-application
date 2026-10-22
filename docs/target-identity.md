# Published target identity

This page records the exact QRA release inputs so consumers can pin the same application and fixture that they verify. API version, package version, fixture version, source revision, and image digest are separate identifiers.

## Current versioned release

| Identity | Value |
| --- | --- |
| Application/package version | `0.2.0` |
| GitHub release | [`v0.2.0`](https://github.com/qa-test-automation-frameworks/quality-reference-application/releases/tag/v0.2.0) |
| API contracts | v1: 1,000,000 minor units; v2: 500,000 minor units |
| Fixture version | `v0.1.0` |
| Source revision | [`e005b4415865c4029857a1066adf9b0f2474298e`](https://github.com/qa-test-automation-frameworks/quality-reference-application/commit/e005b4415865c4029857a1066adf9b0f2474298e) |
| Immutable image | [`ghcr.io/qa-test-automation-frameworks/quality-reference-application@sha256:98642e84cd0ad94a48a2cced57e94bf3c9c1be295b4308a175b88f33c5db405c`](https://github.com/qa-test-automation-frameworks/quality-reference-application/pkgs/container/quality-reference-application) |
| Platforms | `linux/amd64`, `linux/arm64` |
| Build and publication receipt | [Main run 39753401824](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39753401824) |
| Build record | [Docker Buildx record artifact 12414996448](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39753401824/artifacts/12414996448) |
| Build record SHA-256 | `c17556bf6ccc6400e6609b493f6ebfeada6734d3915923fce2c11dd881eaf3dd` |

The release tag points to the source revision above. Main run 39753401824 passed hosted verification and published the image with SBOM and provenance attestations enabled. The versioned image label is `0.2.0`; `org.opencontainers.image.revision` is the source revision above. The Docker Buildx record is linked for the build inputs and trace. Later docs-only builds may produce a new source-tagged digest; that does not update a consumer pin or establish compatibility for that consumer.

## Release descriptor

Each successful `main` push that passes `verify` and publishes an immutable image uploads one `release-descriptor.json` (under 64 KiB) as the `qra-release-descriptor` Actions artifact, retained for 30 days. Schema version 1 binds the actual Buildx digest to the source SHA, run ID and attempt, package version, fixture version, supported API versions, and UTC generation time. Its stable run and artifact references are available to the read-only assurance verifier; signed download URLs are not retained.

## Readiness identity

`GET /health/ready` returns `status`, `sourceRevision`, `seedVersion`, and `datastore`. A consumer should require `status: "ready"`, match `sourceRevision` to the intended image source, match `seedVersion` to `v0.1.0`, and require `datastore: true`. The endpoint does not report the package version or image digest; use the image label and publication receipt for those values.

The hosted QRA verification and publication run [39753401824](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39753401824) passed the PostgreSQL suite, named datastore scenarios, mutation controls, and Compose readiness journey on the release source. Its readiness recovery test exercises an initial success, an injected unavailable response, and recovery. This verifies the injected query-facade recovery behavior; it does not claim an actual PostgreSQL process restart.

## Consumer evidence and retained targets

| Consumer or target | Exact target and evidence | Status |
| --- | --- | --- |
| Playwright shared UI | Image digest `sha256:0de7875e9c69d3e6f8954456b6f7c90160032395f87aee4d3d64e33307b062a9`, source `e90067b38bcd88fbb9118388f9fb8cc9dee6d493`; [PR #58 main run 39039485122](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39039485122) and [main run 39090674631](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39090674631) | Five of five shared-app UI cases passed. This remains a verified historical consumer pin; it predates the current versioned release image above. |
| Verity policy assistant | QRA 0.2.0 source-pinned integration, fixture `v0.1.0`; [PR #31 run 39033065135](https://github.com/qa-test-automation-frameworks/verity-policy-coverage-eval-framework/actions/runs/39033065135) | No-key integration passed. This is source-pinned evidence, not an image-digest compatibility claim; its separate security-exception review remains open. |
| QRA 0.1.0 recovery target | Image digest `sha256:284ae3fa4f2a31a4322b74a6f37e38f0d101879389c656bf1d553df7ec616469`, source `e9f438e06a2b092dccfc6e9ab1820ff2562ddad7`, fixture `v0.1.0`; [Playwright main run 39090674631](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39090674631) | Retain as the tested v1 recovery image until each consumer updates and verifies its own digest. |

The versioned release digest `98642e84…` passed QRA's hosted verification and publication workflow, but it has not yet received an independent consumer compatibility run. The Playwright row records an older digest that did pass consumer checks. Treat each consumer's exact digest and fixture pin as its own evidence boundary.

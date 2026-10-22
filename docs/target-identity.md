# Published target identity

This page records the exact QRA release inputs so consumers can pin the same application and fixture that they verify. API version, package version, fixture version, source revision, and image digest are separate identifiers.

## Current published build

| Identity | Value |
| --- | --- |
| Application/package version | `0.2.0` |
| API contracts | v1: 1,000,000 minor units; v2: 500,000 minor units |
| Fixture version | `v0.1.0` |
| Source revision | [`a0fab9ba2d69db1d1a3d85d762073f8343a218cf`](https://github.com/qa-test-automation-frameworks/quality-reference-application/commit/a0fab9ba2d69db1d1a3d85d762073f8343a218cf) |
| Immutable image | [`ghcr.io/qa-test-automation-frameworks/quality-reference-application@sha256:88c5c901958f9d70265045ae6f72515ddba518d9c6b36baa04161843655db24e`](https://github.com/qa-test-automation-frameworks/quality-reference-application/pkgs/container/quality-reference-application) |
| Platforms | `linux/amd64`, `linux/arm64` |
| Build and publication receipt | [Main run 39751574670](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39751574670#summary-119733534428) |
| Build record | [Docker Buildx record artifact 12413508625](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39751574670/artifacts/12413508625) |
| Build record SHA-256 | `67dd0062ead4d39d7d3adaa1be23042ef90d5ffa1a78c51d919464a1161a9ca5` |

The publisher receipt records that SBOM and provenance attestations were enabled. The versioned image label is `0.2.0`; `org.opencontainers.image.revision` is the source revision above. The Docker Buildx record is linked for the build inputs and trace. Later docs-only builds may produce a new source-tagged digest; that does not update a consumer pin or establish compatibility for that consumer.

## Readiness identity

`GET /health/ready` returns `status`, `sourceRevision`, `seedVersion`, and `datastore`. A consumer should require `status: "ready"`, match `sourceRevision` to the intended image source, match `seedVersion` to `v0.1.0`, and require `datastore: true`. The endpoint does not report the package version or image digest; use the image label and publication receipt for those values.

The hosted QRA verification and publication run [39751574670](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39751574670) passed both the PostgreSQL suite and Compose readiness journey. Its readiness recovery evidence recorded an initial 200, an injected unavailable 503, and a recovered 200, with `sourceRevision` `a0fab9ba2d69db1d1a3d85d762073f8343a218cf` and `seedVersion` `v0.1.0`. This verifies the injected query-facade recovery behavior; it does not claim an actual PostgreSQL process restart.

## Consumer evidence and retained targets

| Consumer or target | Exact target and evidence | Status |
| --- | --- | --- |
| Playwright shared UI | Image digest `sha256:0de7875e9c69d3e6f8954456b6f7c90160032395f87aee4d3d64e33307b062a9`, source `e90067b38bcd88fbb9118388f9fb8cc9dee6d493`; [PR #58 main run 39039485122](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39039485122) and [main run 39090674631](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39090674631) | Five of five shared-app UI cases passed. This remains a verified historical consumer pin; it is older than the current source-tagged image above. |
| Verity policy assistant | QRA 0.2.0 source-pinned integration, fixture `v0.1.0`; [PR #31 run 39033065135](https://github.com/qa-test-automation-frameworks/verity-policy-coverage-eval-framework/actions/runs/39033065135) | No-key integration passed. This is source-pinned evidence, not an image-digest compatibility claim; its separate security-exception review remains open. |
| QRA 0.1.0 recovery target | Image digest `sha256:284ae3fa4f2a31a4322b74a6f37e38f0d101879389c656bf1d553df7ec616469`, source `e9f438e06a2b092dccfc6e9ab1820ff2562ddad7`, fixture `v0.1.0`; [Playwright main run 39090674631](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39090674631) | Retain as the tested v1 recovery image until each consumer updates and verifies its own digest. |

The current source-tagged digest `88c5c901…` passed QRA's hosted verification and publication workflow, but it has not yet received an independent consumer compatibility run. Treat each consumer's exact digest and fixture pin as its own evidence boundary.

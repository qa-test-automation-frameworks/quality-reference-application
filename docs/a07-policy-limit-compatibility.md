# A07: Policy claim-limit change and compatibility evidence

## Change

The application release changes from `0.1.0` to `0.2.0`. API v1 remains available with its existing 1,000,000-cent ($10,000) limit. API v2 is additive and caps claims at 500,000 cents ($5,000). V2 policy reads include `claimAmountLimitMinor`, so clients can render limits from the contract rather than duplicating a hidden server constant. The first-party browser UI moves to v2; integrations that need the old behavior can keep calling v1.

The change is validation and contract-only: persisted claim rows, migrations, seed data, ownership rules, review transitions, and audit-event semantics are unchanged. Fixture version stays `v0.1.0` because its contents and initialization semantics did not change.

## Evidence sequence

1. **Green baseline:** commit `9e9f0349cadeb29988118958eec067fa5693d8af` adds a PostgreSQL integration assertion that v1 accepts 1,000,000 cents and rejects 1,000,001. Hosted baseline run `39007638338` passed.
2. **Deliberate red control:** commit `2a2c871b818d19a2cfdfe8b9e6718bac7430ca09` changed the existing v1 limit in place. Hosted run `39007706443` failed on the preserved v1 acceptance assertion (1,000,000 cents received a 422). This is expected evidence that the test detects the compatibility break; do not merge that state as a product release.
3. **Compatible repair:** retain the v1 acceptance test, introduce v2 with a separate 500,000-cent schema/domain bound, and move the UI to v2. The PostgreSQL integration test checks v2 at-limit acceptance, above-limit rejection, policy-advertised limit, v1 acceptance, ownership, reviewer authorization, version conflicts, and ordered audit events in the same runtime. [Hosted compatible CI run 39008067517](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39008067517) passed on source `3bc1c12abbbd4b891dc0cf09616253b86e90bae4`. Follow-up [run 39009486078](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39009486078) passed on `251f4452baeb9e33b85c04024a6ebf86ccf32fe7` after replacing floating-point conversion with exact decimal-text to integer cents. The browser pilot then caught that the imported `/amount.js` module was missing from the static asset allowlist; [run 39009733278](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39009733278) passed on `21af1f41561a6d83ae44933dd36d9daa5e6a6e4c` after adding that route and an integration assertion for its JavaScript MIME type.
4. **Consumer contract:** [Playwright PR #55](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/pull/55) pins the application source and checks that the form advertises/enforces $5,000 and submits at the limit. Hosted runs `39008732914`, `39008985100`, and `39009521636` exposed the ambiguous heading, floating-point conversion, and missing JavaScript module route. These are fixed in PR #55; consumer run `39009747203` passed all five browser tests against source `21af1f41561a6d83ae44933dd36d9daa5e6a6e4c`, and all current PR checks passed. [Verity PR #31](https://github.com/qa-test-automation-frameworks/verity-policy-coverage-eval-framework/pull/31) reads v2 policy limits and cites the versioned policy section in a no-key assistant test; its latest [hosted integration run `39015728179`](https://github.com/qa-test-automation-frameworks/verity-policy-coverage-eval-framework/actions/runs/39015728179) passed against the pinned app and PostgreSQL. The wider Verity PR remains blocked by unresolved dependency and image-security checks under R02; passing this isolated integration does not make the PR or security posture green.

5. **Published artifact consumer check:** [Playwright PR #56](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/pull/56) replaces the source build with a pull of the immutable `0.2.0` image digest below and checks its OCI source-revision label. [Hosted run `39024915611`](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39024915611) passed the complete required suite, including `shared-app-ui`: the digest pull, source label, isolated PostgreSQL, runtime readiness, browser flow and schema-v3 evidence all passed. The evidence reports five selected and five passed UI cases, zero failures/skips, and target revision `oci:sha256:88d550587cdb0f07cf5c3b5afad1162641196f07e70afae25f568fb402d73c26`. PR #56 is open and CLEAN; its merge is still pending, so this is verified branch evidence rather than default-main consumer state.

## Published release and tested source identity

Default `main` at `30375e5250ae33dde6f0041f7a40f2c8af86b40e` passed [verification and multi-platform publication run `39014891864`](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39014891864). The public image is
`ghcr.io/qa-test-automation-frameworks/quality-reference-application:sha-30375e5250ae33dde6f0041f7a40f2c8af86b40e` at immutable digest
`sha256:88d550587cdb0f07cf5c3b5afad1162641196f07e70afae25f568fb402d73c26` for `linux/amd64` and `linux/arm64`. Anonymous GHCR manifest retrieval returned HTTP 200.

The earlier Playwright run and the Verity consumer run cited above pin source
commit `21af1f41561a6d83ae44933dd36d9daa5e6a6e4c`. It is an ancestor of the
published default-main commit; the only difference is a four-line documentation
change in this guide. Those earlier runs validate app code and v2 behavior, but
do not test the published image digest. Playwright PR #56 now provides that
exact-artifact check; Verity remains source-pinned while its security-blocked PR
is under review. Consumer targets stay explicitly versioned, without requiring
every repository to move to APP `0.2.0` at once.

## Risk map

| Surface | Intended effect | Main failure mode | Evidence |
|---|---|---|---|
| API v1 | No behavior change; retain $10,000 acceptance | In-place validation change breaks deployed clients | Baseline and intentional red-control runs; v1 pass in compatible PostgreSQL suite |
| API v2 | Add a $5,000 cap and report the limit on policies | Server/schema/UI disagree at the boundary | OpenAPI contract and PostgreSQL boundary test |
| Browser UI | Switch first-party requests to v2 and set its native form maximum from policy data | Client shows a stale limit or rejects valid decimal cents | Playwright PR #55 boundary tests and PR #56 exact-digest consumer job |
| Verity assistant | Read v2 workspace data and cite the v2 policy limit | Stale corpus or unsupported answer/citation | No-key provider stub, v0.2.0 fixture, and PR #31 hosted integration |
| Persistence/review flow | No schema, ownership, or transition change | Versioned route bypasses existing authorization/event rules | PostgreSQL v2 workflow test in run 39008067517 |
| Performance | No query, storage, or concurrency path change; only bounded request validation and policy metadata | An unsubstantiated claim of “no impact” | No performance claim is made; a K6 run is not a mandatory A07 gate for this change |

## Compatibility matrix

| Consumer/target | API version | Limit | Expected behavior |
|---|---|---:|---|
| APP `0.1.0` | v1 | $10,000 | Existing published contract |
| APP `0.2.0` | v1 | $10,000 | Kept for existing clients |
| APP `0.2.0` | v2 | $5,000 | New contract; policy response advertises 500,000 cents |
| APP `0.2.0` browser UI | v2 | $5,000 | Uses the v2 advertised value for the native input bound |
| Verity assistant corpus/tool `v0.2.0`/`v2` | v2 | $5,000 | Reads the returned limit and cites the matching retrieved section |

The old immutable APP image remains the rollback target. Consumer source pins are explicit; other repositories do not have to move to APP `0.2.0` as part of this change.

## Review checks

- API v1: 1,000,000 cents succeeds; 1,000,001 is rejected.
- API v2: policy response advertises 500,000; 500,000 succeeds; 500,001 is rejected.
- The browser submits to v2, sets the native input maximum from the API response, and converts decimal text to integer cents without floating-point arithmetic.
- Existing authorization, namespace isolation, reviewer workflow, concurrency versioning, and event history tests remain green for both v1 and v2 routes.
- OpenAPI describes both contracts and CI validates required paths and bounds.
- Image metadata labels the app release `0.2.0`; seed/readiness remains `v0.1.0`.
- No migration or database data rewrite is required. No performance gate is mandatory: the versioned cap changes bounded request validation and response metadata, without changing database queries, persistence, or concurrency. No performance claim is made; use the K6 workload only if a measured performance risk is later identified.

## Rollback

1. Revert the compatible application commit(s) on the feature branch and rerun hosted CI before publishing. Do not revert only the UI if it would continue sending requests to v2 that no longer exists.
2. If a published `0.2.0` image must be withdrawn operationally, pin consumers back to the previously verified immutable image `ghcr.io/qa-test-automation-frameworks/quality-reference-application@sha256:284ae3fa4f2a31a4322b74a6f37e38f0d101879389c656bf1d553df7ec616469` (source `e9f438e06a2b092dccfc6e9ab1820ff2562ddad7`) and fixture `v0.1.0`.
3. No database rollback is needed: the change does not alter schema or stored records. Re-run each consumer's setup, API, browser, and load checks after changing its pinned digest.

The prior image is a recovery target. The published `0.2.0` digest has passed the Playwright consumer flow on PR #56; that PR remains open pending merge, while Verity's separate assistant integration remains source-pinned and its broader PR is blocked by R02 security findings.

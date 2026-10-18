# A07: Policy claim-limit change and compatibility evidence

## Change

The application release changes from `0.1.0` to `0.2.0`. API v1 remains available with its existing 1,000,000-cent ($10,000) limit. API v2 is additive and caps claims at 500,000 cents ($5,000). V2 policy reads include `claimAmountLimitMinor`, so clients can render limits from the contract rather than duplicating a hidden server constant. The first-party browser UI moves to v2; integrations that need the old behavior can keep calling v1.

The change is validation and contract-only: persisted claim rows, migrations, seed data, ownership rules, review transitions, and audit-event semantics are unchanged. Fixture version stays `v0.1.0` because its contents and initialization semantics did not change.

## Evidence sequence

1. **Green baseline:** commit `9e9f0349cadeb29988118958eec067fa5693d8af` adds a PostgreSQL integration assertion that v1 accepts 1,000,000 cents and rejects 1,000,001. Hosted baseline run `39007638338` passed.
2. **Deliberate red control:** commit `2a2c871b818d19a2cfdfe8b9e6718bac7430ca09` changed the existing v1 limit in place. Hosted run `39007706443` failed on the preserved v1 acceptance assertion (1,000,000 cents received a 422). This is expected evidence that the test detects the compatibility break; do not merge that state as a product release.
3. **Compatible repair:** retain the v1 acceptance test, introduce v2 with a separate 500,000-cent schema/domain bound, and move the UI to v2. The PostgreSQL integration test checks v2 at-limit acceptance, above-limit rejection, policy-advertised limit, v1 acceptance, ownership, reviewer authorization, version conflicts, and ordered audit events in the same runtime. [Hosted compatible CI run 39008067517](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39008067517) passed on source `3bc1c12abbbd4b891dc0cf09616253b86e90bae4`. Follow-up [run 39009486078](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39009486078) passed on `251f4452baeb9e33b85c04024a6ebf86ccf32fe7` after replacing floating-point conversion with exact decimal-text to integer cents. The browser pilot then caught that the imported `/amount.js` module was missing from the static asset allowlist; [run 39009733278](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39009733278) passed on `21af1f41561a6d83ae44933dd36d9daa5e6a6e4c` after adding that route and an integration assertion for its JavaScript MIME type.
4. **Consumer contract:** [Playwright PR #55](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/pull/55) pins the application source and checks that the form advertises/enforces $5,000 and submits at the limit. Hosted runs `39008732914`, `39008985100`, and `39009521636` exposed the ambiguous heading, floating-point conversion, and missing JavaScript module route. These are fixed in PR #55; consumer run `39009747203` passed all five browser tests against source `21af1f41561a6d83ae44933dd36d9daa5e6a6e4c`, and all current PR checks passed. [Verity PR #31](https://github.com/qa-test-automation-frameworks/verity-policy-coverage-eval-framework/pull/31) reads v2 policy limits and cites the versioned policy section in a no-key assistant test. Exact-head [run `39033065135`](https://github.com/qa-test-automation-frameworks/verity-policy-coverage-eval-framework/actions/runs/39033065135) passed against the pinned app and PostgreSQL. PR #31 remains draft pending human review of its time-bounded security exceptions under R02; passing this isolated integration does not complete that review.

5. **Published artifact consumer check:** Playwright PR #56 merged as `4033f5a`. Its post-merge [main run `39028370946`](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39028370946) passed the complete required suite, including `shared-app-ui`: digest pull, OCI source label, isolated PostgreSQL, runtime readiness, browser flow and schema-v3 evidence. It passed five of five UI cases against the earlier immutable digest `sha256:88d550587cdb0f07cf5c3b5afad1162641196f07e70afae25f568fb402d73c26` at source `30375e5`. The trusted publisher [run `39028636093`](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39028636093) also passed. Playwright PR #57 passed its main consumer run on the app digest from source `c0018c1`; its latest-digest follow-up PR #58 was merged as `800b731`. The post-merge [main CI run `39039485122`](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39039485122) passed five of five shared-app cases and the 20-sample current-code compatibility study against the immutable app digest below. Trusted publisher [run `39039891632`](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39039891632) passed and published all nine evidence scopes with checksums validated. The [dashboard deployment `39039999547`](https://github.com/qa-test-automation-frameworks/.github/actions/runs/39039999547) reports this Playwright source as current-code compatible. Later docs-only app commits may publish additional image digests for unchanged product code, so consumers pin and test exact digests.

## Published release and tested source identity

Default `main` at `30375e5250ae33dde6f0041f7a40f2c8af86b40e` passed [verification and multi-platform publication run `39014891864`](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39014891864). The public image is
`ghcr.io/qa-test-automation-frameworks/quality-reference-application:sha-30375e5250ae33dde6f0041f7a40f2c8af86b40e` at immutable digest
`sha256:88d550587cdb0f07cf5c3b5afad1162641196f07e70afae25f568fb402d73c26` for `linux/amd64` and `linux/arm64`. Anonymous GHCR manifest retrieval returned HTTP 200.

The later docs-only release commit `c0018c1e50de55a66bb8b846d905a3d72e30e7b1` passed [default-main verification and image publication run `39028361087`](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39028361087). The immutable digest tested by Playwright PR #57 is
`ghcr.io/qa-test-automation-frameworks/quality-reference-application@sha256:20db5afded9fcec74b373d7e1de01efd8211a73ef0a811b3f7d30a0877cd70c9`; it supports `linux/amd64` and `linux/arm64`. Its application source is unchanged from the prior v2 product release; this digest records the newer image metadata and documentation revision. Playwright PR #57 tested this exact digest on its merge ref. The image workflow publishes a source-tagged artifact on every default-branch push, including docs-only commits, so later digests may represent unchanged product code. Verity stays explicitly source-pinned until its PR #31 security exception review is accepted. Consumer targets remain versioned; repositories do not have to move to APP `0.2.0` in lockstep.

The current published app source is `e90067b38bcd88fbb9118388f9fb8cc9dee6d493`; [default-main verification and image publication run `39036763813`](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39036763813) published
`ghcr.io/qa-test-automation-frameworks/quality-reference-application@sha256:0de7875e9c69d3e6f8954456b6f7c90160032395f87aee4d3d64e33307b062a9` for `linux/amd64` and `linux/arm64`. Playwright PR #58 and its merged-main run `39039485122` tested this exact digest. This paragraph supersedes the earlier digest for current-consumer status; the earlier immutable releases remain useful historical evidence.

## Risk map

| Surface                 | Intended effect                                                                                    | Main failure mode                                           | Evidence                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API v1                  | No behavior change; retain $10,000 acceptance                                                      | In-place validation change breaks deployed clients          | Baseline and intentional red-control runs; v1 pass in compatible PostgreSQL suite                                                                                         |
| API v2                  | Add a $5,000 cap and report the limit on policies                                                  | Server/schema/UI disagree at the boundary                   | OpenAPI contract and PostgreSQL boundary test                                                                                                                             |
| Browser UI              | Switch first-party requests to v2 and set its native form maximum from policy data                 | Client shows a stale limit or rejects valid decimal cents   | Playwright PR #55 boundary tests, PR #56 post-merge main run, PR #57 migration proof, and PR #58 post-merge exact-current-digest suite plus 20-sample compatibility study |
| Verity assistant        | Read v2 workspace data and cite the v2 policy limit                                                | Stale corpus or unsupported answer/citation                 | No-key provider stub, v0.2.0 fixture, and PR #31 hosted integration                                                                                                       |
| Persistence/review flow | No schema, ownership, or transition change                                                         | Versioned route bypasses existing authorization/event rules | PostgreSQL v2 workflow test in run 39008067517                                                                                                                            |
| Performance             | No query, storage, or concurrency path change; only bounded request validation and policy metadata | An unsubstantiated claim of “no impact”                     | No performance claim is made; a K6 run is not a mandatory A07 gate for this change                                                                                        |

## Compatibility matrix

| Consumer/target                            | API version |   Limit | Expected behavior                                                 |
| ------------------------------------------ | ----------- | ------: | ----------------------------------------------------------------- |
| APP `0.1.0`                                | v1          | $10,000 | Existing published contract                                       |
| APP `0.2.0`                                | v1          | $10,000 | Kept for existing clients                                         |
| APP `0.2.0`                                | v2          |  $5,000 | New contract; policy response advertises 500,000 cents            |
| APP `0.2.0` browser UI                     | v2          |  $5,000 | Uses the v2 advertised value for the native input bound           |
| Verity assistant corpus/tool `v0.2.0`/`v2` | v2          |  $5,000 | Reads the returned limit and cites the matching retrieved section |

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

The rollback target was first exercised in [PR #59 run
`39046808684`](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39046808684),
then merged in commit `ed2bfd08d79204d5de07ca6b5d8e6b97f678d745`. The required
default-branch `shared-app-rollback` job passed in [main CI run
`39090674631`](https://github.com/qa-test-automation-frameworks/playwright-typescript-framework/actions/runs/39090674631).
It verified the old digest's source label and readiness identity, then accepted
1,000,000 cents and rejected 1,000,001 through API v1. The main-run summary is
available as the run's `shared-app-rollback-proof` artifact; SHA-256:
`2220f51a0f7ef56862ab33cb3dc844f1b7386b9585de83debad39766b1ce1e7a`.

The prior image is a recovery target. The immutable `0.2.0` digest from app source `e90067b` passed the post-merge Playwright run `39039485122`, including five of five shared-app UI cases and a 20-sample compatibility study; all nine trusted evidence scopes were published and checksum-validated by run `39039891632`. The default-branch Playwright run `39090674631` again passed five of five shared-app cases against that exact digest and passed the rollback job against the prior digest. The dashboard deployment `39039999547` reports the earlier consumer revision as compatible with current product code. App guide PR #4 merged as `49ee744`; its verification and multi-platform publication run `39090673927` passed and produced docs-source image digest `sha256:84d2db4e4420f5c0873657c3c184a7207ff65f06e6316e407f900ace62e29292` for `linux/amd64` and `linux/arm64`. The merge changed documentation only; the tested product code is unchanged. Verity's assistant integration passes its isolated hosted test, while PR #31 remains draft pending independent review of the R02 security disposition. A07 remains open until A06 is closed and the compatibility/rollback story is reviewed against the final integration state.

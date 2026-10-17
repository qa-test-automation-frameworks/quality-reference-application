# A07: Policy claim-limit change and compatibility evidence

## Change

The application release changes from `0.1.0` to `0.2.0`. API v1 remains available with its existing 1,000,000-cent ($10,000) limit. API v2 is additive and caps claims at 500,000 cents ($5,000). V2 policy reads include `claimAmountLimitMinor`, so clients can render limits from the contract rather than duplicating a hidden server constant. The first-party browser UI moves to v2; integrations that need the old behavior can keep calling v1.

The change is validation and contract-only: persisted claim rows, migrations, seed data, ownership rules, review transitions, and audit-event semantics are unchanged. Fixture version stays `v0.1.0` because its contents and initialization semantics did not change.

## Evidence sequence

1. **Green baseline:** commit `9e9f0349cadeb29988118958eec067fa5693d8af` adds a PostgreSQL integration assertion that v1 accepts 1,000,000 cents and rejects 1,000,001. Hosted baseline run `39007638338` passed.
2. **Deliberate red control:** commit `2a2c871b818d19a2cfdfe8b9e6718bac7430ca09` changed the existing v1 limit in place. Hosted run `39007706443` failed on the preserved v1 acceptance assertion (1,000,000 cents received a 422). This is expected evidence that the test detects the compatibility break; do not merge that state as a product release.
3. **Compatible repair:** retain the v1 acceptance test, introduce v2 with a separate 500,000-cent schema/domain bound, and move the UI to v2. The PostgreSQL integration test now checks v2 at-limit acceptance, above-limit rejection, policy-advertised limit, and v1 acceptance in the same runtime. Hosted compatible CI is the release gate; this guide must be updated with its final run URL and result before A07 is marked complete.
4. **Consumer contract:** Playwright UI coverage should verify that the form advertises and enforces $5,000 and can submit at the limit. K6 must continue its established workload against the same app release/digest and check its existing latency/error budgets. Verity should check the v2 policy limit and answer with a citation to the relevant policy/contract evidence. Record each consumer branch and hosted run in the portfolio ledger; a local result is not a substitute for hosted evidence.

## Review checks

- API v1: 1,000,000 cents succeeds; 1,000,001 is rejected.
- API v2: policy response advertises 500,000; 500,000 succeeds; 500,001 is rejected.
- The browser submits to v2 and sets the native input maximum from the API response.
- Existing authorization, namespace isolation, reviewer workflow, concurrency versioning, and event history tests remain green.
- OpenAPI describes both contracts and CI validates required paths and bounds.
- Image metadata labels the app release `0.2.0`; seed/readiness remains `v0.1.0`.
- No migration or database data rewrite is required. Performance impact is expected to be negligible because the changed path is bounded request validation and response metadata; make no performance claim without the existing K6 hosted run.

## Rollback

1. Revert the compatible application commit(s) on the feature branch and rerun hosted CI before publishing. Do not revert only the UI if it would continue sending requests to v2 that no longer exists.
2. If a published `0.2.0` image must be withdrawn operationally, pin consumers back to the previously verified immutable image `ghcr.io/qa-test-automation-frameworks/quality-reference-application@sha256:284ae3fa4f2a31a4322b74a6f37e38f0d101879389c656bf1d553df7ec616469` (source `e9f438e06a2b092dccfc6e9ab1820ff2562ddad7`) and fixture `v0.1.0`.
3. No database rollback is needed: the change does not alter schema or stored records. Re-run each consumer's setup, API, browser, and load checks after changing its pinned digest.

The prior image is a recovery target, not evidence that the new release has passed consumer compatibility checks. Update this guide with the immutable `0.2.0` digest and consumer run links only after publication and verification.

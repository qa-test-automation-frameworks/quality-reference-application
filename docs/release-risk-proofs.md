# Candidate release risk proofs

Trusted pushes to `main` publish a `qra-risk-proofs` artifact after the exact source has passed the normal verify job and the immutable image publish job. The risk-proof job runs the named native integration tests against the clean source, then applies one controlled source mutation at a time and requires the corresponding test to fail at its named business-risk assertion. The API v1 compatibility test must remain passing while the API v2 limit test detects its mutation.

The artifact contains one `risk-proofs.json` file with the candidate run, attempt, source SHA, image digest, exact native test IDs, result hashes, mutation patch hashes, and clean/mutated invocation identities. `mutatedTargetDigest` is a deterministic SHA-256 digest of the tracked mutated source tree, labeled `mutated-source-tree-v1`; it is distinct from the candidate OCI image digest. No mutated image is published.

The workflow uploads the artifact for 30 days. Each proof expires after seven days, matching the risk map freshness limit. A missing native test, skipped test, failed clean baseline, unrecognized mutation anchor, or undetected fault fails the job and cannot produce a complete proof packet.

The proof supports review of this synthetic QRA candidate and the named controls. It does not establish production identity-provider behavior or certify a production release.

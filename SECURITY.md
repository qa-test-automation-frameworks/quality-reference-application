# Security policy

This public application contains synthetic policies, claims, accounts, and test credentials. It is not an insurance service and does not make real coverage or financial decisions.

For reporting instructions and private vulnerability disclosures, follow the [organization security policy](https://github.com/qa-test-automation-frameworks/.github/blob/main/SECURITY.md). Do not include credentials, tokens, personal data, or non-public information in a public issue.

## Advisory scan scope

- `npm audit --omit=dev` evaluates the production dependency graph in `package-lock.json`. Development dependencies are handled by monthly Dependabot updates and the separate OS/library scan of the built image.
- Trivy evaluates operating-system and library vulnerabilities in both `linux/amd64` and `linux/arm64` images. On pull requests it scans local candidates; after publication it scans the exact child manifests joined to the published image-index digest.
- High and critical findings block the workflow unless an owner-reviewed exception matches the advisory, package URL, exact installed version, and exact image-index digest. Medium and lower findings remain visible with an explicit triage status.
- Scanner errors, malformed or missing reports, stale Trivy database metadata, and missing architecture scans are unavailable evidence and fail the gate. A passing configured scan does not prove the absence of every exploitable vulnerability.

See [advisory dispositions](docs/security-advisories.md) for scanner versions, evidence, and exception requirements.

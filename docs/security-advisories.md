# Dependency and image advisory dispositions

The [CI workflow](../.github/workflows/ci.yml) runs the advisory gate on every pull request and main push. A monthly run checks the current published image; manual runs can pin an exact source SHA and source-tagged or digest reference. On main, CI first scans locally built candidates, then publishes only after the candidate disposition and application checks pass. A final job scans the exact published image digest. The source-tagged image remains a candidate until that post-publication disposition succeeds.

## Scanner scope and evidence

- `npm audit --omit=dev --audit-level=low --json` evaluates the production lockfile. The report's exit code and JSON summary must agree, and every finding is joined to an exact version in `package-lock.json`.
- Trivy `v0.76.0`, installed through the organization-used Trivy action pinned at commit `ed142fd0673e97e23eac54620cfb913e5ce36c25`, scans OS and library vulnerabilities in both Linux architectures. Published scans resolve the source tag or publisher digest to the OCI index and then scan the exact `linux/amd64` and `linux/arm64` child manifests.
- The report records Trivy tool version and vulnerability database version, update, next-update, and download timestamps. npm's audit JSON exposes its report schema version and the time window of the registry query, but not the registry advisory database version or update time; the evidence says so instead of inventing one.
- CI retains the raw npm report and exit status, Trivy reports, image manifest, database metadata, and evaluated disposition summary as a run artifact. The summary joins the source SHA, image-index digest, architecture manifest digests, scanner status, and findings.

## Disposition policy

- High and critical findings block unless one exception matches the scanner, advisory ID, exact package URL, exact affected version, and exact image-index digest.
- Medium, low, and unknown-severity findings stay in the summary with `triage` status. They are not described as clean or silently suppressed.
- Missing, malformed, truncated, or failed scanner evidence; an unexpected architecture; or a stale/unavailable Trivy database yields `unavailable` and fails the gate.
- Build provenance and SBOM evidence are kept separate from vulnerability findings. Provenance alone cannot make an advisory scan pass.

`docs/security-exceptions.json` starts empty. An exception must satisfy [`schemas/security-exceptions.schema.json`](../schemas/security-exceptions.schema.json) and include the scanner, advisory ID, package URL, exact version, exact image-index digest, owner, rationale and exposure, compensating control, approver, approval and review timestamps, expiry, and an HTTPS evidence URL. Wildcards, malformed records, duplicates, or expired records fail policy. Adding an exception requires human review; this workflow does not generate approvals or infer that a finding is acceptable risk.

The [`SECURITY.md`](../SECURITY.md) file links the organization's private reporting route and defines what this image scan covers. A passing policy disposition is evidence about these scanners and this exact artifact, not a certification that the image contains no exploitable vulnerability.

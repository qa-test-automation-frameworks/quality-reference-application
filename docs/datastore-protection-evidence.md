# Datastore protection evidence

Q2's hosted PostgreSQL verification is recorded in [CI run 39750896134](https://github.com/qa-test-automation-frameworks/quality-reference-application/actions/runs/39750896134). It tested PR head `fab96686b51a174fea4417fbb8e06bca6b8a68fb` against the current main branch; the workflow ran on merge revision `4c0907f08a35dd9b997c2b7ed548901d4db99d6f`. PostgreSQL reported version 18.6 and ran from the pinned image `postgres:18.6-alpine3.23@sha256:885cf05d376c7cf27afef02073e6bdac3841252537f16e244fd1c1e6a7c99fb1`.

The focused native integration run passed all five Q2 tests with zero failures or skips. Its TAP output, sanitized state receipts, database version, and mutation logs are retained in the run's `q2-datastore-evidence-39750896134-1` artifact.

| Check | Observed result |
|---|---|
| Same-version writers | The second `FOR UPDATE` query waited on a PostgreSQL `transactionid` lock. Responses were one 200 and one 409 `VERSION_CONFLICT`; persisted claim status/version was `under_review`/2 with one event at version 2. |
| Failed audit insert on create | Generic 500; direct state read found zero claim rows and zero event rows for the designated claim. |
| Failed audit insert on transition | Generic 500; persisted claim remained `submitted`, version 1, with its initial event only. The response did not expose the trigger or SQL error. |
| Session expiry | Directly expired session returned 401 `SESSION_EXPIRED`; a newly issued session could still list its policy. |
| Readiness query recovery | An injected query facade returned 503 `NOT_READY` while `SELECT 1` failed, then returned 200 with unchanged source and seed identity when it recovered. This is not a PostgreSQL restart experiment. |
| Reset admission | Active API work caused reset and seed to return 409 `RESET_BUSY`. During reset, API access returned 503 `RESET_IN_PROGRESS`, a concurrent reset was rejected, and readiness/static requests stayed available. After reset, the previous session was invalid and the other namespace's identity, policy, claim, and event counts were unchanged. |

Both disposable mutation branches failed on their intended native assertion: removing `FOR UPDATE` removed the observed lock wait, and committing before the audit insert left a claim behind when the event insert failed. The mutation-control logs and run metadata are in the retained artifact.

Reset coordination is process-local. Separate application instances must use different namespaces; these tests do not claim cross-process reset safety.

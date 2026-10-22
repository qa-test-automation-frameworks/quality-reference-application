#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
evidence_root="${Q2_EVIDENCE_DIR:-$repo_root/work/audit-2026-10-21/Q2/controls}"
candidate_root="$(mktemp -d "${TMPDIR:-/tmp}/q2-mutations.XXXXXX")"
mkdir -p "$evidence_root"
declare -a candidate_worktrees=()
declare -a candidate_branches=()
cleanup() {
  for candidate in "${candidate_worktrees[@]}"; do
    git -C "$repo_root" worktree remove --force "$candidate" >/dev/null 2>&1 || true
  done
  for branch in "${candidate_branches[@]}"; do
    git -C "$repo_root" branch -D "$branch" >/dev/null 2>&1 || true
  done
  rm -rf "$candidate_root"
}
trap cleanup EXIT

: "${DATABASE_URL:?DATABASE_URL must point to the disposable hosted PostgreSQL service}"
if [[ "${TEST_MODE:-}" != "true" ]]; then
  echo 'Q2 mutation controls require TEST_MODE=true.' >&2
  exit 2
fi

Q2_EVIDENCE_METADATA="$evidence_root/run-metadata.json" node --input-type=module <<'NODE'
import { writeFile } from 'node:fs/promises';
import pg from 'pg';

const client = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { rows } = await client.query('SELECT version() AS version');
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const metadata = {
    package: 'Q2 datastore adversarial tests',
    repository: repository || 'local',
    revision: process.env.GITHUB_SHA || 'working-tree',
    sourceSha: process.env.APP_SOURCE_SHA || 'working-tree',
    runId: runId || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    runUrl: serverUrl && repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null,
    databaseVersion: rows[0].version,
    databaseImage: process.env.Q2_POSTGRES_IMAGE || null,
  };
  await writeFile(process.env.Q2_EVIDENCE_METADATA, `${JSON.stringify(metadata, null, 2)}\n`);
} finally {
  await client.end();
}
NODE

run_expected_failure() {
  local name="$1"
  local patch_file="$2"
  local test_pattern="$3"
  local expected_test="$4"
  local expected_failure="$5"
  local candidate="$candidate_root/$name"
  local log_file="$evidence_root/$name.log"
  local candidate_branch="q2-control-${name}-${GITHUB_RUN_ID:-local}-$$"
  candidate_branches+=("$candidate_branch")
  git -C "$repo_root" worktree add -b "$candidate_branch" "$candidate" HEAD
  candidate_worktrees+=("$candidate")
  ln -s "$repo_root/node_modules" "$candidate/node_modules"
  git -C "$candidate" apply --check "$repo_root/tests/mutations/$patch_file"
  git -C "$candidate" apply "$repo_root/tests/mutations/$patch_file"

  local exit_code=0
  (cd "$candidate" && node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern="$test_pattern" tests/integration.test.js) > "$log_file" 2>&1 || exit_code=$?
  if [[ "$exit_code" -eq 0 ]]; then
    echo "$name unexpectedly passed; the adversarial test did not catch the mutation." | tee -a "$log_file" >&2
    return 1
  fi
  local targeted_failures
  targeted_failures="$(grep -F " - $expected_test" "$log_file" | grep -Ec '^ *not ok ' || true)"
  local unexpected_failures
  unexpected_failures="$(grep -E '^ *not ok [0-9]+ - ' "$log_file" | grep -v -F " - $expected_test" | grep -v -F 'tests/integration.test.js' || true)"
  if [[ "$targeted_failures" -ne 1 || -n "$unexpected_failures" ]]; then
    echo "$name did not produce only its intended native failing test; inspect $log_file." >&2
    return 1
  fi
  if ! grep -Fq "$expected_test" "$log_file" || ! grep -Fq "$expected_failure" "$log_file"; then
    echo "$name failed outside the expected assertion; inspect $log_file." >&2
    return 1
  fi
  printf 'Expected failure confirmed: %s (%s)\n' "$name" "$expected_test" | tee -a "$evidence_root/mutation-summary.txt"
}

run_expected_failure \
  'remove-claim-row-lock' \
  'q2-remove-claim-row-lock.patch' \
  'same-version writers are actually queued behind the row lock' \
  'same-version writers are actually queued behind the row lock' \
  'did not observe a database row-lock wait within five seconds'

run_expected_failure \
  'bypass-write-transaction' \
  'q2-bypass-write-transaction.patch' \
  'claim creation and transition roll back when their audit event insert fails' \
  'claim creation and transition roll back when their audit event insert fails' \
  'claims: 1'

echo 'Both Q2 mutation controls failed on their intended native assertions.'

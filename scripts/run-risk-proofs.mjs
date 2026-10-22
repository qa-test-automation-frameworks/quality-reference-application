import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPOSITORY =
  'qa-test-automation-frameworks/quality-reference-application';
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]*$/;

export const RISK_CONTROLS = [
  {
    riskId: 'CLAIM_CROSS_MEMBER_DENIAL',
    controlId: 'cross-member-isolation',
    path: 'src/server.js',
    before: 'p.owner_id = $3::uuid)',
    after: 'p.owner_id = $3::uuid OR TRUE)',
    expectedNativeTestIds: [
      'persisted claim journey enforces identity ownership, reviewer transitions, concurrency, and run isolation',
    ],
    detectingTestId:
      'persisted claim journey enforces identity ownership, reviewer transitions, concurrency, and run isolation',
    expectedFailureMessage: 'member policy list must be identity-scoped',
    controlledFaultConfig: 'allow every seeded member to list every policy',
  },
  {
    riskId: 'CLAIM_VERSION_CONFLICT',
    controlId: 'stale-claim-version-rejection',
    path: 'src/server.js',
    before: 'claim.version !== input.expectedVersion',
    after: 'false',
    expectedNativeTestIds: [
      'persisted claim journey enforces identity ownership, reviewer transitions, concurrency, and run isolation',
    ],
    detectingTestId:
      'persisted claim journey enforces identity ownership, reviewer transitions, concurrency, and run isolation',
    expectedFailureMessage: 'stale versions must return a conflict',
    controlledFaultConfig:
      'disable the stale expectedVersion conflict predicate',
  },
  {
    riskId: 'API_V1_V2_CLAIM_LIMITS',
    controlId: 'a07-policy-limit-compatibility',
    path: 'src/domain.js',
    before: 'API_V2_CLAIM_LIMIT_MINOR = 500_000',
    after: 'API_V2_CLAIM_LIMIT_MINOR = 1_000_000',
    expectedNativeTestIds: [
      'compatibility contract: API v1 accepts the published 10,000 USD claim limit',
      'API v2 caps claims at 5,000 USD while API v1 keeps its 10,000 USD contract',
    ],
    mustRemainPassingTestIds: [
      'compatibility contract: API v1 accepts the published 10,000 USD claim limit',
    ],
    detectingTestId:
      'API v2 caps claims at 5,000 USD while API v1 keeps its 10,000 USD contract',
    expectedFailureMessage: 'API v2 must publish the 5,000 USD limit',
    controlledFaultConfig: 'raise the API v2 claim limit to the API v1 limit',
  },
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseTapResults(output) {
  const results = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^(ok|not ok)\s+\d+\s+-\s+(.+)$/.exec(line);
    if (!match) continue;
    const skipped = /\s+#\s*(?:SKIP|TODO)\b/.test(match[2]);
    const title = match[2]
      .replace(/\s+#.*$/, '')
      .replace(/\s+\d+(?:\.\d+)?ms$/, '')
      .trim();
    results.set(
      title,
      skipped ? 'skipped' : match[1] === 'ok' ? 'passed' : 'failed',
    );
  }
  return results;
}

export function hashSourceTreeFiles(files) {
  requireValue(
    Array.isArray(files) && files.length > 0,
    'Mutation source tree must contain tracked files.',
  );
  const hash = createHash('sha256');
  hash.update('qra-source-tree-v1\0');
  for (const entry of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    requireValue(
      typeof entry.path === 'string' &&
        entry.path.length > 0 &&
        !entry.path.startsWith('/') &&
        !entry.path.split('/').includes('..'),
      'Mutation source tree contains an unsafe path.',
    );
    const pathBytes = Buffer.from(entry.path);
    const contentBytes = Buffer.from(entry.content);
    hash.update(`${pathBytes.length}:`);
    hash.update(pathBytes);
    hash.update(`${contentBytes.length}:`);
    hash.update(contentBytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function trackedSourceTreeDigest() {
  const listing = spawnSync('git', ['ls-files', '-z'], {
    cwd: process.cwd(),
    encoding: 'buffer',
  });
  requireValue(
    listing.status === 0,
    'Could not enumerate the candidate source tree.',
  );
  const paths = listing.stdout.toString('utf8').split('\0').filter(Boolean);
  const files = await Promise.all(
    paths.map(async (path) => {
      const metadata = await lstat(path);
      const content = metadata.isSymbolicLink()
        ? await readlink(path)
        : await readFile(path);
      return {
        path,
        content: Buffer.from(content),
        mode: metadata.mode & 0o777,
        symbolicLink: metadata.isSymbolicLink(),
      };
    }),
  );
  return hashSourceTreeFiles(
    files.map((file) => ({
      path: `${file.symbolicLink ? 'link' : `mode-${file.mode.toString(8)}`}/${file.path}`,
      content: file.content,
    })),
  );
}

function runNativeTests(testIds, environment) {
  const result = spawnSync(
    process.execPath,
    nativeTestArguments(testIds),
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: environment,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error)
    throw new Error(
      `Native QRA test process could not start (${result.error.name}).`,
    );
  if (result.signal)
    throw new Error(`Native QRA test process stopped by ${result.signal}.`);
  return {
    exitCode: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    results: parseTapResults(`${result.stdout ?? ''}${result.stderr ?? ''}`),
  };
}

export function nativeTestArguments(testIds) {
  const pattern = `^(?:${testIds.map(escapeRegex).join('|')})$`;
  return [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    '--test-name-pattern',
    pattern,
    'tests/integration.test.js',
  ];
}

async function applyControlledMutation(control) {
  const source = await readFile(control.path, 'utf8');
  const occurrences = source.split(control.before).length - 1;
  requireValue(
    occurrences === 1,
    `Expected one controlled mutation anchor in ${control.path}.`,
  );
  await writeFile(control.path, source.replace(control.before, control.after));
  return async () => {
    const patch = spawnSync(
      'git',
      ['diff', '--no-ext-diff', '--binary', '--', control.path],
      {
        cwd: process.cwd(),
        encoding: 'buffer',
        maxBuffer: 1024 * 1024,
      },
    );
    let mutatedTargetDigest;
    try {
      mutatedTargetDigest = await trackedSourceTreeDigest();
    } finally {
      await writeFile(control.path, source);
    }
    requireValue(
      patch.status === 0 && patch.stdout.length > 0,
      'Could not capture the controlled mutation patch.',
    );
    return { patchBytes: patch.stdout, mutatedTargetDigest };
  };
}

function testResultsSha256(results) {
  const canonical = [...results.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return sha256(Buffer.from(JSON.stringify(canonical)));
}

function createProof(
  control,
  sourceSha,
  candidateDigest,
  run,
  generatedAt,
  baselineRun,
  mutatedRun,
  mutationCapture,
) {
  const { patchBytes, mutatedTargetDigest } = mutationCapture;
  const baselineResults = baselineRun.results;
  const mutatedResults = mutatedRun.results;
  const patchSha256 = sha256(patchBytes);
  const observedNativeTestIds = control.expectedNativeTestIds.filter((id) =>
    mutatedResults.has(id),
  );
  const detectedNativeTestIds = control.expectedNativeTestIds.filter(
    (id) => mutatedResults.get(id) === 'failed',
  );
  const detected = mutatedResults.get(control.detectingTestId) === 'failed';
  return {
    schemaVersion: 1,
    riskId: control.riskId,
    controlId: control.controlId,
    repository: REPOSITORY,
    sourceSha,
    candidateDigest,
    detectorRepository: REPOSITORY,
    detectorFrameworkSha: sourceSha,
    expectedNativeTestIds: control.expectedNativeTestIds,
    cleanNativeTestIds: control.expectedNativeTestIds.filter(
      (id) => baselineResults.get(id) === 'passed',
    ),
    observedNativeTestIds,
    detectedNativeTestIds,
    cleanNativeResultsSha256: testResultsSha256(baselineResults),
    mutatedNativeResultsSha256: testResultsSha256(mutatedResults),
    cleanExitCode: baselineRun.exitCode,
    mutatedExitCode: mutatedRun.exitCode,
    outcome: detected ? 'detected' : 'not-detected',
    generatedAt,
    expiresAt: new Date(
      Date.parse(generatedAt) + 168 * 60 * 60 * 1000,
    ).toISOString(),
    mutation: {
      cleanCandidateDigest: candidateDigest,
      derivedFromCandidateSha: sourceSha,
      mutatedTargetSourceSha: sourceSha,
      mutatedTargetDigest,
      patchSha256,
      controlledFaultConfig: control.controlledFaultConfig,
      targetKind: 'mutated-source-tree-v1',
    },
    cleanRun: {
      ...run,
      sourceSha,
      jobName: 'risk-proof',
      execution: 'clean-candidate',
      resultSha256: testResultsSha256(baselineResults),
    },
    mutatedRun: {
      ...run,
      sourceSha,
      jobName: 'risk-proof',
      execution: control.controlId,
      resultSha256: testResultsSha256(mutatedResults),
    },
  };
}

export async function createRiskProofBundle({
  environment = process.env,
  outputPath,
} = {}) {
  const sourceSha = environment.GITHUB_SHA ?? '';
  const candidateDigest = environment.CANDIDATE_IMAGE_DIGEST ?? '';
  const runId = environment.GITHUB_RUN_ID ?? '';
  const attempt = Number(environment.GITHUB_RUN_ATTEMPT ?? '');
  requireValue(
    environment.GITHUB_REPOSITORY === REPOSITORY,
    'Risk proof job must run in the QRA repository.',
  );
  requireValue(
    SOURCE_SHA_PATTERN.test(sourceSha),
    'GITHUB_SHA must be a full QRA source SHA.',
  );
  requireValue(
    IMAGE_DIGEST_PATTERN.test(candidateDigest),
    'Published candidate image digest is missing or invalid.',
  );
  requireValue(
    NUMERIC_ID_PATTERN.test(runId) && Number.isSafeInteger(Number(runId)),
    'GITHUB_RUN_ID is invalid.',
  );
  requireValue(
    Number.isSafeInteger(attempt) && attempt > 0,
    'GITHUB_RUN_ATTEMPT is invalid.',
  );
  requireValue(
    typeof environment.DATABASE_URL === 'string' &&
      environment.DATABASE_URL.length > 0,
    'A disposable PostgreSQL DATABASE_URL is required for native risk tests.',
  );

  const run = { id: runId, attempt };
  const baselineIds = [
    ...new Set(
      RISK_CONTROLS.flatMap((control) => control.expectedNativeTestIds),
    ),
  ];
  const baseline = runNativeTests(baselineIds, {
    ...environment,
    APP_SOURCE_SHA: sourceSha,
    TEST_MODE: 'true',
  });
  const baselineMissing = baselineIds.filter(
    (id) => baseline.results.get(id) !== 'passed',
  );
  requireValue(
    baseline.exitCode === 0 && baselineMissing.length === 0,
    `Clean candidate native tests did not all pass: ${baselineMissing.join(', ') || 'runner error'}.`,
  );

  const generatedAt = new Date().toISOString();
  const proofs = [];
  for (const control of RISK_CONTROLS) {
    const restoreAndReadPatch = await applyControlledMutation(control);
    let mutated;
    let mutationCapture;
    try {
      mutated = runNativeTests(control.expectedNativeTestIds, {
        ...environment,
        APP_SOURCE_SHA: sourceSha,
        TEST_MODE: 'true',
      });
    } finally {
      mutationCapture = await restoreAndReadPatch();
    }
    const missing = control.expectedNativeTestIds.filter(
      (id) => !mutated.results.has(id),
    );
    requireValue(
      missing.length === 0,
      `Mutated run omitted native tests: ${missing.join(', ')}.`,
    );
    const positiveFailures = (control.mustRemainPassingTestIds ?? []).filter(
      (id) => mutated.results.get(id) !== 'passed',
    );
    requireValue(
      positiveFailures.length === 0,
      `Mutation broke positive native controls: ${positiveFailures.join(', ')}.`,
    );
    const proof = createProof(
      control,
      sourceSha,
      candidateDigest,
      run,
      generatedAt,
      baseline,
      mutated,
      mutationCapture,
    );
    requireValue(
      proof.mutation.mutatedTargetDigest !== candidateDigest,
      `Fault control ${control.controlId} did not produce a distinct mutation target identity.`,
    );
    proofs.push(proof);
    requireValue(
      proof.outcome === 'detected',
      `Fault control ${control.controlId} was not detected by its native test.`,
    );
    requireValue(
      mutated.output.includes(control.expectedFailureMessage),
      `Fault control ${control.controlId} did not fail at its named business-risk assertion.`,
    );
  }

  const bundle = {
    schemaVersion: 1,
    repository: REPOSITORY,
    sourceRun: run,
    sourceSha,
    candidateDigest,
    generatedAt,
    proofs,
  };
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, {
      flag: 'wx',
    });
  }
  return bundle;
}

async function main() {
  const outputPath =
    'work/audit-2026-10-21/NEW-ORG-01/risk-proofs/risk-proofs.json';
  const bundle = await createRiskProofBundle({ outputPath });
  console.log(
    `Recorded ${bundle.proofs.length} candidate-bound QRA fault controls.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

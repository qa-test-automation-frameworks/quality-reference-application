import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURE_VERSION, SUPPORTED_API_VERSIONS } from '../src/release-metadata.js';

const ORG = 'qa-test-automation-frameworks';
const REPOSITORY = `${ORG}/quality-reference-application`;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export async function readReleaseMetadata(root = new URL('../', import.meta.url)) {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  return {
    applicationVersion: packageJson.version,
    fixtureVersion: FIXTURE_VERSION,
    apiVersions: [...SUPPORTED_API_VERSIONS],
  };
}

export function createReleaseDescriptor({ env, imageDigest, metadata, generatedAt = new Date().toISOString() }) {
  const sourceSha = env.GITHUB_SHA;
  const runId = env.GITHUB_RUN_ID;
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error(`Expected ${REPOSITORY} as GITHUB_REPOSITORY.`);
  if (!SOURCE_SHA.test(sourceSha ?? '')) throw new Error('GITHUB_SHA must be the immutable 40-character source revision.');
  if (!RUN_ID.test(runId ?? '') || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('GitHub run ID and attempt are required.');
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Release descriptors can only be generated for a push to main.');
  if (env.GITHUB_SERVER_URL !== 'https://github.com') throw new Error('Release descriptors must use github.com run URLs.');
  if (!DIGEST.test(imageDigest ?? '')) throw new Error('The actual image build output must be an immutable sha256 digest.');
  if (!metadata || typeof metadata.applicationVersion !== 'string' || !VERSION.test(metadata.applicationVersion)
      || !/^v\d+\.\d+\.\d+$/.test(metadata.fixtureVersion ?? '')
      || !Array.isArray(metadata.apiVersions) || !metadata.apiVersions.length
      || metadata.apiVersions.some((version) => !['v1', 'v2'].includes(version))
      || new Set(metadata.apiVersions).size !== metadata.apiVersions.length) {
    throw new Error('Application, fixture, or supported API version metadata is incomplete.');
  }
  if (!Number.isFinite(Date.parse(generatedAt)) || !generatedAt.endsWith('Z')) throw new Error('generatedAt must be a UTC timestamp.');
  const descriptor = {
    schemaVersion: 1,
    repository: REPOSITORY,
    sourceSha,
    applicationVersion: metadata.applicationVersion,
    imageDigest,
    fixtureVersion: metadata.fixtureVersion,
    apiVersions: [...metadata.apiVersions],
    sourceRun: {
      id: runId,
      attempt,
      url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    },
    generatedAt,
  };
  const bytes = `${JSON.stringify(descriptor, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Release descriptor exceeds the 64 KiB limit.');
  return { descriptor, bytes };
}

async function main() {
  const outputIndex = process.argv.indexOf('--output');
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (!outputPath || process.argv.length !== outputIndex + 2) {
    throw new Error('Usage: node scripts/create-release-descriptor.mjs --output <path>');
  }
  const metadata = await readReleaseMetadata();
  const { bytes } = createReleaseDescriptor({ env: process.env, imageDigest: process.env.IMAGE_DIGEST, metadata });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { flag: 'wx' });
  console.log(`Wrote one bounded release descriptor for ${REPOSITORY} at ${process.env.GITHUB_SHA}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

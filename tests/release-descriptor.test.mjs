import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseDescriptor, readReleaseMetadata } from '../scripts/create-release-descriptor.mjs';

const env = {
  GITHUB_REPOSITORY: 'qa-test-automation-frameworks/quality-reference-application',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SERVER_URL: 'https://github.com',
};
const metadata = { applicationVersion: '0.2.0', fixtureVersion: 'v0.1.0', apiVersions: ['v1', 'v2'] };

test('descriptor uses the actual immutable image output and source-run identity', () => {
  const imageDigest = `sha256:${'b'.repeat(64)}`;
  const { descriptor, bytes } = createReleaseDescriptor({
    env, imageDigest, metadata, generatedAt: '2026-10-22T15:00:00.000Z',
  });
  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.repository, env.GITHUB_REPOSITORY);
  assert.equal(descriptor.sourceSha, env.GITHUB_SHA);
  assert.equal(descriptor.applicationVersion, '0.2.0');
  assert.equal(descriptor.imageDigest, imageDigest);
  assert.equal(descriptor.fixtureVersion, 'v0.1.0');
  assert.deepEqual(descriptor.apiVersions, ['v1', 'v2']);
  assert.deepEqual(descriptor.sourceRun, {
    id: env.GITHUB_RUN_ID,
    attempt: 2,
    url: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  });
  assert.equal(JSON.parse(bytes).sourceSha, env.GITHUB_SHA);
  assert.ok(Buffer.byteLength(bytes) < 64 * 1024);
});

test('descriptor metadata comes from the versioned application source', async () => {
  assert.deepEqual(await readReleaseMetadata(), metadata);
});

test('release descriptor rejects tags, pull requests, wrong repositories, and incomplete digests', () => {
  const valid = { env, imageDigest: `sha256:${'c'.repeat(64)}`, metadata };
  assert.throws(() => createReleaseDescriptor({ ...valid, imageDigest: 'ghcr.io/example:latest' }), /immutable sha256/);
  assert.throws(() => createReleaseDescriptor({ ...valid, env: { ...env, GITHUB_EVENT_NAME: 'pull_request' } }), /push to main/);
  assert.throws(() => createReleaseDescriptor({ ...valid, env: { ...env, GITHUB_REPOSITORY: 'other/project' } }), /GITHUB_REPOSITORY/);
  assert.throws(() => createReleaseDescriptor({ ...valid, metadata: { ...metadata, applicationVersion: 'latest' } }), /metadata is incomplete/);
  assert.throws(() => createReleaseDescriptor({ ...valid, metadata: { ...metadata, apiVersions: ['v1', 'v3'] } }), /metadata is incomplete/);
});

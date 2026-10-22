import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkOpenApiDocument, parseOpenApiDocument } from '../scripts/openapi-contract.js';
import { checkOpenApiFile } from '../scripts/check-openapi.js';

const source = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');
const document = parseOpenApiDocument(source, 'openapi.yaml');

const validFixtures = {
  session: {
    token: 'synthetic-token',
    tokenType: 'Bearer',
    expiresAt: '2026-10-22T08:30:00.000Z',
    user: { id: '22222222-2222-4222-8222-222222222222', role: 'member', displayName: 'Member A' },
  },
  policyList: {
    items: [{
      id: '11111111-1111-4111-8111-111111111111',
      policyNumber: 'POL-0001',
      seedVersion: 'v0.1.0',
      claimAmountLimitMinor: 500000,
    }],
  },
  claimCreate: {
    claim: {
      id: '33333333-3333-4333-8333-333333333333',
      policyId: '11111111-1111-4111-8111-111111111111',
      status: 'submitted',
      amountMinor: 150000,
      currency: 'USD',
      category: 'auto',
      version: 1,
      createdAt: '2026-10-22T08:30:00.000Z',
      updatedAt: '2026-10-22T08:30:00.000Z',
    },
  },
  eventList: {
    items: [{
      fromStatus: null,
      toStatus: 'submitted',
      claimVersion: 1,
      createdAt: '2026-10-22T08:30:00.000Z',
      actorDisplayName: 'Member A',
      actorRole: 'member',
    }],
  },
  error: {
    error: {
      code: 'VERSION_CONFLICT',
      message: 'The claim changed before this update.',
      correlationId: '44444444-4444-4444-8444-444444444444',
    },
  },
};

const cloneDocument = () => structuredClone(document);

test('accepts the actual OpenAPI document and all representative response fixtures', () => {
  const contract = checkOpenApiDocument(document);
  assert.deepEqual(contract.fixtureNames.sort(), ['claimCreate', 'error', 'eventList', 'policyList', 'session']);

  for (const [name, fixture] of Object.entries(validFixtures)) {
    assert.equal(contract.validateFixture(name, fixture).valid, true, `${name} should satisfy its response schema`);
  }
});

test('accepts additive fields in response objects', () => {
  const contract = checkOpenApiDocument(document);
  const fixture = { ...validFixtures.session, serverAddedField: { rollout: true } };
  assert.equal(contract.validateFixture('session', fixture).valid, true);
});

test('reports response fixture failures against their actual schema constraints', () => {
  const contract = checkOpenApiDocument(document);
  const missingAmount = structuredClone(validFixtures.claimCreate);
  delete missingAmount.claim.amountMinor;
  const missingResult = contract.validateFixture('claimCreate', missingAmount);
  assert.equal(missingResult.valid, false);
  assert.ok(missingResult.errors.some((error) => error.keyword === 'required'));

  const wrongAmountType = structuredClone(validFixtures.claimCreate);
  wrongAmountType.claim.amountMinor = '150000';
  const typeResult = contract.validateFixture('claimCreate', wrongAmountType);
  assert.equal(typeResult.valid, false);
  assert.ok(typeResult.errors.some((error) => error.keyword === 'type'));

  const invalidCorrelation = structuredClone(validFixtures.error);
  invalidCorrelation.error.correlationId = 'not-a-uuid';
  const formatResult = contract.validateFixture('error', invalidCorrelation);
  assert.equal(formatResult.valid, false);
  assert.ok(formatResult.errors.some((error) => error.keyword === 'format'));
});

test('parses valid YAML and rejects malformed YAML and duplicate keys', () => {
  assert.equal(parseOpenApiDocument('openapi: 3.1.0\ninfo: {}\npaths: {}\n').openapi, '3.1.0');
  assert.throws(() => parseOpenApiDocument('openapi: [\n', 'malformed fixture'), /YAML is invalid/);
  assert.throws(() => parseOpenApiDocument('openapi: 3.1.0\nopenapi: 3.1.0\n', 'duplicate fixture'), /duplicate/i);
});

test('rejects unresolved local and external references before linting', () => {
  assert.throws(() => parseOpenApiDocument('openapi: 3.1.0\npaths: {}\ncomponents:\n  schemas:\n    Broken: { $ref: "#/components/schemas/Missing" }\n'), /missing local reference/);
  assert.throws(() => parseOpenApiDocument('openapi: 3.1.0\npaths: {}\ncomponents:\n  schemas:\n    Remote: { $ref: "https://example.invalid/schema.json" }\n'), /must use a local JSON Pointer/);
  assert.throws(() => parseOpenApiDocument('openapi: 3.1.0\npaths: {}\ncomponents:\n  schemas:\n    InvalidEscape: { $ref: "#/components/schemas/Bad~2Name" }\n'), /invalid JSON Pointer escape/);
});

test('reports missing required path and method precisely', () => {
  const missingPath = cloneDocument();
  delete missingPath.paths['/health/ready'];
  assert.throws(() => checkOpenApiDocument(missingPath), /Required OpenAPI path is missing: \/health\/ready/);

  const missingMethod = cloneDocument();
  delete missingMethod.paths['/health/ready'].get;
  assert.throws(() => checkOpenApiDocument(missingMethod), /Required OpenAPI operation is missing: GET \/health\/ready/);
});

test('rejects incorrect v1 and v2 claim limits', () => {
  const swappedV1 = cloneDocument();
  swappedV1.paths['/api/v1/claims'].post.requestBody.content['application/json'].schema.properties.amountMinor.maximum = 500000;
  assert.throws(() => checkOpenApiDocument(swappedV1), /POST \/api\/v1\/claims amountMinor maximum must be 1000000/);

  const swappedV2 = cloneDocument();
  swappedV2.paths['/api/v2/claims'].post.requestBody.content['application/json'].schema.properties.amountMinor.maximum = 1000000;
  assert.throws(() => checkOpenApiDocument(swappedV2), /POST \/api\/v2\/claims amountMinor maximum must be 500000/);
});

test('requires amount and expectedVersion fields to have their contract types', () => {
  const optionalAmount = cloneDocument();
  optionalAmount.paths['/api/v1/claims'].post.requestBody.content['application/json'].schema.required =
    optionalAmount.paths['/api/v1/claims'].post.requestBody.content['application/json'].schema.required
      .filter((field) => field !== 'amountMinor');
  assert.throws(() => checkOpenApiDocument(optionalAmount), /POST \/api\/v1\/claims must require amountMinor/);

  const missingAmount = cloneDocument();
  missingAmount.paths['/api/v1/claims'].post.requestBody.content['application/json'].schema.properties.amountMinor.type = 'string';
  assert.throws(() => checkOpenApiDocument(missingAmount), /POST \/api\/v1\/claims amountMinor must be an integer/);

  const missingExpectedVersion = cloneDocument();
  const request = missingExpectedVersion.paths['/api/v2/claims/{claimId}'].patch.requestBody.content['application/json'].schema;
  request.required = request.required.filter((field) => field !== 'expectedVersion');
  assert.throws(() => checkOpenApiDocument(missingExpectedVersion), /must require expectedVersion/);

  const wrongExpectedVersionType = cloneDocument();
  wrongExpectedVersionType.paths['/api/v1/claims/{claimId}'].patch.requestBody.content['application/json'].schema.properties.expectedVersion.type = 'string';
  assert.throws(() => checkOpenApiDocument(wrongExpectedVersionType), /expectedVersion must be an integer/);
});

test('compiles a changed response schema and fails a fixture against that schema', () => {
  const wrongResponseSchema = cloneDocument();
  wrongResponseSchema.paths['/api/v2/claims'].post.responses['201'].content['application/json'].schema = { type: 'string' };
  const contract = checkOpenApiDocument(wrongResponseSchema);
  const result = contract.validateFixture('claimCreate', validFixtures.claimCreate);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.keyword === 'type'));
});

test('the CLI checker accepts a copied contract path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-openapi-'));
  const copiedSpec = path.join(directory, 'copied-openapi.yaml');
  try {
    await writeFile(copiedSpec, source);
    const copied = await checkOpenApiFile(copiedSpec, { lint: false });
    assert.equal(copied.openapi, '3.1.0');

    const invalidSpec = path.join(directory, 'invalid-openapi.yaml');
    await writeFile(invalidSpec, source.replace('openapi: 3.1.0', 'openapi: 3.0.0'));
    await assert.rejects(checkOpenApiFile(invalidSpec, { lint: false }), /OpenAPI version must be 3\.1\.0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

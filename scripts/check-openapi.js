import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const document = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');
assert.match(document, /^openapi: 3\.1\.0$/m);
for (const operation of [
  '/health/ready:', '/api/v1/sessions:', '/api/v1/policies:', '/api/v1/policies/{policyId}:',
  '/api/v1/claims:', '/api/v1/claims/{claimId}:', '/api/v1/claims/{claimId}/events:', '/__test/reset:',
]) assert.ok(document.includes(operation), `OpenAPI path missing: ${operation}`);
for (const stableContract of ['correlationId:', 'INVALID_TRANSITION', 'VERSION_CONFLICT', 'additionalProperties: false', 'expectedVersion:']) {
  assert.ok(document.includes(stableContract), `OpenAPI behavior missing: ${stableContract}`);
}
console.log('OpenAPI 3.1 contract contains all v0.1 operations and stable error/version fields.');

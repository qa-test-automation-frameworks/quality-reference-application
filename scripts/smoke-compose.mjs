import assert from 'node:assert/strict';

const baseUrl = process.env.APP_BASE_URL || 'http://127.0.0.1:4300';

async function request(path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: response.status === 204 ? null : await response.json() };
}

const ready = await request('/health/ready');
assert.equal(ready.response.status, 200, 'packaged application must become ready');
assert.equal(ready.payload.sourceRevision, process.env.APP_SOURCE_SHA, 'image must report the exact source revision');
assert.equal(ready.payload.seedVersion, 'v0.1.0');

const memberA = await request('/api/v1/sessions', { method: 'POST', body: { identityKey: 'member-a' } });
assert.equal(memberA.response.status, 201);
const memberAToken = memberA.payload.token;
const policies = await request('/api/v1/policies', { token: memberAToken });
assert.equal(policies.response.status, 200);
const policyId = policies.payload.items[0].id;

const memberB = await request('/api/v1/sessions', { method: 'POST', body: { identityKey: 'member-b' } });
assert.equal(memberB.response.status, 201);
const claim = await request('/api/v1/claims', {
  method: 'POST', token: memberAToken,
  body: { policyId, amountMinor: 12345, currency: 'USD', category: 'auto' },
});
assert.equal(claim.response.status, 201);
const claimId = claim.payload.claim.id;
assert.equal((await request(`/api/v1/claims/${claimId}`, { token: memberB.payload.token })).response.status, 404);

const reviewer = await request('/api/v1/sessions', { method: 'POST', body: { identityKey: 'reviewer' } });
assert.equal(reviewer.response.status, 201);
let transition = await request(`/api/v1/claims/${claimId}`, {
  method: 'PATCH', token: reviewer.payload.token,
  body: { status: 'under_review', expectedVersion: 1 },
});
assert.equal(transition.response.status, 200);
transition = await request(`/api/v1/claims/${claimId}`, {
  method: 'PATCH', token: reviewer.payload.token,
  body: { status: 'approved', expectedVersion: 2 },
});
assert.equal(transition.response.status, 200);
assert.equal(transition.payload.claim.status, 'approved');

process.stdout.write('Packaged container smoke passed: exact source identity, readiness, persisted claim, member isolation, and reviewer transitions.\n');

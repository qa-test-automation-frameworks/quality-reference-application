import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable PostgreSQL 18 database before running integration tests.');
process.env.APP_NAMESPACE = `test-${randomUUID()}`;
process.env.APP_SOURCE_SHA ||= 'integration-test';
process.env.TEST_MODE = 'true';
process.env.TEST_CONTROL_TOKEN = randomBytes(32).toString('hex');
const expectedSourceSha = process.env.APP_SOURCE_SHA;

const { createServer, initialize, close } = await import('../src/server.js');
const { pool, seedNamespace, SEED } = await import('../src/database.js');
const server = createServer();
let baseUrl;
let otherNamespace;

before(async () => {
  otherNamespace = `isolation-${randomUUID()}`;
  await initialize();
  await seedNamespace(otherNamespace);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/health/ready`);
  assert.equal(response.status, 200);
  const ready = await response.json();
  assert.deepEqual(ready, { status: 'ready', sourceRevision: expectedSourceSha, seedVersion: 'v0.1.0', datastore: true });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const namespace of [otherNamespace, process.env.APP_NAMESPACE]) {
    await pool.query('DELETE FROM sessions WHERE namespace_id = $1', [namespace]);
    await pool.query('DELETE FROM claim_events WHERE namespace_id = $1', [namespace]);
    await pool.query('DELETE FROM claims WHERE namespace_id = $1', [namespace]);
    await pool.query('DELETE FROM policies WHERE namespace_id = $1', [namespace]);
    await pool.query('DELETE FROM identities WHERE namespace_id = $1', [namespace]);
  }
  await close();
});

async function request(path, { method = 'GET', token, body, controlToken } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (controlToken) headers['x-test-control-token'] = controlToken;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

async function login(identityKey, extra = {}) {
  return request('/api/v1/sessions', { method: 'POST', body: { identityKey, ...extra } });
}

test('persisted claim journey enforces identity ownership, reviewer transitions, concurrency, and run isolation', async () => {
  const memberLogin = await login('member-a');
  assert.equal(memberLogin.response.status, 201);
  assert.equal(memberLogin.payload.user.role, 'member');
  const memberA = memberLogin.payload.token;

  const policyList = await request('/api/v1/policies', { token: memberA });
  assert.equal(policyList.response.status, 200);
  assert.equal(policyList.payload.items.length, 1);
  const policyId = policyList.payload.items[0].id;

  const forgedRole = await login('member-a', { role: 'reviewer' });
  assert.equal(forgedRole.response.status, 422);
  const unknownIdentity = await login('administrator');
  assert.equal(unknownIdentity.response.status, 422);
  const anonymous = await request('/api/v1/policies');
  assert.equal(anonymous.response.status, 401);

  const memberBLogin = await login('member-b');
  const memberB = memberBLogin.payload.token;
  const hiddenPolicy = await request(`/api/v1/policies/${policyId}`, { token: memberB });
  assert.equal(hiddenPolicy.response.status, 404);

  const created = await request('/api/v1/claims', {
    method: 'POST', token: memberA,
    body: { policyId, amountMinor: 8750, currency: 'USD', category: 'auto' },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.claim.amountMinor, 8750);
  assert.equal(created.payload.claim.status, 'submitted');
  const claimId = created.payload.claim.id;

  const foreignClaim = await request(`/api/v1/claims/${claimId}`, { token: memberB });
  assert.equal(foreignClaim.response.status, 404);
  const memberPatch = await request(`/api/v1/claims/${claimId}`, {
    method: 'PATCH', token: memberA, body: { status: 'approved', expectedVersion: 1 },
  });
  assert.equal(memberPatch.response.status, 403);

  const reviewerLogin = await login('reviewer');
  assert.equal(reviewerLogin.payload.user.role, 'reviewer');
  const reviewer = reviewerLogin.payload.token;
  const firstTransition = await request(`/api/v1/claims/${claimId}`, {
    method: 'PATCH', token: reviewer, body: { status: 'under_review', expectedVersion: 1 },
  });
  assert.equal(firstTransition.response.status, 200);
  assert.equal(firstTransition.payload.claim.version, 2);
  const staleUpdate = await request(`/api/v1/claims/${claimId}`, {
    method: 'PATCH', token: reviewer, body: { status: 'approved', expectedVersion: 1 },
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.payload.error.code, 'VERSION_CONFLICT');
  const approve = await request(`/api/v1/claims/${claimId}`, {
    method: 'PATCH', token: reviewer, body: { status: 'approved', expectedVersion: 2 },
  });
  assert.equal(approve.response.status, 200);
  assert.equal(approve.payload.claim.status, 'approved');
  assert.equal(approve.payload.claim.version, 3);
  const terminalUpdate = await request(`/api/v1/claims/${claimId}`, {
    method: 'PATCH', token: reviewer, body: { status: 'submitted', expectedVersion: 3 },
  });
  assert.equal(terminalUpdate.response.status, 409);
  assert.equal(terminalUpdate.payload.error.code, 'INVALID_TRANSITION');

  const finalClaim = await request(`/api/v1/claims/${claimId}`, { token: memberA });
  assert.equal(finalClaim.payload.claim.status, 'approved');
  const events = await request(`/api/v1/claims/${claimId}/events`, { token: reviewer });
  assert.deepEqual(events.payload.items.map((event) => [event.fromStatus, event.toStatus, event.claimVersion]), [
    [null, 'submitted', 1], ['submitted', 'under_review', 2], ['under_review', 'approved', 3],
  ]);
  assert.equal(events.payload.items[2].actorRole, 'reviewer');

  const resetDenied = await request('/__test/reset', { method: 'POST', controlToken: 'wrong-token' });
  assert.equal(resetDenied.response.status, 403);
  const reset = await request('/__test/reset', { method: 'POST', controlToken: process.env.TEST_CONTROL_TOKEN });
  assert.equal(reset.response.status, 200);
  const otherScope = await pool.query('SELECT count(*)::int AS count FROM policies WHERE namespace_id = $1', [otherNamespace]);
  assert.equal(otherScope.rows[0].count, SEED.policies.length);
  const ownScope = await pool.query('SELECT count(*)::int AS count FROM claims WHERE namespace_id = $1', [process.env.APP_NAMESPACE]);
  assert.equal(ownScope.rows[0].count, 1);
});

test('compatibility contract: API v1 accepts the published 10,000 USD claim limit', async () => {
  const memberLogin = await login('member-a');
  const member = memberLogin.payload.token;
  const policies = await request('/api/v1/policies', { token: member });
  const policyId = policies.payload.items[0].id;

  const atLimit = await request('/api/v1/claims', {
    method: 'POST',
    token: member,
    body: { policyId, amountMinor: 1_000_000, currency: 'USD', category: 'auto' },
  });
  assert.equal(atLimit.response.status, 201);
  assert.equal(atLimit.payload.claim.amountMinor, 1_000_000);

  const aboveLimit = await request('/api/v1/claims', {
    method: 'POST',
    token: member,
    body: { policyId, amountMinor: 1_000_001, currency: 'USD', category: 'auto' },
  });
  assert.equal(aboveLimit.response.status, 422);
  assert.equal(aboveLimit.payload.error.code, 'VALIDATION_ERROR');
});

test('API v2 caps claims at 5,000 USD while API v1 keeps its 10,000 USD contract', async () => {
  const memberLogin = await login('member-a');
  const member = memberLogin.payload.token;
  const policies = await request('/api/v2/policies', { token: member });
  assert.equal(policies.response.status, 200);
  assert.equal(policies.payload.items[0].claimAmountLimitMinor, 500_000);
  const policyId = policies.payload.items[0].id;

  const atLimit = await request('/api/v2/claims', {
    method: 'POST', token: member,
    body: { policyId, amountMinor: 500_000, currency: 'USD', category: 'auto' },
  });
  assert.equal(atLimit.response.status, 201);
  assert.equal(atLimit.payload.claim.amountMinor, 500_000);
  const claimId = atLimit.payload.claim.id;

  const memberBLogin = await login('member-b');
  const memberBRead = await request(`/api/v2/claims/${claimId}`, { token: memberBLogin.payload.token });
  assert.equal(memberBRead.response.status, 404);

  const memberTransition = await request(`/api/v2/claims/${claimId}`, {
    method: 'PATCH', token: member,
    body: { status: 'approved', expectedVersion: 1 },
  });
  assert.equal(memberTransition.response.status, 403);

  const reviewerLogin = await login('reviewer');
  const reviewer = reviewerLogin.payload.token;
  const review = await request(`/api/v2/claims/${claimId}`, {
    method: 'PATCH', token: reviewer,
    body: { status: 'under_review', expectedVersion: 1 },
  });
  assert.equal(review.response.status, 200);
  assert.equal(review.payload.claim.version, 2);

  const staleTransition = await request(`/api/v2/claims/${claimId}`, {
    method: 'PATCH', token: reviewer,
    body: { status: 'approved', expectedVersion: 1 },
  });
  assert.equal(staleTransition.response.status, 409);
  assert.equal(staleTransition.payload.error.code, 'VERSION_CONFLICT');

  const approved = await request(`/api/v2/claims/${claimId}`, {
    method: 'PATCH', token: reviewer,
    body: { status: 'approved', expectedVersion: 2 },
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.payload.claim.version, 3);

  const events = await request(`/api/v2/claims/${claimId}/events`, { token: reviewer });
  assert.deepEqual(events.payload.items.map((event) => [event.fromStatus, event.toStatus, event.claimVersion]), [
    [null, 'submitted', 1], ['submitted', 'under_review', 2], ['under_review', 'approved', 3],
  ]);

  const aboveLimit = await request('/api/v2/claims', {
    method: 'POST', token: member,
    body: { policyId, amountMinor: 500_001, currency: 'USD', category: 'auto' },
  });
  assert.equal(aboveLimit.response.status, 422);
  assert.equal(aboveLimit.payload.error.code, 'VALIDATION_ERROR');

  const v1LimitStillAccepted = await request('/api/v1/claims', {
    method: 'POST', token: member,
    body: { policyId, amountMinor: 1_000_000, currency: 'USD', category: 'auto' },
  });
  assert.equal(v1LimitStillAccepted.response.status, 201);
  assert.equal(v1LimitStillAccepted.payload.claim.amountMinor, 1_000_000);
});

test('test controls and test-session issuance are not exposed when test mode is disabled', async () => {
  process.env.TEST_MODE = 'false';
  const production = await import('../src/server.js?production-mode-check');
  await production.initialize();
  const productionServer = production.createServer();
  await new Promise((resolve, reject) => {
    productionServer.once('error', reject);
    productionServer.listen(0, '127.0.0.1', resolve);
  });
  const productionUrl = `http://127.0.0.1:${productionServer.address().port}`;
  try {
    const session = await fetch(`${productionUrl}/api/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identityKey: 'member-a' }),
    });
    assert.equal(session.status, 404);
    const reset = await fetch(`${productionUrl}/__test/reset`, {
      method: 'POST', headers: { 'x-test-control-token': process.env.TEST_CONTROL_TOKEN },
    });
    assert.equal(reset.status, 404);
  } finally {
    await new Promise((resolve) => productionServer.close(resolve));
    process.env.TEST_MODE = 'true';
  }
});

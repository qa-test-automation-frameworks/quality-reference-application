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
const { pool, seedNamespace, SEED, tokenDigest } = await import('../src/database.js');
const testHooks = {};
const server = createServer({ testHooks });
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createFreshClaim(token, amountMinor = 25_000) {
  const policies = await request('/api/v1/policies', { token });
  assert.equal(policies.response.status, 200);
  const created = await request('/api/v1/claims', {
    method: 'POST', token,
    body: { policyId: policies.payload.items[0].id, amountMinor, currency: 'USD', category: 'auto' },
  });
  assert.equal(created.response.status, 201);
  return created.payload.claim;
}

async function waitForClaimRowLock(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT pid, wait_event_type, wait_event
       FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = 'quality-reference-application'
         AND wait_event_type = 'Lock' AND query ILIKE '%FROM claims%FOR UPDATE%'`,
    );
    if (result.rows[0]) return result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function waitForSignal(signal, timeoutMs, description) {
  let timer;
  try {
    await Promise.race([
      signal,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} did not happen within ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function writeQ2Evidence(event, details) {
  process.stdout.write(`Q2_EVIDENCE ${JSON.stringify({ event, ...details })}\n`);
}

async function installEventFailureTrigger(claimId) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `q2_fail_event_${suffix}`;
  const triggerName = `q2_fail_event_${suffix}`;
  const namespaceLiteral = process.env.APP_NAMESPACE.replaceAll("'", "''");
  const claimLiteral = claimId.replaceAll("'", "''");
  try {
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $q2$
      BEGIN
        IF NEW.namespace_id = '${namespaceLiteral}' AND NEW.claim_id = '${claimLiteral}'::uuid THEN
          RAISE EXCEPTION 'Q2_AUDIT_INSERT_FAILURE';
        END IF;
        RETURN NEW;
      END;
      $q2$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON claim_events
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  } catch (error) {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON claim_events`);
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    throw error;
  }
  return async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON claim_events`);
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  };
}

test('serves the browser amount utility as a same-origin JavaScript module', async () => {
  const response = await fetch(`${baseUrl}/amount.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.match(await response.text(), /amountToMinorUnits/);
});

test('persisted claim journey enforces identity ownership, reviewer transitions, concurrency, and run isolation', async () => {
  const memberLogin = await login('member-a');
  assert.equal(memberLogin.response.status, 201);
  assert.equal(memberLogin.payload.user.role, 'member');
  const memberA = memberLogin.payload.token;

  const policyList = await request('/api/v1/policies', { token: memberA });
  assert.equal(policyList.response.status, 200);
  assert.equal(policyList.payload.items.length, 1, 'member policy list must be identity-scoped');
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
  assert.equal(hiddenPolicy.response.status, 404, 'foreign policy reads must be hidden');

  const created = await request('/api/v1/claims', {
    method: 'POST', token: memberA,
    body: { policyId, amountMinor: 8750, currency: 'USD', category: 'auto' },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.claim.amountMinor, 8750);
  assert.equal(created.payload.claim.status, 'submitted');
  const claimId = created.payload.claim.id;

  const foreignClaim = await request(`/api/v1/claims/${claimId}`, { token: memberB });
  assert.equal(foreignClaim.response.status, 404, 'foreign claim reads must be hidden');
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
  assert.equal(staleUpdate.response.status, 409, 'stale versions must return a conflict');
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
  assert.equal(policies.payload.items[0].claimAmountLimitMinor, 500_000, 'API v2 must publish the 5,000 USD limit');
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
    assert.throws(() => production.createServer({ testHooks: {} }), /only be injected when TEST_MODE=true/);
  } finally {
    await new Promise((resolve) => productionServer.close(resolve));
    process.env.TEST_MODE = 'true';
  }
});

test('same-version writers are actually queued behind the row lock', async () => {
  const member = await login('member-a');
  const reviewer = await login('reviewer');
  const claim = await createFreshClaim(member.payload.token);
  const entered = deferred();
  const releaseFirst = deferred();
  let hookCalls = 0;
  let secondTransition;
  let observedWait;
  let firstHookError;
  const eventsBefore = await pool.query(
    'SELECT count(*)::int AS count FROM claim_events WHERE namespace_id = $1 AND claim_id = $2',
    [process.env.APP_NAMESPACE, claim.id],
  );
  testHooks.afterClaimRowLock = async ({ claimId }) => {
    if (claimId !== claim.id) return;
    hookCalls += 1;
    if (hookCalls === 1) {
      entered.resolve();
      await releaseFirst.promise;
    }
  };
  const firstTransition = request(`/api/v1/claims/${claim.id}`, {
    method: 'PATCH', token: reviewer.payload.token,
    body: { status: 'under_review', expectedVersion: 1 },
  });
  try {
    await waitForSignal(entered.promise, 5_000, 'the first writer to hold the claim row lock');
    secondTransition = request(`/api/v1/claims/${claim.id}`, {
      method: 'PATCH', token: reviewer.payload.token,
      body: { status: 'under_review', expectedVersion: 1 },
    });
    observedWait = await waitForClaimRowLock();
  } catch (error) {
    firstHookError = error;
  } finally {
    releaseFirst.resolve();
    testHooks.afterClaimRowLock = undefined;
  }
  const outcomes = await Promise.all([firstTransition, secondTransition].filter(Boolean));
  assert.equal(firstHookError, undefined);
  writeQ2Evidence('same-version-writer-lock-wait', {
    observed: Boolean(observedWait),
    waitEventType: observedWait?.wait_event_type || null,
    waitEvent: observedWait?.wait_event || null,
    hookCalls,
    responseStatuses: outcomes.map(({ response }) => response.status).sort(),
  });
  assert.ok(observedWait, 'did not observe a database row-lock wait within five seconds');
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.filter(({ response }) => response.status === 200).length, 1);
  const conflict = outcomes.find(({ response }) => response.status === 409);
  assert.equal(conflict?.payload.error.code, 'VERSION_CONFLICT');

  const persisted = await pool.query(
    'SELECT status, version FROM claims WHERE namespace_id = $1 AND id = $2',
    [process.env.APP_NAMESPACE, claim.id],
  );
  const eventsAfter = await pool.query(
    `SELECT from_status AS "fromStatus", to_status AS "toStatus", claim_version AS "claimVersion"
     FROM claim_events WHERE namespace_id = $1 AND claim_id = $2 ORDER BY claim_version`,
    [process.env.APP_NAMESPACE, claim.id],
  );
  writeQ2Evidence('same-version-writer-persisted-state', {
    status: persisted.rows[0]?.status,
    version: persisted.rows[0]?.version,
    eventsBefore: eventsBefore.rows[0].count,
    eventVersionsAfter: eventsAfter.rows.map((event) => event.claimVersion),
  });
  assert.deepEqual(persisted.rows, [{ status: 'under_review', version: 2 }]);
  assert.equal(eventsAfter.rowCount, eventsBefore.rows[0].count + 1);
  assert.deepEqual(eventsAfter.rows.map((event) => event.claimVersion), [1, 2]);
  assert.deepEqual(eventsAfter.rows[1], {
    fromStatus: 'submitted', toStatus: 'under_review', claimVersion: 2,
  });
});

test('claim creation and transition roll back when their audit event insert fails', async () => {
  let cleanupTrigger;
  try {
    const member = await login('member-a');
    const reviewer = await login('reviewer');
    const policies = await request('/api/v1/policies', { token: member.payload.token });
    const policyId = policies.payload.items[0].id;
    const createFailureId = randomUUID();
    testHooks.newClaimId = () => createFailureId;
    cleanupTrigger = await installEventFailureTrigger(createFailureId);
    const failedCreate = await request('/api/v1/claims', {
      method: 'POST', token: member.payload.token,
      body: { policyId, amountMinor: 25_000, currency: 'USD', category: 'auto' },
    });
    assert.equal(failedCreate.response.status, 500);
    assert.equal(failedCreate.payload.error.code, 'INTERNAL_ERROR');
    assert.equal(failedCreate.payload.error.message, 'The request could not be completed.');
    assert.doesNotMatch(JSON.stringify(failedCreate.payload), /Q2_AUDIT_INSERT_FAILURE|claim_events|postgres/i);
    const afterFailedCreate = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM claims WHERE namespace_id = $1 AND id = $2) AS claims,
         (SELECT count(*)::int FROM claim_events WHERE namespace_id = $1 AND claim_id = $2) AS events`,
      [process.env.APP_NAMESPACE, createFailureId],
    );
    writeQ2Evidence('failed-create-atomicity', afterFailedCreate.rows[0]);
    assert.deepEqual(afterFailedCreate.rows[0], { claims: 0, events: 0 });
    await cleanupTrigger();
    cleanupTrigger = undefined;
    testHooks.newClaimId = undefined;

    const transitionClaim = await createFreshClaim(member.payload.token);
    cleanupTrigger = await installEventFailureTrigger(transitionClaim.id);
    const failedTransition = await request(`/api/v1/claims/${transitionClaim.id}`, {
      method: 'PATCH', token: reviewer.payload.token,
      body: { status: 'under_review', expectedVersion: 1 },
    });
    assert.equal(failedTransition.response.status, 500);
    assert.equal(failedTransition.payload.error.code, 'INTERNAL_ERROR');
    assert.equal(failedTransition.payload.error.message, 'The request could not be completed.');
    assert.doesNotMatch(JSON.stringify(failedTransition.payload), /Q2_AUDIT_INSERT_FAILURE|claim_events|postgres/i);
    const afterFailedTransition = await pool.query(
      `SELECT c.status, c.version, count(e.id)::int AS events
       FROM claims c LEFT JOIN claim_events e ON e.namespace_id = c.namespace_id AND e.claim_id = c.id
       WHERE c.namespace_id = $1 AND c.id = $2
       GROUP BY c.status, c.version`,
      [process.env.APP_NAMESPACE, transitionClaim.id],
    );
    writeQ2Evidence('failed-transition-atomicity', afterFailedTransition.rows[0]);
    assert.deepEqual(afterFailedTransition.rows[0], { status: 'submitted', version: 1, events: 1 });
  } finally {
    testHooks.newClaimId = undefined;
    await cleanupTrigger?.();
  }
});

test('expired sessions are rejected immediately and a fresh session still works', async () => {
  const session = await login('member-a');
  assert.equal(session.response.status, 201);
  const expired = await pool.query(
    `UPDATE sessions SET expires_at = now() - interval '1 second'
     WHERE namespace_id = $1 AND token_hash = $2`,
    [process.env.APP_NAMESPACE, tokenDigest(session.payload.token)],
  );
  assert.equal(expired.rowCount, 1);
  const denied = await request('/api/v1/policies', { token: session.payload.token });
  assert.equal(denied.response.status, 401);
  assert.equal(denied.payload.error.code, 'SESSION_EXPIRED');
  assert.equal(denied.payload.items, undefined);

  const fresh = await login('member-a');
  assert.equal(fresh.response.status, 201);
  const allowed = await request('/api/v1/policies', { token: fresh.payload.token });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.payload.items.length, 1);
  writeQ2Evidence('session-expiry', {
    expiredSessionStatus: denied.response.status,
    expiredSessionCode: denied.payload.error.code,
    freshSessionStatus: allowed.response.status,
    policyCount: allowed.payload.items.length,
  });
});

test('readiness reports datastore loss and recovery through an injected pool facade', async () => {
  let unavailable = false;
  const databasePool = {
    query(...args) {
      if (unavailable && args[0] === 'SELECT 1 AS connected') return Promise.reject(new Error('injected datastore outage'));
      return pool.query(...args);
    },
  };
  const readinessServer = createServer({ databasePool });
  await new Promise((resolve, reject) => {
    readinessServer.once('error', reject);
    readinessServer.listen(0, '127.0.0.1', resolve);
  });
  const readinessUrl = `http://127.0.0.1:${readinessServer.address().port}/health/ready`;
  try {
    const initialResponse = await fetch(readinessUrl);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    unavailable = true;
    const unavailableResponse = await fetch(readinessUrl);
    assert.equal(unavailableResponse.status, 503);
    const unavailableBody = await unavailableResponse.json();
    assert.equal(unavailableBody.error.code, 'NOT_READY');
    assert.doesNotMatch(JSON.stringify(unavailableBody), /injected datastore outage/);
    unavailable = false;
    const recoveredResponse = await fetch(readinessUrl);
    assert.equal(recoveredResponse.status, 200);
    const recovered = await recoveredResponse.json();
    assert.deepEqual(recovered, initial);
    writeQ2Evidence('readiness-facade-recovery', {
      initialStatus: initialResponse.status,
      unavailableStatus: unavailableResponse.status,
      unavailableCode: unavailableBody.error.code,
      recoveredStatus: recoveredResponse.status,
      sourceRevision: recovered.sourceRevision,
      seedVersion: recovered.seedVersion,
    });
  } finally {
    await new Promise((resolve) => readinessServer.close(resolve));
  }
});

test('reset admission rejects active work and gates the namespace until reset completes', async () => {
  const member = await login('member-a');
  const reviewer = await login('reviewer');
  const claim = await createFreshClaim(member.payload.token);
  const otherBefore = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM identities WHERE namespace_id = $1) AS identities,
       (SELECT count(*)::int FROM policies WHERE namespace_id = $1) AS policies,
       (SELECT count(*)::int FROM claims WHERE namespace_id = $1) AS claims,
       (SELECT count(*)::int FROM claim_events WHERE namespace_id = $1) AS events`,
    [otherNamespace],
  );
  const transitionEntered = deferred();
  const releaseTransition = deferred();
  let lockCalls = 0;
  testHooks.afterClaimRowLock = async ({ claimId }) => {
    if (claimId === claim.id && ++lockCalls === 1) {
      transitionEntered.resolve();
      await releaseTransition.promise;
    }
  };
  let transition;
  try {
    transition = request(`/api/v1/claims/${claim.id}`, {
      method: 'PATCH', token: reviewer.payload.token,
      body: { status: 'under_review', expectedVersion: 1 },
    });
    await waitForSignal(transitionEntered.promise, 5_000, 'the active request to hold the claim row lock');
    for (const path of ['/__test/reset', '/__test/seed']) {
      const busy = await request(path, { method: 'POST', controlToken: process.env.TEST_CONTROL_TOKEN });
      assert.equal(busy.response.status, 409);
      assert.equal(busy.payload.error.code, 'RESET_BUSY');
    }
  } finally {
    releaseTransition.resolve();
    testHooks.afterClaimRowLock = undefined;
  }
  const transitionResult = await transition;
  assert.equal(transitionResult.response.status, 200);

  const resetEntered = deferred();
  const releaseReset = deferred();
  testHooks.beforeNamespaceControl = async ({ operation }) => {
    if (operation === 'reset') {
      resetEntered.resolve();
      await releaseReset.promise;
    }
  };
  let resetPromise;
  try {
    resetPromise = request('/__test/reset', { method: 'POST', controlToken: process.env.TEST_CONTROL_TOKEN });
    await waitForSignal(resetEntered.promise, 5_000, 'reset to enter its protected section');
    const blockedApi = await request('/api/v1/policies', { token: member.payload.token });
    assert.equal(blockedApi.response.status, 503);
    assert.equal(blockedApi.payload.error.code, 'RESET_IN_PROGRESS');
    const secondReset = await request('/__test/reset', { method: 'POST', controlToken: process.env.TEST_CONTROL_TOKEN });
    assert.equal(secondReset.response.status, 409);
    assert.equal(secondReset.payload.error.code, 'RESET_BUSY');
    const concurrentSeed = await request('/__test/seed', { method: 'POST', controlToken: process.env.TEST_CONTROL_TOKEN });
    assert.equal(concurrentSeed.response.status, 409);
    assert.equal(concurrentSeed.payload.error.code, 'RESET_BUSY');
    const ready = await fetch(`${baseUrl}/health/ready`);
    assert.equal(ready.status, 200);
    const staticPage = await fetch(`${baseUrl}/`);
    assert.equal(staticPage.status, 200);
    writeQ2Evidence('reset-in-progress-admission', {
      activeResetStatus: 200,
      apiStatus: blockedApi.response.status,
      apiCode: blockedApi.payload.error.code,
      secondResetStatus: secondReset.response.status,
      seedStatus: concurrentSeed.response.status,
      readinessStatus: ready.status,
      staticStatus: staticPage.status,
    });
  } finally {
    releaseReset.resolve();
    testHooks.beforeNamespaceControl = undefined;
  }
  const resetResult = await resetPromise;
  assert.equal(resetResult.response.status, 200);
  const expiredOldSession = await request('/api/v1/policies', { token: member.payload.token });
  assert.equal(expiredOldSession.response.status, 401);
  assert.equal(expiredOldSession.payload.error.code, 'SESSION_EXPIRED');
  const otherAfter = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM identities WHERE namespace_id = $1) AS identities,
       (SELECT count(*)::int FROM policies WHERE namespace_id = $1) AS policies,
       (SELECT count(*)::int FROM claims WHERE namespace_id = $1) AS claims,
       (SELECT count(*)::int FROM claim_events WHERE namespace_id = $1) AS events`,
    [otherNamespace],
  );
  assert.deepEqual(otherAfter.rows, otherBefore.rows);
  writeQ2Evidence('reset-complete-isolation', {
    resetStatus: resetResult.response.status,
    oldSessionStatus: expiredOldSession.response.status,
    oldSessionCode: expiredOldSession.payload.error.code,
    otherNamespace: otherAfter.rows[0],
  });
});

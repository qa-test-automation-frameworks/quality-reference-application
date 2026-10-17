import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  API_V1_CLAIM_LIMIT_MINOR,
  API_V2_CLAIM_LIMIT_MINOR,
  CLAIM_CATEGORIES,
  CLAIM_STATES,
  assertClaimAmount,
  assertTransition,
} from './domain.js';
import { closeDatabase, migrate, pool, resetNamespace, seedNamespace, tokenDigest } from './database.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const namespace = process.env.APP_NAMESPACE;
const sourceSha = process.env.APP_SOURCE_SHA || 'working-tree';
const testMode = process.env.TEST_MODE === 'true';
const controlToken = process.env.TEST_CONTROL_TOKEN;
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS || 3600);
const maxBodyBytes = 16 * 1024;
let ready = false;

const uuid = z.uuid();
const sessionSchema = z.object({ identityKey: z.enum(['member-a', 'member-b', 'reviewer']) }).strict();
const createClaimSchema = z.object({
  policyId: uuid,
  amountMinor: z.number().int().min(1).max(API_V1_CLAIM_LIMIT_MINOR),
  currency: z.literal('USD'),
  category: z.enum(CLAIM_CATEGORIES),
}).strict();
const createClaimV2Schema = z.object({
  policyId: uuid,
  amountMinor: z.number().int().min(1).max(API_V2_CLAIM_LIMIT_MINOR),
  currency: z.literal('USD'),
  category: z.enum(CLAIM_CATEGORIES),
}).strict();
const transitionSchema = z.object({
  status: z.enum(CLAIM_STATES),
  expectedVersion: z.number().int().positive(),
}).strict();

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function validateRuntimeConfig() {
  if (!namespace || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(namespace)) {
    throw new Error('APP_NAMESPACE must be a unique 2–63 character lowercase slug.');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (testMode && (!controlToken || Buffer.byteLength(controlToken) < 32)) {
    throw new Error('TEST_CONTROL_TOKEN must contain at least 32 bytes when TEST_MODE=true.');
  }
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 86_400) {
    throw new Error('SESSION_TTL_SECONDS must be between 60 and 86400.');
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the 16 KiB limit.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'INVALID_JSON', 'Request body must contain valid JSON.');
  }
}

function sendJson(res, status, body, correlationId) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-correlation-id': correlationId,
  });
  res.end(JSON.stringify(body));
}

function errorEnvelope(error, correlationId) {
  return {
    status: error.status || 500,
    body: {
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.status ? error.message : 'The request could not be completed.',
        correlationId,
      },
    },
  };
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw httpError(422, 'VALIDATION_ERROR', result.error.issues.map((issue) => issue.message).join('; '));
  return result.data;
}

async function currentIdentity(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(req.headers.authorization || '');
  if (!match) throw httpError(401, 'AUTHENTICATION_REQUIRED', 'A valid synthetic session is required.');
  const digest = tokenDigest(match[1]);
  const result = await pool.query(
    `SELECT i.id, i.identity_key AS "identityKey", i.role, i.display_name AS "displayName"
     FROM sessions s JOIN identities i ON i.namespace_id = s.namespace_id AND i.id = s.identity_id
     WHERE s.namespace_id = $1 AND s.token_hash = $2 AND s.expires_at > now()`,
    [namespace, digest],
  );
  if (!result.rows[0]) throw httpError(401, 'SESSION_EXPIRED', 'The synthetic session is missing or expired.');
  return result.rows[0];
}

async function requireReviewer(req) {
  const actor = await currentIdentity(req);
  if (actor.role !== 'reviewer') throw httpError(403, 'ROLE_FORBIDDEN', 'A reviewer session is required for this action.');
  return actor;
}

async function withTransaction(operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function claimDto(row) {
  return {
    id: row.id,
    policyId: row.policyId,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    category: row.category,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function handleApi(req, res, url, correlationId) {
  const method = req.method || 'GET';
  const path = url.pathname;
  const versionMatch = /^\/api\/v([12])(?=\/)/.exec(path);
  const apiVersion = versionMatch?.[1] || '1';
  const routePath = path.replace(/^\/api\/v[12](?=\/)/, '/api/v1');
  if (method === 'GET' && path === '/health/ready') {
    if (!ready) throw httpError(503, 'NOT_READY', 'Database migrations and fixture initialization have not completed.');
    let result;
    try {
      result = await pool.query('SELECT 1 AS connected');
    } catch {
      throw httpError(503, 'NOT_READY', 'The datastore is not currently available.');
    }
    return { status: 200, body: { status: 'ready', sourceRevision: sourceSha, seedVersion: 'v0.1.0', datastore: result.rows[0].connected === 1 } };
  }

  if (path === '/__test/seed' || path === '/__test/reset') {
    if (!testMode) throw httpError(404, 'NOT_FOUND', 'The requested resource was not found.');
    if (req.headers['x-test-control-token'] !== controlToken) throw httpError(403, 'CONTROL_FORBIDDEN', 'A valid run-scoped control token is required.');
    if (method !== 'POST') throw httpError(405, 'METHOD_NOT_ALLOWED', 'This route accepts POST only.');
    if (path === '/__test/reset') await resetNamespace(namespace);
    else await seedNamespace(namespace);
    return { status: 200, body: { namespace, seedVersion: 'v0.1.0', reset: path.endsWith('/reset') } };
  }

  if (method === 'POST' && path === '/api/v1/sessions') {
    if (!testMode) throw httpError(404, 'NOT_FOUND', 'The requested resource was not found.');
    const input = parse(sessionSchema, await readJson(req));
    const userResult = await pool.query(
      'SELECT id, role, display_name AS "displayName" FROM identities WHERE namespace_id = $1 AND identity_key = $2',
      [namespace, input.identityKey],
    );
    const user = userResult.rows[0];
    if (!user) throw httpError(401, 'UNKNOWN_IDENTITY', 'The synthetic identity is not seeded.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
    await pool.query(
      'INSERT INTO sessions(namespace_id, token_hash, identity_id, expires_at) VALUES ($1, $2, $3, $4)',
      [namespace, tokenDigest(token), user.id, expiresAt],
    );
    return { status: 201, body: { token, tokenType: 'Bearer', expiresAt: expiresAt.toISOString(), user: { id: user.id, role: user.role, displayName: user.displayName } } };
  }

  const actor = await currentIdentity(req);
  if (method === 'GET' && routePath === '/api/v1/policies') {
    const result = await pool.query(
      `SELECT p.id, p.policy_number AS "policyNumber", p.seed_version AS "seedVersion", p.owner_id AS "ownerId"
       FROM policies p WHERE p.namespace_id = $1 AND ($2::text = 'reviewer' OR p.owner_id = $3::uuid)
       ORDER BY p.policy_number`,
      [namespace, actor.role, actor.id],
    );
    const items = result.rows.map(({ ownerId: _ownerId, ...policy }) => (
      apiVersion === '2' ? { ...policy, claimAmountLimitMinor: API_V2_CLAIM_LIMIT_MINOR } : policy
    ));
    return { status: 200, body: { items } };
  }

  const policyMatch = /^\/api\/v1\/policies\/([^/]+)$/.exec(routePath);
  if (method === 'GET' && policyMatch) {
    if (!uuid.safeParse(policyMatch[1]).success) throw httpError(404, 'RESOURCE_NOT_FOUND', 'The requested policy was not found.');
    const result = await pool.query(
      `SELECT id, policy_number AS "policyNumber", seed_version AS "seedVersion"
       FROM policies WHERE namespace_id = $1 AND id = $2 AND (owner_id = $3 OR $4::text = 'reviewer')`,
      [namespace, policyMatch[1], actor.id, actor.role],
    );
    if (!result.rows[0]) throw httpError(404, 'RESOURCE_NOT_FOUND', 'The requested policy was not found.');
    const policy = apiVersion === '2'
      ? { ...result.rows[0], claimAmountLimitMinor: API_V2_CLAIM_LIMIT_MINOR }
      : result.rows[0];
    return { status: 200, body: { policy } };
  }

  if (method === 'POST' && routePath === '/api/v1/claims') {
    const schema = apiVersion === '2' ? createClaimV2Schema : createClaimSchema;
    const input = parse(schema, await readJson(req));
    assertClaimAmount(
      input.amountMinor,
      apiVersion === '2' ? API_V2_CLAIM_LIMIT_MINOR : API_V1_CLAIM_LIMIT_MINOR,
    );
    const policy = await pool.query(
      'SELECT id FROM policies WHERE namespace_id = $1 AND id = $2 AND owner_id = $3',
      [namespace, input.policyId, actor.id],
    );
    if (!policy.rows[0]) throw httpError(404, 'RESOURCE_NOT_FOUND', 'The requested policy was not found.');
    const created = await withTransaction(async (client) => {
      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO claims(namespace_id, id, policy_id, owner_id, status, amount_minor, currency, category)
         VALUES ($1, $2, $3, $4, 'submitted', $5, $6, $7)
         RETURNING id, policy_id AS "policyId", status, amount_minor AS "amountMinor", currency, category, version,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [namespace, id, policy.rows[0].id, actor.id, input.amountMinor, input.currency, input.category],
      );
      await client.query(
        `INSERT INTO claim_events(namespace_id, claim_id, actor_id, from_status, to_status, claim_version)
         VALUES ($1, $2, $3, NULL, 'submitted', 1)`,
        [namespace, id, actor.id],
      );
      return inserted.rows[0];
    });
    return { status: 201, body: { claim: claimDto(created) } };
  }

  if (method === 'GET' && routePath === '/api/v1/claims') {
    const result = await pool.query(
      `SELECT id, policy_id AS "policyId", status, amount_minor AS "amountMinor", currency, category, version,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM claims WHERE namespace_id = $1 AND ($2::text = 'reviewer' OR owner_id = $3::uuid)
       ORDER BY created_at DESC, id`,
      [namespace, actor.role, actor.id],
    );
    return { status: 200, body: { items: result.rows.map(claimDto) } };
  }

  const claimMatch = /^\/api\/v1\/claims\/([^/]+)(?:\/(events))?$/.exec(routePath);
  if (claimMatch && method === 'GET') {
    const id = claimMatch[1];
    if (!uuid.safeParse(id).success) throw httpError(404, 'RESOURCE_NOT_FOUND', 'The requested claim was not found.');
    const claimResult = await pool.query(
      `SELECT id, policy_id AS "policyId", owner_id AS "ownerId", status, amount_minor AS "amountMinor", currency, category, version,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM claims WHERE namespace_id = $1 AND id = $2`,
      [namespace, id],
    );
    const claim = claimResult.rows[0];
    if (!claim || (actor.role !== 'reviewer' && claim.ownerId !== actor.id)) {
      throw httpError(404, 'RESOURCE_NOT_FOUND', 'The requested claim was not found.');
    }
    if (claimMatch[2] === 'events') {
      const events = await pool.query(
        `SELECT e.from_status AS "fromStatus", e.to_status AS "toStatus", e.claim_version AS "claimVersion",
                e.created_at AS "createdAt", i.display_name AS "actorDisplayName", i.role AS "actorRole"
         FROM claim_events e JOIN identities i ON i.namespace_id = e.namespace_id AND i.id = e.actor_id
         WHERE e.namespace_id = $1 AND e.claim_id = $2 ORDER BY e.claim_version`,
        [namespace, id],
      );
      return { status: 200, body: { items: events.rows } };
    }
    const { ownerId: _ownerId, ...publicClaim } = claim;
    return { status: 200, body: { claim: claimDto(publicClaim) } };
  }

  const transitionMatch = /^\/api\/v1\/claims\/([^/]+)$/.exec(routePath);
  if (method === 'PATCH' && transitionMatch) {
    const reviewer = await requireReviewer(req);
    if (!uuid.safeParse(transitionMatch[1]).success) throw httpError(404, 'RESOURCE_NOT_FOUND', 'The requested claim was not found.');
    const input = parse(transitionSchema, await readJson(req));
    const updated = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT id, policy_id AS "policyId", status, amount_minor AS "amountMinor", currency, category, version,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM claims WHERE namespace_id = $1 AND id = $2 FOR UPDATE`,
        [namespace, transitionMatch[1]],
      );
      const claim = result.rows[0];
      if (!claim) throw httpError(404, 'RESOURCE_NOT_FOUND', 'The requested claim was not found.');
      if (claim.version !== input.expectedVersion) throw httpError(409, 'VERSION_CONFLICT', 'The claim changed since it was read; reload it before retrying.');
      assertTransition(claim.status, input.status);
      const changed = await client.query(
        `UPDATE claims SET status = $3, version = version + 1, updated_at = now()
         WHERE namespace_id = $1 AND id = $2
         RETURNING id, policy_id AS "policyId", status, amount_minor AS "amountMinor", currency, category, version,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [namespace, claim.id, input.status],
      );
      await client.query(
        `INSERT INTO claim_events(namespace_id, claim_id, actor_id, from_status, to_status, claim_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [namespace, claim.id, reviewer.id, claim.status, input.status, changed.rows[0].version],
      );
      return changed.rows[0];
    });
    return { status: 200, body: { claim: claimDto(updated) } };
  }

  throw httpError(404, 'NOT_FOUND', 'The requested resource was not found.');
}

async function staticResponse(path, res) {
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ]);
  const entry = assets.get(path);
  if (!entry) return false;
  const [file, contentType] = entry;
  const body = await readFile(join(root, 'public', file));
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
  return true;
}

export async function initialize() {
  validateRuntimeConfig();
  await migrate();
  await seedNamespace(namespace);
  await pool.query('SELECT 1');
  ready = true;
}

export function createServer() {
  const server = createHttpServer(async (req, res) => {
    const startedAt = process.hrtime.bigint();
    const correlationId = randomUUID();
    let status = 500;
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && await staticResponse(url.pathname, res)) {
        status = 200;
        return;
      }
      const result = await handleApi(req, res, url, correlationId);
      status = result.status;
      sendJson(res, result.status, result.body, correlationId);
    } catch (error) {
      const envelope = errorEnvelope(error, correlationId);
      status = envelope.status;
      if (status >= 500) {
        process.stderr.write(`${JSON.stringify({ event: 'request-error', correlationId, errorName: error.name || 'Error' })}\n`);
      }
      if (!res.headersSent) sendJson(res, envelope.status, envelope.body, correlationId);
      else res.destroy();
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      process.stdout.write(`${JSON.stringify({ event: 'request-complete', correlationId, method: req.method, path: (req.url || '/').split('?')[0], status, durationMs: Math.round(elapsedMs * 100) / 100 })}\n`);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

export async function close() {
  ready = false;
  await closeDatabase();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 4300);
  await initialize();
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    const address = server.address();
    process.stdout.write(`${JSON.stringify({ event: 'server-ready', port: typeof address === 'object' && address ? address.port : port, namespace, sourceRevision: sourceSha, seedVersion: 'v0.1.0' })}\n`);
  });
  const shutdown = () => {
    const timeout = setTimeout(() => process.exit(1), 5_000);
    timeout.unref();
    server.close(async () => {
      try {
        await close();
        process.exit(0);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ event: 'shutdown-error', errorName: error.name || 'Error' })}\n`);
        process.exit(1);
      }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

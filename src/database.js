import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { FIXTURE_VERSION } from './release-metadata.js';

const { Pool } = pg;
const directory = dirname(fileURLToPath(import.meta.url));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

export const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_SIZE || 8),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'quality-reference-application',
});

export const SEED_VERSION = FIXTURE_VERSION;
export const SEED = Object.freeze({
  members: [
    { id: '11111111-1111-4111-8111-111111111111', identityKey: 'member-a', displayName: 'Synthetic Member A' },
    { id: '22222222-2222-4222-8222-222222222222', identityKey: 'member-b', displayName: 'Synthetic Member B' },
  ],
  reviewer: { id: '33333333-3333-4333-8333-333333333333', identityKey: 'reviewer', displayName: 'Synthetic Reviewer' },
  policies: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownerId: '11111111-1111-4111-8111-111111111111', number: 'POL-SYN-A-001' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerId: '22222222-2222-4222-8222-222222222222', number: 'POL-SYN-B-001' },
  ],
  claim: {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ownerId: '11111111-1111-4111-8111-111111111111',
    amountMinor: 12500,
    currency: 'USD',
    category: 'property_damage',
  },
});

async function insertSeedClaim(client, namespace) {
  const claim = SEED.claim;
  const inserted = await client.query(
    `INSERT INTO claims(namespace_id, id, policy_id, owner_id, status, amount_minor, currency, category)
     VALUES ($1, $2, $3, $4, 'submitted', $5, $6, $7)
     ON CONFLICT (namespace_id, id) DO NOTHING
     RETURNING id`,
    [namespace, claim.id, claim.policyId, claim.ownerId, claim.amountMinor, claim.currency, claim.category],
  );
  if (inserted.rowCount) {
    await client.query(
      `INSERT INTO claim_events(namespace_id, claim_id, actor_id, from_status, to_status, claim_version)
       VALUES ($1, $2, $3, NULL, 'submitted', 1)`,
      [namespace, claim.id, claim.ownerId],
    );
  }
}

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [74021001]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const current = await client.query('SELECT version FROM schema_migrations WHERE version = $1', ['001_initial']);
    if (current.rowCount === 0) {
      const sql = await readFile(join(directory, '..', 'migrations', '001_initial.sql'), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', ['001_initial']);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function seedNamespace(namespace) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [namespace]);
    for (const member of SEED.members) {
      await client.query(
        `INSERT INTO identities(namespace_id, id, identity_key, role, display_name)
         VALUES ($1, $2, $3, 'member', $4)
         ON CONFLICT (namespace_id, identity_key) DO NOTHING`,
        [namespace, member.id, member.identityKey, member.displayName],
      );
    }
    const reviewer = SEED.reviewer;
    await client.query(
      `INSERT INTO identities(namespace_id, id, identity_key, role, display_name)
       VALUES ($1, $2, $3, 'reviewer', $4)
       ON CONFLICT (namespace_id, identity_key) DO NOTHING`,
      [namespace, reviewer.id, reviewer.identityKey, reviewer.displayName],
    );
    for (const policy of SEED.policies) {
      await client.query(
        `INSERT INTO policies(namespace_id, id, owner_id, policy_number, seed_version)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (namespace_id, id) DO NOTHING`,
        [namespace, policy.id, policy.ownerId, policy.number, SEED_VERSION],
      );
    }
    await insertSeedClaim(client, namespace);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resetNamespace(namespace) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [namespace]);
    await client.query('DELETE FROM sessions WHERE namespace_id = $1', [namespace]);
    await client.query('DELETE FROM claim_events WHERE namespace_id = $1', [namespace]);
    await client.query('DELETE FROM claims WHERE namespace_id = $1', [namespace]);
    await client.query('DELETE FROM policies WHERE namespace_id = $1', [namespace]);
    await client.query('DELETE FROM identities WHERE namespace_id = $1', [namespace]);
    for (const member of SEED.members) {
      await client.query(
        `INSERT INTO identities(namespace_id, id, identity_key, role, display_name)
         VALUES ($1, $2, $3, 'member', $4)`,
        [namespace, member.id, member.identityKey, member.displayName],
      );
    }
    await client.query(
      `INSERT INTO identities(namespace_id, id, identity_key, role, display_name)
       VALUES ($1, $2, $3, 'reviewer', $4)`,
      [namespace, SEED.reviewer.id, SEED.reviewer.identityKey, SEED.reviewer.displayName],
    );
    for (const policy of SEED.policies) {
      await client.query(
        `INSERT INTO policies(namespace_id, id, owner_id, policy_number, seed_version)
         VALUES ($1, $2, $3, $4, $5)`,
        [namespace, policy.id, policy.ownerId, policy.number, SEED_VERSION],
      );
    }
    await insertSeedClaim(client, namespace);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function tokenDigest(token) {
  return createHash('sha256').update(token).digest();
}

export async function closeDatabase() {
  await pool.end();
}

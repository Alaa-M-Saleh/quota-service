import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertAssignablePlan, serializePlan, type PlanRow } from '../services/plans';

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

function assertAdmin(provided: unknown, expected: string) {
  const a = Buffer.from(typeof provided === 'string' ? provided : '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(401, 'ADMIN_UNAUTHORIZED', 'Missing or invalid X-Admin-Token');
  }
}

const planBody = z.object({ planId: z.string().min(1).max(100) });

/** Bootstrap endpoint: protected by the operator-configured ADMIN_TOKEN, not by an account API key. */
export function adminRoutes(app: FastifyInstance, pool: Pool, adminToken: string) {
  app.post('/admin/accounts', async (req, reply) => {
    assertAdmin(req.headers['x-admin-token'], adminToken);
    const body = z.object({ name: z.string().trim().min(1).max(200), planId: z.string().min(1).max(100).default('starter') }).parse(req.body);
    await assertAssignablePlan(pool, null, body.planId, 'account');
    const id = randomUUID();
    const apiKey = `qk_${randomBytes(32).toString('hex')}`;
    await pool.query(`INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, $2, $3, $4)`, [id, body.name, hashKey(apiKey), body.planId]);
    reply.code(201);
    return { id, name: body.name, planId: body.planId, apiKey, note: 'Store the API key now; it cannot be retrieved again.' };
  });
}

export function accountRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/account', async (req) => {
    const r = await pool.query(
      `SELECT a.id AS acct_id, a.name AS acct_name, a.created_at AS acct_created_at, p.*
         FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.id = $1`,
      [req.accountId],
    );
    const row = r.rows[0];
    return { id: row.acct_id, name: row.acct_name, createdAt: row.acct_created_at, plan: serializePlan(row as PlanRow) };
  });

  app.put('/account/plan', async (req) => {
    const { planId } = planBody.parse(req.body);
    await assertAssignablePlan(pool, req.accountId, planId, 'account');
    await pool.query(`UPDATE accounts SET plan_id = $2 WHERE id = $1`, [req.accountId, planId]);
    return { accountId: req.accountId, planId };
  });
}

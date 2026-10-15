import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError, pgErrorCode } from '../errors';
import { serializePlan, type PlanRow } from '../services/plans';

const MAX = 1_000_000_000_000;
const allowance = z.number().int().min(0).max(MAX);
const perRequest = z.number().int().min(1).max(MAX);

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['account', 'user']),
  monthlyAllowance: allowance,
  maxUnitsPerRequest: perRequest.nullable().optional(),
});
const patchBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    monthlyAllowance: allowance.optional(),
    maxUnitsPerRequest: perRequest.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

export function planRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/plans', async (req) => {
    const { kind } = z.object({ kind: z.enum(['account', 'user']).optional() }).parse(req.query);
    const r = await pool.query<PlanRow>(
      `SELECT * FROM plans WHERE (account_id IS NULL OR account_id = $1) AND ($2::text IS NULL OR kind = $2)
        ORDER BY (account_id IS NOT NULL), kind, name`,
      [req.accountId, kind ?? null],
    );
    return { plans: r.rows.map(serializePlan) };
  });

  app.get('/plans/:planId', async (req) => {
    const { planId } = req.params as { planId: string };
    const r = await pool.query<PlanRow>(`SELECT * FROM plans WHERE id = $1 AND (account_id IS NULL OR account_id = $2)`, [planId, req.accountId]);
    if (!r.rowCount) throw new AppError(404, 'PLAN_NOT_FOUND', `Plan "${planId}" not found`);
    return serializePlan(r.rows[0]);
  });

  app.post('/plans', async (req, reply) => {
    const b = createBody.parse(req.body);
    const id = `plan_${randomUUID()}`;
    try {
      const r = await pool.query<PlanRow>(
        `INSERT INTO plans (id, account_id, kind, name, monthly_allowance, max_units_per_request)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, req.accountId, b.kind, b.name, b.monthlyAllowance, b.maxUnitsPerRequest ?? null],
      );
      reply.code(201);
      return serializePlan(r.rows[0]);
    } catch (e) {
      if (pgErrorCode(e) === '23505') throw new AppError(409, 'PLAN_NAME_EXISTS', `You already have a plan named "${b.name}"`);
      throw e;
    }
  });

  // Updates take effect for all subsequent consumption decisions; usage totals are untouched.
  app.patch('/plans/:planId', async (req) => {
    const { planId } = req.params as { planId: string };
    const b = patchBody.parse(req.body);
    await assertOwnPlan(pool, req.accountId, planId);
    try {
      const r = await pool.query<PlanRow>(
        `UPDATE plans SET
           name = COALESCE($3, name),
           monthly_allowance = COALESCE($4, monthly_allowance),
           max_units_per_request = CASE WHEN $5 THEN $6::bigint ELSE max_units_per_request END,
           updated_at = now()
         WHERE id = $1 AND account_id = $2 RETURNING *`,
        [planId, req.accountId, b.name ?? null, b.monthlyAllowance ?? null, b.maxUnitsPerRequest !== undefined, b.maxUnitsPerRequest ?? null],
      );
      return serializePlan(r.rows[0]);
    } catch (e) {
      if (pgErrorCode(e) === '23505') throw new AppError(409, 'PLAN_NAME_EXISTS', `You already have a plan named "${b.name}"`);
      throw e;
    }
  });

  app.delete('/plans/:planId', async (req, reply) => {
    const { planId } = req.params as { planId: string };
    await assertOwnPlan(pool, req.accountId, planId);
    try {
      await pool.query(`DELETE FROM plans WHERE id = $1 AND account_id = $2`, [planId, req.accountId]);
    } catch (e) {
      if (pgErrorCode(e) === '23503') throw new AppError(409, 'PLAN_IN_USE', `Plan "${planId}" is assigned to the account or to users and cannot be deleted`);
      throw e;
    }
    return reply.code(204).send();
  });
}

async function assertOwnPlan(pool: Pool, accountId: string, planId: string) {
  const r = await pool.query(`SELECT account_id FROM plans WHERE id = $1 AND (account_id IS NULL OR account_id = $2)`, [planId, accountId]);
  if (!r.rowCount) throw new AppError(404, 'PLAN_NOT_FOUND', `Plan "${planId}" not found`);
  if (r.rows[0].account_id === null) throw new AppError(403, 'PLAN_READ_ONLY', `Plan "${planId}" is predefined and read-only`);
}

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError, pgErrorCode } from '../errors';
import { assertAssignablePlan } from '../services/plans';

const userId = z.string().min(1).max(200);
const serialize = (r: { user_id: string; plan_id: string; created_at: Date }) => ({ userId: r.user_id, planId: r.plan_id, createdAt: r.created_at });

export function userRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/users', async (req, reply) => {
    const b = z.object({ userId, planId: z.string().min(1).max(100).default('basic') }).parse(req.body);
    await assertAssignablePlan(pool, req.accountId, b.planId, 'user');
    try {
      const r = await pool.query(`INSERT INTO users (account_id, user_id, plan_id) VALUES ($1, $2, $3) RETURNING *`, [req.accountId, b.userId, b.planId]);
      reply.code(201);
      return serialize(r.rows[0]);
    } catch (e) {
      if (pgErrorCode(e) === '23505') throw new AppError(409, 'USER_EXISTS', `User "${b.userId}" already exists`);
      if (pgErrorCode(e) === '23503') throw new AppError(404, 'PLAN_NOT_FOUND', `Plan "${b.planId}" no longer exists`);
      throw e;
    }
  });

  app.get('/users', async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100), after: z.string().optional() })
      .parse(req.query);
    const r = await pool.query(
      `SELECT * FROM users WHERE account_id = $1 AND ($2::text IS NULL OR user_id > $2) ORDER BY user_id LIMIT $3`,
      [req.accountId, q.after ?? null, q.limit],
    );
    return { users: r.rows.map(serialize), nextAfter: r.rowCount === q.limit ? r.rows[r.rows.length - 1].user_id : null };
  });

  app.get('/users/:userId', async (req) => {
    const { userId: id } = req.params as { userId: string };
    const r = await pool.query(`SELECT * FROM users WHERE account_id = $1 AND user_id = $2`, [req.accountId, id]);
    if (!r.rowCount) throw new AppError(404, 'USER_NOT_FOUND', `User "${id}" is not registered under this account`);
    return serialize(r.rows[0]);
  });

  app.put('/users/:userId/plan', async (req) => {
    const { userId: id } = req.params as { userId: string };
    const { planId } = z.object({ planId: z.string().min(1).max(100) }).parse(req.body);
    await assertAssignablePlan(pool, req.accountId, planId, 'user');
    try {
      const r = await pool.query(`UPDATE users SET plan_id = $3 WHERE account_id = $1 AND user_id = $2 RETURNING *`, [req.accountId, id, planId]);
      if (!r.rowCount) throw new AppError(404, 'USER_NOT_FOUND', `User "${id}" is not registered under this account`);
      return serialize(r.rows[0]);
    } catch (e) {
      if (pgErrorCode(e) === '23503') throw new AppError(404, 'PLAN_NOT_FOUND', `Plan "${planId}" no longer exists`);
      throw e;
    }
  });
}

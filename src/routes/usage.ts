import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors';
import { periodOf } from '../db';
import { accountUsage, usageHistory, userUsage } from '../services/usage';

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be YYYY-MM (UTC)');
const currentPeriod = (now: Date) => periodOf(now).slice(0, 7);

export function usageRoutes(app: FastifyInstance, pool: Pool, now: () => Date) {
  app.get('/usage', async (req) => {
    const { period } = z.object({ period: periodSchema.optional() }).parse(req.query);
    return accountUsage(pool, req.accountId, period ?? currentPeriod(now()), now());
  });

  app.get('/usage/history', async (req) => {
    const { userId } = z.object({ userId: z.string().min(1).optional() }).parse(req.query);
    if (userId) await assertUser(pool, req.accountId, userId);
    return { scope: userId ? 'user' : 'account', userId: userId ?? null, periods: await usageHistory(pool, req.accountId, userId) };
  });

  app.get('/users/:userId/usage', async (req) => {
    const { userId } = req.params as { userId: string };
    const { period } = z.object({ period: periodSchema.optional() }).parse(req.query);
    const r = await userUsage(pool, req.accountId, userId, period ?? currentPeriod(now()), now());
    if (!r) throw new AppError(404, 'USER_NOT_FOUND', `User "${userId}" is not registered under this account`);
    return r;
  });

  app.get('/requests', async (req) => {
    const q = z
      .object({
        userId: z.string().min(1).optional(),
        status: z.enum(['accepted', 'rejected']).optional(),
        period: periodSchema.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        before: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    const r = await pool.query(
      `SELECT id, user_id, request_id, units, status, period, created_at, outcome FROM consumption_requests
        WHERE account_id = $1 AND ($2::text IS NULL OR user_id = $2) AND ($3::text IS NULL OR status = $3)
          AND ($4::date IS NULL OR period = $4::date) AND ($5::bigint IS NULL OR id < $5)
        ORDER BY id DESC LIMIT $6`,
      [req.accountId, q.userId ?? null, q.status ?? null, q.period ? `${q.period}-01` : null, q.before ?? null, q.limit],
    );
    return {
      requests: r.rows.map((x) => ({
        id: x.id,
        requestId: x.request_id,
        userId: x.user_id,
        units: x.units,
        status: x.status,
        period: x.period.slice(0, 7),
        timestamp: x.created_at,
        ...(x.status === 'accepted' ? { account: x.outcome.account, user: x.outcome.user } : { reason: x.outcome.reason }),
      })),
      nextBefore: r.rowCount === q.limit ? r.rows[r.rows.length - 1].id : null,
    };
  });
}

async function assertUser(pool: Pool, accountId: string, userId: string) {
  const r = await pool.query(`SELECT 1 FROM users WHERE account_id = $1 AND user_id = $2`, [accountId, userId]);
  if (!r.rowCount) throw new AppError(404, 'USER_NOT_FOUND', `User "${userId}" is not registered under this account`);
}

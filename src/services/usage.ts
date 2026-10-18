import type { Pool } from 'pg';
import { periodOf } from '../db';

/** 'YYYY-MM' -> 'YYYY-MM-01' */
export const toPeriodDate = (p: string) => `${p}-01`;

export interface Allowance {
  planId: string;
  limit: number | null;
  used: number;
  remaining: number | null;
}

// Limits/remaining are derived from the *current* plan, so they are only reported for the current UTC month.
function allowance(planId: string, allow: number, used: number, current: boolean): Allowance {
  return current
    ? { planId, limit: allow, used, remaining: Math.max(0, allow - used) }
    : { planId, limit: null, used, remaining: null };
}

export async function accountUsage(pool: Pool, accountId: string, period: string, now: Date, limit = 100, after?: string) {
  const current = toPeriodDate(period) === periodOf(now);
  const acc = await pool.query(
    `SELECT a.plan_id, p.monthly_allowance, COALESCE(au.used, 0) AS used
       FROM accounts a JOIN plans p ON p.id = a.plan_id
       LEFT JOIN account_usage au ON au.account_id = a.id AND au.period = $2
      WHERE a.id = $1`,
    [accountId, toPeriodDate(period)],
  );
  const users = await pool.query(
    `SELECT u.user_id, u.plan_id, p.monthly_allowance, uu.used
       FROM users u JOIN plans p ON p.id = u.plan_id
       LEFT JOIN user_usage uu ON uu.account_id = u.account_id AND uu.user_id = u.user_id AND uu.period = $2
       WHERE u.account_id = $1 AND ($3 OR uu.used IS NOT NULL)
         AND ($4::text IS NULL OR u.user_id > $4)
      ORDER BY u.user_id LIMIT $5`,
    [accountId, toPeriodDate(period), current, after ?? null, limit + 1],
  );
  const a = acc.rows[0];
  const page = users.rows.slice(0, limit);
  return {
    period,
    current,
    account: allowance(a.plan_id, a.monthly_allowance, a.used, current),
    users: page.map((u) => ({ userId: u.user_id, ...allowance(u.plan_id, u.monthly_allowance, u.used ?? 0, current) })),
    nextAfter: users.rows.length > limit ? page[page.length - 1].user_id : null,
  };
}

export async function userUsage(pool: Pool, accountId: string, userId: string, period: string, now: Date) {
  const current = toPeriodDate(period) === periodOf(now);
  const r = await pool.query(
    `SELECT u.plan_id, p.monthly_allowance, COALESCE(uu.used, 0) AS used,
            ap.id AS a_plan, ap.monthly_allowance AS a_allow, COALESCE(au.used, 0) AS a_used
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       JOIN accounts a ON a.id = u.account_id
       JOIN plans ap ON ap.id = a.plan_id
       LEFT JOIN user_usage uu ON uu.account_id = u.account_id AND uu.user_id = u.user_id AND uu.period = $3
       LEFT JOIN account_usage au ON au.account_id = u.account_id AND au.period = $3
      WHERE u.account_id = $1 AND u.user_id = $2`,
    [accountId, userId, toPeriodDate(period)],
  );
  if (!r.rowCount) return null;
  const x = r.rows[0];
  return {
    period,
    current,
    userId,
    user: allowance(x.plan_id, x.monthly_allowance, x.used, current),
    account: allowance(x.a_plan, x.a_allow, x.a_used, current),
  };
}

export async function usageHistory(pool: Pool, accountId: string, userId?: string, limit = 100, after?: string) {
  const afterDate = after ? toPeriodDate(after) : null;
  const r = userId
    ? await pool.query(
        `SELECT to_char(period, 'YYYY-MM') AS period, used FROM user_usage
          WHERE account_id = $1 AND user_id = $2 AND ($3::date IS NULL OR period < $3::date)
          ORDER BY period DESC LIMIT $4`,
        [accountId, userId, afterDate, limit + 1],
      )
    : await pool.query(
        `SELECT to_char(period, 'YYYY-MM') AS period, used FROM account_usage
          WHERE account_id = $1 AND ($2::date IS NULL OR period < $2::date)
          ORDER BY period DESC LIMIT $3`,
        [accountId, afterDate, limit + 1],
      );
  const page = r.rows.slice(0, limit) as { period: string; used: number }[];
  return {
    periods: page,
    nextAfter: r.rows.length > limit ? page[page.length - 1].period : null,
  };
}

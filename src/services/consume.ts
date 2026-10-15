import type { Pool, PoolClient } from 'pg';
import { AppError } from '../errors';
import { periodOf } from '../db';

export interface ConsumeInput {
  accountId: string;
  userId: string;
  requestId: string;
  units: number;
}

interface PlanLimits {
  id: string;
  monthly_allowance: number;
  max_units_per_request: number | null;
}

interface Balance {
  planId: string;
  limit: number;
  used: number;
  remaining: number;
}

export interface RejectionReason {
  code: string;
  scope: 'account' | 'user';
  accountId: string;
  userId?: string;
  rule: 'max_units_per_request' | 'monthly_allowance';
  message: string;
  requested: number;
  limit: number;
  used?: number;
  remaining?: number;
}

export type Outcome =
  | { accepted: true; account: Balance; user: Balance }
  | { accepted: false; reason: RejectionReason };

export interface ConsumeResult {
  accepted: boolean;
  requestId: string;
  userId: string;
  units: number;
  period: string; // YYYY-MM (UTC)
  timestamp: Date;
  replayed: boolean;
  account?: Balance;
  user?: Balance;
  reason?: RejectionReason;
}

const balance = (planId: string, limit: number, used: number): Balance => ({
  planId,
  limit,
  used,
  remaining: Math.max(0, limit - used),
});

function toResult(
  row: { user_id: string; request_id: string; units: number; period: string; created_at: Date; outcome: Outcome },
  replayed: boolean,
): ConsumeResult {
  return {
    accepted: row.outcome.accepted,
    requestId: row.request_id,
    userId: row.user_id,
    units: row.units,
    period: row.period.slice(0, 7),
    timestamp: row.created_at,
    replayed,
    ...(row.outcome.accepted ? { account: row.outcome.account, user: row.outcome.user } : { reason: row.outcome.reason }),
  };
}

/**
 * Decides and records one consumption request in a single transaction.
 *
 * Concurrency design (READ COMMITTED):
 *  1. A transaction-scoped advisory lock on (account, requestId) serialises duplicates of the same
 *     request, so an idempotent replay always sees the original outcome and never consumes twice.
 *  2. The account row, user row and both plan rows are read FOR SHARE. A plan update or reassignment
 *     therefore waits for in-flight decisions and later decisions see the new plan.
 *  3. Counter rows are locked FOR UPDATE in a fixed order (account, then user). Decisions for the same
 *     account are serialised on the account counter, so allowances cannot be overspent.
 */
export async function consume(pool: Pool, now: Date, input: ConsumeInput): Promise<ConsumeResult> {
  const { accountId, userId, requestId, units } = input;
  const period = periodOf(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await decide(client, now, period, input);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  async function decide(c: PoolClient, ts: Date, per: string, i: ConsumeInput): Promise<ConsumeResult> {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${accountId}:${requestId}`]);

    const existing = await c.query(
      `SELECT user_id, request_id, units, period, created_at, outcome
         FROM consumption_requests WHERE account_id = $1 AND request_id = $2`,
      [accountId, requestId],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.user_id !== userId || row.units !== units) {
        throw new AppError(
          409,
          'IDEMPOTENCY_CONFLICT',
          `requestId "${requestId}" was already used with different parameters (userId "${row.user_id}", units ${row.units})`,
        );
      }
      return toResult(row, true);
    }

    const ctx = await c.query(
      `SELECT ap.id AS a_id, ap.monthly_allowance AS a_allow, ap.max_units_per_request AS a_max,
              up.id AS u_id, up.monthly_allowance AS u_allow, up.max_units_per_request AS u_max
         FROM users u
         JOIN accounts a ON a.id = u.account_id
         JOIN plans ap ON ap.id = a.plan_id
         JOIN plans up ON up.id = u.plan_id
        WHERE u.account_id = $1 AND u.user_id = $2
          FOR SHARE OF u, a, ap, up`,
      [accountId, userId],
    );
    if (!ctx.rowCount) throw new AppError(404, 'USER_NOT_FOUND', `User "${userId}" is not registered under this account`);
    const r = ctx.rows[0];
    const aPlan: PlanLimits = { id: r.a_id, monthly_allowance: r.a_allow, max_units_per_request: r.a_max };
    const uPlan: PlanLimits = { id: r.u_id, monthly_allowance: r.u_allow, max_units_per_request: r.u_max };

    await c.query(
      `WITH a AS (INSERT INTO account_usage (account_id, period) VALUES ($1, $2) ON CONFLICT DO NOTHING)
       INSERT INTO user_usage (account_id, user_id, period) VALUES ($1, $3, $2) ON CONFLICT DO NOTHING`,
      [accountId, per, userId],
    );
    const aUsed = (await c.query(`SELECT used FROM account_usage WHERE account_id = $1 AND period = $2 FOR UPDATE`, [accountId, per])).rows[0].used as number;
    const uUsed = (
      await c.query(`SELECT used FROM user_usage WHERE account_id = $1 AND user_id = $2 AND period = $3 FOR UPDATE`, [accountId, userId, per])
    ).rows[0].used as number;

    const scopes = [
      { scope: 'account' as const, plan: aPlan, used: aUsed },
      { scope: 'user' as const, plan: uPlan, used: uUsed },
    ];
    const subject = (s: 'account' | 'user') => (s === 'account' ? `Account ${accountId}` : `User "${userId}" of account ${accountId}`);

    let reason: RejectionReason | undefined;
    // Rule order is fixed: per-request caps (account, user), then monthly allowances (account, user).
    for (const s of scopes) {
      const max = s.plan.max_units_per_request;
      if (!reason && max !== null && units > max) {
        reason = {
          code: `${s.scope.toUpperCase()}_MAX_UNITS_PER_REQUEST_EXCEEDED`,
          scope: s.scope,
          accountId,
          ...(s.scope === 'user' ? { userId } : {}),
          rule: 'max_units_per_request',
          message: `${subject(s.scope)}: requested ${units} units exceeds the per-request maximum of ${max} (plan "${s.plan.id}")`,
          requested: units,
          limit: max,
        };
      }
    }
    for (const s of scopes) {
      const remaining = Math.max(0, s.plan.monthly_allowance - s.used);
      if (!reason && units > remaining) {
        reason = {
          code: `${s.scope.toUpperCase()}_MONTHLY_ALLOWANCE_EXCEEDED`,
          scope: s.scope,
          accountId,
          ...(s.scope === 'user' ? { userId } : {}),
          rule: 'monthly_allowance',
          message: `${subject(s.scope)}: requested ${units} units but only ${remaining} remain of the monthly allowance ${s.plan.monthly_allowance} (plan "${s.plan.id}", used ${s.used})`,
          requested: units,
          limit: s.plan.monthly_allowance,
          used: s.used,
          remaining,
        };
      }
    }

    let outcome: Outcome;
    if (reason) {
      outcome = { accepted: false, reason };
    } else {
      await c.query(
        `WITH a AS (UPDATE account_usage SET used = used + $3 WHERE account_id = $1 AND period = $2)
         UPDATE user_usage SET used = used + $3 WHERE account_id = $1 AND user_id = $4 AND period = $2`,
        [accountId, per, units, userId],
      );
      outcome = {
        accepted: true,
        account: balance(aPlan.id, aPlan.monthly_allowance, aUsed + units),
        user: balance(uPlan.id, uPlan.monthly_allowance, uUsed + units),
      };
    }

    await c.query(
      `INSERT INTO consumption_requests (account_id, user_id, request_id, units, status, period, created_at, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [accountId, userId, requestId, units, outcome.accepted ? 'accepted' : 'rejected', per, ts, JSON.stringify(outcome)],
    );
    return toResult({ user_id: userId, request_id: requestId, units, period: per, created_at: ts, outcome }, false);
  }
}

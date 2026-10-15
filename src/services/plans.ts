import type { Pool } from 'pg';
import { AppError } from '../errors';

export interface PlanRow {
  id: string;
  account_id: string | null;
  kind: 'account' | 'user';
  name: string;
  monthly_allowance: number;
  max_units_per_request: number | null;
  created_at: Date;
  updated_at: Date;
}

export function serializePlan(p: PlanRow) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    predefined: p.account_id === null,
    monthlyAllowance: p.monthly_allowance,
    maxUnitsPerRequest: p.max_units_per_request,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** A plan can be assigned if it is predefined or owned by the account, and has the right kind. */
export async function assertAssignablePlan(pool: Pool, accountId: string | null, planId: string, kind: 'account' | 'user') {
  const r = await pool.query<PlanRow>(
    `SELECT * FROM plans WHERE id = $1 AND (account_id IS NULL OR account_id = $2)`,
    [planId, accountId],
  );
  if (!r.rowCount) throw new AppError(404, 'PLAN_NOT_FOUND', `Plan "${planId}" does not exist or is not available to this account`);
  if (r.rows[0].kind !== kind) {
    throw new AppError(422, 'PLAN_KIND_MISMATCH', `Plan "${planId}" is a ${r.rows[0].kind} plan; a ${kind} plan is required`);
  }
}

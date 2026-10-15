import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app';
import { createPool, migrate } from '../src/db';

export const ADMIN = 'test-admin-token';
export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/quota_test';

export interface Ctx {
  pool: Pool;
  app: FastifyInstance;
  clock: { now: Date };
}

export async function setup(poolMax = 20): Promise<Ctx> {
  const pool = createPool(TEST_DB, poolMax);
  await migrate(pool);
  const clock = { now: new Date('2026-10-15T12:00:00Z') };
  const app = buildApp({ pool, adminToken: ADMIN, now: () => clock.now });
  await app.ready();
  return { pool, app, clock };
}

export async function teardown(c: Ctx) {
  await c.app.close();
  await c.pool.end();
}

/** Wipes everything except the predefined plans. */
export async function reset(pool: Pool) {
  await pool.query('DELETE FROM consumption_requests');
  await pool.query('DELETE FROM user_usage');
  await pool.query('DELETE FROM account_usage');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM accounts'); // cascades to custom plans
}

export interface Api {
  accountId: string;
  key: string;
  call: (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => Promise<{ status: number; body: any }>;
  createUser: (userId: string, planId?: string) => Promise<any>;
  createPlan: (name: string, kind: 'account' | 'user', monthlyAllowance: number, maxUnitsPerRequest?: number | null) => Promise<any>;
  consume: (userId: string, units: number, requestId: string) => Promise<{ status: number; body: any }>;
}

export async function createAccount(app: FastifyInstance, name = 'acme', planId?: string): Promise<Api> {
  const res = await app.inject({ method: 'POST', url: '/admin/accounts', headers: { 'x-admin-token': ADMIN }, payload: { name, ...(planId ? { planId } : {}) } });
  if (res.statusCode !== 201) throw new Error(`account creation failed: ${res.body}`);
  const { id, apiKey } = res.json();
  const call: Api['call'] = async (method, url, body) => {
    const r = await app.inject({ method, url: `/v1${url}`, headers: { 'x-api-key': apiKey }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  return {
    accountId: id,
    key: apiKey,
    call,
    createUser: async (userId, plan) => {
      const r = await call('POST', '/users', { userId, ...(plan ? { planId: plan } : {}) });
      if (r.status !== 201) throw new Error(`user creation failed: ${JSON.stringify(r.body)}`);
      return r.body;
    },
    createPlan: async (n, kind, monthlyAllowance, maxUnitsPerRequest) => {
      const r = await call('POST', '/plans', { name: n, kind, monthlyAllowance, maxUnitsPerRequest });
      if (r.status !== 201) throw new Error(`plan creation failed: ${JSON.stringify(r.body)}`);
      return r.body;
    },
    consume: (userId, units, requestId) => call('POST', '/consume', { userId, units, requestId }),
  };
}

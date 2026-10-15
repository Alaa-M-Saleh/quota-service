import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createPool } from '../src/db';
import { ADMIN, TEST_DB, createAccount, reset, setup, teardown, type Api, type Ctx } from './helpers';

let c: Ctx;
beforeAll(async () => { c = await setup(); });
afterAll(() => teardown(c));
beforeEach(async () => { await reset(c.pool); c.clock.now = new Date('2026-10-15T12:00:00Z'); });

/** Account allowance 50, user allowance 30, no per-request caps. */
async function scenario(): Promise<{ a: Api; accPlan: any; userPlan: any }> {
  const a = await createAccount(c.app);
  const accPlan = await a.createPlan('acc', 'account', 50);
  const userPlan = await a.createPlan('usr', 'user', 30);
  await a.call('PUT', '/account/plan', { planId: accPlan.id });
  await a.createUser('alice', userPlan.id);
  await a.createUser('bob', userPlan.id);
  return { a, accPlan, userPlan };
}

describe('consumption decisions', () => {
  it('accepts a request and reports balances', async () => {
    const { a } = await scenario();
    const r = await a.consume('alice', 10, 'r1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: true, units: 10, period: '2026-10', replayed: false });
    expect(r.body.account).toMatchObject({ limit: 50, used: 10, remaining: 40 });
    expect(r.body.user).toMatchObject({ limit: 30, used: 10, remaining: 20 });
  });

  it('rejects on the user limit and consumes nothing', async () => {
    const { a } = await scenario();
    await a.consume('alice', 10, 'r1');
    const r = await a.consume('alice', 25, 'r2');
    expect(r.body.accepted).toBe(false);
    expect(r.body.reason).toMatchObject({ code: 'USER_MONTHLY_ALLOWANCE_EXCEEDED', scope: 'user', userId: 'alice', accountId: a.accountId, requested: 25, remaining: 20, limit: 30 });
    expect(r.body.reason.message).toContain('alice');
    const u = (await a.call('GET', '/usage')).body;
    expect(u.account.used).toBe(10);
    expect(u.users.find((x: any) => x.userId === 'alice').used).toBe(10);
  });

  it('rejects on the shared account limit even if the user still has allowance', async () => {
    const { a } = await scenario();
    await a.consume('alice', 10, 'r1');
    await a.consume('bob', 30, 'r2');
    const r = await a.consume('alice', 15, 'r3'); // alice 25/30 fine, account 55/50 not
    expect(r.body.accepted).toBe(false);
    expect(r.body.reason).toMatchObject({ code: 'ACCOUNT_MONTHLY_ALLOWANCE_EXCEEDED', scope: 'account', accountId: a.accountId, remaining: 10, limit: 50 });
    expect(r.body.reason.userId).toBeUndefined();
  });

  it('accepts an exact fit and rejects anything over (all-or-nothing, no partial)', async () => {
    const { a } = await scenario();
    expect((await a.consume('alice', 30, 'r1')).body.accepted).toBe(true);
    expect((await a.consume('alice', 1, 'r2')).body.accepted).toBe(false);
    expect((await a.consume('bob', 21, 'r3')).body.accepted).toBe(false); // only 20 left on the account
    expect((await a.consume('bob', 20, 'r4')).body.accepted).toBe(true);
  });

  it('a larger user allowance does not raise the account allowance', async () => {
    const a = await createAccount(c.app); // starter: 1000
    await a.createUser('big', 'premium'); // 5000
    const r = await a.consume('big', 100, 'r1');
    expect(r.body.accepted).toBe(true);
    let n = 0;
    for (let i = 0; i < 20; i++) if ((await a.consume('big', 100, `x${i}`)).body.accepted) n++;
    expect(n).toBe(9); // 1000 total: 1 + 9 accepted of 100
  });

  it('enforces per-request caps from both plans and reports which one', async () => {
    const a = await createAccount(c.app); // starter cap 100
    await a.createUser('u'); // basic cap 20
    const user = await a.consume('u', 21, 'r1');
    expect(user.body.reason).toMatchObject({ code: 'USER_MAX_UNITS_PER_REQUEST_EXCEEDED', rule: 'max_units_per_request', limit: 20, userId: 'u' });
    await a.createUser('p', 'premium'); // cap 500, account cap 100
    const acc = await a.consume('p', 101, 'r2');
    expect(acc.body.reason).toMatchObject({ code: 'ACCOUNT_MAX_UNITS_PER_REQUEST_EXCEEDED', scope: 'account', limit: 100 });
  });

  it('returns 404 for unknown users without recording anything', async () => {
    const { a } = await scenario();
    expect((await a.consume('ghost', 1, 'r1')).status).toBe(404);
    expect((await a.call('GET', '/requests')).body.requests).toHaveLength(0);
  });
});

describe('idempotency and history', () => {
  it('replays the original accepted outcome without consuming again', async () => {
    const { a } = await scenario();
    const first = await a.consume('alice', 10, 'dup');
    const again = await a.consume('alice', 10, 'dup');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ accepted: true, replayed: true, timestamp: first.body.timestamp });
    expect(again.body.account).toEqual(first.body.account);
    expect((await a.call('GET', '/usage')).body.account.used).toBe(10);
    expect((await a.call('GET', '/requests')).body.requests).toHaveLength(1);
  });

  it('replays the original rejection even if the same request would now be accepted', async () => {
    const { a, userPlan } = await scenario();
    const first = await a.consume('alice', 40, 'rej');
    expect(first.body.accepted).toBe(false);
    await a.call('PATCH', `/plans/${userPlan.id}`, { monthlyAllowance: 100 });
    const again = await a.consume('alice', 40, 'rej');
    expect(again.body).toMatchObject({ accepted: false, replayed: true });
    expect(again.body.reason).toEqual(first.body.reason);
    expect((await a.call('GET', '/usage')).body.account.used).toBe(0);
    // a fresh request id is decided against the new plan
    expect((await a.consume('alice', 40, 'rej2')).body.accepted).toBe(true);
  });

  it('returns 409 when a request id is reused with different parameters (accepted or rejected)', async () => {
    const { a } = await scenario();
    await a.consume('alice', 10, 'k');
    for (const [u, n] of [['alice', 11], ['bob', 10]] as const) {
      const r = await a.consume(u, n, 'k');
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    }
    await a.consume('alice', 99, 'k-rej'); // rejected (user limit 30)
    expect((await a.consume('alice', 98, 'k-rej')).status).toBe(409);
    expect((await a.call('GET', '/usage')).body.account.used).toBe(10);
  });

  it('records accepted and rejected requests with units, user, timestamp and reason; supports filters and paging', async () => {
    const { a } = await scenario();
    await a.consume('alice', 10, 'r1');
    await a.consume('alice', 29, 'r2');
    await a.consume('bob', 5, 'r3');
    const all = (await a.call('GET', '/requests')).body;
    expect(all.requests.map((r: any) => r.requestId)).toEqual(['r3', 'r2', 'r1']); // newest first
    expect(all.requests[1]).toMatchObject({ status: 'rejected', units: 29, userId: 'alice', period: '2026-10' });
    expect(all.requests[1].reason.code).toBe('USER_MONTHLY_ALLOWANCE_EXCEEDED');
    expect(all.requests[1].timestamp).toBe('2026-10-15T12:00:00.000Z');
    expect((await a.call('GET', '/requests?status=rejected')).body.requests).toHaveLength(1);
    expect((await a.call('GET', '/requests?userId=bob')).body.requests).toHaveLength(1);
    const p1 = (await a.call('GET', '/requests?limit=2')).body;
    expect(p1.requests).toHaveLength(2);
    const p2 = (await a.call('GET', `/requests?limit=2&before=${p1.nextBefore}`)).body;
    expect(p2.requests.map((r: any) => r.requestId)).toEqual(['r1']);
  });
});

describe('monthly accounting (UTC calendar months)', () => {
  it('resets allowances on a new UTC month and keeps history queryable', async () => {
    const { a } = await scenario();
    c.clock.now = new Date('2026-10-31T23:59:59Z');
    expect((await a.consume('alice', 30, 'oct')).body.accepted).toBe(true);
    expect((await a.consume('alice', 1, 'oct2')).body.accepted).toBe(false);
    c.clock.now = new Date('2026-11-01T00:00:00Z');
    const nov = await a.consume('alice', 30, 'nov');
    expect(nov.body).toMatchObject({ accepted: true, period: '2026-11' });
    expect(nov.body.user.used).toBe(30);

    const oct = (await a.call('GET', '/usage?period=2026-10')).body;
    expect(oct).toMatchObject({ current: false, account: { used: 30, limit: null, remaining: null } });
    expect(oct.users.find((u: any) => u.userId === 'alice').used).toBe(30);
    expect((await a.call('GET', '/users/alice/usage?period=2026-10')).body.user.used).toBe(30);
    expect((await a.call('GET', '/usage')).body).toMatchObject({ period: '2026-11', current: true, account: { used: 30, remaining: 20 } });
    expect((await a.call('GET', '/usage/history')).body.periods).toEqual([{ period: '2026-11', used: 30 }, { period: '2026-10', used: 30 }]);
    expect((await a.call('GET', '/usage/history?userId=alice')).body.periods).toHaveLength(2);
    expect((await a.call('GET', '/requests?period=2026-10')).body.requests).toHaveLength(2);
    expect((await a.call('GET', '/usage?period=2026-13')).status).toBe(400);
  });
});

describe('plan changes', () => {
  it('applies updates immediately to later requests without resetting usage', async () => {
    const { a, accPlan } = await scenario();
    await a.consume('alice', 10, 'r1');
    await a.consume('bob', 30, 'r2');
    expect((await a.consume('alice', 15, 'r3')).body.accepted).toBe(false);
    await a.call('PATCH', `/plans/${accPlan.id}`, { monthlyAllowance: 200 });
    const r = await a.consume('alice', 15, 'r4');
    expect(r.body.accepted).toBe(true);
    expect(r.body.account).toMatchObject({ limit: 200, used: 55 }); // 40 before + 15, not reset
  });

  it('applies reassignment of a user or account plan immediately', async () => {
    const { a } = await scenario();
    await a.consume('alice', 30, 'r1');
    expect((await a.consume('alice', 1, 'r2')).body.accepted).toBe(false);
    await a.call('PUT', '/users/alice/plan', { planId: 'premium' });
    const r = await a.consume('alice', 1, 'r3'); // premium allows 5000; the account (30/50) still has room
    expect(r.body.accepted).toBe(true);
    expect(r.body.user).toMatchObject({ planId: 'premium', limit: 5000, used: 31 });
    // the account's own limit still binds: only 19 of the original 20 account units remain
    expect((await a.consume('alice', 20, 'r4')).body.reason.code).toBe('ACCOUNT_MONTHLY_ALLOWANCE_EXCEEDED');
  });

  it('reducing an allowance below existing usage leaves zero remaining and rejects further use', async () => {
    const { a, userPlan } = await scenario();
    await a.consume('alice', 25, 'r1');
    await a.call('PATCH', `/plans/${userPlan.id}`, { monthlyAllowance: 10 });
    const u = (await a.call('GET', '/users/alice/usage')).body;
    expect(u.user).toMatchObject({ limit: 10, used: 25, remaining: 0 });
    const r = await a.consume('alice', 1, 'r2');
    expect(r.body.reason).toMatchObject({ code: 'USER_MONTHLY_ALLOWANCE_EXCEEDED', remaining: 0, used: 25, limit: 10 });
    expect((await a.call('GET', '/usage')).body.account.used).toBe(25); // usage untouched
  });

  it('shared plan definitions keep separate usage per user', async () => {
    const { a } = await scenario();
    await a.consume('alice', 30, 'r1');
    expect((await a.consume('bob', 20, 'r2')).body.user).toMatchObject({ used: 20, remaining: 10 });
  });
});

describe('concurrency', () => {
  it('never overspends the shared account allowance', async () => {
    const a = await createAccount(c.app);
    const accPlan = await a.createPlan('acc', 'account', 100);
    const userPlan = await a.createPlan('usr', 'user', 1000);
    await a.call('PUT', '/account/plan', { planId: accPlan.id });
    for (let i = 0; i < 10; i++) await a.createUser(`u${i}`, userPlan.id);
    const results = await Promise.all(Array.from({ length: 400 }, (_, i) => a.consume(`u${i % 10}`, 1, `req-${i}`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.accepted)).toHaveLength(100);
    const u = (await a.call('GET', '/usage')).body;
    expect(u.account).toMatchObject({ used: 100, remaining: 0 });
    const sum = await c.pool.query(`SELECT COALESCE(SUM(units),0)::bigint AS s, count(*) AS n FROM consumption_requests WHERE account_id=$1 AND status='accepted'`, [a.accountId]);
    expect(sum.rows[0].s).toBe(100);
    expect((await a.call('GET', '/requests?limit=500')).body.requests).toHaveLength(400); // every outcome recorded
  });

  it('never overspends a user allowance', async () => {
    const a = await createAccount(c.app, 'acme', 'pro');
    const userPlan = await a.createPlan('usr', 'user', 37);
    await a.createUser('solo', userPlan.id);
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => a.consume('solo', 1, `q${i}`)));
    expect(results.filter((r) => r.body.accepted)).toHaveLength(37);
    expect((await a.call('GET', '/users/solo/usage')).body.user).toMatchObject({ used: 37, remaining: 0 });
  });

  it('counts a request id used by many concurrent callers exactly once', async () => {
    const { a } = await scenario();
    const results = await Promise.all(Array.from({ length: 50 }, () => a.consume('alice', 7, 'same')));
    expect(results.every((r) => r.status === 200 && r.body.accepted)).toBe(true);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect((await a.call('GET', '/usage')).body.account.used).toBe(7);
    const mixed = await Promise.all([a.consume('alice', 3, 'm'), a.consume('alice', 4, 'm'), a.consume('bob', 3, 'm')]);
    expect(mixed.filter((r) => r.status === 200)).toHaveLength(1);
    expect(mixed.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('is consistent when a plan is lowered while requests are in flight', async () => {
    const a = await createAccount(c.app);
    const accPlan = await a.createPlan('acc', 'account', 1000);
    const userPlan = await a.createPlan('usr', 'user', 1000);
    await a.call('PUT', '/account/plan', { planId: accPlan.id });
    await a.createUser('u', userPlan.id);
    const work = Array.from({ length: 300 }, (_, i) => a.consume('u', 1, `r${i}`));
    const patch = a.call('PATCH', `/plans/${accPlan.id}`, { monthlyAllowance: 50 });
    const [, ...results] = await Promise.all([patch, ...work]);
    const used = (await a.call('GET', '/usage')).body.account.used;
    expect(used).toBe(results.filter((r) => r.body.accepted).length);
    expect(used).toBeGreaterThanOrEqual(50); // after the update lands nothing is accepted beyond 50
    // every request decided after the update was judged against 50: later ones are rejected
    expect((await a.consume('u', 1, 'after')).body.accepted).toBe(false);
    // any acceptance beyond 50 must have been decided under the old limit, i.e. before the update committed
    const accepted = (await a.call('GET', '/requests?status=accepted&limit=500')).body.requests;
    expect(accepted.every((r: any) => r.account.limit === 1000 || r.account.used <= 50)).toBe(true);
  });
});

describe('persistence', () => {
  it('keeps data and decisions across a service restart (new pool and app instance)', async () => {
    const { a } = await scenario();
    await a.consume('alice', 10, 'persist');
    await c.app.close();
    await c.pool.end();

    const pool2 = createPool(TEST_DB, 5);
    const app2 = buildApp({ pool: pool2, adminToken: ADMIN, now: () => c.clock.now });
    await app2.ready();
    const call = async (url: string, method: 'GET' | 'POST' = 'GET', payload?: object) =>
      (await app2.inject({ method, url: `/v1${url}`, headers: { 'x-api-key': a.key }, ...(payload ? { payload } : {}) })).json();
    expect((await call('/usage')).account.used).toBe(10);
    const replay = await call('/consume', 'POST', { userId: 'alice', units: 10, requestId: 'persist' });
    expect(replay).toMatchObject({ accepted: true, replayed: true });
    expect((await call('/usage')).account.used).toBe(10);
    await app2.close();
    await pool2.end();
    // restore shared context for afterAll
    c = await setup();
  });
});

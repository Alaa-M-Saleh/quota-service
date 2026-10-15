import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccount, reset, setup, teardown, ADMIN, type Ctx } from './helpers';

let c: Ctx;
beforeAll(async () => { c = await setup(); });
afterAll(() => teardown(c));
beforeEach(() => reset(c.pool));

describe('bootstrap, authentication and isolation', () => {
  it('requires the admin token to create accounts', async () => {
    const r = await c.app.inject({ method: 'POST', url: '/admin/accounts', payload: { name: 'x' } });
    expect(r.statusCode).toBe(401);
    const r2 = await c.app.inject({ method: 'POST', url: '/admin/accounts', headers: { 'x-admin-token': 'wrong-token-1' }, payload: { name: 'x' } });
    expect(r2.statusCode).toBe(401);
  });

  it('creates an account with an API key and a default Starter plan; stores only a hash', async () => {
    const a = await createAccount(c.app);
    expect(a.key).toMatch(/^qk_[0-9a-f]{64}$/);
    const info = await a.call('GET', '/account');
    expect(info.body.plan.id).toBe('starter');
    const stored = await c.pool.query('SELECT api_key_hash FROM accounts WHERE id = $1', [a.accountId]);
    expect(stored.rows[0].api_key_hash).not.toContain(a.key);
  });

  it('rejects missing and invalid API keys', async () => {
    const none = await c.app.inject({ method: 'GET', url: '/v1/account' });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('API_KEY_MISSING');
    const bad = await c.app.inject({ method: 'GET', url: '/v1/account', headers: { 'x-api-key': 'qk_nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('API_KEY_INVALID');
    const consumeNoKey = await c.app.inject({ method: 'POST', url: '/v1/consume', payload: { userId: 'u', units: 1, requestId: 'r' } });
    expect(consumeNoKey.statusCode).toBe(401);
  });

  it('keeps accounts, users, plans and usage separate', async () => {
    const a = await createAccount(c.app, 'A');
    const b = await createAccount(c.app, 'B');
    await a.createUser('alice');
    const plan = await a.createPlan('a-private', 'user', 10);

    // B cannot see or use A's user
    expect((await b.call('GET', '/users/alice')).status).toBe(404);
    expect((await b.consume('alice', 1, 'r1')).status).toBe(404);
    expect((await b.call('GET', '/users/alice/usage')).status).toBe(404);
    expect((await b.call('GET', '/usage/history?userId=alice')).status).toBe(404);
    // B cannot see, use or modify A's custom plan
    expect((await b.call('GET', `/plans/${plan.id}`)).status).toBe(404);
    expect((await b.call('PATCH', `/plans/${plan.id}`, { monthlyAllowance: 1 })).status).toBe(404);
    expect((await b.call('DELETE', `/plans/${plan.id}`)).status).toBe(404);
    await b.createUser('bob');
    expect((await b.call('PUT', '/users/bob/plan', { planId: plan.id })).status).toBe(404);
    expect((await b.call('GET', '/plans')).body.plans.some((p: any) => p.id === plan.id)).toBe(false);

    // same user id under both accounts has independent usage
    await b.createUser('alice');
    await a.consume('alice', 5, 'same-req-id'); // request ids are scoped per account
    const rb = await b.consume('alice', 7, 'same-req-id');
    expect(rb.status).toBe(200);
    expect(rb.body.user.used).toBe(7);
    expect((await a.call('GET', '/usage')).body.account.used).toBe(5);
    expect((await b.call('GET', '/usage')).body.account.used).toBe(7);
    expect((await b.call('GET', '/requests')).body.requests).toHaveLength(1);
  });

  it('admin token does not grant access to /v1 and API key does not grant admin access', async () => {
    const a = await createAccount(c.app);
    const r = await c.app.inject({ method: 'GET', url: '/v1/account', headers: { 'x-admin-token': ADMIN } });
    expect(r.statusCode).toBe(401);
    const r2 = await c.app.inject({ method: 'POST', url: '/admin/accounts', headers: { 'x-api-key': a.key }, payload: { name: 'x' } });
    expect(r2.statusCode).toBe(401);
  });

  it('validates input', async () => {
    const a = await createAccount(c.app);
    await a.createUser('u');
    for (const units of [0, -1, 1.5, '3', null, 1e12]) {
      const r = await a.call('POST', '/consume', { userId: 'u', units, requestId: 'x' });
      expect(r.status, `units=${String(units)}`).toBe(400);
    }
    expect((await a.call('POST', '/consume', { userId: 'u', units: 1 })).status).toBe(400);
    expect((await a.call('POST', '/consume', { units: 1, requestId: 'x' })).status).toBe(400);
    expect((await a.call('GET', '/requests')).body.requests).toHaveLength(0); // invalid requests record nothing
  });
});

describe('users and plans', () => {
  it('ships predefined plans for accounts and users', async () => {
    const a = await createAccount(c.app);
    const plans = (await a.call('GET', '/plans')).body.plans;
    const byId = Object.fromEntries(plans.map((p: any) => [p.id, p]));
    expect(byId.starter).toMatchObject({ kind: 'account', predefined: true, monthlyAllowance: 1000, maxUnitsPerRequest: 100 });
    expect(byId.pro).toMatchObject({ kind: 'account', monthlyAllowance: 100000 });
    expect(byId.basic).toMatchObject({ kind: 'user', monthlyAllowance: 100 });
    expect(byId.premium).toMatchObject({ kind: 'user', monthlyAllowance: 5000 });
  });

  it('predefined plans are read-only', async () => {
    const a = await createAccount(c.app);
    expect((await a.call('PATCH', '/plans/starter', { monthlyAllowance: 5 })).status).toBe(403);
    expect((await a.call('DELETE', '/plans/starter')).status).toBe(403);
  });

  it('registers, lists and re-plans users; enforces plan kind', async () => {
    const a = await createAccount(c.app, 'acme', 'pro');
    expect((await a.createUser('u1')).planId).toBe('basic');
    await a.createUser('u2', 'premium');
    expect((await a.call('POST', '/users', { userId: 'u1' })).status).toBe(409);
    expect((await a.call('POST', '/users', { userId: 'u3', planId: 'pro' })).status).toBe(422); // account plan on a user
    expect((await a.call('PUT', '/account/plan', { planId: 'premium' })).status).toBe(422); // user plan on an account
    expect((await a.call('POST', '/users', { userId: 'u3', planId: 'nope' })).status).toBe(404);
    expect((await a.call('PUT', '/users/u1/plan', { planId: 'premium' })).body.planId).toBe('premium');
    expect((await a.call('PUT', '/users/ghost/plan', { planId: 'premium' })).status).toBe(404);
    const list = (await a.call('GET', '/users')).body.users;
    expect(list.map((u: any) => u.userId)).toEqual(['u1', 'u2']);
  });

  it('creates, updates and deletes custom plans; refuses to delete assigned plans', async () => {
    const a = await createAccount(c.app);
    const p = await a.createPlan('mine', 'user', 50, 10);
    expect(p).toMatchObject({ predefined: false, monthlyAllowance: 50, maxUnitsPerRequest: 10 });
    expect((await a.call('POST', '/plans', { name: 'mine', kind: 'user', monthlyAllowance: 1 })).status).toBe(409);
    const up = await a.call('PATCH', `/plans/${p.id}`, { monthlyAllowance: 60, maxUnitsPerRequest: null });
    expect(up.body).toMatchObject({ monthlyAllowance: 60, maxUnitsPerRequest: null });
    await a.createUser('u', p.id);
    const del = await a.call('DELETE', `/plans/${p.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('PLAN_IN_USE');
    await a.call('PUT', '/users/u/plan', { planId: 'basic' });
    expect((await a.call('DELETE', `/plans/${p.id}`)).status).toBe(204);
    expect((await a.call('GET', `/plans/${p.id}`)).status).toBe(404);
  });

  it('cannot delete the plan assigned to the account', async () => {
    const a = await createAccount(c.app);
    const p = await a.createPlan('acct', 'account', 500);
    await a.call('PUT', '/account/plan', { planId: p.id });
    expect((await a.call('DELETE', `/plans/${p.id}`)).status).toBe(409);
  });
});

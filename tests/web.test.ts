import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWebServer } from '../web/server';
import { ADMIN, reset, setup, teardown, type Ctx } from './helpers';

let c: Ctx;
let web: http.Server;
let base = '';
const publicDir = path.resolve(__dirname, '../web/public');

beforeAll(async () => {
  c = await setup();
  await c.app.listen({ port: 0, host: '127.0.0.1' });
  const apiUrl = `http://127.0.0.1:${(c.app.server.address() as AddressInfo).port}`;
  web = createWebServer({ apiUrl, adminToken: ADMIN, publicDir });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => web.close(r));
  await teardown(c);
});
beforeEach(() => reset(c.pool));

describe('console server', () => {
  it('serves the page and proxies the API, adding the admin token only for account creation', async () => {
    expect((await fetch(base + '/')).headers.get('content-type')).toContain('text/html');
    expect(await (await fetch(base + '/_config')).json()).toEqual({ adminTokenConfigured: true });
    expect((await fetch(base + '/api/health')).status).toBe(200);
    const created = await fetch(base + '/api/admin/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'p' }) });
    expect(created.status).toBe(201);
    const { apiKey } = await created.json();
    expect((await fetch(base + '/api/v1/account', { headers: { 'x-api-key': apiKey } })).status).toBe(200);
    expect((await fetch(base + '/api/v1/account')).status).toBe(401); // no key, no access: the proxy adds nothing
    expect((await fetch(base + '/nope')).status).toBe(404);
  });

  it('reports a clear 502 when the quota service is down', async () => {
    const s = createWebServer({ apiUrl: 'http://127.0.0.1:9', publicDir });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/health`);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('SERVICE_UNREACHABLE');
    await new Promise((r) => s.close(r));
  });
});

/** Loads the real page and its real script in jsdom, talking to the real servers over HTTP. */
async function openUi() {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: base + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      (w as any).fetch = (u: string, o?: RequestInit) => fetch(new URL(u, base), o);
      w.confirm = () => true;
    },
  });
  const w = dom.window;
  const d = w.document;
  const waitFor = async <T,>(fn: () => T | null | undefined | false, label: string, ms = 5000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}\n${d.querySelector('main')?.textContent?.slice(0, 600)}\nTOASTS: ${d.querySelector('#toasts')?.textContent}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const $ = (s: string) => d.querySelector(s) as any;
  const set = (s: string, v: string) => { const el = $(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const submit = (s: string) => $(s).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const click = (s: string) => $(s).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const go = async (route: string, marker: string) => { w.location.hash = `#/${route}`; await waitFor(() => $(marker), `${route} view`); };
  const optionByText = (sel: string, text: string) => Array.from($(sel).options as HTMLOptionElement[]).find((o) => o.textContent!.includes(text))!.value;
  return { dom, w, d, $, set, submit, click, go, waitFor, optionByText };
}

describe('web console UI (real page, real script, real services)', () => {
  it('walks through every feature of the service', async () => {
    const ui = await openUi();
    const { $, d, set, submit, click, go, waitFor, optionByText } = ui;

    // --- connect: create an account (admin token supplied by the console server) ---
    await waitFor(() => $('#create'), 'connect screen');
    expect($('#health').textContent).toContain('Service reachable');
    set('#c-name', 'UI Demo');
    submit('#create');
    const key = (await waitFor(() => $('#newkey'), 'new key')).textContent as string;
    expect(key).toMatch(/^qk_[0-9a-f]{64}$/);
    click('#go');
    await waitFor(() => d.querySelector('h1')?.textContent === 'UI Demo', 'account page');
    expect($('#who').textContent).toContain('Starter');
    expect(d.querySelector('main')!.textContent).toContain('1,000 units');

    // --- plans: create account + user plans; predefined are read-only ---
    await go('plans', '#new-plan');
    await waitFor(() => d.querySelectorAll('#plan-rows tr').length >= 4, 'predefined plans');
    expect(d.querySelector('#plan-rows')!.textContent).toContain('read-only');
    set('#p-name', 'ui-acc'); set('#p-kind', 'account'); set('#p-allow', '50');
    submit('#new-plan');
    await waitFor(() => d.querySelector('#plan-rows')!.textContent!.includes('ui-acc'), 'account plan row');
    set('#p-name', 'ui-usr'); set('#p-kind', 'user'); set('#p-allow', '30');
    submit('#new-plan');
    await waitFor(() => d.querySelector('#plan-rows')!.textContent!.includes('ui-usr'), 'user plan row');

    // --- account: switch to the custom account plan ---
    await go('account', '#acc-plan');
    set('#ap', optionByText('#ap', 'ui-acc'));
    submit('#acc-plan');
    await waitFor(() => d.querySelector('main')!.textContent!.includes('50 units'), 'account plan applied');

    // --- users ---
    await go('users', '#new-user');
    for (const id of ['alice', 'bob']) {
      set('#u-id', id); set('#u-plan', optionByText('#u-plan', 'ui-usr'));
      submit('#new-user');
      await waitFor(() => d.querySelector('#user-list')!.textContent!.includes(id), `user ${id}`);
    }
    set('#u-id', 'alice'); submit('#new-user'); // duplicate -> error toast
    await waitFor(() => d.querySelector('#toasts')!.textContent!.includes('USER_EXISTS'), 'duplicate user error');

    // --- consume: accepted, user-limit rejection, account-limit rejection, replay, conflict ---
    await go('consume', '#consume');
    const send = async (user: string, units: number, id: string) => {
      set('#c-user', user); set('#c-units', String(units)); set('#c-req', id);
      d.querySelector('#result')!.innerHTML = '';
      submit('#consume');
      return waitFor(() => d.querySelector('#result .receipt'), `result for ${id}`) as Promise<Element>;
    };
    let r = await send('alice', 10, 'r1');
    expect(r.className).toContain('accepted');
    expect(r.textContent).toContain('10 of 30');
    expect(r.textContent).toContain('10 of 50');
    r = await send('alice', 25, 'r2');
    expect(r.className).toContain('rejected');
    expect(r.textContent).toContain('USER_MONTHLY_ALLOWANCE_EXCEEDED');
    await send('bob', 30, 'r3');
    r = await send('alice', 15, 'r4');
    expect(r.textContent).toContain('ACCOUNT_MONTHLY_ALLOWANCE_EXCEEDED');
    click('#again'); // same request id again: original answer, flagged as a replay
    await waitFor(() => d.querySelector('#result .receipt')!.textContent!.includes('Replay'), 'replay');
    r = await send('alice', 16, 'r4'); // same id, different units
    expect(r.className).toContain('error');
    expect(r.textContent).toContain('IDEMPOTENCY_CONFLICT');
    expect(d.querySelectorAll('#session tbody tr').length).toBe(6); // r1-r4, the replay and the conflict

    // --- plan change from the UI changes the next decision ---
    await go('plans', '#new-plan');
    const accPlanId = optionByText('#p-kind', 'The account') && (await waitFor(() => d.querySelector('[data-edit]'), 'edit buttons'), '');
    void accPlanId;
    const editFor = Array.from(d.querySelectorAll('#plan-rows tr')).find((tr) => tr.textContent!.includes('ui-acc'))!.querySelector('[data-edit]') as HTMLElement;
    editFor.dispatchEvent(new ui.w.MouseEvent('click', { bubbles: true }));
    await waitFor(() => $('#edit-plan'), 'edit dialog');
    set('#e-allow', '200');
    submit('#edit-plan');
    await waitFor(() => d.querySelector('#plan-rows')!.textContent!.includes('200'), 'plan updated');
    await go('consume', '#consume');
    r = await send('alice', 15, 'r5');
    expect(r.className).toContain('accepted');
    expect(r.textContent).toContain('55 of 200');

    // --- deleting an assigned plan is refused ---
    await go('plans', '#new-plan');
    await waitFor(() => d.querySelector('[data-del]'), 'delete buttons');
    (Array.from(d.querySelectorAll('#plan-rows tr')).find((tr) => tr.textContent!.includes('ui-usr'))!.querySelector('[data-del]') as HTMLElement).dispatchEvent(new ui.w.MouseEvent('click', { bubbles: true }));
    await waitFor(() => d.querySelector('#toasts')!.textContent!.includes('PLAN_IN_USE'), 'plan in use error');

    // --- usage and history ---
    await go('usage', '#usage-body .panel');
    await waitFor(() => d.querySelector('#usage-body')!.textContent!.includes('55 of 200'), 'account usage meter');
    expect(d.querySelector('#usage-body')!.textContent).toContain('25 of 30'); // alice: 10 + 15
    await waitFor(() => d.querySelector('#history tbody tr'), 'history');
    expect(d.querySelector('#history')!.textContent).toContain('55');

    // --- request history: accepted and rejected, filters ---
    await go('requests', '#req-body');
    await waitFor(() => d.querySelectorAll('#req-body tbody tr').length === 5, 'five recorded decisions');
    expect(d.querySelector('#req-body')!.textContent).toContain('ACCOUNT_MONTHLY_ALLOWANCE_EXCEEDED');
    set('#f-status', 'rejected'); submit('#filters');
    await waitFor(() => d.querySelectorAll('#req-body tbody tr').length === 2, 'rejected filter');
    set('#f-user', 'bob'); set('#f-status', ''); submit('#filters');
    await waitFor(() => d.querySelectorAll('#req-body tbody tr').length === 1, 'user filter');

    // --- disconnect ---
    await go('account', '#disconnect');
    click('#disconnect');
    await waitFor(() => $('#create'), 'back to connect screen');
    ui.w.close();
  });

  it('connects with an existing key and rejects a bad one', async () => {
    const created = await (await fetch(base + '/api/admin/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Existing' }) })).json();
    const ui = await openUi();
    await ui.waitFor(() => ui.$('#connect'), 'connect form');
    ui.set('#k-key', 'qk_wrong'); ui.submit('#connect');
    await ui.waitFor(() => ui.d.querySelector('#toasts')!.textContent!.includes('not accepted'), 'bad key message');
    ui.set('#k-key', created.apiKey); ui.submit('#connect');
    await ui.waitFor(() => ui.d.querySelector('h1')?.textContent === 'Existing', 'connected');
    ui.w.close();
  });
});

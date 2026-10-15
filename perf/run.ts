/**
 * Load test against a running service + PostgreSQL, using autocannon.
 *
 *   BASE_URL=http://localhost:3000 ADMIN_TOKEN=... DATABASE_URL=postgres://... npm run perf
 *   (optional) DURATION=10 CONNECTIONS=50
 *
 * DATABASE_URL is optional: when set, the script verifies after each scenario that the stored
 * counters equal the sum of accepted requests and never exceed the allowance (no overspending).
 */
import fs from 'node:fs';
import os from 'node:os';
import autocannon from 'autocannon';
import { Pool, types } from 'pg';

types.setTypeParser(20, (v) => Number(v)); // bigint -> number (values are small)

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const DURATION = Number(process.env.DURATION ?? 10);
const SATURATION_LIMIT = Number(process.env.SATURATION_LIMIT ?? 1000);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);
const runId = Date.now().toString(36);

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

interface Acct { id: string; key: string; users: string[]; accountLimit: number }

async function makeAccount(label: string, nUsers: number, accountLimit: number, userLimit: number): Promise<Acct> {
  const acc = await http('POST', '/admin/accounts', { name: `perf-${label}-${runId}` }, { 'x-admin-token': ADMIN_TOKEN });
  const h = { 'x-api-key': acc.apiKey };
  const ap = await http('POST', '/v1/plans', { name: 'perf-account', kind: 'account', monthlyAllowance: accountLimit }, h);
  const up = await http('POST', '/v1/plans', { name: 'perf-user', kind: 'user', monthlyAllowance: userLimit }, h);
  await http('PUT', '/v1/account/plan', { planId: ap.id }, h);
  const users: string[] = [];
  for (let i = 0; i < nUsers; i++) {
    users.push(`user-${i}`);
    await http('POST', '/v1/users', { userId: `user-${i}`, planId: up.id }, h);
  }
  return { id: acc.id, key: acc.apiKey, users, accountLimit };
}

interface Scenario { name: string; description: string; accounts: Acct[] }

let counter = 0;
async function runLoad(accounts: Acct[]) {
  return autocannon({
    url: BASE_URL,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      {
        method: 'POST',
        path: '/v1/consume',
        setupRequest: (req) => {
          const a = accounts[counter % accounts.length];
          const user = a.users[Math.floor(Math.random() * a.users.length)];
          req.headers = { 'content-type': 'application/json', 'x-api-key': a.key };
          req.body = JSON.stringify({ userId: user, units: 1, requestId: `p-${runId}-${counter++}` });
          return req;
        },
      },
    ],
  });
}

async function verify(pool: Pool | null, accounts: Acct[]) {
  if (!pool) return null;
  let ok = true;
  let decisions = 0, accepted = 0, rejected = 0;
  for (const a of accounts) {
    const r = await pool.query(
      `SELECT (SELECT COALESCE(SUM(units),0)::bigint FROM consumption_requests WHERE account_id=$1 AND status='accepted') AS accepted_units,
              (SELECT count(*)::bigint FROM consumption_requests WHERE account_id=$1 AND status='accepted') AS n_acc,
              (SELECT count(*)::bigint FROM consumption_requests WHERE account_id=$1 AND status='rejected') AS n_rej,
              (SELECT COALESCE(SUM(used),0)::bigint FROM account_usage WHERE account_id=$1) AS acct_used,
              (SELECT COALESCE(SUM(used),0)::bigint FROM user_usage WHERE account_id=$1) AS users_used,
              (SELECT count(*)::bigint FROM user_usage uu JOIN users u USING (account_id, user_id) JOIN plans p ON p.id = u.plan_id WHERE uu.account_id=$1 AND uu.used > p.monthly_allowance) AS users_over`,
      [a.id],
    );
    const x = r.rows[0];
    decisions += x.n_acc + x.n_rej; accepted += x.n_acc; rejected += x.n_rej;
    if (!(x.accepted_units === x.acct_used && x.acct_used === x.users_used && x.acct_used <= a.accountLimit && x.users_over === 0)) ok = false;
  }
  return { ok, decisions, accepted, rejected };
}

async function main() {
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }) : null;
  const big = 1_000_000_000_000;
  const scenarios: Scenario[] = [
    { name: 'many-users', description: '1 account, 200 users, allowances never reached (all accepted)', accounts: [await makeAccount('many', 200, big, big)] },
    { name: 'hot-user', description: '1 account, 1 user (worst-case row contention)', accounts: [await makeAccount('hot', 1, big, big)] },
    { name: 'multi-account', description: '20 accounts x 10 users, allowances never reached', accounts: await Promise.all(Array.from({ length: 20 }, (_, i) => makeAccount(`m${i}`, 10, big, big))) },
    { name: 'saturation', description: `1 account, 50 users, shared allowance ${SATURATION_LIMIT} units (most requests rejected)`, accounts: [await makeAccount('sat', 50, SATURATION_LIMIT, big)] },
  ];

  const env = {
    date: new Date().toISOString(),
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpus: `${os.cpus().length} x ${os.cpus()[0]?.model}`,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    connections: CONNECTIONS,
    durationSeconds: DURATION,
    baseUrl: BASE_URL,
  };
  console.log('Environment:', JSON.stringify(env));

  const results = [];
  for (const s of scenarios) {
    process.stdout.write(`Running ${s.name} (${DURATION}s, ${CONNECTIONS} connections)... `);
    const r = await runLoad(s.accounts);
    const v = await verify(pool, s.accounts);
    const row = {
      scenario: s.name,
      description: s.description,
      requestsPerSec: Math.round(r.requests.average),
      totalRequests: r.requests.total,
      latencyMs: { avg: r.latency.average, p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99, max: r.latency.max },
      http2xx: r['2xx'],
      non2xx: r.non2xx,
      errors: r.errors,
      timeouts: r.timeouts,
      verification: v,
    };
    results.push(row);
    console.log(`${row.requestsPerSec} req/s, p99 ${row.latencyMs.p99} ms, non2xx ${row.non2xx}, errors ${row.errors}${v ? `, invariants ${v.ok ? 'OK' : 'VIOLATED'} (${v.accepted} accepted / ${v.rejected} rejected)` : ''}`);
  }

  fs.mkdirSync('perf/results', { recursive: true });
  fs.writeFileSync('perf/results/latest.json', JSON.stringify({ env, results }, null, 2));
  console.log('\n| Scenario | req/s | avg ms | p50 | p90 | p99 | max | 2xx | non-2xx | errors | invariants |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(`| ${r.scenario} | ${r.requestsPerSec} | ${r.latencyMs.avg} | ${r.latencyMs.p50} | ${r.latencyMs.p90} | ${r.latencyMs.p99} | ${r.latencyMs.max} | ${r.http2xx} | ${r.non2xx} | ${r.errors} | ${r.verification ? (r.verification.ok ? 'OK' : 'VIOLATED') : 'n/a'} |`);
  }
  await pool?.end();
  if (results.some((r) => r.verification && !r.verification.ok)) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Example client for the quota service. It plays the role of a document-processing app backend.
 * The consume logic (`processDocument`) never changes; only the plan configuration does.
 *
 *   BASE_URL (default http://localhost:3000)   ADMIN_TOKEN (needed once, to bootstrap an account)
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

let apiKey = '';
let seq = 0;
const runId = Date.now().toString(36);

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const api = (method: string, path: string, body?: unknown) => http(method, `/v1${path}`, body, { 'x-api-key': apiKey });

/** The only code path the application uses to meter work. */
async function processDocument(userId: string, units: number) {
  const requestId = `doc-${runId}-${++seq}`;
  const r = await api('POST', '/consume', { userId, units, requestId });
  if (r.status !== 200) throw new Error(`unexpected ${r.status}: ${JSON.stringify(r.body)}`);
  const o = r.body;
  console.log(
    o.accepted
      ? `  ACCEPTED  ${userId} +${units}  (account ${o.account.used}/${o.account.limit}, ${userId} ${o.user.used}/${o.user.limit})`
      : `  REJECTED  ${userId} +${units}  [${o.reason.code}] ${o.reason.message}`,
  );
  return { requestId, ...o };
}

function expect(label: string, cond: boolean) {
  if (!cond) {
    console.error(`  ✗ expectation failed: ${label}`);
    process.exit(1);
  }
  console.log(`  ✓ ${label}`);
}

async function showUsage(title: string) {
  const u = (await api('GET', '/usage')).body;
  console.log(`  ${title}: account ${u.account.used}/${u.account.limit} (remaining ${u.account.remaining})`);
  for (const x of u.users) console.log(`    ${x.userId}: ${x.used}/${x.limit} (remaining ${x.remaining})`);
}

async function main() {
  console.log(`Quota service demo -> ${BASE_URL}`);

  console.log('\n0. Bootstrap: create an account and an API key (admin token), then configure plans');
  const acc = await http('POST', '/admin/accounts', { name: `demo-${runId}` }, { 'x-admin-token': ADMIN_TOKEN });
  if (acc.status !== 201) throw new Error(`bootstrap failed (${acc.status}): ${JSON.stringify(acc.body)}`);
  apiKey = acc.body.apiKey;
  const accountPlan = (await api('POST', '/plans', { name: 'demo-account', kind: 'account', monthlyAllowance: 50 })).body;
  const userPlan = (await api('POST', '/plans', { name: 'demo-user', kind: 'user', monthlyAllowance: 30 })).body;
  await api('PUT', '/account/plan', { planId: accountPlan.id });
  await api('POST', '/users', { userId: 'alice', planId: userPlan.id });
  await api('POST', '/users', { userId: 'bob', planId: userPlan.id });
  console.log('  account allowance 50 shared; each user allowance 30');

  console.log('\n1. Accepted request');
  expect('alice +10 accepted', (await processDocument('alice', 10)).accepted === true);

  console.log('\n2. Rejection caused by a USER limit (alice would reach 35 of 30)');
  const userRej = await processDocument('alice', 25);
  expect('rejected by the user limit', !userRej.accepted && userRej.reason.code === 'USER_MONTHLY_ALLOWANCE_EXCEEDED');

  console.log('\n3. Rejection caused by the shared ACCOUNT limit (bob uses 30, then alice asks for 15 more)');
  await processDocument('bob', 30);
  const accRej = await processDocument('alice', 15);
  expect('rejected by the account limit although alice has allowance left', !accRej.accepted && accRej.reason.code === 'ACCOUNT_MONTHLY_ALLOWANCE_EXCEEDED');
  await showUsage('usage now');

  console.log('\n4. Idempotent retry: repeating a request id returns the original outcome and consumes nothing');
  const replay = (await api('POST', '/consume', { userId: 'alice', units: 15, requestId: accRej.requestId })).body;
  expect('replay is flagged and still rejected', replay.replayed === true && replay.accepted === false);

  console.log('\n5. Plan change (account allowance 50 -> 200); same client code, new decision');
  await api('PATCH', `/plans/${accountPlan.id}`, { monthlyAllowance: 200 });
  expect('alice +15 now accepted', (await processDocument('alice', 15)).accepted === true);

  console.log('\n6. Current usage, remaining allowances and request outcomes');
  await showUsage('final usage');
  const hist = (await api('GET', '/requests')).body.requests;
  for (const r of hist.reverse()) console.log(`    ${r.status.padEnd(8)} ${r.userId.padEnd(6)} ${String(r.units).padStart(3)} units  ${r.requestId}${r.reason ? `  (${r.reason.code})` : ''}`);

  console.log('\nDemo complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

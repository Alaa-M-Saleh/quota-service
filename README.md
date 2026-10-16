# Usage Metering and Quota Service

A backend that other applications call to meter usage and decide whether a user may perform an action.
An **account** (the calling app) has a plan with a shared monthly allowance; each **user** has a plan with an
individual allowance. A request for N units is accepted only if *both* allow it; a rejection consumes nothing.

Stack: TypeScript, Fastify, PostgreSQL (plain SQL via `pg`, zod for validation). One service, one database.

## Quick start

```bash
docker compose up --build        # PostgreSQL + service + example client
```

Then open the **web console at <http://localhost:8080>** (see below). The `client` container also runs a scripted
command-line demo (accepted request, user-limit rejection, shared-account rejection, plan change, usage/outcomes) and exits;
the core API stays up on <http://localhost:3000>. Configuration: `ADMIN_TOKEN`
(default `dev-admin-token`, override with `ADMIN_TOKEN=... docker compose up --build`).

Without Docker (needs Node 22 and PostgreSQL):

```bash
npm ci
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/quota ADMIN_TOKEN=dev-admin-token
npm run build && npm start        # applies migrations + seeds predefined plans on startup
npm run demo                      # scripted CLI demo (BASE_URL defaults to http://localhost:3000)
npm run web                       # web console on http://localhost:8080 (API_URL defaults to http://localhost:3000)
```

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `ADMIN_TOKEN` | required (min 8 chars) | Operator token for account creation |
| `PORT` / `HOST` | 3000 / 0.0.0.0 | Listen address |
| `DB_POOL_MAX` | 20 | Connection pool size |
| `LOG_LEVEL` | info | Fastify/pino log level |

Web console server only: `API_URL` (core service, default `http://localhost:3000`), `PORT` (default 8080), and optional
`ADMIN_TOKEN` (see below).

## Web console

`web/` is a small server plus a single self-contained page (no external assets) that covers every feature of the core service:

| Section | What you can do |
|---|---|
| Account | Create an account (shows the API key once) or connect with an existing key; view and change the account plan |
| Plans | List predefined and custom plans; create, edit and delete custom plans (predefined are read-only; assigned plans cannot be deleted) |
| Users | Register users with a plan; change a user's plan; jump to their usage |
| Consume units | Send a consume request; see the decision as a receipt (balances after acceptance, or the rejection code, scope, rule and numbers); resend the same request ID to see an idempotent replay; reuse an ID with different units to see the 409 conflict |
| Usage | Current or past UTC month: shared account meter and one meter per user; month-by-month totals for the account or a single user |
| Request history | Every accepted and rejected decision, filter by user, outcome and month, load older pages |

How it works: the server serves the page and proxies `/api/*` to the core service, so the browser stays on one origin (no CORS).
The API key is kept in this browser's `localStorage`; "Disconnect" removes it. Account creation needs the operator's admin token: either type it in the
form, or set `ADMIN_TOKEN` on the console server (Docker Compose does this by default), in which case the console adds it for
`/admin/accounts` only. **Anyone who can open the console can then create accounts**, so treat the console as an operator/demo tool and do not expose it publicly with an admin token configured.

## Behavior and assumptions

Where the brief was silent I chose the following (all implemented and tested):

- **Bootstrap:** `POST /admin/accounts` with header `X-Admin-Token` (the operator-configured `ADMIN_TOKEN`) creates an
  account and returns its API key **once**. Only a SHA-256 hash is stored. One API key per account. Everything under `/v1`
  requires `X-Api-Key`; the key selects the account. The admin token grants nothing under `/v1`, and API keys grant nothing under `/admin`.
- **Plan rules:** a plan has `monthlyAllowance` (units per UTC month) and an optional `maxUnitsPerRequest`. Both the
  account plan and the user plan apply together; a bigger user allowance never raises the account's.
- **Predefined plans** (read-only, visible to all): account `starter` (1,000/month, ≤100 per request), `pro` (100,000/month, ≤1,000);
  user `basic` (100/month, ≤20), `premium` (5,000/month, ≤500). New accounts default to `starter`, new users to `basic`.
- **Custom plans** belong to one account, are visible only to it, and can be assigned to the account (kind `account`) or its users
  (kind `user`). Several users may share a plan; counters are per user. Plan kind is enforced by composite foreign keys.
- **Plan changes** take effect for the next decision and never reset usage. Lowering an allowance below current usage gives
  `remaining = 0` and all further consumption is rejected. Plans that are assigned cannot be deleted (409 `PLAN_IN_USE`).
- **Users:** identified by an id chosen by the calling app (unique per account). Operations: create, list, get, change plan.
- **Time:** usage is counted per UTC calendar month (`YYYY-MM`) based on the server clock at decision time. Allowances start fresh each month.
  Counter rows are kept forever, so past months stay queryable. Limits/`remaining` are reported only for the current month
  (past months report `used` only, because plans may have changed since).
- **Decision outcome:** `POST /v1/consume` returns HTTP **200 for both accepted and rejected** with `accepted: true|false`.
  4xx is reserved for errors (bad input, auth, unknown user, idempotency conflict) and records nothing.
- **Rule order when several rules fail:** per-request cap (account, then user), then monthly allowance (account, then user);
  the first violated rule is the reported reason.
- **Rejection reasons** (`reason.code`, with `scope`, `accountId`, `userId` for user scope, `rule`, `requested`, `limit`, `used`, `remaining`, `message`):
  `ACCOUNT_MONTHLY_ALLOWANCE_EXCEEDED`, `USER_MONTHLY_ALLOWANCE_EXCEEDED`, `ACCOUNT_MAX_UNITS_PER_REQUEST_EXCEEDED`, `USER_MAX_UNITS_PER_REQUEST_EXCEEDED`.
- **Idempotency:** `requestId` is unique per account. Repeating it with the same `userId` and `units` returns the original outcome
  (accepted *or* rejected, `replayed: true`) without consuming again, even if plans changed meanwhile. Reusing it with different
  parameters returns 409 `IDEMPOTENCY_CONFLICT`. Both outcomes are recorded.
- **History:** every accepted and rejected decision is stored (units, user, timestamp, period, balances or rejection reason).
- **Not built (by design):** API key rotation, user deletion, rate limiting, optional extras.

## API

All bodies/responses are JSON. Errors: `{"error": {"code", "message", "details?"}}`.

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness + DB check |
| `POST /admin/accounts` `{name, planId?}` | (admin token) create account, returns `apiKey` |
| `GET /v1/account`, `PUT /v1/account/plan` `{planId}` | View / change the account's plan |
| `GET /v1/plans?kind=`, `GET /v1/plans/:id` | Predefined + own plans |
| `POST /v1/plans` `{name, kind, monthlyAllowance, maxUnitsPerRequest?}` | Create custom plan |
| `PATCH /v1/plans/:id`, `DELETE /v1/plans/:id` | Update / delete own plan (predefined: 403) |
| `POST /v1/users` `{userId, planId?}`, `GET /v1/users`, `GET /v1/users/:userId`, `PUT /v1/users/:userId/plan` | Manage users |
| `POST /v1/consume` `{userId, units, requestId}` | Decide and record consumption (`units`: positive integer) |
| `GET /v1/usage?period=YYYY-MM` | Account usage + per-user usage for a month |
| `GET /v1/users/:userId/usage?period=` | One user's usage and the shared account balance |
| `GET /v1/usage/history?userId=` | Monthly totals (account, or one user) |
| `GET /v1/requests?userId=&status=&period=&limit=&before=` | Decision history, newest first, cursor via `before` |

```bash
curl -s -X POST localhost:3000/admin/accounts -H 'x-admin-token: dev-admin-token' -H 'content-type: application/json' -d '{"name":"acme"}'
curl -s -X POST localhost:3000/v1/users   -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"userId":"alice"}'
curl -s -X POST localhost:3000/v1/consume -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"userId":"alice","units":10,"requestId":"doc-1"}'
```

## Correctness and concurrency design

Each consume call is one PostgreSQL transaction (READ COMMITTED), see `src/services/consume.ts`:

1. Transaction-scoped advisory lock on `(account, requestId)` serialises duplicates, so replays see the original row and never consume twice.
2. The user, account and both plan rows are read `FOR SHARE`. Plan updates/reassignments need an exclusive lock, so they wait for in-flight
   decisions and every later decision sees the new plan.
3. Counter rows are locked `FOR UPDATE` in a fixed order (account, then user). Decisions for one account are therefore serialised and
   the check-and-increment cannot overspend either allowance; fixed ordering avoids deadlocks.
4. Counters, the decision row and the idempotency key commit atomically. Constraints: `used >= 0`, unique `(account_id, request_id)`,
   composite FKs for plan kind and user ownership.

Trade-off: all consumption for one account serialises on its account counter row (the price of an exact shared limit); different accounts run in parallel.

## Tests

```bash
# needs PostgreSQL; creates/uses the database in TEST_DATABASE_URL
# (default postgres://postgres:postgres@localhost:5432/quota_test)
npm test
```

36 tests against a real PostgreSQL (wiped between tests, `fileParallelism` off) covering: admin/API-key auth, account isolation
(users, plans, usage, history, request ids), predefined/read-only plans, custom plans and deletion rules, accept/reject decisions and reasons,
per-request caps, exact fit, idempotent replay of accepted and rejected outcomes, 409 conflicts, history filters and paging, UTC month rollover
and historical queries, immediate plan changes, allowance reduction below usage, shared plans with separate usage, concurrency
(400 parallel requests against a 100-unit account allowance ⇒ exactly 100 accepted; per-user limit; 50 parallel duplicates of one request id ⇒
consumed once; plan lowered mid-flight), and persistence across a restart (new pool and app instance). The web console is tested by loading the real page and its real
script in jsdom and driving it against the real console server and core service: it creates an account, plans and users, runs accepted, user-limit,
account-limit, replayed and conflicting requests, changes a plan, checks usage and history, and tests filters, disconnect and bad/good API keys.
All 36 passed in the environment below. The page has not been viewed in a real browser by the author, so visual layout is unchecked.

## Performance

Reproduce (service and PostgreSQL running, `DATABASE_URL` enables the invariant check):

```bash
LOG_LEVEL=warn npm start &
BASE_URL=http://localhost:3000 DATABASE_URL=$DATABASE_URL DURATION=10 CONNECTIONS=50 npm run perf
# Docker: docker compose run --rm -e DATABASE_URL=postgres://quota:quota@db:5432/quota client node dist/perf/run.js
```

`perf/run.ts` creates fresh accounts, drives `POST /v1/consume` (1 unit, unique request ids) with autocannon, then queries PostgreSQL to
verify per account: stored counters = sum of accepted units = sum of per-user counters, never above the allowance. Raw output: `perf/results/*.json`.

**Environment (measured run, 2026-10-15):** Linux 6.18 x64 sandbox VM, **1 vCPU** (Intel Xeon 2.8 GHz), 4 GB RAM, Node v22.22.2, PostgreSQL 16.15
(default configuration), pool size 20. The load generator, the service and PostgreSQL **all shared that single core**, over loopback,
and the service ran from the compiled build with `LOG_LEVEL=warn`. Absolute numbers are therefore low and not representative of dedicated hardware;
they are real measurements of this setup, taken once (10 s per scenario, no warm-up, no repeats).

50 connections:

| Scenario | req/s | avg ms | p50 | p90 | p99 | max | non-2xx | errors | invariants |
|---|---|---|---|---|---|---|---|---|---|
| many-users (1 account, 200 users) | 204 | 243.8 | 220 | 363 | 577 | 875 | 0 | 0 | OK |
| hot-user (1 account, 1 user) | 217 | 227.0 | 199 | 347 | 562 | 842 | 0 | 0 | OK |
| multi-account (20 accounts × 10 users) | 278 | 178.1 | 176 | 207 | 233 | 269 | 0 | 0 | OK |
| saturation (allowance 1000, 50 users) | 244 | 201.9 | 183 | 281 | 426 | 762 | 0 | 0 | OK |

10 connections:

| Scenario | req/s | avg ms | p50 | p90 | p99 | max | non-2xx | errors | invariants |
|---|---|---|---|---|---|---|---|---|---|
| many-users | 178 | 55.3 | 51 | 93 | 169 | 283 | 0 | 0 | OK |
| hot-user | 211 | 46.7 | 44 | 81 | 135 | 265 | 0 | 0 | OK |
| multi-account | 268 | 36.7 | 36 | 45 | 59 | 88 | 0 | 0 | OK |
| saturation | 216 | 45.8 | 44 | 65 | 109 | 182 | 0 | 0 | OK |

Reading the results: in the 50-connection saturation run exactly 1,000 units were accepted against the 1,000-unit allowance (1,452 further requests rejected)
with zero HTTP errors. Latency at 50 connections is mostly queueing (50 in flight ÷ ~200 req/s ≈ 250 ms) on a CPU-starved box, not per-request work; at 10 connections
the median is ~45 ms. Throughput barely differs between one hot user and many users because the CPU, not row locking, was the bottleneck here;
the multi-account case is somewhat faster since account-level locking does not serialise across accounts. Each decision costs ~8 database round trips
plus one API-key lookup; likely improvements (not done): cache key lookups, fewer round trips via a stored function, a bigger machine.
Recorded decisions can exceed the 2xx count slightly because requests still in flight when autocannon stops are still processed.

## Verification status and known limitations

- **Docker Compose was not executed** in the environment where this was built (no Docker available). `docker-compose.yml` parses, and the equivalent path was run manually:
  compiled build → fresh PostgreSQL (migrations + seed on startup) → compiled demo client, which completed all steps successfully. Please run
  `docker compose up --build` once on your machine to confirm.
- Account creation is gated by one shared `ADMIN_TOKEN`; there is no key rotation or revocation endpoint.
- Time comes from the service clock; multi-instance deployments rely on synchronised clocks at month boundaries.
- Consumption for one account serialises on one row (see design trade-off); extremely hot single accounts are bounded by that.
- `/v1/usage` lists at most 1,000 users; `/v1/users` and `/v1/requests` are cursor-paginated.
- Predefined plan limits are fixed by migration (changing them requires a new migration).
- Totals are stored as bigint but handled as JS numbers; limits are capped at 10^12 and units per request at 10^9.
- No rate limiting or request-size limits beyond a 64 KB body cap.

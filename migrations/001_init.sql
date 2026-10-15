-- Usage Metering and Quota Service: initial schema.
-- All usage is measured in "units" (one resource). Periods are UTC calendar months,
-- stored as the first day of the month (DATE).

CREATE TABLE accounts (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  api_key_hash  text NOT NULL UNIQUE,            -- sha256 hex of the API key (one key per account)
  plan_id       text NOT NULL,
  plan_kind     text NOT NULL DEFAULT 'account' CHECK (plan_kind = 'account'),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- account_id NULL  => predefined (read-only, visible to everyone)
-- account_id set   => custom plan owned by that account
CREATE TABLE plans (
  id                    text PRIMARY KEY,
  account_id            uuid REFERENCES accounts(id) ON DELETE CASCADE,
  kind                  text NOT NULL CHECK (kind IN ('account', 'user')),
  name                  text NOT NULL,
  monthly_allowance     bigint NOT NULL CHECK (monthly_allowance >= 0),
  max_units_per_request bigint CHECK (max_units_per_request IS NULL OR max_units_per_request > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, kind)
);
CREATE UNIQUE INDEX plans_owner_name_uq ON plans (COALESCE(account_id::text, ''), name);
CREATE INDEX plans_account_idx ON plans (account_id);

-- Composite FKs guarantee an account only points at an 'account' plan and a user at a 'user' plan.
-- NO ACTION (not RESTRICT) so deleting an account together with its plans in one statement works,
-- while deleting a plan that is still assigned is rejected.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_plan_fk FOREIGN KEY (plan_id, plan_kind) REFERENCES plans (id, kind);

CREATE TABLE users (
  account_id  uuid NOT NULL REFERENCES accounts(id),
  user_id     text NOT NULL,                     -- identifier supplied by the calling application
  plan_id     text NOT NULL,
  plan_kind   text NOT NULL DEFAULT 'user' CHECK (plan_kind = 'user'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (plan_id, plan_kind) REFERENCES plans (id, kind)
);
CREATE INDEX users_plan_idx ON users (plan_id);

-- Monthly counters. Rows are never deleted, so historical usage stays queryable.
CREATE TABLE account_usage (
  account_id  uuid NOT NULL REFERENCES accounts(id),
  period      date NOT NULL,
  used        bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (account_id, period)
);

CREATE TABLE user_usage (
  account_id  uuid NOT NULL,
  user_id     text NOT NULL,
  period      date NOT NULL,
  used        bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (account_id, user_id, period),
  FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, user_id)
);

-- Every consumption decision (accepted and rejected) is recorded here.
-- (account_id, request_id) is the idempotency key.
CREATE TABLE consumption_requests (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL,
  user_id     text NOT NULL,
  request_id  text NOT NULL,
  units       bigint NOT NULL CHECK (units > 0),
  status      text NOT NULL CHECK (status IN ('accepted', 'rejected')),
  period      date NOT NULL,
  created_at  timestamptz NOT NULL,
  outcome     jsonb NOT NULL,                    -- balances after acceptance, or the rejection reason
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, user_id)
);
CREATE INDEX consumption_requests_account_idx ON consumption_requests (account_id, id DESC);
CREATE INDEX consumption_requests_user_idx ON consumption_requests (account_id, user_id, id DESC);

-- Predefined plans (read-only through the API).
INSERT INTO plans (id, account_id, kind, name, monthly_allowance, max_units_per_request) VALUES
  ('starter', NULL, 'account', 'Starter',    1000,   100),
  ('pro',     NULL, 'account', 'Pro',      100000,  1000),
  ('basic',   NULL, 'user',    'Basic',       100,    20),
  ('premium', NULL, 'user',    'Premium',    5000,   500);

-- EN: Registry-owned schema only. / 中文：仅管理框架自身的数据表。
CREATE TABLE IF NOT EXISTS agent_tasks (task_id text PRIMARY KEY, capability text NOT NULL, input jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', dependencies jsonb NOT NULL DEFAULT '[]', result jsonb, attempts int NOT NULL DEFAULT 0, lease_until timestamptz, agent_id text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agent_attempts (attempt_id bigserial PRIMARY KEY, task_id text NOT NULL, agent_id text NOT NULL, call_id text NOT NULL UNIQUE, status text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, result jsonb, error text);
CREATE TABLE IF NOT EXISTS agent_events (event_id bigserial PRIMARY KEY, task_id text, event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS shared_facts (fact_id bigserial PRIMARY KEY, task_id text NOT NULL, agent_id text NOT NULL, version int NOT NULL, value jsonb NOT NULL, verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id, version));
CREATE TABLE IF NOT EXISTS agent_workers (agent_id text PRIMARY KEY, capability text NOT NULL, lease_until timestamptz NOT NULL, quota int NOT NULL DEFAULT 1, in_flight int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS call_id text;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE agent_attempts ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE agent_attempts ADD COLUMN IF NOT EXISTS deadline timestamptz;
ALTER TABLE agent_workers ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS agent_requests (request_id text PRIMARY KEY, plan jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agent_quota (name text PRIMARY KEY, capacity int NOT NULL CHECK(capacity>0));

CREATE INDEX IF NOT EXISTS agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS agent_attempts_status ON agent_attempts(status);

CREATE TABLE IF NOT EXISTS agent_capabilities(name text PRIMARY KEY, description text NOT NULL);
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS max_attempts int NOT NULL DEFAULT 2;

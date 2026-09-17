# Agent Registry Framework

**A durable, domain-neutral registry and execution fabric for multi-agent systems.**

[简体中文](README.zh-CN.md) · [Architecture](docs/architecture.en.md) · [设计文档](docs/architecture.zh-CN.md)

[API, configuration and deployment](docs/api.en.md)

This repository extracts the reusable part of a multi-agent commerce system: workers register themselves, a scheduler discovers their capabilities, and a durable PostgreSQL task graph coordinates leased execution. There is no commerce model, prompt, UI, or vendor-specific agent SDK in the core.

## What it provides

- A declarative capability catalog and strict task-graph validation.
- Durable registration, leases, heartbeats, bounded retries, cancellation, quotas, and stale-worker reaping.
- Dependency-aware dispatch with versioned shared facts and late-result fencing.
- A small HTTP boundary with separate operator and capability-scoped worker credentials.
- A `Worker` class that handles registration, polling, heartbeats, deadlines, and result delivery.

The scheduler owns orchestration state. A domain adapter owns authentication, real data, external side effects, and idempotency. Model output is never an authorization decision.

## Quick start

Requires Node.js 22+ and PostgreSQL 14+.

```bash
npm install
export DATABASE_URL=postgresql://registry:password@localhost/registry
export REGISTRY_OPERATOR_TOKEN=$(openssl rand -hex 32)
export NORMALIZE_WORKER_TOKEN=$(openssl rand -hex 32)
export SUMMARIZE_WORKER_TOKEN=$(openssl rand -hex 32)
cp registry.example.json registry.json
REGISTRY_CONFIG=registry.json npm start
```

Run the domain-neutral example from another shell:

```bash
REGISTRY_OPERATOR_TOKEN=... NORMALIZE_WORKER_TOKEN=... SUMMARIZE_WORKER_TOKEN=... npm run demo
```

The example registers two workers and runs a two-node task graph. See `docs/architecture.en.md` for production deployment, security, recovery, and extension rules.

## Library API

```js
import {
  Scheduler,
  Worker,
  createRegistryServer,
} from "agent-registry-framework";
```

`Scheduler` persists registration and task state. `Worker` receives a task and calls your `handler(task, {signal})`; the handler must honor cancellation and make external writes idempotent. `createRegistryServer` exposes the operator and worker endpoints. The schema is created by `scheduler.init()` and is owned by this framework.

## Verification

```bash
npm test
TEST_DATABASE_URL=postgresql://... npm run test:integration
```

The integration suite uses a disposable PostgreSQL schema and exercises concurrent claims, fencing, retry, cancellation, restart recovery, quota isolation, and end-to-end HTTP workers.

## License

Apache-2.0. See [LICENSE](LICENSE).

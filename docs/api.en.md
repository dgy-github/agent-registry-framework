# API and usage

## Configuration

Copy `registry.example.json` to your deployment configuration and set `REGISTRY_CONFIG` to its path. Each capability has a unique `name`, a `description` and a `tokenEnv` naming its secret environment variable. Tokens must be distinct and at least 24 characters; generate random values rather than using example words. `DATABASE_URL` supplies the PostgreSQL connection string. `REGISTRY_OPERATOR_TOKEN` is the operator credential. No `.env` file is loaded implicitly.

`schema` defaults to `agent_registry`; `lease` (90) and `deadline` (180) are seconds, `capacity` (2) is the global running-attempt limit, and `maxAttempts` (2) includes the initial attempt. One worker executes at most one attempt. Configure all scheduler processes identically. Catalog initialization adds/updates names without removing historical capabilities. Removing a configuration entry does not revoke an existing capability: revoke its token and explicitly manage stored entries after draining work.

For PowerShell, set variables using `$env:DATABASE_URL='postgresql://...'` and `$env:REGISTRY_CONFIG='registry.json'`; set the three token variables in the same way, then run `npm start`. Both shells running the server and demo need matching tokens. Use `node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"` to generate a token without OpenSSL.

## HTTP

All bodies are JSON (maximum 1 MB). Operator routes require `Authorization: Bearer <operator token>`. Worker routes require the token for `capability` and include `agent_id` and `capability` in every body. A capability token defines a trusted worker cohort: it does not isolate mutually hostile workers within that cohort. Use a unique agent ID per process and never run concurrent processes with the same ID.

- `GET /health`: unauthenticated process liveness; it does not prove database readiness.
- `GET /api/state`: catalogs, agents, tasks, attempts, facts, events, and quota. Tasks/facts/attempts are limited to the latest 200 and events to 150; this is not a historical export API.
- `POST /api/tasks`: `{ "request_id": "unique-request-id", "plan": { "tasks": [...] } }`; returns `{ "ids": [...] }`. Each task has a request-local `id`, `capability`, JSON object `input` and optional `dependencies` listing other task keys. Returned IDs are database IDs; events retain the local key.
- `POST /api/cancel`: `{ "task_id": "database-task-id" }`. Cancellation prevents accepting success; it cannot undo external effects.
- `POST /api/workers/enable`: `{ "agent_id": "worker-id", "enabled": false }`. Pauses future claims; does not cancel an active attempt.
- `POST /internal/register`: registers or renews an instance; changing its capability is rejected.
- `POST /internal/claim`: renews the instance lease and returns `{ "task": null }` or a task including `call_id`, `attempt_id`, `attempt`, `deadline` and dependency `facts`.
- `POST /internal/heartbeat`: optionally includes `call_id`; returns `valid` for the attempt and `enabled` for the instance. Instance-only heartbeats have `valid: false`.
- `POST /internal/result`: includes `call_id` and either a JSON `result` or `error`. Returns `accepted`; completed/expired attempts reject duplicate receipts.

Errors use stable categories: 400 `request_rejected`, 401 `unauthorized`, 404 `not_found`, or 503 `storage_unavailable`. Some malformed requests receive a more specific 400 category. Error responses do not expose internal exception details.

## Worker handlers

```js
const worker = new Worker({
  url: "http://127.0.0.1:8766",
  token: process.env.RESEARCH_TOKEN,
  capability: "research",
  handler: async (task, { signal }) => {
    const response = await fetch(task.input.url, { signal });
    return { text: await response.text() };
  },
});
await worker.run({ signal: shutdownController.signal });
```

The deployment must validate allowed URLs and business access in a real handler. The task includes only explicit dependency facts, not every agent's private context. Facts carry source agent, task, version, and `verified: false`; a successful task is not human verification. Handler output must be JSON; do not return `undefined`, cyclic values or BigInt. Keep heartbeat and request timeout well below the lease. The sample defaults are 10 s heartbeats, 5 s request timeout and 1 s polling; reduce them if reducing the scheduler lease.

## Deployment and limitations

Bind to loopback by default. Put TLS and access restrictions in front of non-local connections. The operator has schema-wide authority: there is no tenant or per-user authorization layer. State changes serialize per schema, favoring consistency over high-throughput horizontal scaling. Execution is **at least once**, not exactly once: network loss or lease expiry can overlap an old handler with a retry. Enforce idempotency/fencing in the external system using the stable task ID; use attempt/call IDs for tracing. Cooperative cancellation requires the handler to honor `signal`.

The framework does not launch model agents, provision workers, load model skills, or supply an LLM planner. Any planner or model SDK can create a valid task graph or run inside a handler. `examples/workflow.mjs` is deterministic and needs no model key.

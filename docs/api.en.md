# API and usage

## Configuration

Copy `registry.example.json` and point `REGISTRY_CONFIG` at it. The process reads only that file; it does not search parent directories or load `.env` itself.

| Field                    | Default          | Meaning                                                      |
| ------------------------ | ---------------- | ------------------------------------------------------------ |
| `schema`                 | `agent_registry` | PostgreSQL schema owned by this framework                    |
| `host`                   | `127.0.0.1`      | Bind address                                                 |
| `port`                   | `8766`           | Bind port                                                    |
| `lease`                  | `90`             | Worker and attempt lease, seconds                            |
| `deadline`               | `180`            | Attempt deadline, seconds; must be ≥ `lease`                 |
| `capacity`               | `2`              | Global running-attempt limit                                 |
| `maxAttempts`            | `2`              | Includes the first attempt                                   |
| `maxConsecutiveFailures` | `null`           | Optional; auto-disables a worker after N failures/rejections |
| `capabilities[]`         | required         | `name`, `description`, `tokenEnv`                            |

Each capability `name` is unique. `tokenEnv` is the environment variable that holds that worker token. Tokens must be distinct, random, and at least 24 characters. Do not use example words.

Environment variables:

| Name                      | Required by                 | Purpose                                              |
| ------------------------- | --------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`            | `npm start`                 | PostgreSQL connection string                         |
| `REGISTRY_CONFIG`         | `npm start`                 | Path to JSON config; default `registry.example.json` |
| `REGISTRY_OPERATOR_TOKEN` | server and demo             | Operator credential                                  |
| values of each `tokenEnv` | server and matching workers | Capability-scoped worker credentials                 |
| `REGISTRY_URL`            | `npm run demo`              | Base URL, default `http://127.0.0.1:8766`            |
| `TEST_DATABASE_URL`       | `npm run test:integration`  | Disposable integration database                      |

Catalog initialization adds or updates names. Deleting a config entry does not revoke a stored capability. Drain work, rotate or revoke the token, then manage the row explicitly.

Generate a token without OpenSSL:

```bash
node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
```

PowerShell uses `$env:DATABASE_URL = 'postgresql://...'` and the same form for every token. The server shell and the demo shell must use identical values.

## HTTP

All bodies are JSON, maximum 1 MB, `Content-Type: application/json`. Successful bodies are JSON with `Cache-Control: no-store`.

- Operator routes require `Authorization: Bearer <operator token>`.
- Worker routes require the token for `capability`, and every body must include `agent_id` and `capability`.
- Use a unique `agent_id` per process. Do not run concurrent processes with the same id.

### `GET /` and `GET /ui` (Operator Web Console)

> Security: this page is public and never embeds a credential. The former `uiDefaultToken` option of `createRegistryServer` is deprecated and ignored; pass the token via the `#token=` fragment (not sent to the server) or the token input.

Built-in zero-dependency bilingual (中文/EN) Operator Console served directly by the registry server. Supports browser authentication via `sessionStorage` (or `#token=<operatorToken>` hash fragment auto-login) and provides:

- **Interactive SVG DAG & Trace Explorer**: Inspect request topologies, task states, priorities, and `trace_id`, with one-click task cancellation and dynamic subgraph expansion (`expand`).
- **HITL Fact Review & Rework Workbench**: Inspect `shared_facts`, set `confidence`, and approve (`verified: true`) or reject & trigger upstream rework (`verified: false, rework: true`).
- **Capabilities & Worker Fleet Matrix**: Live view of worker pass rates, latency, FinOps token/cost usage, and one-click worker enable/isolate controls.
- **Organizational Memory Ledger & Plan Submitter**: Browse verified `fact_key` memory and submit new DAG plans from built-in templates.
- **Interactive UI Playground**: Run `npm run demo:ui` to launch a live server with simulated workers and pre-seeded workflows.

### `GET /api/events` (Real-Time SSE Stream)

Operator bearer token required. Streams `text/event-stream` notifications whenever tasks are submitted, expanded, completed, reviewed, or worker states change.

### `GET /health`

Unauthenticated process liveness. It does **not** prove database readiness.

```http
GET /health
```

```json
{ "ok": true }
```

### `GET /api/state`

Operator snapshot: capabilities, agents, tasks, attempts, facts, events, quota, and `time`. Tasks, facts, and attempts are the latest 200 rows; events are the latest 150. This is not a historical export API.

```bash
curl -sS -H "Authorization: Bearer $REGISTRY_OPERATOR_TOKEN" http://127.0.0.1:8766/api/state
```

### `GET /api/telemetry`

Operator compound telemetry and organizational memory ledger: aggregates attempt counts, average duration, verification `pass_rate`, and `consecutive_failures` across `capabilities` and `workers`, plus the latest verified organizational facts in `memory`.

### `POST /api/tasks`

Submit a request-local DAG. Returns `201` and database task ids.

Request:

```json
{
  "request_id": "unique-request-id",
  "plan": {
    "tasks": [
      {
        "id": "normalize",
        "capability": "text.normalize",
        "fact_key": "org.greeting.latest",
        "input": { "text": "  hello agents  " }
      },
      {
        "id": "summary",
        "capability": "text.summarize",
        "dependencies": ["normalize"],
        "context_keys": ["org.greeting.latest"]
      }
    ]
  }
}
```

Response:

```json
{ "ids": ["<uuid>", "<uuid>"] }
```

Each task needs a request-local `id`, a catalog `capability`, a JSON object `input` (optional, default `{}`), and optional `dependencies` listing other local ids, `priority` (safe integer in $[-1000, 1000]$, higher dispatched first), `require_verified_facts` (boolean), `min_fact_confidence` ($0 \le \text{confidence} \le 1$ gate for dependency and context facts), `fact_key` (named organizational fact key), and `context_keys` (up to 20 verified organizational fact keys to inject on claim, scoped by the capability's `allowed_context_prefixes`). `plan` also accepts optional `trace_id` (propagated across tasks, dynamic expansions, and events) and `budget`. Returned ids are database `task_id` values; events still keep the local key.

```bash
curl -sS -X POST http://127.0.0.1:8766/api/tasks \
  -H "Authorization: Bearer $REGISTRY_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"request_id":"request-12345678","plan":{"tasks":[{"id":"normalize","capability":"text.normalize","input":{"text":" hi "}}]}}'
```

### `POST /api/tasks/expand`

Dynamically expand a request DAG under a parent task within the 100-task per-request budget. Returns `201` and new database task ids.

```json
{
  "request_id": "unique-request-id",
  "expansion_id": "unique-expansion-id",
  "parent_task_id": "<database-parent-task-id>",
  "rewire_dependents": true,
  "plan": {
    "tasks": [{ "id": "verify-step", "capability": "text.normalize" }]
  }
}
```

Root tasks in `plan` automatically depend on `parent_task_id`. When `rewire_dependents: true`, queued (undispatched) tasks in the same request that depended on `parent_task_id` are rewired to depend on the leaf tasks of `plan`. Idempotent per `(request_id, expansion_id)`.

### `POST /api/facts/review`

Operator only. Library equivalent: `scheduler.reviewFact(taskId, version, verified, note, { rework = false })`.

```json
{
  "task_id": "<database-task-id>",
  "version": 1,
  "verified": false,
  "note": "Missing primary evidence; rework required",
  "rework": true
}
```

`version` must be a positive safe integer matching the completed task's current fact version (possibly greater than 1 after retries). `verified` must be boolean. `note` is required, nonempty after trimming, and at most 4000 characters before trimming. Optional `rework: true` (valid only when `verified: false`) transitions the task back to `queued` (if `attempts < maxAttempts`) or `failed` (propagating `dependency_failed` to queued descendants) provided no direct dependent has been dispatched yet; if a dependent was already dispatched, it returns `{ "accepted": false, "reason": "downstream_dispatched" }`.

Each accepted call appends a `fact_reviewed` event (and `rework_triggered` when `rework: true`).

Set `require_verified_facts: true` on a downstream task to wait for verification of every direct dependency's current output. Omitted or `false` preserves legacy behavior; other types are rejected. Revoke with `verified: false`; this does not roll back dispatched tasks. Claimed facts also include `review_note` and `reviewed_at` (both null before review).

### `POST /api/cancel`

```json
{ "task_id": "<database-task-id>" }
```

```json
{ "ok": true }
```

Cancellation prevents accepting success. It cannot undo external effects. A running attempt keeps its quota slot until acknowledgement or lease expiry.

### `POST /api/workers/enable`

```json
{ "agent_id": "worker-id", "enabled": false }
```

```json
{ "ok": true }
```

Pauses future claims. It does not cancel an active attempt. `enabled` must be a boolean; re-enabling (`enabled: true`) resets the worker's `consecutive_failures` counter to `0`.

### `POST /api/planner/submit` (Natural-Language Goal-to-DAG Planner)

Operator bearer token required. Compiles a natural-language `goal` against live `capabilities` and verified organizational `memory` into a contract-validated DAG and submits it immediately:

```json
{
  "goal": "Research solid-state electrolyte breakthroughs and compose executive summary",
  "request_id": "req-goal-1",
  "trace_id": "trace.goal.1",
  "fact_key": "org.electrolyte.summary",
  "budget": { "max_tokens": 2000, "max_cost_usd": 0.05 }
}
```

Returns `201` with `{ "request_id", "goal", "plan", "ids" }`.

### `POST /api/triggers` and `POST /api/triggers/fire` (Cron & Webhook Triggers)

Register or update recurring schedules (`cron` 5-field expression or `interval_seconds`) and external event triggers (`webhook: true`) that automatically submit DAG workflows on `scheduler.tick()` or via `/api/triggers/fire` to keep organizational memory fresh:

```json
{
  "trigger_id": "hourly-memory-refresh",
  "description": "Refresh domain memory digest every hour",
  "cron": "0 * * * *",
  "webhook": true,
  "enabled": true,
  "plan": {
    "tasks": [
      {
        "id": "refresh-fact",
        "capability": "text.normalize",
        "fact_key": "org.hourly.digest",
        "fact_ttl_seconds": 7200,
        "input": { "text": "periodic refresh" }
      }
    ]
  }
}
```

Manual or webhook invocation via `POST /api/triggers/fire`:

```json
{
  "trigger_id": "hourly-memory-refresh",
  "payload": { "source": "github-release-webhook" }
}
```

### `POST /internal/register`

Registers or renews an instance lease. Changing capability for an existing `agent_id` is rejected.

```json
{ "agent_id": "worker-normalize-1", "capability": "text.normalize" }
```

```json
{ "ok": true }
```

### `POST /internal/claim`

Renews the instance lease. Supports optional `wait_ms` ($0 \le \text{wait\_ms} \le 30000$) for event-driven low-latency long-polling wakeup when work is submitted, expanded, completed, or verified. Returns `{ "task": null }` or a task.

A claimed task includes original columns plus `call_id`, `attempt_id`, `attempt`, `deadline`, dependency `facts`, prior attempt outputs/reviews in `prior_facts`, and subscribed organizational facts in `context_facts`.

Both `attempt` and `attempts` reflect the count after this claim. `lease_until` is the current attempt's lease. Valid heartbeats synchronize task and attempt leases in one transaction, capped at `deadline`, without changing the task's `updated_at`.

For library calls, capability names must be strings and task input must remain an object after JSON serialization. A top-level `Date`, or a `toJSON()` returning a string, array, or null, does not satisfy the task input contract.

### `POST /internal/heartbeat`

Optional `call_id`. Response: `{ "ok": true, "valid": boolean, "enabled": boolean }`.

- `valid` is true only for the current running attempt.
- Instance-only heartbeats have `valid: false`.
- If `valid` becomes false, the worker must stop the handler.

### `POST /internal/result`

Requires `call_id` and either a JSON `result` or `error`, plus optional `usage: { input_tokens, output_tokens, total_tokens, cost_usd }` (exceeding `plan.budget` halts remaining queued tasks in the request with `budget_exceeded`; violating a capability's `required_output_fields` fails the attempt with `output_contract_violation`).

```json
{
  "agent_id": "worker-normalize-1",
  "capability": "text.normalize",
  "call_id": "<uuid>",
  "result": { "text": "HELLO AGENTS" },
  "usage": { "input_tokens": 12, "output_tokens": 6, "cost_usd": 0.0001 }
}
```

```json
{ "accepted": true }
```

Completed or expired attempts return `{ "accepted": false, "duplicate": true }` or `{ "accepted": false }`. Do not send both a success result and expect it to apply after cancel.

### `POST /internal/review`

Callable by registered, active workers bound to a capability with `verifier: true` (self-review of the worker's own facts is rejected), supporting optional `rework`, `confidence` ($0 \le \text{confidence} \le 1$), and `ttl_seconds`:

```json
{
  "agent_id": "worker-verify-1",
  "capability": "fact.verify",
  "task_id": "<database-task-id>",
  "version": 1,
  "verified": true,
  "confidence": 0.98,
  "note": "Verified by independent verifier agent"
}
```

## Errors

Workers validate JSON serialization before sending results. Handler failures report `handler_failed`; already cancelled or expired work does not invoke the handler. Direct `worker.execute()` calls reject on receipt transport failure. `worker.run()` catches that error and re-registers without reporting successful execution as handler failure.

| Status | `error`                | When                                                                   |
| ------ | ---------------------- | ---------------------------------------------------------------------- |
| 400    | `request_rejected`     | Validation or scheduler rejection; internal messages are not forwarded |
| 400    | `invalid_agent`        | Worker `agent_id` failed `/^[\w-]{4,100}$/`                            |
| 400    | `result_required`      | Result body missing both `result` and `error`                          |
| 400    | `invalid_worker_state` | `enabled` is not a boolean or `agent_id` is not a string               |
| 401    | `unauthorized`         | Missing/wrong bearer token, or capability/token mismatch               |
| 404    | `not_found`            | Unknown route                                                          |
| 405    | `method_not_allowed`   | Non-POST on `/internal/*`                                              |
| 503    | `storage_unavailable`  | PostgreSQL driver error code                                           |

`POST /api/tasks` and `POST /api/tasks/expand` return **201** on success. Some malformed JSON bodies also collapse to `request_rejected` because the HTTP layer does not leak parse details.

## Library API

### `new Scheduler(pgConfig, options)`

`pgConfig` is passed to `pg.Pool` (typically `{ connectionString }`).

`options`: `schema`, `lease`, `deadline`, `capabilities` (including optional `verifier`, `required_input_fields`, `required_output_fields`, `allowed_context_prefixes`), `capacity`, `maxAttempts`, `maxConsecutiveFailures`.

| Method                                                                          | Role                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `init()`                                                                        | Create schema, apply SQL, upsert catalog and quota     |
| `submit(requestId, plan)`                                                       | Persist DAG (with optional `budget`/`trace_id`)        |
| `expand(requestId, expansionId, parentTaskId, plan, options?)`                  | Dynamically expand DAG under parent; `{ ids }`         |
| `forkRequest(sourceRequestId, newRequestId, options?)`                          | Time-travel branch DAG reusing completed upstream work |
| `register(id, capability)`                                                      | Upsert worker lease; `{ ok }`                          |
| `claim(id, capability, { waitMs }?)`                                            | `{ task }` or `{ task: null }` (reputation-gated wait) |
| `heartbeat(id, capability, callId?)`                                            | `{ ok, valid, enabled }`                               |
| `result(id, capability, callId, result, error, usage?)`                         | `{ accepted, duplicate?, contract_violation? }`        |
| `reviewFact(taskId, version, verified, note, options?)`                         | Operator fact review (optional rework/confidence/TTL)  |
| `reviewFactByVerifier(id, capability, taskId, version, verified, note, opts?)`  | Delegated Verifier Agent review (self-review blocked)  |
| `searchMemory(query, { prefix, minConfidence, limit }?)`                        | Search active verified organizational memory           |
| `rollbackFact(factKey, { note }?)`                                              | Roll back `fact_key` to previous verified fact version |
| `crystallizePlaybook(playbookId, { sourceRequestId, description, tags, plan })` | Crystallize proven request DAG into reusable SOP       |
| `listPlaybooks()` / `runPlaybook(playbookId, requestId?, options?)`             | List or instantiate crystallized Playbook SOPs         |
| `deletePlaybook(playbookId)`                                                    | Delete a crystallized Playbook SOP                     |
| `exportBundle()` / `importBundle(bundle)`                                       | Export/import portable memory, trigger & playbook pack |
| `cancel(taskId)`                                                                | `{ ok }`                                               |
| `enable(id, enabled)`                                                           | `{ ok }`                                               |
| `upsertTrigger(triggerId, spec)`                                                | Register or update Cron/interval/webhook trigger       |
| `fireTrigger(triggerId, { payload, source }?)`                                  | Manually or webhook-trigger a recurring DAG workflow   |
| `telemetry()`                                                                   | Telemetry, usage, memory, triggers, and playbooks      |
| `tick()`                                                                        | Reap expired attempts/workers and run due triggers     |
| `snapshot()`                                                                    | Recent operational state (`triggers`, `playbooks`)     |
| `close()`                                                                       | End the pool                                           |

Never hold a scheduler transaction across model or network calls. `tx()` is internal and already taken around each mutation.

### `new Planner(options)` (Goal-to-DAG Planner)

Compiles natural-language goals into contract-validated DAG plans against the `capabilities` catalog and active organizational `memory` (supports OpenAI-compatible JSON-mode LLM endpoints via `apiKey` / `endpoint` / `model` as well as deterministic capability-aware synthesis):

- `planner.plan(goal, { requestId, capabilities, memory, traceId, budget, factKey })`: Compile and validate a DAG plan.
- `planner.submitGoal(scheduler, goal, options)`: Compile a goal against live `scheduler.telemetry()` and immediately submit the DAG.
- `planner.expandFromFact(scheduler, { requestId, parentTaskId, fact, goal })`: Dynamically synthesize and expand a child sub-DAG under `parentTaskId`.

### `createLlmWorkerHandler(options)` and `createMcpToolHandler(options)` (LLM & MCP Worker Adapters)

Standardized worker handler builders that automatically inject upstream `facts`, rejected `prior_facts` (`review_note`), and subscribed `context_facts`, and report FinOps token/cost `usage`:

- `createLlmWorkerHandler({ endpoint, apiKey, model, systemPrompt, costPerInputToken, costPerOutputToken })`: Wraps OpenAI-compatible Chat Completions endpoints and returns `{ result, usage }`.
- `createMcpToolHandler({ client, toolName, mapInput, formatOutput })`: Wraps an MCP client (`callTool`) or JSON-RPC MCP HTTP endpoint.

### `new Worker(options)`

Required: `url`, `token`, `capability`, `handler`.

Optional: `id` (default `worker-<uuid>`), `pollMs` (1000), `heartbeatMs` (10000), `requestTimeoutMs` (5000). Keep heartbeat and request timeout well below the scheduler lease.

```js
const worker = new Worker({
  url: "http://127.0.0.1:8766",
  token: process.env.NORMALIZE_WORKER_TOKEN,
  capability: "text.normalize",
  handler: async (task, { signal }) => {
    const text = String(task.input.text ?? "")
      .trim()
      .toUpperCase();
    return { text };
  },
});
await worker.run({ signal: shutdownController.signal });
```

Handler rules:

- Must return JSON. `undefined`, cycles, and `BigInt` are invalid.
- Must honor `signal` for cooperative cancellation.
- Must make external writes idempotent using the stable database `task_id`. Use `attempt_id` / `call_id` for tracing only.
- Sees only explicit dependency facts, not other agents' private context.
- Sample handler URL fetching is unsafe unless the deployment validates allow-lists itself.

`run()` re-registers after transport failures. Offline instances are reaped by lease, not by a client-side logout.

### `createRegistryServer(scheduler, { operatorToken, workerTokens, planner })`

Returns an unbound `http.Server`. Caller owns listen/close and scheduler lifetime.

### `validatePlan(requestId, plan)` / `validateCapabilities(capabilities)` / `validateTriggerSpec(triggerId, spec)`

Pure functions used by `Scheduler`. Safe to call in a planner before submit.

### RRSI / Harness² Self-Evolving & Two-Tier Memory APIs (`v1.5`)

- `await scheduler.getGenome()` / `GET /api/harness/genome`: returns the active `HarnessGenome` (`planner_prompts`, `adapter_prompts`, `memory_config`, `expansion_config`, and `changed_surfaces` vs baseline).
- `await scheduler.updateGenome(candidate, options)` & `await scheduler.evolveGenome(candidate, options)` / `POST /api/harness/genome`: validates and updates or evolves the genome with frozen security boundary checks, anti-overfitting critic, annealed edit budgets, dual-channel cost-aware gate, and ablation pruning.
- `await scheduler.evolvePlaybook(playbookId, options)` / `POST /api/playbooks/evolve`: evolves an organizational Playbook under the RRSI anti-overfitting critic and dual-channel cost-aware acceptance gate.
- `await scheduler.getHarnessLedger({ limit })` / `GET /api/harness/ledger`: returns structured experiment ledger entries and `recommended_focus_surface` for stagnation redirection.
- `await scheduler.calibrateHarness({ tasks, rounds })` / `POST /api/harness/calibrate`: computes single-arm noise floors ($\delta_{\text{pass}}$, $\delta_{\text{cost}}$, $\delta_{\text{tokens}}$) using Jeffreys smoothed Bernoulli variance and sample cost variance.
- `await scheduler.compareHarnessArms(armA, armB, options)` / `POST /api/harness/compare`: runs two-arm paired statistical evaluation (exact McNemar test + 2000-iteration seeded paired bootstrap 95% CI on `cost_per_resolved` ratio $B / A$ + non-inferiority guard).
- `await scheduler.promoteMemoryInvariant(namespace, options)` / `POST /api/memory/promote-invariant`: promotes or refreshes `[Module Invariant: <namespace>]` from verified episodic facts and caps active episodic entries per namespace to `max_episodic_per_namespace`.

## Deployment and limitations

Bind to loopback by default. Put TLS and access restrictions in front of non-local connections.

The operator has schema-wide authority. There is no tenant or per-user layer.

State changes serialize per schema. Prefer consistency over high-throughput horizontal scaling.

Execution is **at least once**. Network loss or lease expiry can overlap an old handler with a retry. Enforce idempotency or fencing in the external system.

`examples/workflow.mjs` and `examples/ui-demo.mjs` run out of the box without external model keys.

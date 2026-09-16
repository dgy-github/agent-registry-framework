# Architecture and design

## Model

The framework has four layers:

1. **Catalog** — a deployment-owned list of capability names and descriptions. Registration accepts only catalog entries; business code decides how a capability is implemented.
2. **Scheduler** — PostgreSQL is the source of truth for workers, tasks, attempts, events, quotas, and shared facts. Every mutation runs in a short transaction protected by a per-schema advisory lock.
3. **Worker boundary** — workers authenticate with a credential scoped to one capability. A worker registers before claiming, renews its lease while running, and returns results with its `call_id`.
4. **Domain adapter** — the handler reads the task input and dependency facts, calls real systems, and applies its own authorization, idempotency, and audit policy.

## Lifecycle

`register → claim → heartbeat → result` is the normal lifecycle. A claim creates an attempt and binds a task to `agent_id`, `attempt_id`, and `call_id`. The scheduler accepts a result only while all three bindings still describe the current running attempt. A timeout or cancellation marks the attempt finished, retains the execution slot until acknowledgement or lease reaping, and prevents a late result from overwriting newer state.

## Task graphs

Clients submit a request id and a JSON task graph. The graph is detached from caller memory, sorted for deterministic comparison, checked for duplicate ids, missing dependencies and cycles, then checked against the capability catalog in the same transaction as its first write. Repeating the request id with the same normalized graph is idempotent; changing the graph is rejected.

## Trust boundaries

The operator token can inspect state and submit or cancel work. Each worker token is accepted only for its declared capability. Credentials must be random, stored outside the repository, rotated by the deployment, and never placed in task input. The HTTP layer returns stable error categories and does not expose database driver messages, connection strings, or payloads. The framework cannot prove a handler's business authorization; the domain adapter must do that before every side effect.

## Recovery and operations

Leases make process loss recoverable. `tick()` reclaims expired attempts before deleting stale registrations. An attempt can be retried only up to its task's `max_attempts`. Keep PostgreSQL backups and monitor `agent_events`, failed attempts, queue age, lease-expiry rate, and handler latency. Run each deployment with an isolated schema and least-privilege database role.

## Extension contract

Add a capability entry, implement a handler, and submit a graph. Do not fork the scheduler to add domain state. If a domain needs durable business records, keep them in its own schema and reference their identifiers in task input. If a different transport is required, adapt the HTTP methods to the same scheduler methods and preserve `agent_id`, `attempt_id`, and `call_id` semantics.

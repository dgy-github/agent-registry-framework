# Agent Registry Framework

A durable, domain-neutral registry and execution fabric for multi-agent systems.

Workers register themselves, a scheduler discovers their capabilities, and a PostgreSQL task graph coordinates leased execution. The core contains no commerce model, prompt, UI, or vendor-specific agent SDK.

[简体中文](README.zh-CN.md) · [Architecture](docs/architecture.en.md) · [API](docs/api.en.md) · [中文设计](docs/architecture.zh-CN.md) · [中文 API](docs/api.zh-CN.md)

## What it is

```mermaid
flowchart TB
  subgraph Entry["Ingress & Triggers"]
    Operator["Operator / Web Console<br/>Bearer Operator Token"]
    Cron["Cron / Webhook Triggers"]
    NLPlanner["Natural-Language Planner<br/>LLM Planner"]
    SOP["Crystallized Playbooks<br/>Procedural SOPs"]
  end

  subgraph Core["Kernel Orchestration & Governance (Scheduler & RRSI Harness)"]
    HTTP["HTTP Trust Boundary & SSE Stream"]
    Val["DAG Topology / Contract / Budget Validator"]
    SM["Leased State Machine & Reputation/Confidence Gates"]
    MemEngine["Harness² Two-Tier Memory Engine<br/>(Invariant + Episodic)"]
    RRSI["RRSI Self-Evolving Regularization Engine<br/>(P0 Calibration / P1 Dual Gate / P2 Genome)"]
  end

  subgraph Fleet["Leased Worker & Verifier Cohort"]
    WorkerA["Domain / LLM / MCP Workers<br/>Capability Token + call_id Fencing"]
    Verifier["Delegated Verifier Workers<br/>No Self-Review + 60-Point Rework Loop"]
  end

  subgraph Storage["Durable Source of Truth (PostgreSQL Schema)"]
    PG_Tasks[("agent_requests / tasks<br/>attempts / expansions")]
    PG_Mem[("shared_facts / playbooks<br/>Two-Tier Memory & Beta Weights")]
    PG_Harness[("agent_harness_genome<br/>agent_harness_ledger")]
  end

  Operator --> HTTP
  Cron --> SM
  NLPlanner --> Val
  SOP --> Val
  HTTP --> Val --> SM
  SM <--> MemEngine
  SM <--> RRSI
  WorkerA <-->|"register / long-poll claim / heartbeat / result"| HTTP
  Verifier <-->|"independent review / reject & rework"| HTTP
  SM --> PG_Tasks
  MemEngine --> PG_Mem
  RRSI --> PG_Harness
```

The scheduler owns orchestration state: capabilities, workers, task graphs, attempts, leases, quotas, events, two-tier shared facts, crystallized playbooks, and the self-evolving harness genome & ledger.

A domain adapter owns authentication, real data, external side effects, and idempotency. Model output is never an authorization decision.

## What it is not

- Not a vendor-locked agent black box (the core scheduler has zero vendor SDK dependencies, while providing an optional `Planner` and standard `LLM`/`MCP` worker adapters).
- Not a multi-tenant or end-user authorization layer.
- Not exactly-once execution. Delivery is **at least once**.

## What it provides

- Declarative capability catalog (with input/output field contracts, `allowed_context_prefixes` memory sandboxes, and delegated `verifier` roles) and strict DAG validation.
- Durable registration, leases, heartbeats, bounded retries, cancellation, quotas, priority preemption (`priority`), reputation-gated dispatch (`min_worker_pass_rate` with cold-start protection), per-request token/cost budget guardrails (`budget`), and event-driven long-polling wakeup (`waitMs`).
- Dependency-aware dispatch, bounded runtime subgraph expansion (`expand`), and time-travel DAG branching (`forkRequest`); versioned shared facts and late-result fencing.
- Verified-dependency gates, minimum confidence gates (`min_fact_confidence`), operator and delegated Verifier Agent reviews (with self-review prevention), and feedback-driven rework (`rework` with `prior_facts`).
- Three-tier organizational memory with Harness² two-tier structuring:
  - **Semantic Memory (`invariant` vs `episodic`)**: cross-request fact publishing (`fact_key`), static subscriptions (`context_keys`), dynamic keyword/topic injection (`context_query`), full-text search (`searchMemory`), TTL expiration, and 1-click version rollback (`rollbackFact`). When a module namespace (e.g., `org.policy.*`) accumulates `>= 2` verified episodic facts, the scheduler automatically promotes a structured **Module Invariant (`[Module Invariant: <namespace>]`)** (with `+6` recall priority boost and preserved Beta posterior weights across in-place updates), caps active episodic facts per namespace to `max_episodic_per_namespace = 2`, and applies **free-rider discounting** on high-cost turns.
  - **Procedural Memory (Skill Crystallization)**: distill proven request graphs (including runtime `expand` subgraphs) into versioned, reusable SOP templates (`crystallizePlaybook` / `runPlaybook` / `evolvePlaybook`).
  - **Portable Organization Bundle**: export and import capabilities, verified memory, triggers, playbooks, and `HarnessGenome` (`exportBundle` / `importBundle`).
- **Google RRSI / ReSelf & Harness² Self-Evolving Regularization Engine ([`src/harness.mjs`](src/harness.mjs))**:
  - **P0 Noise-Calibrated & Paired Statistical Evaluation**: single-arm noise floor calibration (`calibrateHarness` via Jeffreys smoothed Bernoulli variance $\delta_{\text{pass}}$ and sample cost variance $\delta_{\text{cost}}$) and two-arm paired evaluation (`compareHarnessArms` with exact McNemar test, 2000-iteration paired bootstrap 95% CI on `cost_per_resolved` ratio `B / A`, and non-inferiority guard).
  - **P1 RRSI Evolution Regularization**: surface-level annealed edit budgets (`changedGenomeSurfaces` / `changedGenomeLines` and annealed `expand` limits), rule-based anti-overfitting critic (`criticCheckCandidate`), structured falsified ledger (`agent_harness_ledger` with automatic injection into `Planner` and stagnation surface redirection `pickStagnationSurface`), dual-channel cost-aware acceptance gate, and post-search ablation pruning (`evolveGenome` / `evolvePlaybook`).
  - **P2 Multi-Surface Evolvable `HarnessGenome`**: governs `planner_prompts`, `adapter_prompts`, `memory_config` (default `6 entries / 2400 chars` recall cap), and `expansion_config`, with frozen security boundaries and a 100% byte-identical no-op default guarantee.
- Natural-language `Planner`, standard `createLlmWorkerHandler` / `createMcpToolHandler` adapters, and Cron/Webhook `Triggers` (`upsertTrigger` / `fireTrigger`).
- Built-in zero-dependency **AIOS Operator Web Console (`GET /` + `GET /api/events` SSE stream)**.

## Core workflows & self-evolving architecture

### 1. Leased execution, 60-point verifier rework & dynamic subgraph expansion

```mermaid
sequenceDiagram
  autonumber
  actor Op as Operator / Planner
  participant Sch as Scheduler (PostgreSQL)
  participant Wk as Execution Worker (LLM/MCP)
  participant Ver as Independent Verifier Worker

  Op->>Sch: submit(request_id, DAG plan, budget)
  Sch->>Sch: Validate DAG + capability contracts + enqueue (queued)
  Wk->>Sch: claim(capability, waitMs)
  Sch->>Sch: Reputation gate check + recall Two-Tier Memory (<=6 entries/2400 chars)
  Sch-->>Wk: Grant lease (call_id, dependency_facts, context_facts)
  opt Bounded runtime subgraph expansion (annealed budget)
    Wk->>Sch: expand(parent_task_id, sub_tasks, rewireDependents)
    Sch-->>Wk: Idempotently attach sub-DAG & rewire downstream dependents
  end
  Wk->>Sch: complete(call_id, output, usage)
  Sch->>Sch: Persist shared_facts (verified=false) + cost-aware attribution
  Ver->>Sch: reviewFactByVerifier(task_id, verified=false, rework=true, note)
  Sch->>Sch: Trigger rework (rework_triggered), re-queue with prior_facts
  Wk->>Sch: Re-claim task (receives rejection review_note)
  Wk->>Sch: complete(call_id, revised output)
  Ver->>Sch: reviewFactByVerifier(task_id, verified=true, confidence=0.95)
  Sch->>Sch: Unblock downstream require_verified_facts tasks + promote Module Invariant
  Op->>Sch: crystallizePlaybook(request_id) into reusable SOP
```

### 2. Google RRSI / ReSelf regularized self-evolving loop

```mermaid
flowchart TD
  Start["Propose Evolution<br/>evolveGenome / evolvePlaybook"] --> Stagnation{"Stagnant >= 2 rounds?"}
  Stagnation -->|"Yes"| Redirect["Stagnation Redirection (pickStagnationSurface)<br/>Rotate to least-explored Genome surface"]
  Stagnation -->|"No"| Budget["Compute Annealed Edit Budget<br/>max_surfaces = max(1, B0 - floor(r/2))"]
  Redirect --> Budget
  Budget --> Critic{"Anti-Overfitting Static Critic<br/>(criticCheckCandidate)"}
  Critic -->|"Hardcoded task_id / check.py / bypass"| RejectCritic["Block & log to Falsified Ledger<br/>(rejected_critic)"]
  Critic -->|"Pass"| EvalP0["P0 Noise Floor & Paired Statistical Eval<br/>calibrateHarness + compareHarnessArms<br/>(McNemar + 2000x Paired Bootstrap)"]
  EvalP0 --> Holdout{"Holdout Non-Regression Gate"}
  Holdout -->|"Net regression > 0"| RejectHoldout["Block & log to Falsified Ledger<br/>(rejected_holdout_regression)"]
  Holdout -->|"No regression"| DualGate{"P1 Dual-Channel Cost-Aware Gate<br/>(evaluateDualChannelGate)"}
  DualGate -->|"Channel 1: Gain > delta_pass<br/>& no Token Bloat (>10% tokens / <2% gain)"| Ablation["Post-Search Leave-One-Out Ablation<br/>Prune zero-contribution free-rider surfaces"]
  DualGate -->|"Channel 2: Non-Inferior (>= -delta_pass)<br/>& significant cost drop (>=15% or CI<1.0)"| Ablation
  DualGate -->|"Insignificant gain / Token bloat"| RejectGate["Reject & inject falsified history into Planner<br/>(rejected_no_significant_gain / bloat)"]
  Ablation --> Promote["Promote New Genome / Playbook Version<br/>Persist to agent_harness_genome & ledger"]
```

### 3. Harness² two-tier organizational memory & anti-poisoning attribution

```mermaid
flowchart LR
  subgraph Produce["1. Fact Emission & Verifier Gate"]
    Out["Task Output<br/>fact_key = org.policy.refund"] --> VerGate{"Operator / Verifier<br/>verified = true?"}
  end

  subgraph Tiering["2. Two-Tier Structuring (Invariant vs Episodic)"]
    VerGate -->|"Yes"| EpStore["Store Episodic Fact (episodic)<br/>Cap active episodic <= 2 per namespace"]
    EpStore --> CountCheck{">= 2 verified episodic<br/>facts in namespace?"}
    CountCheck -->|"Yes"| Synth["Auto-Promote Module Invariant<br/>[Module Invariant: org.policy]<br/>In-place update preserves Beta weights"]
  end

  subgraph Recall["3. Hard-Budget Priority Recall"]
    Synth -->|"+6 structural boost"| BudgetRecall["Bounded Recall (_claimOnce)<br/>Hard cap: 6 entries / 2400 chars<br/>injected_count + 1"]
    EpStore -->|"Standard relevance score"| BudgetRecall
  end

  subgraph Attribution["4. Cost-Aware Beta Feedback & Anti-Poisoning"]
    BudgetRecall --> TurnCost{"Task total_tokens ><br/>expensive_token_threshold?"}
    TurnCost -->|"Normal-cost turn"| AcceptAll["All recalled facts<br/>accepted_count + 1"]
    TurnCost -->|"Expensive turn"| FreeRider["Free-Rider Filter:<br/>Only cited/domain-matched accepted + 1"]
    AcceptAll --> DemoteCheck{"injected >= 8 &<br/>smoothed p < 0.25?"}
    FreeRider --> DemoteCheck
    DemoteCheck -->|"Yes"| Demote["Auto-Demote (demoted = true)<br/>Excluded from default recall pool"]
  end
```

## Requirements

- Node.js 22+
- PostgreSQL 14+

## Quick start

### Option 1: Interactive Web Console Sandbox (Embedded PostgreSQL included)

```bash
npm install
npm run demo:ui
```

Open the printed auto-login URL (`http://127.0.0.1:8766/#token=...`) in your browser to explore the live SVG DAG canvas, 60-point HITL review & rework, reputation gates, time-travel fork, memory rollback, crystallized Playbooks, and AI Planner.

### Option 2: Standard Production Setup

1. Install dependencies and copy the example config.

```bash
npm install
cp registry.example.json registry.json
```

PowerShell:

```powershell
npm install
Copy-Item .\registry.example.json .\registry.json
```

2. Create a database and set environment variables. Tokens must be distinct random strings of at least 24 characters. The process does not load `.env` files automatically; copy [`.env.example`](.env.example) only if your own tooling loads it.

Bash:

```bash
export DATABASE_URL=postgresql://registry:password@127.0.0.1:5432/registry
export REGISTRY_CONFIG=registry.json
node --input-type=module -e "import {randomBytes} from 'node:crypto'; for (const n of ['REGISTRY_OPERATOR_TOKEN','NORMALIZE_WORKER_TOKEN','SUMMARIZE_WORKER_TOKEN']) console.log('export '+n+'='+randomBytes(32).toString('hex'))"
# paste the three export lines, then:
npm start
```

PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://registry:password@127.0.0.1:5432/registry'
$env:REGISTRY_CONFIG = 'registry.json'
node --input-type=module -e "import {randomBytes} from 'node:crypto'; for (const n of ['REGISTRY_OPERATOR_TOKEN','NORMALIZE_WORKER_TOKEN','SUMMARIZE_WORKER_TOKEN']) console.log(n+'='+randomBytes(32).toString('hex'))"
# set the three $env:... values, then:
npm start
```

The server listens on `127.0.0.1:8766` by default and prints `Agent registry listening`.

3. In a **second shell**, reuse the same three tokens and run the example:

```bash
export REGISTRY_URL=http://127.0.0.1:8766
export REGISTRY_OPERATOR_TOKEN=...
export NORMALIZE_WORKER_TOKEN=...
export SUMMARIZE_WORKER_TOKEN=...
npm run demo
```

PowerShell:

```powershell
$env:REGISTRY_URL = 'http://127.0.0.1:8766'
$env:REGISTRY_OPERATOR_TOKEN = '...'
$env:NORMALIZE_WORKER_TOKEN = '...'
$env:SUMMARIZE_WORKER_TOKEN = '...'
npm run demo
```

The demo registers two workers and runs a two-node graph: `text.normalize` then `text.summarize`. Expected output is JSON whose `text` is `HELLO AGENTS`.

See [docs/architecture.en.md](docs/architecture.en.md) for production deployment, security, recovery, and extension rules. See [docs/api.en.md](docs/api.en.md) for configuration, HTTP, and library methods.

## Library API

```js
import {
  Scheduler,
  Worker,
  Planner,
  createLlmWorkerHandler,
  createMcpWorkerHandler,
  createRegistryServer,
  validatePlan,
  validateCapabilities,
  validateTriggerSpec,
} from "agent-registry-framework";
```

- `Scheduler` persists registration, tasks, organizational memory, triggers, and playbooks. Call `init()` once to create the schema, then `tick()` periodically.
- `Worker` calls your `handler(task, { signal, reportUsage })`. The handler must honor cancellation and make external writes idempotent.
- `Planner` compiles natural-language goals into validated DAG plans or runtime subgraph expansions against the registered capability catalog.
- `createRegistryServer` exposes operator, worker, and Web Console HTTP endpoints. The returned `http.Server` is unbound; the caller owns `listen` / `close`.

## Project layout

| Path                    | Role                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `src/scheduler.mjs`     | Durable state machine, memory, forking, playbooks & transactions |
| `src/scheduler.sql`     | Registry-owned tables and indexes                                |
| `src/validation.mjs`    | Capability catalog and DAG checks                                |
| `src/planner.mjs`       | Natural-language goal → validated DAG planner                    |
| `src/adapters.mjs`      | Standard LLM & MCP tool worker adapters                          |
| `src/triggers.mjs`      | Cron expression parser & scheduled/webhook trigger validation    |
| `src/harness.mjs`       | RRSI / Harness² regularization, genome & paired statistical eval |
| `src/ui.mjs`            | Zero-dependency AIOS Operator Web Console (SPA)                  |
| `src/server.mjs`        | HTTP trust boundary and SSE event stream                         |
| `src/worker.mjs`        | Pull worker with long-polling and usage reporting                |
| `src/cli.mjs`           | Process entry: config, listen, tick, shutdown                    |
| `examples/workflow.mjs` | Domain-neutral two-worker CLI demo                               |
| `examples/ui-demo.mjs`  | Interactive Web Console sandbox with embedded PostgreSQL         |
| `docs/`                 | Architecture and API documentation                               |

## Verification

```bash
npm test
TEST_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/registry_test npm run test:integration
npm run format:check
```

`npm test` runs validation and HTTP tests. The integration suite needs PostgreSQL and covers concurrent claims, fencing, retry, cancellation, restart recovery, quota isolation, rework, dynamic expansion, reputation gates, memory rollback, time-travel fork, playbook crystallization, and end-to-end HTTP workers.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

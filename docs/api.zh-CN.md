# API 与使用说明

## 配置

复制 `registry.example.json`，用 `REGISTRY_CONFIG` 指向它。进程只读这一份文件，不扫描父目录，也不会自己加载 `.env`。

| 字段             | 默认             | 含义                                 |
| ---------------- | ---------------- | ------------------------------------ |
| `schema`         | `agent_registry` | 本框架使用的 PostgreSQL schema       |
| `host`           | `127.0.0.1`      | 监听地址                             |
| `port`           | `8766`           | 监听端口                             |
| `lease`          | `90`             | Worker 与尝试租约，单位秒            |
| `deadline`       | `180`            | 尝试截止时间，单位秒；必须 ≥ `lease` |
| `capacity`       | `2`              | 全局运行中尝试上限                   |
| `maxAttempts`    | `2`              | 包含首次执行                         |
| `capabilities[]` | 必填             | `name`、`description`、`tokenEnv`    |

能力 `name` 必须唯一。`tokenEnv` 是存放该能力 Worker Token 的环境变量名。Token 必须互不相同、随机生成，且不少于 24 字符，不要用示例词语。

环境变量：

| 名称                      | 谁需要                     | 用途                                        |
| ------------------------- | -------------------------- | ------------------------------------------- |
| `DATABASE_URL`            | `npm start`                | PostgreSQL 连接串                           |
| `REGISTRY_CONFIG`         | `npm start`                | JSON 配置路径，默认 `registry.example.json` |
| `REGISTRY_OPERATOR_TOKEN` | 服务和示例                 | 管理端凭据                                  |
| 各 `tokenEnv` 的值        | 服务和对应 Worker          | 按能力隔离的 Worker 凭据                    |
| `REGISTRY_URL`            | `npm run demo`             | 服务地址，默认 `http://127.0.0.1:8766`      |
| `TEST_DATABASE_URL`       | `npm run test:integration` | 集成测试数据库                              |

初始化只添加或更新能力名。从配置里删掉一项不会撤销数据库中的能力。应先清空相关任务、轮换或作废 Token，再显式处理该行。

没有 OpenSSL 时：

```powershell
node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
```

PowerShell 用 `$env:DATABASE_URL = 'postgresql://...'` 设置变量，三个 Token 也一样。跑服务的终端和跑示例的终端必须使用同一组值。

## HTTP

请求体为 JSON，最大 1 MB，`Content-Type: application/json`。成功响应也是 JSON，并带 `Cache-Control: no-store`。

- 管理接口需要 `Authorization: Bearer <管理凭据>`。
- Worker 接口使用该能力的 Token，每次请求体都要带 `agent_id` 和 `capability`。
- 每个进程使用唯一 `agent_id`，不要并发复用。

### `GET /` 与 `GET /ui`（管理端可视化控制台）

> 安全说明：该页面无需认证即可访问，因此绝不内嵌任何凭据。`createRegistryServer` 原有的 `uiDefaultToken` 选项已废弃并被忽略；请通过 `#token=` 哈希片段（不会发送到服务器）或页面中的 Token 输入框登录。

直接由注册中心内置提供的零依赖中英双语可视化控制平面（Operator Console）。支持通过浏览器输入管理端凭据（或通过 `#token=<管理凭据>` 本地哈希自动登录），提供：

- **交互式 SVG DAG 任务拓扑图**：按请求查看拓扑层级、任务状态、优先级、`trace_id`，支持一键取消任务或在任意节点下动态扩展子任务图（`expand`）。
- **60 分奇点·事实核验与打回重做工作台**：在线审查各版本产出、设置置信度（`confidence`），一键放行或携带 `review_note` 打回上游重做（`rework`）。
- **能力契约与节点复利画像**：实时观测各 Worker 核验通过率、耗时、Token/成本消耗，并支持一键隔离禁用或解除隔离。
- **跨周期组织记忆账本与在线 DAG 投递器**：实时查看有效命名事实，内置模板在线编排并投递新计划。
- **一键启动带内嵌数据库的交互式演示沙盒**：运行 `npm run demo:ui` 即可自动拉起服务、模拟 Worker 与预置工作流。

### `GET /api/events`（SSE 实时事件流）

需管理端 Bearer 凭据。返回 `text/event-stream`，当任务提交、动态扩展、回执完成、事实核验或节点状态变更时实时推送唤醒事件，驱动控制台零延迟刷新。

### `GET /health`

免鉴权的进程存活探针，**不代表**数据库就绪。

```json
{ "ok": true }
```

### `GET /api/state`

管理端快照：能力、实例、任务、尝试、事实、事件、配额和 `time`。任务、事实、尝试最多最近 200 条，事件 150 条，不是完整历史导出。

```powershell
curl.exe -sS -H "Authorization: Bearer $env:REGISTRY_OPERATOR_TOKEN" http://127.0.0.1:8766/api/state
```

### `GET /api/telemetry`

管理端能力画像、Worker 健康度与跨请求核验事实记忆：

```json
{
  "capabilities": [...],
  "workers": [...],
  "memory": [...]
}
```

### `POST /api/tasks`

提交请求内 DAG。成功返回 `201` 和数据库任务 ID。

请求：

```json
{
  "request_id": "unique-request-id",
  "plan": {
    "tasks": [
      {
        "id": "normalize",
        "capability": "text.normalize",
        "input": { "text": "  hello agents  " },
        "fact_key": "domain.glossary.v1"
      },
      {
        "id": "summary",
        "capability": "text.summarize",
        "dependencies": ["normalize"],
        "context_keys": ["domain.glossary.v1"]
      }
    ]
  }
}
```

响应：

```json
{ "ids": ["<uuid>", "<uuid>"] }
```

任务需要请求内 `id`、目录中的 `capability`、JSON 对象 `input`（可省略，默认 `{}`），以及可选 `dependencies`（其他请求内 id）、可选 `priority`（$-1000 \sim 1000$ 整数优先级，高优先级优先派发）、可选 `min_fact_confidence`（$0 \sim 1$，要求依赖事实与上下文事实置信度不低于该阈值）、可选 `fact_key`（将该任务产出发布为命名组织事实）和可选 `context_keys`（领取时按 key 注入最新已核验的跨请求组织事实到 `task.context_facts`，受能力 `allowed_context_prefixes` 命名空间前缀强约束）。请求 `plan` 还支持可选 `trace_id`（透传至所有任务、动态扩展子任务与审计事件）及 `budget`。返回值是数据库 `task_id`；事件里仍保留请求内 key。

### `POST /api/tasks/expand`

在已完成或运行中的父任务 `parent_task_id` 下动态追加子 DAG（整个 `request_id` 累计最多 100 个任务，按 `(request_id, expansion_id)` 幂等）：

```json
{
  "request_id": "unique-request-id",
  "expansion_id": "subplan-1",
  "parent_task_id": "<数据库任务 ID>",
  "rewire_dependents": true,
  "plan": {
    "tasks": [{ "id": "sub-1", "capability": "text.normalize" }]
  }
}
```

### `POST /api/facts/review`

仅管理端可调用，库方法为 `scheduler.reviewFact(taskId, version, verified, note, { rework })`。

```json
{
  "task_id": "<数据库任务 ID>",
  "version": 1,
  "verified": false,
  "note": "缺少引用依据，打回重做",
  "rework": true
}
```

`version` 是正安全整数，必须匹配已完成任务当前事实的版本（重试后的版本可能大于 1）。`verified` 必须是布尔值；`note` 必填，去首尾空白后非空，原始长度不超过 4000 字符。当 `verified: false` 且 `rework: true` 时（要求尚无已派发或已完成的下游依赖任务），任务将根据剩余 `max_attempts` 重新入队（附带历史版本与 `review_note` 构成的 `prior_facts`）或转为 `failed` 并级联触发下游失败。成功返回 `{ "accepted": true, "fact": { ... }, "reworked"?: boolean, "task_status"?: string }`；未知任务、缺失事实或版本不匹配返回 `{ "accepted": false }`，不产生审计事件；非法输入返回 400。

每次成功调用追加 `fact_reviewed` 事件，标明版本、核验结果、意见和 `source: "operator"`。重复调用会再次记录核验，不是幂等审计接口。框架使用共享管理端凭据，不识别具体审核人。

在下游任务中设置 `require_verified_facts: true`，等待所有直接依赖的当前版本核验通过再领取。省略或 `false` 保持原行为；其他类型被拒绝。撤回核验用 `verified: false`；不会回滚已领取任务。`facts` 还包含 `review_note`、`reviewed_at`（未核验时均为 null）。

### `POST /api/cancel`

```json
{ "task_id": "<数据库任务 ID>" }
```

```json
{ "ok": true }
```

取消后拒绝成功回执，但不能撤销外部副作用。运行中尝试会占用额度，直到确认停止或租约过期。

### `POST /api/workers/enable`

```json
{ "agent_id": "worker-id", "enabled": false }
```

```json
{ "ok": true }
```

暂停新领取，不取消已运行尝试。`enabled` 必须是布尔值。

### `POST /api/planner/submit`（自然语言自动编排与投递）

需管理端 Bearer 凭据。读取调度器当前能力目录（`capabilities`）与有效组织记忆（`memory`），将自然语言目标 `goal` 自动编译为满足输入契约与命名空间门禁的 DAG 并持久化入队：

```json
{
  "goal": "Research solid-state electrolyte breakthroughs and compose executive summary",
  "request_id": "req-goal-1",
  "trace_id": "trace.goal.1",
  "fact_key": "org.electrolyte.summary",
  "budget": { "max_tokens": 2000, "max_cost_usd": 0.05 }
}
```

成功返回 `201` 及 `{ "request_id", "goal", "plan", "ids" }`。

### `POST /api/triggers` 与 `POST /api/triggers/fire`（定时与事件触发器）

注册或更新周期性（`cron` 5 字段表达式或 `interval_seconds` 秒级间隔）或外部事件（`webhook: true`）触发器，在 `scheduler.tick()` 时自动触发或通过 `/api/triggers/fire` 注入外部 `payload` 触发认知保鲜任务图：

```json
{
  "trigger_id": "hourly-memory-refresh",
  "description": "每小时刷新行业核心事实记忆",
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

手动或 Webhook 触发 `POST /api/triggers/fire`：

```json
{
  "trigger_id": "hourly-memory-refresh",
  "payload": { "source": "github-Release-webhook" }
}
```

### `POST /internal/register`

注册或续期实例租约。已有 `agent_id` 不能改能力。

```json
{ "agent_id": "worker-normalize-1", "capability": "text.normalize" }
```

```json
{ "ok": true }
```

### `POST /internal/claim`

续期实例租约。可选传 `wait_ms`（$0 \sim 30000$ 毫秒），当队列为空时通过内部事件总线挂起等待，一旦有新任务提交、动态扩展、上游完成或核验放行即刻零延迟唤醒领取。返回 `{ "task": null }` 或任务对象。

领取到的任务除原字段外还包括 `call_id`、`attempt_id`、`attempt`、`deadline`、依赖 `facts`、重做时的 `prior_facts`（含历史 `review_note`）以及跨请求组织记忆 `context_facts`。事实含 `task_id`、`agent_id`、`version`、`value`、`verified`。

`attempt` 与 `attempts` 均为本次领取后的尝试次数；`lease_until` 是本次尝试的实际租约。有效心跳会在同一事务内同步任务与尝试的租约，不超过 `deadline`，不会改写任务的 `updated_at`。

通过库 API 提交时，能力名必须是字符串；任务输入经过 JSON 序列化后仍必须是对象。顶层 `Date` 或返回字符串、数组、null 的 `toJSON()` 不符合任务输入契约。

### `POST /internal/heartbeat`

可传 `call_id`。响应：`{ "ok": true, "valid": boolean, "enabled": boolean }`。

- 只有当前运行中的尝试 `valid` 才为 true。
- 不带尝试的心跳 `valid` 为 false。
- `valid` 变为 false 时，Worker 必须停止处理函数。

### `POST /internal/result`

必须有 `call_id`，以及 JSON `result` 或 `error` 之一，可选上报 `usage: { input_tokens, output_tokens, total_tokens, cost_usd }`（若超出请求 `plan.budget` 则自动熔断剩余排队任务，状态置为 `budget_exceeded`；若能力声明了 `required_output_fields` 且产出缺失必填字段，尝试将被记为 `output_contract_violation`）。

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

已完成或已过期尝试返回 `{ "accepted": false, "duplicate": true }` 或 `{ "accepted": false }`。取消之后的成功回执不会生效。

### `POST /internal/review`

仅绑定了 `verifier: true` 能力的已注册独立裁判 Worker 可调用（严禁核验该 Worker 自己产出的事实），支持可选 `rework`、`confidence`（$0 \sim 1$）与 `ttl_seconds`：

```json
{
  "agent_id": "worker-verify-1",
  "capability": "fact.verify",
  "task_id": "<数据库任务 ID>",
  "version": 1,
  "verified": true,
  "confidence": 0.98,
  "note": "独立裁判核验通过"
}
```

## 错误

Worker 会在发送前检查结果能否 JSON 序列化。处理函数失败回报 `handler_failed`；已取消或已过期的任务不会开始调用处理函数。直接调用 `worker.execute()` 时，回执通信失败会抛出异常；`worker.run()` 会捕获并重新注册，不将成功执行改报为处理失败。

| 状态码 | `error`                | 场景                                           |
| ------ | ---------------------- | ---------------------------------------------- |
| 400    | `request_rejected`     | 校验或调度拒绝；内部异常正文不会返回           |
| 400    | `invalid_agent`        | Worker `agent_id` 不符合 `/^[\w-]{4,100}$/`    |
| 400    | `result_required`      | 回执既没有 `result` 也没有 `error`             |
| 400    | `invalid_worker_state` | `enabled` 不是布尔值，或 `agent_id` 不是字符串 |
| 401    | `unauthorized`         | 缺少或错误 Bearer，或能力与 Token 不匹配       |
| 404    | `not_found`            | 未知路径                                       |
| 405    | `method_not_allowed`   | `/internal/*` 不是 POST                        |
| 503    | `storage_unavailable`  | PostgreSQL 驱动错误码                          |

`POST /api/tasks` 与 `POST /api/tasks/expand` 成功时是 **201**。部分畸形 JSON 也会变成 `request_rejected`，HTTP 层不会泄露解析细节。

## 库 API

### `new Scheduler(pgConfig, options)`

`pgConfig` 传给 `pg.Pool`，一般是 `{ connectionString }`。

`options`：`schema`、`lease`、`deadline`、`capabilities`（可含 `verifier`、`required_input_fields`、`required_output_fields`、`allowed_context_prefixes`）、`capacity`、`maxAttempts`、`maxConsecutiveFailures`。

| 方法                                                                            | 作用                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `init()`                                                                        | 创建 schema、执行 SQL、写入目录和配额                 |
| `submit(requestId, plan)`                                                       | 持久化 DAG（支持可选 `budget`/`trace_id`）；`{ids}`   |
| `expand(requestId, expansionId, parentTaskId, plan, opts?)`                     | 在父任务下动态追加子图；`{ ids }`                     |
| `forkRequest(sourceRequestId, newRequestId, opts?)`                             | 状态时间旅行分叉重放（复用上游已完成事实，重跑下游）  |
| `register(id, capability)`                                                      | 注册或续期；`{ ok }`                                  |
| `claim(id, capability, { waitMs }?)`                                            | `{ task }` 或 `{ task: null }`（支持声誉门禁/长轮询） |
| `heartbeat(id, capability, callId?)`                                            | `{ ok, valid, enabled }`                              |
| `result(id, capability, callId, result, error, usage?)`                         | `{ accepted, duplicate?, contract_violation? }`       |
| `reviewFact(taskId, version, verified, note, opts?)`                            | 管理端核验任务当前事实版本或打回重做                  |
| `reviewFactByVerifier(id, capability, taskId, version, verified, note, opts?)`  | 独立裁判 Worker 核验任务当前事实版本（禁止自审）      |
| `searchMemory(query, { prefix, minConfidence, limit }?)`                        | 按关键词与命名空间前缀检索有效跨周期组织记忆          |
| `rollbackFact(factKey, { note }?)`                                              | 一键时光回滚指定 `fact_key` 至上一已核验历史版本      |
| `crystallizePlaybook(playbookId, { sourceRequestId, description, tags, plan })` | 技能结晶：固化已验证请求图（含动态扩展子图）为 SOP    |
| `listPlaybooks()` / `runPlaybook(playbookId, requestId?, opts?)`                | 查询或一键实例化复现组织技能模板（Playbooks）         |
| `deletePlaybook(playbookId)`                                                    | 删除指定的组织技能模板                                |
| `exportBundle()` / `importBundle(bundle)`                                       | 导出/导入可迁移的组织认知资产包（记忆+触发器+技能库） |
| `cancel(taskId)`                                                                | `{ ok }`                                              |
| `enable(id, enabled)`                                                           | `{ ok }`（重新启用时重置 `consecutive_failures`）     |
| `upsertTrigger(triggerId, spec)`                                                | 注册或更新 Cron/间隔/Webhook 触发器                   |
| `fireTrigger(triggerId, { payload, source }?)`                                  | 手动或通过 Webhook 触发周期性认知保鲜计划             |
| `tick()`                                                                        | 回收过期尝试、过期 Worker，并自动触发到期触发器       |
| `snapshot()`                                                                    | 近期运行状态（含 `triggers` 与 `playbooks`）          |
| `telemetry()`                                                                   | 能力画像、Worker 健康度、成本、记忆、触发器与技能模板 |
| `close()`                                                                       | 关闭连接池                                            |

不要在模型或网络调用期间持有调度事务。`tx()` 是内部方法，每次变更已经包在短事务里。

### `new Planner(options)`（自然语言目标自动编排器）

支持将自然语言目标根据 `capabilities` 目录与有效 `memory` 编译为通过契约校验的 DAG 计划（可配置 `apiKey` / `endpoint` / `model` 调用兼容 OpenAI JSON 模式的推理服务，或使用确定性离线感知规划器）：

- `planner.plan(goal, { requestId, capabilities, memory, traceId, budget, factKey })`：生成并校验 DAG 计划。
- `planner.submitGoal(scheduler, goal, options)`：结合调度器实时 `telemetry()` 将自然语言目标直接编译并提交入队。
- `planner.expandFromFact(scheduler, { requestId, parentTaskId, fact, goal })`：根据父任务产出动态生成并扩展子任务图（`expand`）。

### `createLlmWorkerHandler(options)` 与 `createMcpToolHandler(options)`（模型与 MCP 适配器）

标准化的 Worker 处理函数构造器（自动注入上游 `facts`、重做 `prior_facts` 的 `review_note` 以及跨周期 `context_facts`，自动回传 FinOps `usage`）：

- `createLlmWorkerHandler({ endpoint, apiKey, model, systemPrompt, costPerInputToken, costPerOutputToken })`：对接 OpenAI 兼容 Chat Completions 接口，返回 `{ result, usage }`。
- `createMcpToolHandler({ client, toolName, mapInput, formatOutput })`：对接 MCP Client（`callTool`）或 JSON-RPC MCP HTTP 端点。

### `new Worker(options)`

必填：`url`、`token`、`capability`、`handler`。

可选：`id`（默认 `worker-<uuid>`）、`pollMs`（1000）、`heartbeatMs`（10000）、`requestTimeoutMs`（5000）。心跳和请求超时都应明显短于调度器租约。

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

处理函数规则：

- 必须返回 JSON，不能返回 `undefined`、循环引用或 `BigInt`。
- 必须响应 `signal`，配合协作取消。
- 外部写入必须按稳定的数据库 `task_id` 做幂等；`attempt_id` / `call_id` 只用于追踪。
- 只能看到显式依赖事实，不会拿到其他 Agent 的私有上下文。
- 若处理函数去抓 URL，部署方必须自己做白名单，示例不能当授权。

`run()` 在通信失败后会重新注册。离线实例靠租约回收，没有专门的登出接口。

### `createRegistryServer(scheduler, { operatorToken, workerTokens, planner })`

返回未监听的 `http.Server`。调用方负责 listen/close 以及 Scheduler 生命周期。

### `validatePlan(requestId, plan)` / `validateCapabilities(capabilities)` / `validateTriggerSpec(triggerId, spec)`

`Scheduler` 使用的纯函数。规划器可以在提交前先调用。

### RRSI / Harness² 自进化与双层记忆接口（`v1.5`）

- `await scheduler.getGenome()` / `GET /api/harness/genome`：获取当前生效的 `HarnessGenome`（含 `planner_prompts`、`adapter_prompts`、`memory_config`、`expansion_config` 及相对于默认基线的变更表面列表）。
- `await scheduler.updateGenome(candidate, options)` & `await scheduler.evolveGenome(candidate, options)` / `POST /api/harness/genome`：执行带安全边界保护、反作弊审查、按轮退火编辑预算、双通道成本感知验收门与消融剪枝的基因组更新/进化。
- `await scheduler.evolvePlaybook(playbookId, options)` / `POST /api/playbooks/evolve`：在 RRSI 反过拟合 Critic 与双通道成本感知验收门下进化组织技能 Playbook。
- `await scheduler.getHarnessLedger({ limit })` / `GET /api/harness/ledger`：查询结构化进化实验账本与停滞自动转向推荐表面（`recommended_focus_surface`）。
- `await scheduler.calibrateHarness({ tasks, rounds })` / `POST /api/harness/calibrate`：基于 Jeffreys 平滑方差与样本成本方差计算单臂噪声下限（$\delta_{\text{pass}}$、$\delta_{\text{cost}}$、$\delta_{\text{tokens}}$）。
- `await scheduler.compareHarnessArms(armA, armB, options)` / `POST /api/harness/compare`：双臂逐题配对统计检验（精确 McNemar 检验 + 2000 次固定种子按题配对 Bootstrap 95% CI 主指标 `cost_per_resolved` 比值 $B / A$ + 解决率非劣效护栏）。
- `await scheduler.promoteMemoryInvariant(namespace, options)` / `POST /api/memory/promote-invariant`：提炼或刷新指定命名空间的模块级不变量（`[Module Invariant: <namespace>]`），并将该命名空间下的单题情景记忆裁剪至 `max_episodic_per_namespace` 上限。

## 部署及限制

默认监听回环地址。跨机器时应前置 TLS 和访问限制。

管理端拥有整个 schema 的权限，没有租户或终端用户层。

同一 schema 的状态写入串行化，优先保证一致性，不是高吞吐横向扩展设计。

执行语义是**至少一次**。网络中断或租约过期可能导致旧处理函数与新尝试重叠，外部系统必须按稳定任务 ID 做幂等或隔离。

`examples/workflow.mjs` 与 `examples/ui-demo.mjs` 开箱即用，无需外部模型密钥。

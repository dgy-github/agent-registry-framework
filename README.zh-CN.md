# Agent Registry Framework

面向多智能体系统的通用、可持久化注册与执行底座。

Worker 主动注册，调度器发现能力，PostgreSQL 中的任务图负责租约执行。核心不包含电商模型、提示词、页面或特定厂商 SDK。

[English](README.md) · [中文架构](docs/architecture.zh-CN.md) · [中文 API](docs/api.zh-CN.md) · [Architecture](docs/architecture.en.md) · [API](docs/api.en.md)

## 它是什么

```mermaid
flowchart TB
  subgraph Entry["接入与触发层 (Ingress & Triggers)"]
    Operator["管理端 / Web 控制台<br/>Operator Token"]
    Cron["Cron / Webhook 触发器<br/>Triggers"]
    NLPlanner["自然语言编排器<br/>LLM Planner"]
    SOP["技能模板库<br/>Crystallized Playbooks"]
  end

  subgraph Core["内核调度与治理层 (Scheduler & RRSI Harness)"]
    HTTP["HTTP 信任边界 & SSE 实时流"]
    Val["DAG 拓扑 / 契约 / 预算校验"]
    SM["租约状态机 & 声誉/置信度门禁"]
    MemEngine["Harness² 双层记忆引擎<br/>(Invariant + Episodic)"]
    RRSI["RRSI 正则化自进化引擎<br/>(P0 校准 / P1 双通道门控 / P2 Genome)"]
  end

  subgraph Fleet["执行与核验群组 (Leased Worker Cohort)"]
    WorkerA["业务 / LLM / MCP Worker<br/>按能力鉴权 + call_id 围栏"]
    Verifier["独立裁判 Verifier Worker<br/>禁止自审 + 60分重做闭环"]
  end

  subgraph Storage["持久化事实源 (PostgreSQL Schema)"]
    PG_Tasks[("agent_requests / tasks<br/>attempts / expansions")]
    PG_Mem[("shared_facts / playbooks<br/>双层记忆 & Beta 权重")]
    PG_Harness[("agent_harness_genome<br/>agent_harness_ledger")]
  end

  Operator --> HTTP
  Cron --> SM
  NLPlanner --> Val
  SOP --> Val
  HTTP --> Val --> SM
  SM <--> MemEngine
  SM <--> RRSI
  WorkerA <-->|"注册 / 长轮询领取 / 心跳 / 回执"| HTTP
  Verifier <-->|"独立核验 / 驳回重做 (rework)"| HTTP
  SM --> PG_Tasks
  MemEngine --> PG_Mem
  RRSI --> PG_Harness
```

调度器只保存编排状态：能力目录、Worker、任务图、尝试、租约、配额、事件、双层共享事实、技能结晶模板（Playbooks）与自进化基因组账本（Harness Genome & Ledger）。

业务适配层负责身份、真实数据、外部副作用和幂等。模型输出不能代替授权判断。

## 它不是什么

- 不是特定厂商绑定的 Agent 黑盒（核心调度不依赖特定模型 SDK，同时提供可选的 `Planner` 与标准 `LLM`/`MCP` 适配器）。
- 不是多租户或终端用户鉴权层。
- 不是恰好一次执行，语义是**至少一次**。

## 提供什么

- 声明式能力目录（支持输入/输出必填字段契约、`allowed_context_prefixes` 记忆命名空间沙箱与独立 `verifier` 裁判权限）与严格的有向无环任务图校验。
- 持久化注册、租约、心跳、有限重试、取消、配额、优先级抢占（`priority`）、声誉门禁调度（`min_worker_pass_rate` 含冷启动保护）、请求级 Token/成本预算熔断（`budget`）和事件驱动长轮询唤醒（`waitMs`）。
- 按依赖派发、运行中动态子图扩展（`expand`）与状态分叉重放（`forkRequest` 时间旅行断点重跑）；共享事实带版本；迟到回执按 `call_id` 隔离。
- 依赖事实核验门禁、最低置信度门禁（`min_fact_confidence`）、管理端与独立 Verifier Agent 核验（禁止自审）、核验驳回自动重做（`rework` 附带 `prior_facts`）。
- 三层组织记忆体系与 Harness² 双层记忆结构化：
  - **语义记忆（双层架构 `invariant` vs `episodic`）**：跨请求事实沉淀（`fact_key`）、静态订阅（`context_keys`）、动态检索注入（`context_query`）、全文检索（`searchMemory`）、TTL 过期淘汰與一键版本回滚（`rollbackFact`）；当同一模块命名空间（如 `org.policy.*`）经核验累计达到 `>= 2` 条事实后，自动合并提炼**模块级不变量（`[Module Invariant: <namespace>]`）**（享有 `+6` 召回结构加权与原地更新保留 Beta 权重），并将该模块名下旧单题情景记忆自动裁剪封顶至 `max_episodic_per_namespace = 2` 条，同时对高消耗轮次执行**搭便车记忆归因打折**。
  - **程序性记忆（技能结晶）**：将跑通的请求图（含动态扩展子图）固化为可版本化复用的标准作业程序（`crystallizePlaybook` / `runPlaybook` / `evolvePlaybook`）。
  - **组织资产包迁移**：一键导出/导入能力契约、已核验记忆、触发器、技能模板与 `HarnessGenome`（`exportBundle` / `importBundle`）。
- **Google RRSI / ReSelf & Harness² 自进化正则化引擎（[`src/harness.mjs`](src/harness.mjs)）**：
  - **P0 噪声校准与配对统计评测**：单臂噪声下限校准（`calibrateHarness`，Jeffreys 平滑方差求 $\delta_{\text{pass}}$、样本方差求 $\delta_{\text{cost}}$）与双臂逐题配对检验（`compareHarnessArms`，精确 McNemar 检验 + 2000 次按题配对 Bootstrap 95% CI 主指标 `cost_per_resolved` 比值 `B / A` + 非劣效护栏）。
  - **P1 RRSI 进化正则化**：表面级按轮退火编辑预算（`changedGenomeSurfaces` / `changedGenomeLines` 及 `expand` 动态扩展退火上限）、规则版反过拟合/反作弊审查器（`criticCheckCandidate`）、结构化证伪实验账本（`agent_harness_ledger` 自动向 `Planner` 注入被拒历史并支持停滞自动转向 `pickStagnationSurface`）、双通道成本感知验收门与盘后消融剪枝（`evolveGenome` / `evolvePlaybook`）。
  - **P2 多表面受控基因组（`HarnessGenome`）**：统一纳管 `planner_prompts`、`adapter_prompts`、`memory_config`（默认 `6 条 / 2400 字符` 召回上限）与 `expansion_config`，强制冻结安全边界并保证空配置 100% 字节级 No-op 等价。
- 自然语言自动编排器（`Planner`）、标准模型/MCP 工具 Worker 适配器（`createLlmWorkerHandler` / `createMcpToolHandler`）与 Cron/Webhook 定时事件触发器（`upsertTrigger` / `fireTrigger`）。
- 零外部依赖的内置 **AIOS Web 控制台（`GET /` + `GET /api/events` SSE 实时流）**。

## 核心工作流与自进化机制图解

### 1. 任务执行、60分奇点核验重做与动态扩展时序

```mermaid
sequenceDiagram
  autonumber
  actor Op as 管理端 / Planner
  participant Sch as 调度器 (PostgreSQL)
  participant Wk as 执行 Worker (LLM/MCP)
  participant Ver as 独立 Verifier Worker

  Op->>Sch: submit(request_id, DAG plan, budget)
  Sch->>Sch: 拓扑校验 + 能力契约校验 + 入队 (queued)
  Wk->>Sch: claim(capability, waitMs)
  Sch->>Sch: 声誉门禁检查 + 召回双层记忆 (<=6条/2400字符)
  Sch-->>Wk: 签发租约 (call_id, dependency_facts, context_facts)
  opt 运行中动态子图扩展 (受退火预算约束)
    Wk->>Sch: expand(parent_task_id, sub_tasks, rewireDependents)
    Sch-->>Wk: 幂等挂载子 DAG 并重连下游依赖
  end
  Wk->>Sch: complete(call_id, output, usage)
  Sch->>Sch: 写入 shared_facts (verified=false) + 成本归因
  Ver->>Sch: reviewFactByVerifier(task_id, verified=false, rework=true, note)
  Sch->>Sch: 触发重做 (rework_triggered)，重新入队并附带 prior_facts
  Wk->>Sch: 再次 claim (读取上次驳回意见 review_note)
  Wk->>Sch: complete(call_id, 修正后 output)
  Ver->>Sch: reviewFactByVerifier(task_id, verified=true, confidence=0.95)
  Sch->>Sch: 解锁下游 require_verified_facts 任务 + 触发双层记忆提炼
  Op->>Sch: crystallizePlaybook(request_id) 固化为可复用 SOP
```

### 2. Google RRSI / ReSelf 正则化自进化闭环

```mermaid
flowchart TD
  Start["启动自进化提案<br/>evolveGenome / evolvePlaybook"] --> Stagnation{"连续 >= 2 轮未晋升?"}
  Stagnation -->|"是"| Redirect["停滞表面旋转 (pickStagnationSurface)<br/>切换至探索最少的 Genome 表面"]
  Stagnation -->|"否"| Budget["计算按轮退火编辑预算<br/>max_surfaces = max(1, B0 - floor(r/2))"]
  Redirect --> Budget
  Budget --> Critic{"反过拟合静态审查<br/>(criticCheckCandidate)"}
  Critic -->|"命中 task_id / check.py / bypass"| RejectCritic["拦截并写入证伪账本<br/>(rejected_critic)"]
  Critic -->|"通过"| EvalP0["P0 噪声校准与双臂配对统计<br/>calibrateHarness + compareHarnessArms<br/>(McNemar + 2000x Paired Bootstrap)"]
  EvalP0 --> Holdout{"Holdout 集非回退检查"}
  Holdout -->|"出现净回退"| RejectHoldout["拦截并记入证伪账本<br/>(rejected_holdout_regression)"]
  Holdout -->|"无回退"| DualGate{"P1 双通道成本感知门控<br/>(evaluateDualChannelGate)"}
  DualGate -->|"通道 1: 解决率提升 > delta_pass<br/>且未触发 Token 膨胀 (>10% 涨耗/<2% 提质)"| Ablation["多表面留一法消融剪枝<br/>剔除零贡献搭便车改动"]
  DualGate -->|"通道 2: 解决率非劣效 (>= -delta_pass)<br/>且单题成本显著下降 (>=15% 或 CI<1.0)"| Ablation
  DualGate -->|"未达标 / Token 膨胀"| RejectGate["拦截并向 Planner 注入被拒历史<br/>(rejected_no_significant_gain / bloat)"]
  Ablation --> Promote["晋升新版本 Genome / Playbook<br/>持久化至 agent_harness_genome & ledger"]
```

### 3. Harness² 双层组织记忆与防毒化归因流转

```mermaid
flowchart LR
  subgraph Produce["1. 产出与裁判门禁"]
    Out["任务完成输出<br/>fact_key = org.policy.refund"] --> VerGate{"管理端 / Verifier<br/>核验通过 (verified=true)?"}
  end

  subgraph Tiering["2. 双层记忆结构化 (Invariant vs Episodic)"]
    VerGate -->|"是"| EpStore["写入情景记忆 (episodic)<br/>单命名空间保留最新 <= 2 条"]
    EpStore --> CountCheck{"同命名空间已核验<br/>情景事实 >= 2 条?"}
    CountCheck -->|"是"| Synth["自动提炼模块不变量<br/>[Module Invariant: org.policy]<br/>原地更新保留 Beta 历史权重"]
  end

  subgraph Recall["3. 硬预算优先召回"]
    Synth -->|"+6 结构性加权"| BudgetRecall["动态召回 (_claimOnce)<br/>硬上限: 6 条 / 2400 字符<br/>injected_count + 1"]
    EpStore -->|"常规检索权重"| BudgetRecall
  end

  subgraph Attribution["4. 成本感知 Beta 反馈与反毒化"]
    BudgetRecall --> TurnCost{"任务完成 Token 消耗<br/>> expensive_token_threshold?"}
    TurnCost -->|"低消耗常规轮次"| AcceptAll["全部召回记忆<br/>accepted_count + 1"]
    TurnCost -->|"高消耗昂贵轮次"| FreeRider["防搭便车过滤:<br/>仅显式引用/同域记忆 accepted + 1"]
    AcceptAll --> DemoteCheck{"injected >= 8 且<br/>平滑接受率 p < 0.25?"}
    FreeRider --> DemoteCheck
    DemoteCheck -->|"是"| Demote["自动降级隔离 (demoted = true)<br/>移出默认检索池"]
  end
```

## 运行要求

- Node.js 22+
- PostgreSQL 14+

## 快速开始

### 方式一：一键体验 Web 控制台交互沙盒（内置嵌入式 PostgreSQL，免手工建库）

```powershell
npm install
npm run demo:ui
```

启动后在浏览器打开终端输出的自动登录链接（默认 `http://127.0.0.1:8766/#token=...`），即可交互式体验可视化 DAG 拓扑、60 分奇点核验重做、声誉门禁、时间旅行分叉重跑、记忆回滚、技能结晶（Playbooks）与 AI 自动编排。

### 方式二：生产标准启动

1. 安装依赖并复制示例配置。

```powershell
npm install
Copy-Item .\registry.example.json .\registry.json
```

Bash:

```bash
npm install
cp registry.example.json registry.json
```

2. 准备数据库并设置环境变量。凭据必须互不相同、随机生成，且不少于 24 字符。程序**不会**隐式加载 `.env`；只有你自己的工具会读取 [`.env.example`](.env.example)。

PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://registry:password@127.0.0.1:5432/registry'
$env:REGISTRY_CONFIG = 'registry.json'
node --input-type=module -e "import {randomBytes} from 'node:crypto'; for (const n of ['REGISTRY_OPERATOR_TOKEN','NORMALIZE_WORKER_TOKEN','SUMMARIZE_WORKER_TOKEN']) console.log(n+'='+randomBytes(32).toString('hex'))"
# 把三行输出写成 $env:NAME = '...' 后再启动：
npm start
```

Bash:

```bash
export DATABASE_URL=postgresql://registry:password@127.0.0.1:5432/registry
export REGISTRY_CONFIG=registry.json
node --input-type=module -e "import {randomBytes} from 'node:crypto'; for (const n of ['REGISTRY_OPERATOR_TOKEN','NORMALIZE_WORKER_TOKEN','SUMMARIZE_WORKER_TOKEN']) console.log('export '+n+'='+randomBytes(32).toString('hex'))"
# 粘贴三行 export 后：
npm start
```

默认监听 `127.0.0.1:8766`，启动成功会打印 `Agent registry listening`。

3. 另开一个终端，使用**同一组**三个 Token 运行示例：

```powershell
$env:REGISTRY_URL = 'http://127.0.0.1:8766'
$env:REGISTRY_OPERATOR_TOKEN = '...'
$env:NORMALIZE_WORKER_TOKEN = '...'
$env:SUMMARIZE_WORKER_TOKEN = '...'
npm run demo
```

示例会注册两个 Worker，执行 `text.normalize` → `text.summarize` 两节点任务图。成功时 JSON 里的 `text` 为 `HELLO AGENTS`。

生产部署、安全边界、故障恢复和扩展规则见 [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md)。配置项、HTTP 和库方法见 [docs/api.zh-CN.md](docs/api.zh-CN.md)。

## 库 API

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

- `Scheduler` 保存注册、任务、记忆、触发器与技能模板状态。先调用一次 `init()` 创建 schema，再定期调用 `tick()`。
- `Worker` 调用你提供的 `handler(task, { signal, reportUsage })`。处理函数必须响应取消，并对外部写入自行保证幂等。
- `Planner` 根据能力目录与组织记忆将自然语言目标编译为合法的 DAG 计划或运行中子图扩展。
- `createRegistryServer` 提供管理端、Worker HTTP 接口以及 Web 控制台。返回未监听的 `http.Server`，由调用方负责 `listen` / `close`。

## 目录说明

| 路径                    | 作用                                               |
| ----------------------- | -------------------------------------------------- |
| `src/scheduler.mjs`     | 持久化状态机、记忆账本、分叉、技能结晶与事务       |
| `src/scheduler.sql`     | 框架自己的数据表与索引                             |
| `src/validation.mjs`    | 能力目录与任务图校验                               |
| `src/planner.mjs`       | 自然语言目标 → DAG 计划自动编排器                  |
| `src/adapters.mjs`      | 标准大模型（LLM）与 MCP 工具 Worker 适配器         |
| `src/triggers.mjs`      | Cron 表达式解析与定时/Webhook 触发器校验           |
| `src/harness.mjs`       | RRSI / Harness² 自进化正则化、基因组与配对统计引擎 |
| `src/ui.mjs`            | 零外部依赖的 AIOS Web 控制台（单页应用）           |
| `src/server.mjs`        | HTTP 信任边界与 SSE 实时推送                       |
| `src/worker.mjs`        | 支持事件长轮询与用量上报的拉取式 Worker            |
| `src/cli.mjs`           | 进程入口：读配置、监听、tick、退出                 |
| `examples/workflow.mjs` | 与业务无关的双 Worker 命令行示例                   |
| `examples/ui-demo.mjs`  | 一键启动的 Web 控制台全特性交互式沙盒              |
| `docs/`                 | 中英文架构与 API 文档                              |

## 验证

```powershell
npm test
$env:TEST_DATABASE_URL = 'postgresql://postgres:password@127.0.0.1:5432/registry_test'
npm run test:integration
npm run format:check
```

`npm test` 覆盖校验和 HTTP 鉴权。集成测试需要 PostgreSQL，覆盖并发领取、迟到回执隔离、重试、取消、重启恢复、配额隔离、核验重做、动态扩展、声誉门禁、记忆回滚、时间旅行分叉、技能结晶与 HTTP Worker 端到端流程。

## 许可证

Apache-2.0，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

# API 与使用说明

## 配置

复制 `registry.example.json` 为部署配置，通过 `REGISTRY_CONFIG` 指定路径。能力项包含唯一 `name`、`description` 和指定凭据环境变量名的 `tokenEnv`。凭据必须互不相同且不少于 24 字符，应随机生成，不要使用示例词语。`DATABASE_URL` 指定 PostgreSQL 连接串；`REGISTRY_OPERATOR_TOKEN` 是管理端凭据。程序不会隐式加载 `.env` 文件。

`schema` 默认 `agent_registry`；`lease`（90）与 `deadline`（180）单位为秒；`capacity`（2）限制全局运行中尝试数量；`maxAttempts`（2）包含首次执行。每个 Worker 最多执行一个尝试。多个调度进程应使用一致配置。初始化只添加或更新能力，不删除历史能力；删除配置项不会撤销数据库中已有能力，应撤销凭据、清空相关任务后再显式管理目录。

PowerShell 用 `$env:DATABASE_URL='postgresql://...'`、`$env:REGISTRY_CONFIG='registry.json'` 设置变量；三个 Token 也用同样方式设置，再运行 `npm start`。服务和示例所在终端必须使用相同凭据。没有 OpenSSL 时可用 `node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"` 生成随机值。

## HTTP

请求体为 JSON，最大 1 MB。管理接口需要 `Authorization: Bearer <管理凭据>`；Worker 接口使用能力对应的凭据，每次请求都包含 `agent_id` 和 `capability`。同能力凭据代表一个互相信任的 Worker 群组，不隔离组内恶意实例。每个进程使用唯一实例 ID，不要并发复用 ID。

- `GET /health`：免鉴权的进程存活探针，不代表数据库就绪。
- `GET /api/state`：能力、实例、任务、尝试、事实、事件、配额。任务/事实/尝试最多返回最近 200 条，事件 150 条，不是完整历史导出接口。
- `POST /api/tasks`：`{ "request_id": "unique-request-id", "plan": { "tasks": [...] } }`，返回 `{ "ids": [...] }`。任务包含请求内 `id`、`capability`、JSON 对象 `input` 和可选 `dependencies`（其他任务的请求内 ID）。返回的是数据库任务 ID，事件中保留请求内 key。
- `POST /api/cancel`：`{ "task_id": "数据库任务 ID" }`，取消后拒绝成功回执，但不能撤销外部副作用。
- `POST /api/workers/enable`：`{ "agent_id": "worker-id", "enabled": false }`，暂停新领取，不取消已运行尝试。
- `POST /internal/register`：注册或续期实例，不允许同 ID 改变能力。
- `POST /internal/claim`：续期实例并返回 `{ "task": null }` 或含 `call_id`、`attempt_id`、`attempt`、`deadline`、依赖 `facts` 的任务。
- `POST /internal/heartbeat`：可传 `call_id`，返回尝试的 `valid` 和实例的 `enabled`。不指定尝试时 `valid: false`。
- `POST /internal/result`：传 `call_id` 及 JSON `result` 或 `error`，返回 `accepted`。已完成或已过期尝试拒绝重复回执。

错误类别为 400 `request_rejected`、401 `unauthorized`、404 `not_found` 或 503 `storage_unavailable`。部分格式错误返回更具体的 400 类别，不暴露内部异常正文。

## Worker 处理函数

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

真实业务中需要校验 URL 白名单及访问权限。任务只携带显式依赖事实，不会共享所有 Agent 私有上下文。事实含来源 Agent、任务、版本和 `verified: false`，执行成功不代表人工核验。处理函数必须返回 JSON，不能返回 `undefined`、循环引用或 BigInt。心跳和请求超时应明显短于租约；默认心跳 10 秒、请求超时 5 秒、轮询 1 秒，缩短租约时也要同步调整。

## 部署及限制

默认监听回环地址，跨机器部署时应提供 TLS 和访问限制。管理端具有整个 schema 权限，没有租户或终端用户鉴权层。每个 schema 的状态写入串行化，优先保证一致性，不是高吞吐横向扩展设计。执行语义是**至少一次**，不是恰好一次：网络中断或租约过期可能导致旧处理函数与新尝试重叠，外部系统应按稳定任务 ID 做幂等或隔离，尝试/调用 ID 用于追踪。协作取消要求处理函数响应 `signal`。

框架不启动模型 Agent、不创建 Worker 进程、不加载模型技能，也不提供 LLM 规划器。任何规划器或模型 SDK 都可以生成合法任务图，或在处理函数内运行。`examples/workflow.mjs` 是不需要模型密钥的确定性示例。

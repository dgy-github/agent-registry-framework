# Agent Registry Framework

**面向多智能体系统的通用、可持久化注册与执行底座。**

[English](README.md) · [中文架构设计](docs/architecture.zh-CN.md) · [English architecture](docs/architecture.en.md)

本仓库从多智能体电商系统中提炼出与业务无关的部分：Worker 主动注册，调度中心发现能力，PostgreSQL 中的持久化任务图负责租约执行。核心不包含电商模型、提示词、页面或特定厂商 SDK。

## 提供什么

- 声明式能力目录与严格的任务图校验。
- 持久化注册、租约、心跳、有限重试、取消、配额和过期实例回收。
- 按依赖派发任务，共享事实带版本，迟到回执通过调用编号隔离。
- 管理端与按能力隔离的 Worker 凭据。
- `Worker` 类自动处理注册、轮询、心跳、截止时间与回传。

调度器只负责编排状态；业务适配层负责身份、真实数据、外部副作用和幂等。模型输出不能代替授权判断。

## 快速开始

需要 Node.js 22+ 和 PostgreSQL 14+。

```bash
npm install
export DATABASE_URL=postgresql://registry:password@localhost/registry
export REGISTRY_OPERATOR_TOKEN=$(openssl rand -hex 32)
export NORMALIZE_WORKER_TOKEN=$(openssl rand -hex 32)
export SUMMARIZE_WORKER_TOKEN=$(openssl rand -hex 32)
cp registry.example.json registry.json
REGISTRY_CONFIG=registry.json npm start
```

在另一个终端运行通用示例：

```bash
REGISTRY_OPERATOR_TOKEN=... NORMALIZE_WORKER_TOKEN=... SUMMARIZE_WORKER_TOKEN=... npm run demo
```

示例会注册两个 Worker 并执行两节点任务图。生产部署、安全边界、故障恢复和扩展规则见 `docs/architecture.zh-CN.md`。

## 库 API

```js
import {Scheduler, Worker, createRegistryServer} from 'agent-registry-framework';
```

`Scheduler` 保存注册和任务状态；`Worker` 调用你提供的 `handler(task, {signal})`，处理函数必须响应取消且保证外部写入幂等；`createRegistryServer` 提供管理端和 Worker 接口。`scheduler.init()` 创建并管理框架自己的数据库表。

## 验证

```bash
npm test
TEST_DATABASE_URL=postgresql://... npm run test:integration
```

集成测试使用一次性 PostgreSQL schema，覆盖并发领取、迟到回执隔离、重试、取消、重启恢复、配额隔离及 HTTP Worker 端到端流程。

## 许可证

Apache-2.0，详见 [LICENSE](LICENSE)。

/** EN: Zero-dependency bilingual Operator Console UI served directly by the registry HTTP server.
 * 中文：由注册中心 HTTP 服务直接提供的零依赖中英双语管理控制台界面。
 */
export function renderConsoleHtml({ defaultToken = "" } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Registry Console · AIOS 调度与认知控制台</title>
  <style>
    :root {
      --bg: #0b0f19;
      --panel: #111827;
      --panel-alt: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --ok: #10b981;
      --warn: #f59e0b;
      --err: #ef4444;
      --purple: #a855f7;
      --font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      font-size: 14px;
      line-height: 1.5;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 24px;
      background: rgba(17, 24, 39, 0.92);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 20;
      backdrop-filter: blur(8px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--accent), var(--purple));
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #fff;
      font-size: 16px;
    }
    .brand h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    .brand p {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    input, select, textarea, button {
      font-family: inherit;
      font-size: 13px;
      color: var(--text);
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    button {
      cursor: pointer;
      font-weight: 600;
      background: var(--accent-hover);
      border-color: transparent;
      transition: opacity 0.15s, background 0.15s;
    }
    button:hover { opacity: 0.92; }
    button.secondary {
      background: var(--panel-alt);
      border-color: var(--border);
    }
    button.success { background: #059669; }
    button.danger { background: #dc2626; }
    button.warn { background: #d97706; }
    .status-dot {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
    }
    .dot.live { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
    .dot.err { background: var(--err); }
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 20px 24px 48px;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .kpi-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .kpi-label {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .kpi-value {
      font-size: 22px;
      font-weight: 700;
      font-family: var(--mono);
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
    }
    .tabs {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 18px;
      overflow-x: auto;
    }
    .tab-btn {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      padding: 10px 16px;
      color: var(--muted);
      font-weight: 600;
    }
    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .panel-title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 9px 10px;
      border-bottom: 1px solid rgba(51, 65, 85, 0.6);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    code, .mono {
      font-family: var(--mono);
      font-size: 12px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      font-family: var(--mono);
    }
    .badge.queued { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }
    .badge.running { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .badge.completed, .badge.verified, .badge.enabled { background: rgba(16, 185, 129, 0.18); color: #34d399; }
    .badge.failed, .badge.rejected, .badge.disabled { background: rgba(239, 68, 68, 0.18); color: #f87171; }
    .badge.cancelled { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }
    .badge.purple { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
    .split {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 16px;
    }
    @media (max-width: 1024px) {
      .split { grid-template-columns: 1fr; }
    }
    .dag-box {
      width: 100%;
      overflow-x: auto;
      background: #090d16;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      min-height: 280px;
    }
    pre {
      margin: 0;
      padding: 10px;
      background: #090d16;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow-x: auto;
      font-family: var(--mono);
      font-size: 12px;
      color: #e2e8f0;
      max-height: 260px;
    }
    .form-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 8px;
    }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 24px;
      padding: 10px 16px;
      border-radius: 8px;
      background: var(--panel-alt);
      border: 1px solid var(--accent);
      color: var(--text);
      font-size: 13px;
      z-index: 100;
      display: none;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo">AR</div>
      <div>
        <h1 data-i18n="title">Agent Registry Framework · AIOS 调度与认知控制台</h1>
        <p data-i18n="subtitle">任务 DAG 编排 · 60分奇点核验重做 · 节点复利画像 · 跨周期组织记忆 · FinOps 护栏</p>
      </div>
    </div>
    <div class="toolbar">
      <span class="status-dot">
        <span id="conn-dot" class="dot"></span>
        <span id="conn-text">未连接</span>
      </span>
      <input id="token-input" type="password" placeholder="Operator Bearer Token (≥24 chars)" style="width: 240px;" />
      <button id="connect-btn">连接 / 刷新</button>
      <button id="lang-btn" class="secondary">EN / 中文</button>
    </div>
  </header>

  <main>
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label" data-i18n="kpi_quota">全局并发配额 (Execution Quota)</div>
        <div class="kpi-value" id="kpi-quota">- / -</div>
        <div class="kpi-sub" id="kpi-quota-sub">运行中尝试 / 容积上限</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label" data-i18n="kpi_tasks">任务图状态分布 (DAG Tasks)</div>
        <div class="kpi-value" id="kpi-tasks">0</div>
        <div class="kpi-sub" id="kpi-tasks-sub">排队 0 · 运行 0 · 完成 0 · 失败 0</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label" data-i18n="kpi_workers">认知节点健康度 (Worker Fleet)</div>
        <div class="kpi-value" id="kpi-workers">0 / 0</div>
        <div class="kpi-sub" id="kpi-workers-sub">平均核验通过率: -</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label" data-i18n="kpi_memory">跨周期组织记忆 (Active Memory)</div>
        <div class="kpi-value" id="kpi-memory">0</div>
        <div class="kpi-sub" id="kpi-memory-sub">已核验且在有效期内的命名事实</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label" data-i18n="kpi_finops">FinOps 累计消耗 (Tokens & Cost)</div>
        <div class="kpi-value" id="kpi-finops">$0.0000</div>
        <div class="kpi-sub" id="kpi-finops-sub">0 tokens</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab-btn active" data-tab="tab-dag">1. 可视化 DAG 与动态扩展</button>
      <button class="tab-btn" data-tab="tab-review">2. 60分奇点·事实核验与重做台</button>
      <button class="tab-btn" data-tab="tab-telemetry">3. 能力契约与节点复利画像</button>
      <button class="tab-btn" data-tab="tab-memory">4. 组织记忆与 AI 自动编排器</button>
      <button class="tab-btn" data-tab="tab-triggers">5. 定时与事件触发器 (Cron/Webhook)</button>
      <button class="tab-btn" data-tab="tab-events">6. 全链路审计事件流</button>
    </div>

    <!-- TAB 1: DAG & Topology -->
    <section id="tab-dag" class="tab-pane active">
      <div class="split">
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">请求级拓扑图 (Interactive SVG DAG)</h2>
            <div class="form-row" style="margin-top:0">
              <label style="font-size:12px;color:var(--muted)">选择 Request:</label>
              <select id="request-select"></select>
            </div>
          </div>
          <div id="request-meta" style="font-size:12px;color:var(--muted);margin-bottom:10px;"></div>
          <div class="dag-box" id="dag-canvas"></div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">任务详情与动态干预 (Task Inspector)</h2>
          </div>
          <div id="task-inspector">
            <p style="color:var(--muted)">点击左侧 DAG 图或下方列表中的任意任务节点，查看输入/输出详情、执行取消（Cancel）或动态插入子任务图（Expand）。</p>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">近期任务列表 (Recent Tasks)</h2>
        </div>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>Task ID / Key</th>
                <th>Request / Trace</th>
                <th>Capability</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Confidence Gate</th>
                <th>Memory Keys</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="tasks-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 2: Fact Review & Rework Workbench -->
    <section id="tab-review" class="tab-pane">
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">版本化共享事实核验与打回重做工作台 (Shared Facts & HITL Review)</h2>
          <span style="font-size:12px;color:var(--muted)">支持对已完成任务的最新事实版本赋予置信度、通过核验，或携带意见打回上游重做 (Rework)</span>
        </div>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>Task ID / Fact Key</th>
                <th>Version</th>
                <th>Producer Agent</th>
                <th>Verified / Confidence</th>
                <th>Value (JSON)</th>
                <th>Review Note / Expiry</th>
                <th>Operator Decision (核验与重做)</th>
              </tr>
            </thead>
            <tbody id="facts-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 3: Telemetry & Worker Fleet -->
    <section id="tab-telemetry" class="tab-pane">
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">认知节点表现画像与隔离熔断控制 (Worker Fleet & Auto-Isolation)</h2>
        </div>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>Agent ID</th>
                <th>Capability</th>
                <th>State</th>
                <th>In-Flight</th>
                <th>Attempts (OK / Fail)</th>
                <th>Fact Pass Rate</th>
                <th>Consecutive Failures</th>
                <th>Avg Latency</th>
                <th>Tokens / Cost</th>
                <th>Control</th>
              </tr>
            </thead>
            <tbody id="workers-tbody"></tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">声明式能力目录与 Agent Card 契约 (Capabilities Catalog)</h2>
        </div>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>Capability</th>
                <th>Role</th>
                <th>Input / Output Contracts</th>
                <th>Allowed Context Prefixes</th>
                <th>Tasks (Q / R / C / F)</th>
                <th>Facts (Verified / Rejected)</th>
                <th>Total Tokens / Cost</th>
              </tr>
            </thead>
            <tbody id="caps-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 4: Organizational Memory & Planner / Submitter -->
    <section id="tab-memory" class="tab-pane">
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">✨ 自然语言自动编排器 (LLM Planner: Natural Language Goal → Validated DAG)</h2>
          <span style="font-size:12px;color:var(--muted)">自动读取当前能力目录契约与有效组织记忆，将自然语言目标编译为多阶段 DAG 并投递</span>
        </div>
        <div class="form-row">
          <input id="planner-goal-input" placeholder="输入自然语言目标，例如：提取最新欧盟电池碳足迹法规核心条款并结合组织记忆汇总报告" value="Extract key insights on autonomous supply chain resilience and synthesize executive brief" style="flex:1" />
          <input id="planner-fact-key" placeholder="可选沉淀 fact_key (如 org.supply.2026)" value="org.supply.2026" style="width:200px" />
          <input id="planner-min-rate" type="number" step="0.05" min="0.05" max="1" placeholder="声誉门禁 (如 0.8)" title="最低节点核验通过率门禁 (min_worker_pass_rate)" style="width:140px" />
          <button id="planner-submit-btn" class="success">✨ AI 自动拆解并投递 (POST /api/planner/submit)</button>
        </div>
      </div>

      <div class="split">
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">跨周期组织认知记忆账本 (Verified Organizational Memory)</h2>
            <div class="form-row" style="margin-top:0">
              <input id="memory-search-input" placeholder="检索记忆关键词 (如 battery / supply)..." style="width:190px" />
              <button class="secondary" id="export-bundle-btn">📦 导出资产包</button>
            </div>
          </div>
          <div style="overflow-x:auto">
            <table>
              <thead>
                <tr>
                  <th>Fact Key</th>
                  <th>Confidence</th>
                  <th>Producer / Version</th>
                  <th>Expires At</th>
                  <th>Latest Verified Value</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="memory-tbody"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">在线 JSON 编排并投递任务图 (Submit Raw DAG Plan)</h2>
            <div class="form-row" style="margin-top:0">
              <button class="secondary" id="tpl-basic">模板 1：标准流水线</button>
              <button class="secondary" id="tpl-advanced">模板 2：带核验门禁+优先级+预算</button>
            </div>
          </div>
          <div class="form-row">
            <label style="font-size:12px;color:var(--muted)">Request ID:</label>
            <input id="submit-req-id" style="flex:1" />
          </div>
          <div style="margin-top:8px">
            <textarea id="submit-plan-json" rows="13" style="width:100%;font-family:var(--mono);font-size:12px"></textarea>
          </div>
          <div class="form-row">
            <button id="submit-plan-btn" class="success">投递 DAG 计划 (POST /api/tasks)</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">💎 已结晶组织技能库与标准作业程序 (Crystallized Playbooks · Procedural Memory)</h2>
          <span style="font-size:12px;color:var(--muted)">将已验证请求图（含动态扩展子图）固化为带版本的组织级可复用 SOP 模板，零规划开销一键复现</span>
        </div>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>Playbook ID / Description</th>
                <th>Version</th>
                <th>Source Request</th>
                <th>Nodes / Capabilities</th>
                <th>Total Runs / Last Run</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="playbooks-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 5: Triggers & Cron Schedules -->
    <section id="tab-triggers" class="tab-pane">
      <div class="split">
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">已注册定时与事件触发器 (Registered Cron & Webhook Triggers)</h2>
            <span style="font-size:12px;color:var(--muted)">支持周期性自动触发认知保鲜任务图，或通过外部 Webhook / 手动立即触发</span>
          </div>
          <div style="overflow-x:auto">
            <table>
              <thead>
                <tr>
                  <th>Trigger ID / Description</th>
                  <th>Schedule / Webhook</th>
                  <th>State</th>
                  <th>Next Run</th>
                  <th>Total Runs / Last Request</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="triggers-tbody"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">新建 / 更新触发器 (Upsert Trigger)</h2>
          </div>
          <div class="form-row">
            <input id="trig-id" placeholder="trigger_id" value="cron-memory-refresh" style="flex:1" />
            <input id="trig-cron" placeholder="Cron (如 */15 * * * *)" value="*/15 * * * *" style="width:150px" />
            <input id="trig-interval" type="number" placeholder="或间隔秒数" style="width:110px" />
            <label style="font-size:12px"><input type="checkbox" id="trig-webhook" checked /> 允许 Webhook</label>
          </div>
          <div class="form-row">
            <input id="trig-desc" placeholder="触发器用途说明" value="每 15 分钟自动巡检并刷新组织政策记忆账本" style="width:100%" />
          </div>
          <div style="margin-top:8px">
            <textarea id="trig-plan-json" rows="9" style="width:100%;font-family:var(--mono);font-size:12px"></textarea>
          </div>
          <div class="form-row">
            <button id="trig-save-btn" class="success">保存触发器 (POST /api/triggers)</button>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 6: Audit Events -->
    <section id="tab-events" class="tab-pane">
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">全链路不可变审计事件流 (Immutable Audit Events)</h2>
          <input id="event-filter" placeholder="按事件类型 / task_id / trace_id 过滤..." style="width:260px" />
        </div>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Time</th>
                <th>Event Type</th>
                <th>Task ID</th>
                <th>Details (Trace / Call / Verdict / Reason)</th>
              </tr>
            </thead>
            <tbody id="events-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>
  </main>

  <div id="toast" class="toast"></div>

  <script>
    if (location.hash.startsWith("#token=")) {
      sessionStorage.setItem(
        "ar_operator_token",
        decodeURIComponent(location.hash.slice(7)),
      );
      history.replaceState(null, "", location.pathname);
    }
    const state = {
      token: sessionStorage.getItem("ar_operator_token") || ${JSON.stringify(defaultToken)},
      lang: "zh",
      snapshot: null,
      telemetry: null,
      selectedRequestId: null,
      selectedTaskId: null,
      sseAbort: null,
    };

    const tokenInput = document.getElementById("token-input");
    tokenInput.value = state.token;

    function showToast(msg, isError = false) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.style.borderColor = isError ? "var(--err)" : "var(--accent)";
      el.style.display = "block";
      clearTimeout(el._timer);
      el._timer = setTimeout(() => { el.style.display = "none"; }, 3200);
    }

    function esc(v) {
      return String(v ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    async function api(path, method = "GET", bodyObj = null) {
      const headers = { Authorization: "Bearer " + state.token };
      if (bodyObj !== null) headers["Content-Type"] = "application/json";
      const res = await fetch(path, {
        method,
        headers,
        body: bodyObj !== null ? JSON.stringify(bodyObj) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Error(data.error || ("HTTP " + res.status));
      return data;
    }

    async function refreshAll() {
      if (!state.token) {
        setConnStatus(false, "请输入 Operator Token");
        return;
      }
      try {
        const [snap, tel] = await Promise.all([
          api("/api/state"),
          api("/api/telemetry"),
        ]);
        state.snapshot = snap;
        state.telemetry = tel;
        setConnStatus(true, "实时同步中 (SSE)");
        renderAll();
      } catch (err) {
        setConnStatus(false, "鉴权或连接失败: " + err.message);
      }
    }

    function setConnStatus(ok, text) {
      const dot = document.getElementById("conn-dot");
      const txt = document.getElementById("conn-text");
      dot.className = "dot " + (ok ? "live" : "err");
      txt.textContent = text;
    }

    async function connectSse() {
      if (state.sseAbort) state.sseAbort.abort();
      if (!state.token) return;
      const ctrl = new AbortController();
      state.sseAbort = ctrl;
      try {
        const res = await fetch("/api/events", {
          headers: { Authorization: "Bearer " + state.token },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          if (buf.includes("\\n\\n")) {
            buf = "";
            await refreshAll();
          }
        }
      } catch {}
    }

    function renderAll() {
      if (!state.snapshot || !state.telemetry) return;
      const { snapshot: snap, telemetry: tel } = state;

      // 1. KPIs
      const used = snap.attempts.filter((a) => a.status === "running").length;
      const cap = snap.quota?.capacity ?? "-";
      document.getElementById("kpi-quota").textContent = used + " / " + cap;

      const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
      for (const t of snap.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
      document.getElementById("kpi-tasks").textContent = String(snap.tasks.length);
      document.getElementById("kpi-tasks-sub").textContent =
        \`排队 \${counts.queued} · 运行 \${counts.running} · 完成 \${counts.completed} · 失败 \${counts.failed}\`;

      const enabledWorkers = tel.workers.filter((w) => w.enabled).length;
      const rates = tel.workers.map((w) => w.pass_rate).filter((r) => r !== null);
      const avgRate = rates.length
        ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) + "%"
        : "N/A";
      document.getElementById("kpi-workers").textContent = enabledWorkers + " / " + tel.workers.length;
      document.getElementById("kpi-workers-sub").textContent = "平均核验通过率: " + avgRate;

      document.getElementById("kpi-memory").textContent = String(tel.memory.length);

      const totTokens = tel.capabilities.reduce((s, c) => s + (c.total_tokens || 0), 0);
      const totCost = tel.capabilities.reduce((s, c) => s + (c.total_cost_usd || 0), 0);
      document.getElementById("kpi-finops").textContent = "$" + totCost.toFixed(4);
      document.getElementById("kpi-finops-sub").textContent = totTokens.toLocaleString() + " tokens";

      renderRequestSelector();
      renderDag();
      renderTaskInspector();
      renderTasksTable();
      renderFactsTable();
      renderTelemetryTables();
      renderMemoryTable();
      renderPlaybooksTable();
      renderTriggersTable();
      renderEventsTable();
    }

    function renderRequestSelector() {
      const sel = document.getElementById("request-select");
      const reqIds = [...new Set(state.snapshot.tasks.map((t) => t.request_id))];
      if (!state.selectedRequestId || !reqIds.includes(state.selectedRequestId)) {
        state.selectedRequestId = reqIds[0] || null;
      }
      sel.innerHTML = reqIds.length
        ? reqIds.map((id) => \`<option value="\${esc(id)}" \${id === state.selectedRequestId ? "selected" : ""}>\${esc(id)}</option>\`).join("")
        : '<option value="">(暂无任务请求)</option>';
    }

    function renderDag() {
      const box = document.getElementById("dag-canvas");
      const meta = document.getElementById("request-meta");
      const tasks = state.snapshot.tasks.filter((t) => t.request_id === state.selectedRequestId);
      if (!tasks.length) {
        meta.textContent = "";
        box.innerHTML = '<p style="color:var(--muted)">暂无任务节点，可在「组织记忆与 AI 自动编排器」标签页投递新计划。</p>';
        return;
      }
      const traceId = tasks[0].trace_id || "none";
      meta.innerHTML = \`Request ID: <code>\${esc(state.selectedRequestId)}</code> · Trace ID: <span class="badge purple">\${esc(traceId)}</span> · 节点数: <b>\${tasks.length}</b>\`;

      const byId = new Map(tasks.map((t) => [t.task_id, t]));
      const depth = new Map();
      const getDepth = (id, seen = new Set()) => {
        if (depth.has(id)) return depth.get(id);
        if (seen.has(id)) return 0;
        seen.add(id);
        const t = byId.get(id);
        if (!t || !Array.isArray(t.dependencies) || !t.dependencies.length) {
          depth.set(id, 0);
          return 0;
        }
        let d = 0;
        for (const dep of t.dependencies) {
          if (byId.has(dep)) d = Math.max(d, getDepth(dep, seen) + 1);
        }
        depth.set(id, d);
        return d;
      };
      for (const t of tasks) getDepth(t.task_id);

      const cols = new Map();
      for (const t of tasks) {
        const c = depth.get(t.task_id) || 0;
        if (!cols.has(c)) cols.set(c, []);
        cols.get(c).push(t);
      }
      const maxCol = Math.max(...cols.keys(), 0);
      const maxRows = Math.max(...[...cols.values()].map((arr) => arr.length), 1);
      const nodeW = 190, nodeH = 74, gapX = 70, gapY = 26;
      const width = Math.max(560, (maxCol + 1) * (nodeW + gapX) + 40);
      const height = Math.max(240, maxRows * (nodeH + gapY) + 40);

      const pos = new Map();
      for (const [c, arr] of cols.entries()) {
        arr.forEach((t, idx) => {
          pos.set(t.task_id, {
            x: 24 + c * (nodeW + gapX),
            y: 24 + idx * (nodeH + gapY),
          });
        });
      }

      const colorOf = {
        queued: "#38bdf8",
        running: "#f59e0b",
        completed: "#10b981",
        failed: "#ef4444",
        cancelled: "#94a3b8",
      };

      let edgesSvg = "";
      for (const t of tasks) {
        const to = pos.get(t.task_id);
        for (const dep of t.dependencies || []) {
          const from = pos.get(dep);
          if (!from || !to) continue;
          const x1 = from.x + nodeW, y1 = from.y + nodeH / 2;
          const x2 = to.x, y2 = to.y + nodeH / 2;
          const cx = (x1 + x2) / 2;
          edgesSvg += \`<path d="M\${x1},\${y1} C\${cx},\${y1} \${cx},\${y2} \${x2},\${y2}" fill="none" stroke="#475569" stroke-width="2" />\`;
        }
      }

      let nodesSvg = "";
      for (const t of tasks) {
        const p = pos.get(t.task_id);
        const stroke = t.task_id === state.selectedTaskId ? "#fff" : (colorOf[t.status] || "#475569");
        const label = t.task_id.length > 18 ? t.task_id.slice(0, 8) + "…" + t.task_id.slice(-6) : t.task_id;
        nodesSvg += \`
          <g class="dag-node" data-id="\${esc(t.task_id)}" style="cursor:pointer" transform="translate(\${p.x},\${p.y})">
            <rect width="\${nodeW}" height="\${nodeH}" rx="8" fill="#111827" stroke="\${stroke}" stroke-width="\${t.task_id === state.selectedTaskId ? 2.5 : 1.5}" />
            <text x="10" y="20" fill="#f8fafc" font-size="12" font-weight="700" font-family="monospace">\${esc(t.capability)}</text>
            <text x="10" y="38" fill="#94a3b8" font-size="11" font-family="monospace">\${esc(label)}</text>
            <text x="10" y="58" fill="\${colorOf[t.status] || "#cbd5e1"}" font-size="11" font-weight="600">\${esc(t.status.toUpperCase())} · p:\${t.priority ?? 0} · try:\${t.attempts}/\${t.max_attempts}</text>
          </g>\`;
      }

      box.innerHTML = \`<svg width="\${width}" height="\${height}">\${edgesSvg}\${nodesSvg}</svg>\`;
      box.querySelectorAll(".dag-node").forEach((el) => {
        el.addEventListener("click", () => {
          state.selectedTaskId = el.getAttribute("data-id");
          renderDag();
          renderTaskInspector();
        });
      });
    }

    function renderTaskInspector() {
      const box = document.getElementById("task-inspector");
      const t = state.snapshot.tasks.find((x) => x.task_id === state.selectedTaskId) || state.snapshot.tasks[0];
      if (!t) return;
      state.selectedTaskId = t.task_id;
      const defaultCap = state.telemetry.capabilities[0]?.name || t.capability;
      box.innerHTML = \`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <code>\${esc(t.task_id)}</code>
          <span class="badge \${esc(t.status)}">\${esc(t.status)}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
          Capability: <b>\${esc(t.capability)}</b> · Priority: <b>\${t.priority ?? 0}</b> · Attempts: <b>\${t.attempts}/\${t.max_attempts}</b>
          \${t.last_error ? \` · Error: <span style="color:var(--err)">\${esc(t.last_error)}</span>\` : ""}
        </div>
        <div style="font-size:12px;margin-bottom:4px;color:var(--muted)">Input / Result:</div>
        <pre>\${esc(JSON.stringify({ input: t.input, result: t.result, dependencies: t.dependencies }, null, 2))}</pre>
        <div class="form-row" style="margin-top:10px">
          <button class="danger" id="inspector-cancel-btn" \${["queued","running"].includes(t.status) ? "" : "disabled"}>取消任务 (Cancel)</button>
        </div>
        <hr style="border:none;border-top:1px solid var(--border);margin:12px 0" />
        <div style="font-size:12px;font-weight:600;margin-bottom:6px">动态插入子任务图 (Dynamic Expand under this Task)</div>
        <div class="form-row">
          <input id="exp-id" placeholder="expansion_id" value="exp-\${Date.now().toString(36)}" style="width:140px" />
          <input id="exp-sub-id" placeholder="subtask id" value="sub-step-1" style="width:120px" />
          <input id="exp-cap" placeholder="capability" value="\${esc(defaultCap)}" style="width:130px" />
          <label style="font-size:12px"><input type="checkbox" id="exp-rewire" checked /> 自动缝合下游 (rewire)</label>
          <button id="inspector-expand-btn">动态扩展 (Expand)</button>
        </div>
        <hr style="border:none;border-top:1px solid var(--border);margin:12px 0" />
        <div style="font-size:12px;font-weight:600;margin-bottom:6px">⚡ 状态分叉与断点重放 (Time-Travel Fork from this Node)</div>
        <div class="form-row">
          <input id="fork-req-id" placeholder="new_request_id" value="fork-\${Date.now().toString(36)}" style="width:160px" />
          <button id="inspector-fork-btn" class="secondary">从当前节点分叉重跑 (POST /api/tasks/fork)</button>
        </div>
        <hr style="border:none;border-top:1px solid var(--border);margin:12px 0" />
        <div style="font-size:12px;font-weight:600;margin-bottom:6px">💎 技能结晶：固化当前请求图为组织标准作业程序 (Crystallize Playbook)</div>
        <div class="form-row">
          <input id="pb-id" placeholder="playbook_id" value="sop.\${esc((t.request_id || "workflow").slice(0, 24).toLowerCase().replace(/[^a-z0-9_.:-]/g, "-"))}" style="width:170px" />
          <input id="pb-desc" placeholder="SOP 用途描述" value="从请求 \${esc(t.request_id)} 结晶的标准工作流" style="flex:1" />
          <button id="inspector-crystallize-btn" class="success">💎 结晶为 Playbook</button>
        </div>
      \`;
      const cancelBtn = document.getElementById("inspector-cancel-btn");
      if (cancelBtn) {
        cancelBtn.onclick = async () => {
          try {
            await api("/api/cancel", "POST", { task_id: t.task_id });
            showToast("已取消任务 " + t.task_id);
            await refreshAll();
          } catch (e) {
            showToast("取消失败: " + e.message, true);
          }
        };
      }
      const expandBtn = document.getElementById("inspector-expand-btn");
      if (expandBtn) {
        expandBtn.onclick = async () => {
          try {
            const expansion_id = document.getElementById("exp-id").value.trim();
            const subId = document.getElementById("exp-sub-id").value.trim();
            const cap = document.getElementById("exp-cap").value.trim();
            const rewire_dependents = document.getElementById("exp-rewire").checked;
            await api("/api/tasks/expand", "POST", {
              request_id: t.request_id,
              expansion_id,
              parent_task_id: t.task_id,
              rewire_dependents,
              plan: { tasks: [{ id: subId, capability: cap, input: { text: "expanded from console", topic: "expanded" } }] },
            });
            showToast("成功动态扩展子任务: " + subId);
            await refreshAll();
          } catch (e) {
            showToast("动态扩展失败: " + e.message, true);
          }
        };
      }
      const forkBtn = document.getElementById("inspector-fork-btn");
      if (forkBtn) {
        forkBtn.onclick = async () => {
          try {
            const new_request_id = document.getElementById("fork-req-id").value.trim();
            const res = await api("/api/tasks/fork", "POST", {
              source_request_id: t.request_id,
              new_request_id,
              from_task_key: t.task_key || t.task_id,
            });
            state.selectedRequestId = res.request_id;
            showToast(\`已分叉新请求 \${res.request_id}（复用上游 \${res.reused_task_ids.length} 个节点，重跑 \${res.queued_task_ids.length} 个节点）\`);
            await refreshAll();
          } catch (e) {
            showToast("分叉重放失败: " + e.message, true);
          }
        };
      }
      const crystallizeBtn = document.getElementById("inspector-crystallize-btn");
      if (crystallizeBtn) {
        crystallizeBtn.onclick = async () => {
          try {
            const playbook_id = document.getElementById("pb-id").value.trim();
            const description = document.getElementById("pb-desc").value.trim();
            const res = await api("/api/playbooks", "POST", {
              playbook_id,
              source_request_id: t.request_id,
              description,
              tags: ["console-crystallized"],
            });
            showToast(\`💎 已结晶组织技能模板 \${res.playbook.playbook_id} (v\${res.playbook.version})\`);
            await refreshAll();
          } catch (e) {
            showToast("技能结晶失败: " + e.message, true);
          }
        };
      }
    }

    function renderTasksTable() {
      const tbody = document.getElementById("tasks-tbody");
      tbody.innerHTML = state.snapshot.tasks.map((t) => \`
        <tr>
          <td><a href="#" class="pick-task mono" data-id="\${esc(t.task_id)}" style="color:var(--accent)">\${esc(t.task_id.slice(0, 12))}…</a></td>
          <td class="mono">\${esc(t.request_id.slice(0, 12))}<br/><span style="color:var(--muted)">\${esc(t.trace_id || "-")}</span></td>
          <td class="mono">\${esc(t.capability)}</td>
          <td class="mono">\${t.priority ?? 0}</td>
          <td><span class="badge \${esc(t.status)}">\${esc(t.status)}</span></td>
          <td class="mono">\${t.attempts} / \${t.max_attempts}</td>
          <td class="mono">\${t.require_verified_facts ? "✓ verified" : "-"} \${t.min_fact_confidence != null ? "conf≥" + t.min_fact_confidence : ""} \${t.min_worker_pass_rate != null ? \`<span class="badge purple">rep≥\${Math.round(t.min_worker_pass_rate * 100)}%</span>\` : ""}</td>
          <td class="mono">\${esc(t.fact_key || "-")} \${t.context_keys?.length ? "← [" + esc(t.context_keys.join(",")) + "]" : ""}</td>
          <td><button class="secondary pick-task" data-id="\${esc(t.task_id)}">查看</button></td>
        </tr>
      \`).join("");
      tbody.querySelectorAll(".pick-task").forEach((el) => {
        el.onclick = (ev) => {
          ev.preventDefault();
          const id = el.getAttribute("data-id");
          const task = state.snapshot.tasks.find((x) => x.task_id === id);
          if (task) state.selectedRequestId = task.request_id;
          state.selectedTaskId = id;
          renderRequestSelector();
          renderDag();
          renderTaskInspector();
        };
      });
    }

    function renderFactsTable() {
      const tbody = document.getElementById("facts-tbody");
      if (!state.snapshot.facts.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted)">尚无任务产出共享事实</td></tr>';
        return;
      }
      tbody.innerHTML = state.snapshot.facts.map((f) => \`
        <tr>
          <td class="mono">\${esc(f.task_id.slice(0, 12))}…<br/>\${f.fact_key ? \`<span class="badge purple">\${esc(f.fact_key)}</span>\` : ""}</td>
          <td class="mono">v\${f.version}</td>
          <td class="mono">\${esc(f.agent_id)}</td>
          <td>
            <span class="badge \${f.verified ? "verified" : "rejected"}">\${f.verified ? "VERIFIED" : "UNVERIFIED"}</span>
            <div class="mono" style="margin-top:4px">conf: \${f.confidence ?? "-"}</div>
          </td>
          <td><pre style="max-width:280px">\${esc(JSON.stringify(f.value))}</pre></td>
          <td style="font-size:12px">
            <div>\${esc(f.review_note || "(未核验)")}</div>
            <div class="mono" style="color:var(--muted)">\${f.expires_at ? "TTL: " + new Date(f.expires_at).toLocaleTimeString() : ""}</div>
          </td>
          <td>
            <div class="form-row" style="margin-top:0">
              <input placeholder="核验意见 (review_note)" id="note-\${f.fact_id}" value="\${esc(f.review_note || "人工复核确认")}" style="width:150px" />
              <input type="number" step="0.05" min="0" max="1" id="conf-\${f.fact_id}" value="\${f.confidence ?? 0.95}" style="width:70px" title="置信度 (0~1)" />
              <button class="success rev-btn" data-task="\${esc(f.task_id)}" data-ver="\${f.version}" data-fid="\${f.fact_id}" data-ok="true" data-rework="false">✓ 通过</button>
              <button class="warn rev-btn" data-task="\${esc(f.task_id)}" data-ver="\${f.version}" data-fid="\${f.fact_id}" data-ok="false" data-rework="true">↺ 驳回重做</button>
            </div>
          </td>
        </tr>
      \`).join("");

      tbody.querySelectorAll(".rev-btn").forEach((btn) => {
        btn.onclick = async () => {
          const fid = btn.getAttribute("data-fid");
          const task_id = btn.getAttribute("data-task");
          const version = Number(btn.getAttribute("data-ver"));
          const verified = btn.getAttribute("data-ok") === "true";
          const rework = btn.getAttribute("data-rework") === "true";
          const note = document.getElementById("note-" + fid).value.trim() || "reviewed";
          const confidence = Number(document.getElementById("conf-" + fid).value);
          try {
            const res = await api("/api/facts/review", "POST", {
              task_id,
              version,
              verified,
              note,
              rework,
              confidence,
            });
            if (!res.accepted) {
              showToast("未生效: " + (res.reason || "版本已过期或非completed状态"), true);
            } else {
              showToast(rework ? "已驳回并触发上游重做 (" + res.next + ")" : "核验已提交");
            }
            await refreshAll();
          } catch (e) {
            showToast("核验失败: " + e.message, true);
          }
        };
      });
    }

    function renderTelemetryTables() {
      const wbody = document.getElementById("workers-tbody");
      wbody.innerHTML = state.telemetry.workers.map((w) => \`
        <tr>
          <td class="mono"><b>\${esc(w.agent_id)}</b></td>
          <td class="mono">\${esc(w.capability)}</td>
          <td><span class="badge \${w.enabled ? "enabled" : "disabled"}">\${w.enabled ? "ENABLED" : "ISOLATED"}</span></td>
          <td class="mono">\${w.in_flight}</td>
          <td class="mono">\${w.completed_attempts} / \${w.failed_attempts}</td>
          <td class="mono">\${w.pass_rate !== null ? (w.pass_rate * 100).toFixed(1) + "%" : "-"} (\${w.verified_facts}/\${w.verified_facts + w.rejected_facts})<br/><span style="color:var(--muted);font-size:11px">Wilson LB: \${w.wilson_lower_bound !== null && w.wilson_lower_bound !== undefined ? (w.wilson_lower_bound * 100).toFixed(1) + "%" : "-"}</span></td>
          <td class="mono" style="color:\${w.consecutive_failures > 0 ? "var(--warn)" : "inherit"}">\${w.consecutive_failures}</td>
          <td class="mono">\${w.avg_duration_ms !== null ? w.avg_duration_ms + " ms" : "-"}</td>
          <td class="mono">\${w.total_tokens} tok / $\${Number(w.total_cost_usd || 0).toFixed(4)}<br/><span style="color:var(--accent);font-size:11px">cpr: \${w.cost_per_verified_usd !== null && w.cost_per_verified_usd !== undefined ? "$" + Number(w.cost_per_verified_usd).toFixed(4) + "/ok" : "-"}</span></td>
          <td>
            <button class="\${w.enabled ? "danger" : "success"} toggle-worker" data-id="\${esc(w.agent_id)}" data-enable="\${!w.enabled}">
              \${w.enabled ? "隔离禁用" : "解除隔离并启用"}
            </button>
          </td>
        </tr>
      \`).join("");

      wbody.querySelectorAll(".toggle-worker").forEach((btn) => {
        btn.onclick = async () => {
          const agent_id = btn.getAttribute("data-id");
          const enabled = btn.getAttribute("data-enable") === "true";
          try {
            await api("/api/workers/enable", "POST", { agent_id, enabled });
            showToast(\`节点 \${agent_id} 已\${enabled ? "启用并清零连续失败计数" : "隔离禁用"}\`);
            await refreshAll();
          } catch (e) {
            showToast("操作失败: " + e.message, true);
          }
        };
      });

      const cbody = document.getElementById("caps-tbody");
      cbody.innerHTML = state.telemetry.capabilities.map((c) => \`
        <tr>
          <td class="mono"><b>\${esc(c.name)}</b><br/><span style="color:var(--muted)">\${esc(c.description)}</span></td>
          <td>\${c.verifier ? '<span class="badge purple">VERIFIER 裁判</span>' : '<span class="badge queued">EXECUTOR</span>'}</td>
          <td class="mono">in: [\${esc((c.required_input_fields || []).join(","))}]<br/>out: [\${esc((c.required_output_fields || []).join(","))}]</td>
          <td class="mono">\${(c.allowed_context_prefixes || []).length ? esc(c.allowed_context_prefixes.join(", ")) : "* (无限制)"}</td>
          <td class="mono">\${c.queued_tasks} / \${c.running_tasks} / \${c.completed_tasks} / \${c.failed_tasks}</td>
          <td class="mono">\${c.verified_facts} / \${c.rejected_facts}</td>
          <td class="mono">\${c.total_tokens} tok / $\${Number(c.total_cost_usd || 0).toFixed(4)}</td>
        </tr>
      \`).join("");
    }

    function renderMemoryTable() {
      const mbody = document.getElementById("memory-tbody");
      const q = (document.getElementById("memory-search-input")?.value || "").trim().toLowerCase();
      const list = state.telemetry.memory.filter((m) => {
        if (!q) return true;
        return JSON.stringify(m).toLowerCase().includes(q);
      });
      if (!list.length) {
        mbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">暂无匹配的跨周期组织记忆 (需任务声明 fact_key 且通过核验)</td></tr>';
        return;
      }
      mbody.innerHTML = list.map((m) => \`
        <tr>
          <td>
            <span class="badge purple">\${esc(m.fact_key)}</span>
            <div style="margin-top:4px">
              \${m.memory_tier === "invariant" ? '<span class="badge completed">🧬 INVARIANT 不变量</span>' : '<span class="badge queued">📝 EPISODIC 情景</span>'}
            </div>
          </td>
          <td class="mono">
            \${m.confidence ?? 1}
            <div style="color:var(--muted);font-size:11px">Beta ×\${m.feedback_multiplier ?? 1} (\${m.accepted_count ?? 0}/\${m.injected_count ?? 0})</div>
          </td>
          <td class="mono">\${esc(m.agent_id)} (v\${m.version})</td>
          <td class="mono">\${m.expires_at ? new Date(m.expires_at).toLocaleString() : "永不过期"}</td>
          <td><pre>\${esc(JSON.stringify(m.value, null, 2))}</pre></td>
          <td>
            <button class="warn rollback-fact-btn" data-key="\${esc(m.fact_key)}">↺ 时光回滚</button>
          </td>
        </tr>
      \`).join("");

      mbody.querySelectorAll(".rollback-fact-btn").forEach((btn) => {
        btn.onclick = async () => {
          const fact_key = btn.getAttribute("data-key");
          try {
            const res = await api("/api/memory/rollback", "POST", {
              fact_key,
              note: "控制台人工回滚至上一版本",
            });
            if (res.rolled_back) {
              showToast(\`已回滚记忆 \${fact_key}\${res.active_fact ? " 至历史已核验版本" : "（已无更早版本）"}\`);
            } else {
              showToast("未找到可回滚的激活事实", true);
            }
            await refreshAll();
          } catch (e) {
            showToast("回滚失败: " + e.message, true);
          }
        };
      });
    }

    function renderPlaybooksTable() {
      const pbody = document.getElementById("playbooks-tbody");
      if (!pbody) return;
      const playbooks = state.telemetry.playbooks || state.snapshot.playbooks || [];
      if (!playbooks.length) {
        pbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">尚无已固化的组织技能模板（可在 DAG 节点检查器点击「💎 结晶为 Playbook」）</td></tr>';
        return;
      }
      pbody.innerHTML = playbooks.map((pb) => {
        const tasks = pb.plan_template?.tasks || [];
        const caps = [...new Set(tasks.map((t) => t.capability))].join(" → ");
        return \`
          <tr>
            <td class="mono"><b>\${esc(pb.playbook_id)}</b><br/><span style="color:var(--muted)">\${esc(pb.description)}</span></td>
            <td class="mono"><span class="badge purple">v\${pb.version}</span></td>
            <td class="mono">\${esc(pb.source_request_id || "-")}</td>
            <td class="mono">\${tasks.length} nodes (\${esc(caps)})</td>
            <td class="mono">\${pb.total_runs} runs<br/><span style="color:var(--muted)">\${pb.last_run_at ? new Date(pb.last_run_at).toLocaleTimeString() : "-"}</span></td>
            <td>
              <button class="success run-pb-btn" data-id="\${esc(pb.playbook_id)}">▶ 一键复现执行</button>
            </td>
          </tr>
        \`;
      }).join("");

      pbody.querySelectorAll(".run-pb-btn").forEach((btn) => {
        btn.onclick = async () => {
          const playbook_id = btn.getAttribute("data-id");
          try {
            const res = await api("/api/playbooks/run", "POST", { playbook_id });
            state.selectedRequestId = res.request_id;
            showToast(\`▶ 已实例化执行技能模板 \${playbook_id}，新请求 ID: \${res.request_id}\`);
            await refreshAll();
          } catch (e) {
            showToast("执行技能模板失败: " + e.message, true);
          }
        };
      });
    }

    function renderTriggersTable() {
      const tbody = document.getElementById("triggers-tbody");
      const triggers = state.telemetry.triggers || state.snapshot.triggers || [];
      if (!triggers.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">尚无定时或事件触发器，可在右侧新建</td></tr>';
        return;
      }
      tbody.innerHTML = triggers.map((tr) => \`
        <tr>
          <td class="mono"><b>\${esc(tr.trigger_id)}</b><br/><span style="color:var(--muted)">\${esc(tr.description)}</span></td>
          <td class="mono">
            \${tr.cron_expr ? \`<div>cron: <code>\${esc(tr.cron_expr)}</code></div>\` : ""}
            \${tr.interval_seconds ? \`<div>every: \${tr.interval_seconds}s</div>\` : ""}
            \${tr.webhook ? '<span class="badge purple">WEBHOOK</span>' : ""}
          </td>
          <td><span class="badge \${tr.enabled ? "enabled" : "disabled"}">\${tr.enabled ? "ENABLED" : "PAUSED"}</span></td>
          <td class="mono">\${tr.next_run_at ? new Date(tr.next_run_at).toLocaleString() : "-"}</td>
          <td class="mono">\${tr.total_runs} runs<br/><span style="color:var(--muted)">\${esc(tr.last_request_id || "-")}</span></td>
          <td>
            <button class="success fire-trig-btn" data-id="\${esc(tr.trigger_id)}">⚡ 立即触发</button>
          </td>
        </tr>
      \`).join("");

      tbody.querySelectorAll(".fire-trig-btn").forEach((btn) => {
        btn.onclick = async () => {
          const trigger_id = btn.getAttribute("data-id");
          try {
            const res = await api("/api/triggers/fire", "POST", {
              trigger_id,
              source: "manual",
            });
            showToast(\`触发器 \${trigger_id} 已触发，请求 ID: \${res.request_id}\`);
            state.selectedRequestId = res.request_id;
            await refreshAll();
          } catch (e) {
            showToast("触发失败: " + e.message, true);
          }
        };
      });
    }

    function renderEventsTable() {
      const filter = document.getElementById("event-filter").value.trim().toLowerCase();
      const ebody = document.getElementById("events-tbody");
      const list = state.snapshot.events.filter((e) => {
        if (!filter) return true;
        return JSON.stringify(e).toLowerCase().includes(filter);
      });
      ebody.innerHTML = list.map((e) => \`
        <tr>
          <td class="mono">#\${e.event_id}</td>
          <td class="mono">\${new Date(e.created_at).toLocaleTimeString()}</td>
          <td><span class="badge queued">\${esc(e.type)}</span></td>
          <td class="mono">\${esc(e.task_id || "-")}</td>
          <td><code style="word-break:break-all">\${esc(JSON.stringify(e.details))}</code></td>
        </tr>
      \`).join("");
    }

    // Tabs switching
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.getAttribute("data-tab")).classList.add("active");
      };
    });

    document.getElementById("request-select").onchange = (e) => {
      state.selectedRequestId = e.target.value;
      renderDag();
    };

    document.getElementById("event-filter").oninput = () => renderEventsTable();
    document.getElementById("memory-search-input").oninput = () => renderMemoryTable();
    document.getElementById("export-bundle-btn").onclick = async () => {
      try {
        const bundle = await api("/api/bundle");
        document.getElementById("submit-plan-json").value = JSON.stringify(bundle, null, 2);
        showToast("📦 已导出组织认知资产包至右侧 JSON 预览框");
      } catch (e) {
        showToast("导出失败: " + e.message, true);
      }
    };

    document.getElementById("connect-btn").onclick = async () => {
      state.token = tokenInput.value.trim();
      sessionStorage.setItem("ar_operator_token", state.token);
      await refreshAll();
      connectSse();
    };

    const i18n = {
      zh: {
        title: "Agent Registry Framework · AIOS 调度与认知控制台",
        subtitle: "任务 DAG 编排 · 60分奇点核验重做 · 节点复利画像 · 跨周期组织记忆 · FinOps 护栏",
        kpi_quota: "全局并发配额 (Execution Quota)",
        kpi_tasks: "任务图状态分布 (DAG Tasks)",
        kpi_workers: "认知节点健康度 (Worker Fleet)",
        kpi_memory: "跨周期组织记忆 (Active Memory)",
        kpi_finops: "FinOps 累计消耗 (Tokens & Cost)",
      },
      en: {
        title: "Agent Registry Framework · AIOS Control Plane",
        subtitle: "DAG Orchestration · HITL Fact Rework · Compound Telemetry · Organizational Memory · FinOps",
        kpi_quota: "Global Execution Quota",
        kpi_tasks: "DAG Task Distribution",
        kpi_workers: "Worker Fleet Health",
        kpi_memory: "Active Organizational Memory",
        kpi_finops: "FinOps Ledger (Tokens & Cost)",
      },
    };
    document.getElementById("lang-btn").onclick = () => {
      state.lang = state.lang === "zh" ? "en" : "zh";
      const dict = i18n[state.lang];
      document.querySelectorAll("[data-i18n]").forEach((el) => {
        const k = el.getAttribute("data-i18n");
        if (dict[k]) el.textContent = dict[k];
      });
    };

    // Plan Submitter Templates
    function loadTemplate(advanced = false) {
      const caps = state.telemetry?.capabilities?.map((c) => c.name) || ["text.normalize", "text.summarize"];
      const c1 = caps[0] || "text.normalize";
      const c2 = caps[1] || c1;
      document.getElementById("submit-req-id").value = "req-console-" + Date.now().toString(36);
      const plan = advanced
        ? {
            trace_id: "trace.console." + Date.now().toString(36),
            budget: { max_tokens: 50000, max_cost_usd: 1.5 },
            tasks: [
              {
                id: "step-extract",
                capability: c1,
                priority: 20,
                fact_key: "org.console.fact",
                fact_ttl_seconds: 7200,
                input: { text: "  intelligent agent os  ", topic: "aios" },
              },
              {
                id: "step-synthesize",
                capability: c2,
                priority: 10,
                dependencies: ["step-extract"],
                require_verified_facts: true,
                min_fact_confidence: 0.85,
                min_worker_pass_rate: 0.8,
                context_keys: ["org.console.fact"],
                input: { text: "synthesize report", topic: "report" },
              },
            ],
          }
        : {
            trace_id: "trace.basic." + Date.now().toString(36),
            tasks: [
              {
                id: "normalize",
                capability: c1,
                input: { text: "  hello operator console  ", topic: "greeting" },
              },
              {
                id: "summarize",
                capability: c2,
                dependencies: ["normalize"],
                input: { text: "summarize greeting", topic: "summary" },
              },
            ],
          };
      document.getElementById("submit-plan-json").value = JSON.stringify(plan, null, 2);
      document.getElementById("trig-plan-json").value = JSON.stringify(plan, null, 2);
    }

    document.getElementById("tpl-basic").onclick = () => loadTemplate(false);
    document.getElementById("tpl-advanced").onclick = () => loadTemplate(true);
    loadTemplate(false);

    document.getElementById("planner-submit-btn").onclick = async () => {
      try {
        const goal = document.getElementById("planner-goal-input").value.trim();
        const fact_key = document.getElementById("planner-fact-key").value.trim() || null;
        const rateStr = document.getElementById("planner-min-rate").value.trim();
        const min_worker_pass_rate = rateStr ? Number(rateStr) : null;
        const res = await api("/api/planner/submit", "POST", {
          goal,
          fact_key,
          min_worker_pass_rate,
        });
        document.getElementById("submit-plan-json").value = JSON.stringify(res.plan, null, 2);
        state.selectedRequestId = res.request_id;
        showToast("✨ AI Planner 已自动生成并投递 " + res.ids.length + " 个任务");
        await refreshAll();
      } catch (e) {
        showToast("AI 编排失败: " + e.message, true);
      }
    };

    document.getElementById("submit-plan-btn").onclick = async () => {
      try {
        const request_id = document.getElementById("submit-req-id").value.trim();
        const plan = JSON.parse(document.getElementById("submit-plan-json").value);
        const res = await api("/api/tasks", "POST", { request_id, plan });
        showToast("已投递计划，生成 " + res.ids.length + " 个任务");
        state.selectedRequestId = request_id;
        await refreshAll();
      } catch (e) {
        showToast("投递失败: " + e.message, true);
      }
    };

    document.getElementById("trig-save-btn").onclick = async () => {
      try {
        const trigger_id = document.getElementById("trig-id").value.trim();
        const cron = document.getElementById("trig-cron").value.trim() || null;
        const intervalVal = document.getElementById("trig-interval").value.trim();
        const interval_seconds = intervalVal ? Number(intervalVal) : null;
        const webhook = document.getElementById("trig-webhook").checked;
        const description = document.getElementById("trig-desc").value.trim();
        const plan = JSON.parse(document.getElementById("trig-plan-json").value);
        await api("/api/triggers", "POST", {
          trigger_id,
          description,
          cron,
          interval_seconds,
          webhook,
          plan,
          enabled: true,
        });
        showToast("已保存触发器: " + trigger_id);
        await refreshAll();
      } catch (e) {
        showToast("保存触发器失败: " + e.message, true);
      }
    };

    if (state.token) {
      refreshAll();
      connectSse();
    }
  </script>
</body>
</html>`;
}

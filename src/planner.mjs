import { randomUUID } from "node:crypto";
import { validatePlan } from "./validation.mjs";
import { DEFAULT_HARNESS_GENOME } from "./harness.mjs";

function slug(text, fallback = "step") {
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || fallback;
}

function buildCapabilitySatisfiedInput(cap, goal, inputDefaults = {}) {
  const input = { ...inputDefaults };
  if (input.text === undefined && input.goal === undefined) {
    input.text = goal;
  }
  for (const field of cap.required_input_fields || []) {
    if (
      input[field] === undefined ||
      input[field] === null ||
      input[field] === ""
    ) {
      input[field] = goal;
    }
  }
  return input;
}

/** EN: Natural-language Goal-to-DAG Planner with LLM (OpenAI-compatible) and deterministic capability-contract fallback.
 * 中文：自然语言目标转 DAG 编排器，支持 OpenAI 兼容大模型接口、自定义补全回调以及确定性能力契约推导回退。
 */
export class Planner {
  constructor({
    capabilities = [],
    complete = null,
    baseUrl = "https://api.openai.com/v1",
    apiKey = null,
    model = "gpt-4o-mini",
    timeoutMs = 15_000,
  } = {}) {
    if (complete !== null && typeof complete !== "function")
      throw Error("Invalid planner complete callback");
    this.capabilities = capabilities;
    this.complete = complete;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async _callLlm(messages, context) {
    if (this.complete) {
      return this.complete(messages, context);
    }
    if (!this.apiKey) return null;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw Error(`Planner LLM HTTP ${res.status}`);
    const body = await res.json();
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw Error("Empty LLM planner response");
    return JSON.parse(content);
  }

  _compileDeterministicPlan(
    goal,
    {
      capabilities,
      memory = [],
      traceId = null,
      budget = null,
      inputDefaults = {},
      factKey = null,
      minWorkerPassRate = null,
    },
  ) {
    const executors = capabilities.filter((c) => !c.verifier);
    const pool = executors.length ? executors : capabilities;
    if (!pool.length) throw Error("No capabilities available for planning");

    // Match capabilities mentioned in goal in order of appearance, or use pipeline order (up to 4 stages)
    const lower = goal.toLowerCase();
    const matchPos = (c) => {
      const nameIdx = lower.indexOf(c.name.toLowerCase());
      if (nameIdx !== -1) return nameIdx;
      if (!c.description) return -1;
      let best = -1;
      for (const w of c.description.toLowerCase().split(/\W+/)) {
        if (w.length < 4) continue;
        const idx = lower.indexOf(w);
        if (idx !== -1 && (best === -1 || idx < best)) best = idx;
      }
      return best;
    };
    const matched = pool
      .map((c) => ({ cap: c, pos: matchPos(c) }))
      .filter((x) => x.pos !== -1)
      .sort((a, b) => a.pos - b.pos)
      .map((x) => x.cap);
    const selected = (matched.length ? matched : pool).slice(0, 4);

    const tasks = [];
    let prevId = null;
    let producedFactKey = null;

    selected.forEach((cap, idx) => {
      const id =
        selected.length === 1
          ? slug(cap.name, "task-1")
          : `step-${idx + 1}-${slug(cap.name)}`;
      const isFirst = idx === 0;
      const isLast = idx === selected.length - 1;
      const task = {
        id,
        capability: cap.name,
        priority: (selected.length - idx) * 10,
        input: buildCapabilitySatisfiedInput(cap, goal, inputDefaults),
        ...(minWorkerPassRate !== null && minWorkerPassRate !== undefined
          ? { min_worker_pass_rate: minWorkerPassRate }
          : {}),
      };
      if (prevId) {
        task.dependencies = [prevId];
        task.require_verified_facts = true;
        task.min_fact_confidence = 0.85;
      }
      const prefixes = cap.allowed_context_prefixes || [];
      if (isFirst && factKey) {
        task.fact_key = factKey;
        task.fact_ttl_seconds = 86_400;
        producedFactKey = factKey;
      } else if (isFirst && selected.length > 1) {
        const prefix = prefixes[0] || "org.";
        producedFactKey = `${prefix}${slug(goal, "goal").replaceAll("-", "_")}`;
        task.fact_key = producedFactKey;
        task.fact_ttl_seconds = 86_400;
      }
      if (isLast) {
        const candidateKeys = [
          ...(producedFactKey ? [producedFactKey] : []),
          ...memory.map((m) => m.fact_key).filter(Boolean),
        ];
        const allowedKeys = candidateKeys.filter(
          (k, i, arr) =>
            arr.indexOf(k) === i &&
            (!prefixes.length || prefixes.some((p) => k.startsWith(p))),
        );
        if (allowedKeys.length) {
          task.context_keys = allowedKeys.slice(0, 10);
        }
      }
      tasks.push(task);
      prevId = id;
    });

    return {
      ...(traceId ? { trace_id: traceId } : {}),
      ...(budget ? { budget } : {}),
      tasks,
    };
  }

  /** EN: Compile a natural-language goal into a validated DAG plan.
   * 中文：将自然语言目标编译并校验为符合能力契约的 DAG 计划。
   */
  async plan(
    goal,
    {
      requestId = `plan-${randomUUID()}`,
      capabilities = this.capabilities,
      memory = [],
      traceId = null,
      budget = null,
      inputDefaults = {},
      factKey = null,
      minWorkerPassRate = null,
      genome = null,
      falsifiedHistory = [],
    } = {},
  ) {
    if (typeof goal !== "string" || !goal.trim() || goal.length > 4000)
      throw Error("Invalid planning goal");
    const cleanGoal = goal.trim();
    const baseSysPrompt =
      genome?.planner_prompts?.system_prompt ??
      DEFAULT_HARNESS_GENOME.planner_prompts.system_prompt;
    const sysLines = [
      baseSysPrompt,
      `Capabilities: ${JSON.stringify(capabilities)}`,
      `Active Organizational Memory Keys: ${JSON.stringify(memory.map((m) => m.fact_key))}`,
    ];
    if (Array.isArray(falsifiedHistory) && falsifiedHistory.length > 0) {
      sysLines.push(
        `Falsified / Rejected Mutations & Facts (DO NOT repeat these approaches): ${JSON.stringify(falsifiedHistory.slice(0, 6))}`,
      );
    }
    const systemPrompt = sysLines.join("\n");
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: cleanGoal },
    ];

    let rawPlan = await this._callLlm(messages, {
      goal: cleanGoal,
      capabilities,
      memory,
      traceId,
      budget,
      falsifiedHistory,
    });
    if (!rawPlan) {
      rawPlan = this._compileDeterministicPlan(cleanGoal, {
        capabilities,
        memory,
        traceId,
        budget,
        inputDefaults,
        factKey,
        minWorkerPassRate,
      });
    } else {
      if (traceId && !rawPlan.trace_id) rawPlan.trace_id = traceId;
      if (budget && !rawPlan.budget) rawPlan.budget = budget;
    }

    const validated = validatePlan(requestId, rawPlan);
    return {
      request_id: requestId,
      goal: cleanGoal,
      plan: validated,
    };
  }

  /** EN: Compile a natural-language goal against live scheduler telemetry and immediately submit the DAG.
   * 中文：读取调度器实时能力目录与组织记忆，将自然语言目标编译为 DAG 并立即持久化提交。
   */
  async submitGoal(
    scheduler,
    goal,
    {
      requestId = `goal-${randomUUID()}`,
      traceId = `trace.goal.${Date.now().toString(36)}`,
      budget = null,
      inputDefaults = {},
      factKey = null,
      minWorkerPassRate = null,
    } = {},
  ) {
    const tel = await scheduler.telemetry();
    const compiled = await this.plan(goal, {
      requestId,
      capabilities: tel.capabilities,
      memory: tel.memory,
      traceId,
      budget,
      inputDefaults,
      factKey,
      minWorkerPassRate,
      genome: tel.genome?.surfaces ?? null,
      falsifiedHistory: tel.falsified_history ?? [],
    });
    const { ids } = await scheduler.submit(compiled.request_id, compiled.plan);
    return {
      ...compiled,
      ids,
    };
  }

  /** EN: Dynamically synthesize and expand a follow-up sub-DAG from an upstream task's output fact.
   * 中文：根据上游任务产出的事实结果与目标，动态生成并追加子任务图（expand）。
   */
  async expandFromFact(
    scheduler,
    {
      requestId,
      expansionId = `exp-${randomUUID()}`,
      parentTaskId,
      fact,
      goal = "Verify and refine upstream fact",
      rewireDependents = true,
      inputDefaults = {},
    } = {},
  ) {
    const tel = await scheduler.telemetry();
    const contextualGoal = `${goal} | upstream_fact=${JSON.stringify(fact ?? {})}`;
    const compiled = await this.plan(contextualGoal, {
      requestId: expansionId,
      capabilities: tel.capabilities,
      memory: tel.memory,
      inputDefaults: { ...inputDefaults, upstream_fact: fact ?? null },
      genome: tel.genome?.surfaces ?? null,
      falsifiedHistory: tel.falsified_history ?? [],
    });
    const { ids } = await scheduler.expand(
      requestId,
      expansionId,
      parentTaskId,
      compiled.plan,
      { rewireDependents },
    );
    return {
      request_id: requestId,
      expansion_id: expansionId,
      plan: compiled.plan,
      ids,
    };
  }
}

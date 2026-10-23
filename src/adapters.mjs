import { DEFAULT_HARNESS_GENOME } from "./harness.mjs";

/** EN: Build structured LLM messages from a claimed registry task, including upstream facts, rework feedback, and organizational memory.
 * 中文：根据领取的调度任务构建结构化 LLM 消息，自动注入上游依赖事实、打回重做的历史审核意见以及跨请求组织记忆。
 */
export function buildAgentMessages(
  task,
  {
    systemPrompt = null,
    reworkDirective = null,
    genome = null,
    requiredOutputFields = [],
  } = {},
) {
  const effectiveSysPrompt =
    systemPrompt ??
    genome?.adapter_prompts?.worker_system_prompt ??
    DEFAULT_HARNESS_GENOME.adapter_prompts.worker_system_prompt;
  const effectiveReworkDirective =
    reworkDirective ??
    genome?.adapter_prompts?.rework_directive ??
    DEFAULT_HARNESS_GENOME.adapter_prompts.rework_directive;
  const sysParts = [effectiveSysPrompt];
  if (requiredOutputFields.length > 0) {
    sysParts.push(
      `Your JSON response MUST include these non-null fields: ${requiredOutputFields.join(", ")}.`,
    );
  }
  const payload = {
    task_id: task.task_id,
    capability: task.capability,
    attempt: task.attempt,
    input: task.input,
    dependency_facts: (task.facts || []).map((f) => ({
      task_id: f.task_id,
      version: f.version,
      verified: f.verified,
      confidence: f.confidence,
      value: f.value,
    })),
    organizational_memory: (task.context_facts || []).map((f) => ({
      fact_key: f.fact_key,
      confidence: f.confidence,
      ...(f.memory_tier && f.memory_tier !== "episodic"
        ? { memory_tier: f.memory_tier }
        : {}),
      value: f.value,
    })),
  };
  if (Array.isArray(task.prior_facts) && task.prior_facts.length > 0) {
    payload.rework_history = task.prior_facts.map((p) => ({
      version: p.version,
      previous_output: p.value,
      rejected_reason: p.review_note,
      confidence: p.confidence,
    }));
    sysParts.push(effectiveReworkDirective);
  }
  return [
    { role: "system", content: sysParts.join("\n") },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

/** EN: Create a Worker handler backed by an OpenAI-compatible LLM endpoint or custom completion function.
 * 中文：创建对接 OpenAI 兼容大模型接口或自定义补全函数的标准 Worker 处理函数，自动采集 Token 与成本并适配打回重做。
 */
export function createLlmWorkerHandler({
  complete = null,
  baseUrl = "https://api.openai.com/v1",
  apiKey = null,
  model = "gpt-4o-mini",
  systemPrompt = null,
  reworkDirective = null,
  genome = null,
  requiredOutputFields = [],
  costPer1kInput = 0.00015,
  costPer1kOutput = 0.0006,
} = {}) {
  if (!complete && !apiKey)
    throw Error("createLlmWorkerHandler requires either complete or apiKey");
  const cleanUrl = String(baseUrl).replace(/\/+$/, "");

  return async function llmWorkerHandler(task, { signal, reportUsage }) {
    const messages = buildAgentMessages(task, {
      systemPrompt,
      reworkDirective,
      genome,
      requiredOutputFields,
    });
    let rawOutput;
    let usage = null;

    if (complete) {
      const res = await complete(messages, { task, signal });
      if (res && typeof res === "object" && Object.hasOwn(res, "output")) {
        rawOutput = res.output;
        usage = res.usage ?? null;
      } else {
        rawOutput = res;
      }
    } else {
      const response = await fetch(`${cleanUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages,
        }),
        signal,
      });
      if (!response.ok) throw Error(`LLM HTTP ${response.status}`);
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw Error("Missing LLM content");
      rawOutput = JSON.parse(content);
      if (data.usage) {
        const inTok = Number(
          data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0,
        );
        const outTok = Number(
          data.usage.completion_tokens ?? data.usage.output_tokens ?? 0,
        );
        const totTok = Number(data.usage.total_tokens ?? inTok + outTok);
        const cost = Number(
          (
            (inTok / 1000) * costPer1kInput +
            (outTok / 1000) * costPer1kOutput
          ).toFixed(6),
        );
        usage = {
          input_tokens: inTok,
          output_tokens: outTok,
          total_tokens: totTok,
          cost_usd: cost,
        };
      }
    }

    if (usage && typeof reportUsage === "function") {
      reportUsage(usage);
    }
    const parsed =
      typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw Error("LLM output must be a JSON object");
    for (const field of requiredOutputFields) {
      if (parsed[field] === undefined || parsed[field] === null)
        throw Error(`LLM output missing required field: ${field}`);
    }
    return parsed;
  };
}

/** EN: Create a Worker handler that bridges a registry capability to a Model Context Protocol (MCP) tool client.
 * 中文：创建将注册中心能力桥接至 MCP（Model Context Protocol）工具客户端的标准 Worker 处理函数。
 */
export function createMcpToolHandler({
  client,
  toolName,
  mapArguments = null,
  mapResult = null,
} = {}) {
  if (!client || typeof client.callTool !== "function")
    throw Error("MCP client with callTool() is required");
  if (typeof toolName !== "string" || !toolName.trim())
    throw Error("MCP toolName is required");

  return async function mcpToolHandler(task, { signal, reportUsage }) {
    const args = mapArguments
      ? await mapArguments(task)
      : {
          ...task.input,
          ...(task.facts?.length ? { _dependency_facts: task.facts } : {}),
          ...(task.context_facts?.length
            ? { _context_facts: task.context_facts }
            : {}),
        };

    const response = await client.callTool(
      { name: toolName, arguments: args },
      { signal },
    );
    if (!response || response.isError) {
      const errText =
        response?.content?.find((c) => c.type === "text")?.text ||
        "MCP tool execution failed";
      throw Error(errText);
    }
    if (response._meta?.usage && typeof reportUsage === "function") {
      reportUsage(response._meta.usage);
    }
    if (mapResult) {
      return mapResult(response, task);
    }
    if (
      response.structuredContent &&
      typeof response.structuredContent === "object"
    ) {
      return response.structuredContent;
    }
    const textItem = (response.content || []).find((c) => c.type === "text");
    if (textItem && typeof textItem.text === "string") {
      try {
        const parsed = JSON.parse(textItem.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          return parsed;
      } catch {
        // Not JSON; wrap as { text }
      }
      return { text: textItem.text };
    }
    return { ok: true, content: response.content ?? [] };
  };
}

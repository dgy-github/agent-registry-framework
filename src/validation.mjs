function validateFieldList(fields, label) {
  if (fields === undefined) return;
  if (
    !Array.isArray(fields) ||
    fields.length > 20 ||
    fields.some(
      (f) => typeof f !== "string" || !/^[a-zA-Z_]\w{0,63}$/.test(f),
    ) ||
    new Set(fields).size !== fields.length
  )
    throw Error(`Invalid ${label}`);
}

/** EN: Validate a trusted capability catalog. 中文：校验受信任的能力目录。 */
export function validateCapabilities(capabilities) {
  if (!Array.isArray(capabilities))
    throw Error("Capabilities must be an array");
  const seen = new Set();
  for (const capability of capabilities) {
    if (
      !capability ||
      typeof capability.name !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(capability.name) ||
      typeof capability.description !== "string" ||
      !capability.description.trim() ||
      seen.has(capability.name)
    )
      throw Error("Invalid or duplicate capability");
    if (
      capability.verifier !== undefined &&
      typeof capability.verifier !== "boolean"
    )
      throw Error("Invalid capability verifier flag");
    validateFieldList(
      capability.required_input_fields,
      "required_input_fields",
    );
    validateFieldList(
      capability.required_output_fields,
      "required_output_fields",
    );
    if (capability.allowed_context_prefixes !== undefined) {
      if (
        !Array.isArray(capability.allowed_context_prefixes) ||
        capability.allowed_context_prefixes.length > 20 ||
        capability.allowed_context_prefixes.some(
          (p) => typeof p !== "string" || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(p),
        ) ||
        new Set(capability.allowed_context_prefixes).size !==
          capability.allowed_context_prefixes.length
      )
        throw Error("Invalid allowed_context_prefixes");
    }
    seen.add(capability.name);
  }
}

/** EN: Normalize and validate an acyclic request-local task graph before writes.
 * 中文：写入前规范化并校验请求内的有向无环任务图，拒绝悬空依赖。
 */
export function validatePlan(requestId, plan) {
  if (typeof requestId !== "string" || !/^[\w-]{8,80}$/.test(requestId))
    throw Error("Invalid request id");
  if (
    !Array.isArray(plan?.tasks) ||
    !plan.tasks.length ||
    plan.tasks.length > 100
  )
    throw Error("Expected 1 to 100 tasks");
  if (
    plan.trace_id !== undefined &&
    (typeof plan.trace_id !== "string" ||
      !/^[\w.:-]{8,128}$/.test(plan.trace_id))
  )
    throw Error("Invalid trace_id");
  let budget;
  if (plan.budget !== undefined) {
    if (
      !plan.budget ||
      typeof plan.budget !== "object" ||
      Array.isArray(plan.budget)
    )
      throw Error("Invalid plan budget");
    const { max_tokens: maxTokens, max_cost_usd: maxCostUsd } = plan.budget;
    if (maxTokens === undefined && maxCostUsd === undefined)
      throw Error("Invalid plan budget");
    if (
      maxTokens !== undefined &&
      (!Number.isSafeInteger(maxTokens) || maxTokens < 1)
    )
      throw Error("Invalid max_tokens budget");
    if (
      maxCostUsd !== undefined &&
      (typeof maxCostUsd !== "number" ||
        !Number.isFinite(maxCostUsd) ||
        maxCostUsd <= 0)
    )
      throw Error("Invalid max_cost_usd budget");
    budget = {
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(maxCostUsd !== undefined ? { max_cost_usd: maxCostUsd } : {}),
    };
  }
  const tasks = plan.tasks
    .map((task) => {
      if (
        !task ||
        typeof task.id !== "string" ||
        !/^[\w-]{1,80}$/.test(task.id) ||
        typeof task.capability !== "string" ||
        !/^[a-z][a-z0-9_.-]{0,63}$/.test(task.capability)
      )
        throw Error("Invalid task");
      const dependencies = task.dependencies ?? [];
      if (
        !Array.isArray(dependencies) ||
        dependencies.some((d) => typeof d !== "string") ||
        new Set(dependencies).size !== dependencies.length
      )
        throw Error("Invalid dependencies");
      const input = task.input ?? {};
      if (
        task.priority !== undefined &&
        (!Number.isSafeInteger(task.priority) ||
          task.priority < -10 ||
          task.priority > 100)
      )
        throw Error("Invalid task priority");
      if (
        task.require_verified_facts !== undefined &&
        typeof task.require_verified_facts !== "boolean"
      )
        throw Error("require_verified_facts must be boolean");
      if (
        task.min_fact_confidence !== undefined &&
        (typeof task.min_fact_confidence !== "number" ||
          !Number.isFinite(task.min_fact_confidence) ||
          task.min_fact_confidence <= 0 ||
          task.min_fact_confidence > 1)
      )
        throw Error("Invalid min_fact_confidence");
      if (
        task.min_worker_pass_rate !== undefined &&
        (typeof task.min_worker_pass_rate !== "number" ||
          !Number.isFinite(task.min_worker_pass_rate) ||
          task.min_worker_pass_rate <= 0 ||
          task.min_worker_pass_rate > 1)
      )
        throw Error("Invalid min_worker_pass_rate");
      if (
        task.fact_key !== undefined &&
        (typeof task.fact_key !== "string" ||
          !/^[a-z][a-z0-9_.:-]{0,119}$/.test(task.fact_key))
      )
        throw Error("Invalid fact_key");
      if (
        task.fact_ttl_seconds !== undefined &&
        (!Number.isSafeInteger(task.fact_ttl_seconds) ||
          task.fact_ttl_seconds < 1 ||
          task.fact_ttl_seconds > 31_536_000)
      )
        throw Error("Invalid fact_ttl_seconds");
      const contextKeys = task.context_keys ?? [];
      if (
        !Array.isArray(contextKeys) ||
        contextKeys.length > 20 ||
        contextKeys.some(
          (k) => typeof k !== "string" || !/^[a-z][a-z0-9_.:-]{0,119}$/.test(k),
        ) ||
        new Set(contextKeys).size !== contextKeys.length
      )
        throw Error("Invalid context_keys");
      if (
        task.context_query !== undefined &&
        (typeof task.context_query !== "string" ||
          !task.context_query.trim() ||
          task.context_query.length > 200)
      )
        throw Error("Invalid context_query");
      if (typeof input !== "object" || Array.isArray(input))
        throw Error("Task input must be an object");
      // EN: Round-trip once to detach caller state and enforce JSON transport.
      // 中文：通过 JSON 往返隔离调用方对象，确保与网络传输语义一致。
      const encoded = JSON.stringify(input);
      if (encoded === undefined)
        throw Error("Task input must be a JSON object");
      if (encoded.length > 100_000) throw Error("Task input too large");
      const detached = JSON.parse(encoded);
      if (!detached || typeof detached !== "object" || Array.isArray(detached))
        throw Error("Task input must be a JSON object");
      return {
        id: task.id,
        capability: task.capability,
        input: detached,
        dependencies: [...dependencies].sort(),
        // Omit defaults to preserve idempotency with plans stored before these options.
        ...(task.priority ? { priority: task.priority } : {}),
        ...(task.require_verified_facts
          ? { require_verified_facts: true }
          : {}),
        ...(task.min_fact_confidence !== undefined
          ? { min_fact_confidence: task.min_fact_confidence }
          : {}),
        ...(task.min_worker_pass_rate !== undefined
          ? { min_worker_pass_rate: task.min_worker_pass_rate }
          : {}),
        ...(task.fact_key ? { fact_key: task.fact_key } : {}),
        ...(task.fact_ttl_seconds
          ? { fact_ttl_seconds: task.fact_ttl_seconds }
          : {}),
        ...(contextKeys.length
          ? { context_keys: [...contextKeys].sort() }
          : {}),
        ...(task.context_query
          ? { context_query: task.context_query.trim() }
          : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length) throw Error("Duplicate task id");
  const done = new Set(),
    active = new Set();
  function visit(id) {
    if (!byId.has(id)) throw Error("Unknown dependency");
    if (active.has(id)) throw Error("Cyclic dependencies");
    if (done.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    active.delete(id);
    done.add(id);
  }
  for (const task of tasks) visit(task.id);
  return {
    tasks,
    ...(budget ? { budget } : {}),
    ...(plan.trace_id ? { trace_id: plan.trace_id } : {}),
  };
}

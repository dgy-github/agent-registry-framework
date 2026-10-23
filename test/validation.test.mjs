import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCapabilities,
  validatePlan,
  Scheduler,
  Planner,
  buildAgentMessages,
  createLlmWorkerHandler,
  createMcpToolHandler,
  parseCron,
  nextCronDate,
  validateTriggerSpec,
  DEFAULT_HARNESS_GENOME,
  resolveAndValidateGenome,
  changedGenomeSurfaces,
  changedGenomeLines,
  criticCheckCandidate,
  evaluateDualChannelGate,
  pickStagnationSurface,
  jeffreysSmooth,
  wilsonLowerBound,
  calibrateArmStats,
  comparePairedArms,
  extractMemoryNamespace,
  betaFeedbackMultiplier,
} from "../src/index.mjs";

const task = (id, dependencies = []) => ({
  id,
  capability: "research",
  dependencies,
});
test("capability names cannot rely on implicit string coercion", () => {
  for (const name of [undefined, null, true, { toString: () => "research" }]) {
    assert.throws(
      () => validateCapabilities([{ name, description: "Research" }]),
      /Invalid/,
    );
  }
});

test("task input must remain an object after JSON serialization", () => {
  for (const input of [
    new Date(),
    { toJSON: () => null },
    { toJSON: () => [] },
    { toJSON: () => "text" },
    { toJSON: () => undefined },
  ]) {
    assert.throws(
      () => validatePlan("request-123", { tasks: [{ ...task("a"), input }] }),
      /Task input/,
    );
  }
  const normalized = validatePlan("request-123", {
    tasks: [{ ...task("a"), input: { toJSON: () => ({ text: "valid" }) } }],
  });
  assert.deepEqual(normalized.tasks[0].input, { text: "valid" });
});
test("verification gates and organizational memory keys are strict and preserve legacy plan idempotency", () => {
  const normalize = (extra) =>
    validatePlan("request-123", {
      tasks: [{ ...task("a"), ...extra }],
    });
  assert.deepEqual(
    normalize({ require_verified_facts: false, context_keys: [], priority: 0 }),
    normalize({}),
  );
  const enriched = normalize({
    require_verified_facts: true,
    min_fact_confidence: 0.85,
    priority: 10,
    fact_key: "policy.shipping.2026",
    fact_ttl_seconds: 3600,
    context_keys: ["user.tier", "policy.tax"],
  }).tasks[0];
  assert.equal(enriched.require_verified_facts, true);
  assert.equal(enriched.min_fact_confidence, 0.85);
  assert.equal(enriched.priority, 10);
  assert.equal(enriched.fact_key, "policy.shipping.2026");
  assert.equal(enriched.fact_ttl_seconds, 3600);
  assert.deepEqual(enriched.context_keys, ["policy.tax", "user.tier"]);
  const withBudget = validatePlan("request-123", {
    trace_id: "trace.root:2026-10",
    budget: { max_tokens: 5000, max_cost_usd: 0.25 },
    tasks: [task("a")],
  });
  assert.equal(withBudget.trace_id, "trace.root:2026-10");
  assert.deepEqual(withBudget.budget, {
    max_tokens: 5000,
    max_cost_usd: 0.25,
  });
  for (const value of [null, 1, "true", {}, []]) {
    assert.throws(
      () => normalize({ require_verified_facts: value }),
      /boolean/,
    );
  }
  for (const badPriority of [-1001, 1001, 1.5, "10"]) {
    assert.throws(() => normalize({ priority: badPriority }), /priority/);
  }
  for (const badConf of [-0.1, 0, 1.1, "0.8", NaN]) {
    assert.throws(
      () => normalize({ min_fact_confidence: badConf }),
      /min_fact_confidence/,
    );
    assert.throws(
      () => normalize({ min_worker_pass_rate: badConf }),
      /min_worker_pass_rate/,
    );
  }
  assert.equal(
    normalize({ min_worker_pass_rate: 0.85 }).tasks[0].min_worker_pass_rate,
    0.85,
  );
  assert.equal(
    normalize({ context_query: "  battery policy  " }).tasks[0].context_query,
    "battery policy",
  );
  for (const badQuery of ["", "   ", 123, "x".repeat(201)]) {
    assert.throws(
      () => normalize({ context_query: badQuery }),
      /context_query/,
    );
  }
  for (const badTrace of ["short", "bad trace", 123]) {
    assert.throws(
      () =>
        validatePlan("request-123", { trace_id: badTrace, tasks: [task("a")] }),
      /trace_id/,
    );
  }
  for (const badKey of ["", "Bad Key", 123, "x".repeat(121)]) {
    assert.throws(() => normalize({ fact_key: badKey }), /fact_key/);
    assert.throws(() => normalize({ context_keys: [badKey] }), /context_keys/);
  }
  for (const badTtl of [0, -1, 1.5, "3600", 40_000_000]) {
    assert.throws(
      () => normalize({ fact_ttl_seconds: badTtl }),
      /fact_ttl_seconds/,
    );
  }
  for (const badBudget of [
    null,
    [],
    {},
    { max_tokens: 0 },
    { max_cost_usd: -0.1 },
  ]) {
    assert.throws(
      () =>
        validatePlan("request-123", { budget: badBudget, tasks: [task("a")] }),
      /budget/,
    );
  }
  assert.throws(
    () => normalize({ context_keys: ["dup.key", "dup.key"] }),
    /context_keys/,
  );
});
test("fact review, expand, cancel and enable reject malformed inputs before opening a transaction", async () => {
  const noStorage = {
    _validateReviewArgs: Scheduler.prototype._validateReviewArgs,
    tx() {
      throw Error("unexpected storage access");
    },
  };
  const review = Scheduler.prototype.reviewFact.bind(noStorage);
  for (const args of [
    ["task", 0, true, "checked"],
    ["task", 1.5, true, "checked"],
    ["task", 1, "true", "checked"],
    ["task", 1, true, "  "],
    ["task", 1, false, "x".repeat(4001)],
    [null, 1, true, "checked"],
    ["task", 1, true, "checked", { rework: true }],
    ["task", 1, false, "checked", { rework: "yes" }],
    ["task", 1, true, "checked", { confidence: 1.5 }],
    ["task", 1, true, "checked", { confidence: -0.1 }],
    ["task", 1, true, "checked", { ttlSeconds: 0 }],
  ])
    await assert.rejects(review(...args), /Invalid fact review/);
  const verifierReview =
    Scheduler.prototype.reviewFactByVerifier.bind(noStorage);
  await assert.rejects(
    verifierReview("bad", "verify", "task", 1, true, "ok"),
    /Invalid worker/,
  );
  const expand = Scheduler.prototype.expand.bind(noStorage);
  for (const args of [
    ["short", "expansion-123", "parent-1", { tasks: [task("a")] }],
    ["request-123", "short", "parent-1", { tasks: [task("a")] }],
    ["request-123", "expansion-123", "", { tasks: [task("a")] }],
    [
      "request-123",
      "expansion-123",
      "parent-1",
      { tasks: [task("a")] },
      { rewireDependents: "yes" },
    ],
  ])
    await assert.rejects(expand(...args));
  const cancel = Scheduler.prototype.cancel.bind(noStorage);
  for (const id of [undefined, null, "", 123, "x".repeat(101)])
    await assert.rejects(cancel(id), /Invalid task id/);
  const enable = Scheduler.prototype.enable.bind(noStorage);
  for (const args of [
    ["", true],
    [null, false],
    ["worker-one", "false"],
    ["x".repeat(101), true],
  ])
    await assert.rejects(enable(...args), /Invalid worker state/);
  const claim = Scheduler.prototype.claim.bind(noStorage);
  for (const waitMs of [-1, 1.5, 40_000, "100"])
    await assert.rejects(
      claim("worker-one", "research", { waitMs }),
      /Invalid wait_ms/,
    );
});
test("arbitrary capability catalogs and normalized, detached graphs", () => {
  validateCapabilities([
    {
      name: "research",
      description: "Research / 研究",
      verifier: true,
      required_input_fields: ["query"],
      required_output_fields: ["summary"],
      allowed_context_prefixes: ["policy.", "user."],
    },
  ]);
  const input = { query: "hello" };
  const plan = validatePlan("request-123", {
    tasks: [task("b", ["a"]), { ...task("a"), input }],
  });
  input.query = "changed";
  assert.equal(plan.tasks[0].input.query, "hello");
  assert.deepEqual(
    plan.tasks.map((t) => t.id),
    ["a", "b"],
  );
});
test("invalid catalogs, duplicate ids, missing dependencies and cycles fail before storage", () => {
  assert.throws(() =>
    validateCapabilities([
      { name: "x", description: "x" },
      { name: "x", description: "y" },
    ]),
  );
  assert.throws(() =>
    validateCapabilities([{ name: "Bad name", description: "x" }]),
  );
  assert.throws(() =>
    validateCapabilities([{ name: "x", description: "x", verifier: "yes" }]),
  );
  assert.throws(() =>
    validateCapabilities([
      { name: "x", description: "x", required_input_fields: ["bad-field"] },
    ]),
  );
  assert.throws(() =>
    validateCapabilities([
      { name: "x", description: "x", allowed_context_prefixes: ["bad prefix"] },
    ]),
  );
  for (const tasks of [
    [task("a"), task("a")],
    [task("a", ["absent"])],
    [task("a", ["a"])],
    [task("a", ["b"]), task("b", ["a"])],
  ]) {
    assert.throws(() => validatePlan("request-123", { tasks }));
  }
  assert.throws(() => validatePlan("short", { tasks: [task("a")] }));
  assert.throws(() => validatePlan("request-123", { tasks: [] }));
  assert.throws(() =>
    validatePlan("request-123", { tasks: [{ ...task("a"), input: [] }] }),
  );
  assert.throws(() => new Scheduler({}, { schema: "unsafe;drop" }));
  assert.throws(() => new Scheduler({}, { capacity: 0 }));
  assert.throws(() => new Scheduler({}, { maxConsecutiveFailures: 0 }));
  assert.throws(() => new Scheduler({}, { lease: 10, deadline: 1 }));
});
test("Planner, LLM/MCP Worker adapters and Cron/Trigger specs validate contracts strictly", async () => {
  const parsedCron = parseCron("*/15 9-17 * * 1-5");
  assert.ok(parsedCron.minute.has(15));
  assert.ok(parsedCron.hour.has(9));
  const next = nextCronDate(
    "30 10 * * *",
    new Date("2026-10-18T10:00:00.000Z"),
  );
  assert.equal(next.toISOString(), "2026-10-18T10:30:00.000Z");
  assert.throws(() => parseCron("invalid cron"));
  assert.throws(() =>
    validateTriggerSpec("trig-1", {
      plan: { tasks: [task("a")] },
    }),
  );
  const trigSpec = validateTriggerSpec(
    "trig-valid-1",
    {
      description: "Daily check",
      cron: "0 8 * * *",
      webhook: true,
      plan: { tasks: [task("a")] },
    },
    new Date("2026-10-18T07:00:00.000Z"),
  );
  assert.equal(trigSpec.next_run_at.toISOString(), "2026-10-18T08:00:00.000Z");

  const planner = new Planner({
    capabilities: [
      {
        name: "research",
        description: "Research topics",
        required_input_fields: ["topic"],
      },
      {
        name: "compose",
        description: "Compose report",
        allowed_context_prefixes: ["org."],
      },
    ],
  });
  const compiled = await planner.plan("Research and compose report", {
    requestId: "req-plan-123",
    memory: [{ fact_key: "org.prev" }, { fact_key: "secret.key" }],
  });
  assert.equal(compiled.plan.tasks.length, 2);
  assert.equal(
    compiled.plan.tasks[0].input.topic,
    "Research and compose report",
  );
  // Only 'org.' prefixed memory keys are injected into compose's context_keys
  assert.ok(
    compiled.plan.tasks[1].context_keys.every((k) => k.startsWith("org.")),
  );

  // LLM Worker Handler with rework history & usage reporting
  let capturedUsage = null;
  let capturedMessages = null;
  const llmHandler = createLlmWorkerHandler({
    requiredOutputFields: ["summary"],
    complete: async (messages) => {
      capturedMessages = messages;
      return {
        output: { summary: "fixed after rework" },
        usage: {
          input_tokens: 50,
          output_tokens: 25,
          total_tokens: 75,
          cost_usd: 0.001,
        },
      };
    },
  });
  const llmOut = await llmHandler(
    {
      task_id: "t-1",
      capability: "research",
      attempt: 2,
      input: { topic: "ai" },
      facts: [],
      prior_facts: [
        { version: 1, value: { summary: "bad" }, review_note: "Fix citations" },
      ],
      context_facts: [],
    },
    {
      signal: AbortSignal.timeout(5000),
      reportUsage: (u) => {
        capturedUsage = u;
      },
    },
  );
  assert.deepEqual(llmOut, { summary: "fixed after rework" });
  assert.equal(capturedUsage.total_tokens, 75);
  assert.match(capturedMessages[0].content, /previous attempt was rejected/);

  // MCP Tool Worker Handler
  const mcpHandler = createMcpToolHandler({
    toolName: "search_docs",
    client: {
      callTool: async ({ name, arguments: args }) => ({
        content: [
          { type: "text", text: JSON.stringify({ tool: name, q: args.query }) },
        ],
      }),
    },
  });
  const mcpOut = await mcpHandler(
    {
      task_id: "t-2",
      capability: "research",
      input: { query: "mcp" },
      facts: [],
      context_facts: [],
    },
    { signal: AbortSignal.timeout(5000), reportUsage: () => {} },
  );
  assert.deepEqual(mcpOut, { tool: "search_docs", q: "mcp" });
});

test("v1.5 RRSI & Harness²: Genome surfaces, annealed edit budget, critic, dual-channel gate, and paired statistical evaluation", () => {
  // P2: Empty genome is 100% byte-identical no-op to DEFAULT_HARNESS_GENOME
  const emptyResolved = resolveAndValidateGenome({});
  assert.deepEqual(emptyResolved, DEFAULT_HARNESS_GENOME);
  assert.deepEqual(changedGenomeSurfaces(emptyResolved), []);
  assert.equal(changedGenomeLines(emptyResolved), 0);

  // Frozen security boundaries are strictly blocked
  assert.throws(
    () => resolveAndValidateGenome({ disable_verifier: true }),
    /Frozen security boundary violation/,
  );
  assert.throws(
    () =>
      resolveAndValidateGenome({
        planner_prompts: { allow_self_review: "yes" },
      }),
    /Frozen security boundary violation/,
  );

  // Surface-level diffing & annealed edit budget (P1.1)
  const candMulti = {
    memory_config: { max_entries: 4, max_chars: 1800 },
    expansion_config: { max_tasks_per_expansion: 10 },
  };
  const diffSurfaces = changedGenomeSurfaces(candMulti);
  assert.deepEqual(diffSurfaces, [
    "expansion_config:max_tasks_per_expansion",
    "memory_config:max_chars",
    "memory_config:max_entries",
  ]);
  assert.throws(
    () =>
      resolveAndValidateGenome(candMulti, {
        parent: DEFAULT_HARNESS_GENOME,
        maxSurfaces: 2,
      }),
    /Edit budget exceeded: changed 3 surfaces > limit 2/,
  );
  // Annealed surfaces: at round 4 with maxSurfaces=3, limit anneals to max(1, 3 - floor(4/2)) = 1
  assert.throws(
    () =>
      resolveAndValidateGenome(
        { memory_config: { max_entries: 4, max_chars: 1800 } },
        {
          parent: DEFAULT_HARNESS_GENOME,
          maxSurfaces: 3,
          round: 4,
          annealSurfaces: true,
        },
      ),
    /Edit budget exceeded: changed 2 surfaces > limit 1/,
  );

  // P1.2 Anti-overfitting / anti-cheating critic
  assert.equal(
    criticCheckCandidate(
      { prompt: "Check sqlparse-496 before answering" },
      { forbiddenTerms: ["sqlparse-496"] },
    ).verdict,
    "rejected_critic",
  );
  assert.equal(
    criticCheckCandidate({ prompt: "Inspect check.py for test answers" })
      .verdict,
    "rejected_critic",
  );
  assert.equal(
    criticCheckCandidate({ prompt: "General modular verification rule" }).ok,
    true,
  );

  // P1.4 Dual-Channel Cost-Aware Gate
  // Channel 1: Quality gain accepted if within maxTokenGrowth, rejected if bloated
  const bloatRes = evaluateDualChannelGate(
    { pass_rate: 0.7, mean_tokens: 1000 },
    { pass_rate: 0.85, mean_tokens: 1800 },
    { deltaPass: 0.05, maxTokenGrowth: 500 },
  );
  assert.equal(bloatRes.accepted, false);
  assert.equal(bloatRes.verdict, "rejected_token_bloat");

  const qualRes = evaluateDualChannelGate(
    { pass_rate: 0.7, mean_tokens: 1000 },
    { pass_rate: 0.8, mean_tokens: 1200 },
    { deltaPass: 0.05, maxTokenGrowth: 500 },
  );
  assert.equal(qualRes.accepted, true);
  assert.equal(qualRes.channel, "quality_gain");

  // Channel 2: Same pass rate (or non-inferior within deltaPass) with significant token reduction
  const costRes = evaluateDualChannelGate(
    { pass_rate: 0.8, mean_tokens: 1500 },
    { pass_rate: 0.78, mean_tokens: 1100 },
    { deltaPass: 0.05, deltaTokens: 200 },
  );
  assert.equal(costRes.accepted, true);
  assert.equal(costRes.channel, "cost_reduction");
  assert.equal(costRes.verdict, "accepted_cost_reduction");

  // P0: Single-arm calibration & Paired Bootstrap + McNemar comparison
  const armA = Array.from({ length: 9 }, (_, i) => ({
    id: `tab-${i + 1}`,
    runs: 3,
    resolved: i < 7 ? 3 : 0,
    cost_usd: 0.22,
    total_tokens: 2200,
    costs: [0.21, 0.22, 0.23],
  }));
  const armB = Array.from({ length: 9 }, (_, i) => ({
    id: `tab-${i + 1}`,
    runs: 3,
    resolved: i < 7 ? 3 : i === 7 ? 1 : 0,
    cost_usd: 0.16,
    total_tokens: 1600,
    costs: [0.15, 0.16, 0.17],
  }));
  const cal = calibrateArmStats(armB, { rounds: 3 });
  assert.deepEqual(cal.informative_tasks, ["tab-8"]);
  assert.ok(cal.delta_pass_rate > 0);

  const cmp = comparePairedArms(armA, armB, { seed: 42 });
  assert.equal(cmp.non_inferiority_passed, true);
  assert.ok(cmp.cost_per_resolved_ratio_b_over_a < 0.85);
  assert.ok(cmp.cost_per_resolved_ratio_ci95[1] < 1.0);
  assert.equal(cmp.significant_cost_reduction, true);

  // P3 helpers: namespace extraction & Beta posterior multiplier
  assert.equal(
    extractMemoryNamespace("org.policy.eu_battery_2026"),
    "org.policy",
  );
  assert.equal(
    extractMemoryNamespace("org.policy.__invariant__"),
    "org.policy",
  );
  const lowBeta = betaFeedbackMultiplier(0, 10);
  assert.equal(lowBeta.should_demote, true);
  assert.ok(lowBeta.multiplier >= 0.8 && lowBeta.multiplier < 0.9);
});

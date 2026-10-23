/** EN: Regularized Self-Evolving Harness (Google RRSI / ReSelf & Harness² Theory) —
 * P0 Noise-Calibrated Evaluation & Cost-per-Verified Pairing,
 * P1 Annealed Edit Budgets, Anti-Overfitting Critic, Falsified Ledger & Dual-Channel Gate,
 * P2 Multi-Surface HarnessGenome with Frozen Security Boundaries,
 * P3 Two-Tier Memory (Module Invariants vs Episodic) & Cost-Aware Attribution.
 * 中文：自进化 Harness 正则化引擎（对齐 Google RRSI / ReSelf 与 Harness² 框架理论）。
 */

export const DEFAULT_HARNESS_GENOME = Object.freeze({
  planner_prompts: Object.freeze({
    system_prompt:
      "You are an AIOS DAG Planner for agent-registry-framework. Output ONLY a JSON object with { tasks: [...] } matching the capability catalog and input/context contracts.",
    expansion_prompt:
      "Synthesize a minimal, acyclic follow-up sub-DAG from the upstream verified fact without repeating falsified hypotheses.",
  }),
  adapter_prompts: Object.freeze({
    worker_system_prompt:
      "You are a reliable capability worker. Respond with a valid JSON object.",
    rework_directive:
      "IMPORTANT: Your previous attempt was rejected during verification. Carefully address every issue in rework_history[].rejected_reason.",
  }),
  memory_config: Object.freeze({
    max_entries: 6,
    max_chars: 2400,
    max_episodic_per_namespace: 2,
    invariant_boost: 6,
    expensive_token_threshold: 4000,
  }),
  expansion_config: Object.freeze({
    max_tasks_per_expansion: 20,
    anneal_step: 0,
  }),
});

const FROZEN_SECURITY_KEYS = new Set([
  "disable_verifier",
  "allow_self_review",
  "bypass_acl",
  "disable_lease_fencing",
  "skip_verified_facts",
  "ignore_budget",
]);

const CRITIC_FORBIDDEN_SUBSTRINGS = [
  "__eval_holdout__",
  "eval_holdout",
  "hidden_test",
  "hidden test",
  "check.py",
  "_check.py",
  "bypass_verifier",
  "self_review_override",
  "mock_judge_pass",
];

function clampInt(val, min, max, fallback) {
  if (val === undefined || val === null) return fallback;
  if (!Number.isSafeInteger(val) || val < min || val > max) {
    throw Error(`Genome integer out of bounds [${min}, ${max}]: ${val}`);
  }
  return val;
}

/** EN: Merge and validate a partial or full HarnessGenome against baseline defaults and frozen security boundaries.
 * Byte-identical no-op guarantee when candidate is null/undefined/{}.
 * 中文：校验并合并可进化基因组表面，强制拦截任何触碰安全边界的修改，空对象时保证 100% 字节级默认等价。
 */
export function resolveAndValidateGenome(
  candidate = {},
  {
    parent = null,
    maxSurfaces = null,
    maxChangedLines = null,
    round = 0,
    annealSurfaces = false,
  } = {},
) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw Error("Invalid genome object");
  }
  for (const key of Object.keys(candidate)) {
    if (FROZEN_SECURITY_KEYS.has(key)) {
      throw Error(`Frozen security boundary violation: ${key}`);
    }
    if (!Object.hasOwn(DEFAULT_HARNESS_GENOME, key)) {
      throw Error(`Unknown genome surface group: ${key}`);
    }
  }

  const pp = candidate.planner_prompts ?? {};
  const ap = candidate.adapter_prompts ?? {};
  const mc = candidate.memory_config ?? {};
  const ec = candidate.expansion_config ?? {};
  for (const sub of [pp, ap, mc, ec]) {
    if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
      throw Error("Invalid genome surface group value");
    }
    for (const k of Object.keys(sub)) {
      if (FROZEN_SECURITY_KEYS.has(k)) {
        throw Error(`Frozen security boundary violation: ${k}`);
      }
    }
  }

  for (const k of Object.keys(pp)) {
    if (!Object.hasOwn(DEFAULT_HARNESS_GENOME.planner_prompts, k))
      throw Error(`Unknown planner_prompts surface: ${k}`);
    if (
      typeof pp[k] !== "string" ||
      !pp[k].trim() ||
      pp[k].length > DEFAULT_HARNESS_GENOME.planner_prompts[k].length + 600
    ) {
      throw Error(`Invalid planner_prompts.${k}`);
    }
  }
  for (const k of Object.keys(ap)) {
    if (!Object.hasOwn(DEFAULT_HARNESS_GENOME.adapter_prompts, k))
      throw Error(`Unknown adapter_prompts surface: ${k}`);
    if (
      typeof ap[k] !== "string" ||
      !ap[k].trim() ||
      ap[k].length > DEFAULT_HARNESS_GENOME.adapter_prompts[k].length + 600
    ) {
      throw Error(`Invalid adapter_prompts.${k}`);
    }
  }
  for (const k of Object.keys(mc)) {
    if (!Object.hasOwn(DEFAULT_HARNESS_GENOME.memory_config, k))
      throw Error(`Unknown memory_config surface: ${k}`);
  }
  for (const k of Object.keys(ec)) {
    if (!Object.hasOwn(DEFAULT_HARNESS_GENOME.expansion_config, k))
      throw Error(`Unknown expansion_config surface: ${k}`);
  }

  const resolved = {
    planner_prompts: {
      system_prompt:
        pp.system_prompt ??
        DEFAULT_HARNESS_GENOME.planner_prompts.system_prompt,
      expansion_prompt:
        pp.expansion_prompt ??
        DEFAULT_HARNESS_GENOME.planner_prompts.expansion_prompt,
    },
    adapter_prompts: {
      worker_system_prompt:
        ap.worker_system_prompt ??
        DEFAULT_HARNESS_GENOME.adapter_prompts.worker_system_prompt,
      rework_directive:
        ap.rework_directive ??
        DEFAULT_HARNESS_GENOME.adapter_prompts.rework_directive,
    },
    memory_config: {
      max_entries: clampInt(
        mc.max_entries,
        1,
        32,
        DEFAULT_HARNESS_GENOME.memory_config.max_entries,
      ),
      max_chars: clampInt(
        mc.max_chars,
        200,
        16000,
        DEFAULT_HARNESS_GENOME.memory_config.max_chars,
      ),
      max_episodic_per_namespace: clampInt(
        mc.max_episodic_per_namespace,
        1,
        10,
        DEFAULT_HARNESS_GENOME.memory_config.max_episodic_per_namespace,
      ),
      invariant_boost: clampInt(
        mc.invariant_boost,
        0,
        20,
        DEFAULT_HARNESS_GENOME.memory_config.invariant_boost,
      ),
      expensive_token_threshold: clampInt(
        mc.expensive_token_threshold,
        100,
        200000,
        DEFAULT_HARNESS_GENOME.memory_config.expensive_token_threshold,
      ),
    },
    expansion_config: {
      max_tasks_per_expansion: clampInt(
        ec.max_tasks_per_expansion,
        1,
        50,
        DEFAULT_HARNESS_GENOME.expansion_config.max_tasks_per_expansion,
      ),
      anneal_step: clampInt(
        ec.anneal_step,
        0,
        10,
        DEFAULT_HARNESS_GENOME.expansion_config.anneal_step,
      ),
    },
  };

  if (parent) {
    const parentResolved = resolveAndValidateGenome(parent);
    const surfaces = changedGenomeSurfaces(resolved, parentResolved);
    const lines = changedGenomeLines(resolved, parentResolved);
    const effectiveMaxSurfaces =
      maxSurfaces !== null && maxSurfaces !== undefined
        ? annealSurfaces
          ? Math.max(1, maxSurfaces - Math.floor(Math.max(0, round) / 2))
          : maxSurfaces
        : null;
    if (
      effectiveMaxSurfaces !== null &&
      surfaces.length > effectiveMaxSurfaces
    ) {
      throw Error(
        `Edit budget exceeded: changed ${surfaces.length} surfaces > limit ${effectiveMaxSurfaces}`,
      );
    }
    if (
      maxChangedLines !== null &&
      maxChangedLines !== undefined &&
      lines > maxChangedLines
    ) {
      throw Error(
        `Edit budget exceeded: changed ${lines} lines > limit ${maxChangedLines}`,
      );
    }
  }

  return resolved;
}

/** EN: Enumerate all leaf surface identifiers (`group:key`) that differ between two genomes.
 * 中文：枚举两个基因组之间发生变更的全部叶子表面标识符（如 `planner_prompts:system_prompt`）。
 */
export function changedGenomeSurfaces(
  candidate,
  reference = DEFAULT_HARNESS_GENOME,
) {
  const cand = resolveAndValidateGenome(candidate);
  const ref = resolveAndValidateGenome(reference);
  const changed = [];
  for (const group of Object.keys(DEFAULT_HARNESS_GENOME)) {
    for (const key of Object.keys(DEFAULT_HARNESS_GENOME[group])) {
      if (cand[group][key] !== ref[group][key]) {
        changed.push(`${group}:${key}`);
      }
    }
  }
  return changed.sort();
}

/** EN: Count added/modified non-empty lines across all surfaces between candidate and reference.
 * 中文：统计候选基因组相对于参考基因组新增或修改的非空行数。
 */
export function changedGenomeLines(
  candidate,
  reference = DEFAULT_HARNESS_GENOME,
) {
  const cand = resolveAndValidateGenome(candidate);
  const ref = resolveAndValidateGenome(reference);
  let total = 0;
  for (const group of Object.keys(DEFAULT_HARNESS_GENOME)) {
    for (const key of Object.keys(DEFAULT_HARNESS_GENOME[group])) {
      const cVal = String(cand[group][key]);
      const rVal = String(ref[group][key]);
      if (cVal === rVal) continue;
      const cLines = cVal
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const rSet = new Set(
        rVal
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      );
      for (const l of cLines) {
        if (!rSet.has(l)) total += 1;
      }
      for (const rl of rSet) {
        if (!cLines.includes(rl)) total += 1;
      }
    }
  }
  return total;
}

/** EN: Rule-based anti-overfitting / anti-cheating critic (RRSI G5).
 * Rejects candidates that hardcode training request IDs, hidden judge markers, or verification bypass strings.
 * 中文：规则版反过拟合与反作弊审查器（拦截硬编码训练集任务号、隐藏裁判脚本名或跳过核验指令）。
 */
export function criticCheckCandidate(
  candidatePayload,
  { forbiddenTerms = [] } = {},
) {
  const serialized = JSON.stringify(candidatePayload ?? {}).toLowerCase();
  for (const marker of CRITIC_FORBIDDEN_SUBSTRINGS) {
    if (serialized.includes(marker.toLowerCase())) {
      return {
        ok: false,
        verdict: "rejected_critic",
        reason: `Critic blocked forbidden evaluation/bypass marker: ${marker}`,
      };
    }
  }
  for (const term of forbiddenTerms) {
    if (typeof term !== "string" || term.trim().length < 4) continue;
    const clean = term.trim().toLowerCase();
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(serialized)) {
      return {
        ok: false,
        verdict: "rejected_critic",
        reason: `Critic blocked hardcoded task/request identifier: ${term}`,
      };
    }
  }
  return { ok: true, verdict: "passed_critic", reason: null };
}

/** EN: Dual-channel cost-aware acceptance gate (RRSI P1.4).
 * Channel 1 (Quality Gain + Anti-Bloat): pass_rate gain >= deltaPass AND token growth <= maxTokenGrowth.
 * Channel 2 (Cost Reduction under Non-Inferiority): pass_rate gain >= -deltaPass AND token savings >= deltaTokens.
 * Both channels require holdout non-regression when holdout metrics are provided.
 * 中文：RRSI 双通道成本感知验收门（通道 1：通过率提升且无 Token 膨胀；通道 2：非劣效前提下显著降低 Token 开销）。
 */
export function evaluateDualChannelGate(
  incumbentMetrics,
  candidateMetrics,
  { deltaPass = 0.05, deltaTokens = 150, maxTokenGrowth = 500 } = {},
) {
  const incPass = Number(incumbentMetrics?.pass_rate ?? 0);
  const candPass = Number(candidateMetrics?.pass_rate ?? 0);
  const incTokens = Number(incumbentMetrics?.mean_tokens ?? 0);
  const candTokens = Number(candidateMetrics?.mean_tokens ?? 0);

  if (
    incumbentMetrics?.holdout_pass_rate !== undefined &&
    candidateMetrics?.holdout_pass_rate !== undefined
  ) {
    if (
      Number(candidateMetrics.holdout_pass_rate) <
      Number(incumbentMetrics.holdout_pass_rate)
    ) {
      return {
        accepted: false,
        verdict: "rejected_holdout_regression",
        reason: `Holdout pass rate regressed (${candidateMetrics.holdout_pass_rate} < ${incumbentMetrics.holdout_pass_rate})`,
      };
    }
  }

  const passGain = candPass - incPass;
  const tokenGrowth = candTokens - incTokens;
  const tokenSaving = incTokens - candTokens;

  // Channel 1: Significant quality improvement without excessive token bloat
  if (passGain >= deltaPass && passGain > 0) {
    if (tokenGrowth > maxTokenGrowth) {
      return {
        accepted: false,
        verdict: "rejected_token_bloat",
        reason: `Pass rate improved (+${passGain.toFixed(4)}) but token growth (+${tokenGrowth.toFixed(1)}) exceeded maxTokenGrowth (${maxTokenGrowth})`,
      };
    }
    return {
      accepted: true,
      channel: "quality_gain",
      verdict: "accepted_quality",
      reason: `Pass rate improved by +${passGain.toFixed(4)} (>= ${deltaPass}) within token budget`,
    };
  }

  // Channel 2: Non-inferior pass rate with significant token/cost reduction
  if (passGain >= -deltaPass && tokenSaving >= deltaTokens && tokenSaving > 0) {
    return {
      accepted: true,
      channel: "cost_reduction",
      verdict: "accepted_cost_reduction",
      reason: `Token usage reduced by -${tokenSaving.toFixed(1)} (>= ${deltaTokens}) while maintaining non-inferior pass rate (delta=${passGain.toFixed(4)})`,
    };
  }

  return {
    accepted: false,
    verdict: "rejected_insufficient_gain",
    reason: `Neither quality gain (${passGain.toFixed(4)} < ${deltaPass}) nor token reduction (${tokenSaving.toFixed(1)} < ${deltaTokens}) met RRSI acceptance thresholds`,
  };
}

/** EN: Select the least-explored genome surface when evolution stagnates for S consecutive rounds (RRSI P1.8).
 * 中文：停滞自动转向（统计实验账本中各表面尝试次数，选出探索最少的表面作为下一轮聚焦目标）。
 */
export function pickStagnationSurface(ledgerEntries = []) {
  const allSurfaces = [];
  for (const group of Object.keys(DEFAULT_HARNESS_GENOME)) {
    for (const key of Object.keys(DEFAULT_HARNESS_GENOME[group])) {
      allSurfaces.push(`${group}:${key}`);
    }
  }
  const counts = new Map(allSurfaces.map((s) => [s, 0]));
  for (const entry of ledgerEntries) {
    for (const s of entry.target_surfaces || []) {
      if (counts.has(s)) counts.set(s, counts.get(s) + 1);
    }
  }
  return allSurfaces.sort(
    (a, b) => counts.get(a) - counts.get(b) || a.localeCompare(b),
  )[0];
}

/** EN: Jeffreys smoothed Bernoulli parameter p = (k + 0.5) / (n + 1).
 * 中文：Jeffreys 平滑伯努利参数估计，消除小样本全过/全挂的零方差退化。
 */
export function jeffreysSmooth(k, n) {
  const cleanN = Math.max(0, Number(n || 0));
  const cleanK = Math.max(0, Math.min(cleanN, Number(k || 0)));
  return Number(((cleanK + 0.5) / (cleanN + 1)).toFixed(4));
}

/** EN: Wilson 95% confidence interval lower bound for proportion k / n.
 * 中文：Wilson 95% 置信区间下界（用于 60 分奇点判定与稳健节点声誉评估）。
 */
export function wilsonLowerBound(k, n, z = 1.96) {
  const cleanN = Number(n || 0);
  if (cleanN <= 0) return 0;
  const cleanK = Math.max(0, Math.min(cleanN, Number(k || 0)));
  const p = cleanK / cleanN;
  const z2 = z * z;
  const denom = 1 + z2 / cleanN;
  const center = p + z2 / (2 * cleanN);
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * cleanN)) / cleanN);
  return Number(Math.max(0, (center - half) / denom).toFixed(4));
}

/** EN: Single-arm noise floor calibration (RRSI P0.1).
 * Computes delta_resolved / delta_pass_rate via Jeffreys variance and delta_cost / delta_tokens via sample variance.
 * 中文：单臂噪声下限校准（输出 informative / always_pass / always_fail 分类及 95% 最小可检出差值 delta）。
 */
export function calibrateArmStats(tasks = [], { rounds = 3 } = {}) {
  const K = Math.max(1, Number(rounds || 3));
  const informative = [];
  const alwaysPass = [];
  const alwaysFail = [];
  let sumBernoulliVar = 0;
  let sumCostVar = 0;
  let sumTokenVar = 0;
  let totalResolved = 0;
  let totalRuns = 0;
  let totalCost = 0;
  let totalTokens = 0;

  for (const item of tasks) {
    const id = item.id || item.task_key || item.capability || "unknown";
    const n = Math.max(1, Number(item.runs ?? item.n ?? 1));
    const k = Math.max(0, Math.min(n, Number(item.resolved ?? item.k ?? 0)));
    if (k > 0 && k < n) informative.push(id);
    else if (k === n) alwaysPass.push(id);
    else alwaysFail.push(id);

    const pJ = (k + 0.5) / (n + 1);
    sumBernoulliVar += pJ * (1 - pJ);
    totalResolved += k;
    totalRuns += n;

    const costs = Array.isArray(item.costs)
      ? item.costs.map(Number)
      : [Number(item.cost_usd ?? 0)];
    const tokens = Array.isArray(item.tokens)
      ? item.tokens.map(Number)
      : [Number(item.total_tokens ?? 0)];

    totalCost += costs.reduce((a, b) => a + b, 0);
    totalTokens += tokens.reduce((a, b) => a + b, 0);

    if (costs.length > 1) {
      const meanC = costs.reduce((a, b) => a + b, 0) / costs.length;
      const varC =
        costs.reduce((acc, c) => acc + (c - meanC) ** 2, 0) /
        (costs.length - 1);
      sumCostVar += varC;
    }
    if (tokens.length > 1) {
      const meanT = tokens.reduce((a, b) => a + b, 0) / tokens.length;
      const varT =
        tokens.reduce((acc, t) => acc + (t - meanT) ** 2, 0) /
        (tokens.length - 1);
      sumTokenVar += varT;
    }
  }

  const N = Math.max(1, tasks.length);
  const deltaResolved = Number(
    (1.96 * Math.sqrt((2 * sumBernoulliVar) / K)).toFixed(4),
  );
  const deltaPassRate = Number((deltaResolved / N).toFixed(4));
  const deltaCost = Number((1.96 * Math.sqrt((2 * sumCostVar) / K)).toFixed(6));
  const deltaTokens = Number(
    (1.96 * Math.sqrt((2 * sumTokenVar) / K)).toFixed(2),
  );

  return {
    task_count: tasks.length,
    rounds: K,
    informative_tasks: informative,
    always_pass_tasks: alwaysPass,
    always_fail_tasks: alwaysFail,
    resolution_rate: totalRuns
      ? Number((totalResolved / totalRuns).toFixed(4))
      : 0,
    cost_per_resolved_usd:
      totalResolved > 0 ? Number((totalCost / totalResolved).toFixed(6)) : null,
    tokens_per_resolved:
      totalResolved > 0 ? Math.round(totalTokens / totalResolved) : null,
    delta_resolved: deltaResolved,
    delta_pass_rate: deltaPassRate,
    delta_cost_usd: deltaCost,
    delta_tokens: deltaTokens,
  };
}

function exactMcNemarPValue(n01, n10) {
  const n = n01 + n10;
  if (n === 0) return 1.0;
  const k = Math.min(n01, n10);
  let cdf = 0;
  let comb = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) comb = (comb * (n - i + 1)) / i;
    cdf += comb;
  }
  const pTwoSided = Math.min(1.0, 2 * cdf * Math.pow(0.5, n));
  return Number(pTwoSided.toFixed(6));
}

function createSeededRng(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** EN: Paired two-arm evaluation (RRSI P0.2 & P0.3):
 * Exact McNemar test + Paired Bootstrap 95% CI (B=2000, seed=42) on `cost_per_resolved` ratio (B / A) + Non-inferiority guard.
 * 中文：双臂逐题配对统计检验（精确 McNemar 检验 + 2000 次固定种子按题配对 Bootstrap 95% 置信区间 + 解决率非劣效护栏）。
 */
export function comparePairedArms(
  armA = [],
  armB = [],
  { bootstrapIterations = 2000, seed = 42, deltaPassRate = null } = {},
) {
  const mapA = new Map(armA.map((x) => [String(x.id ?? x.task_key), x]));
  const mapB = new Map(armB.map((x) => [String(x.id ?? x.task_key), x]));
  const commonIds = [...mapA.keys()].filter((k) => mapB.has(k)).sort();
  if (!commonIds.length) {
    throw Error("No paired task IDs found between armA and armB");
  }

  let n01 = 0;
  let n10 = 0;
  const pairs = commonIds.map((id) => {
    const a = mapA.get(id);
    const b = mapB.get(id);
    const aPass = Number(a.resolved ?? (a.passed ? 1 : 0));
    const bPass = Number(b.resolved ?? (b.passed ? 1 : 0));
    const aRuns = Math.max(1, Number(a.runs ?? 1));
    const bRuns = Math.max(1, Number(b.runs ?? 1));
    const aRate = aPass / aRuns;
    const bRate = bPass / bRuns;
    if (aRate < 0.5 && bRate >= 0.5) n01 += 1;
    else if (aRate >= 0.5 && bRate < 0.5) n10 += 1;
    return {
      id,
      aRate,
      bRate,
      aCost: Number(a.cost_usd ?? 0),
      bCost: Number(b.cost_usd ?? 0),
      aTokens: Number(a.total_tokens ?? 0),
      bTokens: Number(b.total_tokens ?? 0),
    };
  });

  const calA = calibrateArmStats(armA);
  const effectiveDelta =
    deltaPassRate !== null && deltaPassRate !== undefined
      ? Number(deltaPassRate)
      : calA.delta_pass_rate;

  const meanRateA = pairs.reduce((s, p) => s + p.aRate, 0) / pairs.length;
  const meanRateB = pairs.reduce((s, p) => s + p.bRate, 0) / pairs.length;
  const sumCostA = pairs.reduce((s, p) => s + p.aCost, 0);
  const sumCostB = pairs.reduce((s, p) => s + p.bCost, 0);
  const sumPassA = pairs.reduce((s, p) => s + p.aRate, 0);
  const sumPassB = pairs.reduce((s, p) => s + p.bRate, 0);

  const cprA = sumPassA > 0 ? sumCostA / sumPassA : null;
  const cprB = sumPassB > 0 ? sumCostB / sumPassB : null;
  const cprRatio = cprA && cprB !== null ? cprB / cprA : null;

  const rng = createSeededRng(seed);
  const B = Math.max(100, Math.min(10000, Number(bootstrapIterations || 2000)));
  const ratios = [];
  const costDiffs = [];

  for (let b = 0; b < B; b++) {
    let bCostA = 0;
    let bCostB = 0;
    let bPassA = 0;
    let bPassB = 0;
    for (let i = 0; i < pairs.length; i++) {
      const idx = Math.floor(rng() * pairs.length);
      const item = pairs[idx];
      bCostA += item.aCost;
      bCostB += item.bCost;
      bPassA += item.aRate;
      bPassB += item.bRate;
    }
    costDiffs.push((bCostB - bCostA) / pairs.length);
    if (bPassA > 0 && bPassB > 0 && bCostA > 0) {
      ratios.push(bCostB / bPassB / (bCostA / bPassA));
    }
  }
  ratios.sort((x, y) => x - y);
  costDiffs.sort((x, y) => x - y);

  const quantile = (arr, q) =>
    arr.length
      ? Number(
          arr[Math.min(arr.length - 1, Math.floor(q * arr.length))].toFixed(6),
        )
      : null;

  const ratioCi95 = [quantile(ratios, 0.025), quantile(ratios, 0.975)];
  const costDiffCi95 = [quantile(costDiffs, 0.025), quantile(costDiffs, 0.975)];
  const rateDiff = Number((meanRateB - meanRateA).toFixed(4));
  const nonInferiorityPassed = rateDiff >= -effectiveDelta;
  const costSignificantlyReduced =
    ratioCi95[1] !== null && ratioCi95[1] < 1.0 && nonInferiorityPassed;

  return {
    paired_tasks: pairs.length,
    resolution_rate_a: Number(meanRateA.toFixed(4)),
    resolution_rate_b: Number(meanRateB.toFixed(4)),
    resolution_rate_diff: rateDiff,
    delta_pass_rate: effectiveDelta,
    non_inferiority_passed: nonInferiorityPassed,
    mcnemar_b_only: n01,
    mcnemar_a_only: n10,
    mcnemar_p_value: exactMcNemarPValue(n01, n10),
    cost_per_resolved_a: cprA !== null ? Number(cprA.toFixed(6)) : null,
    cost_per_resolved_b: cprB !== null ? Number(cprB.toFixed(6)) : null,
    cost_per_resolved_ratio_b_over_a:
      cprRatio !== null ? Number(cprRatio.toFixed(4)) : null,
    cost_per_resolved_ratio_ci95: ratioCi95,
    mean_cost_diff_b_minus_a: Number(
      ((sumCostB - sumCostA) / pairs.length).toFixed(6),
    ),
    mean_cost_diff_ci95: costDiffCi95,
    significant_cost_reduction: costSignificantlyReduced,
  };
}

/** EN: Extract module/domain namespace prefix from a fact_key (e.g. `org.policy.eu_battery_2026` -> `org.policy`).
 * 中文：从 `fact_key` 中提取模块/领域命名空间前缀（用于双层记忆的模块级不变量聚合）。
 */
export function extractMemoryNamespace(
  factKey,
  { allowTwoSegmentNamespace = false } = {},
) {
  if (typeof factKey !== "string" || !factKey.trim()) return null;
  const clean = factKey.trim();
  if (clean.endsWith(".__invariant__")) {
    return clean.slice(0, -".__invariant__".length);
  }
  const parts = clean.split(".");
  if (parts.length >= 3) return parts.slice(0, 2).join(".");
  if (parts.length === 2 && allowTwoSegmentNamespace) return clean;
  return null;
}

/** EN: Compute bounded Beta posterior multiplier in [0.8, 1.2] from (accepted, injected) counts (Harness² P3.3).
 * p = (accepted + 1) / (injected + 2); multiplier = 0.8 + 0.4 * p.
 * 中文：基于 Beta 后验概率 `p = (accepted + 1) / (injected + 2)` 计算 `[0.8, 1.2]`（±20%）有界召回乘子。
 */
export function betaFeedbackMultiplier(acceptedCount = 0, injectedCount = 0) {
  const inj = Math.max(0, Number(injectedCount || 0));
  const acc = Math.max(0, Math.min(inj, Number(acceptedCount || 0)));
  const p = (acc + 1) / (inj + 2);
  return {
    posterior: Number(p.toFixed(4)),
    multiplier: Number((0.8 + 0.4 * p).toFixed(4)),
    should_demote: inj >= 8 && p < 0.25,
  };
}

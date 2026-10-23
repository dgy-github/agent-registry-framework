import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Scheduler, Worker, createRegistryServer } from "../src/index.mjs";

const operatorToken =
  process.env.REGISTRY_OPERATOR_TOKEN || "operator-demo-token-2026-intelligent";
const normalizeToken =
  process.env.NORMALIZE_WORKER_TOKEN || "worker-normalize-demo-token-2026";
const summarizeToken =
  process.env.SUMMARIZE_WORKER_TOKEN || "worker-summarize-demo-token-2026";
const verifyToken =
  process.env.VERIFY_WORKER_TOKEN || "worker-verifier-demo-token-2026";

let embeddedPg = null;
let databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  const modPath = join(
    process.cwd(),
    ".runtime/pg-test/node_modules/embedded-postgres/dist/index.js",
  );
  const { default: EmbeddedPostgres } = await import(
    pathToFileURL(modPath).href
  );
  const dataDir = join(process.cwd(), ".runtime/pg-test/ui-demo-db");
  rmSync(dataDir, { recursive: true, force: true });
  const pgPort = Number(process.env.DEMO_PG_PORT || 55440);
  embeddedPg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "password",
    port: pgPort,
    persistent: false,
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: () => {},
    onError: () => {},
  });
  await embeddedPg.initialise();
  await embeddedPg.start();
  databaseUrl = `postgresql://postgres:password@127.0.0.1:${pgPort}/postgres`;
}

const scheduler = new Scheduler(
  { connectionString: databaseUrl },
  {
    schema: "agent_registry_ui_demo",
    capacity: 3,
    maxAttempts: 3,
    maxConsecutiveFailures: 2,
    capabilities: [
      {
        name: "text.normalize",
        description: "Normalize raw text & extract structured domain facts",
        required_input_fields: ["text"],
        required_output_fields: ["text"],
      },
      {
        name: "text.summarize",
        description:
          "Synthesize verified upstream facts & organizational memory",
        allowed_context_prefixes: ["org."],
      },
      {
        name: "fact.verify",
        description: "Independent Verifier Agent (60-point singularity gate)",
        verifier: true,
      },
    ],
  },
);

await scheduler.init();

const server = createRegistryServer(scheduler, {
  operatorToken,
  uiDefaultToken: operatorToken,
  workerTokens: {
    "text.normalize": normalizeToken,
    "text.summarize": summarizeToken,
    "fact.verify": verifyToken,
  },
});

const preferredPort = Number(process.env.PORT || 8766);
for (const candidatePort of [preferredPort, 8788, 8789, 0]) {
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("listening", onListen);
        reject(err);
      };
      const onListen = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListen);
      server.listen(candidatePort, "127.0.0.1");
    });
    if (candidatePort !== preferredPort) {
      console.log(
        `⚠️  Port ${preferredPort} is currently occupied by another process (e.g. WSL commerce-scheduler); switched to port ${server.address().port}.`,
      );
    }
    break;
  } catch (err) {
    if (err.code !== "EADDRINUSE" || candidatePort === 0) {
      if (embeddedPg) await embeddedPg.stop().catch(() => {});
      throw err;
    }
  }
}
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// Seed an isolated flaky worker to showcase worker health & auto-isolation in UI
await scheduler.register("worker-normalize-flaky", "text.normalize");
await scheduler.enable("worker-normalize-flaky", false);

// Start live background workers
const stop = new AbortController();
const normalizeWorker = new Worker({
  id: "worker-normalize-1",
  url: baseUrl,
  token: normalizeToken,
  capability: "text.normalize",
  pollMs: 250,
  handler: async (task, { reportUsage }) => {
    reportUsage({
      input_tokens: 180,
      output_tokens: 95,
      cost_usd: 0.0028,
    });
    const raw = String(task.input.text ?? "").trim();
    const priorNote = task.prior_facts?.at(-1)?.review_note || null;
    return {
      text: raw.toUpperCase(),
      attempt: task.attempt,
      ...(priorNote ? { revised_after_feedback: priorNote } : {}),
    };
  },
});

const summarizeWorker = new Worker({
  id: "worker-summarize-1",
  url: baseUrl,
  token: summarizeToken,
  capability: "text.summarize",
  pollMs: 250,
  handler: async (task, { reportUsage }) => {
    reportUsage({
      input_tokens: 320,
      output_tokens: 140,
      cost_usd: 0.0046,
    });
    const upstream = task.facts.map((f) => f.value?.text || "").join(" | ");
    const memoryKeys = (task.context_facts || []).map((f) => f.fact_key);
    return {
      summary: `Synthesized [${upstream}] with org memory [${memoryKeys.join(", ")}]`,
      words: upstream.split(/\s+/).filter(Boolean).length,
    };
  },
});

await scheduler.register("worker-verifier-1", "fact.verify");

const loop1 = normalizeWorker.run({ signal: stop.signal });
const loop2 = summarizeWorker.run({ signal: stop.signal });

// Seed Request 1: Completed workflow with Verifier Agent approval + Organizational Memory
const req1 = "req-battery-policy-2026";
await scheduler.submit(req1, {
  trace_id: "trace.battery.2026.01",
  budget: { max_tokens: 10000, max_cost_usd: 0.5 },
  tasks: [
    {
      id: "extract-policy",
      capability: "text.normalize",
      priority: 30,
      fact_key: "org.policy.eu_battery_2026",
      fact_ttl_seconds: 86400,
      input: { text: "eu battery passport carbon footprint mandatory 2026" },
    },
    {
      id: "executive-brief",
      capability: "text.summarize",
      priority: 20,
      dependencies: ["extract-policy"],
      require_verified_facts: true,
      min_fact_confidence: 0.9,
      min_worker_pass_rate: 0.85,
      context_keys: ["org.policy.eu_battery_2026"],
      context_query: "battery",
      input: { topic: "briefing" },
    },
  ],
});

// Wait for extract-policy to complete, then approve via Verifier Agent
let extractPolicyTaskId = null;
while (true) {
  const snap = await scheduler.snapshot();
  const t = snap.tasks.find(
    (x) => x.request_id === req1 && x.capability === "text.normalize",
  );
  if (t?.status === "completed") {
    extractPolicyTaskId = t.task_id;
    break;
  }
  await new Promise((r) => setTimeout(r, 80));
}
await scheduler.reviewFactByVerifier(
  "worker-verifier-1",
  "fact.verify",
  extractPolicyTaskId,
  1,
  true,
  "Verified primary EU regulation citation by independent Verifier Agent",
  { confidence: 0.98, ttlSeconds: 86400 },
);

// Crystallize Request 1 into a reusable Organizational Playbook (Procedural Memory)
await scheduler.crystallizePlaybook("sop.eu_battery_audit", {
  sourceRequestId: req1,
  description: "Standardized EU Battery Regulation Audit & Briefing SOP",
  tags: ["compliance", "battery", "eu-2026"],
});

// Seed v1.5 Harness² Two-Tier Memory (Module Invariant + Episodic) & RRSI Regularized Evolution Ledger
await scheduler.importBundle({
  memory: [
    {
      fact_key: "org.policy.cbam_tariff_2026",
      value: {
        normalized_text: "EU CBAM cross-border carbon tariff phase-in 2026",
        word_count: 7,
      },
      confidence: 0.96,
      review_note: "Verified CBAM regulatory baseline",
    },
  ],
});
await scheduler.promoteMemoryInvariant("org.policy", {
  ruleSummary:
    "EU 2026 compliance requires both Battery Passport carbon footprint & CBAM declarations",
});
await scheduler.evolveGenome(
  { memory_config: { max_entries: 6, max_chars: 2400 } },
  {
    hypothesis: "Enforce Harness² 6-entry / 2400-char memory recall cap",
    round: 1,
    incumbentMetrics: { pass_rate: 0.82, mean_tokens: 1650 },
    candidateMetrics: { pass_rate: 0.85, mean_tokens: 1320 },
  },
);

// Seed Request 2: Waiting at the 60-point singularity gate for human operator review/rework in UI!
const req2 = "req-awaiting-human-review";
await scheduler.submit(req2, {
  trace_id: "trace.human.gate.02",
  budget: { max_tokens: 8000, max_cost_usd: 0.25 },
  tasks: [
    {
      id: "draft-analysis",
      capability: "text.normalize",
      priority: 15,
      fact_key: "org.market.q4_forecast",
      fact_ttl_seconds: 7200,
      input: { text: "preliminary q4 supply chain forecast draft" },
    },
    {
      id: "publish-report",
      capability: "text.summarize",
      priority: 10,
      dependencies: ["draft-analysis"],
      require_verified_facts: true,
      min_fact_confidence: 0.85,
      min_worker_pass_rate: 0.8,
      context_keys: ["org.policy.eu_battery_2026"],
      input: { topic: "q4-report" },
    },
  ],
});

// Seed a Cron + Webhook Trigger for periodic organizational memory refresh
await scheduler.upsertTrigger("cron-org-memory-refresh", {
  description: "Hourly organizational policy & supply-chain memory refresh",
  cron: "0 * * * *",
  webhook: true,
  plan: {
    trace_id: "trace.cron.memory_refresh",
    tasks: [
      {
        id: "refresh-policy",
        capability: "text.normalize",
        fact_key: "org.policy.hourly_snapshot",
        fact_ttl_seconds: 7200,
        input: { text: "scheduled hourly regulatory & supply chain pulse" },
      },
    ],
  },
});

const tickTimer = setInterval(() => {
  scheduler.tick().catch(() => {});
}, 2000);

const consoleUrl = `${baseUrl}/`;
console.log("\n==============================================================");
console.log("🚀 Agent Registry Console UI is live!");
console.log(`👉 Open in browser (Auto-Connected): ${consoleUrl}`);
console.log(`🔑 Operator Token: ${operatorToken}`);
console.log("==============================================================\n");

const shutdown = async () => {
  clearInterval(tickTimer);
  stop.abort();
  await Promise.allSettled([loop1, loop2]);
  await new Promise((resolve) => server.close(resolve));
  await scheduler.close();
  if (embeddedPg) await embeddedPg.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

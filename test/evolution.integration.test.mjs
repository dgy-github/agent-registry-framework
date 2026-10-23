import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Scheduler } from "../src/index.mjs";

const database = process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL: feedback-driven rework, worker telemetry/isolation, dynamic DAG expansion and organizational memory",
  { skip: !database },
  async () => {
    const schema = "evolution_test_" + randomUUID().replaceAll("-", "");
    const scheduler = new Scheduler(
      { connectionString: database },
      {
        schema,
        capabilities: [
          {
            name: "research",
            description: "Research / 研究",
            required_input_fields: ["topic"],
            required_output_fields: ["summary"],
          },
          {
            name: "verify",
            description: "Verify / 核查",
            verifier: true,
          },
          {
            name: "compose",
            description: "Compose / 汇总",
            allowed_context_prefixes: ["org."],
          },
        ],
        maxAttempts: 2,
        maxConsecutiveFailures: 2,
      },
    );
    try {
      await scheduler.init();
      await scheduler.register("research-bad", "research");
      await scheduler.register("research-good", "research");
      await scheduler.register("verify-one", "verify");
      await scheduler.register("compose-one", "compose");

      // v0.6 Input contract & v0.9 Memory namespace prefix enforcement
      await assert.rejects(
        scheduler.submit(randomUUID(), {
          tasks: [{ id: "bad-input", capability: "research", input: {} }],
        }),
        /Missing required input field: topic/,
      );
      await assert.rejects(
        scheduler.submit(randomUUID(), {
          tasks: [
            {
              id: "bad-scope",
              capability: "compose",
              context_keys: ["secret.payroll"],
            },
          ],
        }),
        /Unauthorized context_key: secret\.payroll/,
      );

      // Stage 1 (v0.2) & Stage 2 (v0.3): Rework with prior_facts + auto-isolation of flaky workers
      const req1 = randomUUID();
      await scheduler.submit(req1, {
        trace_id: "trace.req1.root",
        tasks: [
          {
            id: "draft",
            capability: "research",
            fact_key: "org.market.2026",
            fact_ttl_seconds: 3600,
            input: { topic: "battery" },
          },
          {
            id: "report",
            capability: "compose",
            dependencies: ["draft"],
            require_verified_facts: true,
            min_fact_confidence: 0.9,
          },
        ],
      });

      // Attempt 1 on draft by research-bad: succeeds execution, but rejected by Verifier Agent with rework=true
      const draft1 = (await scheduler.claim("research-bad", "research")).task;
      assert.equal(draft1.attempt, 1);
      assert.equal(draft1.trace_id, "trace.req1.root");
      assert.deepEqual(draft1.prior_facts, []);
      await scheduler.result(
        "research-bad",
        "research",
        draft1.call_id,
        { summary: "unverified draft v1" },
        null,
        { input_tokens: 120, output_tokens: 80, cost_usd: 0.002 },
      );

      // v0.7 Verifier Agent authorization & self-review prevention
      await assert.rejects(
        scheduler.reviewFactByVerifier(
          "research-good",
          "research",
          draft1.task_id,
          1,
          true,
          "unauthorized capability",
        ),
        /Verifier not authorized/,
      );
      const rejected = await scheduler.reviewFactByVerifier(
        "verify-one",
        "verify",
        draft1.task_id,
        1,
        false,
        "missing primary citation",
        { rework: true, confidence: 0.15 },
      );
      assert.equal(rejected.accepted, true);
      assert.equal(rejected.next, "queued");
      assert.equal(rejected.fact.confidence, 0.15);

      // Attempt 2 on draft: receives prior_facts with v1 output and review_note
      const draft2 = (await scheduler.claim("research-good", "research")).task;
      assert.equal(draft2.task_id, draft1.task_id);
      assert.equal(draft2.attempt, 2);
      assert.equal(draft2.prior_facts.length, 1);
      assert.equal(draft2.prior_facts[0].version, 1);
      assert.equal(draft2.prior_facts[0].confidence, 0.15);
      assert.equal(
        draft2.prior_facts[0].review_note,
        "missing primary citation",
      );
      assert.deepEqual(draft2.prior_facts[0].value, {
        summary: "unverified draft v1",
      });
      await scheduler.result(
        "research-good",
        "research",
        draft2.call_id,
        { summary: "verified draft v2" },
        null,
        { input_tokens: 150, output_tokens: 100, cost_usd: 0.003 },
      );

      const approved = await scheduler.reviewFactByVerifier(
        "verify-one",
        "verify",
        draft2.task_id,
        2,
        true,
        "citations verified",
        { confidence: 0.98 },
      );
      assert.equal(approved.accepted, true);
      assert.equal(approved.fact.confidence, 0.98);
      assert.ok(approved.fact.expires_at);

      // Stage 3 (v0.4): Dynamic DAG expansion between completed 'draft' and queued 'report'
      const expId = "expand-verify-step";
      const subplan = {
        tasks: [
          {
            id: "audit",
            capability: "verify",
            input: { check: "compliance" },
          },
        ],
      };
      const expanded = await scheduler.expand(
        req1,
        expId,
        draft2.task_id,
        subplan,
        { rewireDependents: true },
      );
      assert.equal(expanded.ids.length, 1);
      assert.deepEqual(
        await scheduler.expand(req1, expId, draft2.task_id, subplan, {
          rewireDependents: true,
        }),
        expanded,
      );
      await assert.rejects(
        scheduler.expand(req1, expId, draft2.task_id, subplan, {
          rewireDependents: false,
        }),
        /Idempotency conflict/,
      );

      // Because 'report' was rewired to depend on 'audit', 'report' cannot be claimed until 'audit' completes
      assert.equal(
        (await scheduler.claim("compose-one", "compose")).task,
        null,
      );
      const auditTask = (await scheduler.claim("verify-one", "verify")).task;
      assert.equal(auditTask.task_id, expanded.ids[0]);
      assert.equal(auditTask.trace_id, "trace.req1.root");
      assert.equal(auditTask.facts.length, 1);
      assert.deepEqual(auditTask.facts[0].value, {
        summary: "verified draft v2",
      });
      await scheduler.result("verify-one", "verify", auditTask.call_id, {
        audited: true,
      });

      // Self-review by 'verify-one' on its own output is forbidden!
      await assert.rejects(
        scheduler.reviewFactByVerifier(
          "verify-one",
          "verify",
          auditTask.task_id,
          1,
          true,
          "self approval attempt",
        ),
        /Self-review is forbidden/,
      );

      // v0.9 min_fact_confidence gate: 'report' requires min_fact_confidence: 0.9
      // First approve 'audit' with confidence 0.6 -> 'report' must stay blocked!
      await scheduler.reviewFact(
        auditTask.task_id,
        1,
        true,
        "low confidence check",
        { confidence: 0.6 },
      );
      assert.equal(
        (await scheduler.claim("compose-one", "compose")).task,
        null,
      );
      // Elevate confidence to 0.95 -> 'report' unblocks!
      await scheduler.reviewFact(
        auditTask.task_id,
        1,
        true,
        "high confidence compliance passed",
        { confidence: 0.95 },
      );

      const reportTask = (await scheduler.claim("compose-one", "compose")).task;
      assert.equal(reportTask.facts.length, 1);
      assert.equal(reportTask.facts[0].task_id, auditTask.task_id);
      // Downstream already dispatched: upstream 'audit' cannot be reworked now
      assert.deepEqual(
        await scheduler.reviewFact(
          auditTask.task_id,
          1,
          false,
          "too late to rework",
          { rework: true },
        ),
        { accepted: false, reason: "downstream_dispatched" },
      );
      await scheduler.result("compose-one", "compose", reportTask.call_id, {
        final: "complete",
      });

      // Stage 2 (v0.3) & v0.6 Output Contract Violation:
      // 'research' requires 'summary' in output; returning {} triggers output_contract_violation and isolates research-bad!
      const reqFail = randomUUID();
      await scheduler.submit(reqFail, {
        tasks: [
          {
            id: "fail-task",
            capability: "research",
            input: { topic: "solar" },
          },
        ],
      });
      const failAttempt = (await scheduler.claim("research-bad", "research"))
        .task;
      const violationReceipt = await scheduler.result(
        "research-bad",
        "research",
        failAttempt.call_id,
        { wrong_field: "missing summary" },
        null,
      );
      assert.equal(violationReceipt.accepted, true);
      assert.equal(violationReceipt.contract_violation, true);

      // research-bad now has 2 consecutive failures (1 rejected fact + 1 output_contract_violation) and is auto-disabled
      assert.equal(
        (await scheduler.claim("research-bad", "research")).task,
        null,
      );
      await scheduler.cancel(failAttempt.task_id);
      const tel = await scheduler.telemetry();
      const badStat = tel.workers.find((w) => w.agent_id === "research-bad");
      const goodStat = tel.workers.find((w) => w.agent_id === "research-good");
      const researchCap = tel.capabilities.find((c) => c.name === "research");
      const composeCap = tel.capabilities.find((c) => c.name === "compose");
      assert.deepEqual(composeCap.allowed_context_prefixes, ["org."]);
      assert.equal(badStat.enabled, false);
      assert.equal(badStat.consecutive_failures, 2);
      assert.equal(badStat.rejected_facts, 1);
      assert.equal(badStat.pass_rate, 0);
      assert.equal(badStat.total_tokens, 200);
      assert.equal(goodStat.enabled, true);
      assert.equal(goodStat.verified_facts, 1);
      assert.equal(goodStat.pass_rate, 1);
      assert.equal(goodStat.total_tokens, 250);
      assert.equal(researchCap.total_tokens, 450);
      assert.equal(researchCap.total_cost_usd, 0.005);
      assert.equal(tel.memory.length, 1);
      assert.equal(tel.memory[0].fact_key, "org.market.2026");
      assert.equal(tel.memory[0].confidence, 0.98);
      assert.deepEqual(tel.memory[0].value, { summary: "verified draft v2" });

      // Re-enabling research-bad resets consecutive_failures
      await scheduler.enable("research-bad", true);
      const afterEnable = (await scheduler.telemetry()).workers.find(
        (w) => w.agent_id === "research-bad",
      );
      assert.equal(afterEnable.enabled, true);
      assert.equal(afterEnable.consecutive_failures, 0);

      // Stage 4 (v0.5), v0.6 Memory TTL & v0.9 Priority + v1.0 Event-driven claim waitMs:
      const waitingClaim = scheduler.claim("compose-one", "compose", {
        waitMs: 2000,
      });
      await new Promise((r) => setTimeout(r, 30));
      const req2 = randomUUID();
      await scheduler.submit(req2, {
        tasks: [
          {
            id: "low-pri",
            capability: "compose",
            priority: -10,
            context_keys: ["org.market.2026"],
          },
          {
            id: "high-pri",
            capability: "compose",
            priority: 50,
            context_keys: ["org.market.2026", "org.nonexistent"],
          },
        ],
      });
      // Event-driven wakeup resolves waitingClaim immediately with the higher-priority task ("high-pri")!
      const followup = (await waitingClaim).task;
      assert.equal(followup.priority, 50);
      assert.equal(followup.context_facts.length, 1);
      assert.equal(followup.context_facts[0].fact_key, "org.market.2026");
      assert.equal(followup.context_facts[0].version, 2);
      assert.equal(followup.context_facts[0].confidence, 0.98);
      assert.deepEqual(followup.context_facts[0].value, {
        summary: "verified draft v2",
      });
      await scheduler.result("compose-one", "compose", followup.call_id, {
        reused: true,
      });
      const lowPriTask = (await scheduler.claim("compose-one", "compose")).task;
      assert.equal(lowPriTask.priority, -10);
      await scheduler.result("compose-one", "compose", lowPriTask.call_id, {
        reused: true,
      });

      // Expire the fact in DB and confirm expired memory is excluded from context_facts and telemetry().memory
      await scheduler.pool.query(
        `UPDATE ${schema}.shared_facts SET expires_at=now()-interval '1 second' WHERE fact_key='org.market.2026'`,
      );
      assert.equal((await scheduler.telemetry()).memory.length, 0);

      // v0.8 FinOps Request Token/Cost Budget Guardrail:
      const reqBudget = randomUUID();
      const { ids: budgetIds } = await scheduler.submit(reqBudget, {
        budget: { max_tokens: 300, max_cost_usd: 0.01 },
        tasks: [
          {
            id: "step1",
            capability: "research",
            input: { topic: "fusion" },
          },
          {
            id: "step2",
            capability: "compose",
            dependencies: ["step1"],
          },
        ],
      });
      const step1Task = (await scheduler.claim("research-good", "research"))
        .task;
      await scheduler.result(
        "research-good",
        "research",
        step1Task.call_id,
        { summary: "expensive step1" },
        null,
        { input_tokens: 250, output_tokens: 100, cost_usd: 0.015 },
      );
      // Because step1 used 350 tokens (> 300) and $0.015 (> $0.01), step2 is immediately halted with budget_exceeded
      assert.equal(
        (await scheduler.claim("compose-one", "compose")).task,
        null,
      );
      const snapAfterBudget = await scheduler.snapshot();
      const haltedStep2 = snapAfterBudget.tasks.find(
        (t) => t.task_id !== step1Task.task_id && budgetIds.includes(t.task_id),
      );
      assert.equal(haltedStep2.status, "failed");
      assert.equal(haltedStep2.last_error, "budget_exceeded");

      // v1.1 LLM Planner (Natural-Language Goal -> Validated DAG) & Dynamic expandFromFact:
      const { Planner } = await import("../src/index.mjs");
      const planner = new Planner();
      const planned = await planner.submitGoal(
        scheduler,
        "Research solid-state electrolyte breakthroughs and compose executive summary",
        { factKey: "org.solid_state.2026" },
      );
      assert.equal(planned.ids.length, 2);
      assert.equal(planned.plan.tasks[0].capability, "research");
      assert.equal(planned.plan.tasks[0].fact_key, "org.solid_state.2026");
      assert.equal(planned.plan.tasks[1].capability, "compose");
      assert.equal(planned.plan.tasks[1].require_verified_facts, true);

      // v1.2 Scheduled Cron & Webhook Triggers:
      const upsertedTrig = await scheduler.upsertTrigger(
        "cron-battery-monitor",
        {
          description: "Periodic battery intelligence refresh",
          cron: "*/15 * * * *",
          interval_seconds: 60,
          webhook: true,
          plan: {
            trace_id: "trace.cron.battery",
            tasks: [
              {
                id: "scan",
                capability: "research",
                input: { topic: "lithium-sulfur" },
              },
            ],
          },
        },
      );
      assert.equal(upsertedTrig.ok, true);
      assert.ok(upsertedTrig.trigger.next_run_at);

      // Fire trigger via Webhook with custom payload injection
      const webhookFired = await scheduler.fireTrigger("cron-battery-monitor", {
        source: "webhook",
        payload: { alert_id: "wh-99" },
      });
      assert.equal(webhookFired.triggered, true);
      assert.equal(webhookFired.ids.length, 1);

      // Backdate next_run_at to simulate a due Cron schedule and verify scheduler.tick() fires it automatically!
      await scheduler.pool.query(
        `UPDATE ${schema}.agent_triggers SET next_run_at=now()-interval '5 seconds' WHERE trigger_id='cron-battery-monitor'`,
      );
      const tickRes = await scheduler.tick();
      assert.equal(tickRes.fired.length, 1);
      assert.equal(tickRes.fired[0].trigger_id, "cron-battery-monitor");
      const trigState = (await scheduler.telemetry()).triggers.find(
        (tr) => tr.trigger_id === "cron-battery-monitor",
      );
      assert.equal(trigState.total_runs, 2);

      // v1.2 Reputation-Gated Dispatch (min_worker_pass_rate) with Cold-Start Protection:
      // Clear any remaining queued tasks so we isolate the reputation-gated task.
      for (const t of (await scheduler.snapshot()).tasks) {
        if (t.status === "queued") await scheduler.cancel(t.task_id);
      }
      const {
        ids: [repTaskId],
      } = await scheduler.submit("req-reputation-gate-1", {
        tasks: [
          {
            id: "critical-research",
            capability: "research",
            priority: 100,
            min_worker_pass_rate: 0.85,
            input: { topic: "mission-critical-audit" },
          },
        ],
      });
      // research-bad has 0% pass_rate (0 verified, 2 rejected) -> blocked by min_worker_pass_rate: 0.85
      assert.equal(
        (await scheduler.claim("research-bad", "research")).task,
        null,
      );
      // research-good has 100% pass_rate -> allowed to claim the reputation-gated task!
      const repClaimed = (await scheduler.claim("research-good", "research"))
        .task;
      assert.ok(repClaimed);
      assert.equal(repClaimed.task_id, repTaskId);
      assert.equal(repClaimed.min_worker_pass_rate, 0.85);
      await scheduler.result(
        "research-good",
        "research",
        repClaimed.call_id,
        { summary: "high-reputation output" },
        null,
      );

      // v1.3 Memory Search, Dynamic context_query Injection & Fact Version Rollback (rollbackFact):
      // Restore org.market.2026 v2 from the earlier TTL expiry test and publish a v3 verified version
      await scheduler.pool.query(
        `UPDATE ${schema}.shared_facts SET expires_at=NULL WHERE fact_key='org.market.2026'`,
      );
      const {
        ids: [v3TaskId],
      } = await scheduler.submit("req-market-v3-update", {
        tasks: [
          {
            id: "draft-v3",
            capability: "research",
            fact_key: "org.market.2026",
            input: { topic: "battery-v3" },
          },
        ],
      });
      const v3Claim = (await scheduler.claim("research-good", "research")).task;
      await scheduler.result(
        "research-good",
        "research",
        v3Claim.call_id,
        { summary: "verified draft v3 240Wh/kg" },
        null,
      );
      await scheduler.reviewFact(
        v3TaskId,
        1,
        true,
        "Approved v3 market update",
        { confidence: 0.99 },
      );

      const searchHits = await scheduler.searchMemory("240Wh/kg", {
        prefix: "org.",
      });
      assert.equal(searchHits.facts.length, 1);
      assert.equal(searchHits.facts[0].fact_key, "org.market.2026");
      assert.equal(
        searchHits.facts[0].value.summary,
        "verified draft v3 240Wh/kg",
      );

      // Submit a compose task using dynamic context_query (without knowing exact fact_key upfront)
      await scheduler.submit("req-context-query-1", {
        tasks: [
          {
            id: "compose-by-query",
            capability: "compose",
            context_query: "240Wh/kg",
            input: { format: "memo" },
          },
        ],
      });
      const queryClaimed = (await scheduler.claim("compose-one", "compose"))
        .task;
      assert.ok(queryClaimed);
      assert.equal(queryClaimed.context_facts.length, 1);
      assert.equal(queryClaimed.context_facts[0].fact_key, "org.market.2026");
      assert.equal(
        queryClaimed.context_facts[0].value.summary,
        "verified draft v3 240Wh/kg",
      );
      await scheduler.result(
        "compose-one",
        "compose",
        queryClaimed.call_id,
        { report: "memo with 240Wh/kg" },
        null,
      );

      // Roll back org.market.2026 -> should revert from v3 (240Wh/kg) to the previous verified version (verified draft v2)!
      const rolledBack = await scheduler.rollbackFact("org.market.2026", {
        note: "Revert to validated v2 baseline",
      });
      assert.equal(rolledBack.rolled_back, true);
      assert.equal(
        rolledBack.revoked_fact.value.summary,
        "verified draft v3 240Wh/kg",
      );
      assert.equal(rolledBack.active_fact.value.summary, "verified draft v2");

      // v1.3 Time-Travel DAG Branching (forkRequest):
      // Fork req1 from 'report' with overridden input, reusing upstream completed tasks & verified facts!
      const forked = await scheduler.forkRequest(req1, "req-forked-whatif-1", {
        fromTaskKey: "report",
        inputOverrides: {
          report: { format: "executive-slide-deck" },
        },
      });
      assert.equal(forked.request_id, "req-forked-whatif-1");
      assert.ok(forked.reused_task_ids.length >= 2);
      assert.equal(forked.queued_task_ids.length, 1);
      // Claim the forked report task immediately (since upstream facts were cloned in verified state!)
      const forkedCompose = (await scheduler.claim("compose-one", "compose"))
        .task;
      assert.ok(forkedCompose);
      assert.equal(forkedCompose.task_id, forked.queued_task_ids[0]);
      assert.equal(forkedCompose.input.format, "executive-slide-deck");
      assert.ok(forkedCompose.facts.length >= 1);
      await scheduler.result(
        "compose-one",
        "compose",
        forkedCompose.call_id,
        { report: "forked slide deck" },
        null,
      );

      // v1.4 Procedural Memory & Skill Crystallization (crystallizePlaybook / runPlaybook):
      // Crystallize req1 (which evolved from 2 tasks into 3 tasks via dynamic expand!) into a reusable Playbook SOP
      const crystallized = await scheduler.crystallizePlaybook(
        "sop.battery.deep_dive",
        {
          sourceRequestId: req1,
          description: "Evolved 3-node battery deep dive SOP",
          tags: ["battery", "sop"],
        },
      );
      assert.equal(crystallized.ok, true);
      assert.equal(crystallized.playbook.version, 1);
      assert.equal(crystallized.playbook.plan_template.tasks.length, 3);

      const pbList = await scheduler.listPlaybooks();
      assert.equal(pbList.playbooks.length, 1);
      assert.equal(pbList.playbooks[0].playbook_id, "sop.battery.deep_dive");

      const pbRun = await scheduler.runPlaybook(
        "sop.battery.deep_dive",
        "req-from-playbook-1",
        {
          params: { topic: "sodium-ion-2026" },
        },
      );
      assert.equal(pbRun.ok, true);
      assert.equal(pbRun.ids.length, 3);

      // v1.3/v1.4 Portable Asset Bundle Export & Import (exportBundle / importBundle):
      const exported = await scheduler.exportBundle();
      assert.equal(exported.version, "1.3");
      assert.ok(exported.capabilities.length >= 3);
      assert.ok(exported.memory.some((m) => m.fact_key === "org.market.2026"));
      assert.ok(
        exported.playbooks.some(
          (p) => p.playbook_id === "sop.battery.deep_dive",
        ),
      );
      const importRes = await scheduler.importBundle({
        memory: [
          {
            fact_key: "org.imported.standard",
            value: { summary: "ISO-26262 ASIL-D" },
            confidence: 0.99,
            review_note: "Imported compliance standard",
          },
        ],
        triggers: [],
        playbooks: [],
      });
      assert.equal(importRes.ok, true);
      assert.equal(importRes.imported_facts, 1);
      const afterImportSearch = await scheduler.searchMemory("ISO-26262");
      assert.equal(afterImportSearch.facts.length, 1);
      assert.equal(
        afterImportSearch.facts[0].fact_key,
        "org.imported.standard",
      );

      // v1.5 Regularized Self-Evolving Harness (Google RRSI / ReSelf & Harness²):
      // 1. P3 Two-Tier Memory (Module Invariants vs Episodic) + Capping + Cost-Aware Attribution
      for (const [idx, issueKey] of [
        "org.tabulate.issue_175",
        "org.tabulate.issue_24",
        "org.tabulate.issue_190",
      ].entries()) {
        const {
          ids: [tabTaskId],
        } = await scheduler.submit(`req-tabulate-${idx + 1}`, {
          tasks: [
            {
              id: `fix-${idx + 1}`,
              capability: "research",
              priority: 80,
              fact_key: issueKey,
              input: { topic: `tabulate-fix-${idx + 1}` },
            },
          ],
        });
        const claimedTab = (await scheduler.claim("research-good", "research"))
          .task;
        await scheduler.result(
          "research-good",
          "research",
          claimedTab.call_id,
          { summary: `tabulate rule ${idx + 1}` },
          null,
          {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            cost_usd: 0.002,
          },
        );
        await scheduler.reviewFact(
          tabTaskId,
          1,
          true,
          `Verified tabulate fix ${idx + 1}`,
          { confidence: 0.96 },
        );
      }

      // Check that org.tabulate.__invariant__ was auto-promoted and active episodic notes in org.tabulate were capped at 2!
      const telAfterP3 = await scheduler.telemetry();
      const tabMemories = telAfterP3.memory.filter((m) =>
        m.fact_key.startsWith("org.tabulate."),
      );
      assert.equal(tabMemories.length, 3); // 1 invariant + 2 latest episodic (issue_175 was capped/demoted!)
      const tabInvariant = tabMemories.find(
        (m) => m.fact_key === "org.tabulate.__invariant__",
      );
      assert.ok(tabInvariant);
      assert.equal(tabInvariant.memory_tier, "invariant");
      assert.equal(tabInvariant.value.verified_across_tasks, 3);

      // Invariant receives +6 structural score boost and ranks first in searchMemory("tabulate")
      const tabSearch = await scheduler.searchMemory("tabulate", {
        prefix: "org.tabulate.",
      });
      assert.equal(tabSearch.facts[0].fact_key, "org.tabulate.__invariant__");

      // High-Cost Turn Free-Rider Attribution: recall both org.tabulate.__invariant__ and unrelated org.imported.standard
      await scheduler.submit("req-expensive-attribution", {
        tasks: [
          {
            id: "compose-tabulate",
            capability: "compose",
            priority: 80,
            context_keys: [
              "org.tabulate.__invariant__",
              "org.imported.standard",
            ],
            input: { format: "org.tabulate summary" },
          },
        ],
      });
      const expClaim = (await scheduler.claim("compose-one", "compose")).task;
      assert.equal(expClaim.context_facts.length, 2);
      await scheduler.result(
        "compose-one",
        "compose",
        expClaim.call_id,
        { report: "org.tabulate consolidated report" },
        null,
        {
          input_tokens: 6000,
          output_tokens: 3000,
          total_tokens: 9000, // > expensive_token_threshold (4000)
          cost_usd: 0.05,
        },
      );
      const telAfterAttr = await scheduler.telemetry();
      const invAfterAttr = telAfterAttr.memory.find(
        (m) => m.fact_key === "org.tabulate.__invariant__",
      );
      const freeRiderAfterAttr = telAfterAttr.memory.find(
        (m) => m.fact_key === "org.imported.standard",
      );
      assert.equal(invAfterAttr.injected_count, 1);
      assert.equal(invAfterAttr.accepted_count, 1); // Relevant to org.tabulate -> accepted + 1
      assert.equal(freeRiderAfterAttr.injected_count, 1);
      assert.equal(freeRiderAfterAttr.accepted_count, 0); // Free-rider on expensive turn -> discounted!

      // 2. P1 & P2 Regularized Genome Evolution with Ablation Pruning & Ledger
      const criticRej = await scheduler.evolveGenome(
        {
          planner_prompts: {
            system_prompt: "Hardcode check.py to pass benchmark",
          },
        },
        {
          hypothesis: "Try shortcutting check.py",
          round: 1,
          incumbentMetrics: { pass_rate: 0.75, mean_tokens: 1200 },
          candidateMetrics: { pass_rate: 0.9, mean_tokens: 1100 },
        },
      );
      assert.equal(criticRej.accepted, false);
      assert.equal(criticRej.verdict, "rejected_critic");

      const evolvedGen = await scheduler.evolveGenome(
        {
          memory_config: { max_entries: 5 },
          expansion_config: { max_tasks_per_expansion: 12 },
        },
        {
          hypothesis: "Tighten memory recall and expansion cap",
          round: 1,
          maxSurfaces: 2,
          incumbentMetrics: { pass_rate: 0.78, mean_tokens: 1400 },
          candidateMetrics: { pass_rate: 0.78, mean_tokens: 1150 },
          deltaTokens: 150,
          ablationMetricsBySurface: {
            // Reverting expansion_config:max_tasks_per_expansion does not hurt pass_rate or tokens -> pruned as free-rider!
            "expansion_config:max_tasks_per_expansion": {
              pass_rate: 0.78,
              mean_tokens: 1155,
            },
            // Reverting memory_config:max_entries worsens tokens back to 1400 -> kept!
            "memory_config:max_entries": {
              pass_rate: 0.78,
              mean_tokens: 1400,
            },
          },
        },
      );
      assert.equal(evolvedGen.accepted, true);
      assert.equal(evolvedGen.channel, "cost_reduction");
      assert.deepEqual(evolvedGen.pruned_surfaces, [
        "expansion_config:max_tasks_per_expansion",
      ]);
      assert.deepEqual(evolvedGen.changed_surfaces, [
        "memory_config:max_entries",
      ]);
      assert.equal(evolvedGen.surfaces.memory_config.max_entries, 5);
      assert.equal(
        evolvedGen.surfaces.expansion_config.max_tasks_per_expansion,
        20,
      );

      // 3. P1 Regularized Playbook Evolution & P0 Calibration
      const pbEvolved = await scheduler.evolvePlaybook(
        "sop.battery.deep_dive",
        {
          sourceRequestId: req1,
          description: "Cost-optimized battery deep dive SOP v2",
          tags: ["battery", "rrsi"],
          hypothesis: "Reduce token overhead on verified topology",
          round: 3,
          incumbentMetrics: { pass_rate: 0.85, mean_tokens: 2000 },
          candidateMetrics: { pass_rate: 0.85, mean_tokens: 1650 },
          deltaTokens: 200,
        },
      );
      assert.equal(pbEvolved.accepted, true);
      assert.equal(pbEvolved.playbook.version, 2);

      const ledger = await scheduler.getHarnessLedger();
      assert.ok(ledger.entries.length >= 3);
      assert.ok(typeof ledger.recommended_focus_surface === "string");

      const calLive = await scheduler.calibrateHarness({ rounds: 3 });
      assert.ok(calLive.task_count >= 2);
      assert.ok(calLive.delta_pass_rate > 0);
    } finally {
      await scheduler.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await scheduler.close();
    }
  },
);

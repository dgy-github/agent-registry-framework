import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Scheduler } from "../src/index.mjs";

const database = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL: versioned feedback gates all dependencies, survives restart and supports revocation",
  { skip: !database },
  async () => {
    const schema = "review_test_" + randomUUID().replaceAll("-", "");
    const options = {
      schema,
      capabilities: [{ name: "work", description: "Work" }],
    };
    let scheduler = new Scheduler({ connectionString: database }, options);
    try {
      await scheduler.init();
      // Simulate the previous schema, then verify additive migration is repeatable.
      await scheduler.pool.query(
        "ALTER TABLE agent_tasks DROP COLUMN require_verified_facts; ALTER TABLE shared_facts DROP COLUMN review_note, DROP COLUMN reviewed_at",
      );
      const legacy = {
        tasks: [{ id: "old", capability: "work", input: {}, dependencies: [] }],
      };
      const legacyId = randomUUID();
      await scheduler.pool.query(
        "INSERT INTO agent_requests(request_id,plan) VALUES($1,$2)",
        [legacyId, JSON.stringify(legacy)],
      );
      await scheduler.init();
      await scheduler.init();
      assert.deepEqual(await scheduler.submit(legacyId, legacy), { ids: [] });
      const requestId = randomUUID();
      const plan = {
        tasks: [
          { id: "a", capability: "work" },
          { id: "b", capability: "work" },
          {
            id: "c",
            capability: "work",
            dependencies: ["a", "b"],
            require_verified_facts: true,
          },
        ],
      };
      const submitted = await scheduler.submit(requestId, plan);
      assert.deepEqual(await scheduler.submit(requestId, plan), submitted);
      await assert.rejects(
        scheduler.submit(requestId, {
          tasks: plan.tasks.map((t) => ({
            ...t,
            require_verified_facts: false,
          })),
        }),
        /Idempotency/,
      );
      await scheduler.register("worker-one", "work");
      let first = (await scheduler.claim("worker-one", "work")).task;
      await scheduler.result(
        "worker-one",
        "work",
        first.call_id,
        null,
        "retry",
      );
      const sources = [];
      for (let i = 0; i < 2; i++) {
        const task = (await scheduler.claim("worker-one", "work")).task;
        sources.push(task);
        await scheduler.result("worker-one", "work", task.call_id, {
          output: task.task_id,
        });
      }
      assert.equal((await scheduler.claim("worker-one", "work")).task, null);
      const retried = sources.find((t) => t.task_id === first.task_id);
      assert.equal(retried.attempt, 2);
      assert.deepEqual(
        await scheduler.reviewFact(retried.task_id, 1, true, "stale version"),
        { accepted: false },
      );
      assert.deepEqual(
        await scheduler.reviewFact("missing", 1, true, "missing"),
        { accepted: false },
      );
      const [a, b] = sources;
      await scheduler.reviewFact(
        a.task_id,
        a.attempt,
        true,
        "evidence checked",
      );
      assert.equal((await scheduler.claim("worker-one", "work")).task, null);
      await scheduler.reviewFact(b.task_id, b.attempt, false, "needs review");
      assert.equal((await scheduler.claim("worker-one", "work")).task, null);
      await scheduler.reviewFact(b.task_id, b.attempt, true, "verified");
      await scheduler.reviewFact(a.task_id, a.attempt, false, "new evidence");
      assert.equal((await scheduler.claim("worker-one", "work")).task, null);
      await scheduler.reviewFact(a.task_id, a.attempt, true, "rechecked");
      await scheduler.close();
      scheduler = new Scheduler({ connectionString: database }, options);
      const downstream = (await scheduler.claim("worker-one", "work")).task;
      assert.equal(downstream.require_verified_facts, true);
      assert.equal(downstream.facts.length, 2);
      assert.ok(
        downstream.facts.every(
          (f) => f.verified && f.reviewed_at && f.review_note,
        ),
      );
      // Revoking a review cannot roll back already dispatched work.
      await scheduler.reviewFact(
        a.task_id,
        a.attempt,
        false,
        "revoked after dispatch",
      );
      assert.equal(
        (
          await scheduler.result(
            "worker-one",
            "work",
            downstream.call_id,
            false,
          )
        ).accepted,
        true,
      );
      const state = await scheduler.snapshot();
      assert.equal(
        state.events.filter((e) => e.event_type === "fact_reviewed").length,
        6,
      );
      assert.equal(
        state.tasks.find((t) => t.task_id === downstream.task_id).status,
        "completed",
      );
    } finally {
      await scheduler.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await scheduler.close();
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Scheduler } from "../src/index.mjs";

test(
  "PostgreSQL: cancellation propagates through a diamond DAG in one transaction",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "propagation_test_" + randomUUID().replaceAll("-", "");
    const scheduler = new Scheduler(
      { connectionString: process.env.TEST_DATABASE_URL },
      {
        schema,
        capabilities: [{ name: "work", description: "Work" }],
      },
    );
    try {
      await scheduler.init();
      await scheduler.submit(randomUUID(), {
        tasks: [
          { id: "root", capability: "work" },
          { id: "left", capability: "work", dependencies: ["root"] },
          { id: "right", capability: "work", dependencies: ["root"] },
          { id: "join", capability: "work", dependencies: ["left", "right"] },
          {
            id: "leaf",
            capability: "work",
            dependencies: ["join"],
            require_verified_facts: true,
          },
          { id: "independent", capability: "work" },
        ],
      });
      const before = await scheduler.snapshot();
      const root = before.events.find(
        (e) => e.event_type === "queued" && e.payload.key === "root",
      ).task_id;
      const independent = before.events.find(
        (e) => e.event_type === "queued" && e.payload.key === "independent",
      ).task_id;
      await scheduler.cancel(root);
      const state = await scheduler.snapshot();
      assert.equal(
        state.tasks.find((t) => t.task_id === root).status,
        "cancelled",
      );
      assert.equal(
        state.tasks.find((t) => t.task_id === independent).status,
        "queued",
      );
      const descendants = state.tasks.filter(
        (t) => ![root, independent].includes(t.task_id),
      );
      assert.equal(descendants.length, 4);
      assert.ok(
        descendants.every(
          (t) =>
            t.status === "failed" &&
            t.last_error === "dependency_failed" &&
            t.attempts === 0,
        ),
      );
      assert.equal(
        state.events.filter((e) => e.event_type === "dependency_failed").length,
        4,
      );
      await scheduler.tick();
      assert.equal(
        (await scheduler.snapshot()).events.filter(
          (e) => e.event_type === "dependency_failed",
        ).length,
        4,
      );
    } finally {
      await scheduler.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await scheduler.close();
    }
  },
);

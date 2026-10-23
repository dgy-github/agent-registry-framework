import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Scheduler } from "../src/index.mjs";

test(
  "PostgreSQL: large DAG submission and cancellation have bounded query counts",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = "performance_test_" + randomUUID().replaceAll("-", "");
    const scheduler = new Scheduler(
      { connectionString: process.env.TEST_DATABASE_URL },
      {
        schema,
        capabilities: [{ name: "work", description: "Work" }],
      },
    );
    let queries = 0;
    const tx = scheduler.tx.bind(scheduler);
    scheduler.tx = (fn, readOnly) =>
      tx(
        (db) =>
          fn({
            query: (...args) => {
              queries++;
              return db.query(...args);
            },
          }),
        readOnly,
      );
    try {
      await scheduler.init();
      const tasks = Array.from({ length: 100 }, (_, i) => ({
        id: `task-${i}`,
        capability: "work",
        input: { index: i },
        dependencies: i ? [`task-${i - 1}`] : [],
      }));
      queries = 0;
      const start = performance.now();
      const request = randomUUID();
      const submitted = await scheduler.submit(request, { tasks });
      const submitQueries = queries;
      assert.ok(
        submitQueries <= 5,
        "submission must not issue per-task queries",
      );
      t.diagnostic(
        `100-task submit: ${submitQueries} queries, ${(performance.now() - start).toFixed(1)} ms`,
      );
      assert.equal(submitted.ids.length, 100);
      assert.deepEqual(await scheduler.submit(request, { tasks }), submitted);
      const state = await scheduler.snapshot();
      assert.equal(
        state.events.filter((e) => e.event_type === "queued").length,
        100,
      );
      const root = state.tasks.find((task) => task.input.index === 0);
      for (const task of state.tasks) {
        if (task.input.index) {
          const parent = state.tasks.find(
            (row) => row.input.index === task.input.index - 1,
          );
          assert.deepEqual(task.dependencies, [parent.task_id]);
        }
      }
      queries = 0;
      const cancelStart = performance.now();
      await scheduler.cancel(root.task_id);
      const cancelQueries = queries;
      assert.ok(
        cancelQueries <= 6,
        "failure propagation must not issue per-descendant queries",
      );
      t.diagnostic(
        `99 descendants cancelled: ${cancelQueries} queries, ${(performance.now() - cancelStart).toFixed(1)} ms`,
      );
      const final = await scheduler.snapshot();
      assert.equal(
        final.tasks.filter((task) => task.status === "failed").length,
        99,
      );
      assert.equal(
        final.events.filter((event) => event.event_type === "dependency_failed")
          .length,
        99,
      );
    } finally {
      await scheduler.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await scheduler.close();
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Scheduler, Worker, createRegistryServer } from "../src/index.mjs";

const database = process.env.TEST_DATABASE_URL;
const capabilities = [
  { name: "research", description: "Research / 研究" },
  { name: "compose", description: "Compose / 组合" },
];
const graph = () => ({
  tasks: [
    { id: "read", capability: "research", input: { query: "hello" } },
    { id: "compose", capability: "compose", dependencies: ["read"] },
  ],
});
test(
  "PostgreSQL: durable registry, DAG, concurrent claims, quota, fencing, retry and cancellation",
  { skip: !database },
  async () => {
    const schema = "registry_test_" + randomUUID().replaceAll("-", "");
    const options = {
      schema,
      capabilities,
      lease: 60,
      deadline: 120,
      capacity: 1,
      maxAttempts: 2,
    };
    let a = new Scheduler({ connectionString: database }, options);
    const b = new Scheduler({ connectionString: database }, options);
    try {
      await a.init();
      await b.init();
      const request = randomUUID(),
        submitted = await a.submit(request, graph());
      assert.deepEqual(await b.submit(request, graph()), submitted);
      await assert.rejects(
        a.submit(request, {
          tasks: [{ id: "changed", capability: "research" }],
        }),
        /Idempotency/,
      );
      await assert.rejects(
        a.submit(randomUUID(), { tasks: [{ id: "x", capability: "unknown" }] }),
        /Unknown capability/,
      );
      await assert.rejects(
        a.register("unknown-one", "unknown"),
        /Unknown capability/,
      );
      await a.register("research-one", "research");
      await b.register("research-two", "research");
      await a.register("compose-one", "compose");
      await assert.rejects(a.register("research-one", "compose"), /conflict/);
      assert.equal((await a.claim("compose-one", "compose")).task, null);
      const claims = await Promise.all([
        a.claim("research-one", "research"),
        b.claim("research-two", "research"),
      ]);
      assert.equal(claims.filter((c) => c.task).length, 1);
      const t = claims.find((c) => c.task).task,
        owner = t.agent_id;
      assert.equal(t.status, "running");
      assert.ok(t.attempt_id);
      assert.equal(
        (await a.heartbeat(owner, "research", t.call_id)).valid,
        true,
      );
      assert.equal(
        (
          await a.result("compose-one", "compose", t.call_id, {
            text: "forged",
          })
        ).accepted,
        false,
      );
      const extra = await a.submit(randomUUID(), graph());
      const other = owner === "research-one" ? "research-two" : "research-one";
      assert.equal((await a.claim(other, "research")).task, null);
      assert.equal(
        (await a.result(owner, "research", t.call_id, { text: "hello" }))
          .accepted,
        true,
      );
      assert.equal(
        (await a.result(owner, "research", t.call_id, { text: "duplicate" }))
          .accepted,
        false,
      );
      const summary = (await a.claim("compose-one", "compose")).task;
      assert.equal(summary.facts.length, 1);
      assert.equal(summary.facts[0].verified, false);
      await a.result("compose-one", "compose", summary.call_id, false);
      assert.equal(
        (await a.snapshot()).tasks.find((t) => t.task_id === summary.task_id)
          .result,
        false,
      );
      await a.close();
      a = new Scheduler({ connectionString: database }, options);
      assert.equal((await a.snapshot()).facts.length, 2);
      const retry = (await a.claim(owner, "research")).task;
      await a.pool.query(
        "UPDATE agent_attempts SET lease_until=now()-interval '1 second' WHERE call_id=$1",
        [retry.call_id],
      );
      await b.tick();
      const second = (await b.claim(owner, "research")).task;
      assert.equal(second.attempt, 2);
      assert.equal(
        (await a.result(owner, "research", retry.call_id, { text: "late" }))
          .accepted,
        false,
      );
      await a.result(owner, "research", second.call_id, null, "failure");
      await a.tick();
      let state = await a.snapshot();
      assert.ok(
        state.tasks
          .filter((t) => extra.ids.includes(t.task_id))
          .every((t) => t.status === "failed"),
      );
      await a.submit(randomUUID(), graph());
      const cancelled = (await a.claim(owner, "research")).task;
      await a.cancel(cancelled.task_id);
      assert.equal(
        (await a.heartbeat(owner, "research", cancelled.call_id)).valid,
        false,
      );
      assert.equal((await a.snapshot()).quota.used, 1);
      assert.equal(
        (await a.result(owner, "research", cancelled.call_id, { text: "late" }))
          .accepted,
        false,
      );
      assert.equal((await a.snapshot()).quota.used, 0);
      await a.register("stale-worker", "research");
      await a.pool.query(
        "UPDATE agent_workers SET lease_until=now()-interval '2 hours' WHERE agent_id='stale-worker'",
      );
      await a.tick();
      assert.ok(
        !(await a.snapshot()).agents.some((w) => w.agent_id === "stale-worker"),
      );
      await assert.rejects(
        a.claim("stale-worker", "research"),
        /not registered/,
      );
      await a.submit(randomUUID(), graph());
      const busy = (await a.claim(owner, "research")).task;
      await a.pool.query(
        "UPDATE agent_attempts SET deadline=now()-interval '1 second' WHERE call_id=$1",
        [busy.call_id],
      );
      assert.equal(
        (await a.heartbeat(owner, "research", busy.call_id)).valid,
        false,
      );
      await a.enable(other, false);
      assert.equal((await a.claim(other, "research")).task, null);
      state = await a.snapshot();
      assert.equal(state.capabilities.length, 2);
    } finally {
      await a.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.close();
      await b.close();
    }
  },
);

test(
  "HTTP workers automatically register and complete a domain-neutral workflow",
  { skip: !database },
  async () => {
    const schema = "registry_test_" + randomUUID().replaceAll("-", "");
    const scheduler = new Scheduler(
      { connectionString: database },
      { schema, capabilities },
    );
    const operator = "operator-integration-1234567890",
      research = "research-integration-1234567890",
      compose = "compose-integration-1234567890";
    const server = createRegistryServer(scheduler, {
      operatorToken: operator,
      workerTokens: { research, compose },
    });
    const stop = new AbortController();
    let running = [];
    try {
      await scheduler.init();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const url = `http://127.0.0.1:${server.address().port}`;
      const workers = [
        new Worker({
          url,
          token: research,
          capability: "research",
          pollMs: 20,
          heartbeatMs: 20,
          handler: async (task, { signal }) => {
            await delay(80, undefined, { signal });
            return { text: task.input.query.toUpperCase() };
          },
        }),
        new Worker({
          url,
          token: compose,
          capability: "compose",
          pollMs: 20,
          handler: async (task) => ({
            text: task.facts.map((f) => f.value.text).join(" "),
          }),
        }),
      ];
      running = workers.map((w) => w.run({ signal: stop.signal }));
      const response = await fetch(url + "/api/tasks", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${operator}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ request_id: randomUUID(), plan: graph() }),
      });
      assert.equal(response.status, 201);
      const { ids } = await response.json();
      let completed = false;
      for (let i = 0; i < 100; i++) {
        const state = await scheduler.snapshot();
        if (
          state.tasks
            .filter((t) => ids.includes(t.task_id))
            .every((t) => t.status === "completed")
        ) {
          assert.equal(
            state.tasks.find((t) => t.capability === "compose").result.text,
            "HELLO",
          );
          assert.equal(state.agents.length, 2);
          completed = true;
          break;
        }
        await delay(30);
      }
      assert.equal(completed, true);
    } finally {
      stop.abort();
      await Promise.all(running);
      await new Promise((resolve) => server.close(resolve));
      await scheduler.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await scheduler.close();
    }
  },
);

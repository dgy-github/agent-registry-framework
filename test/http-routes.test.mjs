import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRegistryServer, renderConsoleHtml } from "../src/index.mjs";

const operator = "operator-test-token-123456789";
const worker = "worker-test-token-1234567890";

// Stub scheduler: every method records its call and resolves { ok: true, method }.
function stubScheduler(overrides = {}) {
  const calls = [];
  const scheduler = new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "wakeup" || prop === "then") return undefined;
      return async (...args) => {
        calls.push([prop, args]);
        return { ok: true, method: prop };
      };
    },
  });
  return { scheduler, calls };
}

async function withServer(options, fn) {
  const { scheduler, calls } = stubScheduler(options.overrides);
  const server = createRegistryServer(scheduler, {
    operatorToken: operator,
    workerTokens: { research: worker },
    ...(options.server ?? {}),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, auth, data, contentType = "application/json") =>
    fetch(url + route, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(data !== undefined ? { "Content-Type": contentType } : {}),
      },
      body:
        data === undefined
          ? undefined
          : typeof data === "string"
            ? data
            : JSON.stringify(data),
    });
  try {
    await fn({ url, call, calls });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const routes = [
  ["GET", "/api/harness/genome", undefined, "getGenome", 200],
  ["POST", "/api/harness/genome", { candidate: {} }, "updateGenome", 200],
  ["GET", "/api/harness/ledger", undefined, "getHarnessLedger", 200],
  ["POST", "/api/harness/calibrate", {}, "calibrateHarness", 200],
  [
    "POST",
    "/api/harness/compare",
    { arm_a: [], arm_b: [] },
    "compareHarnessArms",
    200,
  ],
  ["GET", "/api/memory/search?q=x", undefined, "searchMemory", 200],
  ["POST", "/api/memory/rollback", { fact_key: "a.b" }, "rollbackFact", 200],
  [
    "POST",
    "/api/memory/promote-invariant",
    { namespace: "org.x" },
    "promoteMemoryInvariant",
    200,
  ],
  ["GET", "/api/playbooks", undefined, "listPlaybooks", 200],
  [
    "POST",
    "/api/playbooks",
    { playbook_id: "pb-1" },
    "crystallizePlaybook",
    201,
  ],
  ["DELETE", "/api/playbooks", { playbook_id: "pb-1" }, "deletePlaybook", 200],
  ["POST", "/api/playbooks/run", { playbook_id: "pb-1" }, "runPlaybook", 201],
  [
    "POST",
    "/api/playbooks/evolve",
    { playbook_id: "pb-1" },
    "evolvePlaybook",
    200,
  ],
  ["POST", "/api/triggers", { trigger_id: "t-1" }, "upsertTrigger", 201],
  ["POST", "/api/triggers/fire", { trigger_id: "t-1" }, "fireTrigger", 200],
  ["POST", "/api/planner/submit", { goal: "g" }, null, null],
  ["GET", "/api/bundle", undefined, "exportBundle", 200],
  ["POST", "/api/bundle", { facts: [] }, "importBundle", 200],
  [
    "POST",
    "/api/tasks/fork",
    { source_request_id: "r1", new_request_id: "r2" },
    "forkRequest",
    201,
  ],
  [
    "POST",
    "/api/workers/enable",
    { agent_id: "worker-one", enabled: false },
    "enable",
    200,
  ],
  ["POST", "/api/cancel", { task_id: "task-1" }, "cancel", 200],
];

test("public endpoints: /health is 200 JSON and /ui is text/html", async () => {
  await withServer({}, async ({ call }) => {
    const health = await call("GET", "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const ui = await call("GET", "/ui");
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get("content-type"), /^text\/html/);
    assert.equal(ui.headers.get("cache-control"), "no-store");
  });
});

test("every new /api route rejects missing token and worker token (401) without touching the scheduler", async () => {
  await withServer({}, async ({ call, calls }) => {
    for (const [method, route, data] of routes) {
      assert.equal(
        (await call(method, route, null, data)).status,
        401,
        `${method} ${route} no token`,
      );
      assert.equal(
        (await call(method, route, worker, data)).status,
        401,
        `${method} ${route} worker token`,
      );
      assert.equal(
        (await call(method, route, "Bearer-garbage-xxxxxxxxxxxxxxxx", data))
          .status,
        401,
      );
    }
    assert.deepEqual(calls, []);
  });
});

test("every new /api route succeeds with the operator token and dispatches to the scheduler", async () => {
  await withServer({}, async ({ call, calls }) => {
    for (const [method, route, data, schedulerMethod, status] of routes) {
      if (!schedulerMethod) continue;
      const before = calls.length;
      const res = await call(method, route, operator, data);
      assert.equal(res.status, status, `${method} ${route}`);
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1)[0], schedulerMethod);
    }
  });
});

test("argument mapping for selected routes", async () => {
  await withServer({}, async ({ call, calls }) => {
    await call(
      "GET",
      "/api/memory/search?q=iso&prefix=org.&min_confidence=0.5&limit=5",
      operator,
    );
    assert.deepEqual(calls.at(-1), [
      "searchMemory",
      ["iso", { prefix: "org.", minConfidence: 0.5, limit: 5 }],
    ]);
    await call("GET", "/api/memory/search", operator);
    assert.deepEqual(calls.at(-1), [
      "searchMemory",
      ["", { prefix: null, minConfidence: null, limit: 20 }],
    ]);
    await call("POST", "/api/workers/enable", operator, {
      agent_id: "worker-one",
      enabled: true,
    });
    assert.deepEqual(calls.at(-1), ["enable", ["worker-one", true]]);
    await call("POST", "/api/triggers/fire", operator, { trigger_id: "t-1" });
    assert.deepEqual(calls.at(-1), [
      "fireTrigger",
      ["t-1", { requestId: null, payload: null, source: "manual" }],
    ]);
    // With metrics, genome POST goes through evolveGenome (gated) instead of updateGenome.
    await call("POST", "/api/harness/genome", operator, {
      candidate: {},
      incumbent_metrics: {},
      candidate_metrics: {},
    });
    assert.equal(calls.at(-1)[0], "evolveGenome");
  });
});

test("invalid bodies are rejected with 400 before reaching the scheduler", async () => {
  await withServer({}, async ({ call, calls }) => {
    for (const [method, route, data] of routes) {
      if (data === undefined) continue;
      assert.equal(
        (await call(method, route, operator, "{not json")).status,
        400,
        `${route} bad json`,
      );
      assert.equal(
        (await call(method, route, operator, "[1,2]")).status,
        400,
        `${route} array`,
      );
      assert.equal(
        (await call(method, route, operator, "{}", "text/plain")).status,
        400,
        `${route} content-type`,
      );
    }
    for (const bad of [
      { agent_id: "w", enabled: "yes" },
      { enabled: true },
      {},
    ]) {
      const res = await call("POST", "/api/workers/enable", operator, bad);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "invalid_worker_state" });
    }
    assert.deepEqual(calls, []);
  });
});

test("scheduler errors are mapped without leaking details; unknown trigger -> 400 request_rejected (not 404)", async () => {
  await withServer(
    {
      overrides: {
        fireTrigger: async () => {
          throw Error("Unknown trigger secret-detail");
        },
        cancel: async () => {
          throw Object.assign(Error("connect ECONNREFUSED postgres://u:p@h"), {
            code: "ECONNREFUSED",
          });
        },
      },
    },
    async ({ call }) => {
      const fire = await call("POST", "/api/triggers/fire", operator, {
        trigger_id: "nope",
      });
      assert.equal(fire.status, 400);
      const text = await fire.text();
      assert.deepEqual(JSON.parse(text), { error: "request_rejected" });
      assert.doesNotMatch(text, /secret-detail/);
      const cancel = await call("POST", "/api/cancel", operator, {
        task_id: "t",
      });
      assert.equal(cancel.status, 503);
      assert.doesNotMatch(await cancel.text(), /postgres|ECONN/);
      assert.equal((await call("GET", "/api/nope", operator)).status, 404);
    },
  );
});

test("planner/submit requires operator token and passes through to Planner.submitGoal", async () => {
  const seen = [];
  const planner = {
    submitGoal: async (s, goal, opts) => {
      seen.push([goal, opts.requestId]);
      return { ok: true };
    },
  };
  await withServer({ server: { planner } }, async ({ call }) => {
    assert.equal(
      (await call("POST", "/api/planner/submit", worker, { goal: "g" })).status,
      401,
    );
    const res = await call("POST", "/api/planner/submit", operator, {
      goal: "g",
      request_id: "r-1",
    });
    assert.equal(res.status, 201);
    assert.deepEqual(seen, [["g", "r-1"]]);
  });
});

test("renderConsoleHtml: no token leaks when none is passed", () => {
  const html = renderConsoleHtml();
  assert.doesNotMatch(html, new RegExp(operator));
  assert.match(html, /sessionStorage\.getItem\("ar_operator_token"\) \|\| ""/);
});

// SECURITY: defaultToken must be escaped for inline <script> (fixed via safeJsonForScript).
test("SECURITY: renderConsoleHtml escapes a malicious defaultToken (no </script> breakout)", () => {
  const evil = "</script><script>alert(1)</script>";
  const html = renderConsoleHtml({ defaultToken: evil });
  assert.equal(
    html.includes("<script>alert(1)</script>"),
    false,
    "raw script injected into HTML",
  );
  // Value is still embedded (escaped) and round-trips to the original string in JS.
  const m = html.match(/getItem\("ar_operator_token"\) \|\| (".*?"),/);
  assert.ok(m, "token literal present");
  assert.equal(JSON.parse(m[1]), evil);
  assert.doesNotMatch(m[1], /[<>&\u2028\u2029]/);
});

// SECURITY: /ui is anonymous; legacy uiDefaultToken must be ignored (never embedded).
test("SECURITY: unauthenticated GET /ui must not disclose the operator token", async () => {
  await withServer(
    { server: { uiDefaultToken: operator } },
    async ({ call }) => {
      const html = await (await call("GET", "/ui")).text();
      assert.equal(
        html.includes(operator),
        false,
        "operator token served to anonymous client",
      );
    },
  );
});

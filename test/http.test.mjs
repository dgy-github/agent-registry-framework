import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createRegistryServer } from "../src/index.mjs";

const operator = "operator-test-token-123456789";
const token = "worker-test-token-1234567890";
test("HTTP preserves UTF-8 characters split across network chunks", async () => {
  let received;
  const server = createRegistryServer(
    {
      submit: async (id, plan) => {
        received = plan;
        return { ids: [] };
      },
    },
    { operatorToken: operator, workerTokens: { research: token } },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const plan = { tasks: [{ input: { text: "智能反馈🌏" } }] };
    const payload = Buffer.from(
      JSON.stringify({ request_id: "request-123", plan }),
    );
    const split = payload.indexOf(Buffer.from("智")) + 1;
    const result = new Promise((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${server.address().port}/api/tasks`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${operator}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.write(payload.subarray(0, split));
      delay(30).then(() => req.end(payload.subarray(split)));
    });
    assert.equal(await result, 201);
    assert.deepEqual(received, plan);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("HTTP authorization prevents cross-capability and management access", async () => {
  const calls = [];
  const server = createRegistryServer(
    {
      register: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
      snapshot: async () => ({ tasks: [] }),
      telemetry: async () => ({ capabilities: [], workers: [], memory: [] }),
      expand: async (...args) => {
        calls.push(args);
        return { ids: ["sub-1"] };
      },
      reviewFact: async (...args) => {
        calls.push(args);
        return { accepted: true };
      },
      reviewFactByVerifier: async (...args) => {
        calls.push(args);
        return { accepted: true, source: "verifier" };
      },
    },
    { operatorToken: operator, workerTokens: { research: token } },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, auth, data) =>
    fetch(url + route, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await fetch(url + "/api/state")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/state", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post("/internal/register", token, {
          agent_id: "worker-one",
          capability: "other",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post("/internal/register", operator, {
          agent_id: "worker-one",
          capability: "research",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post("/internal/register", token, {
          agent_id: "worker-one",
          capability: "research",
        })
      ).status,
      200,
    );
    assert.deepEqual(calls, [["worker-one", "research"]]);
    const review = {
      task_id: "task-one",
      version: 1,
      verified: true,
      note: "checked",
    };
    assert.equal((await post("/api/facts/review", token, review)).status, 401);
    assert.equal(calls.length, 1);
    const reviewed = await post("/api/facts/review", operator, review);
    assert.equal(reviewed.status, 200);
    assert.deepEqual(await reviewed.json(), { accepted: true });
    assert.deepEqual(calls[1], [
      "task-one",
      1,
      true,
      "checked",
      { rework: false, confidence: null, ttlSeconds: null },
    ]);
    const verifierReviewed = await post("/internal/review", token, {
      agent_id: "worker-one",
      capability: "research",
      ...review,
      confidence: 0.9,
    });
    assert.equal(verifierReviewed.status, 200);
    assert.deepEqual(calls[2], [
      "worker-one",
      "research",
      "task-one",
      1,
      true,
      "checked",
      { rework: false, confidence: 0.9, ttlSeconds: null },
    ]);
    const expansion = {
      request_id: "request-123",
      expansion_id: "expand-123",
      parent_task_id: "task-one",
      rewire_dependents: true,
      plan: { tasks: [{ id: "step-2", capability: "research" }] },
    };
    assert.equal(
      (await post("/api/tasks/expand", token, expansion)).status,
      401,
    );
    const expanded = await post("/api/tasks/expand", operator, expansion);
    assert.equal(expanded.status, 201);
    assert.deepEqual(await expanded.json(), { ids: ["sub-1"] });
    assert.deepEqual(calls[3], [
      "request-123",
      "expand-123",
      "task-one",
      expansion.plan,
      { rewireDependents: true },
    ]);
    assert.equal(
      (
        await fetch(url + "/api/telemetry", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(url + "/api/telemetry", {
          headers: { Authorization: `Bearer ${operator}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post("/internal/register", token, {
          agent_id: "bad",
          capability: "research",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/internal/result", token, {
          agent_id: "worker-one",
          capability: "research",
          call_id: "x",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url + "/api/state", {
          headers: { Authorization: `Bearer ${operator}` },
        })
      ).status,
      200,
    );
    const uiRes = await fetch(url + "/");
    assert.equal(uiRes.status, 200);
    assert.match(uiRes.headers.get("content-type") || "", /text\/html/);
    assert.match(await uiRes.text(), /Agent Registry Framework/);
    assert.equal((await fetch(url + "/api/events")).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("configuration rejects shared credentials and short secrets", () => {
  assert.throws(() =>
    createRegistryServer(
      {},
      { operatorToken: operator, workerTokens: { x: operator } },
    ),
  );
  assert.throws(() =>
    createRegistryServer({}, { operatorToken: "short", workerTokens: {} }),
  );
});

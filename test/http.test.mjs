import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRegistryServer } from "../src/index.mjs";

const operator = "operator-test-token-123456789";
const token = "worker-test-token-1234567890";
test("HTTP authorization prevents cross-capability and management access", async () => {
  const calls = [];
  const server = createRegistryServer(
    {
      register: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
      snapshot: async () => ({ tasks: [] }),
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

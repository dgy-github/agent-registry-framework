import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/index.mjs";

const task = () => ({
  call_id: "call-one",
  deadline: new Date(Date.now() + 60000).toISOString(),
});
const worker = (handler) =>
  new Worker({
    url: "http://localhost",
    token: "test",
    capability: "work",
    handler,
  });

test("a lost success receipt never becomes a handler failure", async () => {
  const w = worker(async () => ({ text: "done" }));
  const receipts = [];
  w.api = async (action, data) => {
    receipts.push(data);
    throw Error("connection lost");
  };
  await assert.rejects(w.execute(task()), /connection lost/);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].error, null);
  assert.deepEqual(receipts[0].result, { text: "done" });
});

test("already cancelled work never invokes the handler", async () => {
  let invoked = false;
  const w = worker(async () => {
    invoked = true;
    return true;
  });
  const receipts = [];
  w.api = async (action, data) => {
    receipts.push(data);
    return { accepted: false };
  };
  await w.execute(task(), AbortSignal.abort());
  assert.equal(invoked, false);
  assert.equal(receipts[0].error, "cancelled");
});

test("expired work never invokes the handler", async () => {
  let invoked = false;
  const w = worker(async () => {
    invoked = true;
    return true;
  });
  w.api = async () => ({ accepted: false });
  await w.execute({ ...task(), deadline: new Date(0).toISOString() });
  assert.equal(invoked, false);
});

test("cancellation waits for the active handler to stop before acknowledging", async () => {
  const stop = new AbortController();
  let release;
  const stopped = new Promise((resolve) => {
    release = resolve;
  });
  const w = worker(async () => {
    await stopped;
    return true;
  });
  const receipts = [];
  w.api = async (action, data) => {
    receipts.push(data);
    return { accepted: false };
  };
  const executing = w.execute(task(), stop.signal);
  stop.abort();
  await Promise.resolve();
  assert.equal(receipts.length, 0);
  release();
  await executing;
  assert.deepEqual(receipts, [{ call_id: "call-one", error: "cancelled" }]);
});

test("handler errors and non-JSON results produce one failure receipt", async () => {
  for (const handler of [
    async () => {
      throw Error("private details");
    },
    async () => undefined,
    async () => 1n,
  ]) {
    const w = worker(handler);
    const receipts = [];
    w.api = async (action, data) => {
      receipts.push(data);
      return { accepted: true };
    };
    await w.execute(task());
    assert.deepEqual(receipts, [
      { call_id: "call-one", error: "handler_failed" },
    ]);
  }
});

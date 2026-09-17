import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCapabilities,
  validatePlan,
  Scheduler,
} from "../src/index.mjs";

const task = (id, dependencies = []) => ({
  id,
  capability: "research",
  dependencies,
});
test("arbitrary capability catalogs and normalized, detached graphs", () => {
  validateCapabilities([{ name: "research", description: "Research / 研究" }]);
  const input = { query: "hello" };
  const plan = validatePlan("request-123", {
    tasks: [task("b", ["a"]), { ...task("a"), input }],
  });
  input.query = "changed";
  assert.equal(plan.tasks[0].input.query, "hello");
  assert.deepEqual(
    plan.tasks.map((t) => t.id),
    ["a", "b"],
  );
});
test("invalid catalogs, duplicate ids, missing dependencies and cycles fail before storage", () => {
  assert.throws(() =>
    validateCapabilities([
      { name: "x", description: "x" },
      { name: "x", description: "y" },
    ]),
  );
  assert.throws(() =>
    validateCapabilities([{ name: "Bad name", description: "x" }]),
  );
  for (const tasks of [
    [task("a"), task("a")],
    [task("a", ["absent"])],
    [task("a", ["a"])],
    [task("a", ["b"]), task("b", ["a"])],
  ]) {
    assert.throws(() => validatePlan("request-123", { tasks }));
  }
  assert.throws(() => validatePlan("short", { tasks: [task("a")] }));
  assert.throws(() => validatePlan("request-123", { tasks: [] }));
  assert.throws(() =>
    validatePlan("request-123", { tasks: [{ ...task("a"), input: [] }] }),
  );
  assert.throws(() => new Scheduler({}, { schema: "unsafe;drop" }));
  assert.throws(() => new Scheduler({}, { capacity: 0 }));
  assert.throws(() => new Scheduler({}, { lease: 10, deadline: 1 }));
});

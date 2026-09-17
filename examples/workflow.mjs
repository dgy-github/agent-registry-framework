import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "../src/index.mjs";

const url = process.env.REGISTRY_URL || "http://127.0.0.1:8766";
const operator = process.env.REGISTRY_OPERATOR_TOKEN;
if (
  !operator ||
  !process.env.NORMALIZE_WORKER_TOKEN ||
  !process.env.SUMMARIZE_WORKER_TOKEN
)
  throw Error("Set the three documented tokens");
const stop = new AbortController();
const workers = [
  new Worker({
    url,
    token: process.env.NORMALIZE_WORKER_TOKEN,
    capability: "text.normalize",
    handler: async (task) => ({ text: task.input.text.trim().toUpperCase() }),
  }),
  new Worker({
    url,
    token: process.env.SUMMARIZE_WORKER_TOKEN,
    capability: "text.summarize",
    handler: async (task) => ({
      text: task.facts.map((f) => f.value.text).join(" | "),
    }),
  }),
];
async function api(route, body) {
  const response = await fetch(url + route, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${operator}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error(`API returned ${response.status}`);
  return response.json();
}
const running = workers.map((w) => w.run({ signal: stop.signal }));
try {
  const { ids } = await api("/api/tasks", {
    request_id: randomUUID(),
    plan: {
      tasks: [
        {
          id: "normalize",
          capability: "text.normalize",
          input: { text: "  hello agents  " },
        },
        {
          id: "summary",
          capability: "text.summarize",
          dependencies: ["normalize"],
        },
      ],
    },
  });
  let complete = false;
  for (let i = 0; i < 60; i++) {
    const state = await api("/api/state");
    const tasks = state.tasks.filter((t) => ids.includes(t.task_id));
    if (tasks.some((t) => ["failed", "cancelled"].includes(t.status)))
      throw Error("Workflow failed");
    if (
      tasks.length === ids.length &&
      tasks.every((t) => t.status === "completed")
    ) {
      console.log(
        JSON.stringify(
          tasks.map((t) => ({ capability: t.capability, result: t.result })),
          null,
          2,
        ),
      );
      complete = true;
      break;
    }
    await delay(500);
  }
  if (!complete) throw Error("Workflow timed out");
} finally {
  stop.abort();
  await Promise.all(running);
}

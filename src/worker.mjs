import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** EN: Pull worker with automatic registration, heartbeats and cooperative cancellation.
 * 中文：主动注册、拉取任务、续租与协作取消的 Worker；业务函数由调用方提供。
 * handler(task,{signal}) must honor cancellation and return a JSON value.
 * handler 必须响应 signal，并返回可序列化的 JSON 值；外部副作用须自行幂等。
 */
export class Worker {
  constructor({
    url,
    token,
    capability,
    handler,
    id = `worker-${randomUUID()}`,
    pollMs = 1000,
    heartbeatMs = 10000,
    requestTimeoutMs = 5000,
  }) {
    if (typeof handler !== "function" || !token || !capability)
      throw Error("Worker requires handler, token and capability");
    for (const value of [pollMs, heartbeatMs, requestTimeoutMs])
      if (!Number.isSafeInteger(value) || value < 1)
        throw Error("Invalid worker timing");
    Object.assign(this, {
      url: url.replace(/\/$/, ""),
      token,
      capability,
      handler,
      id,
      pollMs,
      heartbeatMs,
      requestTimeoutMs,
    });
  }
  async api(action, data = {}) {
    const response = await fetch(`${this.url}/internal/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        ...data,
        agent_id: this.id,
        capability: this.capability,
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok)
      throw Error(`Worker endpoint returned ${response.status}`);
    return response.json();
  }
  async review(
    taskId,
    version,
    verified,
    note,
    { rework = false, confidence = null, ttlSeconds = null } = {},
  ) {
    return this.api("review", {
      task_id: taskId,
      version,
      verified,
      note,
      rework,
      ...(confidence !== null ? { confidence } : {}),
      ...(ttlSeconds !== null ? { ttl_seconds: ttlSeconds } : {}),
    });
  }
  async execute(task, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const remaining = Date.parse(task.deadline) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) abort();
    const pulseStop = new AbortController();
    const deadline = setTimeout(abort, Math.max(1, remaining || 1));
    const pulse = (async () => {
      while (!pulseStop.signal.aborted) {
        try {
          await delay(this.heartbeatMs, undefined, {
            signal: pulseStop.signal,
          });
          const heartbeat = await this.api("heartbeat", {
            call_id: task.call_id,
          });
          if (!heartbeat.valid) {
            abort();
            break;
          }
        } catch {
          if (!pulseStop.signal.aborted) abort();
          break;
        }
      }
    })();
    try {
      let receipt;
      let usage;
      try {
        controller.signal.throwIfAborted();
        const result = await this.handler(task, {
          signal: controller.signal,
          reportUsage: (u) => {
            usage = u;
          },
          review: (taskId, version, verified, note, opts) =>
            this.review(taskId, version, verified, note, opts),
        });
        // Validate and detach before transport so serialization errors are handler failures.
        const encoded = JSON.stringify(result);
        if (encoded === undefined) throw Error("Handler must return JSON");
        receipt = controller.signal.aborted
          ? { error: "cancelled" }
          : { result: JSON.parse(encoded), error: null };
      } catch {
        receipt = {
          error: controller.signal.aborted ? "cancelled" : "handler_failed",
        };
      }
      if (usage !== undefined) receipt.usage = usage;
      // A lost response does not mean execution failed. Let run() re-register;
      // the scheduler keeps ownership until receipt acceptance or lease expiry.
      await this.api("result", { call_id: task.call_id, ...receipt });
    } finally {
      pulseStop.abort();
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      await pulse;
    }
  }
  /** EN: Run until aborted; transient transport failures trigger re-registration.
   * 中文：运行至 signal 取消；通信失败后重新注册，离线实例由租约回收。
   */
  async run({ signal } = {}) {
    let registered = false;
    while (!signal?.aborted) {
      try {
        if (!registered) {
          await this.api("register");
          registered = true;
        }
        const { task } = await this.api("claim");
        if (task) {
          await this.execute(task, signal);
          continue;
        }
      } catch {
        registered = false;
      }
      await delay(this.pollMs, undefined, { signal }).catch(() => {});
    }
  }
}

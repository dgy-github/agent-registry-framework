import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function body(request) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw Error("JSON required");
  let value = "";
  for await (const chunk of request) {
    value += chunk;
    if (Buffer.byteLength(value) > 1_000_000) throw Error("Body too large");
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("Object required");
  return parsed;
}

/** EN: HTTP boundary; operators and capability-scoped workers use separate credentials.
 * 中文：HTTP 信任边界；管理端凭据与各能力 Worker 凭据相互分离。
 * Returns an unbound http.Server; caller owns listen/close and scheduler lifetime.
 * 返回未监听的服务；调用方负责启动、关闭以及 Scheduler 生命周期。
 */
export function createRegistryServer(
  scheduler,
  { operatorToken, workerTokens },
) {
  if (
    typeof operatorToken !== "string" ||
    operatorToken.length < 24 ||
    !workerTokens ||
    Object.values(workerTokens).some(
      (t) => typeof t !== "string" || t.length < 24,
    ) ||
    new Set([operatorToken, ...Object.values(workerTokens)]).size !==
      Object.keys(workerTokens).length + 1
  ) {
    throw Error("Provide distinct credentials of at least 24 characters");
  }
  return createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(data));
    };
    try {
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      const route = request.url;
      if (route === "/health" && request.method === "GET")
        return send(200, { ok: true });
      if (route?.startsWith("/internal/")) {
        if (request.method !== "POST")
          return send(405, { error: "method_not_allowed" });
        const data = await body(request);
        if (
          !Object.hasOwn(workerTokens, data.capability) ||
          !equal(token, workerTokens[data.capability])
        )
          return send(401, { error: "unauthorized" });
        if (
          typeof data.agent_id !== "string" ||
          !/^[\w-]{4,100}$/.test(data.agent_id)
        )
          return send(400, { error: "invalid_agent" });
        let result;
        switch (route) {
          case "/internal/register":
            result = await scheduler.register(data.agent_id, data.capability);
            break;
          case "/internal/claim":
            result = await scheduler.claim(data.agent_id, data.capability);
            break;
          case "/internal/heartbeat":
            result = await scheduler.heartbeat(
              data.agent_id,
              data.capability,
              data.call_id,
            );
            break;
          case "/internal/result":
            if (
              typeof data.call_id !== "string" ||
              (!Object.hasOwn(data, "result") && !data.error)
            )
              return send(400, { error: "result_required" });
            result = await scheduler.result(
              data.agent_id,
              data.capability,
              data.call_id,
              data.result ?? null,
              data.error,
            );
            break;
          default:
            return send(404, { error: "not_found" });
        }
        return send(200, result);
      }
      if (!equal(token, operatorToken))
        return send(401, { error: "unauthorized" });
      if (route === "/api/state" && request.method === "GET")
        return send(200, await scheduler.snapshot());
      if (route === "/api/tasks" && request.method === "POST") {
        const data = await body(request);
        return send(201, await scheduler.submit(data.request_id, data.plan));
      }
      if (route === "/api/cancel" && request.method === "POST") {
        const data = await body(request);
        return send(200, await scheduler.cancel(data.task_id));
      }
      if (route === "/api/workers/enable" && request.method === "POST") {
        const data = await body(request);
        if (
          typeof data.enabled !== "boolean" ||
          typeof data.agent_id !== "string"
        )
          return send(400, { error: "invalid_worker_state" });
        return send(200, await scheduler.enable(data.agent_id, data.enabled));
      }
      send(404, { error: "not_found" });
    } catch (error) {
      // EN: Never disclose driver errors, connection strings, or task payloads.
      // 中文：不向客户端泄露驱动异常、连接字符串或任务内容。
      const unavailable = error.code && /^[A-Z0-9]{5,}$/.test(error.code);
      send(unavailable ? 503 : 400, {
        error: unavailable ? "storage_unavailable" : "request_rejected",
      });
    }
  });
}

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { renderConsoleHtml } from "./ui.mjs";
import { Planner } from "./planner.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function body(request) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw Error("JSON required");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw Error("Body too large");
    chunks.push(chunk);
  }
  // Decode once: a multibyte character can straddle network chunks.
  const parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
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
  { operatorToken, workerTokens, planner = new Planner(), uiDefaultToken = "" },
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
      if ((route === "/" || route === "/ui") && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        return response.end(
          renderConsoleHtml({ defaultToken: uiDefaultToken }),
        );
      }
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
            result =
              data.wait_ms === undefined
                ? await scheduler.claim(data.agent_id, data.capability)
                : await scheduler.claim(data.agent_id, data.capability, {
                    waitMs: data.wait_ms,
                  });
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
              data.usage ?? null,
            );
            break;
          case "/internal/review":
            result = await scheduler.reviewFactByVerifier(
              data.agent_id,
              data.capability,
              data.task_id,
              data.version,
              data.verified,
              data.note,
              {
                rework: data.rework ?? false,
                confidence: data.confidence ?? null,
                ttlSeconds: data.ttl_seconds ?? null,
              },
            );
            break;
          default:
            return send(404, { error: "not_found" });
        }
        return send(200, result);
      }
      if (!equal(token, operatorToken))
        return send(401, { error: "unauthorized" });
      if (route === "/api/events" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write('data: {"type":"connected"}\n\n');
        const onWake = () => {
          response.write('data: {"type":"wake"}\n\n');
        };
        scheduler.wakeup?.on("wake", onWake);
        request.on("close", () => {
          scheduler.wakeup?.off("wake", onWake);
        });
        return;
      }
      if (route === "/api/state" && request.method === "GET")
        return send(200, await scheduler.snapshot());
      if (route === "/api/telemetry" && request.method === "GET")
        return send(200, await scheduler.telemetry());
      if (route === "/api/tasks" && request.method === "POST") {
        const data = await body(request);
        return send(201, await scheduler.submit(data.request_id, data.plan));
      }
      if (route === "/api/planner/submit" && request.method === "POST") {
        const data = await body(request);
        return send(
          201,
          await planner.submitGoal(scheduler, data.goal, {
            requestId: data.request_id,
            traceId: data.trace_id ?? undefined,
            budget: data.budget ?? null,
            inputDefaults: data.input_defaults ?? {},
            factKey: data.fact_key ?? null,
            minWorkerPassRate: data.min_worker_pass_rate ?? null,
          }),
        );
      }
      if (route === "/api/triggers" && request.method === "POST") {
        const data = await body(request);
        return send(201, await scheduler.upsertTrigger(data.trigger_id, data));
      }
      if (route === "/api/triggers/fire" && request.method === "POST") {
        const data = await body(request);
        return send(
          200,
          await scheduler.fireTrigger(data.trigger_id, {
            requestId: data.request_id ?? null,
            payload: data.payload ?? null,
            source: data.source ?? "manual",
          }),
        );
      }
      if (route === "/api/tasks/expand" && request.method === "POST") {
        const data = await body(request);
        return send(
          201,
          await scheduler.expand(
            data.request_id,
            data.expansion_id,
            data.parent_task_id,
            data.plan,
            { rewireDependents: data.rewire_dependents ?? false },
          ),
        );
      }
      if (route === "/api/cancel" && request.method === "POST") {
        const data = await body(request);
        return send(200, await scheduler.cancel(data.task_id));
      }
      if (route === "/api/facts/review" && request.method === "POST") {
        const data = await body(request);
        return send(
          200,
          await scheduler.reviewFact(
            data.task_id,
            data.version,
            data.verified,
            data.note,
            {
              rework: data.rework ?? false,
              confidence: data.confidence ?? null,
              ttlSeconds: data.ttl_seconds ?? null,
            },
          ),
        );
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
      if (
        (route === "/api/memory/search" ||
          route?.startsWith("/api/memory/search?")) &&
        request.method === "GET"
      ) {
        const u = new URL(request.url, "http://127.0.0.1");
        const q = u.searchParams.get("q") ?? "";
        const prefix = u.searchParams.get("prefix") || null;
        const minConfStr = u.searchParams.get("min_confidence");
        const minConfidence = minConfStr ? Number(minConfStr) : null;
        const limitStr = u.searchParams.get("limit");
        const limit = limitStr ? Number(limitStr) : 20;
        return send(
          200,
          await scheduler.searchMemory(q, { prefix, minConfidence, limit }),
        );
      }
      if (route === "/api/memory/rollback" && request.method === "POST") {
        const data = await body(request);
        return send(
          200,
          await scheduler.rollbackFact(data.fact_key, {
            note: data.note ?? "Rolled back by operator",
          }),
        );
      }
      if (route === "/api/tasks/fork" && request.method === "POST") {
        const data = await body(request);
        return send(
          201,
          await scheduler.forkRequest(
            data.source_request_id,
            data.new_request_id,
            {
              fromTaskKey: data.from_task_key ?? null,
              inputOverrides: data.input_overrides ?? {},
              traceId: data.trace_id ?? null,
              budget: data.budget ?? null,
            },
          ),
        );
      }
      if (route === "/api/bundle" && request.method === "GET") {
        return send(200, await scheduler.exportBundle());
      }
      if (route === "/api/bundle" && request.method === "POST") {
        const data = await body(request);
        return send(200, await scheduler.importBundle(data));
      }
      if (route === "/api/playbooks" && request.method === "GET") {
        return send(200, await scheduler.listPlaybooks());
      }
      if (route === "/api/playbooks" && request.method === "POST") {
        const data = await body(request);
        return send(
          201,
          await scheduler.crystallizePlaybook(data.playbook_id, {
            sourceRequestId: data.source_request_id ?? null,
            description: data.description ?? "",
            tags: data.tags ?? [],
            plan: data.plan ?? null,
          }),
        );
      }
      if (route === "/api/playbooks/run" && request.method === "POST") {
        const data = await body(request);
        return send(
          201,
          await scheduler.runPlaybook(
            data.playbook_id,
            data.request_id ?? null,
            {
              inputOverrides: data.input_overrides ?? {},
              params: data.params ?? {},
              traceId: data.trace_id ?? null,
              budget: data.budget ?? null,
            },
          ),
        );
      }
      if (route === "/api/playbooks" && request.method === "DELETE") {
        const data = await body(request);
        return send(200, await scheduler.deletePlaybook(data.playbook_id));
      }
      if (route === "/api/playbooks/evolve" && request.method === "POST") {
        const data = await body(request);
        return send(
          200,
          await scheduler.evolvePlaybook(data.playbook_id, {
            sourceRequestId: data.source_request_id ?? null,
            plan: data.plan ?? null,
            description: data.description ?? "",
            tags: data.tags ?? [],
            hypothesis: data.hypothesis ?? "",
            round: data.round ?? 1,
            incumbentMetrics: data.incumbent_metrics ?? {},
            candidateMetrics: data.candidate_metrics ?? {},
            deltaPass: data.delta_pass ?? 0.05,
            deltaTokens: data.delta_tokens ?? 150,
            maxTokenGrowth: data.max_token_growth ?? 500,
            forbiddenTerms: data.forbidden_terms ?? [],
          }),
        );
      }
      if (route === "/api/harness/genome" && request.method === "GET") {
        return send(200, await scheduler.getGenome());
      }
      if (route === "/api/harness/genome" && request.method === "POST") {
        const data = await body(request);
        if (data.incumbent_metrics || data.candidate_metrics) {
          return send(
            200,
            await scheduler.evolveGenome(
              data.candidate ?? data.surfaces ?? {},
              {
                hypothesis: data.hypothesis ?? "",
                round: data.round ?? 0,
                incumbentMetrics: data.incumbent_metrics ?? {},
                candidateMetrics: data.candidate_metrics ?? {},
                deltaPass: data.delta_pass ?? 0.05,
                deltaTokens: data.delta_tokens ?? 150,
                maxTokenGrowth: data.max_token_growth ?? 500,
                maxSurfaces: data.max_surfaces ?? 2,
                maxChangedLines: data.max_changed_lines ?? 40,
                annealSurfaces: data.anneal_surfaces ?? true,
                forbiddenTerms: data.forbidden_terms ?? [],
                ablationMetricsBySurface:
                  data.ablation_metrics_by_surface ?? null,
              },
            ),
          );
        }
        return send(
          200,
          await scheduler.updateGenome(
            data.candidate ?? data.surfaces ?? data,
            {
              hypothesis: data.hypothesis ?? "Manual operator genome update",
              round: data.round ?? 0,
              maxSurfaces: data.max_surfaces ?? null,
              maxChangedLines: data.max_changed_lines ?? null,
              annealSurfaces: data.anneal_surfaces ?? false,
              forbiddenTerms: data.forbidden_terms ?? [],
            },
          ),
        );
      }
      if (route === "/api/harness/ledger" && request.method === "GET") {
        return send(200, await scheduler.getHarnessLedger());
      }
      if (route === "/api/harness/calibrate" && request.method === "POST") {
        const data = await body(request);
        return send(
          200,
          await scheduler.calibrateHarness({
            tasks: data.tasks ?? null,
            rounds: data.rounds ?? 3,
          }),
        );
      }
      if (route === "/api/harness/compare" && request.method === "POST") {
        const data = await body(request);
        return send(
          200,
          await scheduler.compareHarnessArms(data.arm_a, data.arm_b, {
            bootstrapIterations: data.bootstrap_iterations ?? 2000,
            seed: data.seed ?? 42,
            deltaPassRate: data.delta_pass_rate ?? null,
          }),
        );
      }
      if (
        route === "/api/memory/promote-invariant" &&
        request.method === "POST"
      ) {
        const data = await body(request);
        return send(
          200,
          await scheduler.promoteMemoryInvariant(data.namespace, {
            maxEpisodic: data.max_episodic ?? null,
            ruleSummary: data.rule_summary ?? null,
          }),
        );
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

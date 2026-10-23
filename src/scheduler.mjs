import pg from "pg";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { validatePlan, validateCapabilities } from "./validation.mjs";
import { nextCronDate, validateTriggerSpec } from "./triggers.mjs";
import {
  DEFAULT_HARNESS_GENOME,
  resolveAndValidateGenome,
  changedGenomeSurfaces,
  changedGenomeLines,
  criticCheckCandidate,
  evaluateDualChannelGate,
  pickStagnationSurface,
  jeffreysSmooth,
  wilsonLowerBound,
  calibrateArmStats,
  comparePairedArms,
  extractMemoryNamespace,
  betaFeedbackMultiplier,
} from "./harness.mjs";
const json = (x) => JSON.stringify(x);
export class Scheduler {
  constructor(
    config,
    {
      schema = "agent_registry",
      lease = 90,
      deadline = 180,
      capabilities = [],
      capacity = 2,
      maxAttempts = 2,
      maxConsecutiveFailures = null,
    } = {},
  ) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
      throw Error("Invalid scheduler schema");
    validateCapabilities(capabilities);
    for (const value of [lease, deadline, capacity, maxAttempts]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw Error("Invalid scheduler limits");
    }
    if (
      maxConsecutiveFailures !== null &&
      (!Number.isSafeInteger(maxConsecutiveFailures) ||
        maxConsecutiveFailures < 1)
    )
      throw Error("Invalid scheduler limits");
    if (deadline < lease) throw Error("Deadline must be at least the lease");
    this.schema = schema;
    this.lease = lease;
    this.deadline = deadline;
    this.capabilities = capabilities;
    this.capacity = capacity;
    this.maxAttempts = maxAttempts;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.wakeup = new EventEmitter();
    this.wakeup.setMaxListeners(0);
    this.pool = new pg.Pool({
      ...config,
      connectionTimeoutMillis: 5000,
      keepAlive: true,
      options: `-c search_path=${schema} -c statement_timeout=15000 -c idle_in_transaction_session_timeout=20000`,
    });
    // EN: Connections can fail between queries. / 中文：查询间隙也可能发生连接错误。
    this.pool.on("connect", (client) =>
      client.on("error", () =>
        console.error("Scheduler active database connection lost"),
      ),
    );
    this.pool.on("error", () =>
      console.error("Scheduler database connection lost"),
    );
  }
  async init() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.tx(async (db) => {
      await db.query(
        await readFile(new URL("./scheduler.sql", import.meta.url), "utf8"),
      );
      for (const capability of this.capabilities) {
        await db.query(
          `INSERT INTO agent_capabilities(name,description,verifier,required_input_fields,required_output_fields,allowed_context_prefixes)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(name) DO UPDATE SET
             description=excluded.description,
             verifier=excluded.verifier,
             required_input_fields=excluded.required_input_fields,
             required_output_fields=excluded.required_output_fields,
             allowed_context_prefixes=excluded.allowed_context_prefixes`,
          [
            capability.name,
            capability.description,
            Boolean(capability.verifier),
            json([...(capability.required_input_fields ?? [])].sort()),
            json([...(capability.required_output_fields ?? [])].sort()),
            json([...(capability.allowed_context_prefixes ?? [])].sort()),
          ],
        );
      }
      await db.query(
        "INSERT INTO agent_quota VALUES ('execution',$1) ON CONFLICT(name) DO UPDATE SET capacity=excluded.capacity",
        [this.capacity],
      );
      await db.query(
        "INSERT INTO agent_harness_genome(genome_id,version,surfaces) VALUES('active',1,'{}') ON CONFLICT(genome_id) DO NOTHING",
      );
    });
  }
  async _getActiveGenomeTx(db) {
    const row = (
      await db.query(
        "SELECT version,surfaces,updated_at FROM agent_harness_genome WHERE genome_id='active'",
      )
    ).rows[0];
    const raw = row?.surfaces ?? {};
    const surfaces = resolveAndValidateGenome(raw);
    return {
      version: row?.version ?? 1,
      surfaces,
      raw_overrides: raw,
      changed_surfaces: changedGenomeSurfaces(surfaces, DEFAULT_HARNESS_GENOME),
      updated_at: row?.updated_at ?? null,
    };
  }
  // EN: Serialize transitions across schedulers; never hold the lock during model calls.
  // 中文：多个调度进程共享事务锁；模型调用期间不持有该锁。
  async tx(fn, readOnly = false) {
    const db = await this.pool.connect();
    let broken = false;
    try {
      await db.query(
        readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
      );
      if (!readOnly)
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          this.schema,
        ]);
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      try {
        await db.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw e;
    } finally {
      db.release(broken);
    }
  }
  async event(db, type, id = null, payload = {}) {
    await db.query(
      "INSERT INTO agent_events(task_id,event_type,payload) VALUES($1,$2,$3)",
      [id, type, json(payload)],
    );
  }
  _checkInputContracts(tasks, catalog) {
    for (const task of tasks) {
      const spec = catalog.get(task.capability);
      if (!spec) throw Error("Unknown capability");
      for (const field of spec.requiredInput) {
        if (
          !Object.hasOwn(task.input, field) ||
          task.input[field] === null ||
          task.input[field] === undefined
        )
          throw Error(`Missing required input field: ${field}`);
      }
      if (spec.allowedPrefixes.length > 0 && task.context_keys?.length > 0) {
        for (const key of task.context_keys) {
          if (!spec.allowedPrefixes.some((p) => key.startsWith(p)))
            throw Error(`Unauthorized context_key: ${key}`);
        }
      }
    }
  }
  // EN: Request ids bind the entire normalized DAG, not just the user-facing text.
  // 中文：请求编号绑定完整任务图，重试不得偷偷改变输入或依赖。
  async submit(requestId, plan) {
    const normalized = validatePlan(requestId, plan);
    const traceId = normalized.trace_id ?? requestId;
    const out = await this.tx(async (db) => {
      const old = (
        await db.query(
          "SELECT plan, plan=$2::jsonb AS same FROM agent_requests WHERE request_id=$1",
          [requestId, json(normalized)],
        )
      ).rows[0];
      if (old) {
        if (!old.same) throw Error("Idempotency conflict");
        return {
          ids: (
            await db.query(
              "SELECT task_id FROM agent_tasks WHERE request_id=$1 ORDER BY task_id",
              [requestId],
            )
          ).rows.map((x) => x.task_id),
        };
      }
      const catalog = new Map(
        (
          await db.query(
            "SELECT name,required_input_fields,allowed_context_prefixes FROM agent_capabilities",
          )
        ).rows.map((x) => [
          x.name,
          {
            requiredInput: x.required_input_fields ?? [],
            allowedPrefixes: x.allowed_context_prefixes ?? [],
          },
        ]),
      );
      this._checkInputContracts(normalized.tasks, catalog);
      await db.query(
        "INSERT INTO agent_requests(request_id,plan,max_tokens,max_cost_usd,trace_id) VALUES($1,$2,$3,$4,$5)",
        [
          requestId,
          json(normalized),
          normalized.budget?.max_tokens ?? null,
          normalized.budget?.max_cost_usd ?? null,
          traceId,
        ],
      );
      const ids = new Map(normalized.tasks.map((t) => [t.id, randomUUID()]));
      const rows = normalized.tasks.map((task) => ({
        task_id: ids.get(task.id),
        key: task.id,
        capability: task.capability,
        input: task.input,
        dependencies: task.dependencies.map((d) => ids.get(d)),
        priority: task.priority ?? 0,
        require_verified_facts: task.require_verified_facts ?? false,
        min_fact_confidence: task.min_fact_confidence ?? null,
        min_worker_pass_rate: task.min_worker_pass_rate ?? null,
        fact_key: task.fact_key ?? null,
        fact_ttl_seconds: task.fact_ttl_seconds ?? null,
        context_keys: task.context_keys ?? [],
        context_query: task.context_query ?? null,
      }));
      // One round trip for the graph and its audit events, under the existing lock.
      await db.query(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
             task_id text,key text,capability text,input jsonb,dependencies jsonb,priority int,require_verified_facts boolean,min_fact_confidence float8,min_worker_pass_rate float8,fact_key text,fact_ttl_seconds int,context_keys jsonb,context_query text)
         ), inserted AS (
           INSERT INTO agent_tasks(task_id,task_key,capability,input,dependencies,request_id,max_attempts,priority,require_verified_facts,min_fact_confidence,min_worker_pass_rate,fact_key,fact_ttl_seconds,context_keys,context_query,trace_id)
           SELECT task_id,key,capability,input,dependencies,$2,$3,priority,require_verified_facts,min_fact_confidence,min_worker_pass_rate,fact_key,fact_ttl_seconds,context_keys,context_query,$4 FROM incoming
           RETURNING task_id
         ) INSERT INTO agent_events(task_id,event_type,payload)
           SELECT i.task_id,'queued',jsonb_build_object('capability',r.capability,'key',r.key,'trace_id',$4::text)
           FROM inserted i JOIN incoming r USING(task_id)`,
        [json(rows), requestId, this.maxAttempts, traceId],
      );
      return { ids: [...ids.values()].sort() };
    });
    this.wakeup.emit("wake");
    return out;
  }
  /** Dynamically expand a request DAG under a parent task within the 100-task request budget and optional RRSI annealed single-step edit budget.
   * 在不突破请求总节点上限与按轮退火扩展预算且保持无环的前提下，基于父任务动态派生子任务图。
   */
  async expand(
    requestId,
    expansionId,
    parentTaskId,
    plan,
    {
      rewireDependents = false,
      maxTasksPerExpansion = null,
      annealStep = null,
    } = {},
  ) {
    if (typeof requestId !== "string" || !/^[\w-]{8,80}$/.test(requestId))
      throw Error("Invalid request id");
    if (
      typeof parentTaskId !== "string" ||
      !parentTaskId ||
      parentTaskId.length > 100
    )
      throw Error("Invalid parent task id");
    if (typeof rewireDependents !== "boolean")
      throw Error("rewireDependents must be boolean");
    const normalized = validatePlan(expansionId, plan);
    const out = await this.tx(async (db) => {
      const old = (
        await db.query(
          "SELECT parent_task_id,rewire_dependents,task_ids,plan=$3::jsonb AS same FROM agent_expansions WHERE request_id=$1 AND expansion_id=$2",
          [requestId, expansionId, json(normalized)],
        )
      ).rows[0];
      if (old) {
        if (
          !old.same ||
          old.parent_task_id !== parentTaskId ||
          old.rewire_dependents !== rewireDependents
        )
          throw Error("Idempotency conflict");
        return { ids: old.task_ids };
      }
      const reqRow = (
        await db.query(
          "SELECT max_tokens,max_cost_usd,used_tokens,used_cost_usd,trace_id FROM agent_requests WHERE request_id=$1",
          [requestId],
        )
      ).rows[0];
      if (
        reqRow &&
        ((reqRow.max_tokens !== null &&
          Number(reqRow.used_tokens) > Number(reqRow.max_tokens)) ||
          (reqRow.max_cost_usd !== null &&
            Number(reqRow.used_cost_usd) > Number(reqRow.max_cost_usd)))
      )
        throw Error("Request budget exceeded");
      const traceId = normalized.trace_id ?? reqRow?.trace_id ?? requestId;
      const parent = (
        await db.query(
          "SELECT task_id,status FROM agent_tasks WHERE task_id=$1 AND request_id=$2",
          [parentTaskId, requestId],
        )
      ).rows[0];
      if (!parent || ["failed", "cancelled"].includes(parent.status))
        throw Error("Parent task unavailable for expansion");
      const existingCount = Number(
        (
          await db.query(
            "SELECT count(*) AS count FROM agent_tasks WHERE request_id=$1",
            [requestId],
          )
        ).rows[0].count,
      );
      if (existingCount + normalized.tasks.length > 100)
        throw Error("Request task budget exceeded");
      const expansionRound = Number(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM agent_expansions WHERE request_id=$1",
            [requestId],
          )
        ).rows[0].count,
      );
      const activeGenome = await this._getActiveGenomeTx(db);
      const baseMaxPerExp =
        maxTasksPerExpansion ??
        activeGenome.surfaces.expansion_config.max_tasks_per_expansion;
      const stepAnneal =
        annealStep ?? activeGenome.surfaces.expansion_config.anneal_step;
      const annealedMaxTasks = Math.max(
        1,
        baseMaxPerExp - expansionRound * stepAnneal,
      );
      if (normalized.tasks.length > annealedMaxTasks)
        throw Error(
          `Expansion annealed edit budget exceeded (${normalized.tasks.length} > ${annealedMaxTasks} at round ${expansionRound})`,
        );
      const catalog = new Map(
        (
          await db.query(
            "SELECT name,required_input_fields,allowed_context_prefixes FROM agent_capabilities",
          )
        ).rows.map((x) => [
          x.name,
          {
            requiredInput: x.required_input_fields ?? [],
            allowedPrefixes: x.allowed_context_prefixes ?? [],
          },
        ]),
      );
      this._checkInputContracts(normalized.tasks, catalog);
      const ids = new Map(normalized.tasks.map((t) => [t.id, randomUUID()]));
      const dependedUpon = new Set(
        normalized.tasks.flatMap((t) => t.dependencies),
      );
      const leafIds = normalized.tasks
        .filter((t) => !dependedUpon.has(t.id))
        .map((t) => ids.get(t.id))
        .sort();
      if (rewireDependents) {
        const dependents = (
          await db.query(
            "SELECT task_id,status,attempts,dependencies FROM agent_tasks WHERE request_id=$1 AND dependencies @> jsonb_build_array($2::text)",
            [requestId, parentTaskId],
          )
        ).rows;
        if (dependents.some((d) => d.status !== "queued" || d.attempts > 0))
          throw Error("Cannot rewire dispatched dependents");
        for (const dep of dependents) {
          const nextDeps = [
            ...new Set([
              ...dep.dependencies.filter((d) => d !== parentTaskId),
              ...leafIds,
            ]),
          ].sort();
          await db.query(
            "UPDATE agent_tasks SET dependencies=$2,updated_at=now() WHERE task_id=$1",
            [dep.task_id, json(nextDeps)],
          );
        }
      }
      const rows = normalized.tasks.map((task) => ({
        task_id: ids.get(task.id),
        key: task.id,
        capability: task.capability,
        input: task.input,
        dependencies: task.dependencies.length
          ? task.dependencies.map((d) => ids.get(d))
          : [parentTaskId],
        priority: task.priority ?? 0,
        require_verified_facts: task.require_verified_facts ?? false,
        min_fact_confidence: task.min_fact_confidence ?? null,
        min_worker_pass_rate: task.min_worker_pass_rate ?? null,
        fact_key: task.fact_key ?? null,
        fact_ttl_seconds: task.fact_ttl_seconds ?? null,
        context_keys: task.context_keys ?? [],
        context_query: task.context_query ?? null,
      }));
      await db.query(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
             task_id text,key text,capability text,input jsonb,dependencies jsonb,priority int,require_verified_facts boolean,min_fact_confidence float8,min_worker_pass_rate float8,fact_key text,fact_ttl_seconds int,context_keys jsonb,context_query text)
         ), inserted AS (
           INSERT INTO agent_tasks(task_id,task_key,capability,input,dependencies,request_id,max_attempts,priority,require_verified_facts,min_fact_confidence,min_worker_pass_rate,fact_key,fact_ttl_seconds,context_keys,context_query,trace_id)
           SELECT task_id,key,capability,input,dependencies,$2,$3,priority,require_verified_facts,min_fact_confidence,min_worker_pass_rate,fact_key,fact_ttl_seconds,context_keys,context_query,$5 FROM incoming
           RETURNING task_id
         ) INSERT INTO agent_events(task_id,event_type,payload)
           SELECT i.task_id,'queued',jsonb_build_object('capability',r.capability,'key',r.key,'expansion_id',$4::text,'trace_id',$5::text)
           FROM inserted i JOIN incoming r USING(task_id)`,
        [json(rows), requestId, this.maxAttempts, expansionId, traceId],
      );
      const sortedIds = [...ids.values()].sort();
      await db.query(
        "INSERT INTO agent_expansions(request_id,expansion_id,parent_task_id,plan,rewire_dependents,task_ids) VALUES($1,$2,$3,$4,$5,$6)",
        [
          requestId,
          expansionId,
          parentTaskId,
          json(normalized),
          rewireDependents,
          json(sortedIds),
        ],
      );
      await this.event(db, "expanded", parentTaskId, {
        expansion_id: expansionId,
        ids: sortedIds,
        rewire_dependents: rewireDependents,
        trace_id: traceId,
      });
      return { ids: sortedIds };
    });
    this.wakeup.emit("wake");
    return out;
  }
  async register(id, capability) {
    if (!/^[\w-]{4,100}$/.test(id)) throw Error("Invalid worker");
    return this.tx(async (db) => {
      if (
        !(
          await db.query("SELECT name FROM agent_capabilities WHERE name=$1", [
            capability,
          ])
        ).rowCount
      )
        throw Error("Unknown capability");
      const old = (
        await db.query("SELECT * FROM agent_workers WHERE agent_id=$1", [id])
      ).rows[0];
      if (old && old.capability !== capability)
        throw Error("Worker capability conflict");
      await db.query(
        "INSERT INTO agent_workers(agent_id,capability,lease_until) VALUES($1,$2,now()+$3*interval '1 second') ON CONFLICT(agent_id) DO UPDATE SET lease_until=excluded.lease_until,updated_at=now()",
        [id, capability, this.lease],
      );
      if (!old)
        await this.event(db, "registered", null, { agent_id: id, capability });
      return { ok: true };
    });
  }
  async reap(db) {
    const expired = (
      await db.query(
        "SELECT a.* FROM agent_attempts a JOIN agent_workers w USING(agent_id) WHERE a.status='running' AND (a.lease_until<=now() OR a.deadline<=now() OR w.lease_until<=now())",
      )
    ).rows;
    for (const a of expired) await this.finishAttempt(db, a, "lease_expired");
    // EN: Retain active attempts before pruning stale instance registrations.
    // 中文：先回收尝试，再清理过期实例，避免遗失在途任务的所有权。
    await db.query(
      "DELETE FROM agent_workers w WHERE w.lease_until<now()-interval '1 hour' AND NOT EXISTS (SELECT 1 FROM agent_attempts a WHERE a.agent_id=w.agent_id AND a.status='running')",
    );
    await db.query(
      `WITH RECURSIVE blocked(task_id) AS (
           SELECT t.task_id FROM agent_tasks t WHERE t.status='queued' AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(t.dependencies) dep
             LEFT JOIN agent_tasks d ON d.task_id=dep
             WHERE d.task_id IS NULL OR d.status IN ('failed','cancelled')
           )
           UNION
           SELECT t.task_id FROM agent_tasks t JOIN blocked b
             ON t.dependencies @> jsonb_build_array(b.task_id)
           WHERE t.status='queued'
         ), changed AS (
           UPDATE agent_tasks SET status='failed',last_error='dependency_failed',updated_at=now()
           WHERE task_id IN (SELECT task_id FROM blocked) AND status='queued'
           RETURNING task_id
         ) INSERT INTO agent_events(task_id,event_type)
           SELECT task_id,'dependency_failed' FROM changed`,
    );
  }
  async finishAttempt(db, a, error, result = null, usage = null) {
    await db.query(
      "UPDATE agent_attempts SET status=$2,error=$3,result=$4,usage=$5,finished_at=now() WHERE call_id=$1",
      [
        a.call_id,
        error ? "failed" : "completed",
        error,
        result === null ? null : json(result),
        usage === null ? null : json(usage),
      ],
    );
    const t = (
      await db.query("SELECT * FROM agent_tasks WHERE task_id=$1", [a.task_id])
    ).rows[0];
    if (t.status === "running" && t.call_id === a.call_id) {
      const status = error
        ? t.attempts < t.max_attempts
          ? "queued"
          : "failed"
        : "completed";
      await db.query(
        "UPDATE agent_tasks SET status=$2,result=$3,last_error=$4,lease_until=NULL,updated_at=now() WHERE task_id=$1",
        [t.task_id, status, result === null ? null : json(result), error],
      );
      if (!error) {
        await db.query(
          "INSERT INTO shared_facts(task_id,agent_id,version,value,fact_key,expires_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6::int IS NOT NULL THEN now()+$6::int*interval '1 second' ELSE NULL END)",
          [
            t.task_id,
            a.agent_id,
            t.attempts,
            json(result),
            t.fact_key ?? null,
            t.fact_ttl_seconds ?? null,
          ],
        );
        await this._attributeRecalledMemoryTx(db, t, result, usage);
      }
      await this.event(db, error ? "attempt_failed" : "completed", t.task_id, {
        call_id: a.call_id,
        agent_id: a.agent_id,
        attempt_id: a.attempt_id,
        next: status,
        error,
        ...(usage ? { usage } : {}),
      });
    }
    if (usage && t?.request_id) {
      const reqRow = (
        await db.query(
          `UPDATE agent_requests
           SET used_tokens=used_tokens+$2,used_cost_usd=used_cost_usd+$3
           WHERE request_id=$1
           RETURNING max_tokens,max_cost_usd,used_tokens,used_cost_usd`,
          [t.request_id, usage.total_tokens, usage.cost_usd],
        )
      ).rows[0];
      if (
        reqRow &&
        ((reqRow.max_tokens !== null &&
          Number(reqRow.used_tokens) > Number(reqRow.max_tokens)) ||
          (reqRow.max_cost_usd !== null &&
            Number(reqRow.used_cost_usd) > Number(reqRow.max_cost_usd)))
      ) {
        await db.query(
          `WITH halted AS (
             UPDATE agent_tasks SET status='failed',last_error='budget_exceeded',updated_at=now()
             WHERE request_id=$1 AND status='queued'
             RETURNING task_id
           ) INSERT INTO agent_events(task_id,event_type,payload)
             SELECT task_id,'budget_exceeded',$2::jsonb FROM halted`,
          [
            t.request_id,
            json({
              request_id: t.request_id,
              used_tokens: Number(reqRow.used_tokens),
              max_tokens:
                reqRow.max_tokens !== null ? Number(reqRow.max_tokens) : null,
              used_cost_usd: Number(reqRow.used_cost_usd),
              max_cost_usd: reqRow.max_cost_usd,
            }),
          ],
        );
      }
    }
    const workerFailure = Boolean(error && error !== "cancelled");
    const w = (
      await db.query(
        `UPDATE agent_workers SET
           in_flight=GREATEST(0,in_flight-1),
           consecutive_failures=CASE WHEN $2 THEN consecutive_failures+1 WHEN $3 THEN 0 ELSE consecutive_failures END,
           enabled=CASE WHEN $2 AND $4::int IS NOT NULL AND consecutive_failures+1>=$4::int THEN false ELSE enabled END
         WHERE agent_id=$1 RETURNING enabled,consecutive_failures,capability`,
        [a.agent_id, workerFailure, !error, this.maxConsecutiveFailures],
      )
    ).rows[0];
    if (
      workerFailure &&
      this.maxConsecutiveFailures !== null &&
      w &&
      w.consecutive_failures === this.maxConsecutiveFailures
    ) {
      await this.event(db, "worker_isolated", a.task_id, {
        agent_id: a.agent_id,
        capability: w.capability,
        consecutive_failures: w.consecutive_failures,
        reason: error,
      });
    }
  }
  async heartbeat(id, capability, callId = null) {
    return this.tx(async (db) => {
      await this.reap(db);
      const w = (
        await db.query(
          "UPDATE agent_workers SET lease_until=now()+$3*interval '1 second',updated_at=now() WHERE agent_id=$1 AND capability=$2 RETURNING *",
          [id, capability, this.lease],
        )
      ).rows[0];
      if (!w) throw Error("Worker not registered");
      let valid = false;
      if (callId) {
        const a = (
          await db.query(
            "SELECT a.* FROM agent_attempts a JOIN agent_tasks t USING(task_id) WHERE a.call_id=$1 AND a.agent_id=$2 AND a.status='running' AND t.status='running' AND t.call_id=a.call_id",
            [callId, id],
          )
        ).rows[0];
        if (a) {
          await db.query(
            `WITH renewed AS (
               UPDATE agent_attempts SET lease_until=LEAST(deadline,now()+$2*interval '1 second')
               WHERE call_id=$1 RETURNING task_id,call_id,lease_until
             ) UPDATE agent_tasks t SET lease_until=r.lease_until
               FROM renewed r WHERE t.task_id=r.task_id AND t.call_id=r.call_id`,
            [callId, this.lease],
          );
          valid = true;
        }
      }
      return { ok: true, valid, enabled: w.enabled };
    });
  }
  async claim(id, capability, { waitMs = 0 } = {}) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000)
      throw Error("Invalid wait_ms");
    const first = await this._claimOnce(id, capability);
    if (first.task || waitMs === 0) return first;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      await new Promise((resolve) => {
        const onWake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(
          () => {
            this.wakeup.off("wake", onWake);
            resolve();
          },
          Math.min(remaining, 250),
        );
        this.wakeup.once("wake", onWake);
      });
      const next = await this._claimOnce(id, capability);
      if (next.task) return next;
    }
    return { task: null };
  }
  async _claimOnce(id, capability) {
    return this.tx(async (db) => {
      await this.reap(db);
      const w = (
        await db.query(
          "UPDATE agent_workers SET lease_until=now()+$3*interval '1 second',updated_at=now() WHERE agent_id=$1 AND capability=$2 RETURNING *",
          [id, capability, this.lease],
        )
      ).rows[0];
      if (!w) throw Error("Worker not registered");
      if (!w.enabled) return { task: null };
      const quota = (
        await db.query(
          `SELECT capacity,
             (SELECT count(*) FROM agent_attempts WHERE status='running') AS used,
             EXISTS(SELECT 1 FROM agent_attempts WHERE status='running' AND agent_id=$1) AS busy
           FROM agent_quota WHERE name='execution'`,
          [id],
        )
      ).rows[0];
      if (Number(quota.used) >= quota.capacity || quota.busy)
        return { task: null };
      const t = (
        await db.query(
          `SELECT t.* FROM agent_tasks t
           WHERE status='queued' AND capability=$1
             AND (
               t.min_worker_pass_rate IS NULL
               OR COALESCE(
                 (
                   SELECT count(*) FILTER (WHERE f.verified)::float8 / NULLIF(count(*), 0)
                   FROM shared_facts f
                   WHERE f.agent_id=$2 AND f.reviewed_at IS NOT NULL
                 ),
                 CASE WHEN $3::int = 0 THEN 1.0 ELSE 0.0 END
               ) >= t.min_worker_pass_rate
             )
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(t.dependencies) dep
               LEFT JOIN agent_tasks d ON d.task_id=dep
               WHERE d.status IS DISTINCT FROM 'completed'
                 OR ((t.require_verified_facts OR t.min_fact_confidence IS NOT NULL) AND NOT EXISTS (
                   SELECT 1 FROM shared_facts f
                   WHERE f.task_id=d.task_id AND f.version=d.attempts AND f.verified
                     AND (t.min_fact_confidence IS NULL OR COALESCE(f.confidence,1)>=t.min_fact_confidence)
                 ))
             ) ORDER BY priority DESC,updated_at,task_id LIMIT 1 FOR UPDATE`,
          [capability, id, w.consecutive_failures ?? 0],
        )
      ).rows[0];
      if (!t) return { task: null };
      const call = randomUUID();
      const a = (
        await db.query(
          "INSERT INTO agent_attempts(task_id,agent_id,call_id,status,lease_until,deadline) VALUES($1,$2,$3,'running',now()+$4*interval '1 second',now()+$5*interval '1 second') RETURNING *",
          [t.task_id, id, call, this.lease, this.deadline],
        )
      ).rows[0];
      await db.query(
        "UPDATE agent_tasks SET status='running',agent_id=$2,call_id=$3,attempts=attempts+1,lease_until=$4,updated_at=now() WHERE task_id=$1",
        [t.task_id, id, call, a.lease_until],
      );
      await db.query("UPDATE agent_workers SET in_flight=1 WHERE agent_id=$1", [
        id,
      ]);
      const facts = (
        await db.query(
          "SELECT f.task_id,f.agent_id,f.version,f.value,f.verified,f.confidence,f.expires_at,f.review_note,f.reviewed_at FROM shared_facts f JOIN agent_tasks d ON d.task_id=f.task_id AND d.attempts=f.version WHERE f.task_id=ANY($1::text[]) ORDER BY f.task_id",
          [t.dependencies],
        )
      ).rows;
      const prior_facts =
        t.attempts > 0
          ? (
              await db.query(
                "SELECT task_id,agent_id,version,value,verified,confidence,expires_at,review_note,reviewed_at FROM shared_facts WHERE task_id=$1 ORDER BY version ASC",
                [t.task_id],
              )
            ).rows
          : [];
      const activeGenome = await this._getActiveGenomeTx(db);
      const memCfg = activeGenome.surfaces.memory_config;
      const rawContextFacts =
        t.context_keys?.length > 0
          ? (
              await db.query(
                `SELECT DISTINCT ON (f.fact_key)
                   f.fact_id,f.fact_key,f.task_id,f.agent_id,f.version,f.value,f.verified,f.confidence,f.expires_at,f.review_note,f.reviewed_at,f.memory_tier,f.injected_count,f.accepted_count,f.demoted
                 FROM shared_facts f
                 JOIN agent_tasks d ON d.task_id=f.task_id AND d.attempts=f.version
                 WHERE f.fact_key=ANY($1::text[]) AND f.verified=true AND NOT COALESCE(f.demoted,false)
                   AND (f.expires_at IS NULL OR f.expires_at>now())
                   AND ($2::double precision IS NULL OR COALESCE(f.confidence,1)>=$2::double precision)
                 ORDER BY f.fact_key,f.fact_id DESC`,
                [t.context_keys, t.min_fact_confidence ?? null],
              )
            ).rows
          : [];
      if (t.context_query) {
        const capRow = (
          await db.query(
            "SELECT allowed_context_prefixes FROM agent_capabilities WHERE name=$1",
            [capability],
          )
        ).rows[0];
        const queried = await this._searchMemoryTx(db, t.context_query, {
          prefixes: capRow?.allowed_context_prefixes ?? [],
          minConfidence: t.min_fact_confidence ?? null,
          limit: memCfg.max_entries,
        });
        const existingKeys = new Set(rawContextFacts.map((f) => f.fact_key));
        for (const qf of queried) {
          if (!existingKeys.has(qf.fact_key)) {
            existingKeys.add(qf.fact_key);
            rawContextFacts.push(qf);
          }
        }
      }
      // Enforce Harness² P3 recall budget (max_entries & max_chars) with invariant priority
      const sortedContext = [...rawContextFacts].sort((a, b) => {
        const aInv = a.memory_tier === "invariant" ? 1 : 0;
        const bInv = b.memory_tier === "invariant" ? 1 : 0;
        if (bInv !== aInv) return bInv - aInv;
        const aMult = betaFeedbackMultiplier(
          a.accepted_count,
          a.injected_count,
        ).multiplier;
        const bMult = betaFeedbackMultiplier(
          b.accepted_count,
          b.injected_count,
        ).multiplier;
        return (
          bMult * (b.confidence ?? 1) - aMult * (a.confidence ?? 1) ||
          Number(b.fact_id) - Number(a.fact_id)
        );
      });
      const context_facts = [];
      let usedChars = 0;
      for (const cf of sortedContext) {
        if (context_facts.length >= memCfg.max_entries) break;
        const entryChars =
          JSON.stringify(cf.value ?? {}).length + (cf.fact_key?.length ?? 0);
        if (
          context_facts.length > 0 &&
          usedChars + entryChars > memCfg.max_chars
        ) {
          continue;
        }
        usedChars += entryChars;
        context_facts.push(cf);
      }
      const recalledFactIds = context_facts
        .map((cf) => Number(cf.fact_id))
        .filter((fid) => Number.isSafeInteger(fid) && fid > 0);
      if (recalledFactIds.length > 0) {
        await db.query(
          "UPDATE shared_facts SET injected_count=injected_count+1 WHERE fact_id=ANY($1::bigint[])",
          [recalledFactIds],
        );
        await db.query(
          "UPDATE agent_tasks SET recalled_fact_ids=$2 WHERE task_id=$1",
          [t.task_id, json(recalledFactIds)],
        );
      }
      await this.event(db, "dispatched", t.task_id, {
        call_id: call,
        agent_id: id,
        attempt_id: a.attempt_id,
        ...(t.trace_id ? { trace_id: t.trace_id } : {}),
      });
      return {
        task: {
          ...t,
          status: "running",
          agent_id: id,
          call_id: call,
          attempt_id: a.attempt_id,
          attempt: t.attempts + 1,
          attempts: t.attempts + 1,
          lease_until: a.lease_until,
          facts,
          prior_facts,
          context_facts,
          deadline: a.deadline,
        },
      };
    });
  }
  _normalizeUsage(usage) {
    if (usage === null || usage === undefined) return null;
    if (typeof usage !== "object" || Array.isArray(usage))
      throw Error("Invalid usage");
    const inTok = usage.input_tokens ?? 0;
    const outTok = usage.output_tokens ?? 0;
    const totTok = usage.total_tokens ?? inTok + outTok;
    const cost = usage.cost_usd ?? 0;
    if (
      !Number.isSafeInteger(inTok) ||
      inTok < 0 ||
      !Number.isSafeInteger(outTok) ||
      outTok < 0 ||
      !Number.isSafeInteger(totTok) ||
      totTok < 0 ||
      typeof cost !== "number" ||
      !Number.isFinite(cost) ||
      cost < 0
    )
      throw Error("Invalid usage metrics");
    return {
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: totTok,
      cost_usd: cost,
    };
  }
  async result(id, capability, callId, result, error, usage = null) {
    const normalizedUsage = this._normalizeUsage(usage);
    const out = await this.tx(async (db) => {
      await this.reap(db);
      const a = (
        await db.query(
          "SELECT a.*,c.required_output_fields FROM agent_attempts a JOIN agent_workers w USING(agent_id) JOIN agent_capabilities c ON c.name=w.capability WHERE call_id=$1 AND a.agent_id=$2 AND w.capability=$3",
          [callId, id, capability],
        )
      ).rows[0];
      if (!a) return { accepted: false };
      if (a.status !== "running") return { accepted: false, duplicate: true };
      const t = (
        await db.query(
          "SELECT status,call_id FROM agent_tasks WHERE task_id=$1",
          [a.task_id],
        )
      ).rows[0];
      if (t.status !== "running" || t.call_id !== callId) {
        await this.finishAttempt(db, a, "cancelled", null, normalizedUsage);
        await this.event(db, "late_result_rejected", a.task_id, {
          call_id: callId,
        });
        return { accepted: false };
      }
      let attemptError = error ? "worker_execution_failed" : null;
      let attemptResult = result;
      if (
        !attemptError &&
        Array.isArray(a.required_output_fields) &&
        a.required_output_fields.length > 0
      ) {
        const invalidOutput =
          !result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          a.required_output_fields.some(
            (field) =>
              !Object.hasOwn(result, field) ||
              result[field] === null ||
              result[field] === undefined,
          );
        if (invalidOutput) {
          attemptError = "output_contract_violation";
          attemptResult = null;
        }
      }
      await this.finishAttempt(
        db,
        a,
        attemptError,
        attemptResult,
        normalizedUsage,
      );
      return {
        accepted: true,
        ...(attemptError === "output_contract_violation"
          ? { contract_violation: true }
          : {}),
      };
    });
    if (out.accepted) this.wakeup.emit("wake");
    return out;
  }
  async cancel(id) {
    if (typeof id !== "string" || !id || id.length > 100)
      throw Error("Invalid task id");
    return this.tx(async (db) => {
      const r = await db.query(
        "UPDATE agent_tasks SET status='cancelled',updated_at=now() WHERE task_id=$1 AND status IN ('queued','running')",
        [id],
      );
      if (r.rowCount) await this.event(db, "cancelled", id);
      // EN: Hold quota until acknowledgment or expiry. / 中文：确认停止或租约过期后才释放额度。
      await this.reap(db);
      return { ok: true };
    });
  }
  _validateReviewArgs(
    taskId,
    version,
    verified,
    note,
    { rework = false, confidence = null, ttlSeconds = null } = {},
  ) {
    if (
      typeof taskId !== "string" ||
      !taskId ||
      taskId.length > 100 ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      typeof verified !== "boolean" ||
      typeof note !== "string" ||
      !note.trim() ||
      note.length > 4000 ||
      typeof rework !== "boolean" ||
      (rework && verified) ||
      (confidence !== null &&
        confidence !== undefined &&
        (typeof confidence !== "number" ||
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > 1)) ||
      (ttlSeconds !== null &&
        ttlSeconds !== undefined &&
        (!Number.isSafeInteger(ttlSeconds) ||
          ttlSeconds < 1 ||
          ttlSeconds > 31_536_000))
    )
      throw Error("Invalid fact review");
  }
  async _applyFactReview(
    db,
    taskId,
    version,
    verified,
    note,
    {
      rework = false,
      confidence = null,
      ttlSeconds = null,
      source = "operator",
      verifierAgentId = null,
    } = {},
  ) {
    if (rework) {
      const dispatchedDependent = (
        await db.query(
          "SELECT 1 FROM agent_tasks WHERE dependencies @> jsonb_build_array($1::text) AND (status<>'queued' OR attempts>0) LIMIT 1",
          [taskId],
        )
      ).rows[0];
      if (dispatchedDependent)
        return { accepted: false, reason: "downstream_dispatched" };
    }
    if (verifierAgentId) {
      const target = (
        await db.query(
          "SELECT agent_id FROM shared_facts WHERE task_id=$1 AND version=$2",
          [taskId, version],
        )
      ).rows[0];
      if (target && target.agent_id === verifierAgentId)
        throw Error("Self-review is forbidden");
    }
    const row = (
      await db.query(
        `UPDATE shared_facts f SET
           verified=$3,
           review_note=$4,
           reviewed_at=now(),
           confidence=COALESCE($5::double precision,f.confidence),
           expires_at=CASE WHEN $6::int IS NOT NULL THEN now()+$6::int*interval '1 second' ELSE f.expires_at END
         FROM agent_tasks t WHERE f.task_id=$1 AND f.version=$2
           AND t.task_id=f.task_id AND t.status='completed' AND t.attempts=f.version
         RETURNING f.*,t.attempts,t.max_attempts`,
        [
          taskId,
          version,
          verified,
          note.trim(),
          confidence ?? null,
          ttlSeconds ?? null,
        ],
      )
    ).rows[0];
    if (!row) return { accepted: false };
    const { attempts, max_attempts, ...fact } = row;
    await this.event(db, "fact_reviewed", taskId, {
      version,
      verified,
      note: note.trim(),
      source,
      ...(verifierAgentId ? { verifier_agent_id: verifierAgentId } : {}),
      ...(confidence !== null && confidence !== undefined
        ? { confidence }
        : {}),
      ...(rework ? { rework: true } : {}),
    });
    if (!verified) {
      const taskRow = (
        await db.query(
          "SELECT recalled_fact_ids FROM agent_tasks WHERE task_id=$1",
          [taskId],
        )
      ).rows[0];
      const recalledIds = Array.isArray(taskRow?.recalled_fact_ids)
        ? taskRow.recalled_fact_ids
            .map(Number)
            .filter((n) => Number.isSafeInteger(n) && n > 0)
        : [];
      if (recalledIds.length > 0) {
        await db.query(
          "UPDATE shared_facts SET accepted_count=GREATEST(0,accepted_count-1) WHERE fact_id=ANY($1::bigint[])",
          [recalledIds],
        );
      }
      const w = (
        await db.query(
          `UPDATE agent_workers SET
             consecutive_failures=consecutive_failures+1,
             enabled=CASE WHEN $2::int IS NOT NULL AND consecutive_failures+1>=$2::int THEN false ELSE enabled END
           WHERE agent_id=$1 RETURNING enabled,consecutive_failures,capability`,
          [fact.agent_id, this.maxConsecutiveFailures],
        )
      ).rows[0];
      if (
        this.maxConsecutiveFailures !== null &&
        w &&
        w.consecutive_failures === this.maxConsecutiveFailures
      ) {
        await this.event(db, "worker_isolated", taskId, {
          agent_id: fact.agent_id,
          capability: w.capability,
          consecutive_failures: w.consecutive_failures,
          reason: "verification_rejected",
        });
      }
    } else if (fact.fact_key && !fact.fact_key.endsWith(".__invariant__")) {
      const ns = extractMemoryNamespace(fact.fact_key);
      if (ns) {
        await this._promoteNamespaceInvariantIfDueTx(db, ns);
      }
    }
    if (rework) {
      const next = attempts < max_attempts ? "queued" : "failed";
      await db.query(
        "UPDATE agent_tasks SET status=$2,result=NULL,last_error='verification_rejected',call_id=NULL,lease_until=NULL,updated_at=now() WHERE task_id=$1",
        [taskId, next],
      );
      await this.event(db, "rework_triggered", taskId, {
        version,
        next,
      });
      if (next === "failed") await this.reap(db);
      return { accepted: true, fact, next };
    }
    return { accepted: true, fact };
  }
  /** Record trusted operator feedback for an exact output version, optionally triggering rework.
   * 核验影响后续领取，可选在未派发下游前将驳回任务退回重做；意见与状态变更在同一事务审计。
   */
  async reviewFact(taskId, version, verified, note, options = {}) {
    this._validateReviewArgs(taskId, version, verified, note, options);
    const out = await this.tx((db) =>
      this._applyFactReview(db, taskId, version, verified, note, {
        ...options,
        source: "operator",
      }),
    );
    if (out.accepted) this.wakeup.emit("wake");
    return out;
  }
  /** Record feedback from an independent registered Verifier Agent (self-review forbidden).
   * 由具备 verifier 权限的独立裁判 Worker 核验上游事实，严禁自审。
   */
  async reviewFactByVerifier(
    agentId,
    capability,
    taskId,
    version,
    verified,
    note,
    options = {},
  ) {
    if (typeof agentId !== "string" || !/^[\w-]{4,100}$/.test(agentId))
      throw Error("Invalid worker");
    this._validateReviewArgs(taskId, version, verified, note, options);
    const out = await this.tx(async (db) => {
      await this.reap(db);
      const w = (
        await db.query(
          `UPDATE agent_workers w
           SET lease_until=now()+$3*interval '1 second',updated_at=now()
           FROM agent_capabilities c
           WHERE w.agent_id=$1 AND w.capability=$2 AND c.name=w.capability AND c.verifier=true
           RETURNING w.enabled`,
          [agentId, capability, this.lease],
        )
      ).rows[0];
      if (!w) throw Error("Verifier not authorized");
      if (!w.enabled) throw Error("Verifier worker disabled");
      return this._applyFactReview(db, taskId, version, verified, note, {
        ...options,
        source: "verifier",
        verifierAgentId: agentId,
      });
    });
    if (out.accepted) this.wakeup.emit("wake");
    return out;
  }
  async enable(id, enabled) {
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 100 ||
      typeof enabled !== "boolean"
    )
      throw Error("Invalid worker state");
    const out = await this.tx(async (db) => {
      await db.query(
        "UPDATE agent_workers SET enabled=$2,consecutive_failures=CASE WHEN $2 THEN 0 ELSE consecutive_failures END WHERE agent_id=$1",
        [id, enabled],
      );
      return { ok: true };
    });
    if (enabled) this.wakeup.emit("wake");
    return out;
  }
  /** Aggregate operational compound metrics and verified organizational memory.
   * 汇总能力与节点的执行表现、核验通过率及最新已核验的组织认知账本。
   */
  async telemetry() {
    return this.tx(async (db) => {
      const capabilities = (
        await db.query(
          `SELECT c.name,c.description,c.verifier,c.required_input_fields,c.required_output_fields,c.allowed_context_prefixes,
             count(t.task_id) FILTER (WHERE t.status='queued')::int AS queued_tasks,
             count(t.task_id) FILTER (WHERE t.status='running')::int AS running_tasks,
             count(t.task_id) FILTER (WHERE t.status='completed')::int AS completed_tasks,
             count(t.task_id) FILTER (WHERE t.status='failed')::int AS failed_tasks,
             (SELECT count(*)::int FROM shared_facts f JOIN agent_tasks ft USING(task_id)
              WHERE ft.capability=c.name AND f.reviewed_at IS NOT NULL AND f.verified) AS verified_facts,
             (SELECT count(*)::int FROM shared_facts f JOIN agent_tasks ft USING(task_id)
              WHERE ft.capability=c.name AND f.reviewed_at IS NOT NULL AND NOT f.verified) AS rejected_facts,
             COALESCE((SELECT sum((a.usage->>'total_tokens')::bigint)::int FROM agent_attempts a JOIN agent_tasks at USING(task_id)
              WHERE at.capability=c.name AND a.usage IS NOT NULL),0) AS total_tokens,
             COALESCE((SELECT round(sum((a.usage->>'cost_usd')::numeric),6)::float8 FROM agent_attempts a JOIN agent_tasks at USING(task_id)
              WHERE at.capability=c.name AND a.usage IS NOT NULL),0) AS total_cost_usd
           FROM agent_capabilities c
           LEFT JOIN agent_tasks t ON t.capability=c.name
           GROUP BY c.name,c.description,c.verifier,c.required_input_fields,c.required_output_fields,c.allowed_context_prefixes
           ORDER BY c.name`,
        )
      ).rows.map((c) => {
        const reviewed = c.verified_facts + c.rejected_facts;
        return {
          ...c,
          pass_rate: reviewed
            ? Number((c.verified_facts / reviewed).toFixed(4))
            : null,
          jeffreys_pass_rate: reviewed
            ? jeffreysSmooth(c.verified_facts, reviewed)
            : null,
          wilson_lower_bound: reviewed
            ? wilsonLowerBound(c.verified_facts, reviewed)
            : null,
          cost_per_verified_usd:
            c.verified_facts > 0
              ? Number((c.total_cost_usd / c.verified_facts).toFixed(6))
              : null,
          tokens_per_verified:
            c.verified_facts > 0
              ? Math.round(c.total_tokens / c.verified_facts)
              : null,
        };
      });
      const workers = (
        await db.query(
          `SELECT w.agent_id,w.capability,w.enabled,w.in_flight,w.consecutive_failures,
             count(a.attempt_id) FILTER (WHERE a.status='completed')::int AS completed_attempts,
             count(a.attempt_id) FILTER (WHERE a.status='failed')::int AS failed_attempts,
             round(avg(extract(epoch FROM (a.finished_at - a.started_at)) * 1000)
               FILTER (WHERE a.finished_at IS NOT NULL))::int AS avg_duration_ms,
             COALESCE(sum((a.usage->>'total_tokens')::bigint) FILTER (WHERE a.usage IS NOT NULL)::int,0) AS total_tokens,
             COALESCE(round(sum((a.usage->>'cost_usd')::numeric) FILTER (WHERE a.usage IS NOT NULL),6)::float8,0) AS total_cost_usd,
             (SELECT count(*)::int FROM shared_facts f
              WHERE f.agent_id=w.agent_id AND f.reviewed_at IS NOT NULL AND f.verified) AS verified_facts,
             (SELECT count(*)::int FROM shared_facts f
              WHERE f.agent_id=w.agent_id AND f.reviewed_at IS NOT NULL AND NOT f.verified) AS rejected_facts
           FROM agent_workers w
           LEFT JOIN agent_attempts a USING(agent_id)
           GROUP BY w.agent_id,w.capability,w.enabled,w.in_flight,w.consecutive_failures
           ORDER BY w.agent_id`,
        )
      ).rows.map((w) => {
        const reviewed = w.verified_facts + w.rejected_facts;
        return {
          ...w,
          pass_rate: reviewed
            ? Number((w.verified_facts / reviewed).toFixed(4))
            : null,
          jeffreys_pass_rate: reviewed
            ? jeffreysSmooth(w.verified_facts, reviewed)
            : null,
          wilson_lower_bound: reviewed
            ? wilsonLowerBound(w.verified_facts, reviewed)
            : null,
          cost_per_verified_usd:
            w.verified_facts > 0
              ? Number((w.total_cost_usd / w.verified_facts).toFixed(6))
              : null,
          tokens_per_verified:
            w.verified_facts > 0
              ? Math.round(w.total_tokens / w.verified_facts)
              : null,
        };
      });
      const memory = (
        await db.query(
          `SELECT DISTINCT ON (f.fact_key)
             f.fact_id,f.fact_key,f.task_id,f.agent_id,f.version,f.value,f.verified,f.confidence,f.expires_at,f.review_note,f.reviewed_at,f.created_at,f.memory_tier,f.injected_count,f.accepted_count,f.demoted
           FROM shared_facts f
           JOIN agent_tasks t ON t.task_id=f.task_id AND t.attempts=f.version
           WHERE f.fact_key IS NOT NULL AND f.verified=true AND NOT COALESCE(f.demoted,false)
             AND (f.expires_at IS NULL OR f.expires_at>now())
           ORDER BY f.fact_key,f.fact_id DESC`,
        )
      ).rows.map((m) => ({
        ...m,
        feedback_multiplier: betaFeedbackMultiplier(
          m.accepted_count,
          m.injected_count,
        ).multiplier,
      }));
      const triggers = (
        await db.query("SELECT * FROM agent_triggers ORDER BY trigger_id")
      ).rows;
      const playbooks = (
        await db.query("SELECT * FROM agent_playbooks ORDER BY playbook_id")
      ).rows;
      const genome = await this._getActiveGenomeTx(db);
      const harness_ledger = (
        await db.query(
          "SELECT * FROM agent_harness_ledger ORDER BY entry_id DESC LIMIT 30",
        )
      ).rows;
      const rejectedFacts = (
        await db.query(
          "SELECT fact_key,task_id,version,review_note,reviewed_at FROM shared_facts WHERE reviewed_at IS NOT NULL AND NOT verified ORDER BY fact_id DESC LIMIT 6",
        )
      ).rows.map((rf) => ({
        type: "rejected_fact",
        target: rf.fact_key || rf.task_id,
        reason: rf.review_note,
      }));
      const rejectedMutations = harness_ledger
        .filter((e) => String(e.verdict).startsWith("rejected"))
        .slice(0, 6)
        .map((e) => ({
          type: "rejected_mutation",
          target: e.target_id,
          surfaces: e.target_surfaces,
          hypothesis: e.hypothesis,
          verdict: e.verdict,
          reason: e.reason,
        }));
      const falsified_history = [...rejectedMutations, ...rejectedFacts].slice(
        0,
        8,
      );
      return {
        capabilities,
        workers,
        memory,
        triggers,
        playbooks,
        genome,
        harness_ledger,
        falsified_history,
        time: Date.now(),
      };
    }, true);
  }
  /** Register or update a Cron, interval, or webhook trigger for recurring DAG execution.
   * 注册或更新定时（Cron / 间隔）或外部事件（Webhook）触发器，驱动周期性组织认知保鲜。
   */
  async upsertTrigger(triggerId, spec) {
    const normalized = validateTriggerSpec(triggerId, spec);
    const out = await this.tx(async (db) => {
      const catalog = new Map(
        (
          await db.query(
            "SELECT name,required_input_fields,allowed_context_prefixes FROM agent_capabilities",
          )
        ).rows.map((x) => [
          x.name,
          {
            requiredInput: x.required_input_fields ?? [],
            allowedPrefixes: x.allowed_context_prefixes ?? [],
          },
        ]),
      );
      this._checkInputContracts(normalized.plan.tasks, catalog);
      const trigger = (
        await db.query(
          `INSERT INTO agent_triggers(trigger_id,description,cron_expr,interval_seconds,webhook,plan,enabled,next_run_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
           ON CONFLICT(trigger_id) DO UPDATE SET
             description=EXCLUDED.description,
             cron_expr=EXCLUDED.cron_expr,
             interval_seconds=EXCLUDED.interval_seconds,
             webhook=EXCLUDED.webhook,
             plan=EXCLUDED.plan,
             enabled=EXCLUDED.enabled,
             next_run_at=EXCLUDED.next_run_at,
             updated_at=now()
           RETURNING *`,
          [
            normalized.trigger_id,
            normalized.description,
            normalized.cron_expr,
            normalized.interval_seconds,
            normalized.webhook,
            json(normalized.plan),
            normalized.enabled,
            normalized.next_run_at,
          ],
        )
      ).rows[0];
      await this.event(db, "trigger_upserted", null, {
        trigger_id: normalized.trigger_id,
        cron: normalized.cron_expr,
        interval_seconds: normalized.interval_seconds,
        webhook: normalized.webhook,
        enabled: normalized.enabled,
      });
      return { ok: true, trigger };
    });
    this.wakeup.emit("wake");
    return out;
  }
  /** Fire a registered trigger immediately (via schedule, webhook payload, or manual operator action).
   * 立即触发指定触发器（支持定时到期、外部 Webhook 载荷注入或管理端手动触发）。
   */
  async fireTrigger(
    triggerId,
    { requestId = null, payload = null, source = "manual" } = {},
  ) {
    if (typeof triggerId !== "string" || !/^[\w.:-]{4,100}$/.test(triggerId))
      throw Error("Invalid trigger_id");
    if (
      payload !== null &&
      payload !== undefined &&
      (typeof payload !== "object" || Array.isArray(payload))
    )
      throw Error("Invalid trigger payload");
    const prepared = await this.tx(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM agent_triggers WHERE trigger_id=$1 FOR UPDATE",
          [triggerId],
        )
      ).rows[0];
      if (!row) throw Error("Unknown trigger");
      if (!row.enabled && source !== "manual")
        return { triggered: false, reason: "disabled" };
      if (source === "webhook" && !row.webhook)
        throw Error("Webhook not enabled for trigger");
      const now = new Date();
      let nextRunAt = row.next_run_at;
      if (row.enabled) {
        if (row.cron_expr) {
          nextRunAt = nextCronDate(row.cron_expr, now);
        } else if (row.interval_seconds) {
          nextRunAt = new Date(now.getTime() + row.interval_seconds * 1000);
        }
      }
      const runNum = row.total_runs + 1;
      const reqId =
        requestId || `trig-${triggerId}-${runNum}-${randomUUID().slice(0, 8)}`;
      await db.query(
        "UPDATE agent_triggers SET last_triggered_at=now(),next_run_at=$2,total_runs=total_runs+1,last_request_id=$3,updated_at=now() WHERE trigger_id=$1",
        [triggerId, nextRunAt, reqId],
      );
      const plan = structuredClone(row.plan);
      if (payload) {
        for (const t of plan.tasks) {
          if (!t.dependencies || t.dependencies.length === 0) {
            t.input = { ...(t.input || {}), trigger_payload: payload };
          }
        }
      }
      await this.event(db, "trigger_fired", null, {
        trigger_id: triggerId,
        request_id: reqId,
        source,
        run: runNum,
      });
      return { triggered: true, reqId, plan };
    });
    if (!prepared.triggered) return prepared;
    const { ids } = await this.submit(prepared.reqId, prepared.plan);
    return {
      triggered: true,
      trigger_id: triggerId,
      request_id: prepared.reqId,
      ids,
    };
  }
  /** Execute all enabled scheduled triggers whose next_run_at is due.
   * 扫描并触发所有已到期的定时触发器。
   */
  async runDueTriggers(now = new Date()) {
    const due = await this.tx(async (db) => {
      return (
        await db.query(
          "SELECT trigger_id FROM agent_triggers WHERE enabled=true AND next_run_at IS NOT NULL AND next_run_at<=$1 ORDER BY next_run_at ASC",
          [now],
        )
      ).rows;
    }, true);
    const fired = [];
    for (const row of due) {
      const res = await this.fireTrigger(row.trigger_id, {
        source: "schedule",
      });
      if (res.triggered) fired.push(res);
    }
    return { fired };
  }
  async tick() {
    await this.tx((db) => this.reap(db));
    return this.runDueTriggers();
  }
  async snapshot() {
    return this.tx(async (db) => {
      const capabilities = (
        await db.query("SELECT * FROM agent_capabilities ORDER BY name")
      ).rows;
      const tasks = (
        await db.query(
          "SELECT * FROM agent_tasks ORDER BY updated_at DESC LIMIT 200",
        )
      ).rows;
      const agents = (
        await db.query("SELECT * FROM agent_workers ORDER BY agent_id")
      ).rows;
      const facts = (
        await db.query(
          "SELECT * FROM shared_facts ORDER BY fact_id DESC LIMIT 200",
        )
      ).rows;
      const events = (
        await db.query(
          "SELECT * FROM agent_events ORDER BY event_id DESC LIMIT 150",
        )
      ).rows;
      const quota = (
        await db.query(
          "SELECT capacity,(SELECT count(*)::int FROM agent_attempts WHERE status='running') AS used FROM agent_quota WHERE name='execution'",
        )
      ).rows[0];
      const attempts = (
        await db.query(
          "SELECT * FROM agent_attempts ORDER BY attempt_id DESC LIMIT 200",
        )
      ).rows;
      const triggers = (
        await db.query("SELECT * FROM agent_triggers ORDER BY trigger_id")
      ).rows;
      const playbooks = (
        await db.query("SELECT * FROM agent_playbooks ORDER BY playbook_id")
      ).rows;
      const genome = await this._getActiveGenomeTx(db);
      const harness_ledger = (
        await db.query(
          "SELECT * FROM agent_harness_ledger ORDER BY entry_id DESC LIMIT 30",
        )
      ).rows;
      return {
        capabilities,
        tasks,
        agents,
        facts,
        events,
        attempts,
        triggers,
        playbooks,
        genome,
        harness_ledger,
        quota,
        time: Date.now(),
      };
    }, true);
  }
  async _searchMemoryTx(
    db,
    query = "",
    {
      prefixes = [],
      minConfidence = null,
      limit = 20,
      includeDemoted = false,
    } = {},
  ) {
    const activeGenome = await this._getActiveGenomeTx(db);
    const invBoost = activeGenome.surfaces.memory_config.invariant_boost;
    const rows = (
      await db.query(
        `SELECT DISTINCT ON (f.fact_key)
           f.fact_id,f.fact_key,f.task_id,f.agent_id,f.version,f.value,f.verified,f.confidence,f.expires_at,f.review_note,f.reviewed_at,f.created_at,f.memory_tier,f.injected_count,f.accepted_count,f.demoted
         FROM shared_facts f
         JOIN agent_tasks t ON t.task_id=f.task_id AND t.attempts=f.version
         WHERE f.fact_key IS NOT NULL AND f.verified=true
           AND ($2::boolean OR NOT COALESCE(f.demoted,false))
           AND (f.expires_at IS NULL OR f.expires_at>now())
           AND ($1::double precision IS NULL OR COALESCE(f.confidence,1)>=$1::double precision)
         ORDER BY f.fact_key,f.fact_id DESC`,
        [minConfidence, Boolean(includeDemoted)],
      )
    ).rows;
    const prefixFiltered =
      prefixes && prefixes.length
        ? rows.filter((r) => prefixes.some((p) => r.fact_key.startsWith(p)))
        : rows;
    const clean = String(query ?? "")
      .trim()
      .toLowerCase();
    if (!clean || clean === "*") {
      return [...prefixFiltered]
        .sort((a, b) => {
          const aInv = a.memory_tier === "invariant" ? 1 : 0;
          const bInv = b.memory_tier === "invariant" ? 1 : 0;
          if (bInv !== aInv) return bInv - aInv;
          return Number(b.fact_id) - Number(a.fact_id);
        })
        .slice(0, limit);
    }
    const tokens = clean.split(/[\s,;|]+/).filter(Boolean);
    return prefixFiltered
      .map((r) => {
        const hay =
          `${r.fact_key} ${JSON.stringify(r.value)} ${r.review_note || ""}`.toLowerCase();
        let rawScore = 0;
        for (const tok of tokens) {
          if (hay.includes(tok)) rawScore += 1;
        }
        if (rawScore === 0) return { row: r, score: 0 };
        const structuralScore =
          rawScore + (r.memory_tier === "invariant" ? invBoost : 0);
        const mult = betaFeedbackMultiplier(
          r.accepted_count,
          r.injected_count,
        ).multiplier;
        return { row: r, score: Number((structuralScore * mult).toFixed(4)) };
      })
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.row.confidence ?? 1) - (a.row.confidence ?? 1) ||
          Number(b.row.fact_id) - Number(a.row.fact_id),
      )
      .slice(0, limit)
      .map((x) => x.row);
  }
  /** Search active verified organizational memory by keyword/topic and optional prefix/confidence filter.
   * 按关键词、命名空间前缀与最低置信度检索有效跨周期组织记忆。
   */
  async searchMemory(
    query = "",
    { prefix = null, minConfidence = null, limit = 20 } = {},
  ) {
    if (typeof query !== "string" || query.length > 200)
      throw Error("Invalid memory search query");
    if (
      prefix !== null &&
      prefix !== undefined &&
      (typeof prefix !== "string" || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(prefix))
    )
      throw Error("Invalid memory prefix");
    if (
      minConfidence !== null &&
      minConfidence !== undefined &&
      (typeof minConfidence !== "number" ||
        !Number.isFinite(minConfidence) ||
        minConfidence <= 0 ||
        minConfidence > 1)
    )
      throw Error("Invalid minConfidence");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error("Invalid limit");
    return this.tx(
      async (db) => ({
        facts: await this._searchMemoryTx(db, query, {
          prefixes: prefix ? [prefix] : [],
          minConfidence,
          limit,
        }),
      }),
      true,
    );
  }
  /** Roll back the current active verified fact on a fact_key so organizational memory reverts to the previous verified version.
   * 一键回滚指定 fact_key 的当前激活事实，使组织记忆自动回退至上一已核验历史版本。
   */
  async rollbackFact(
    factKey,
    { note = "Rolled back to previous verified version" } = {},
  ) {
    if (
      typeof factKey !== "string" ||
      !/^[a-z][a-z0-9_.:-]{0,119}$/.test(factKey)
    )
      throw Error("Invalid fact_key");
    if (typeof note !== "string" || !note.trim() || note.length > 4000)
      throw Error("Invalid rollback note");
    const trimmedNote = note.trim();
    const out = await this.tx(async (db) => {
      const current = (
        await db.query(
          `SELECT f.* FROM shared_facts f
           JOIN agent_tasks t ON t.task_id=f.task_id AND t.attempts=f.version
           WHERE f.fact_key=$1 AND f.verified=true
             AND (f.expires_at IS NULL OR f.expires_at>now())
           ORDER BY f.fact_id DESC LIMIT 1 FOR UPDATE OF f`,
          [factKey],
        )
      ).rows[0];
      if (!current) return { rolled_back: false, reason: "no_active_fact" };
      const revoked = (
        await db.query(
          `UPDATE shared_facts
           SET verified=false, review_note=$2, reviewed_at=now()
           WHERE fact_id=$1
           RETURNING *`,
          [current.fact_id, trimmedNote],
        )
      ).rows[0];
      const fallback = (
        await db.query(
          `SELECT f.fact_id,f.fact_key,f.task_id,f.agent_id,f.version,f.value,f.verified,f.confidence,f.expires_at,f.review_note,f.reviewed_at
           FROM shared_facts f
           JOIN agent_tasks t ON t.task_id=f.task_id AND t.attempts=f.version
           WHERE f.fact_key=$1 AND f.verified=true
             AND (f.expires_at IS NULL OR f.expires_at>now())
           ORDER BY f.fact_id DESC LIMIT 1`,
          [factKey],
        )
      ).rows[0];
      await this.event(db, "fact_rolled_back", current.task_id, {
        fact_key: factKey,
        revoked_fact_id: revoked.fact_id,
        active_fact_id: fallback?.fact_id ?? null,
        note: trimmedNote,
      });
      return {
        rolled_back: true,
        fact_key: factKey,
        revoked_fact: revoked,
        active_fact: fallback ?? null,
      };
    });
    if (out.rolled_back) this.wakeup.emit("wake");
    return out;
  }
  /** Time-travel DAG branching: fork an existing request into a new request, reusing upstream completed tasks & verified facts while re-running fromTaskKey and its descendants.
   * 状态时间旅行与分叉重放：从已有请求的指定节点分叉出新请求，直接复用上游已完成任务与核验事实，仅重跑目标节点及其下游子图。
   */
  async forkRequest(
    sourceRequestId,
    newRequestId,
    {
      fromTaskKey = null,
      inputOverrides = {},
      traceId = null,
      budget = null,
    } = {},
  ) {
    if (
      typeof sourceRequestId !== "string" ||
      !/^[\w-]{8,80}$/.test(sourceRequestId) ||
      typeof newRequestId !== "string" ||
      !/^[\w-]{8,80}$/.test(newRequestId) ||
      sourceRequestId === newRequestId
    )
      throw Error("Invalid fork request ids");
    if (
      !inputOverrides ||
      typeof inputOverrides !== "object" ||
      Array.isArray(inputOverrides)
    )
      throw Error("Invalid inputOverrides");
    const out = await this.tx(async (db) => {
      const existingNew = (
        await db.query(
          "SELECT request_id FROM agent_requests WHERE request_id=$1",
          [newRequestId],
        )
      ).rows[0];
      if (existingNew) throw Error("Target fork request_id already exists");
      const srcReq = (
        await db.query("SELECT * FROM agent_requests WHERE request_id=$1", [
          sourceRequestId,
        ])
      ).rows[0];
      if (!srcReq) throw Error("Source request not found");
      const srcTasks = (
        await db.query(
          "SELECT * FROM agent_tasks WHERE request_id=$1 ORDER BY task_id",
          [sourceRequestId],
        )
      ).rows;
      if (!srcTasks.length) throw Error("Source request has no tasks");
      const srcFacts = new Map(
        (
          await db.query(
            `SELECT f.* FROM shared_facts f
             JOIN agent_tasks t ON t.task_id=f.task_id AND t.attempts=f.version
             WHERE t.request_id=$1`,
            [sourceRequestId],
          )
        ).rows.map((f) => [f.task_id, f]),
      );

      // Determine dirty tasks (those that must be re-executed and all their transitive dependents)
      const dirty = new Set();
      let matchedTarget = fromTaskKey === null;
      for (const t of srcTasks) {
        const key = t.task_key || t.task_id;
        if (
          fromTaskKey !== null &&
          (key === fromTaskKey || t.task_id === fromTaskKey)
        ) {
          dirty.add(t.task_id);
          matchedTarget = true;
        } else if (
          fromTaskKey === null &&
          (t.status !== "completed" ||
            Object.hasOwn(inputOverrides, key) ||
            Object.hasOwn(inputOverrides, t.task_id))
        ) {
          dirty.add(t.task_id);
        } else if (t.status !== "completed") {
          dirty.add(t.task_id);
        }
      }
      if (!matchedTarget) throw Error("Unknown fork target task");

      let changed = true;
      while (changed) {
        changed = false;
        for (const t of srcTasks) {
          if (dirty.has(t.task_id)) continue;
          const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
          if (deps.some((d) => dirty.has(d))) {
            dirty.add(t.task_id);
            changed = true;
          }
        }
      }

      const catalog = new Map(
        (
          await db.query(
            "SELECT name,required_input_fields,allowed_context_prefixes FROM agent_capabilities",
          )
        ).rows.map((x) => [
          x.name,
          {
            requiredInput: x.required_input_fields ?? [],
            allowedPrefixes: x.allowed_context_prefixes ?? [],
          },
        ]),
      );

      const newIdMap = new Map(srcTasks.map((t) => [t.task_id, randomUUID()]));
      const nextTraceId = traceId ?? srcReq.trace_id ?? newRequestId;
      const maxTokens = budget?.max_tokens ?? srcReq.max_tokens ?? null;
      const maxCostUsd = budget?.max_cost_usd ?? srcReq.max_cost_usd ?? null;

      await db.query(
        "INSERT INTO agent_requests(request_id,plan,max_tokens,max_cost_usd,trace_id) VALUES($1,$2,$3,$4,$5)",
        [newRequestId, json(srcReq.plan), maxTokens, maxCostUsd, nextTraceId],
      );

      const reusedIds = [];
      const queuedIds = [];

      for (const t of srcTasks) {
        const newId = newIdMap.get(t.task_id);
        const key = t.task_key || t.task_id;
        const mappedDeps = (t.dependencies || [])
          .map((d) => newIdMap.get(d))
          .filter(Boolean)
          .sort();
        const override =
          inputOverrides[key] ?? inputOverrides[t.task_id] ?? null;
        const nextInput = override ? { ...t.input, ...override } : t.input;
        this._checkInputContracts(
          [
            {
              capability: t.capability,
              input: nextInput,
              context_keys: t.context_keys ?? [],
            },
          ],
          catalog,
        );

        if (!dirty.has(t.task_id)) {
          reusedIds.push(newId);
          await db.query(
            `INSERT INTO agent_tasks(task_id,task_key,capability,input,status,dependencies,result,attempts,agent_id,request_id,max_attempts,priority,require_verified_facts,min_fact_confidence,min_worker_pass_rate,fact_key,fact_ttl_seconds,context_keys,context_query,trace_id)
             VALUES($1,$2,$3,$4,'completed',$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [
              newId,
              key,
              t.capability,
              json(nextInput),
              json(mappedDeps),
              json(t.result),
              t.agent_id,
              newRequestId,
              t.max_attempts,
              t.priority ?? 0,
              t.require_verified_facts ?? false,
              t.min_fact_confidence ?? null,
              t.min_worker_pass_rate ?? null,
              t.fact_key ?? null,
              t.fact_ttl_seconds ?? null,
              json(t.context_keys ?? []),
              t.context_query ?? null,
              nextTraceId,
            ],
          );
          const sf = srcFacts.get(t.task_id);
          if (sf) {
            await db.query(
              `INSERT INTO shared_facts(task_id,agent_id,version,value,verified,confidence,fact_key,expires_at,review_note,reviewed_at)
               VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
              [
                newId,
                sf.agent_id,
                json(sf.value),
                sf.verified,
                sf.confidence,
                sf.fact_key,
                sf.expires_at,
                sf.review_note,
                sf.reviewed_at,
              ],
            );
          }
        } else {
          queuedIds.push(newId);
          await db.query(
            `INSERT INTO agent_tasks(task_id,task_key,capability,input,status,dependencies,attempts,request_id,max_attempts,priority,require_verified_facts,min_fact_confidence,min_worker_pass_rate,fact_key,fact_ttl_seconds,context_keys,context_query,trace_id)
             VALUES($1,$2,$3,$4,'queued',$5,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
              newId,
              key,
              t.capability,
              json(nextInput),
              json(mappedDeps),
              newRequestId,
              t.max_attempts,
              t.priority ?? 0,
              t.require_verified_facts ?? false,
              t.min_fact_confidence ?? null,
              t.min_worker_pass_rate ?? null,
              t.fact_key ?? null,
              t.fact_ttl_seconds ?? null,
              json(t.context_keys ?? []),
              t.context_query ?? null,
              nextTraceId,
            ],
          );
        }
      }

      await this.event(db, "request_forked", null, {
        source_request_id: sourceRequestId,
        request_id: newRequestId,
        from_task_key: fromTaskKey,
        reused_count: reusedIds.length,
        queued_count: queuedIds.length,
        trace_id: nextTraceId,
      });
      return {
        request_id: newRequestId,
        source_request_id: sourceRequestId,
        ids: [...newIdMap.values()].sort(),
        reused_task_ids: reusedIds.sort(),
        queued_task_ids: queuedIds.sort(),
      };
    });
    this.wakeup.emit("wake");
    return out;
  }
  /** Crystallize a proven request DAG (including runtime subgraph expansions) or explicit plan into a reusable versioned Organizational Playbook (Procedural Memory).
   * 技能结晶（程序性记忆固化）：将已跑通的请求任务图（含运行中动态扩展的子图拓扑）或指定计划固化为可版本化复用的组织标准作业程序（Playbook / SOP）。
   */
  async crystallizePlaybook(
    playbookId,
    { sourceRequestId = null, description = "", tags = [], plan = null } = {},
  ) {
    if (
      typeof playbookId !== "string" ||
      !/^[a-z][a-z0-9_.:-]{2,80}$/.test(playbookId)
    )
      throw Error("Invalid playbook_id");
    if (typeof description !== "string" || description.length > 500)
      throw Error("Invalid playbook description");
    if (
      !Array.isArray(tags) ||
      tags.length > 20 ||
      tags.some(
        (t) => typeof t !== "string" || !t.trim() || t.trim().length > 40,
      )
    )
      throw Error("Invalid playbook tags");
    const cleanTags = [...new Set(tags.map((t) => t.trim()))];

    const out = await this.tx(async (db) => {
      let normalizedPlan;
      if (sourceRequestId !== null && sourceRequestId !== undefined) {
        if (
          typeof sourceRequestId !== "string" ||
          !/^[\w-]{8,80}$/.test(sourceRequestId)
        )
          throw Error("Invalid sourceRequestId");
        const srcTasks = (
          await db.query(
            "SELECT * FROM agent_tasks WHERE request_id=$1 ORDER BY task_id",
            [sourceRequestId],
          )
        ).rows;
        if (!srcTasks.length)
          throw Error("Source request not found for playbook");
        const usedKeys = new Set();
        const keyByTaskId = new Map();
        for (let i = 0; i < srcTasks.length; i++) {
          const t = srcTasks[i];
          const base =
            t.task_key && /^[\w-]{1,70}$/.test(t.task_key)
              ? t.task_key
              : `step-${i + 1}`;
          let candidate = base;
          let seq = 2;
          while (usedKeys.has(candidate)) {
            candidate = `${base}-${seq++}`;
          }
          usedKeys.add(candidate);
          keyByTaskId.set(t.task_id, candidate);
        }
        const extractedTasks = srcTasks.map((t) => {
          const entry = {
            id: keyByTaskId.get(t.task_id),
            capability: t.capability,
            input: t.input ?? {},
            dependencies: (t.dependencies || [])
              .map((d) => keyByTaskId.get(d))
              .filter(Boolean),
          };
          if (t.priority) entry.priority = t.priority;
          if (
            t.max_attempts !== null &&
            t.max_attempts !== undefined &&
            t.max_attempts !== this.maxAttempts
          )
            entry.max_attempts = t.max_attempts;
          if (t.require_verified_facts) entry.require_verified_facts = true;
          if (
            t.min_fact_confidence !== null &&
            t.min_fact_confidence !== undefined
          )
            entry.min_fact_confidence = Number(t.min_fact_confidence);
          if (
            t.min_worker_pass_rate !== null &&
            t.min_worker_pass_rate !== undefined
          )
            entry.min_worker_pass_rate = Number(t.min_worker_pass_rate);
          if (t.fact_key) entry.fact_key = t.fact_key;
          if (t.fact_ttl_seconds) entry.fact_ttl_seconds = t.fact_ttl_seconds;
          if (Array.isArray(t.context_keys) && t.context_keys.length)
            entry.context_keys = t.context_keys;
          if (t.context_query) entry.context_query = t.context_query;
          return entry;
        });
        normalizedPlan = validatePlan("playbook-template", {
          tasks: extractedTasks,
        });
      } else if (plan !== null && plan !== undefined) {
        normalizedPlan = validatePlan("playbook-template", plan);
      } else {
        throw Error("Playbook requires sourceRequestId or plan");
      }

      const catalog = new Map(
        (
          await db.query(
            "SELECT name,required_input_fields,allowed_context_prefixes FROM agent_capabilities",
          )
        ).rows.map((x) => [
          x.name,
          {
            requiredInput: x.required_input_fields ?? [],
            allowedPrefixes: x.allowed_context_prefixes ?? [],
          },
        ]),
      );
      this._checkInputContracts(normalizedPlan.tasks, catalog);

      const playbook = (
        await db.query(
          `INSERT INTO agent_playbooks(playbook_id,description,source_request_id,version,plan_template,tags,updated_at)
           VALUES($1,$2,$3,1,$4,$5,now())
           ON CONFLICT(playbook_id) DO UPDATE SET
             description=EXCLUDED.description,
             source_request_id=COALESCE(EXCLUDED.source_request_id,agent_playbooks.source_request_id),
             version=agent_playbooks.version+1,
             plan_template=EXCLUDED.plan_template,
             tags=EXCLUDED.tags,
             updated_at=now()
           RETURNING *`,
          [
            playbookId,
            description.trim(),
            sourceRequestId,
            json(normalizedPlan),
            json(cleanTags),
          ],
        )
      ).rows[0];
      await this.event(db, "playbook_crystallized", null, {
        playbook_id: playbookId,
        version: playbook.version,
        source_request_id: sourceRequestId,
        task_count: normalizedPlan.tasks.length,
      });
      return { ok: true, playbook };
    });
    this.wakeup.emit("wake");
    return out;
  }
  /** List all crystallized organizational playbooks.
   * 获取所有已固化的组织技能模板（Playbooks）。
   */
  async listPlaybooks() {
    return this.tx(
      async (db) => ({
        playbooks: (
          await db.query("SELECT * FROM agent_playbooks ORDER BY playbook_id")
        ).rows,
      }),
      true,
    );
  }
  /** Instantiate and execute a crystallized organizational playbook with optional per-task inputOverrides or root params.
   * 实例化并运行指定组织技能模板（支持注入根参数 params 或按节点 ID 覆写 inputOverrides）。
   */
  async runPlaybook(
    playbookId,
    requestId = null,
    { inputOverrides = {}, params = {}, traceId = null, budget = null } = {},
  ) {
    if (
      typeof playbookId !== "string" ||
      !/^[a-z][a-z0-9_.:-]{2,80}$/.test(playbookId)
    )
      throw Error("Invalid playbook_id");
    if (
      !inputOverrides ||
      typeof inputOverrides !== "object" ||
      Array.isArray(inputOverrides)
    )
      throw Error("Invalid inputOverrides");
    if (!params || typeof params !== "object" || Array.isArray(params))
      throw Error("Invalid playbook params");

    const prepared = await this.tx(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM agent_playbooks WHERE playbook_id=$1 FOR UPDATE",
          [playbookId],
        )
      ).rows[0];
      if (!row) throw Error("Unknown playbook");
      const runNum = row.total_runs + 1;
      const reqId =
        requestId || `pb-${playbookId}-${runNum}-${randomUUID().slice(0, 8)}`;
      await db.query(
        "UPDATE agent_playbooks SET total_runs=total_runs+1,last_run_at=now(),updated_at=now() WHERE playbook_id=$1",
        [playbookId],
      );
      const plan = structuredClone(row.plan_template);
      plan.trace_id = traceId ?? `trace.playbook.${playbookId}`;
      if (budget) plan.budget = budget;
      for (const t of plan.tasks) {
        if (
          Object.keys(params).length > 0 &&
          (!t.dependencies || t.dependencies.length === 0)
        ) {
          t.input = { ...(t.input || {}), ...params };
        }
        if (Object.hasOwn(inputOverrides, t.id)) {
          const ov = inputOverrides[t.id];
          if (!ov || typeof ov !== "object" || Array.isArray(ov))
            throw Error("Invalid task input override");
          t.input = { ...(t.input || {}), ...ov };
        }
      }
      await this.event(db, "playbook_executed", null, {
        playbook_id: playbookId,
        version: row.version,
        request_id: reqId,
        run: runNum,
      });
      return { reqId, plan, version: row.version };
    });
    const { ids } = await this.submit(prepared.reqId, prepared.plan);
    return {
      ok: true,
      playbook_id: playbookId,
      version: prepared.version,
      request_id: prepared.reqId,
      ids,
    };
  }
  /** Delete a crystallized playbook by ID.
   * 删除指定的组织技能模板。
   */
  async deletePlaybook(playbookId) {
    if (
      typeof playbookId !== "string" ||
      !/^[a-z][a-z0-9_.:-]{2,80}$/.test(playbookId)
    )
      throw Error("Invalid playbook_id");
    return this.tx(async (db) => {
      const res = await db.query(
        "DELETE FROM agent_playbooks WHERE playbook_id=$1",
        [playbookId],
      );
      return { deleted: Boolean(res.rowCount) };
    });
  }
  /** Export a portable organizational knowledge & governance bundle (capabilities, verified memory, triggers, playbooks).
   * 导出可迁移的组织认知资产包（能力契约、已核验组织记忆、定时/事件触发器、已结晶技能 Playbooks）。
   */
  async exportBundle() {
    const tel = await this.telemetry();
    return {
      version: "1.3",
      exported_at: new Date().toISOString(),
      capabilities: tel.capabilities.map((c) => ({
        name: c.name,
        description: c.description,
        verifier: c.verifier,
        required_input_fields: c.required_input_fields,
        required_output_fields: c.required_output_fields,
        allowed_context_prefixes: c.allowed_context_prefixes,
      })),
      memory: tel.memory.map((m) => ({
        fact_key: m.fact_key,
        value: m.value,
        confidence: m.confidence ?? 1,
        memory_tier: m.memory_tier ?? "episodic",
        review_note: m.review_note ?? "imported",
      })),
      triggers: tel.triggers.map((t) => ({
        trigger_id: t.trigger_id,
        description: t.description,
        cron: t.cron_expr,
        interval_seconds: t.interval_seconds,
        webhook: t.webhook,
        enabled: t.enabled,
        plan: t.plan,
      })),
      playbooks: (tel.playbooks || []).map((p) => ({
        playbook_id: p.playbook_id,
        description: p.description,
        source_request_id: p.source_request_id,
        tags: p.tags,
        plan: p.plan_template,
      })),
      genome: tel.genome?.raw_overrides ?? {},
    };
  }
  /** Import a portable organizational knowledge & governance bundle into this registry.
   * 导入组织认知资产包（批量恢复已核验命名事实记忆、触发器、技能模板 Playbooks 与 HarnessGenome）。
   */
  async importBundle(bundle) {
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
      throw Error("Invalid bundle");
    const memoryList = Array.isArray(bundle.memory) ? bundle.memory : [];
    const triggersList = Array.isArray(bundle.triggers) ? bundle.triggers : [];
    const playbooksList = Array.isArray(bundle.playbooks)
      ? bundle.playbooks
      : [];
    let importedFacts = 0;
    await this.tx(async (db) => {
      const firstCap =
        (
          await db.query(
            "SELECT name FROM agent_capabilities ORDER BY name LIMIT 1",
          )
        ).rows[0]?.name ?? "imported";
      for (const item of memoryList) {
        if (
          !item ||
          typeof item.fact_key !== "string" ||
          !/^[a-z][a-z0-9_.:-]{0,119}$/.test(item.fact_key) ||
          !item.value ||
          typeof item.value !== "object" ||
          Array.isArray(item.value)
        )
          throw Error("Invalid bundle memory item");
        const tier =
          item.memory_tier === "invariant" ? "invariant" : "episodic";
        const seedTaskId = `bundle-fact-${randomUUID()}`;
        await db.query(
          `INSERT INTO agent_tasks(task_id,task_key,capability,input,status,result,attempts,agent_id,request_id,fact_key)
           VALUES($1,'bundle-import',$2,'{}','completed',$3,1,'bundle-importer','bundle-import',$4)`,
          [seedTaskId, firstCap, json(item.value), item.fact_key],
        );
        await db.query(
          `INSERT INTO shared_facts(task_id,agent_id,version,value,verified,confidence,fact_key,memory_tier,review_note,reviewed_at)
           VALUES($1,'bundle-importer',1,$2,true,$3,$4,$5,$6,now())`,
          [
            seedTaskId,
            json(item.value),
            item.confidence ?? 1,
            item.fact_key,
            tier,
            item.review_note ?? "Imported from organizational bundle",
          ],
        );
        importedFacts += 1;
      }
      await this.event(db, "bundle_imported", null, {
        imported_facts: importedFacts,
        imported_triggers: triggersList.length,
        imported_playbooks: playbooksList.length,
      });
    });
    for (const trig of triggersList) {
      await this.upsertTrigger(trig.trigger_id, trig);
    }
    for (const pb of playbooksList) {
      await this.crystallizePlaybook(pb.playbook_id, {
        description: pb.description ?? "",
        tags: pb.tags ?? [],
        plan: pb.plan ?? pb.plan_template,
      });
    }
    if (
      bundle.genome &&
      typeof bundle.genome === "object" &&
      !Array.isArray(bundle.genome) &&
      Object.keys(bundle.genome).length > 0
    ) {
      await this.updateGenome(bundle.genome, {
        hypothesis: "Imported from organizational bundle",
      });
    }
    this.wakeup.emit("wake");
    return {
      ok: true,
      imported_facts: importedFacts,
      imported_triggers: triggersList.length,
      imported_playbooks: playbooksList.length,
    };
  }
  async _attributeRecalledMemoryTx(db, task, result, usage) {
    const recalledIds = Array.isArray(task.recalled_fact_ids)
      ? task.recalled_fact_ids
          .map(Number)
          .filter((n) => Number.isSafeInteger(n) && n > 0)
      : [];
    if (!recalledIds.length) return;
    const genome = await this._getActiveGenomeTx(db);
    const memCfg = genome.surfaces.memory_config;
    const totalTokens = Number(usage?.total_tokens ?? 0);
    const expensiveTurn = totalTokens > memCfg.expensive_token_threshold;
    const taskBlob = JSON.stringify({
      fact_key: task.fact_key,
      input: task.input,
      result,
    }).toLowerCase();

    const recalledRows = (
      await db.query(
        "SELECT fact_id,fact_key,value,memory_tier,injected_count,accepted_count,demoted FROM shared_facts WHERE fact_id=ANY($1::bigint[]) FOR UPDATE",
        [recalledIds],
      )
    ).rows;
    for (const rf of recalledRows) {
      let helpful = true;
      if (expensiveTurn) {
        const ns = extractMemoryNamespace(rf.fact_key, {
          allowTwoSegmentNamespace: true,
        });
        const keyParts = String(rf.fact_key ?? "")
          .toLowerCase()
          .split(/[._:-]+/)
          .filter((w) => w.length >= 4 && w !== "invariant");
        const matched =
          (ns && taskBlob.includes(ns.toLowerCase())) ||
          keyParts.some((kp) => taskBlob.includes(kp));
        helpful = Boolean(matched);
      }
      const nextAccepted = helpful ? rf.accepted_count + 1 : rf.accepted_count;
      const fb = betaFeedbackMultiplier(nextAccepted, rf.injected_count);
      const nextDemoted =
        rf.demoted || (rf.memory_tier === "episodic" && fb.should_demote);
      await db.query(
        "UPDATE shared_facts SET accepted_count=$2,demoted=$3 WHERE fact_id=$1",
        [rf.fact_id, nextAccepted, nextDemoted],
      );
    }
  }
  async _promoteNamespaceInvariantIfDueTx(
    db,
    namespace,
    { maxEpisodic = null, ruleSummary = null } = {},
  ) {
    if (
      typeof namespace !== "string" ||
      !/^[a-z][a-z0-9_.:-]{1,80}$/.test(namespace)
    )
      throw Error("Invalid memory namespace");
    const genome = await this._getActiveGenomeTx(db);
    const capLimit =
      maxEpisodic ??
      genome.surfaces.memory_config.max_episodic_per_namespace ??
      2;
    const episodicRows = (
      await db.query(
        `SELECT DISTINCT ON (f.fact_key)
           f.fact_id,f.fact_key,f.task_id,f.agent_id,f.version,f.value,f.confidence,f.review_note,f.reviewed_at,f.created_at
         FROM shared_facts f
         JOIN agent_tasks t ON t.task_id=f.task_id AND t.attempts=f.version
         WHERE f.fact_key LIKE $1 AND f.fact_key <> $2
           AND f.verified=true AND f.memory_tier='episodic' AND NOT COALESCE(f.demoted,false)
           AND (f.expires_at IS NULL OR f.expires_at>now())
         ORDER BY f.fact_key,f.fact_id DESC`,
        [`${namespace}.%`, `${namespace}.__invariant__`],
      )
    ).rows.sort((a, b) => Number(b.fact_id) - Number(a.fact_id));

    if (episodicRows.length < 2) {
      return {
        promoted: false,
        namespace,
        episodic_count: episodicRows.length,
      };
    }

    const invariantKey = `${namespace}.__invariant__`;
    const invariantTaskId = `invariant:${namespace}`;
    const existingInv = (
      await db.query(
        "SELECT fact_id,version,injected_count,accepted_count FROM shared_facts WHERE fact_key=$1 ORDER BY fact_id DESC LIMIT 1",
        [invariantKey],
      )
    ).rows[0];
    const nextVersion = existingInv ? Number(existingInv.version) + 1 : 1;
    const preservedInjected = existingInv
      ? Number(existingInv.injected_count)
      : 0;
    const preservedAccepted = existingInv
      ? Number(existingInv.accepted_count)
      : 0;

    const keySymbols = [
      ...new Set(
        episodicRows.flatMap((r) => [
          r.fact_key.slice(namespace.length + 1),
          ...Object.keys(r.value || {}),
        ]),
      ),
    ].slice(0, 12);
    const mergedFacts = {};
    for (const r of [...episodicRows].reverse()) {
      const shortKey = r.fact_key.slice(namespace.length + 1);
      mergedFacts[shortKey] = r.value;
    }
    const invariantValue = {
      invariant_header: `[Module Invariant: ${namespace}]`,
      namespace,
      verified_across_tasks: episodicRows.length,
      key_symbols: keySymbols,
      latest_rule:
        ruleSummary ||
        episodicRows[0]?.review_note ||
        `Synthesized from ${episodicRows.length} verified facts in ${namespace}`,
      consolidated_facts: mergedFacts,
    };
    const firstCap =
      (
        await db.query(
          "SELECT name FROM agent_capabilities ORDER BY name LIMIT 1",
        )
      ).rows[0]?.name ?? "invariant";

    await db.query(
      `INSERT INTO agent_tasks(task_id,task_key,capability,input,status,result,attempts,agent_id,request_id,fact_key)
       VALUES($1,$2,$3,'{}','completed',$4,$5,'harness-promoter','harness-invariant',$6)
       ON CONFLICT(task_id) DO UPDATE SET
         result=EXCLUDED.result,
         attempts=EXCLUDED.attempts,
         updated_at=now()`,
      [
        invariantTaskId,
        `invariant-${namespace}`,
        firstCap,
        json(invariantValue),
        nextVersion,
        invariantKey,
      ],
    );
    const invRow = (
      await db.query(
        `INSERT INTO shared_facts(task_id,agent_id,version,value,verified,confidence,fact_key,memory_tier,injected_count,accepted_count,review_note,reviewed_at)
         VALUES($1,'harness-promoter',$2,$3,true,0.99,$4,'invariant',$5,$6,$7,now())
         RETURNING *`,
        [
          invariantTaskId,
          nextVersion,
          json(invariantValue),
          invariantKey,
          preservedInjected,
          preservedAccepted,
          `[Module Invariant: ${namespace}] Auto-promoted from ${episodicRows.length} verified episodic facts`,
        ],
      )
    ).rows[0];

    const keptEpisodic = episodicRows.slice(0, capLimit);
    const evictedEpisodic = episodicRows.slice(capLimit);
    if (evictedEpisodic.length > 0) {
      const evictedKeys = evictedEpisodic.map((e) => e.fact_key);
      await db.query(
        "UPDATE shared_facts SET demoted=true WHERE fact_key=ANY($1::text[]) AND memory_tier='episodic'",
        [evictedKeys],
      );
    }

    await this.event(db, "memory_invariant_promoted", invariantTaskId, {
      namespace,
      invariant_key: invariantKey,
      version: nextVersion,
      merged_count: episodicRows.length,
      kept_episodic: keptEpisodic.length,
      demoted_episodic: evictedEpisodic.length,
    });

    return {
      promoted: true,
      namespace,
      invariant: invRow,
      kept_episodic_keys: keptEpisodic.map((k) => k.fact_key),
      demoted_episodic_keys: evictedEpisodic.map((k) => k.fact_key),
    };
  }
  /** Explicitly promote or refresh a module/namespace invariant from verified episodic facts and cap episodic entries (Harness² P3.1).
   * 提炼或刷新指定命名空间的模块级不变量（`[Module Invariant: <namespace>]`），并将单题情景记忆裁剪至上限。
   */
  async promoteMemoryInvariant(namespace, options = {}) {
    const out = await this.tx((db) =>
      this._promoteNamespaceInvariantIfDueTx(db, namespace, options),
    );
    if (out.promoted) this.wakeup.emit("wake");
    return out;
  }
  /** Get the active multi-surface HarnessGenome (`planner_prompts`, `adapter_prompts`, `memory_config`, `expansion_config`).
   * 获取当前生效的可进化 Harness 基因组配置表面。
   */
  async getGenome() {
    return this.tx((db) => this._getActiveGenomeTx(db), true);
  }
  /** Validate and apply an updated HarnessGenome with frozen security boundary protection and critic check.
   * 校验并更新 Harness 基因组（带安全边界保护、反作弊审查与退火编辑预算检查）。
   */
  async updateGenome(
    candidate,
    {
      hypothesis = "Manual operator genome update",
      round = 0,
      maxSurfaces = null,
      maxChangedLines = null,
      annealSurfaces = false,
      forbiddenTerms = [],
    } = {},
  ) {
    const out = await this.tx(async (db) => {
      const current = await this._getActiveGenomeTx(db);
      const mergedRaw = {
        planner_prompts: {
          ...(current.raw_overrides.planner_prompts || {}),
          ...(candidate?.planner_prompts || {}),
        },
        adapter_prompts: {
          ...(current.raw_overrides.adapter_prompts || {}),
          ...(candidate?.adapter_prompts || {}),
        },
        memory_config: {
          ...(current.raw_overrides.memory_config || {}),
          ...(candidate?.memory_config || {}),
        },
        expansion_config: {
          ...(current.raw_overrides.expansion_config || {}),
          ...(candidate?.expansion_config || {}),
        },
      };
      // Validate top-level keys of candidate first
      resolveAndValidateGenome(candidate, {
        parent: current.surfaces,
        maxSurfaces,
        maxChangedLines,
        round,
        annealSurfaces,
      });
      const resolved = resolveAndValidateGenome(mergedRaw, {
        parent: current.surfaces,
        maxSurfaces,
        maxChangedLines,
        round,
        annealSurfaces,
      });
      const critic = criticCheckCandidate(candidate, { forbiddenTerms });
      const changed = changedGenomeSurfaces(resolved, current.surfaces);
      const lines = changedGenomeLines(resolved, current.surfaces);
      if (!critic.ok) {
        await db.query(
          `INSERT INTO agent_harness_ledger(round,target_type,target_id,hypothesis,target_surfaces,changed_lines,verdict,reason)
           VALUES($1,'genome','active',$2,$3,$4,$5,$6)`,
          [
            round,
            hypothesis,
            json(changed),
            lines,
            critic.verdict,
            critic.reason,
          ],
        );
        throw Error(critic.reason);
      }
      const row = (
        await db.query(
          `INSERT INTO agent_harness_genome(genome_id,version,surfaces,updated_at)
           VALUES('active',1,$1,now())
           ON CONFLICT(genome_id) DO UPDATE SET
             version=agent_harness_genome.version+1,
             surfaces=$1,
             updated_at=now()
           RETURNING *`,
          [json(resolved)],
        )
      ).rows[0];
      await db.query(
        `INSERT INTO agent_harness_ledger(round,target_type,target_id,hypothesis,target_surfaces,changed_lines,verdict,reason)
         VALUES($1,'genome','active',$2,$3,$4,'accepted_operator','Validated and applied genome surfaces')`,
        [round, hypothesis, json(changed), lines],
      );
      await this.event(db, "genome_updated", null, {
        version: row.version,
        changed_surfaces: changed,
        changed_lines: lines,
        hypothesis,
      });
      return {
        ok: true,
        version: row.version,
        surfaces: resolved,
        changed_surfaces: changed,
        changed_lines: lines,
      };
    });
    this.wakeup.emit("wake");
    return out;
  }
  /** Execute an RRSI-regularized Genome evolution step with annealed edit budget, critic check, dual-channel cost-aware gate, optional ablation pruning, and stagnation surface recommendation.
   * 执行 RRSI 正则化基因组进化（含按轮退火编辑预算、反过拟合 Critic、双通道成本感知验收门、消融剪枝与实验账本记录）。
   */
  async evolveGenome(
    candidate,
    {
      hypothesis = "",
      round = 0,
      incumbentMetrics = {},
      candidateMetrics = {},
      deltaPass = 0.05,
      deltaTokens = 150,
      maxTokenGrowth = 500,
      maxSurfaces = 2,
      maxChangedLines = 40,
      annealSurfaces = true,
      forbiddenTerms = [],
      ablationMetricsBySurface = null,
    } = {},
  ) {
    const out = await this.tx(async (db) => {
      const current = await this._getActiveGenomeTx(db);
      const mergedRaw = {
        planner_prompts: {
          ...(current.surfaces.planner_prompts || {}),
          ...(candidate?.planner_prompts || {}),
        },
        adapter_prompts: {
          ...(current.surfaces.adapter_prompts || {}),
          ...(candidate?.adapter_prompts || {}),
        },
        memory_config: {
          ...(current.surfaces.memory_config || {}),
          ...(candidate?.memory_config || {}),
        },
        expansion_config: {
          ...(current.surfaces.expansion_config || {}),
          ...(candidate?.expansion_config || {}),
        },
      };
      let resolved;
      try {
        resolveAndValidateGenome(candidate);
        resolved = resolveAndValidateGenome(mergedRaw, {
          parent: current.surfaces,
          maxSurfaces,
          maxChangedLines,
          round,
          annealSurfaces,
        });
      } catch (e) {
        await db.query(
          `INSERT INTO agent_harness_ledger(round,target_type,target_id,hypothesis,target_surfaces,changed_lines,incumbent_metrics,candidate_metrics,verdict,reason)
           VALUES($1,'genome','active',$2,'[]',0,$3,$4,'rejected_edit_budget',$5)`,
          [
            round,
            hypothesis,
            json(incumbentMetrics),
            json(candidateMetrics),
            e.message,
          ],
        );
        return {
          accepted: false,
          verdict: "rejected_edit_budget",
          reason: e.message,
        };
      }

      const changed = changedGenomeSurfaces(resolved, current.surfaces);
      const lines = changedGenomeLines(resolved, current.surfaces);

      const critic = criticCheckCandidate(candidate, { forbiddenTerms });
      if (!critic.ok) {
        await db.query(
          `INSERT INTO agent_harness_ledger(round,target_type,target_id,hypothesis,target_surfaces,changed_lines,incumbent_metrics,candidate_metrics,verdict,reason)
           VALUES($1,'genome','active',$2,$3,$4,$5,$6,$7,$8)`,
          [
            round,
            hypothesis,
            json(changed),
            lines,
            json(incumbentMetrics),
            json(candidateMetrics),
            critic.verdict,
            critic.reason,
          ],
        );
        return {
          accepted: false,
          verdict: critic.verdict,
          reason: critic.reason,
          changed_surfaces: changed,
        };
      }

      const gate = evaluateDualChannelGate(incumbentMetrics, candidateMetrics, {
        deltaPass,
        deltaTokens,
        maxTokenGrowth,
      });
      if (!gate.accepted) {
        await db.query(
          `INSERT INTO agent_harness_ledger(round,target_type,target_id,hypothesis,target_surfaces,changed_lines,incumbent_metrics,candidate_metrics,verdict,reason)
           VALUES($1,'genome','active',$2,$3,$4,$5,$6,$7,$8)`,
          [
            round,
            hypothesis,
            json(changed),
            lines,
            json(incumbentMetrics),
            json(candidateMetrics),
            gate.verdict,
            gate.reason,
          ],
        );
        const recentLedger = (
          await db.query(
            "SELECT * FROM agent_harness_ledger ORDER BY entry_id DESC LIMIT 20",
          )
        ).rows;
        return {
          accepted: false,
          verdict: gate.verdict,
          reason: gate.reason,
          changed_surfaces: changed,
          recommended_focus_surface: pickStagnationSurface(recentLedger),
        };
      }

      // Optional RRSI P1.5 Post-search Ablation Pruning of free-rider surfaces
      const prunedSurfaces = [];
      if (
        ablationMetricsBySurface &&
        typeof ablationMetricsBySurface === "object" &&
        changed.length > 1
      ) {
        for (const surf of changed) {
          const ablatedMetrics = ablationMetricsBySurface[surf];
          if (!ablatedMetrics) continue;
          const [grp, key] = surf.split(":");
          const passDrop =
            Number(candidateMetrics.pass_rate ?? 0) -
            Number(ablatedMetrics.pass_rate ?? 0);
          const tokWorsening =
            Number(ablatedMetrics.mean_tokens ?? 0) -
            Number(candidateMetrics.mean_tokens ?? 0);
          if (passDrop <= deltaPass && tokWorsening <= deltaTokens) {
            resolved[grp][key] = current.surfaces[grp][key];
            prunedSurfaces.push(surf);
          }
        }
      }

      const finalChanged = changedGenomeSurfaces(resolved, current.surfaces);
      const row = (
        await db.query(
          `INSERT INTO agent_harness_genome(genome_id,version,surfaces,updated_at)
           VALUES('active',1,$1,now())
           ON CONFLICT(genome_id) DO UPDATE SET
             version=agent_harness_genome.version+1,
             surfaces=$1,
             updated_at=now()
           RETURNING *`,
          [json(resolved)],
        )
      ).rows[0];
      await db.query(
        `INSERT INTO agent_harness_ledger(round,target_type,target_id,hypothesis,target_surfaces,changed_lines,incumbent_metrics,candidate_metrics,verdict,reason)
         VALUES($1,'genome','active',$2,$3,$4,$5,$6,$7,$8)`,
        [
          round,
          hypothesis,
          json(finalChanged),
          lines,
          json(incumbentMetrics),
          json(candidateMetrics),
          gate.verdict,
          gate.reason,
        ],
      );
      await this.event(db, "genome_evolved", null, {
        version: row.version,
        verdict: gate.verdict,
        channel: gate.channel,
        changed_surfaces: finalChanged,
        pruned_surfaces: prunedSurfaces,
        hypothesis,
      });
      return {
        accepted: true,
        verdict: gate.verdict,
        channel: gate.channel,
        reason: gate.reason,
        version: row.version,
        surfaces: resolved,
        changed_surfaces: finalChanged,
        pruned_surfaces: prunedSurfaces,
      };
    });
    if (out.accepted) this.wakeup.emit("wake");
    return out;
  }
  /** Evolve a crystallized Playbook under RRSI regularization (anti-overfitting critic + dual-channel cost-aware gate + ledger).
   * 在 RRSI 正则化门禁下进化组织技能 Playbook（反过拟合审查 + 双通道成本感知验收门 + 证伪账本记录）。
   */
  async evolvePlaybook(
    playbookId,
    {
      sourceRequestId = null,
      plan = null,
      description = "",
      tags = [],
      hypothesis = "",
      round = 1,
      incumbentMetrics = {},
      candidateMetrics = {},
      deltaPass = 0.05,
      deltaTokens = 150,
      maxTokenGrowth = 500,
      forbiddenTerms = [],
    } = {},
  ) {
    const critic = criticCheckCandidate(
      { plan, description, tags, hypothesis },
      { forbiddenTerms },
    );
    if (!critic.ok) {
      await this.tx(async (db) => {
        await db.query(
          `INSERT INTO agent_harness_ledger(round,target_type,target_id,hypothesis,target_surfaces,changed_lines,incumbent_metrics,candidate_metrics,verdict,reason)
           VALUES($1,'playbook',$2,$3,$4,0,$5,$6,$7,$8)`,
          [
            round,
            playbookId,
            hypothesis,
            json([`playbook:${playbookId}`]),
            json(incumbentMetrics),
            json(candidateMetrics),
            critic.verdict,
            critic.reason,
          ],
        );
      });
      return {
        accepted: false,
        verdict: critic.verdict,
        reason: critic.reason,
      };
    }

    const gate = evaluateDualChannelGate(incumbentMetrics, candidateMetrics, {
      deltaPass,
      deltaTokens,
      maxTokenGrowth,
    });
    if (!gate.accepted) {
      await this.tx(async (db) => {
        await db.query(
          `INSERT INTO agent_harness_ledger(round,target_type,target_id,hypothesis,target_surfaces,changed_lines,incumbent_metrics,candidate_metrics,verdict,reason)
           VALUES($1,'playbook',$2,$3,$4,0,$5,$6,$7,$8)`,
          [
            round,
            playbookId,
            hypothesis,
            json([`playbook:${playbookId}`]),
            json(incumbentMetrics),
            json(candidateMetrics),
            gate.verdict,
            gate.reason,
          ],
        );
      });
      return {
        accepted: false,
        verdict: gate.verdict,
        reason: gate.reason,
      };
    }

    const crystallized = await this.crystallizePlaybook(playbookId, {
      sourceRequestId,
      plan,
      description,
      tags,
    });
    await this.tx(async (db) => {
      await db.query(
        `INSERT INTO agent_harness_ledger(round,target_type,target_id,hypothesis,target_surfaces,changed_lines,incumbent_metrics,candidate_metrics,verdict,reason)
         VALUES($1,'playbook',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          round,
          playbookId,
          hypothesis,
          json([`playbook:${playbookId}`]),
          crystallized.playbook.plan_template?.tasks?.length ?? 0,
          json(incumbentMetrics),
          json(candidateMetrics),
          gate.verdict,
          gate.reason,
        ],
      );
    });
    return {
      accepted: true,
      verdict: gate.verdict,
      channel: gate.channel,
      reason: gate.reason,
      playbook: crystallized.playbook,
    };
  }
  /** Query the RRSI experiment ledger, falsified hypotheses, and stagnation surface recommendation.
   * 查询 RRSI 进化实验账本、已证伪假设列表与停滞转向建议表面。
   */
  async getHarnessLedger({ limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw Error("Invalid ledger limit");
    return this.tx(async (db) => {
      const entries = (
        await db.query(
          "SELECT * FROM agent_harness_ledger ORDER BY entry_id DESC LIMIT $1",
          [limit],
        )
      ).rows;
      return {
        entries,
        recommended_focus_surface: pickStagnationSurface(entries),
      };
    }, true);
  }
  /** Calibrate single-arm noise floor (delta_resolved, delta_pass_rate, delta_cost_usd, delta_tokens) from registry execution telemetry (RRSI P0.1).
   * 基于注册中心实测遥测数据或传入样本执行单臂噪声下限校准（Jeffreys 平滑方差与样本成本方差）。
   */
  async calibrateHarness({ tasks = null, rounds = 3 } = {}) {
    if (Array.isArray(tasks)) {
      return calibrateArmStats(tasks, { rounds });
    }
    const tel = await this.telemetry();
    const derived = tel.capabilities
      .filter((c) => !c.verifier)
      .map((c) => {
        const n = Math.max(
          1,
          c.verified_facts + c.rejected_facts ||
            c.completed_tasks + c.failed_tasks ||
            1,
        );
        const k =
          c.verified_facts + c.rejected_facts > 0
            ? c.verified_facts
            : c.completed_tasks;
        return {
          id: c.name,
          runs: n,
          resolved: k,
          cost_usd: c.total_cost_usd,
          total_tokens: c.total_tokens,
        };
      });
    return calibrateArmStats(derived, { rounds });
  }
  /** Compare two paired evaluation arms using exact McNemar test, paired bootstrap 95% CI on cost_per_resolved ratio (B/A), and non-inferiority guard (RRSI P0.2).
   * 执行双臂逐题配对统计检验（精确 McNemar + 固定种子按题配对 Bootstrap 95% 置信区间 + 解决率非劣效护栏）。
   */
  async compareHarnessArms(armA, armB, options = {}) {
    return comparePairedArms(armA, armB, options);
  }
  close() {
    return this.pool.end();
  }
}

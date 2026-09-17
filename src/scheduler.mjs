import pg from "pg";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { validatePlan, validateCapabilities } from "./validation.mjs";
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
    } = {},
  ) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
      throw Error("Invalid scheduler schema");
    validateCapabilities(capabilities);
    for (const value of [lease, deadline, capacity, maxAttempts]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw Error("Invalid scheduler limits");
    }
    if (deadline < lease) throw Error("Deadline must be at least the lease");
    this.schema = schema;
    this.lease = lease;
    this.deadline = deadline;
    this.capabilities = capabilities;
    this.capacity = capacity;
    this.maxAttempts = maxAttempts;
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
          "INSERT INTO agent_capabilities(name,description) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET description=excluded.description",
          [capability.name, capability.description],
        );
      }
      await db.query(
        "INSERT INTO agent_quota VALUES ('execution',$1) ON CONFLICT(name) DO UPDATE SET capacity=excluded.capacity",
        [this.capacity],
      );
    });
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
  // EN: Request ids bind the entire normalized DAG, not just the user-facing text.
  // 中文：请求编号绑定完整任务图，重试不得偷偷改变输入或依赖。
  async submit(requestId, plan) {
    const normalized = validatePlan(requestId, plan);
    return this.tx(async (db) => {
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
      const allowed = new Set(
        (await db.query("SELECT name FROM agent_capabilities")).rows.map(
          (x) => x.name,
        ),
      );
      if (normalized.tasks.some((t) => !allowed.has(t.capability)))
        throw Error("Unknown capability");
      await db.query(
        "INSERT INTO agent_requests(request_id,plan) VALUES($1,$2)",
        [requestId, json(normalized)],
      );
      const ids = new Map(normalized.tasks.map((t) => [t.id, randomUUID()]));
      for (const task of normalized.tasks) {
        const id = ids.get(task.id);
        await db.query(
          "INSERT INTO agent_tasks(task_id,capability,input,dependencies,request_id,max_attempts) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            task.capability,
            json(task.input),
            json(task.dependencies.map((d) => ids.get(d))),
            requestId,
            this.maxAttempts,
          ],
        );
        await this.event(db, "queued", id, {
          capability: task.capability,
          key: task.id,
        });
      }
      return { ids: [...ids.values()].sort() };
    });
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
    const blocked = (
      await db.query(
        "SELECT t.task_id FROM agent_tasks t WHERE t.status='queued' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.dependencies) dep LEFT JOIN agent_tasks d ON d.task_id=dep WHERE d.task_id IS NULL OR d.status IN ('failed','cancelled'))",
      )
    ).rows;
    for (const t of blocked) {
      await db.query(
        "UPDATE agent_tasks SET status='failed',last_error='dependency_failed',updated_at=now() WHERE task_id=$1",
        [t.task_id],
      );
      await this.event(db, "dependency_failed", t.task_id);
    }
  }
  async finishAttempt(db, a, error, result = null) {
    await db.query(
      "UPDATE agent_attempts SET status=$2,error=$3,result=$4,finished_at=now() WHERE call_id=$1",
      [
        a.call_id,
        error ? "failed" : "completed",
        error,
        result === null ? null : json(result),
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
      if (!error)
        await db.query(
          "INSERT INTO shared_facts(task_id,agent_id,version,value) VALUES($1,$2,$3,$4)",
          [t.task_id, a.agent_id, t.attempts, json(result)],
        );
      await this.event(db, error ? "attempt_failed" : "completed", t.task_id, {
        call_id: a.call_id,
        agent_id: a.agent_id,
        attempt_id: a.attempt_id,
        next: status,
        error,
      });
    }
    await db.query(
      "UPDATE agent_workers SET in_flight=GREATEST(0,in_flight-1) WHERE agent_id=$1",
      [a.agent_id],
    );
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
            "UPDATE agent_attempts SET lease_until=LEAST(deadline,now()+$2*interval '1 second') WHERE call_id=$1",
            [callId, this.lease],
          );
          valid = true;
        }
      }
      return { ok: true, valid, enabled: w.enabled };
    });
  }
  async claim(id, capability) {
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
      const running = (
        await db.query(
          "SELECT agent_id FROM agent_attempts WHERE status='running'",
        )
      ).rows;
      const capacity = (
        await db.query(
          "SELECT capacity FROM agent_quota WHERE name='execution'",
        )
      ).rows[0].capacity;
      if (running.length >= capacity || running.some((a) => a.agent_id === id))
        return { task: null };
      const t = (
        await db.query(
          "SELECT t.* FROM agent_tasks t WHERE status='queued' AND capability=$1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.dependencies) dep LEFT JOIN agent_tasks d ON d.task_id=dep WHERE d.status IS DISTINCT FROM 'completed') ORDER BY updated_at,task_id LIMIT 1 FOR UPDATE",
          [capability],
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
          "SELECT task_id,agent_id,version,value,verified FROM shared_facts WHERE task_id=ANY($1::text[])",
          [t.dependencies],
        )
      ).rows;
      await this.event(db, "dispatched", t.task_id, {
        call_id: call,
        agent_id: id,
        attempt_id: a.attempt_id,
      });
      return {
        task: {
          ...t,
          status: "running",
          agent_id: id,
          call_id: call,
          attempt_id: a.attempt_id,
          attempt: t.attempts + 1,
          facts,
          deadline: a.deadline,
        },
      };
    });
  }
  async result(id, capability, callId, result, error) {
    return this.tx(async (db) => {
      await this.reap(db);
      const a = (
        await db.query(
          "SELECT a.* FROM agent_attempts a JOIN agent_workers w USING(agent_id) WHERE call_id=$1 AND a.agent_id=$2 AND w.capability=$3",
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
        await this.finishAttempt(db, a, "cancelled");
        await this.event(db, "late_result_rejected", a.task_id, {
          call_id: callId,
        });
        return { accepted: false };
      }
      await this.finishAttempt(
        db,
        a,
        error ? "worker_execution_failed" : null,
        result,
      );
      return { accepted: true };
    });
  }
  async cancel(id) {
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
  async enable(id, enabled) {
    return this.tx(async (db) => {
      await db.query("UPDATE agent_workers SET enabled=$2 WHERE agent_id=$1", [
        id,
        enabled,
      ]);
      return { ok: true };
    });
  }
  async tick() {
    return this.tx((db) => this.reap(db));
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
      return {
        capabilities,
        tasks,
        agents,
        facts,
        events,
        attempts,
        quota,
        time: Date.now(),
      };
    }, true);
  }
  close() {
    return this.pool.end();
  }
}

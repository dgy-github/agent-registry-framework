import { validatePlan } from "./validation.mjs";

function parseField(field, min, max, isDow = false) {
  const allowed = new Set();
  for (const part of String(field).split(",")) {
    const [rangePart, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isSafeInteger(step) || step < 1 || step > max)
      throw Error(`Invalid cron step: ${part}`);
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [a, b] = rangePart.split("-").map(Number);
        if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b))
          throw Error(`Invalid cron range: ${part}`);
        start = isDow && a === 7 ? 0 : a;
        end = isDow && b === 7 ? 7 : b;
      } else {
        const v = Number(rangePart);
        if (!Number.isSafeInteger(v))
          throw Error(`Invalid cron value: ${part}`);
        const norm = isDow && v === 7 ? 0 : v;
        if (norm < min || norm > max)
          throw Error(`Cron value out of bounds: ${part}`);
        if (stepStr === undefined) {
          allowed.add(norm);
          continue;
        }
        start = norm;
      }
    }
    if (start < min || end > (isDow ? 7 : max) || start > end)
      throw Error(`Cron range out of bounds: ${part}`);
    for (let i = start; i <= end; i += step) {
      allowed.add(isDow && i === 7 ? 0 : i);
    }
  }
  if (!allowed.size) throw Error("Empty cron field");
  return allowed;
}

/** EN: Parse a standard 5-field cron expression (minute hour day-of-month month day-of-week).
 * 中文：解析标准 5 段式 Cron 表达式（分 时 日 月 周）。
 */
export function parseCron(expr) {
  if (typeof expr !== "string" || !expr.trim())
    throw Error("Invalid cron expression");
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    throw Error("Cron expression must have exactly 5 fields");
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dayOfWeek: parseField(fields[4], 0, 6, true),
    domWild: fields[2] === "*",
    dowWild: fields[4] === "*",
  };
}

/** EN: Compute the next execution timestamp strictly after `from` (UTC).
 * 中文：计算严格晚于 `from`（UTC）的下一次 Cron 触发时间。
 */
export function nextCronDate(expr, from = new Date()) {
  const parsed = parseCron(expr);
  const startMs =
    from instanceof Date ? from.getTime() : new Date(from).getTime();
  if (!Number.isFinite(startMs)) throw Error("Invalid base date");
  const cursor = new Date(Math.floor(startMs / 60_000) * 60_000 + 60_000);
  // Search up to 366 days ahead (527,040 minutes)
  for (let i = 0; i < 527_040; i++) {
    const m = cursor.getUTCMonth() + 1;
    if (!parsed.month.has(m)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const dom = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    const domMatch = parsed.dayOfMonth.has(dom);
    const dowMatch = parsed.dayOfWeek.has(dow);
    const dayOk =
      parsed.domWild && parsed.dowWild
        ? true
        : parsed.domWild
          ? dowMatch
          : parsed.dowWild
            ? domMatch
            : domMatch || dowMatch;
    if (!dayOk) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const h = cursor.getUTCHours();
    if (!parsed.hour.has(h)) {
      cursor.setUTCHours(h + 1, 0, 0, 0);
      continue;
    }
    const min = cursor.getUTCMinutes();
    if (!parsed.minute.has(min)) {
      cursor.setUTCMinutes(min + 1, 0, 0);
      continue;
    }
    return cursor;
  }
  throw Error("No matching cron execution time within 366 days");
}

/** EN: Validate a periodic/event trigger specification and its embedded DAG plan.
 * 中文：校验定时/事件触发器定义及其内嵌的 DAG 计划。
 */
export function validateTriggerSpec(triggerId, spec, now = new Date()) {
  if (typeof triggerId !== "string" || !/^[\w.:-]{4,100}$/.test(triggerId))
    throw Error("Invalid trigger_id");
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw Error("Invalid trigger specification");
  const description = spec.description ?? "";
  if (typeof description !== "string" || description.length > 400)
    throw Error("Invalid trigger description");
  const cron = spec.cron ?? null;
  if (cron !== null) parseCron(cron);
  const intervalSeconds = spec.interval_seconds ?? null;
  if (
    intervalSeconds !== null &&
    (!Number.isSafeInteger(intervalSeconds) ||
      intervalSeconds < 1 ||
      intervalSeconds > 31_536_000)
  )
    throw Error("Invalid trigger interval_seconds");
  const webhook = spec.webhook ?? false;
  if (typeof webhook !== "boolean") throw Error("Invalid trigger webhook flag");
  if (cron === null && intervalSeconds === null && !webhook)
    throw Error("Trigger requires cron, interval_seconds, or webhook=true");
  const enabled = spec.enabled ?? true;
  if (typeof enabled !== "boolean") throw Error("Invalid trigger enabled flag");
  const plan = validatePlan(`trig-${triggerId}`, spec.plan);
  let nextRunAt = null;
  if (enabled) {
    if (cron !== null) {
      nextRunAt = nextCronDate(cron, now);
    } else if (intervalSeconds !== null) {
      nextRunAt = new Date(now.getTime() + intervalSeconds * 1000);
    }
  }
  return {
    trigger_id: triggerId,
    description: description.trim(),
    cron_expr: cron,
    interval_seconds: intervalSeconds,
    webhook,
    plan,
    enabled,
    next_run_at: nextRunAt,
  };
}

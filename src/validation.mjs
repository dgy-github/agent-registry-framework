/** EN: Validate a trusted capability catalog. 中文：校验受信任的能力目录。 */
export function validateCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) throw Error('Capabilities must be an array');
  const seen = new Set();
  for (const capability of capabilities) {
    if (!capability || !/^[a-z][a-z0-9_.-]{0,63}$/.test(capability.name)
      || typeof capability.description !== 'string' || !capability.description.trim()
      || seen.has(capability.name)) throw Error('Invalid or duplicate capability');
    seen.add(capability.name);
  }
}

/** EN: Normalize and validate an acyclic request-local task graph before writes.
 * 中文：写入前规范化并校验请求内的有向无环任务图，拒绝悬空依赖。
 */
export function validatePlan(requestId, plan) {
  if (typeof requestId !== 'string' || !/^[\w-]{8,80}$/.test(requestId)) throw Error('Invalid request id');
  if (!Array.isArray(plan?.tasks) || !plan.tasks.length || plan.tasks.length > 100) throw Error('Expected 1 to 100 tasks');
  const tasks = plan.tasks.map(task => {
    if (!task || typeof task.id !== 'string' || !/^[\w-]{1,80}$/.test(task.id)
      || typeof task.capability !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(task.capability)) throw Error('Invalid task');
    const dependencies = task.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.some(d => typeof d !== 'string')
      || new Set(dependencies).size !== dependencies.length) throw Error('Invalid dependencies');
    const input = task.input ?? {};
    if (typeof input !== 'object' || Array.isArray(input)) throw Error('Task input must be an object');
    // EN: Round-trip once to detach caller state and enforce JSON transport.
    // 中文：通过 JSON 往返隔离调用方对象，确保与网络传输语义一致。
    const encoded = JSON.stringify(input);
    if (encoded.length > 100_000) throw Error('Task input too large');
    return {id: task.id, capability: task.capability, input: JSON.parse(encoded), dependencies: [...dependencies].sort()};
  }).sort((a,b) => a.id.localeCompare(b.id));
  const byId = new Map(tasks.map(t => [t.id,t]));
  if (byId.size !== tasks.length) throw Error('Duplicate task id');
  const done = new Set(), active = new Set();
  function visit(id) {
    if (!byId.has(id)) throw Error('Unknown dependency');
    if (active.has(id)) throw Error('Cyclic dependencies');
    if (done.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    active.delete(id); done.add(id);
  }
  for (const task of tasks) visit(task.id);
  return {tasks};
}

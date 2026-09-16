import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

/** EN: Pull worker with automatic registration, heartbeats and cooperative cancellation.
 * 中文：主动注册、拉取任务、续租与协作取消的 Worker；业务函数由调用方提供。
 * handler(task,{signal}) must honor cancellation and return a JSON value.
 * handler 必须响应 signal，并返回可序列化的 JSON 值；外部副作用须自行幂等。
 */
export class Worker {
  constructor({url,token,capability,handler,id=`worker-${randomUUID()}`,pollMs=1000,heartbeatMs=10000,requestTimeoutMs=5000}) {
    if (typeof handler !== 'function' || !token || !capability) throw Error('Worker requires handler, token and capability');
    for (const value of [pollMs,heartbeatMs,requestTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid worker timing');
    Object.assign(this,{url:url.replace(/\/$/,''),token,capability,handler,id,pollMs,heartbeatMs,requestTimeoutMs});
  }
  async api(action,data={}) {
    const response = await fetch(`${this.url}/internal/${action}`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.token}`},
      body:JSON.stringify({...data,agent_id:this.id,capability:this.capability}),
      signal:AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw Error(`Worker endpoint returned ${response.status}`);
    return response.json();
  }
  async execute(task,signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) controller.abort();
    const pulseStop = new AbortController();
    const deadline = setTimeout(abort,Math.max(1,Date.parse(task.deadline)-Date.now()));
    const pulse = (async () => {
      while (!pulseStop.signal.aborted) {
        try {
          await delay(this.heartbeatMs,undefined,{signal:pulseStop.signal});
          const heartbeat = await this.api('heartbeat',{call_id:task.call_id});
          if (!heartbeat.valid) { abort(); break; }
        } catch {
          if (!pulseStop.signal.aborted) abort();
          break;
        }
      }
    })();
    try {
      const result = await this.handler(task,{signal:controller.signal});
      if (result === undefined) throw Error('Handler must return JSON');
      await this.api('result',{call_id:task.call_id,result,error:controller.signal.aborted?'cancelled':null});
    } catch {
      // EN: No premature slot release while a handler is still running.
      // 中文：必须等业务函数停止后才确认结束，避免并发额度被提前释放。
      await this.api('result',{call_id:task.call_id,error:'handler_failed'}).catch(()=>{});
    } finally {
      pulseStop.abort();clearTimeout(deadline);
      signal?.removeEventListener('abort',abort);await pulse;
    }
  }
  /** EN: Run until aborted; transient transport failures trigger re-registration.
   * 中文：运行至 signal 取消；通信失败后重新注册，离线实例由租约回收。
   */
  async run({signal}={}) {
    let registered = false;
    while (!signal?.aborted) {
      try {
        if (!registered) { await this.api('register'); registered=true; }
        const {task} = await this.api('claim');
        if (task) { await this.execute(task,signal); continue; }
      } catch { registered=false; }
      await delay(this.pollMs,undefined,{signal}).catch(()=>{});
    }
  }
}

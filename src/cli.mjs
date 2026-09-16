import {readFile} from 'node:fs/promises';
import {Scheduler,createRegistryServer} from './index.mjs';

// EN: Read explicit local configuration only; no parent-directory credential discovery.
// 中文：只读取明确指定的配置，不扫描父目录或交接文档中的凭据。
const file = process.env.REGISTRY_CONFIG || 'registry.example.json';
const config = JSON.parse(await readFile(file,'utf8'));
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required');
const workerTokens = Object.fromEntries(config.capabilities.map(c=>[c.name,process.env[c.tokenEnv]]));
const scheduler = new Scheduler({connectionString:process.env.DATABASE_URL},config);
const server = createRegistryServer(scheduler,{operatorToken:process.env.REGISTRY_OPERATOR_TOKEN,workerTokens});
await scheduler.init();
server.listen(config.port ?? 8766,config.host ?? '127.0.0.1',()=>console.log('Agent registry listening'));
const tick = setInterval(()=>scheduler.tick().catch(()=>console.error('Scheduler maintenance failed')),1000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping=true;clearInterval(tick);
  await new Promise(resolve=>server.close(resolve));await scheduler.close();
}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);

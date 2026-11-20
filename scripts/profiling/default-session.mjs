// Headless native Default startup: catalog fixtures, no provider requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { parseArguments, profilingDirectory } from './harness.mjs';

const options = parseArguments(process.argv.slice(2), { label: 'after', checkout: process.cwd(), runs: 3 });
const checkout = path.resolve(options.checkout);
const output = profilingDirectory('default-session');
const root = fs.mkdtempSync(path.join(output, 'fixture-'));
const project = path.join(root, 'project');
fs.mkdirSync(project);
// Isolate the host's Settings owner without repurposing the shell's HOME.
const home = path.join(root, 'home');
fs.mkdirSync(home);
os.homedir = () => home;
syncBuiltinESMExports();
Object.assign(process.env, {
  STASHBASE_APP_ROOT: checkout,
  STASHBASE_LOCAL_DATA_ROOT: path.join(root, 'data'),
  STASHBASE_TELEMETRY_DISABLED: '1',
  XDG_DATA_HOME: path.join(root, 'xdg-data'),
  XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
});
const network = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === '/v1/agent/models') return Promise.resolve(Response.json({ models: [{
    id: 'stashbase-agent-default', version: 1, displayName: 'Fixture', isDefault: true,
    contextTokenLimit: 200000, outputTokenLimit: 16000,
  }] }));
  if (url.pathname === '/v2/agent/tools') return Promise.resolve(Response.json({
    schemaVersion: 2, revision: 'fixture', models: [], tools: [],
  }));
  if (url.hostname !== '127.0.0.1') throw new Error('This scenario must not make external requests.');
  return network(input, init);
};
const moduleAt = (file) => import(pathToFileURL(path.join(checkout, 'server', file)).href);
const { setHostedAccountSession } = await moduleAt('app-config.ts');
const { createOpenCodeSessionRuntime, stopOpenCodeRuntime } = await moduleAt('opencode-runtime.ts');
setHostedAccountSession({ userId: 'profile-fixture', email: 'fixture@example.invalid',
  accessToken: 'fixture', sessionToken: 'fixture', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim()
  + (execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).trim() ? '+dirty' : '');
async function connect() {
  const started = performance.now();
  const runtime = createOpenCodeSessionRuntime({ windowId: 'profile', directory: project,
    agentSessionId: randomUUID() });
  await runtime.models();
  const client = await runtime.client(project);
  if ((await client.mcp.status({ throwOnError: true })).data.stashbase?.status !== 'connected') {
    throw new Error('MCP was not ready.');
  }
  await client.session.create({ body: { title: 'Startup measurement' }, throwOnError: true });
  return { runtime, elapsed: Math.round(performance.now() - started) };
}
try {
  for (let run = 1; run <= options.runs; run++) {
    const cold = await connect();
    cold.runtime.endTurn();
    // A fixed idle interval represents the user reading the preceding answer.
    // It is excluded from startup latency, and does not claim immediate warm-up.
    await delay(5000);
    const next = await connect();
    const result = { scenario: 'default-session', label: options.label, run, revision,
      coldMs: cold.elapsed, nextChatMs: next.elapsed, idleIntervalMs: 5000 };
    fs.appendFileSync(path.join(output, 'results.jsonl'), JSON.stringify(result) + '\n');
    console.log(JSON.stringify(result));
    await cold.runtime.close();
    await next.runtime.close();
    await stopOpenCodeRuntime();
  }
} finally {
  await stopOpenCodeRuntime();
  fs.rmSync(root, { recursive: true, force: true });
}

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

/** Capture only the tail of Electron's own host log after a startup/crash
 * failure, including failures that happened before the host collector loaded. */
function readServerLogTail(filePath) {
  if (!filePath) return undefined;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 8000));
    const read = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.subarray(0, read).toString('utf8');
  } catch { return undefined; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* no impact on launch */ } }
}


function serverHealthMismatch(body, expected) {
  const wanted = { app: 'stashbase', ok: true, ...expected };
  for (const key of ['app', 'ok', 'protocolVersion', 'appRoot', 'resourcesPath', 'instanceId']) {
    if (key === 'instanceId' && expected.instanceId === undefined) continue;
    if (!body || typeof body !== 'object' || body[key] !== wanted[key]) return key;
  }
  return undefined;
}

function isCompatibleServerHealth(body, expected) {
  return serverHealthMismatch(body, expected) === undefined;
}

/** One bounded request; keep transport evidence instead of folding every
 * failure into unreachable. Never retain the health body in diagnostics. */
function requestJson(port, requestPath, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    let connected = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ...result, connected, durationMs: Math.round(performance.now() - started) });
    };
    const failed = (result) => finish({ reachable: false, statusCode: 0, body: null, result });
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, agent: false,
      method: options.method || 'GET', headers: options.headers }, (res) => {
      let body = '';
      let oversized = false;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        oversized ||= body.length + chunk.length > 4096;
        body = (body + chunk).slice(0, 4096);
      });
      res.on('error', () => failed('transport_error'));
      res.on('end', () => {
        try {
          const parsed = oversized ? null : JSON.parse(body);
          finish({ reachable: true, statusCode: res.statusCode ?? 0, body: parsed,
            result: oversized ? 'invalid_json' : 'response' });
        } catch {
          finish({ reachable: true, statusCode: res.statusCode ?? 0, body: null, result: 'invalid_json' });
        }
      });
    });
    const deadline = setTimeout(() => {
      failed(connected ? 'response_timeout' : 'connect_timeout');
      req.destroy();
    }, timeoutMs);
    req.on('socket', (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once('connect', () => { connected = true; });
    });
    req.on('error', (error) => failed(error.code === 'ECONNREFUSED' ? 'connection_refused' : 'transport_error'));
    req.end(options.body);
  });
}

async function probeServerHealth(port, timeoutMs, expected) {
  const health = await requestJson(port, '/api/health', timeoutMs);
  const evidence = { probe_duration_ms: health.durationMs };
  if (!health.reachable) return { compatible: false, occupied: health.connected,
    legacyStashBase: false, transient: health.connected,
    ...evidence, probe_result: health.result };
  evidence.probe_http_status = health.statusCode;
  const mismatch = serverHealthMismatch(health.body, expected);
  if (health.statusCode === 200 && health.result !== 'invalid_json' && !mismatch) {
    return { compatible: true, occupied: true, legacyStashBase: false, transient: false,
      ...evidence, probe_result: 'ready',
      ...(typeof health.body.instanceId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(health.body.instanceId)
        ? { instanceId: health.body.instanceId } : {}),
      ...(health.body.preparationStorage?.ok === false
        && ['PREPARATION_NATIVE_UNAVAILABLE', 'PREPARATION_STORAGE_UNAVAILABLE'].includes(health.body.preparationStorage.code)
        && typeof health.body.preparationStorage.message === 'string'
        && health.body.preparationStorage.message.length <= 1_000
        ? { preparationStorageWarning: health.body.preparationStorage.message } : {}) };
  }
  const result = health.statusCode !== 200 ? 'http_error'
    : health.result === 'invalid_json' ? 'invalid_json'
      : mismatch === 'ok' ? 'not_ready' : 'identity_mismatch';
  // Legacy detection only arbitrates an existing listener. After spawning we
  // check the new instance alone and keep its health probe as the evidence.
  const folder = expected.instanceId === undefined ? await requestJson(port, '/api/folder', timeoutMs) : null;
  const legacyStashBase = !!(folder?.statusCode === 200 && folder.body && typeof folder.body === 'object'
    && ('current' in folder.body || 'recent' in folder.body) && 'homeDir' in folder.body);
  return { compatible: false, occupied: true, legacyStashBase, transient: false,
    ...evidence, probe_result: result, ...(mismatch && ['identity_mismatch', 'not_ready'].includes(result)
      ? { probe_mismatch: mismatch } : {}) };
}

/** Build the environment for the Electron-owned server process. Source
 * launches need development runtime behavior even when they serve the built
 * renderer. `STASHBASE_DEV_VITE` is narrower: preserve it only when the caller
 * explicitly knows a Vite renderer is running. Packaged launches inherit
 * neither development mode. */
function createServerChildEnvironment({
  baseEnv,
  packaged,
  packagedEnv,
  shutdownToken,
  oauthReturnToken,
  externalFileToken,
  instanceId,
  authNetwork,
}) {
  const environment = {
    ...baseEnv,
    ...packagedEnv,
    STASHBASE_SHUTDOWN_TOKEN: shutdownToken,
    STASHBASE_OAUTH_RETURN_TOKEN: oauthReturnToken,
    STASHBASE_EXTERNAL_FILE_TOKEN: externalFileToken,
    STASHBASE_SERVER_INSTANCE_ID: instanceId,
  };
  delete environment.STASHBASE_AUTH_NETWORK_PORT;
  delete environment.STASHBASE_AUTH_NETWORK_TOKEN;
  if (authNetwork) {
    environment.STASHBASE_AUTH_NETWORK_PORT = String(authNetwork.port);
    environment.STASHBASE_AUTH_NETWORK_TOKEN = authNetwork.token;
  }
  if (packaged) {
    delete environment.STASHBASE_DEV_RUNTIME;
    delete environment.STASHBASE_DEV_VITE;
  } else {
    environment.STASHBASE_DEV_RUNTIME = '1';
  }
  return environment;
}

/** Resolve port ownership before launch, then wait for that launch alone.
 * A watch/shell wrapper may have a different PID from its listener, so the
 * health response carries a non-secret instance ID inherited by the server. */
async function startServer({
  packaged,
  port,
  probe,
  spawn,
  probeOptions,
  onReady = () => {},
  timeoutMs = serverStartupTimeoutMs({ packaged }),
  handoffTimeoutMs = 12_000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let existing = await waitForStableServerProbe(probe, probeOptions);
  if (existing.compatible && !packaged) { onReady(existing); return null; }
  if (packaged && existing.compatible) {
    // A replacement launch can begin while the prior Electron instance is
    // still waiting for its owned server to finish shutdown. Binding now
    // would fail with EADDRINUSE: the old server has a live parent and must
    // not be reclaimed as an orphan. Wait for the owner to release the port.
    const deadline = now() + handoffTimeoutMs;
    while (existing.occupied && now() < deadline) {
      await sleep(Math.min(150, Math.max(0, deadline - now())));
      existing = await probe();
    }
    if (existing.occupied) {
      throw new Error(
        `Port ${port} is still held by a previous StashBase instance. `
        + 'Quit that instance and reopen StashBase.',
      );
    }
  }
  if (existing.occupied && !existing.compatible && !existing.transient) {
    const what = existing.legacyStashBase ? 'an older StashBase server' : 'another local service';
    throw new Error(
      `Port ${port} is already in use by ${what}, so this StashBase build cannot start its server.\n`
      + `Quit the other StashBase/app using http://127.0.0.1:${port}, then reopen StashBase.`,
    );
  }
  // A persistently unresponsive listener may be a wedged orphan. Let the
  // child arbitrate EADDRINUSE: it alone verifies the entry path and missing
  // parent before reclaiming, and leaves live or foreign listeners alone.
  const instanceId = randomUUID();
  const child = spawn(instanceId);
  let spawnError = null;
  const onError = (error) => { spawnError = error; };
  child.on('error', onError);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let probeCount = 0;
  let lastProbe = {};
  try {
    while (now() < deadline) {
      const probeStartedAt = now();
      // Port arbitration needs a quick answer, but an owned child may be
      // contended while booting. Do not repeatedly abandon a healthy response
      // at the arbitration budget; keep every probe inside the startup deadline.
      const health = await probe(instanceId, Math.min(1000, Math.max(1, deadline - now())));
      probeCount += 1;
      lastProbe = {
        probe_duration_ms: health.probe_duration_ms ?? Math.max(0, now() - probeStartedAt),
        ...(health.probe_result ? { probe_result: health.probe_result } : {}),
        ...(health.probe_http_status ? { probe_http_status: health.probe_http_status } : {}),
        ...(health.probe_mismatch ? { probe_mismatch: health.probe_mismatch } : {}),
      };
      if (spawnError) throw new Error(`server spawn failed: ${spawnError.message}`);
      if (child.exitCode != null || child.signalCode != null) {
        const detail = child.exitCode != null
          ? `server exited with code ${child.exitCode}`
          : `server exited with signal ${child.signalCode}`;
        throw new Error(`${detail} before reporting healthy on :${port}`);
      }
      if (health.compatible) { onReady(health); return child; }
      await sleep(Math.min(150, Math.max(0, deadline - now())));
    }
    throw new Error(`server did not come up on :${port} within ${timeoutMs / 1000}s`);
  } catch (error) {
    throw Object.assign(error, { startupContext: {
      process_start_id: instanceId, elapsed_ms: Math.max(0, now() - startedAt),
      probe_count: probeCount, ...lastProbe,
    } });
  } finally {
    child.removeListener('error', onError);
  }
}

/** Keep the Electron-owned process single-layered unless the caller is an
 * explicit Vite development session. A watch wrapper can outlive or orphan
 * its actual listener during Electron shutdown, while a direct source launch
 * needs one child whose exit is the server lifecycle boundary. */
function createServerArguments({ entry, portArgs, packaged, vite }) {
  if (packaged) return [entry, ...portArgs];
  return vite ? ['watch', entry, ...portArgs] : [entry, ...portArgs];
}

/** Windows source launches run the `.cmd` shim from node_modules/.bin, which
 * only cmd.exe can execute. With `shell: true` Node joins the command and its
 * arguments with spaces and no quoting, so a checkout such as
 * `C:\My Projects\stashbase` would be split at the space. Quote every part;
 * Node wraps the whole line for `cmd.exe /s /c`, which keeps these quotes. */
function createServerSpawn({ command, args, platform = process.platform }) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args, shell: false };
  }
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  return { command: quote(command), args: args.map(quote), shell: true };
}

/** Source launches compile the TypeScript server on demand, so their first
 * process can legitimately take longer on a cold or contended machine than
 * the pre-bundled packaged entry. Keep packaged startup failure fast while
 * giving source launches a separate bounded readiness budget. */
function serverStartupTimeoutMs({ packaged }) {
  return packaged ? 10_000 : 30_000;
}

/** A listener that accepted the TCP connection but did not finish the health
 * response may be a StashBase server restarting or briefly contended. Do not
 * race a second server onto its port after one short health timeout. Re-probe
 * for a bounded interval; responsive incompatible services still fail fast. */
async function waitForStableServerProbe(probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryMs = options.retryMs ?? 150;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;

  let result = await probe();
  while (result?.transient === true && now() < deadline) {
    await sleep(Math.min(retryMs, deadline - now()));
    result = await probe();
  }
  return result;
}

/** The registration token a development server that Electron did not start
 * leaves for main (`server/external-files.ts`), or null. Only a source launch
 * reuses such a server, so a packaged app never reads it. */
function readDevelopmentExternalFileToken(homeDir = os.homedir()) {
  try {
    const token = fs.readFileSync(path.join(homeDir, '.stashbase', 'dev-external-file-token'), 'utf8').trim();
    return /^[0-9a-f]{64}$/u.test(token) ? token : null;
  } catch {
    return null;
  }
}

module.exports = {
  probeServerHealth,
  readDevelopmentExternalFileToken,
  requestJson,
  readServerLogTail,
  createServerArguments,
  createServerSpawn,
  createServerChildEnvironment,
  isCompatibleServerHealth,
  serverStartupTimeoutMs,
  startServer,
  waitForStableServerProbe,
};

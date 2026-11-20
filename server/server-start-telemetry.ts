import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAppConfigStrict, type AppConfigFile } from './app-config.ts';
import { writeFileAtomic } from './atomic-write.ts';
import { telemetryAvailable } from './telemetry-environment.ts';
import { initialUsageIdentity, clearServerStartTelemetry, serverStartTelemetryRoot } from './telemetry-bootstrap.ts';
import { accountUsageId, usageState, usageIdentitySchema, queuedUsageSchema, usagePayload, QUEUE_TTL, type QueuedUsage } from './telemetry-state.ts';
import { serverStartEventSchema, errorDiagnostic, boundedDiagnosticContext, type ServerStartEvent, type DiagnosticContext } from '../shared/protocols/http/telemetry.ts';
import { usageBatchUrl } from '../shared/hosted-auth-network.ts';
import destination from './telemetry-destination.json' with { type: 'json' };

/** Main owns only these pre-renderer events. Its separate spool and read-only
 * config access cannot race the host's durable queue. Network delivery must be
 * Electron's proxy-aware fetch, injected by main, never direct Node fetch. */
export function createServerStartTelemetry(options: {
  version: string; distribution: QueuedUsage['distribution']; fetch: typeof fetch;
  directory?: string; available?: boolean; read?: () => AppConfigFile;
  now?: () => number; monotonicNow?: () => number; timeoutMs?: number;
}) {
  const directory = options.directory ?? serverStartTelemetryRoot();
  const eventsDirectory = path.join(directory, 'events');
  const read = options.read ?? readAppConfigStrict;
  const now = options.now ?? Date.now;
  const clock = options.monotonicNow ?? (() => performance.now());
  const available = (options.available ?? telemetryAvailable()) && Boolean(usageBatchUrl(destination));
  const timeoutMs = options.timeoutMs ?? 1500;
  let sending: Promise<void> | undefined;
  let pending: AbortController | undefined;
  let admitted = false;
  const files = () => fs.existsSync(eventsDirectory)
    ? fs.readdirSync(eventsDirectory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)) : [];
  const consent = () => {
    if (!available) return false;
    // Host opt-out deletes this spool even when app-config persistence fails.
    // Once admitted, a removed spool retires this main-process collector too.
    if (admitted && !fs.existsSync(eventsDirectory)) { pending?.abort(); return false; }
    const enabled = usageState(read(), now()).enabled;
    if (!enabled) { pending?.abort(); clearServerStartTelemetry(directory); }
    return enabled;
  };
  const capture = (event: ServerStartEvent) => {
    try {
      if (!consent()) return;
      const config = read();
      const state = usageState(config, now());
      if (!state.enabled) return;
      const initial = config.telemetry === undefined ? initialUsageIdentity(directory, now()) : undefined;
      const identity = initial ?? usageIdentitySchema.safeParse(state).data;
      // An unsynchronized account transition belongs to the host. Never attach
      // a new attempt to the previous person's anonymous identity.
      if (!identity || (!initial && state.userId !== accountUsageId(config))) return;
      const parsed = serverStartEventSchema.parse(event);
      const queued: QueuedUsage = {
        ...identity, ...(accountUsageId(config) ? { userId: accountUsageId(config) } : {}),
        uuid: randomUUID(), timestamp: new Date(now()).toISOString(),
        version: options.version, distribution: options.distribution, os: process.platform, event: parsed,
      };
      fs.mkdirSync(eventsDirectory, { recursive: true, mode: 0o700 });
      // Expiry also runs without a network connection so old failures cannot
      // permanently fill the bounded spool.
      const existing = entries();
      if (existing.length >= (event.event === 'server_start_initiated' ? 25 : 50)) return;
      writeFileAtomic(path.join(eventsDirectory, `${queued.uuid}.json`), JSON.stringify(queued), { mode: 0o600 });
      admitted = true;
    } catch { /* Launch never depends on diagnostic storage. */ }
  };
  const entries = (): Array<{ file: string; entry: QueuedUsage }> => files().flatMap(name => {
    const file = path.join(eventsDirectory, name);
    try {
      if (fs.statSync(file).size > 100_000) throw new Error('Oversized startup event');
      const entry = queuedUsageSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      const age = now() - Date.parse(entry.timestamp);
      serverStartEventSchema.parse(entry.event);
      if (age >= QUEUE_TTL || age < -60_000 || `${entry.uuid}.json` !== name) throw new Error('Expired or invalid startup event');
      return [{ file, entry }];
    } catch { fs.rmSync(file, { force: true }); return []; }
  }).sort((a, b) => a.entry.timestamp.localeCompare(b.entry.timestamp));
  const flush = (): Promise<void> => {
    if (sending) return sending;
    const work = Promise.resolve().then(async () => {
      if (!consent()) return;
      const controller = new AbortController();
      pending = controller;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Settings can change in another live window while a replacement host
      // starts. Abort promptly on opt-out or an unreadable preference store.
      const privacy = setInterval(() => {
        try { if (!consent()) controller.abort(); } catch { controller.abort(); }
      }, 100);
      try {
        for (const { file, entry } of entries()) {
          if (controller.signal.aborted || !consent()) break;
          const event = serverStartEventSchema.parse(entry.event);
          if (event.event === 'server_start_failed') event.diagnostic = errorDiagnostic(event.diagnostic);
          if (event.context) event.context = boundedDiagnosticContext(event.context) as DiagnosticContext;
          const response = await options.fetch(usageBatchUrl(destination)!, {
            method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: destination.projectToken, historical_migration: false,
              batch: [usagePayload({ ...entry, event })] }),
          });
          await response.body?.cancel();
          if (!consent()) break;
          if (response.ok || (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)))
            fs.rmSync(file, { force: true });
          else break; // Keep the original UUID/time for a later launch.
        }
      } finally { clearTimeout(timer); clearInterval(privacy); pending = undefined; }
    }).catch(() => { /* Offline events retry on the next launch/terminal event. */ }).finally(() => {
      if (sending === work) sending = undefined;
    });
    sending = work;
    return work;
  };
  const settle = async () => { await sending; await flush(); };
  return {
    flush,
    /** The terminal event may have been captured during an earlier request.
     * Give it its own bounded drain before a startup-error dialog blocks main. */
    settle,
    begin(appSessionId: string) {
      const attemptId = randomUUID();
      const started = clock();
      let stage: ServerStartEvent['stage'] = 'network';
      let context: DiagnosticContext = {};
      let finished = false;
      const fields = () => ({ app_session_id: appSessionId, attempt_id: attemptId, stage,
        elapsed_ms: Math.max(0, Math.round(clock() - started)), context });
      capture({ event: 'server_start_initiated', ...fields() });
      void flush();
      return {
        stage(next: ServerStartEvent['stage'], details: DiagnosticContext = {}) {
          if (!finished) { stage = next; context = { ...context, ...details }; }
        },
        success(reused: boolean) {
          if (finished) return;
          finished = true; stage = 'ready';
          capture({ event: 'server_start_success', ...fields(), reused });
          void settle();
        },
        failed(error: unknown, details: DiagnosticContext = {}) {
          if (finished) return;
          finished = true; context = { ...context, ...details };
          capture({ event: 'server_start_failed', ...fields(), diagnostic: errorDiagnostic(error) });
        },
      };
    },
  };
}

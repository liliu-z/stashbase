/** One Node owner for identity, opt-out and durable delivery across windows.
 * Only allowlisted facts enter the queue; account credentials never do. */
import { randomUUID } from 'node:crypto';
import type { AppConfigFile } from './app-config.ts';
import { readAppConfigStrict, writeAppConfigStrict } from './app-config.ts';
import { telemetryEventSchema, type TelemetryEvent, type ErrorContext } from '../shared/protocols/http/telemetry.ts';
import { diagnosticOperation, errorDiagnostic } from './error-diagnostics.ts';
import { accountUsageId, usageState, usageIdentity, usagePayload, QUEUE_LIMIT,
  type QueuedUsage, type UsageIdentity, type TelemetryState } from './telemetry-state.ts';
import destination from './telemetry-destination.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };
export type { TelemetryState } from './telemetry-state.ts';

export function createTelemetry(options: {
  available: boolean;
  projectToken: string;
  host: string;
  version: string;
  os: string;
  read(): AppConfigFile;
  write(config: AppConfigFile): void;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const sendFetch = options.fetch ?? fetch;
  let opened = false;
  let stopped = false;
  let collectionStopped = false;
  let rateWindow = 0;
  let count = 0;
  let sending: Promise<void> | null = null;
  let pending: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  let generation = 0;
  const recentErrors = new Map<string, number>();
  const turns = new Map<string, { identity: UsageIdentity; startedAt: number; sessionId?: string }>();
  const allowed = () => options.available && !stopped && !collectionStopped;
  const preferences = () => ({ enabled: usageState(options.read(), now()).enabled, available: options.available });
  const save = (config: AppConfigFile, state: TelemetryState) => {
    config.telemetry = state;
    options.write(config);
  };
  const entry = (identity: UsageIdentity, event: QueuedUsage['event'], sessionId?: string): QueuedUsage => ({
    ...identity, uuid: randomUUID(), timestamp: new Date(now()).toISOString(),
    version: options.version, os: options.os, ...(sessionId ? { sessionId } : {}), event,
  });
  const cancel = () => {
    generation++;
    pending?.abort();
    pending = null;
    clearTimeout(retry);
    retry = undefined;
    recentErrors.clear();
    turns.clear();
  };
  const send = async (queued: QueuedUsage, controller: AbortController) => {
    const timeout = setTimeout(() => controller.abort(), 2000);
    timeout.unref();
    try {
      const payload = usagePayload(queued);
      // Re-redact disk diagnostics too, even if a queue file was modified.
      if ('diagnostic' in payload.properties && payload.properties.diagnostic) {
        payload.properties.diagnostic = errorDiagnostic(payload.properties.diagnostic);
      }
      if ('operation' in payload.properties) payload.properties.operation = diagnosticOperation(payload.properties.operation);
      const response = await sendFetch(`${options.host.replace(/\/$/, '')}/i/v0/e/`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: options.projectToken, ...payload }),
      });
      await response.body?.cancel();
      // Retrying a refused payload cannot repair it. Network failures, timeouts,
      // rate limits and service failures retain the same UUID and timestamp.
      return response.ok || (response.status >= 400 && response.status < 500
        && response.status !== 408 && response.status !== 429);
    } finally { clearTimeout(timeout); }
  };
  const schedule = () => {
    if (retry || !allowed()) return;
    retry = setTimeout(() => { retry = undefined; void flush(); }, retryDelay);
    retry.unref();
    retryDelay = Math.min(retryDelay * 2, 60_000);
  };
  const drain = async () => {
    const capturedGeneration = generation;
    while (allowed() && capturedGeneration === generation) {
      const config = options.read();
      const state = usageState(config, now());
      if (!state.enabled) return;
      const queued = state.queue?.[0];
      // Persist expiry/filtering even when there is nothing left to deliver.
      if (!queued) {
        if (config.telemetry?.queue?.length) save(config, state);
        return;
      }
      const controller = new AbortController();
      pending = controller;
      let delivered = false;
      try { delivered = await send(queued, controller); } catch { /* bounded retry below */ }
      if (capturedGeneration !== generation || !allowed()) return;
      pending = null;
      if (!delivered) { schedule(); return; }
      // Re-read after await: never overwrite captures, settings or account
      // changes made while this request was in flight.
      const latest = options.read();
      const current = usageState(latest, now());
      if (!current.enabled) return;
      current.queue = current.queue?.filter((item) => item.uuid !== queued.uuid);
      save(latest, current);
      retryDelay = 1000;
    }
  };
  const flush = (): Promise<void> => {
    if (!allowed()) return Promise.resolve();
    if (sending) return sending;
    // Defer transport so a synchronous opt-out cancels even a new capture.
    const capturedGeneration = generation;
    const work = Promise.resolve().then(drain).catch(() => { schedule(); }).finally(() => {
      if (sending !== work) return;
      sending = null;
      if (capturedGeneration !== generation && allowed()) kick();
    });
    sending = work;
    return work;
  };
  const kick = () => { if (!retry) void flush(); };

  const synchronize = (config: AppConfigFile, state: TelemetryState): UsageIdentity => {
    usageIdentity(state, now());
    const userId = accountUsageId(config);
    if (state.userId !== userId) {
      if (state.userId) state.anonymousId = randomUUID();
      state.userId = userId;
      delete state.sessionId;
      delete state.lastActiveAt;
      delete state.markers;
      delete state.subscription;
      if (userId) (state.queue ??= []).push(entry(usageIdentity(state, now()), { event: '$identify' }));
    }
    return usageIdentity(state, now());
  };
  const capture = (input: TelemetryEvent, captured?: UsageIdentity, capturedGeneration = generation) => {
    if (!allowed() || capturedGeneration !== generation) return;
    try {
      const parsed = telemetryEventSchema.safeParse(input);
      if (!parsed.success) return;
      const config = options.read();
      const state = usageState(config, now());
      if (!state.enabled) return;
      const turn = parsed.data.event === 'agent_turn_finished' && parsed.data.turn_id ? turns.get(parsed.data.turn_id) : undefined;
      if (parsed.data.event === 'agent_turn_finished' && parsed.data.turn_id) {
        if (!turn || now() - turn.startedAt > 86400_000) return;
        captured = turn.identity;
      }
      // Reserve room for a link and its event; never evict an identity link
      // while accepting later events that depend on it.
      if ((state.queue?.length ?? 0) > QUEUE_LIMIT - 2) { kick(); return; }
      const identity = synchronize(config, state);
      if (captured && captured.installationId !== identity.installationId) return;
      const event = parsed.data;
      if ('diagnostic' in event && event.diagnostic) event.diagnostic = errorDiagnostic(event.diagnostic);
      if (event.event === 'application_error') {
        event.operation = diagnosticOperation(event.operation);
        const key = JSON.stringify(event);
        const last = recentErrors.get(key);
        if (last !== undefined && now() - last < 60_000) return;
        if (recentErrors.size >= 100) recentErrors.delete(recentErrors.keys().next().value!);
        recentErrors.set(key, now());
      }
      if (event.event === 'app_opened' && opened) return;
      const minute = Math.floor(now() / 60000);
      if (minute !== rateWindow) { rateWindow = minute; count = 0; }
      if (count >= 120) return;
      const active = event.event === 'app_active' || event.event === 'document_engaged' || event.event === 'agent_turn_started';
      const currentIdentity = !captured || (captured.anonymousId === identity.anonymousId && captured.userId === identity.userId);
      if (active && currentIdentity) {
        if (!state.sessionId || !state.lastActiveAt || now() - state.lastActiveAt >= 30 * 60_000 || now() < state.lastActiveAt) {
          state.sessionId = randomUUID();
        }
        state.lastActiveAt = now();
      }
      const marker = event.event === 'app_active' ? `app_active:${event.mode}`
        : event.event === 'document_engaged' ? `document_engaged:${event.activity}:${event.format}` : null;
      if (marker && state.markers?.[marker] !== undefined && Math.floor(state.markers[marker] / 60_000) === minute) return;
      if (marker) state.markers = { ...state.markers, [marker]: now() };
      if (event.event === 'subscription_observed') {
        const status = `${event.plan}:${event.paid}:${event.cancel_at_period_end}`;
        if (!currentIdentity || state.subscription === status) return;
        state.subscription = status;
      }
      (state.queue ??= []).push(entry(captured ?? identity, event, turn?.sessionId ?? (currentIdentity ? state.sessionId : undefined)));
      save(config, state);
      if (event.event === 'agent_turn_started' && event.turn_id) {
        if (turns.size >= 100) turns.delete(turns.keys().next().value!);
        turns.set(event.turn_id, { identity, startedAt: now(), sessionId: state.sessionId });
      }
      if (event.event === 'agent_turn_finished' && event.turn_id) turns.delete(event.turn_id);
      if (event.event === 'app_opened') opened = true;
      count++;
      kick();
    } catch { /* Unavailable persistence fails closed without affecting work. */ }
  };
  return {
    preferences,
    capture(input: TelemetryEvent) { capture(input); },
    /** Capture before asynchronous host work to keep its terminal outcome on
     * the initiating account even if another window signs out or switches. */
    scoped() {
      const capturedGeneration = generation;
      try {
        if (!allowed()) return (_event: TelemetryEvent) => {};
        const config = options.read();
        const state = usageState(config, now());
        if (!state.enabled || (state.queue?.length ?? 0) >= QUEUE_LIMIT) return (_event: TelemetryEvent) => {};
        const identity = synchronize(config, state);
        save(config, state);
        kick();
        return (event: TelemetryEvent) => capture(event, identity, capturedGeneration);
      } catch { return (_event: TelemetryEvent) => {}; }
    },
    identityChanged() {
      // Persist even a sign-out with no subsequent events, so its anonymous
      // successor can never be linked to the previous account after restart.
      try {
        if (!allowed()) return;
        const config = options.read();
        const state = usageState(config, now());
        if (!state.enabled || (state.queue?.length ?? 0) >= QUEUE_LIMIT) return;
        synchronize(config, state);
        save(config, state);
        kick();
      } catch { /* Authentication never depends on analytics. */ }
    },
    captureError(error: unknown, context: ErrorContext) {
      try { capture({ event: 'application_error', ...context, diagnostic: errorDiagnostic(error) }); }
      catch { /* Never replace the original failure. */ }
    },
    update(next: { enabled: boolean }) {
      if (!next.enabled) { collectionStopped = true; cancel(); }
      const config = options.read();
      const state = usageState(config, now());
      // Disabling erases the queue and all local analytics identity. No final
      // network request is made after the switch is turned off.
      save(config, next.enabled ? { ...state, enabled: true } : { enabled: false });
      collectionStopped = !next.enabled;
      if (next.enabled) { opened = false; retryDelay = 1000; kick(); }
      return preferences();
    },
    flush,
    close() { stopped = true; cancel(); },
  };
}

export const telemetry = createTelemetry({
  available: process.env.STASHBASE_TELEMETRY_DISABLED !== '1'
    && process.env.STASHBASE_PACKAGED === '1'
    && destination.projectToken.startsWith('phc_') && destination.host.startsWith('https://'),
  projectToken: destination.projectToken, host: destination.host,
  version: packageInfo.version, os: process.platform,
  read: readAppConfigStrict, write: writeAppConfigStrict,
});

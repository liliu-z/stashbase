/** One process owns collection. Direct Capture API calls avoid SDK automatic
 * metadata, remote configuration, recordings, profiles, and durable queues.
 * The project token is public ingestion configuration, never a personal API key. */
import { randomUUID } from 'node:crypto';
import type { AppConfigFile } from './app-config.ts';
import { readAppConfigStrict, writeAppConfigStrict } from './app-config.ts';
import { telemetryEventSchema, type TelemetryEvent, type ErrorContext } from '../shared/protocols/http/telemetry.ts';
import { diagnosticOperation, errorDiagnostic } from './error-diagnostics.ts';
import destination from './telemetry-destination.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };

export interface TelemetryState {
  enabled: boolean;
  installationId?: string;
  /** Only bounded daily suppression markers, never document identities. */
  writeDay?: string;
  writeOutcomes?: string[];
}

function stateOf(config: AppConfigFile): TelemetryState {
  const raw = config.telemetry;
  if (raw === undefined) return { enabled: true };
  // Malformed preferences must never silently re-enable collection.
  return {
    enabled: raw?.enabled === true,
    ...(typeof raw?.installationId === 'string' && /^[0-9a-f-]{36}$/.test(raw.installationId)
      ? { installationId: raw.installationId } : {}),
    ...(typeof raw?.writeDay === 'string' ? { writeDay: raw.writeDay } : {}),
    ...(Array.isArray(raw?.writeOutcomes) ? { writeOutcomes: raw.writeOutcomes.filter((value) => ['success', 'failed', 'conflict'].includes(value)) } : {}),
  };
}

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
  const pending = new Set<AbortController>();
  let opened = false;
  let stopped = false;
  let collectionStopped = false;
  let rateWindow = 0;
  let count = 0;
  const recentErrors = new Map<string, number>();

  const preferences = () => {
    const state = stateOf(options.read());
    return { enabled: state.enabled, available: options.available };
  };
  const cancel = () => {
    for (const controller of pending) controller.abort();
    pending.clear();
    recentErrors.clear();
  };
  const send = (id: string, event: string, properties: Record<string, unknown>) => {
    const controller = new AbortController();
    pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), 2000);
    timeout.unref();
    // No retries, no redirect forwarding, no durable queue, no raw failure log.
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      const response = await sendFetch(`${options.host.replace(/\/$/, '')}/i/v0/e/`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: options.projectToken, distinct_id: id, event,
          timestamp: new Date(now()).toISOString(),
          properties: { ...properties, app_version: options.version, os: options.os,
            schema_version: 2, $process_person_profile: false, $geoip_disable: true, $ip: null },
        }),
      });
      await response.body?.cancel();
    }).catch(() => {}).finally(() => { clearTimeout(timeout); pending.delete(controller); });
  };
  const capture = (input: TelemetryEvent) => {
    if (!options.available || stopped || collectionStopped) return;
    try {
      const parsed = telemetryEventSchema.safeParse(input);
      if (!parsed.success) return;
      const config = options.read();
      const state = stateOf(config);
      if (!state.enabled) return;
      const event = parsed.data;
      if ('diagnostic' in event && event.diagnostic) event.diagnostic = errorDiagnostic(event.diagnostic);
      if (event.event === 'application_error') {
        // Callers name a source operation, never a URL, folder, or session id.
        event.operation = diagnosticOperation(event.operation);
        const key = JSON.stringify(event);
        const last = recentErrors.get(key);
        if (last !== undefined && now() - last < 60_000) return;
        if (recentErrors.size >= 100) recentErrors.delete(recentErrors.keys().next().value!);
        recentErrors.set(key, now());
      }
      if (event.event === 'app_opened' && opened) return;
      // At most 120 events/minute, at most 8 concurrent outbound requests.
      const minute = Math.floor(now() / 60000);
      if (minute !== rateWindow) { rateWindow = minute; count = 0; }
      if (count >= 120 || pending.size >= 8) return;
      let dirty = false;
      if (!state.installationId) { state.installationId = randomUUID(); dirty = true; }
      if (event.event === 'document_write_result') {
        const day = new Date(now()).toISOString().slice(0, 10);
        const outcomes = state.writeDay === day ? state.writeOutcomes ?? [] : [];
        if (outcomes.includes(event.outcome)) return;
        state.writeDay = day;
        state.writeOutcomes = [...outcomes, event.outcome];
        dirty = true;
      }
      if (dirty) { config.telemetry = state; options.write(config); }
      if (event.event === 'app_opened') opened = true;
      count += 1;
      const { event: name, ...properties } = event;
      send(state.installationId, name, properties);
    } catch { /* Config unavailable: fail closed without affecting the operation. */ }
  };
  return {
    preferences,
    capture,
    captureError(error: unknown, context: ErrorContext) {
      try { capture({ event: 'application_error', ...context, diagnostic: errorDiagnostic(error) }); }
      catch { /* Diagnostic collection must never replace the original failure. */ }
    },
    update(next: { enabled: boolean }) {
      // Even a persistence failure stops this process; the UI reports that the
      // choice could not be saved and must not claim it survives relaunch.
      if (next.enabled === false) { collectionStopped = true; cancel(); }
      const config = options.read();
      const previous = stateOf(config);
      const state = { ...previous, ...next };
      if (!state.enabled) {
        delete state.installationId;
        delete state.writeDay;
        delete state.writeOutcomes;
      }
      config.telemetry = state;
      options.write(config);
      collectionStopped = !state.enabled;
      if (previous.enabled && !state.enabled && previous.installationId && options.available && !stopped) {
        send(previous.installationId, 'telemetry_disabled', {});
      }
      return { enabled: state.enabled, available: options.available };
    },
    close() { stopped = true; cancel(); },
  };
}

export const telemetry = createTelemetry({
  // Packaged UI checks must be able to suppress collection before the first
  // event, independently of the user's persisted preference. Electron passes
  // this launch-only override to its server; Settings cannot re-enable it.
  available: process.env.STASHBASE_TELEMETRY_DISABLED !== '1'
    && process.env.STASHBASE_PACKAGED === '1'
    && destination.projectToken.startsWith('phc_') && destination.host.startsWith('https://'),
  projectToken: destination.projectToken, host: destination.host,
  version: packageInfo.version, os: process.platform,
  read: readAppConfigStrict, write: writeAppConfigStrict,
});

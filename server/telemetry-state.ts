import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { telemetryEventSchema, agentTurnStageSchema, diagnosticContextSchema, agentToolSummarySchema, AGENT_TOOL_RESULT_LIMIT } from '../shared/protocols/http/telemetry.ts';
import type { AppConfigFile } from './app-config.ts';
import { countDelivery, hostDeliverySchema, rendererDeliverySchema, type HostDelivery } from '../shared/protocols/telemetry-delivery.ts';

export const QUEUE_LIMIT = 500;
/** Gaps of one to three weeks between uses are normal; undelivered events
 * wait for a later launch instead of expiring before the person returns. */
export const QUEUE_TTL = 30 * 86400_000;
export const usageDistributionSchema = z.enum(['source', 'packaged']);
const id = z.string().uuid();
const userId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestamp = z.string().datetime();
const identitySchema = z.object({
  installationId: id,
  anonymousId: id,
  userId: userId.optional(),
  firstSeenAt: timestamp,
});
export type UsageIdentity = z.infer<typeof identitySchema>;
const queuedSchema = identitySchema.extend({
  uuid: id,
  timestamp,
  version: z.string().max(80),
  distribution: usageDistributionSchema,
  os: z.string().max(20),
  sessionId: id.optional(),
  delivery: hostDeliverySchema.optional(),
  rendererDelivery: rendererDeliverySchema.optional(),
  event: z.union([telemetryEventSchema, z.object({ event: z.literal('$identify') }).strict()]),
}).strict();
export type QueuedUsage = z.infer<typeof queuedSchema>;

const turnSchema = identitySchema.extend({
  turnId: id, runtime: z.enum(['stashbase', 'claude', 'codex', 'antigravity']),
  version: z.string().max(80), os: z.string().max(20), sessionId: id.optional(),
  distribution: usageDistributionSchema,
  startedAt: timestamp, observedAt: timestamp, stage: agentTurnStageSchema,
  sequence: z.number().int().nonnegative(),
  context: diagnosticContextSchema.optional(),
  toolSummary: agentToolSummarySchema.optional(),
  toolCallIds: z.array(z.string().min(1).max(512)).max(AGENT_TOOL_RESULT_LIMIT).optional(),
}).strict();
export type PendingTurn = z.infer<typeof turnSchema>;
export const TURN_LIMIT = 100;
export const turnCapacity = (state: TelemetryState) => (state.queue?.length ?? 0) + (state.turns?.length ?? 0);

export interface TelemetryState {
  enabled: boolean;
  installationId?: string;
  anonymousId?: string;
  userId?: string;
  firstSeenAt?: string;
  sessionId?: string;
  lastActiveAt?: number;
  /** These are bounded event categories, never source or project identities. */
  markers?: Record<string, number>;
  subscription?: string;
  queue?: QueuedUsage[];
  /** Every admitted turn reserves one slot in the same bounded delivery queue. */
  turns?: PendingTurn[];
  finishedTurns?: Record<string, number>;
  delivery?: HostDelivery;
}

export function noteDelivery(state: TelemetryState, key: keyof HostDelivery['counters'], now: number, amount = 1): void {
  if (!amount) return;
  state.delivery ??= { series_id: randomUUID(), started_at: new Date(now).toISOString(), counters: {} };
  countDelivery(state.delivery, key, amount);
}

/** Validate the disk queue just like incoming events. Only current, bounded
 * envelopes survive; old formats and arbitrary properties cannot be uploaded. */
export function usageState(config: AppConfigFile, now: number): TelemetryState {
  const raw = config.telemetry;
  if (raw === undefined) return { enabled: true };
  if (raw?.enabled !== true) return { enabled: false };
  const identity = identitySchema.safeParse(raw);
  const delivery = hostDeliverySchema.safeParse(raw.delivery);
  const queue: QueuedUsage[] = [];
  let expired = 0;
  let invalid = 0;
  for (const item of Array.isArray(raw.queue) ? raw.queue : []) {
    const parsed = queuedSchema.safeParse(item);
    if (!parsed.success || Date.parse(parsed.data.timestamp) > now + 60_000 || queue.length >= QUEUE_LIMIT) invalid++;
    else if (Date.parse(parsed.data.timestamp) <= now - QUEUE_TTL) expired++;
    else queue.push(parsed.data);
  }
  const health: TelemetryState = { enabled: true, ...(delivery.success ? { delivery: delivery.data } : {}) };
  noteDelivery(health, 'expired', now, expired);
  noteDelivery(health, 'invalid_queued', now, invalid);
  return {
    enabled: true,
    ...(health.delivery ? { delivery: health.delivery } : {}),
    ...(identity.success ? identity.data : {}),
    ...(id.safeParse(raw.sessionId).success ? { sessionId: raw.sessionId } : {}),
    ...(Number.isFinite(raw.lastActiveAt) ? { lastActiveAt: raw.lastActiveAt } : {}),
    ...(typeof raw.subscription === 'string' && /^(free|plus|pro|other):(true|false):(true|false)$/.test(raw.subscription)
      ? { subscription: raw.subscription } : {}),
    markers: Object.fromEntries(Object.entries(raw.markers ?? {}).filter(([key, time]) =>
      /^(app_active:(welcome|documents|chat)|document_engaged:(read|edit):(md|txt|json|csv|html|pdf|docx|image|audio|generic))$/.test(key)
      && Number.isFinite(time) && time > now - 60_000 && time <= now)),
    turns: (Array.isArray(raw.turns) ? raw.turns.slice(0, TURN_LIMIT) : []).flatMap((entry) => {
      const parsed = turnSchema.safeParse(entry);
      return parsed.success && parsed.data.installationId === raw.installationId
        && Date.parse(parsed.data.startedAt) > now - QUEUE_TTL ? [parsed.data] : [];
    }),
    finishedTurns: Object.fromEntries(Object.entries(raw.finishedTurns ?? {}).filter(([key, time]) =>
      id.safeParse(key).success && Number.isFinite(time) && time > now - QUEUE_TTL).slice(-QUEUE_LIMIT)),
    queue,
  };
}

export function accountUsageId(config: AppConfigFile): string | undefined {
  const result = userId.safeParse(config.account?.session?.userId);
  return result.success ? result.data : undefined;
}

export function usageIdentity(state: TelemetryState, now: number): UsageIdentity {
  state.installationId ??= randomUUID();
  state.anonymousId ??= randomUUID();
  state.firstSeenAt ??= new Date(now).toISOString();
  return { installationId: state.installationId, anonymousId: state.anonymousId,
    firstSeenAt: state.firstSeenAt, ...(state.userId ? { userId: state.userId } : {}) };
}

export function usagePayload(entry: QueuedUsage) {
  const { event, ...properties } = entry.event;
  return {
    uuid: entry.uuid,
    distinct_id: entry.userId ? `user:${entry.userId}` : entry.anonymousId,
    event,
    timestamp: entry.timestamp,
    properties: {
      ...properties,
      installation_id: entry.installationId,
      anonymous_id: entry.anonymousId,
      ...(entry.userId ? { user_id: entry.userId } : {}),
      installation_first_seen_at: entry.firstSeenAt,
      ...(entry.sessionId ? { $session_id: entry.sessionId } : {}),
      ...(event === '$identify' ? { $anon_distinct_id: entry.anonymousId } : {}),
      ...(entry.delivery ? { delivery: entry.delivery } : {}),
      ...(entry.rendererDelivery ? { renderer_delivery: entry.rendererDelivery } : {}),
      app_version: entry.version, app_distribution: entry.distribution, os: entry.os, schema_version: 9,
      $process_person_profile: Boolean(entry.userId), $geoip_disable: true, $ip: null,
    },
  };
}

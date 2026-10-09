import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { telemetryEventSchema } from '../shared/protocols/http/telemetry.ts';
import type { AppConfigFile } from './app-config.ts';

export const QUEUE_LIMIT = 500;
export const QUEUE_TTL = 7 * 86400_000;
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
  os: z.string().max(20),
  sessionId: id.optional(),
  event: z.union([telemetryEventSchema, z.object({ event: z.literal('$identify') }).strict()]),
}).strict();
export type QueuedUsage = z.infer<typeof queuedSchema>;

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
}

/** Validate the disk queue just like incoming events. Only current, bounded
 * envelopes survive; old formats and arbitrary properties cannot be uploaded. */
export function usageState(config: AppConfigFile, now: number): TelemetryState {
  const raw = config.telemetry;
  if (raw === undefined) return { enabled: true };
  if (raw?.enabled !== true) return { enabled: false };
  const identity = identitySchema.safeParse(raw);
  return {
    enabled: true,
    ...(identity.success ? identity.data : {}),
    ...(id.safeParse(raw.sessionId).success ? { sessionId: raw.sessionId } : {}),
    ...(Number.isFinite(raw.lastActiveAt) ? { lastActiveAt: raw.lastActiveAt } : {}),
    ...(typeof raw.subscription === 'string' && /^(free|plus|pro|other):(true|false):(true|false)$/.test(raw.subscription)
      ? { subscription: raw.subscription } : {}),
    markers: Object.fromEntries(Object.entries(raw.markers ?? {}).filter(([key, time]) =>
      /^(app_active:(welcome|documents|chat)|document_engaged:(read|edit):(md|txt|json|html|pdf|docx|image|audio|generic))$/.test(key)
      && Number.isFinite(time) && time > now - 60_000 && time <= now)),
    queue: (Array.isArray(raw.queue) ? raw.queue.slice(0, QUEUE_LIMIT) : []).flatMap((entry) => {
      const parsed = queuedSchema.safeParse(entry);
      return parsed.success && Date.parse(parsed.data.timestamp) > now - QUEUE_TTL
        && Date.parse(parsed.data.timestamp) <= now + 60_000 ? [parsed.data] : [];
    }),
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
      app_version: entry.version, os: entry.os, schema_version: 3,
      $process_person_profile: Boolean(entry.userId), $geoip_disable: true, $ip: null,
    },
  };
}

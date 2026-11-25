import { z } from 'zod';

export const UPDATES_CAPABILITY = 'updates.desktop';

export const UPDATES_SNAPSHOT_CHANNEL = 'updates:snapshot';
export const UPDATES_READ_CHANNEL = 'updates:read';
export const UPDATES_CHECK_CHANNEL = 'updates:check';
export const UPDATES_PRIMARY_ACTION_CHANNEL = 'updates:primary-action';
export const UPDATES_OPEN_RELEASE_PAGE_CHANNEL = 'updates:open-release-page';
export const UPDATES_SET_AUTO_CHECK_CHANNEL = 'updates:set-auto-check';
export const UPDATES_SET_SIMULATION_CHANNEL = 'updates:set-simulation';

/** Every phase the main-process update machine can reach. Main's own state
 *  carries more than a window may see, so the projection into the snapshot
 *  below is exhaustive over exactly this list. */
export const UPDATE_PHASES = [
  'unsupported',
  'store',
  'idle',
  'checking',
  'current',
  'available',
  'downloading',
  'ready',
  'installing',
  'error',
] as const;

const version = z.string().trim().min(1).max(64);

/** True of every phase: which build this is, and whether it looks on its own. */
const state = {
  autoCheckEnabled: z.boolean(),
  currentVersion: version,
};

/**
 * What one window is told about updates, as a union on the phase rather than
 * one object with optional fields, so a version exists only where there is a
 * version and a percentage only while bytes are moving.
 *
 * The installer's own diagnostic sentence is deliberately absent: no reader
 * should ever see it, and a field that exists is a field something renders.
 */
export const updatesSnapshotSchema = z.discriminatedUnion('phase', [
  z.object({ ...state, phase: z.literal('unsupported') }).strict(),
  z.object({ ...state, phase: z.literal('store') }).strict(),
  z.object({ ...state, phase: z.literal('idle') }).strict(),
  z.object({ ...state, phase: z.literal('checking') }).strict(),
  z.object({ ...state, phase: z.literal('current') }).strict(),
  z.object({ ...state, availableVersion: version, phase: z.literal('available') }).strict(),
  z
    .object({
      ...state,
      availableVersion: version,
      percent: z.number().int().min(0).max(100).optional(),
      phase: z.literal('downloading'),
    })
    .strict(),
  z.object({ ...state, availableVersion: version, checkFailed: z.literal(true).optional(), phase: z.literal('ready') }).strict(),
  z.object({ ...state, availableVersion: version, phase: z.literal('installing') }).strict(),
  z.object({ ...state, phase: z.literal('error') }).strict(),
]);

/** `unauthorized` is this window not being allowed to manage updates at all;
 *  `invalid-request` is a malformed payload; `failed` is main not answering. */
const UPDATE_FAILURE_KINDS = ['unauthorized', 'invalid-request', 'failed'] as const;

const updatesFailureSchema = z
  .object({ kind: z.enum(UPDATE_FAILURE_KINDS) })
  .strict();

/** Every invocation answers the same way: the snapshot main now stands
 *  behind, or the reason it would not act. */
export const updatesResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: updatesSnapshotSchema }).strict(),
  z.object({ failure: updatesFailureSchema, ok: z.literal(false) }).strict(),
]);

export const updatesSetAutoCheckRequestSchema = z.object({ enabled: z.boolean() }).strict();

/** Development-only. The value walks the surface through phases a packaged
 *  build reaches only against a real release. */
const UPDATE_SIMULATION_VALUES = [
  'off',
  'available',
  'downloading',
  'ready',
  'installing',
  'error',
] as const;

export const updatesSetSimulationRequestSchema = z
  .object({ value: z.enum(UPDATE_SIMULATION_VALUES) })
  .strict();

export type UpdatesSnapshot = z.infer<typeof updatesSnapshotSchema>;
export type UpdatesResult = z.infer<typeof updatesResultSchema>;
type UpdatesFailure = z.infer<typeof updatesFailureSchema>;
export type UpdateFailureKind = UpdatesFailure['kind'];
export type UpdateSimulationValue = (typeof UPDATE_SIMULATION_VALUES)[number];

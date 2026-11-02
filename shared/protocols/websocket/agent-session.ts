import { z } from "zod";
import { agentCrewCallSchema } from '../http/agent-tools';

import { agentIdSchema } from "../http/agent-runtime";

// A clean server retirement is distinct from a transport that merely closes.
export const AGENT_SESSION_CLOSE = { code: 1000, reason: 'session_disposed' } as const;

const boundedText = (maximum: number) => z.string().max(maximum);
const recordSchema = z.record(z.string(), z.unknown());

const agentAccessModeSchema = z.enum(["default", "acceptEdits", "plan", "auto"]);

const agentTurnFailureKindSchema = z.enum([
  "rate-limit",
  "quota",
  "allowance-exhausted",
  "access-restricted",
  "auth-expired",
  "network",
  "runtime-outdated",
  "app-outdated",
  "model-changed",
]);

const agentTurnFailureSchema = z.object({ kind: agentTurnFailureKindSchema }).strict();

import { agentModelSchema } from '../agent-model';

export { agentModelSchema };

const agentSkillSchema = z
  .object({
    id: boundedText(200),
    label: boundedText(500),
    description: boundedText(2_000).optional(),
    argumentHint: boundedText(1_000).optional(),
  })
  .strict();

export const agentClientEventSchema = z.discriminatedUnion("t", [
  z
    .object({
      t: z.literal("prompt"),
      telemetryTurnId: z.string().uuid().optional(),
      text: boundedText(1_048_576),
      attachments: z.array(boundedText(16_384)).max(50).optional(),
      titleHint: boundedText(2_000).optional(),
      skill: boundedText(200).optional(),
    })
    .strict(),
  z.object({ t: z.literal("refresh-skills") }).strict(),
  z.object({ t: z.literal("steer"), id: boundedText(512), text: boundedText(1_048_576) }).strict(),
  z
    .object({
      t: z.literal("permission-reply"),
      id: boundedText(512),
      allow: z.boolean(),
      always: z.boolean().optional(),
      scope: z.enum(["session", "always"]).optional(),
      // Replies to an Agent's clarifying questions, keyed by question text.
      answers: z.record(boundedText(4_000), boundedText(16_384)).optional(),
    })
    .strict(),
  z.object({ t: z.literal("interrupt") }).strict(),
  z.object({ t: z.literal("close") }).strict(),
  z.object({ t: z.literal("set-model"), model: boundedText(200).optional() }).strict(),
  z.object({ t: z.literal("set-mode"), mode: boundedText(64) }).strict(),
]);

/** One Markdown file an Agent turn left different on disk. `path` is absolute
 *  POSIX; the counts are lines, not hunks. */
const agentTurnChangedFileSchema = z
  .object({
    path: boundedText(16_384),
    change: z.enum(["created", "edited", "deleted"]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

/** A turn that rewrites more files than this has stopped being something a
 *  person reviews file by file; the host reports the first ones by path. */
export const MAX_TURN_CHANGED_FILES = 500;

export const agentServerEventSchema = z.union([
  z.object({ t: z.literal("ready") }).strict(),
  z.object({ t: z.literal("session-id"), id: boundedText(512) }).strict(),
  z.object({ t: z.literal("session-title"), title: boundedText(2_000) }).strict(),
  z
    .object({
      t: z.literal("models"),
      models: z.array(agentModelSchema).max(256),
      activeModel: boundedText(200).optional(),
      effort: boundedText(64).optional(),
      fallback: boundedText(500).optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal("skills"),
      skills: z.array(agentSkillSchema).max(2_000),
      state: z.enum(["available", "empty", "failed"]),
      error: boundedText(2_000).optional(),
    })
    .strict(),
  z.object({ t: z.literal("turn-start") }).strict(),
  z.object({ t: z.literal("text"), delta: boundedText(1_048_576) }).strict(),
  z.object({ t: z.literal("thinking"), delta: boundedText(1_048_576) }).strict(),
  z
    .object({
      t: z.literal("tool"),
      id: boundedText(512),
      name: boundedText(512),
      input: recordSchema,
      crew: agentCrewCallSchema.optional(),
    })
    .strict(),
  z
    .object({ t: z.literal("tool-delta"), id: boundedText(512), delta: boundedText(1_048_576) })
    .strict(),
  z
    .object({
      t: z.literal("tool-result"),
      id: boundedText(512),
      content: boundedText(4_194_304),
      isError: z.boolean(),
    })
    .strict(),
  z
    .object({
      t: z.literal("file-diff"),
      id: boundedText(512),
      file: boundedText(16_384),
      before: boundedText(4_194_304),
      after: boundedText(4_194_304),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      t: z.literal("permission"),
      id: boundedText(512),
      toolUseId: boundedText(512),
      name: boundedText(512),
      title: boundedText(2_000).nullable(),
      input: recordSchema,
      approvalScopes: z.array(z.enum(["session", "always"])).max(2).optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal("steer-result"),
      id: boundedText(512),
      ok: z.boolean(),
      message: boundedText(2_000).optional(),
    })
    .strict(),
  z.object({ t: z.literal("turn-end"), isError: z.boolean() }).strict(),
  z
    .object({
      t: z.literal("turn-changes"),
      turnId: boundedText(512),
      files: z.array(agentTurnChangedFileSchema).max(MAX_TURN_CHANGED_FILES),
    })
    .strict(),
  z.object({ t: z.literal("notice"), message: boundedText(2_000) }).strict(),
  z
    .object({
      t: z.literal("error"),
      message: boundedText(2_000),
      failure: agentTurnFailureSchema.optional(),
    })
    .strict(),
  z.object({ t: z.literal("exit"), message: boundedText(2_000).optional(), failure: agentTurnFailureSchema.optional() }).strict(),
  z
    .object({
      t: z.literal("exit"),
      reason: z.literal("scope-removed"),
      folder: boundedText(16_384),
    })
    .strict(),
]);

const agentSessionConnectFields = {
  telemetryConnectionId: z.string().uuid().optional(),
  access: agentAccessModeSchema.default("auto"),
  agent: agentIdSchema,
  effort: boundedText(64).optional(),
  model: boundedText(200).optional(),
  resume: boundedText(512).optional(),
  crew: z.string().regex(/^[a-zA-Z0-9_-]{1,512}$/u).optional(),
  /** The library persona the Chat runs under; absent runs none. */
  persona: z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/u).optional(),
};

export const agentSessionConnectSchema = z.object({
  ...agentSessionConnectFields,
  folder: boundedText(16_384).min(1),
}).strict();

export type AgentId = z.infer<typeof agentIdSchema>;
export type AgentAccessMode = z.infer<typeof agentAccessModeSchema>;
export type AgentTurnFailureKind = z.infer<typeof agentTurnFailureKindSchema>;
export type AgentTurnFailure = z.infer<typeof agentTurnFailureSchema>;
export type AgentModel = z.infer<typeof agentModelSchema>;
export type AgentSkill = z.infer<typeof agentSkillSchema>;
export type AgentClientEvent = z.infer<typeof agentClientEventSchema>;
export type AgentServerEvent = z.infer<typeof agentServerEventSchema>;
export type AgentTurnChangedFile = z.infer<typeof agentTurnChangedFileSchema>;

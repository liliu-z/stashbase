import { z } from "zod";

const boundedText = (maximum: number) => z.string().max(maximum);

export const agentSessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "session id contains control characters",
  );

export const agentSessionInfoSchema = z
  .object({
    id: agentSessionIdSchema,
    title: boundedText(2_000),
    lastModified: z.number().finite().nonnegative(),
    hasContent: z.boolean(),
    cwd: boundedText(16_384).optional(),
    gitBranch: boundedText(2_000).optional(),
    folder: boundedText(16_384).optional(),
  })
  .strict();

/** The longest replayed passage quote; above the composer's own limit so
 *  every passage it sends replays, and a longer one stays in the prose. */
export const AGENT_SESSION_QUOTE_MAX = 16_384;

export const agentSessionAttachmentSchema = z
  .object({
    path: boundedText(16_384),
    name: boundedText(2_000),
    dims: boundedText(128).optional(),
    previewUrl: boundedText(32_768).optional(),
    /** The selected passage a `Selected passages:` entry carried. */
    quote: boundedText(AGENT_SESSION_QUOTE_MAX).optional(),
  })
  .strict();

const agentSessionUserBlockSchema = z
  .object({
    kind: z.literal("user"),
    id: boundedText(512),
    text: boundedText(4_194_304),
    attachments: z.array(agentSessionAttachmentSchema).max(128).optional(),
    at: z.number().finite().nonnegative().optional(),
  })
  .strict();

const agentSessionAssistantBlockSchema = z
  .object({
    kind: z.literal("assistant"),
    id: boundedText(512),
    text: boundedText(4_194_304),
    at: z.number().finite().nonnegative().optional(),
  })
  .strict();

const agentSessionThinkingBlockSchema = z
  .object({
    kind: z.literal("thinking"),
    id: boundedText(512),
    text: boundedText(4_194_304),
  })
  .strict();

const agentSessionToolBlockSchema = z
  .object({
    kind: z.literal("tool"),
    id: boundedText(512),
    name: boundedText(512),
    input: z.record(z.string(), z.unknown()),
    status: z.enum(["done", "error"]),
    result: boundedText(4_194_304).optional(),
  })
  .strict();

export const agentSessionBlockSchema = z.discriminatedUnion("kind", [
  agentSessionUserBlockSchema,
  agentSessionAssistantBlockSchema,
  agentSessionThinkingBlockSchema,
  agentSessionToolBlockSchema,
]);

export const agentSessionReplaySchema = z
  .object({
    protocol: z.literal(2),
    messages: z.array(agentSessionBlockSchema).max(50_000),
    effort: boundedText(64).nullable(),
  })
  .strict();

export const agentSessionListResponseSchema = z.array(agentSessionInfoSchema).max(20_000);

export const agentSessionRenameRequestSchema = z
  .object({ title: z.string().trim().min(1).max(2_000) })
  .strict();

export const agentSessionEmptyResponseSchema = z.object({}).strict();

export const agentSessionFailureSchema = z
  .object({ error: z.string().trim().min(1).max(2_000) })
  .passthrough();

export type AgentSessionInfoWire = z.infer<typeof agentSessionInfoSchema>;
export type AgentSessionBlockWire = z.infer<typeof agentSessionBlockSchema>;
export type AgentSessionReplayWire = z.infer<typeof agentSessionReplaySchema>;
export type AgentSessionRenameRequestWire = z.infer<typeof agentSessionRenameRequestSchema>;

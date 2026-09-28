import { z } from 'zod';

export const embedderProviderSchema = z.enum(['openai', 'openrouter', 'requesty']);

/** `GET /api/account`. Account identity is independent from embeddings. */
export const hostedAccountStateSchema = z
  .object({
    avatarUrl: z.string().max(4096).optional(),
    displayName: z.string().max(240).optional(),
    email: z.string().max(320).optional(),
    signedIn: z.boolean(),
  })
  .passthrough();

/** `GET /api/embedder`, and the body every embedder mutation answers with. */
export const embedderStateSchema = z
  .object({
    backfillStarted: z.boolean().optional(),
    hasKey: z.boolean(),
    model: z.string().max(240),
    provider: embedderProviderSchema,
  })
  .passthrough();

export const embedderKeyRequestSchema = z
  .object({
    key: z.string().trim().min(1).max(4096),
    provider: embedderProviderSchema,
  })
  .strict();

/** `PUT /api/embedder/key`. */
export const embedderKeySaveResponseSchema = z
  .object({
    backfillStarted: z.boolean().optional(),
    hasKey: z.literal(true),
    model: z.string().max(240),
    provider: embedderProviderSchema,
    warning: z.string().max(1000).optional(),
  })
  .passthrough();

export const hostedOAuthStartRequestSchema = z
  .object({
    provider: z.literal('google'),
    purpose: z.literal('account'),
  })
  .strict();

export const hostedOAuthStartResponseSchema = z
  .object({
    flowId: z.string().min(1).max(256),
    provider: z.literal('google'),
    purpose: z.literal('account'),
    url: z.string().url().max(4096),
  })
  .passthrough();

export const hostedOAuthStatusSchema = z
  .object({
    appReturned: z.boolean().optional(),
    error: z.string().max(1000).optional(),
    state: z.enum(['pending', 'complete', 'error']),
  })
  .passthrough();

export const embedderFailureSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    error: z.string().trim().min(1).max(1000),
  })
  .passthrough();

export type EmbedderStateWire = z.infer<typeof embedderStateSchema>;
export type HostedAccountStateWire = z.infer<typeof hostedAccountStateSchema>;
export type EmbedderKeySaveResponseWire = z.infer<typeof embedderKeySaveResponseSchema>;
export type HostedOAuthStartResponseWire = z.infer<typeof hostedOAuthStartResponseSchema>;
export type HostedOAuthStatusWire = z.infer<typeof hostedOAuthStatusSchema>;

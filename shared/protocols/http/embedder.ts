import { z } from 'zod';
import { accountGenerationSchema } from './referrals';

const embedderProviderSchema = z.enum(['openai', 'openrouter']);

/** `GET /api/account`. Account identity is independent from embeddings. */
export const hostedAccountStateSchema = z
  .object({
    avatarUrl: z.string().max(4096).optional(),
    displayName: z.string().max(240).optional(),
    email: z.string().max(320).optional(),
    generation: accountGenerationSchema.optional(),
    offers: z.array(z.string().max(64)).max(8).optional(),
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

export const hostedAccountOfferSchema = z.enum(['sign-in']);

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

export const emailSendSchema = z.object({ email: z.string().trim().email().max(320) }).strict();
export const emailCancelSchema = z.object({ flowId: z.string().min(1).max(128) }).strict();
export const emailVerifySchema = emailCancelSchema.extend({ otp: z.string().regex(/^\d{6}$/) });
export const emailSentSchema = emailCancelSchema;
export const accountMethodsSchema = z.object({ email: z.string().email(), google: z.boolean() });
export const accountLinkActionSchema = z.object({ action: z.enum(['send','link','unlink','status']), otp: z.string().max(16).optional(), ticket: z.string().max(128).optional() }).strict();
export const accountLinkStartSchema = z.object({ ticket: z.string().min(1).max(128), url: z.string().url() });
export const accountLinkStatusSchema = z.object({ state: z.enum(['pending','complete','error']) });
export const accountCommandSchema = z.object({ success: z.boolean().optional(), sent: z.boolean().optional() });

/** Authenticated mailbox proof accepts no caller-selected recipient. */
export const emailProofSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send') }).strict(),
  z.object({ action: z.literal('verify'), otp: z.string().regex(/^\d{6}$/) }).strict(),
]);

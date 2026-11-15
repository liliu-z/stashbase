import { z } from 'zod';

export const speechModelStatusSchema = z.object({
  phase: z.enum(['missing', 'downloading', 'paused', 'verifying', 'ready', 'failed', 'unsupported']),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  error: z.string().max(1000).nullable(),
}).strict();
export type SpeechModelStatus = z.infer<typeof speechModelStatusSchema>;

export const speechModelCommandSchema = z.object({ action: z.enum(['stop', 'resume', 'retry']) }).strict();
export const speechStartSchema = z.object({ id: z.string().uuid(), conversation: z.string().min(1).max(128) }).strict();
// One second of mono 16 kHz signed 16-bit PCM. JSON uses the existing window
// transport rather than introducing another binary/authentication channel.
export const speechAudioSchema = z.object({
  sequence: z.number().int().nonnegative().safe(),
  pcm: z.string().min(4).max(42668).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
}).strict();
export const speechFinishSchema = z.object({ sequence: z.number().int().nonnegative().safe() }).strict();
export const speechJobSchema = z.object({
  id: z.string().uuid(),
  phase: z.enum(['recording', 'processing', 'ready', 'failed', 'cancelled']),
  nextSequence: z.number().int().nonnegative(),
  text: z.string(),
  error: z.string().max(1000).nullable(),
}).strict();
export type SpeechJob = z.infer<typeof speechJobSchema>;
export const speechCancelledSchema = z.object({ ok: z.literal(true) }).strict();
export const speechFailureSchema = z.object({ error: z.string(), code: z.string().optional() });

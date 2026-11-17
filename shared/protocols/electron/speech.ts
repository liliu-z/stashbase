import { z } from 'zod';
export const SPEECH_CAPTURE_CAPABILITY = 'speech.capture';
export const SPEECH_CAPTURE_CHANNEL = 'speech:capture';
export const speechCaptureRequestSchema = z.object({ active: z.boolean() }).strict();
export const speechCaptureResponseSchema = z.object({ ok: z.boolean() }).strict();

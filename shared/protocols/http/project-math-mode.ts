import { z } from 'zod';

/** `GET /api/project-math-mode` answers the state the server actually applies
 *  for one project. An absent or unreadable record means single dollars are
 *  plain text, so the response always carries a boolean rather than "unset". */
export const projectMathModeSchema = z
  .object({
    /** The project's registered folder root. */
    scope: z.string().min(1).max(4096),
    enabled: z.boolean(),
  })
  .strip();

/** A read names one project and nothing else. */
export const projectMathModeQuerySchema = z
  .object({ scope: z.string().min(1).max(4096) })
  .strict();

/** A write names exactly one project and the state to keep for it. It is strict
 *  because it reaches durable configuration: an unknown key is a caller mistake
 *  to refuse, not a value to persist. */
export const projectMathModeRequestSchema = z
  .object({
    scope: z.string().min(1).max(4096),
    enabled: z.boolean(),
  })
  .strict();

/** Every refusal carries one sentence written for the reader. */
export const projectMathModeFailureSchema = z
  .object({ error: z.string().trim().min(1).max(500) })
  .passthrough();

export type ProjectMathModeWire = z.infer<typeof projectMathModeSchema>;

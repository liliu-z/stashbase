import { z } from 'zod';

import { VIEWER_FORMATS } from '../../file-formats';

/** Process-private header main sends when it registers a dropped file. */
export const EXTERNAL_FILE_REGISTRATION_TOKEN_HEADER = 'x-stashbase-external-file-token';

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Paths cannot contain NUL.');

/** The opaque capability that names one granted file. */
export const externalFileTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/u);

export const externalFileOpenRequestSchema = z.object({ path: absolutePathSchema }).strict();

const EXTERNAL_FILE_REFUSALS = ['copy-required', 'directory', 'unavailable', 'no-project'] as const;

/**
 * What opening one dropped file resolved to: a read grant for a file outside
 * the project, the project's own copy when the file already lives there, or a
 * refusal the renderer explains. The refusal names the file by its basename.
 */
export const externalFileOpenResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      format: z.enum(VIEWER_FORMATS),
      kind: z.literal('external'),
      name: z.string().min(1).max(1024),
      path: absolutePathSchema,
      token: externalFileTokenSchema,
    })
    .strict(),
  z
    .object({
      /** The registered project the file belongs to, when it is not the
       *  window's own; such a file opens read-only, as that project's. */
      folderPath: absolutePathSchema.optional(),
      format: z.enum(VIEWER_FORMATS),
      kind: z.literal('project'),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal('refused'),
      name: z.string().min(1).max(1024),
      reason: z.enum(EXTERNAL_FILE_REFUSALS),
    })
    .strict(),
]);

export type ExternalFileOpenResult = z.infer<typeof externalFileOpenResultSchema>;

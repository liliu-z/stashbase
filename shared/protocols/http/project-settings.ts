import { z } from 'zod';

/** Local application settings owned by one registered project. These never
 * travel with the project's files. */
export const projectMathSettingsSchema = z
  .object({
    scope: z.string().min(1).max(4096),
    math_mode: z.boolean(),
  })
  .strict();

export const projectMathSettingsRequestSchema = projectMathSettingsSchema.pick({
  scope: true,
  math_mode: true,
});

export type ProjectMathSettingsWire = z.infer<typeof projectMathSettingsSchema>;

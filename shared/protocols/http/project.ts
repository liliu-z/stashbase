import { z } from 'zod';

const folderPathSchema = z.string().min(1).max(4096)
  .refine((value) => value.trim().length > 0, 'Path must contain a visible character.');
const folderNameSchema = z.string().min(1).max(255);

const registeredProjectSchema = z.object({
  favorite: z.boolean().optional(),
  openedAt: z.string().trim().min(1).max(64),
  path: folderPathSchema,
});

const activeProjectFolderSchema = z.object({
  name: folderNameSchema,
  path: folderPathSchema,
});

export const projectRegistrySnapshotSchema = z.object({
  current: activeProjectFolderSchema.nullable(),
  homeDir: folderPathSchema,
  recent: z.array(registeredProjectSchema).max(1000),
});

export const projectOpenFolderRequestSchema = z
  .object({
    path: folderPathSchema,
  })
  .strict();

export const projectRemoveFolderRequestSchema = z
  .object({
    path: folderPathSchema,
  })
  .strict();

export const projectRevealFolderRequestSchema = z
  .object({
    path: folderPathSchema,
  })
  .strict();

export const projectRevealFolderResponseSchema = z.object({}).strict();

export const projectFailureSchema = z.object({
  code: z.string().trim().min(1).max(64).optional(),
  error: z.string().trim().min(1).max(500),
});

export type ProjectRegistrySnapshotWire = z.infer<typeof projectRegistrySnapshotSchema>;

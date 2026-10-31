import { z } from 'zod';

export const WORKSPACE_SESSION_CAPABILITY = 'workspace.session';
export const WORKSPACE_SESSION_READ_CHANNEL = 'workspace-session:read';
export const WORKSPACE_SESSION_WRITE_CHANNEL = 'workspace-session:write';
export const MAX_WORKSPACE_SESSION_FOLDERS = 32;
export const MAX_WORKSPACE_SESSION_BYTES = 1_048_576;

const persistedPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0, 'Path must contain a visible character.');
const absolutePathSchema = persistedPathSchema;
const relativePathSchema = persistedPathSchema;
const identitySchema = z.string().trim().min(1).max(128);

const workspaceSessionTabSchema = z
  .object({
    id: identitySchema,
    path: relativePathSchema,
  })
  .strict();

const workspaceSessionFolderSchema = z
  .object({
    activeTabId: identitySchema.nullable(),
    expandedPaths: z.array(relativePathSchema).max(2_048),
    folderPath: absolutePathSchema,
    mathMode: z.boolean().default(false),
    selectedPath: relativePathSchema.nullable(),
    tabs: z.array(workspaceSessionTabSchema).max(50),
  })
  .strict();

export const workspaceSessionSnapshotSchema = z
  .object({
    activeFolderPath: absolutePathSchema.nullable(),
    folders: z.array(workspaceSessionFolderSchema).max(MAX_WORKSPACE_SESSION_FOLDERS),
    shell: z
      .object({
        sidebarOpen: z.boolean(),
        sidebarWidth: z.number().int().min(160).max(360),
        agentPaneWidth: z.number().int().min(320).max(960).default(576),
      })
      .strict(),
    version: z.literal(1),
  })
  .strict()
  .refine(
    (snapshot) =>
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <=
      MAX_WORKSPACE_SESSION_BYTES,
    'Workspace session exceeds its persistence bound.',
  );

const workspaceSessionReadSuccessSchema = z
  .object({ ok: z.literal(true), session: workspaceSessionSnapshotSchema.nullable() })
  .strict();

const workspaceSessionWriteSuccessSchema = z.object({ ok: z.literal(true) }).strict();

export const workspaceSessionFailureSchema = z
  .object({
    failure: z
      .object({
        kind: z.enum(['unauthorized', 'unavailable', 'invalid-response']),
        message: z.string().trim().min(1).max(240),
      })
      .strict(),
    ok: z.literal(false),
  })
  .strict();

export const workspaceSessionReadResponseSchema = z.union([
  workspaceSessionReadSuccessSchema,
  workspaceSessionFailureSchema,
]);

export const workspaceSessionWriteResponseSchema = z.union([
  workspaceSessionWriteSuccessSchema,
  workspaceSessionFailureSchema,
]);

export type WorkspaceSessionSnapshotWire = z.infer<typeof workspaceSessionSnapshotSchema>;
export type WorkspaceSessionReadResponse = z.infer<
  typeof workspaceSessionReadResponseSchema
>;
export type WorkspaceSessionWriteResponse = z.infer<
  typeof workspaceSessionWriteResponseSchema
>;

import type { z } from 'zod';
import type { agentContextFileResponseSchema } from './protocols/http/agent-context.ts';
import type {
  genericFilePreviewResponseSchema,
  WORKSPACE_ENTRY_AVAILABILITIES,
  WORKSPACE_FILE_KINDS,
} from './protocols/http/files.ts';

/**
 * File-shaped contracts the server reports about a folder's contents.
 *
 * Workspace listings report visible filesystem entries truthfully. A
 * `generic` file is present in the workbench but deliberately outside Search
 * and automatic Agent context. Entry metadata records cases where the source
 * can be identified but must not be read or mutated through normal document
 * flows.
 */

export type WorkspaceFileKind = (typeof WORKSPACE_FILE_KINDS)[number];
export type WorkspaceEntryAvailability = (typeof WORKSPACE_ENTRY_AVAILABILITIES)[number];

/**
 * One source resolved for Agent retrieval. `path` is the absolute source
 * identity accepted by read_file; `sourcePath` is its folder-relative label.
 * The host alone locates prepared text. Availability failures stay in-band
 * so one unavailable attachment does not fail the whole context request.
 */
export type AgentContextFile = z.infer<typeof agentContextFileResponseSchema>;

export type GenericFilePreview = z.infer<typeof genericFilePreviewResponseSchema>;

/** Upload reports per file rather than failing the batch: one rejected
 *  file must not discard the rest of a multi-file drop. */
interface UploadResultEntry {
  file: string;
  error?: string;
}

export interface UploadResult {
  files: UploadResultEntry[];
}

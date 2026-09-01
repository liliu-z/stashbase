import type { ViewerFormat } from './file-formats.ts';

/**
 * File-shaped contracts the server reports about a folder's contents.
 *
 * Workspace listings report visible filesystem entries truthfully. A
 * `generic` file is present in the workbench but deliberately outside Search
 * and automatic Agent context. Entry metadata records cases where the source
 * can be identified but must not be read or mutated through normal document
 * flows.
 */

export type WorkspaceFileKind =
  | 'regular'
  | 'symlink'
  | 'special'
  | 'cloud-placeholder';

export type WorkspaceEntryAvailability = 'available' | 'unreadable';

/**
 * One file resolved for Agent retrieval. `sourcePath` is what the user sees
 * and `readPath` is what actually gets read — they differ for a converted
 * source, where the readable text lives in a derived note. `available` and
 * `reason` carry a refusal in-band so a caller reports why a file could not
 * be supplied rather than failing the whole request.
 */
export interface AgentContextFile {
  /** Absolute source spelling exposed to MCP/file tools. */
  path: string;
  /** Display label of the member folder containing the source. */
  folder: string;
  /** Folder-relative visible source path (`paper.pdf`). */
  sourcePath: string;
  /** Path the agent should read first (folder-relative for direct text; an
   *  absolute app-data path for extracted PDF/DOCX text). */
  readPath: string;
  kind: 'direct' | 'derived';
  sourceFormat: string;
  available: boolean;
  reason: string;
}

/** One file row in a folder listing. `snippet` and `heading` are preview
 *  text the server extracts so the tree can render without reading files. */
export interface FileMeta {
  name: string;
  format: ViewerFormat;
  heading: string;
  snippet: string;
  size?: number;
  entryKind?: WorkspaceFileKind;
  availability?: WorkspaceEntryAvailability;
  imported_at?: string;
}

export interface FolderMeta {
  path: string;
  kind?: 'normal' | 'excluded' | 'unreadable';
}

/** The library as the shell sees it: which folder is open, and the
 *  recents-ordered membership behind the switcher. */
export interface FolderState {
  current: { path: string; name: string } | null;
  recent: { path: string; openedAt: string; favorite?: boolean }[];
  homeDir?: string;
}

export interface FilesPayload {
  files: FileMeta[];
  folders: FolderMeta[];
  folder: string;
  /** Effective application-level hidden-files visibility this listing was
   *  computed with, so every window's menu state tracks server truth. */
  showHiddenFiles?: boolean;
}

/** A file's editable content. `version` is the concurrency token a save
 *  echoes back so a write can detect that disk moved underneath it. */
export interface FileBody {
  name: string;
  format: ViewerFormat;
  content: string;
  version?: string;
  /** In-band source-open failure used when the source identity is valid but
   * its bytes cannot safely become editor text. Such bodies are read-only and
   * must never be persisted back to disk. */
  error?: {
    code: 'UNSUPPORTED_ENCODING';
    message: string;
  };
}

export type GenericFilePreview =
  | {
      kind: 'text';
      name: string;
      size: number;
      content: string;
      version?: string;
    }
  | {
      kind:
        | 'binary'
        | 'too-large'
        | 'unreadable'
        | 'symlink'
        | 'special'
        | 'cloud-placeholder';
      name: string;
      size?: number;
      message?: string;
    };

/** Upload reports per file rather than failing the batch: one rejected
 *  file must not discard the rest of a multi-file drop. */
export interface UploadResultEntry {
  file: string;
  error?: string;
}

export interface UploadResult {
  files: UploadResultEntry[];
}

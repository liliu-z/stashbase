import { z } from 'zod';
import { VIEWER_FORMATS } from '../../file-formats';

const relativePathSchema = z.string().min(1).max(4096);
const folderPathSchema = z.string().trim().min(1).max(4096);
const sourceVersionSchema = z.string().trim().min(1).max(256);
const boundedSourceTextSchema = z.string().max(8 * 1024 * 1024);

const viewerFormatSchema = z.enum(VIEWER_FORMATS);

export const WORKSPACE_FILE_KINDS = ['regular', 'symlink', 'special', 'cloud-placeholder'] as const;
export const WORKSPACE_ENTRY_AVAILABILITIES = ['available', 'unreadable'] as const;

const workspaceFileSchema = z
  .object({
    availability: z.enum(WORKSPACE_ENTRY_AVAILABILITIES).optional(),
    entryKind: z.enum(WORKSPACE_FILE_KINDS).optional(),
    format: viewerFormatSchema,
    name: relativePathSchema,
    size: z.number().finite().nonnegative(),
  })
  .strict();

const workspaceFolderSchema = z
  .object({
    kind: z.enum(['normal', 'excluded', 'unreadable']).optional(),
    path: relativePathSchema,
  })
  .strict();

export const workspaceFilesSchema = z
  .object({
    files: z.array(workspaceFileSchema),
    folder: z.string().trim().min(1).max(255),
    folders: z.array(workspaceFolderSchema),
    /** The visibility the server actually applied. Echoed so every window's
     * menu tracks server truth, including folder-explicit workspace listings. */
    showHiddenFiles: z.boolean(),
  })
  .strict();

export const workspaceFailureSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    error: z.string().trim().min(1).max(500),
  })
  .passthrough();

export const workspaceRevealResponseSchema = z.object({}).strict();

export const workspaceRevealRequestSchema = z
  .object({
    folderPath: folderPathSchema,
    path: relativePathSchema,
  })
  .strict();

/** One leaf name: no separators, no traversal, and something left once
 *  trimmed. Whether the server keeps or completes an extension is the
 *  server's rule; the wire only rules out names that could leave the parent. */
const workspaceEntryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !/[\\/]/u.test(name) && name !== '.' && name !== '..', {
    message: 'entry names cannot contain separators',
  });

const workspaceEntryKindSchema = z.enum(['file', 'folder']);

export const interactiveNoteCreateRequestSchema = z.object({
  parentPath: z.string().max(4096),
  name: workspaceEntryNameSchema.optional(),
}).strict();

export const interactiveNoteCreateResponseSchema = z.object({
  path: relativePathSchema,
  entryPath: relativePathSchema,
}).strict();

/** Identity of one file or folder inside an explicit member folder. */
export const workspaceEntryRequestSchema = z
  .object({
    folderPath: folderPathSchema,
    kind: workspaceEntryKindSchema,
    path: relativePathSchema,
  })
  .strict();

export const workspaceCreateEntryRequestSchema = z
  .object({
    folderPath: folderPathSchema,
    kind: workspaceEntryKindSchema,
    name: workspaceEntryNameSchema,
    /** Folder-relative parent; empty for the folder root. */
    parentPath: z.string().trim().max(4096),
  })
  .strict();

export const workspaceRenameEntryRequestSchema = z
  .object({
    folderPath: folderPathSchema,
    kind: workspaceEntryKindSchema,
    name: workspaceEntryNameSchema,
    path: relativePathSchema,
  })
  .strict();

/** A file or folder moving under its own name into another folder of the
 *  same project. Whether a folder would land inside itself is the server's
 *  rule. */
export const workspaceMoveEntryRequestSchema = z
  .object({
    folderPath: folderPathSchema,
    kind: workspaceEntryKindSchema,
    /** Folder-relative destination folder; empty for the folder root. */
    parentPath: z.string().max(4096),
    path: relativePathSchema,
  })
  .strict();

/** The created or renamed entry's settled folder-relative path. File
 *  routes answer with `name`, folder routes with `path`; both may carry
 *  extra detail such as an index warning. */
export const workspaceEntryPathResponseSchema = z
  .object({ name: relativePathSchema.optional(), path: relativePathSchema.optional() })
  .passthrough()
  .refine((body) => body.name !== undefined || body.path !== undefined, {
    message: 'name or path required',
  });

export const workspaceDeleteEntryResponseSchema = z
  .object({ alreadyGone: z.boolean().optional() })
  .passthrough();

export const documentTextSourceRequestSchema = z
  .object({
    folderPath: folderPathSchema,
    path: relativePathSchema,
  })
  .strict();

const documentTextSourceBaseSchema = {
  content: boundedSourceTextSchema,
  format: z.enum(['md', 'html', 'json', 'txt', 'csv']),
  name: relativePathSchema,
  version: sourceVersionSchema,
};

export const documentTextSourceResponseSchema = z.union([
  z.object(documentTextSourceBaseSchema).strict(),
  z
    .object({
      ...documentTextSourceBaseSchema,
      content: z.literal(''),
      format: z.enum(['txt', 'csv']),
      error: z
        .object({
          code: z.literal('UNSUPPORTED_ENCODING'),
          message: z.string().trim().min(1).max(500),
        })
        .strict(),
    })
    .strict(),
]);

export const documentTextSourceFailureSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    error: z.string().trim().min(1).max(500),
  })
  .strict();

const genericFilePreviewBaseSchema = {
  name: relativePathSchema,
  size: z.number().finite().nonnegative().optional(),
};

export const spreadsheetPreviewSchema = z.object({
  sheets: z.array(z.object({
    name: z.string().max(255),
    firstRow: z.number().int().nonnegative(),
    firstColumn: z.number().int().nonnegative(),
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    rows: z.array(z.array(z.string().max(32_767)).max(64)).max(1_000),
    /** Formula cells among `rows`, by their index there. The value shown is
     *  the result saved in the file; StashBase does not recalculate it. */
    formulas: z.array(z.object({
      row: z.number().int().nonnegative().max(999),
      column: z.number().int().nonnegative().max(63),
      formula: z.string().min(1).max(8_192),
    }).strict()).max(2_000),
  }).strict()).max(20),
  sheetCount: z.number().int().nonnegative(),
  hasFormulas: z.boolean(),
}).strict();

export const genericFilePreviewResponseSchema = z.union([
  z.object({
    ...genericFilePreviewBaseSchema,
    kind: z.literal('spreadsheet'),
    workbook: spreadsheetPreviewSchema,
    size: z.number().finite().nonnegative(),
    version: sourceVersionSchema,
  }).strict(),
  z
    .object({
      ...genericFilePreviewBaseSchema,
      content: boundedSourceTextSchema,
      kind: z.literal('text'),
      size: z.number().finite().nonnegative(),
      version: sourceVersionSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...genericFilePreviewBaseSchema,
      kind: z.enum([
        'binary',
        'too-large',
        'unreadable',
        'symlink',
        'special',
        'cloud-placeholder',
        'invalid-spreadsheet',
      ]),
      message: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
]);

const TABLE_DELIMITERS = [',', '\t', ';', '|'] as const;
const TABLE_ENCODINGS = ['utf-16le', 'utf-16be', 'gb18030'] as const;
export type TableDelimiter = (typeof TABLE_DELIMITERS)[number];
export type TableEncoding = (typeof TABLE_ENCODINGS)[number];

export const delimitedTableRequestSchema = z
  .object({
    count: z.coerce.number().int().min(1).max(500),
    start: z.coerce.number().int().nonnegative(),
  })
  .strict();

/** One page of a CSV/TSV table, read in segments. `rowCount` counts records
 *  including the first; `columnCount` is the widest record, capped, and
 *  `totalColumns` is the uncapped width. `editable` says whether the source
 *  is within the ceiling for opening it as text. */
export const delimitedTableResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      columnCount: z.number().int().nonnegative(),
      delimiter: z.enum(TABLE_DELIMITERS),
      editable: z.boolean(),
      kind: z.literal('table'),
      name: relativePathSchema,
      rowCount: z.number().int().nonnegative(),
      rows: z.array(z.array(z.string().max(32_768))).max(500),
      size: z.number().finite().nonnegative(),
      start: z.number().int().nonnegative(),
      totalColumns: z.number().int().nonnegative(),
      version: sourceVersionSchema,
    })
    .strict(),
  z
    .object({
      encoding: z.enum(TABLE_ENCODINGS).nullable(),
      kind: z.literal('unsupported-encoding'),
      name: relativePathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('too-large'),
      name: relativePathSchema,
      size: z.number().finite().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('binary'), name: relativePathSchema }).strict(),
]);

export type DelimitedTable = z.infer<typeof delimitedTableResponseSchema>;

export const documentTextSaveRequestSchema = z
  .object({
    baseVersion: sourceVersionSchema,
    content: boundedSourceTextSchema,
    folderPath: folderPathSchema,
    path: relativePathSchema,
  })
  .strict();

export const documentTextOverwriteRequestSchema = z
  .object({
    content: boundedSourceTextSchema,
    folderPath: folderPathSchema,
    overwrite: z.literal(true),
    path: relativePathSchema,
  })
  .strict();

export const documentTextSaveResponseSchema = z
  .object({
    content: boundedSourceTextSchema,
    format: z.enum(['json', 'md', 'txt', 'csv']),
    indexWarning: z.string().trim().min(1).max(1_000).optional(),
    name: relativePathSchema,
    version: sourceVersionSchema,
  })
  .strict();

export const documentTextSaveFailureSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    currentVersion: sourceVersionSchema.nullable().optional(),
    error: z.string().trim().min(1).max(500),
  })
  .strict();

export type WorkspaceFilesWire = z.infer<typeof workspaceFilesSchema>;

/** Original JSON response of a file mutation, queried without replaying it. */
export const fileOperationReceiptSchema = z.object({
  status: z.number().int().min(200).max(599),
  body: z.unknown(),
}).strict();

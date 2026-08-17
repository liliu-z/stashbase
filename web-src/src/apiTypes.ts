/**
 * Renderer-facing request and response contracts for the local HTTP API.
 * These declarations have no runtime dependencies.
 */
import type { ConversionProgress } from '../../shared/conversion.ts';
import type {
  AudioPreviewStatus,
  AudioTranscript,
  AudioTranscriptSegment,
  AudioTranscriptState,
  LocalTranscriptionModelId,
  TranscriptionModelOperation,
  TranscriptionModelState,
  TranscriptionSettings,
} from '../../shared/transcription.ts';
export type { ConversionProgress } from '../../shared/conversion.ts';
export type {
  AudioPreviewStatus,
  AudioTranscript,
  AudioTranscriptSegment,
  AudioTranscriptState,
  LocalTranscriptionModelId,
  TranscriptionModelOperation,
  TranscriptionModelState,
  TranscriptionSettings,
} from '../../shared/transcription.ts';
export type TranscriptionModelId = LocalTranscriptionModelId;
export type AppearanceTheme = 'system' | 'light' | 'dark';
export type AppearanceScale = 'small' | 'default' | 'large';

export interface AppearancePreferences {
  theme: AppearanceTheme;
  uiScale: AppearanceScale;
  readingTextSize: AppearanceScale;
}

export interface CapturePreferences {
  clipboardImageImport: boolean;
}

export interface UpdatePreferences {
  autoCheck: boolean;
}

/** Viewer format the renderer uses for tab routing. `md` / `html` / `json` are
 *  text formats loaded from `/api/files/*`; `pdf`, `image`, and `docx` load
 *  their source bytes from `/asset/*`. DOCX visible preview conversion happens
 *  in the renderer, while its searchable/Agent-readable text and preview
 *  fallback live in AppData-derived HTML. This type is therefore wider than
 *  the server's editable text format on purpose. */
export type FileFormat = 'md' | 'html' | 'json' | 'pdf' | 'image' | 'docx' | 'audio';

export interface ApiKeySaveResult {
  hasKey: true;
  provider: EmbedderProvider;
  model: string;
  /** True only when adding the first active embedding key and the server
   *  started a semantic backfill. Rotating a key keeps existing vectors
   *  valid and should not make files look pending. */
  backfillStarted?: boolean;
  /** Present when the key was saved but StashBase could not reach
   *  the provider to validate it at save time. Indexing/search will
   *  surface the real connectivity failure if it persists. */
  warning?: string;
}

export interface FileMeta {
  name: string;
  format: FileFormat;
  heading: string;
  snippet: string;
  imported_at?: string;
}

export interface FolderMeta {
  path: string;
}

export interface FolderState {
  current: { path: string; name: string } | null;
  recent: { path: string; openedAt: string; favorite?: boolean }[];
  homeDir?: string;
}

export interface UnsupportedFileSummary {
  sourceCode: number;
  other: number;
  otherExtensions: Array<{
    extension: string;
    count: number;
  }>;
}

export interface OnboardingPreferences {
  sourceCodeNoticeVersion?: number;
  unsupportedFormatsNoticeVersion?: number;
}

export interface FilesPayload {
  files: FileMeta[];
  folders: FolderMeta[];
  folder: string;
  unsupportedFiles?: UnsupportedFileSummary;
}

export interface FileBody {
  name: string;
  format: FileFormat;
  content: string;
  version?: string;
}

/** A local Claude Code session, as listed in the chat panel's History
 *  dropdown. Backed by the Agent SDK's transcript store. */
export interface SessionInfo {
  id: string;
  title: string;
  lastModified: number;
  cwd?: string;
  gitBranch?: string;
  /** `scope=all` listings only: the member folder this session belongs
   *  to; absent = the library bucket. */
  folder?: string;
}

/** One block of a session's replayed transcript. Structurally a subset of
 *  AgentView's `Block` (history tools are always settled), so it drops
 *  straight into `setBlocks`. */
export type SessionBlock =
  | { kind: 'user'; id: string; text: string; attachments?: Array<{ path: string; name: string; dims?: string; previewUrl?: string }> }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'done' | 'error'; result?: string };

export interface SessionReplay {
  protocol: 2;
  messages: SessionBlock[];
  /** Null means inherited/unknown and must not become a resume override. */
  effort: string | null;
}

export interface IndexStatus {
  folder?: string;
  total: number;
  indexed: number;
  pendingCount: number;
  pending: string[];
  orphanedCount: number;
  orphaned: string[];
  upToDate: boolean;
  /** False when semantic indexing/retrieval is unavailable, e.g. no embedding key. */
  semanticEnabled?: boolean;
  /** False while a configured hosted source is blocked by its shared quota. */
  semanticAvailable?: boolean;
  /** Human-readable reason when semantic indexing/retrieval is disabled. */
  semanticDisabledReason?: string;
  /** True when no UI-visible file is waiting for embedding. Unlike
   *  upToDate, this ignores orphaned/hidden index rows that are not
   *  relevant to search-readiness accounting. */
  visibleIndexingSettled?: boolean;
  semanticIndexing?: {
    state: 'disabled' | 'quota-exhausted' | 'partial-quota-exhausted' | 'awaiting-decision' | 'paused' | 'partial-paused' | 'indexing' | 'partial-indexing' | 'ready' | 'failed';
    sourceCount?: number;
    estimatedBytes?: number;
  };
  /** False while the server is still loading the index cache for a folder. */
  indexReady?: boolean;
  /** Folder-relative paths of PDF/image/DOCX sources that are queued or
   *  running. Empty when no conversions are pending. */
  pendingConversions?: string[];
  /** Incomplete convertible sources that cannot be queued until setup is
   *  resolved (currently audio with an unavailable runtime/provider/model). */
  blockedConversions?: string[];
  /** Folder-relative conversion progress keyed by visible source path.
   *  Used by PDF/image preview banners for queue/extraction/indexing copy. */
  conversionProgress?: Record<string, ConversionProgress>;
  /** Global in-memory scheduler change counter. Display-only notification;
   *  derived artifacts remain the conversion source of truth. */
  conversionRevision?: number;
  /** Folder-relative per-source refresh tokens for derived previews. */
  conversionVersions?: Record<string, number>;
  /** Persistent file preparation failures. Survives app restart (read
   *  back from AppData `state.db`). Empty when no failures. Drives
   *  lightweight row markers, rich viewer banners where available, and
   *  the context-menu Reprocess entry. */
  preparationFailures?: PreparationFailure[];
  /** Monotonic counter the server bumps on every external fs event
   *  (after self-write filtering). Renderer compares against its
   *  last-seen value and triggers `/api/files` on any change — picks
   *  up writes from the chat panel (Claude Code, `touch`, …) even
   *  for non-indexable files / empty dirs that don't move `pending`. */
  treeVersion?: number;
  /** Non-null when the active folder's background index sync failed after
   *  opening/importing. Cleared by a successful manual/background sync or
   *  user dismissal. */
  indexWarning?: IndexWarning | null;
}

export interface IndexWarning {
  message: string;
  at: string;
}

/** Persistent file preparation failure record — subset of the on-disk
 *  entry, with timestamps the UI doesn't need stripped. */
export interface PreparationFailure {
  path: string;
  lastError: string;
  attempts: number;
  status?: 'failed' | 'cancelled';
}

/** Full file preparation status entries returned by `GET /api/pdf/status`.
 *  Keyed by absolute source path. Rich viewers use this to pick out the
 *  entry for the file they're rendering and decide whether to show the
 *  failure banner. */
export type PdfStatusKind = 'in-flight' | 'done' | 'failed' | 'cancelled';
export interface PdfStatusEntry {
  status: PdfStatusKind;
  attempts: number;
  lastError?: string;
  lastAttemptAt: string;
  doneAt?: string;
}

export interface SyncResult {
  added?: string[];
  modified?: string[];
  removed?: string[];
  /** Files the daemon detected as renames (hash match between a
   *  deleted and an added path). These bypass the embedding pipeline
   *  entirely — cached vectors get re-stamped under the new source. */
  renamed?: string[];
  failed?: { name: string; error: string }[];
  cancelled?: boolean;
  error?: string;
}

export interface UploadResultEntry {
  file: string;
  error?: string;
}

export interface UploadResult {
  files: UploadResultEntry[];
}

export interface AgentContextFile {
  path: string;
  folder: string;
  sourcePath: string;
  readPath: string;
  kind: 'direct' | 'derived';
  sourceFormat: string;
  available: boolean;
  reason: string;
}

export interface SearchHit {
  fileName: string;
  chunkIndex: number;
  content: string;
  heading: string;
  startLine?: number;
  endLine?: number;
  pdfPage?: number;
  score: number;
}

export interface KeywordMatch {
  line: number;
  text: string;
  ranges: Array<[number, number]>;
  pdfPage?: number;
  audioTimestampMs?: number;
}

export interface KeywordHitFile {
  path: string;
  matches: KeywordMatch[];
  totalMatches: number;
}

export interface KeywordSearchResult {
  query: string;
  folder: string;
  files: KeywordHitFile[];
  totalMatches: number;
  truncated: boolean;
}

/** One keyword-hit file from the library-wide sweep: `folder` is the
 *  absolute member folder root, `path` stays folder-relative. */
export interface LibraryKeywordFile extends KeywordHitFile {
  folder: string;
}

export interface LibraryKeywordSearchResult {
  files: LibraryKeywordFile[];
  totalMatches: number;
  truncated: boolean;
}

export type EmbedderProvider = 'openai' | 'openrouter';
export type EmbeddingSource = EmbedderProvider | 'stashbase-account';

export interface HostedQuota {
  plan: string;
  grantedTokens: number;
  usedTokens: number;
  reservedTokens: number;
  remainingTokens: number;
  periodStartedAt: string | null;
  periodEndsAt: string | null;
}

export interface HostedAccountState {
  signedIn: boolean;
  active: boolean;
  email?: string;
  quota?: HostedQuota;
  quotaUnavailable?: boolean;
  backfillStarted?: boolean;
}

export type HostedOAuthProvider = 'google';

export interface HostedOAuthStart {
  flowId: string;
  provider: HostedOAuthProvider;
  url: string;
}

export interface HostedOAuthStatus {
  state: 'pending' | 'complete' | 'error';
  error?: string;
  appReturned?: boolean;
}

export interface EmbedderState {
  provider: EmbedderProvider;
  hasKey: boolean;
  authorized: boolean;
  source: EmbeddingSource;
  model: string;
  account: HostedAccountState;
}

export interface McpHttpStatus {
  loopbackUrl: string;
  dockerUrl: string;
  dockerPort: number;
  token: string | null;
  dockerAccess: boolean;
  dockerActive: boolean;
  dockerError?: string;
  settingsError?: string;
}

export interface Agent {
  id: string;
  label: string;
  vendor: string;
  installHint: string;
  installed: boolean;
  /** Which executable discovery selected. `managed` lives under StashBase
   * AppData; `system` is an existing user installation. */
  source?: 'system' | 'managed' | null;
  bootstrap?: AgentBootstrapStatus;
  /** Full shell command the panel feeds to the shell once it's ready
   *  (e.g. `claude --theme light`). Built by the server from the agent
   *  registry so the renderer doesn't have to track per-agent flags. */
  launchCommand: string;
  /** Shared Agent Contract endpoint. Both current adapters use this common
   * bridge; `id` selects the native runtime. */
  endpoint?: string;
  state?: 'available' | 'unavailable' | 'failed';
  error?: string;
  capabilities?: {
    connection: true;
    prompts: true;
    interrupt: true;
    transcript: true;
    approvals: true;
    history: true;
    modes: boolean;
    effort: boolean;
    models: boolean;
    skills: boolean;
    steering: boolean;
    titleHint: boolean;
  };
}

export type AgentBootstrapPhase = 'idle' | 'installing' | 'authenticating' | 'configuring' | 'ready' | 'failed';
export type AgentBootstrapFailureStage = 'discovery' | 'installation' | 'authentication' | 'mcp';
export type AgentBootstrapFailureCode =
  | 'simulated'
  | 'operation-failed'
  | 'runtime-unavailable'
  | 'authentication-required'
  | 'authentication-check-failed';
export type AgentBootstrapManualRecovery = 'install-command' | 'mcp-settings';

export interface AgentBootstrapFailure {
  stage: AgentBootstrapFailureStage;
  code: AgentBootstrapFailureCode;
  message: string;
  retryable: boolean;
  manualRecovery?: AgentBootstrapManualRecovery;
}

export interface AgentBootstrapStatus {
  phase: AgentBootstrapPhase;
  progress?: number;
  message?: string;
  failure?: AgentBootstrapFailure;
}

export type AgentDiscoveryPolicy = 'auto' | 'managed-only' | 'system-only';
export type AgentSetupFailureSimulation = 'none' | 'installation' | 'mcp';

export interface AgentRuntimeDebugState {
  enabled: boolean;
  discoveryPolicy: AgentDiscoveryPolicy;
  nextFailure: AgentSetupFailureSimulation;
}

export interface AgentsResponse {
  clis: Agent[];
  debug?: AgentRuntimeDebugState;
}

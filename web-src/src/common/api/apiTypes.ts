/**
 * The renderer's view of the local HTTP API's contracts.
 *
 * Every declaration here now lives in `shared/`, which both processes
 * import, so this file is a re-export surface and nothing else. It exists
 * so renderer code keeps one import site (`@/common/api`) rather than
 * reaching into a different `@shared/` module per type, and so the renderer
 * never needs a path into `server/`.
 *
 * A new contract goes in the matching `shared/` module and gets a line
 * here. It does not get declared here: a type written in this file is a
 * contract only one side of the wire has agreed to.
 */
import type { LocalTranscriptionModelId } from '@shared/transcription';
export type { ConversionProgress } from '@shared/conversion';
export type { DirectTextFormat, ViewerFormat } from '@shared/file-formats';
export type {
  AgentBootstrapFailure,
  AgentBootstrapFailureCode,
  AgentBootstrapFailureStage,
  AgentBootstrapManualRecovery,
  AgentBootstrapPhase,
  AgentBootstrapStatus,
  Agent,
  AgentsResponse,
  AgentDiscoveryPolicy,
  AgentRuntimeDebugState,
  AgentSetupFailureSimulation,
  AgentTurnFailureSimulation,
} from '@shared/agent-runtime';
export type {
  HostedAccountActivation,
  HostedAccountState,
  HostedAgentAllowance,
  HostedOAuthProvider,
  HostedOAuthPurpose,
  HostedOAuthStart,
  HostedOAuthStatus,
  HostedQuota,
} from '@shared/account';
export type {
  ApiKeySaveResult,
  EmbedderProvider,
  EmbedderState,
  EmbeddingSource,
} from '@shared/embedding';
export type {
  AgentContextFile,
  FileBody,
  FileMeta,
  FilesPayload,
  GenericFilePreview,
  FolderMeta,
  FolderState,
  UploadResult,
  UploadResultEntry,
  WorkspaceEntryAvailability,
  WorkspaceFileKind,
} from '@shared/library-files';
export type { SessionBlock, SessionInfo, SessionReplay } from '@shared/agent-sessions';
export type { AgentInstructionsScope, AgentInstructionsState } from '@shared/agent-instructions';
export type { McpHttpStatus } from '@shared/mcp';
export type {
  AppearancePreferences,
  AppearanceScale,
  AppearanceTheme,
  CapturePreferences,
  OnboardingPreferences,
  UpdatePreferences,
  WorkspacePreferences,
} from '@shared/preferences';
export type {
  KeywordHitFile,
  KeywordMatch,
  KeywordSearchResult,
  LibraryKeywordFile,
  LibraryKeywordSearchResult,
  SearchHit,
} from '@shared/search-results';
export type { SyncResult } from '@shared/sync';
export type {
  IndexStatus,
  IndexWarning,
  PdfStatusEntry,
  PdfStatusKind,
  PreparationFailure,
  SemanticIndexingState,
  SemanticIndexingStatus,
} from '@shared/index-status';
export type {
  AudioPreviewStatus,
  AudioTranscript,
  AudioTranscriptSegment,
  AudioTranscriptState,
  LocalTranscriptionModelId,
  TranscriptionModelOperation,
  TranscriptionModelState,
  TranscriptionSettings,
} from '@shared/transcription';
export type TranscriptionModelId = LocalTranscriptionModelId;

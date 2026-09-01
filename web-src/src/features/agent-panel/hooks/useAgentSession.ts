import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, getWindowId } from '@/common/api/api';
import { AGENT_META, type AgentKind } from '@/common/lib/agentCatalog';
import { errorMessage } from '@/common/api/apiTransport';
import { electronBridge } from '@/common/lib/electronBridge';
import { openSettings } from '@/common/lib/settingsTrigger';
import { openEmbeddingSetup } from '@/common/lib/embeddingSetupTrigger';
import { onAgentInstructionsSaved } from '@/common/lib/agentInstructionsTrigger';
import { useLatestRef } from '@/common/hooks/useLatestRef';
import { useStateWithRef } from '@/common/hooks/useStateWithRef';
import type { Action, AppActions, ChatState, WorkspaceState } from '@/store/contexts/AppContext';
import { makeChatTab } from '@/store/state/state';
import { resolveAssistantLink } from '@/features/agent-panel/lib/assistantLinkTarget';
import type { TurnMeta } from '@/features/agent-panel/lib/turnModel';
import { agentConnectionUrl } from '@/features/agent-panel/lib/connectionUrl';
import { isBlankChatTab, newChatScope, nextSessionScope } from '@/features/agent-panel/lib/folderState';
import {
  libraryScopesEqual,
  LIBRARY_SCOPE,
  scopeChangedScope,
  scopeRequestParams,
  type LibraryScope,
} from '@/common/lib/libraryScope';
import { closeAgentSocketIntentionally, retireAgentTranscript, terminalAgentState } from '@/features/agent-panel/lib/connectionLifecycle';
import {
  appendRuntimeNotice,
  appendToolOutput,
  applyPermissionReply,
  appendFileDiff,
  completeToolCard,
  markToolAwaitingPermission,
  openToolCard,
  settleRunningTools,
} from '@/features/agent-panel/lib/transcriptEvents';
import { applyModelEvent } from '@/features/agent-panel/lib/modelState';
import { recordFailureBeforeContinuing, TurnErrorTracker, type TurnFailureActionId } from '@/features/agent-panel/lib/turnFailure';
import { nextBlockId } from '@/features/agent-panel/lib/blockIds';
import {
  isDefaultChatTitle,
  isSafeFolderRelativePath,
  shouldRefreshAfterTool,
  tabTitleFromSession,
} from '@/features/agent-panel/lib/agentSessionText';
import { useAgentControlState } from '@/features/agent-panel/hooks/useAgentControlState';
import { useAgentMentionListing } from '@/features/agent-panel/hooks/useAgentMentionListing';
import { useAgentPromptQueue, type QueuedPrompt } from '@/features/agent-panel/hooks/useAgentPromptQueue';
import { useAgentRuntimeCatalog } from '@/features/agent-panel/hooks/useAgentRuntimeCatalog';
import { useAgentSkills } from '@/features/agent-panel/hooks/useAgentSkills';
import { useAgentTabRegistration } from '@/features/agent-panel/hooks/useAgentTabRegistration';
import { useSessionFolderReconcile } from '@/features/agent-panel/hooks/useSessionFolderReconcile';
import { BUILD_WIKI_PAGES_PROMPT } from '@/features/agent-panel/lib/buildWikiPagesPrompt';
import type { Attachment, Block, RetiredAgentScope, ServerEvent } from '@/features/agent-panel/lib/types';

interface PendingBuildWikiPages {
  scope: Extract<LibraryScope, { kind: 'folder' }>;
  previousPickedScope: LibraryScope | undefined;
}

/** The whole "talk to the runtime" concern for one AgentView tab: WebSocket
 *  connection lifecycle, server-event routing, session reset/resume, and
 *  the transcript those produce. Pulled out of AgentView so the component
 *  itself is composition + JSX.
 *
 *  Socket transport and session lifecycle are deliberately ONE hook, not
 *  two, despite the Renderer Refactor Blueprint's initial split. They are
 *  circularly coupled in the real code: `handleEvent`'s 'error'/'exit' cases
 *  call `resetSessionState` synchronously in the same closure the WS
 *  `onclose` handler uses, and `resetSessionState`'s `startConnection` flag
 *  bumps the `nonce` the connect effect depends on. Separating them would
 *  mean threading session-lifecycle callbacks into the socket hook and
 *  socket refs back out to the session hook — strictly more indirection
 *  than the current single closure, for a seam that isn't real in this
 *  protocol. So the connect effect, `handleEvent`, `resetSessionState`, and
 *  `finishRendererSession` stay here together, and everything they can only
 *  reach through a ref or a callback is a sub-hook composed below:
 *
 *  - `useAgentRuntimeCatalog` — which runtime backs this tab and whether it
 *    is usable yet; the connect effect gates on its `runtimeBlocked`.
 *  - `useAgentControlState` — the composer's mode/effort/model/scope pills;
 *    they apply live or reconnect, so they take `wsRef`/`reconnect`/
 *    `resetSessionState` as injected params.
 *  - `useAgentMentionListing` — the session-scoped file listing behind
 *    `@`-mentions, re-fetched through `bumpSessionListing`.
 *  - `useAgentPromptQueue` — the outbound half (queued follow-ups, wire
 *    prompt building), driven back from `turn-end`/`steer-result`.
 *  - `useAgentSkills` — the one event with no lifecycle consequence.
 *  - `useSessionFolderReconcile` — the folder-sync policy the tool-result
 *    and turn-end cases fire and never wait on.
 *  - `useAgentTabRegistration` — this tab's two writes to the shared tab
 *    model: its blankness, and claiming a pending History resume.
 *
 *  The transcript rules those events imply are pure `Block[] -> Block[]`
 *  steps in `lib/transcriptEvents.ts`, so `handleEvent` below stays a
 *  dispatcher over the connection state machine.
 *
 *  Attachments and the runtime-readiness gate (the two pieces that only
 *  read this session read-only, without feeding back into it) split out as
 *  components of their own — see `useAgentAttachments` and
 *  `AgentRuntimeGate`.
 *
 *  The return groups by owner (`controls`, `queue`, `mentions`, `skills`,
 *  `runtime`, `transcript`) rather than flattening every sub-hook field:
 *  a flat object made this a re-export barrel and made `AgentView` re-thread
 *  ~50 props by hand. */
export function useAgentSession({
  active,
  id,
  title,
  agent,
  workspace,
  chat,
  dispatch,
  actions,
  attachments,
  attachmentsRef,
  clearComposerAttachments,
  discardAttachmentsForReset,
  initialScope,
}: {
  active: boolean;
  id: string;
  title: string;
  agent: AgentKind;
  workspace: WorkspaceState;
  chat: ChatState;
  dispatch: (a: Action) => void;
  actions: AppActions;
  attachments: Attachment[];
  attachmentsRef: RefObject<Attachment[]>;
  clearComposerAttachments: () => void;
  discardAttachmentsForReset: () => void;
  /** Optional first-connect override used by the scope-retirement action to
   * create a genuinely Library-scoped tab even when this window is browsing
   * another member folder. */
  initialScope?: LibraryScope;
}) {
  const meta = AGENT_META[agent];
  const folderPathRef = useLatestRef(workspace.folderPath);
  const [blocks, setBlocks, blocksRef] = useStateWithRef<Block[]>([]);
  const [turnActive, setTurnActive, turnActiveRef] = useStateWithRef(false);
  // Per-turn "Worked for X" data, keyed by the turn's user-message id.
  // Measured on the renderer wall clock (no duration exists on the wire);
  // `interrupted` is set when the user stops the turn. Resumed history has
  // no entry and renders no duration.
  const [turnMeta, setTurnMeta] = useState<Record<string, TurnMeta>>({});
  const turnStartRef = useRef<number | null>(null);
  const interruptedKeyRef = useRef<string | null>(null);
  // The prompt queue's single source of truth. `useAgentPromptQueue` owns
  // every mutation (and derives the rendered preview from it); the ref is
  // created here because the window-folder scope rule below must read the
  // pending follow-ups as content too.
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  // Connection lifecycle. `connecting` → waiting for the session to come
  // up; `live` → session ready, accepting prompts; `closed` → ended or
  // failed (see `fatal`). `nonce` bumps to force a reconnect.
  const [phase, setPhase] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [fatal, setFatal, fatalRef] = useStateWithRef<string | null>(null);
  const [fatalRecoveryLabel, setFatalRecoveryLabel] = useState<'Retry' | 'Reconnect'>('Retry');
  const [scopeRetired, setScopeRetired] = useState<RetiredAgentScope | null>(null);
  const [nonce, setNonce] = useState(0);
  const recentRef = useLatestRef(workspace.recent);
  // `resumeIdRef` holds a session id to resume on the next connect; it
  // rides the connect URL (like effort) and is consumed-and-cleared there.
  const resumeIdRef = useRef<string | null>(null);
  // One-shot override for a replacement/new connection that must bind to a
  // precise scope independent of the window's current folder. Consumed in
  // the same place as `resumeIdRef`, so it cannot leak into later retries.
  const nextConnectionScopeRef = useRef<LibraryScope | null>(initialScope ?? null);
  // The failed prompt to auto-resend once the replacement session is ready,
  // armed only by an acted-on failure card (sign-in / reconnect). Firing it
  // makes the recovery's outcome visible immediately: an answer when the
  // recovery stuck, a fresh failure card when it did not. Any other session
  // reset clears it so a stale retry can never land in a different session.
  const pendingRetryRef = useRef<{ text: string; attachments: Attachment[] } | null>(null);
  // A Build Wiki click is a tab-local intent. It survives Agent setup and
  // runtime reconnect, but never app restart, and pins the folder scope until
  // it sends or the user cancels. Semantic indexing has an independent lifecycle.
  const [pendingBuildWikiPages, setPendingBuildWikiPages, pendingBuildWikiPagesRef] = useStateWithRef<PendingBuildWikiPages | null>(null);
  // null follows product availability: configured Similarity Search starts
  // on; an explicitly disabled chat stays off even if credentials later change.
  // The effective policy is always false while no embedding source exists,
  // but text retrieval (including prepared documents) remains available.
  const [similaritySearchPreference, setSimilaritySearchPreference] = useState<boolean | null>(null);
  const similaritySearchEnabled = workspace.embedderHasKey === true
    && similaritySearchPreference !== false;
  const similaritySearchEnabledRef = useLatestRef(similaritySearchEnabled);
  // The permission mode the live connection was opened with (rode the
  // connect URL); `ready` re-sends `set-mode` only when the mode moved
  // while the connection was coming up.
  const connectAccessRef = useRef<string>('auto');
  // Refs mirror the live session id + this tab's id/title so the WS
  // message handler (bound once per connection) reads current values
  // when it renames the tab on the first turn-end.
  const sessionIdRef = useRef<string | null>(null);
  const idRef = useLatestRef(id);
  const titleRef = useLatestRef(title);
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const exitReceivedRef = useRef(false);
  const toolNamesRef = useRef<Map<string, string>>(new Map());
  // Which streaming block kind is currently "open" (so consecutive text
  // deltas append to one bubble; a tool call closes it).
  const openKind = useRef<'assistant' | 'thinking' | null>(null);
  const turnErrorTrackerRef = useRef(new TurnErrorTracker());

  function sendSimilaritySearchPolicy(enabled = similaritySearchEnabledRef.current) {
    wsRef.current?.send(JSON.stringify({ t: 'set-similarity-search', enabled }));
  }

  function changeSimilaritySearch(enabled: boolean) {
    setSimilaritySearchPreference(enabled);
    const effective = enabled && workspace.embedderHasKey === true;
    sendSimilaritySearchPolicy(effective);
    if (enabled && workspace.embedderHasKey !== true) openEmbeddingSetup();
  }

  // Completing or removing Similarity Search setup changes the effective policy without a
  // new Chat connection. Re-apply it live; the ready handler below covers
  // initial connection ordering.
  useEffect(() => {
    if (readyRef.current) sendSimilaritySearchPolicy(similaritySearchEnabled);
  }, [similaritySearchEnabled]);

  // The sub-hooks below take the refs above only where the core genuinely
  // co-owns them. `blocksRef`, `turnActiveRef`, `wsRef`, and `sessionIdRef`
  // are written by the connect effect / `handleEvent` / `resetSessionState`
  // and read by the pills and the queue, so their home is this closure.
  // `queuedPromptsRef` is the one ref a sub-hook fully owns and still cannot
  // hold: `useAgentPromptQueue` mutates it, but it must exist before
  // `useAgentControlState` (whose follow/freeze rule reads it as content),
  // and the queue in turn needs that hook's `connectedScopeRef` — a cycle
  // only a ref created here can break. Everything else a sub-hook alone
  // reads now lives in that sub-hook.
  const runtimeCatalog = useAgentRuntimeCatalog({ agent, meta, agents: chat.agents, dispatch, actions });
  const controls = useAgentControlState({
    agent,
    workspace,
    capabilities: runtimeCatalog.capabilities,
    blocks,
    turnActive,
    blocksRef,
    turnActiveRef,
    queuedPromptsRef,
    attachmentsRef,
    sessionIdRef,
    wsRef,
    reconnect,
    resetSessionState,
  });
  const mentions = useAgentMentionListing({
    connectedScope: controls.connectedScope,
    workspace,
    disabled: scopeRetired !== null,
  });
  const promptQueue = useAgentPromptQueue({
    agentShortName: meta.shortName,
    capabilitiesRef: runtimeCatalog.capabilitiesRef,
    attachmentsRef,
    clearComposerAttachments,
    titleRef,
    queuedPromptsRef,
    turnActiveRef,
    setTurnBusy,
    setBlocks,
    openKindRef: openKind,
    wsRef,
    stop,
    knownFilePathsRef: mentions.knownFilePathsRef,
    sessionFolder,
  });

  function maybeSendPendingBuildWikiPages() {
    const pending = pendingBuildWikiPagesRef.current;
    if (!pending || !readyRef.current || turnActiveRef.current) return;
    if (!libraryScopesEqual(controls.connectedScopeRef.current, pending.scope)) return;
    // Clear before the send so a repeated ready event cannot duplicate the
    // product-owned turn.
    setPendingBuildWikiPages(null);
    promptQueue.sendPreset(BUILD_WIKI_PAGES_PROMPT);
  }

  /* Agent Instructions edited for some scope. The resolved text is injected
   * when a native session MOUNTS, so there is no live setter to call — applying
   * an edit means remounting, exactly the move a thinking-effort change
   * makes. Resume in place when the conversation has content so the
   * transcript survives; a blank chat just starts again.
   *
   * Deferred rather than immediate while a turn is in flight: remounting
   * mid-turn would strand the reply being streamed. The armed flag then
   * lands at turn-end, which is the next moment the guidance can matter. */
  const [, setInstructionsStale, instructionsStaleRef] = useStateWithRef(false);

  function maybeApplyAgentInstructions() {
    if (!instructionsStaleRef.current || !readyRef.current || turnActiveRef.current) return;
    // Cleared BEFORE the reset so the `ready` this triggers cannot arm a
    // second remount and loop.
    setInstructionsStale(false);
    if (blocksRef.current.length > 0 && sessionIdRef.current) {
      resetSessionState({ resumeId: sessionIdRef.current });
    } else {
      reconnect();
    }
  }

  function handleAgentInstructionsSaved(scope: Extract<LibraryScope, { kind: 'folder' }>) {
    // The editor edits a scope; this session only cares when that scope is
    // the one it actually connected with.
    if (!libraryScopesEqual(controls.connectedScopeRef.current, scope)) return;
    setInstructionsStale(true);
    maybeApplyAgentInstructions();
  }

  const agentInstructionsSavedRef = useLatestRef(handleAgentInstructionsSaved);
  useEffect(
    () => onAgentInstructionsSaved((scope) => agentInstructionsSavedRef.current(scope)),
    [agentInstructionsSavedRef],
  );

  /** Pin this blank chat to its folder and arm one Build Wiki turn. */
  function requestBuildWikiPages(): boolean {
    const scope = controls.sessionScope;
    if (scope.kind !== 'folder' || pendingBuildWikiPagesRef.current) return false;
    setPendingBuildWikiPages({
      scope,
      previousPickedScope: controls.pickedScopeRef.current,
    });
    // Even when this is the window-default folder, retain an explicit pick so
    // Agent setup or a window-folder switch cannot redirect the intent.
    controls.setPickedScope(scope);
    maybeSendPendingBuildWikiPages();
    return true;
  }

  function cancelBuildWikiPages() {
    const pending = pendingBuildWikiPagesRef.current;
    if (!pending) return;
    controls.setPickedScope(pending.previousPickedScope);
    setPendingBuildWikiPages(null);
  }
  const skills = useAgentSkills({ phase, wsRef });
  const reconcileSessionFolder = useSessionFolderReconcile({
    sessionFolder,
    folderPathRef,
    actions,
    bumpSessionListing: mentions.bumpSessionListing,
  });

  useEffect(() => {
    return () => {
      setAgentComposerFocused(false);
    };
  }, []);

  function setAgentComposerFocused(focused: boolean) {
    electronBridge()?.setAgentComposerFocused?.(focused);
  }

  /** Tell every OTHER window's sidebar the library gained a member (the
   *  owning window refreshes through its own openFolder). Desktop-only; the
   *  browser dev shell has one window and needs no broadcast. */
  function notifyLibraryFolderAdded(path: string) {
    void electronBridge()?.notifyLibraryFolderAdded?.(path);
  }

  /** The folder this session's file operations resolve against: the bound
   *  scope's folder for a folder-scoped tab, else the window's current
   *  folder. Null for a library chat in a window with no folder open. One
   *  definition so attachment resolution and folder reconcile can never
   *  disagree about which folder a cross-folder tab means. */
  function sessionFolder(): string | null {
    const boundScope = controls.connectedScopeRef.current;
    return (boundScope?.kind === 'folder' ? boundScope.path : folderPathRef.current) || null;
  }

  /** The current turn's identity = its user-message id (stable for the
   *  turn's whole life, unlike the streaming block that keeps changing). */
  function currentTurnKey(): string | null {
    const bs = blocksRef.current;
    for (let i = bs.length - 1; i >= 0; i--) if (bs[i].kind === 'user') return bs[i].id;
    return null;
  }

  function setTurnBusy(active: boolean): void {
    const was = turnActiveRef.current;
    setTurnActive(active);
    if (!was && active) {
      // Turn began: start the wall clock.
      turnStartRef.current = Date.now();
    } else if (was && !active && turnStartRef.current != null) {
      // Turn settled: attribute the elapsed time (and any interrupt) to it,
      // keyed by its user message, for the "Worked for X" header.
      const key = currentTurnKey();
      if (key) {
        const durationMs = Date.now() - turnStartRef.current;
        // Capture before clearing the ref below. React may execute this state
        // updater after the current call stack; reading the ref inside it made
        // an interrupted edit-and-resend turn render as ordinary "Worked".
        const interrupted = interruptedKeyRef.current === key;
        setTurnMeta((prev) => ({ ...prev, [key]: { durationMs, interrupted, settledAt: Date.now() } }));
      }
      turnStartRef.current = null;
      interruptedKeyRef.current = null;
    }
  }

  /** The one session-reset path. All resets share the same core — drop
   *  queued prompts, forget in-flight tool names, close the open stream
   *  block, settle the turn — and each caller states only its deltas
   *  through the named options. */
  function resetSessionState({
    transcript = 'keep',
    clearAttachments = false,
    forgetNativeSession = false,
    adoptSessionId,
    resumeId,
    modelReset,
    turnStillActive = false,
    nextFatal = null,
    recoveryLabel = 'Retry',
    nextPhase = 'connecting',
    startConnection = true,
  }: {
    /** 'keep' retains the visible transcript (a fatal reconnect keeps the
     *  conversation for context); 'clear' empties it; an array replaces it
     *  with replayed history; a function maps the current blocks (terminal
     *  close settles still-running tool cards). Clearing or replacing also
     *  drops per-turn "Worked for X" entries whose user-message blocks left
     *  the transcript, so dead keys never accumulate and replayed history
     *  never inherits an invented duration. */
    transcript?: 'keep' | 'clear' | Block[] | ((current: Block[]) => Block[]);
    /** The composer owns its attachment chips: empty them AND revoke their
     *  image object-URLs together, so no chip is ever left rendering a dead
     *  URL. Only safe when the transcript that may still show the same
     *  thumbnails is cleared or replaced. A fatal reconnect and a terminal
     *  close keep the composer intact (draft and chips survive for the
     *  retry), so they leave this off. */
    clearAttachments?: boolean;
    /** Drop the native session identity and its restored-session flags —
     *  the next connect starts a brand-new session. */
    forgetNativeSession?: boolean;
    /** Adopt a native session id (resuming replayed history). */
    adoptSessionId?: string;
    /** Session id the next connect should resume (may be null: a fatal
     *  reconnect forwards whatever id the dead session had). */
    resumeId?: string | null;
    /** 'new-session' clears live telemetry so a fresh session cannot wear
     *  the old session's active model; 'resumed' drops the previous tab's
     *  catalog and explicit choice until native replay publishes identity. */
    modelReset?: 'new-session' | 'resumed';
    /** Whether the current turn survives the reset. No caller keeps one
     *  alive today; the default settles it. */
    turnStillActive?: boolean;
    /** Fatal message the pane shows after the reset (null clears one). */
    nextFatal?: string | null;
    recoveryLabel?: 'Retry' | 'Reconnect';
    /** Connection phase after the reset. */
    nextPhase?: 'connecting' | 'closed';
    /** Bump the connect nonce so the socket effect starts a new session. */
    startConnection?: boolean;
  }): void {
    if (clearAttachments) {
      discardAttachmentsForReset();
    }
    if (transcript !== 'keep') {
      const nextBlocks = transcript === 'clear'
        ? []
        : typeof transcript === 'function' ? transcript(blocksRef.current) : transcript;
      setBlocks(nextBlocks);
      // `turnMeta` is keyed by the turn's user-message block id. Trim it to
      // the blocks that survive: 'clear' drops every entry, replayed history
      // carries fresh ids (so stale durations vanish; resumed turns render
      // none), and a mapping function preserves ids (entries stay).
      setTurnMeta((prev) => {
        const kept: Record<string, TurnMeta> = {};
        for (const block of nextBlocks) {
          if (block.kind === 'user' && prev[block.id]) kept[block.id] = prev[block.id];
        }
        return kept;
      });
    }
    promptQueue.clearQueue();
    pendingRetryRef.current = null;
    toolNamesRef.current.clear();
    openKind.current = null;
    setTurnBusy(turnStillActive);
    setFatal(nextFatal);
    setFatalRecoveryLabel(recoveryLabel);
    setScopeRetired(null);
    if (forgetNativeSession) {
      sessionIdRef.current = null;
      controls.setRestoredClaudeSession(false);
      controls.setEffortInherited(false);
    }
    if (adoptSessionId !== undefined) sessionIdRef.current = adoptSessionId;
    if (resumeId !== undefined) resumeIdRef.current = resumeId;
    if (modelReset === 'new-session') {
      controls.setModelControl((current) => ({ ...current, activeModel: undefined, resumedSession: false }));
    } else if (modelReset === 'resumed') {
      controls.setModelControl({ models: [], notice: null, resumedSession: true });
    }
    setPhase(nextPhase);
    if (startConnection) setNonce((n) => n + 1);
  }

  function finishRendererSession({
    ready,
    exitReceived,
    message,
  }: {
    ready: boolean;
    exitReceived: boolean;
    message?: string;
  }) {
    const input = {
      ready,
      exitReceived,
      agentShortName: meta.shortName,
      message,
      currentFatal: fatalRef.current,
    };
    const terminal = terminalAgentState({ ...input, blocks: [] });
    resetSessionState({
      transcript: (currentBlocks) => terminalAgentState({ ...input, blocks: currentBlocks }).blocks,
      nextFatal: terminal.fatal,
      recoveryLabel: terminal.recoveryLabel,
      nextPhase: terminal.phase,
      startConnection: false,
    });
  }

  /** A removed member folder is an expected authorization/lifecycle change,
   * not a runtime crash. Completely blank tabs can safely become fresh
   * Library sessions in place; every form of user work stays visible in a
   * retired, non-reconnectable conversation. */
  function retireRemovedScope(folder: string) {
    if (pendingBuildWikiPagesRef.current?.scope.path === folder) setPendingBuildWikiPages(null);
    const completelyBlank = isBlankChatTab({
      hasContent: blocksRef.current.length > 0 || queuedPromptsRef.current.length > 0,
      turnActive: turnActiveRef.current,
      resumedSession: controls.modelControlRef.current.resumedSession,
      picked: controls.pickedScopeRef.current,
      hasDraftText: controls.hasDraftTextRef.current,
      attachmentCount: attachmentsRef.current.length,
    });
    if (completelyBlank) {
      nextConnectionScopeRef.current = LIBRARY_SCOPE;
      controls.setPickedScope(undefined);
      controls.setConnectedScope(LIBRARY_SCOPE);
      dispatch({ type: 'CHAT_TAB_SET_SCOPE', id: idRef.current, folder: null });
      resetSessionState({
        transcript: 'clear',
        forgetNativeSession: true,
        modelReset: 'new-session',
      });
      return;
    }

    // Preserve transcript, queued follow-ups, draft, attachment chips, tab,
    // and native history identity. Only live work is retired.
    interruptedKeyRef.current = currentTurnKey();
    setBlocks((current) => retireAgentTranscript(current));
    promptQueue.retireQueue();
    pendingRetryRef.current = null;
    toolNamesRef.current.clear();
    openKind.current = null;
    setTurnBusy(false);
    setFatal(null);
    setFatalRecoveryLabel('Retry');
    setScopeRetired({ folder });
    setPhase('closed');
    controls.setConnectedScope({ kind: 'folder', path: folder });
    dispatch({ type: 'CHAT_TAB_SET_SCOPE', id: idRef.current, folder });
  }

  useEffect(() => {
    if (!runtimeCatalog.runtime) {
      readyRef.current = false;
      setPhase('connecting');
      setFatal(null);
      setFatalRecoveryLabel('Retry');
      return;
    }
    // Discovery is authoritative once it has returned. Do not open a socket
    // for a known-missing CLI: the setup card below is the actionable state,
    // rather than a generic connection failure.
    if (runtimeCatalog.runtimeBlocked) {
      readyRef.current = false;
      setPhase('closed');
      setFatal(null);
      setFatalRecoveryLabel('Retry');
      return;
    }
    readyRef.current = false;
    exitReceivedRef.current = false;
    // Consume-and-clear the resume id: it belongs to this one connection,
    // so a later reconnect (Retry / effort change) starts fresh instead of
    // re-resuming.
    const resume = resumeIdRef.current;
    resumeIdRef.current = null;
    const forcedScope = nextConnectionScopeRef.current;
    nextConnectionScopeRef.current = null;
    // Bind this session's scope explicitly: the user's pick, else the
    // window's current folder, else the whole library. Recorded here so a
    // later window-folder switch can never rebind a started conversation.
    const sessionScopeForConnect = forcedScope ?? nextSessionScope(
      controls.pickedScopeRef.current,
      folderPathRef.current,
      recentRef.current.map((entry) => entry.path),
    );
    controls.setConnectedScope(sessionScopeForConnect);
    // Mirror the binding into the tab model: the window-folder switch
    // logic skips spawning a welcome tab when the active chat already
    // targets the new folder.
    dispatch({
      type: 'CHAT_TAB_SET_SCOPE',
      id: idRef.current,
      folder: sessionScopeForConnect.kind === 'folder' ? sessionScopeForConnect.path : null,
    });
    const endpoint = runtimeCatalog.runtime?.endpoint ?? '/ws/agent';
    connectAccessRef.current = controls.modeRef.current;
    const wsUrl = agentConnectionUrl({
      protocol: location.protocol, host: location.host, endpoint,
      windowId: getWindowId(), effort: controls.effortRef.current, access: controls.modeRef.current,
      agent, model: controls.modelControlRef.current.selectedModel ?? undefined, resume,
      ...scopeRequestParams(sessionScopeForConnect),
    });
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      handleEvent(ev);
    };
    ws.onclose = () => {
      const wasReady = readyRef.current;
      const sawExit = exitReceivedRef.current;
      // A protocol exit already owns the terminal transition (and any fatal
      // cause). The server closes the socket immediately afterward, before
      // React may have committed the fatal state, so terminalizing again here
      // could erase the message with a stale fatalRef.
      if (sawExit) return;
      finishRendererSession({ ready: wasReady, exitReceived: sawExit });
      if (!wasReady) runtimeCatalog.refreshRuntimes();
    };

    return () => {
      closeAgentSocketIntentionally(ws);
    };
  }, [nonce, runtimeCatalog.runtime?.endpoint, runtimeCatalog.runtimeBlocked, agent, meta.shortName]);

  /** Tear down and start a fresh session (Retry button / after the user
   *  reopens a folder). */
  function reconnect(): void {
    resetSessionState({
      transcript: 'clear',
      clearAttachments: true,
      forgetNativeSession: true,
      modelReset: 'new-session',
    });
  }

  /** A fatal runtime reconnect keeps the transcript available for context and
   * diagnosis. The dead native session cannot be resumed implicitly, but the
   * visible conversation must not disappear as the replacement connects.
   * The composer keeps its draft and attachment chips for the same reason:
   * the user retries the send, not the setup. */
  function reconnectAfterFatal() {
    resetSessionState({ resumeId: sessionIdRef.current });
  }

  /** In-transcript recovery for an expired Codex sign-in. Starting the login
   * flips the bootstrap phase, which closes the live socket and reopens one
   * when the runtime is ready again (`runtimeBlocked` gates the connect
   * effect). Stashing the session id first makes that reopen resume the same
   * native thread — with the transcript kept — instead of starting blank. */
  function signInToCodexFromTurnFailure() {
    if (agent !== 'codex') return;
    resumeIdRef.current = sessionIdRef.current;
    void runtimeCatalog.loginToCodex();
  }

  /** An acted-on failure card first settles to a plain message — its button
   * and guidance describe a state the action is about to change, and a stale
   * "Sign in"/"Reconnect"/"Try again" must not outlive it. The failed prompt
   * is then auto-resent — immediately for `resend` (quota, rate, network
   * clear on the provider side), or once the replacement session is ready
   * for the sign-in/reconnect recoveries — so the outcome is visible without
   * retyping: an answer when the recovery stuck, a fresh card when not. */
  function handleTurnFailureAction(blockId: string, action: TurnFailureActionId) {
    setBlocks((bs) => bs.map((b) => (
      b.kind === 'error' && b.id === blockId ? { kind: 'error', id: b.id, text: b.text } : b
    )));
    // The retry is the prompt of the turn THIS card settled — the nearest
    // user block above the card, not the transcript's newest. A failure
    // never ends the session, so the user may have kept chatting before
    // acting on an older card.
    const bs = blocksRef.current;
    const cardIndex = bs.findIndex((b) => b.id === blockId);
    let cardUser: Extract<Block, { kind: 'user' }> | null = null;
    for (let i = (cardIndex >= 0 ? cardIndex : bs.length) - 1; i >= 0; i--) {
      const candidate = bs[i];
      if (candidate.kind === 'user') { cardUser = candidate; break; }
    }
    const retry = cardUser ? { text: cardUser.text, attachments: cardUser.attachments ?? [] } : null;
    if (action === 'resend') {
      if (retry) promptQueue.resendFailedPrompt(retry);
      return;
    }
    if (action === 'open-agent-settings') {
      // Account/allowance recovery completes outside this view. Keep the
      // failed prompt armed so the runtime's account-change reconnect can
      // retry it exactly once when Built-in becomes ready again.
      if (retry) pendingRetryRef.current = retry;
      openSettings('agents');
      return;
    }
    if (action === 'codex-sign-in') signInToCodexFromTurnFailure();
    else reconnectAfterFatal();
    // Arm AFTER the reset: resetSessionState clears any pending retry.
    if (retry) pendingRetryRef.current = retry;
  }

  /** Open a past session from the sidebar's History menu: paint its
   *  transcript, then reconnect with `resume` so the SDK appends to it and
   *  the user can keep chatting. Unlike `reconnect`, blocks are
   *  pre-populated (not cleared) with the replayed history. `scope` is the
   *  scope the History menu was scoped to; the tab's binding pins to it so
   *  the reconnect below carries the same scope — a resumed session always
   *  keeps its own scope. */
  async function resumeSession(resumeSessionId: string, scope: LibraryScope) {
    let hist: Block[] = [];
    try {
      const replay = await api.getSessionReplay(resumeSessionId, agent, scopeRequestParams(scope));
      hist = replay.messages as Block[];
      controls.setEffort(agent === 'claude' ? replay.effort ?? undefined : undefined);
      controls.setRestoredClaudeSession(agent === 'claude');
      controls.setEffortInherited(agent === 'claude' && replay.effort === null);
    } catch {
      actions.toast('Could not load that session.', { level: 'error' });
      return;
    }
    controls.setPickedScope(libraryScopesEqual(scope, newChatScope(folderPathRef.current)) ? undefined : scope);
    resetSessionState({
      transcript: hist,
      clearAttachments: true,
      adoptSessionId: resumeSessionId,
      resumeId: resumeSessionId,
      // The previous tab may have been configured for another model; the
      // 'resumed' reset clears it so the locked resumed chat cannot
      // mislabel itself. No notice line: the locked model pill (and its
      // tooltip) already says the session keeps its own model — notices
      // are for failures only.
      modelReset: 'resumed',
    });
    // Name the tab from the resumed session right away — otherwise a tab
    // opened to a past session keeps its "New Chat" placeholder until the
    // user sends a prompt (the `turn-end` path that usually renames never
    // fires on a pure load). Safe: `maybeNameTab` only overwrites a placeholder.
    void maybeNameTab();
  }

  function handleEvent(ev: ServerEvent) {
    switch (ev.t) {
      case 'ready':
        readyRef.current = true;
        // Policy precedes every prompt sent from this ready transition, so a
        // pending Build Wiki or recovery turn cannot race the server default.
        sendSimilaritySearchPolicy();
        setPhase('live');
        runtimeCatalog.refreshRuntimes();
        // Starting a built-in agent can create root-level instruction files
        // (`AGENTS.md`, and for Claude the `CLAUDE.md` bridge). Refresh the
        // tree immediately instead of waiting for the next index-status poll;
        // a cross-folder session refreshes its own folder's listing too.
        // (Library-wide sessions write no instruction files and have no
        // folder listing of their own.)
        if (folderPathRef.current) void actions.loadFiles(folderPathRef.current);
        if (controls.connectedScopeRef.current?.kind === 'folder' && controls.connectedScopeRef.current.path !== folderPathRef.current) {
          mentions.bumpSessionListing();
        }
        // The session came up with the mode that rode the connect URL; if
        // the user switched modes while the connection was coming up,
        // re-apply the current pick so it isn't silently lost. Read through
        // the ref: this handler is bound once per connection and must see
        // the mode as of ready time, not connect time.
        if (controls.modeRef.current !== connectAccessRef.current) {
          wsRef.current?.send(JSON.stringify({ t: 'set-mode', mode: controls.modeRef.current }));
        }
        // A recovery action armed the failed prompt for one auto-retry on
        // the replacement session; send it through the normal prompt path
        // so its outcome (answer or fresh failure card) is a regular turn.
        {
          const retry = pendingRetryRef.current;
          pendingRetryRef.current = null;
          if (retry) promptQueue.resendFailedPrompt(retry);
        }
        maybeSendPendingBuildWikiPages();
        maybeApplyAgentInstructions();
        break;
      case 'session-id':
        sessionIdRef.current = ev.id;
        break;
      case 'models':
        controls.setModelControl((current) => applyModelEvent(current, ev));
        break;
      case 'skills': skills.handleSkillsEvent(ev); break;
      case 'session-title':
        if (isDefaultChatTitle(titleRef.current)) {
          const t = tabTitleFromSession(ev.title);
          if (t) dispatch({ type: 'CHAT_TAB_RENAME', id: idRef.current, title: t });
        }
        break;
      case 'turn-start':
        openKind.current = null;
        turnErrorTrackerRef.current.start();
        setTurnBusy(true);
        break;
      case 'text':
        appendStream('assistant', ev.delta);
        break;
      case 'thinking':
        appendStream('thinking', ev.delta);
        break;
      case 'tool':
        openKind.current = null;
        toolNamesRef.current.set(ev.id, ev.name);
        setBlocks((bs) => openToolCard(bs, ev));
        break;
      case 'tool-delta':
        setBlocks((bs) => appendToolOutput(bs, ev));
        break;
      case 'tool-result':
        setBlocks((bs) => completeToolCard(bs, ev));
        if (!ev.isError) {
          const toolName = toolNamesRef.current.get(ev.id);
          if (shouldRefreshAfterTool(toolName)) {
            // Mid-turn: reload the window tree too, and surface a failed
            // reload — the user is watching files land while the turn runs.
            void reconcileSessionFolder({ reloadWindowTree: true }).catch((err) => {
              actions.toast(`Could not refresh files: ${errorMessage(err)}`, { level: 'error' });
            });
          }
        }
        toolNamesRef.current.delete(ev.id);
        break;
      case 'file-diff':
        setBlocks((bs) => appendFileDiff(bs, ev));
        void reconcileSessionFolder({ reloadWindowTree: true }).catch((err) => {
          actions.toast(`Could not refresh files: ${errorMessage(err)}`, { level: 'error' });
        });
        break;
      case 'permission':
        openKind.current = null;
        setBlocks((bs) => markToolAwaitingPermission(bs, ev));
        break;
      case 'steer-result':
        promptQueue.setQueuedPromptStatus(ev.id, ev.ok ? 'steered' : 'waiting');
        if (!ev.ok) {
          if (ev.message) {
            setBlocks((bs) => [...bs, { kind: 'error', id: nextBlockId(), text: `Could not steer Codex: ${ev.message}` }]);
          }
          // A steer that lost its turn (ended mid-flight) re-queues as
          // 'waiting'; with no turn running nothing else would ever send
          // it, so run the queue now.
          if (!turnActiveRef.current) promptQueue.runNextQueuedPrompt();
        }
        break;
      case 'scope-changed': {
        // The server migrated this session's binding (create_project from a
        // library-scoped chat): flip the pill/header to the project and have
        // THIS window — the one owning the chat — select it in the sidebar,
        // exactly as if the user had clicked the new library entry. Other
        // windows only receive the membership update.
        const next = scopeChangedScope(ev.scope);
        if (!next || next.kind !== 'folder') break;
        controls.setConnectedScope(next);
        // Update the tab-model binding BEFORE opening the folder, so the
        // switch effect sees the active tab already bound to the project
        // and does not activate a welcome tab over this conversation.
        dispatch({ type: 'CHAT_TAB_SET_SCOPE', id: idRef.current, folder: next.path });
        notifyLibraryFolderAdded(next.path);
        if (folderPathRef.current !== next.path) {
          void actions.openFolder(next.path).catch((err) => {
            actions.toast(`Could not open the new project: ${errorMessage(err)}`, { level: 'error' });
          });
        }
        break;
      }
      case 'notice':
        setBlocks((bs) => appendRuntimeNotice(bs, ev, nextBlockId()));
        break;
      case 'turn-end': {
        const terminal = turnErrorTrackerRef.current.finish(ev.isError);
        if (terminal.duplicate) break;
        openKind.current = null;
        setBlocks((bs) => settleRunningTools(bs, ev.isError));
        toolNamesRef.current.clear();
        // Name the tab from the session's derived title (first prompt /
        // SDK summary) once the first turn lands — keeps it in sync with
        // the History list instead of staying "New Chat".
        void maybeNameTab();
        // The agent may have written files via shell during the turn —
        // reconcile now (deterministic, replaces fs.watch). MCP writes
        // already index on their own path; this catches `Bash`/editor
        // writes the moment the turn finishes. No tree reload here (the
        // poll owns it) and nothing can reject, so no error surface.
        void reconcileSessionFolder({ reloadWindowTree: false });
        recordFailureBeforeContinuing(
          terminal,
          (message) => setBlocks((bs) => [...bs, { kind: 'error', id: nextBlockId(), text: message }]),
          promptQueue.runNextQueuedPrompt,
        );
        maybeSendPendingBuildWikiPages();
        maybeApplyAgentInstructions();
        break;
      }
      case 'error':
        openKind.current = null;
        // Runtime bridges record terminal failures in the shared catalog.
        // Refresh for both startup and active-session errors: regular turn
        // errors leave the descriptor unchanged, while an app-server exit
        // immediately flips the runtime's descriptor from available to failed.
        runtimeCatalog.refreshRuntimes();
        // An error before the session is ready is fatal (e.g. no folder
        // open / not authenticated); mid-session it's just a notice.
        if (!readyRef.current) {
          resetSessionState({ nextFatal: ev.message, nextPhase: 'closed', startConnection: false });
        } else {
          turnErrorTrackerRef.current.explain();
          setBlocks((bs) => [...bs, {
            kind: 'error', id: nextBlockId(), text: ev.message,
            ...(ev.failure ? { failureKind: ev.failure.kind } : {}),
          }]);
        }
        break;
      case 'exit':
        exitReceivedRef.current = true;
        if (ev.reason === 'scope-removed') {
          retireRemovedScope(ev.folder);
          break;
        }
        finishRendererSession({ ready: readyRef.current, exitReceived: true, message: ev.message });
        if (ev.message) runtimeCatalog.refreshRuntimes();
        break;
    }
  }

  function appendStream(kind: 'assistant' | 'thinking', delta: string) {
    // Capture the stream boundary before scheduling React state. Several WS
    // messages can arrive in one task, and turn-end/tool handling mutates the
    // ref synchronously while React is still batching these updaters. Reading
    // the ref inside the updater can therefore discard or split an earlier
    // delta when completion follows immediately after it.
    const appendToOpenBlock = openKind.current === kind;
    openKind.current = kind;
    setBlocks((bs) => {
      const last = bs[bs.length - 1];
      if (appendToOpenBlock && last?.kind === kind) {
        const next = bs.slice();
        next[next.length - 1] = { ...last, text: last.text + delta };
        return next;
      }
      return [...bs, { kind, id: nextBlockId(), text: delta }];
    });
  }

  function copyUserMessage(text: string) {
    void navigator.clipboard.writeText(text)
      .then(() => actions.toast('Copied.', { level: 'info' }))
      .catch(() => actions.toast('Could not copy message.', { level: 'error' }));
  }

  function stop(): void {
    // Remember which turn the user interrupted so its settle records it as
    // "You stopped after X" rather than "Worked for X".
    interruptedKeyRef.current = currentTurnKey();
    wsRef.current?.send(JSON.stringify({ t: 'interrupt' }));
  }

  /** The retired conversation remains untouched. Start a separate tab whose
   * first connection is explicitly Library-scoped, even if this window is
   * currently browsing another member folder. */
  function startLibraryChat(): void {
    const tab = { ...makeChatTab(agent, chat.chatTabs), boundFolder: null };
    dispatch({ type: 'CHAT_TAB_NEW', tab });
  }

  /** Rename this tab from the session's server-derived title once the
   *  first turn lands. Only fires while the tab still wears its
   *  "New Chat" placeholder, so a user-set name (or a later turn) never
   *  clobbers it. Uses the same source as the History list, so the two
   *  stay consistent. */
  async function maybeNameTab() {
    const tabId = idRef.current;
    const sid = sessionIdRef.current;
    if (!tabId || !sid || !isDefaultChatTitle(titleRef.current)) return;
    try {
      const nameScope = controls.connectedScopeRef.current ?? newChatScope(folderPathRef.current);
      const sessions = await api.listSessions(agent, scopeRequestParams(nameScope));
      const t = tabTitleFromSession(sessions.find((x) => x.id === sid)?.title ?? '');
      if (t && !isDefaultChatTitle(t)) {
        dispatch({ type: 'CHAT_TAB_RENAME', id: tabId, title: t });
      }
    } catch { /* leave the placeholder if the lookup fails */ }
  }

  function replyPermission(toolBlockId: string, permId: string, allow: boolean) {
    wsRef.current?.send(JSON.stringify({ t: 'permission-reply', id: permId, allow }));
    setBlocks((bs) => applyPermissionReply(bs, toolBlockId, allow));
  }

  /** Cross-file link nav from an assistant message: resolve, then open a
   *  folder / select a file the same way the sidebar would. */
  function openArtifactLink(path: string) {
    const action = resolveAssistantLink(path, {
      scopeFolder: controls.connectedScopeRef.current?.kind === 'folder' ? controls.connectedScopeRef.current.path : null,
      windowFolder: folderPathRef.current || null,
      members: workspace.recent.map((entry) => entry.path),
    });
    if (!action) return;
    if (action.kind === 'open-folder') {
      void actions.openFolder(action.path);
      return;
    }
    if (!isSafeFolderRelativePath(action.rel)) return;
    if (action.folder === folderPathRef.current) {
      void actions.selectFile(action.rel);
      return;
    }
    // The file lives in another member folder: switch the browse
    // location first, then select it there.
    void actions.openFolder(action.folder).then(() => actions.selectFile(action.rel));
  }

  // A COMPLETELY blank tab (no transcript, no active turn, not resumed, no
  // picked scope, no draft text, no attachments) is the reusable welcome tab
  // for New Chat and window-folder switches.
  const blankNow = isBlankChatTab({
    hasContent: blocks.length > 0 || promptQueue.queuedTurns.length > 0,
    turnActive,
    resumedSession: controls.modelControl.resumedSession,
    picked: controls.pickedScope,
    hasDraftText: controls.hasDraftText,
    attachmentCount: attachments.length,
  });
  useAgentTabRegistration({ id, active, agent, blank: blankNow, chat, dispatch, resumeSession });

  return {
    meta,
    runtime: runtimeCatalog,
    controls,
    queue: promptQueue,
    mentions,
    skills,
    wiki: {
      pending: pendingBuildWikiPages !== null,
      requestBuildWikiPages,
      cancelBuildWikiPages,
    },
    similaritySearch: {
      enabled: similaritySearchEnabled,
      availabilityKnown: workspace.embedderHasKey !== null,
      change: changeSimilaritySearch,
    },
    transcript: {
      blocks,
      turnActive,
      turnMeta,
      phase,
      fatal,
      fatalRecoveryLabel,
      scopeRetired,
      stop,
      reconnect,
      reconnectAfterFatal,
      startLibraryChat,
      handleTurnFailureAction,
      replyPermission,
      copyUserMessage,
      openArtifactLink,
      setAgentComposerFocused,
    },
  };
}

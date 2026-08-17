/**
 * Structured chat view for an agent tab — the VSCode-extension-style
 * panel. Both Claude (Agent SDK) and Codex (app-server) connect through the
 * Shared Agent Contract at `/ws/agent`; their adapters live in server.
 * Both render the event stream as ordered blocks:
 * user / assistant bubbles, collapsible thinking, tool cards with
 * inline diffs + approve/reject, and error notices. A composer at the
 * bottom sends prompts, stops a running turn, takes dropped files, and
 * `@`-mentions library files.
 *
 * See design-docs/architecture.md §8 for the shared library path.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, getWindowId, type Agent, type AgentContextFile, type AgentsResponse, type FileMeta, type FolderMeta } from '../api';
import { AGENT_META, type AgentKind } from '../agentCatalog';
import { errorMessage } from '../apiTransport';
import { FILE_MIME } from '../dragMime';
import { acceptsAgentContextDrop, dragPayloadKinds } from '../dragRouting';
import { electronBridge } from '../electronBridge';
import { useLatestRef } from '../hooks/useLatestRef';
import { useStateWithRef } from '../hooks/useStateWithRef';
import { useApp } from '../store/AppContext';
import { Button } from 'react-aria-components';
import { buttonVariants } from './ui/button';
import { AgentComposer } from './agent/AgentComposer';
import { EmptyChatGreeting, EmptyChatSuggestion } from './agent/AgentEmptyState';
import { resolveAssistantLink } from './agent/assistantLinkTarget';
import { MessageList, flattenFileMentions, type QueuedTurnPreview, type TurnMeta } from './agent/AgentMessages';
import { mergeAttachments, readImageDims } from './agent/attachments';
import { basename } from '../lib/paths';
import { agentConnectionUrl } from './agent/connectionUrl';
import {
  chatScopePill,
  chatScopesEqual,
  folderMenuEntries,
  folderMenuLocked,
  folderScope,
  isBlankChatTab,
  LIBRARY_SCOPE,
  mentionListingPlan,
  newChatScope,
  nextSessionScope,
  scopeChangedScope,
  scopeRequestParams,
  windowFolderSwitchPlan,
  type ChatScope,
} from './agent/folderState';
import { shouldConsumePendingResume } from './agent/sessionHistory';
import { closeAgentSocketIntentionally, terminalAgentState } from './agent/connectionLifecycle';
import { effortMenuLocked } from './agent/effortMenuState';
import { applyModelEvent, modelMenuLocked, modelMenuVisible, type ModelControlState } from './agent/modelState';
import { recordFailureBeforeContinuing, TurnErrorTracker } from './agent/turnFailure';
import { runtimeFailurePresentation } from './agent/runtimeFailurePresentation';
import type { AgentSkill, Attachment, Block, EffortLevel, PermMode, ServerEvent, ToolBlock } from './agent/types';
import { openSettings } from './SettingsModal';

/** Runtimes title sessions from the first message's RAW text, so a chat
 * opened with an @-mention would name its tab a bare relative path.
 * Flatten mentions to file names and collapse whitespace before the tab
 * ever sees it. */
function tabTitleFromSession(raw: string): string {
  const flat = flattenFileMentions(raw).replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? flat.slice(0, 60).trimEnd() + '…' : flat;
}

let blockSeq = 0;
const nextId = () => `b${++blockSeq}`;
const ATTACH_MAX_FILES = 50;
const ATTACH_MAX_BYTES = 64 * 1024 * 1024;
const ATTACH_TIMEOUT_MS = 60_000;

interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Attachment[];
  titleHint?: string;
  skill?: string;
  status: 'waiting' | 'steering' | 'steered';
}

interface PromptToSend {
  text: string;
  attachments: Attachment[];
  titleHint?: string;
  skill?: string;
  appendBlock: boolean;
  clearAttachments?: boolean;
}

/** A chat tab still wearing its auto-generated placeholder name, so we
 *  know it's safe to overwrite with the session's derived title. */
function isDefaultChatTitle(t: string): boolean {
  return /^New Chat( \d+)?$/.test(t.trim());
}

export function AgentView({
  active,
  id,
  title,
  agent = 'claude',
}: {
  active: boolean;
  id: string;
  title: string;
  agent?: AgentKind;
}) {
  const { state, dispatch, actions } = useApp();
  const meta = AGENT_META[agent];
  const runtime = state.agents.find((candidate) => candidate.id === agent);
  const runtimeUnavailable = runtime?.state === 'unavailable';
  const bootstrapPhase = runtime?.bootstrap?.phase ?? 'idle';
  const bootstrapActive = bootstrapPhase === 'installing' || bootstrapPhase === 'authenticating' || bootstrapPhase === 'configuring';
  const bootstrapFailed = bootstrapPhase === 'failed';
  const runtimeBlocked = runtimeUnavailable || bootstrapActive || bootstrapFailed;
  const capabilities = runtime?.capabilities ?? meta.capabilities;
  // Mirrored for the once-bound WS handler chain (`turn-end` →
  // `runNextQueuedPrompt` → `mutateQueue`), which must not read the
  // connect-render's stale capabilities.
  const capabilitiesRef = useLatestRef(capabilities);
  const folderPathRef = useLatestRef(state.folderPath);
  const mountedRef = useRef(true);
  const attachmentPreviewUrlsRef = useRef(new Set<string>());
  const uploadCountRef = useRef(0);
  const [blocks, setBlocks, blocksRef] = useStateWithRef<Block[]>([]);
  const [turnActive, setTurnActive, turnActiveRef] = useStateWithRef(false);
  // Per-turn "Worked for X" data, keyed by the turn's user-message id.
  // Measured on the renderer wall clock (no duration exists on the wire);
  // `interrupted` is set when the user stops the turn. Resumed history has
  // no entry and renders no duration.
  const [turnMeta, setTurnMeta] = useState<Record<string, TurnMeta>>({});
  const turnStartRef = useRef<number | null>(null);
  const interruptedKeyRef = useRef<string | null>(null);
  // The prompt queue's single source of truth. The rendered preview
  // (`queuedTurns`) is derived from it inside `mutateQueue`/`clearQueue`
  // below — every mutation funnels through them, so no call site can
  // forget to refresh the preview.
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurnPreview[]>([]);
  // Composer attachments (context files) — lifted here so a drop anywhere
  // on the panel, the composer `+`, and the send path all share one list.
  const [attachments, setAttachments, attachmentsRef] = useStateWithRef<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Connection lifecycle. `connecting` → waiting for the session to come
  // up; `live` → session ready, accepting prompts; `closed` → ended or
  // failed (see `fatal`). `nonce` bumps to force a reconnect.
  const [phase, setPhase] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [fatal, setFatal, fatalRef] = useStateWithRef<string | null>(null);
  const [fatalRecoveryLabel, setFatalRecoveryLabel] = useState<'Retry' | 'Reconnect'>('Retry');
  const [nonce, setNonce] = useState(0);
  // Permission mode for this session — drives the composer's Modes
  // dropdown. Switching it sends `set-mode` so the agent applies it live.
  const [mode, setMode, modeRef] = useStateWithRef<PermMode>('default');
  // Thinking effort is opt-in. Undefined preserves the native runtime
  // default; an explicit choice rides the connect URL for a new session.
  const [effort, setEffort, effortRef] = useStateWithRef<EffortLevel | undefined>(undefined);
  const [restoredClaudeSession, setRestoredClaudeSession] = useState(false);
  const [effortInherited, setEffortInherited] = useState(false);
  // User intent and runtime telemetry must stay separate: an active model
  // reached through Default must never become an explicit override later.
  const [modelControl, setModelControl, modelControlRef] = useStateWithRef<ModelControlState>({ models: [], notice: null, resumedSession: false });
  // Session scope (Cursor-style picker: a library folder, or "Library").
  // `pickedScope` is the user's explicit choice for the NEXT session;
  // undefined follows the window default (current folder, else library).
  // `connectedScope` is the binding the live session actually connected
  // with — captured per connect and never rebound.
  const [pickedScope, setPickedScope, pickedScopeRef] = useStateWithRef<ChatScope | undefined>(undefined);
  const [connectedScope, setConnectedScope, connectedScopeRef] = useStateWithRef<ChatScope | null>(null);
  // Unsent draft text lifted from the composer: a draft freezes the tab's
  // scope on a window-folder switch and keeps the tab from counting as a
  // reusable blank welcome tab.
  const [hasDraftText, setHasDraftText, hasDraftTextRef] = useStateWithRef(false);
  const recentRef = useLatestRef(state.recent);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [skillState, setSkillState] = useState<'available' | 'empty' | 'failed'>('empty');
  // `resumeIdRef` holds a session id to resume on the next connect; it
  // rides the connect URL (like effort) and is consumed-and-cleared there.
  const resumeIdRef = useRef<string | null>(null);
  // Refs mirror the live session id + this tab's id/title so the WS
  // message handler (bound once per connection) reads current values
  // when it renames the tab on the first turn-end.
  const sessionIdRef = useRef<string | null>(null);
  const idRef = useLatestRef(id);
  const titleRef = useLatestRef(title);
  // Empty-state starter suggestion → composer draft. Prefill only; the
  // nonce lets the same template be re-applied after the user edits it.
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const exitReceivedRef = useRef(false);
  const toolNamesRef = useRef<Map<string, string>>(new Map());
  // Which streaming block kind is currently "open" (so consecutive text
  // deltas append to one bubble; a tool call closes it).
  const openKind = useRef<'assistant' | 'thinking' | null>(null);
  const turnErrorTrackerRef = useRef(new TurnErrorTracker());
  // Scope-specific file listing: `@` mentions, folder-file attachment
  // validation, and context resolution run against the session's bound
  // folder, not the window's current one. Library-wide chats have no
  // single folder listing, so mentions are disabled there.
  const listingPlan = connectedScope
    ? mentionListingPlan(connectedScope, state.folderPath)
    : { kind: 'window' as const };
  const listingRoot = listingPlan.kind === 'folder' ? listingPlan.root : null;
  const mentionsDisabled = listingPlan.kind === 'disabled';
  const [sessionListing, setSessionListing] = useState<{ files: FileMeta[]; folders: FolderMeta[] } | null>(null);
  const [sessionListingNonce, setSessionListingNonce] = useState(0);
  useEffect(() => {
    if (!listingRoot) {
      setSessionListing(null);
      return;
    }
    let cancelled = false;
    void api.listFiles(listingRoot)
      .then((payload) => {
        if (!cancelled) setSessionListing({ files: payload.files, folders: payload.folders });
      })
      .catch(() => {
        // Keep whatever listing we had; the next turn/tool refresh retries.
      });
    return () => { cancelled = true; };
  }, [listingRoot, sessionListingNonce]);
  const mentionFiles = mentionsDisabled ? [] : listingRoot ? sessionListing?.files ?? [] : state.files;
  const mentionFolders = mentionsDisabled ? [] : listingRoot ? sessionListing?.folders ?? [] : state.folders;
  const knownFilePaths = useMemo(() => new Set(mentionFiles.map((f) => f.name)), [mentionFiles]);
  // Mirrored for prompt sends driven from the once-bound WS handler
  // (queued prompts fire on `turn-end`): `resolveFolderContext` must
  // validate against the listing as of send time, not connect time.
  const knownFilePathsRef = useLatestRef(knownFilePaths);
  // An unbound tab that is still empty and draft-free follows the window's
  // folder: a sidebar switch reconnects its next (empty) session to the
  // new window default. A tab holding an unsent draft freezes its scope
  // (the draft keeps the binding the user saw). Bound tabs — content,
  // queued prompts, an explicit pick, or a resume — keep their session
  // and transcript untouched.
  useEffect(() => {
    const plan = windowFolderSwitchPlan({
      connectedScope: connectedScopeRef.current,
      picked: pickedScopeRef.current,
      resumedSession: modelControlRef.current.resumedSession,
      hasContent: blocksRef.current.length > 0 || queuedPromptsRef.current.length > 0,
      turnActive: turnActiveRef.current,
      hasDraft: hasDraftTextRef.current || attachmentsRef.current.length > 0,
      windowFolder: state.folderPath,
    });
    if (plan === 'freeze') {
      // Promote the connected scope to an explicit pick so a draft can
      // never be silently rebound by this or a later window switch.
      setPickedScope(connectedScopeRef.current ?? undefined);
      return;
    }
    if (plan !== 'follow') return;
    reconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow-mode only reacts to window-folder changes
  }, [state.folderPath]);

  useEffect(() => {
    // Fast Refresh runs an effect cleanup before reapplying it while keeping
    // refs and state. Re-arm this guard on every mount so a live attachment
    // upload can settle instead of leaving the composer on “Uploading…”.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setAgentComposerFocused(false);
      releaseAllAttachmentPreviews();
    };
  }, []);

  function releaseAllAttachmentPreviews() {
    for (const url of attachmentPreviewUrlsRef.current) URL.revokeObjectURL(url);
    attachmentPreviewUrlsRef.current.clear();
  }

  function setAgentComposerFocused(focused: boolean) {
    electronBridge()?.setAgentComposerFocused?.(focused);
  }

  /** Tell every OTHER window's sidebar the library gained a member (the
   *  owning window refreshes through its own openFolder). Desktop-only; the
   *  browser dev shell has one window and needs no broadcast. */
  function notifyLibraryFolderAdded(path: string) {
    void electronBridge()?.notifyLibraryFolderAdded?.(path);
  }

  function pasteImages(files: File[]) {
    // The native watcher independently observes screenshots. Mark this
    // explicit composer paste first so it cannot surface later as a library
    // import prompt once focus leaves the input.
    electronBridge()?.markCurrentClipboardImageHandled?.();
    void uploadFiles(files);
  }

  // A chat can be opened before the app's initial discovery request
  // settles. Keep that tab out of the WebSocket path until its runtime has a
  // descriptor, so a missing CLI never briefly becomes a generic failure.
  useEffect(() => {
    if (!runtime) void refreshRuntimes();
  }, [runtime]);

  useEffect(() => {
    if (!bootstrapActive) return;
    const timer = window.setInterval(() => { void refreshRuntimes(); }, 500);
    return () => window.clearInterval(timer);
  }, [bootstrapActive]);

  /** The current turn's identity = its user-message id (stable for the
   *  turn's whole life, unlike the streaming block that keeps changing). */
  function currentTurnKey(): string | null {
    const bs = blocksRef.current;
    for (let i = bs.length - 1; i >= 0; i--) if (bs[i].kind === 'user') return bs[i].id;
    return null;
  }

  function setTurnBusy(active: boolean) {
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
        setTurnMeta((prev) => ({ ...prev, [key]: { durationMs, interrupted } }));
      }
      turnStartRef.current = null;
      interruptedKeyRef.current = null;
    }
  }

  /** Rewrite the prompt queue and derive its rendered preview in the same
   *  step. The ref stays the queue's single source of truth; every mutation
   *  (and the resets below) must go through here or `clearQueue`. */
  function mutateQueue(mutate: (queue: QueuedPrompt[]) => QueuedPrompt[]) {
    queuedPromptsRef.current = mutate(queuedPromptsRef.current);
    setQueuedTurns(queuedPromptsRef.current.map((p) => ({
      id: p.id,
      text: p.text,
      attachments: p.attachments.length ? p.attachments : undefined,
      status: p.status,
      canSteer: capabilitiesRef.current?.steering === true && !p.skill,
    })));
  }

  function clearQueue() {
    mutateQueue(() => []);
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
     *  the old session's active model; 'resumed' locks the control to the
     *  resumed session's own model (drops the previous tab's catalog). */
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
  }) {
    if (clearAttachments) {
      releaseAllAttachmentPreviews();
      setAttachments([]);
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
    clearQueue();
    toolNamesRef.current.clear();
    openKind.current = null;
    setTurnBusy(turnStillActive);
    setFatal(nextFatal);
    setFatalRecoveryLabel(recoveryLabel);
    if (forgetNativeSession) {
      sessionIdRef.current = null;
      setRestoredClaudeSession(false);
      setEffortInherited(false);
    }
    if (adoptSessionId !== undefined) sessionIdRef.current = adoptSessionId;
    if (resumeId !== undefined) resumeIdRef.current = resumeId;
    if (modelReset === 'new-session') {
      setModelControl((current) => ({ ...current, activeModel: undefined, resumedSession: false }));
    } else if (modelReset === 'resumed') {
      setModelControl({ models: [], notice: null, resumedSession: true });
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

  useEffect(() => {
    if (!runtime) {
      readyRef.current = false;
      setPhase('connecting');
      setFatal(null);
      setFatalRecoveryLabel('Retry');
      return;
    }
    // Discovery is authoritative once it has returned. Do not open a socket
    // for a known-missing CLI: the setup card below is the actionable state,
    // rather than a generic connection failure.
    if (runtimeBlocked) {
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
    // Bind this session's scope explicitly: the user's pick, else the
    // window's current folder, else the whole library. Recorded here so a
    // later window-folder switch can never rebind a started conversation.
    const sessionScope = nextSessionScope(
      pickedScopeRef.current,
      folderPathRef.current,
      recentRef.current.map((entry) => entry.path),
    );
    setConnectedScope(sessionScope);
    // Mirror the binding into the tab model: the window-folder switch
    // logic skips spawning a welcome tab when the active chat already
    // targets the new folder.
    dispatch({
      type: 'CHAT_TAB_SET_SCOPE',
      id: idRef.current,
      folder: sessionScope.kind === 'folder' ? sessionScope.path : null,
    });
    const endpoint = runtime?.endpoint ?? '/ws/agent';
    const wsUrl = agentConnectionUrl({
      protocol: location.protocol, host: location.host, endpoint,
      windowId: getWindowId(), effort: effortRef.current, access: modeRef.current,
      agent, model: modelControlRef.current.selectedModel, resume,
      ...scopeRequestParams(sessionScope),
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
      if (!wasReady) refreshRuntimes();
    };

    return () => {
      closeAgentSocketIntentionally(ws);
    };
  }, [nonce, runtime?.endpoint, runtimeBlocked, agent, meta.shortName]);

  /** Tear down and start a fresh session (Retry button / after the user
   *  reopens a folder). */
  function reconnect() {
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

  /** Refresh after a failed or successful connection so the chrome reflects
   * the contract's in-memory available/failed state. */
  async function refreshRuntimes() {
    try {
      const result: AgentsResponse = await api.listAgents();
      dispatch({ type: 'AGENTS_LOADED', agents: result.clis });
    } catch {
      // Retain the last known catalog so an unavailable runtime remains
      // actionable even while the local server is restarting.
    }
  }

  async function applyRuntimeAction(request: () => Promise<AgentsResponse>) {
    try {
      const result = await request();
      dispatch({ type: 'AGENTS_LOADED', agents: result.clis });
    } catch (error) {
      actions.toast(error instanceof Error ? error.message : String(error), { level: 'error' });
    }
  }

  function startRuntimeBootstrap() {
    return applyRuntimeAction(() => api.prepareAgent(agent, 'bootstrap'));
  }

  function checkRuntime() {
    return applyRuntimeAction(() => api.prepareAgent(agent, 'check'));
  }

  function loginToCodex() {
    if (agent !== 'codex') return;
    return applyRuntimeAction(() => api.prepareAgent(agent, 'login'));
  }

  /** Open a past session from the sidebar's History menu: paint its
   *  transcript, then reconnect with `resume` so the SDK appends to it and
   *  the user can keep chatting. Unlike `reconnect`, blocks are
   *  pre-populated (not cleared) with the replayed history. `scope` is the
   *  scope the History menu was scoped to; the tab's binding pins to it so
   *  the reconnect below carries the same scope — a resumed session always
   *  keeps its own scope. */
  async function resumeSession(id: string, scope: ChatScope) {
    let hist: Block[] = [];
    try {
      const replay = await api.getSessionReplay(id, agent, scopeRequestParams(scope));
      hist = replay.messages as Block[];
      setEffort(agent === 'claude' ? replay.effort ?? undefined : undefined);
      setRestoredClaudeSession(agent === 'claude');
      setEffortInherited(agent === 'claude' && replay.effort === null);
    } catch {
      actions.toast('Could not load that session.', { level: 'error' });
      return;
    }
    setPickedScope(chatScopesEqual(scope, newChatScope(folderPathRef.current)) ? undefined : scope);
    resetSessionState({
      transcript: hist,
      clearAttachments: true,
      adoptSessionId: id,
      resumeId: id,
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

  /** The agent may have changed files: sync the folder this session is
   *  bound to (a library-wide chat has no bound folder — reconcile the
   *  window's current folder so the visible tree stays fresh), then refresh
   *  whichever surface shows it. Same-folder windows refresh index state;
   *  a cross-folder tab instead re-fetches its session-folder listing so
   *  mentions and attachment validation see the new files. The sync itself
   *  is best-effort in both callers — a failure falls through to the
   *  refresh, and the next status poll surfaces it. */
  async function reconcileSessionFolder({ reloadWindowTree }: {
    /** Reload the window's visible file tree before the index-state
     *  refresh. The mid-turn tool-result path turns this on so new files
     *  appear immediately; the turn-end sweep leaves it off and lets the
     *  regular poll repaint the tree. */
    reloadWindowTree: boolean;
  }): Promise<void> {
    const boundScope = connectedScopeRef.current;
    const folder = boundScope?.kind === 'folder' ? boundScope.path : folderPathRef.current;
    if (!folder) return; // library chat in a no-folder window: nothing visible to reconcile
    await api.sync(folder).catch(() => { /* best-effort; next poll surfaces it */ });
    if (folderPathRef.current !== folder) {
      setSessionListingNonce((n) => n + 1);
      return;
    }
    if (reloadWindowTree) {
      await actions.loadFiles(folder);
      // The reload awaited: the window may have switched folders meanwhile.
      // Re-check before touching index state — this second check is
      // deliberate, so a stale tab can never refresh another folder's
      // index chrome.
      if (folderPathRef.current !== folder) return;
    }
    void actions.refreshIndexState();
  }

  function handleEvent(ev: ServerEvent) {
    switch (ev.t) {
      case 'ready':
        readyRef.current = true;
        setPhase('live');
        refreshRuntimes();
        // Starting a built-in agent can create root-level instruction files
        // (`AGENTS.md`, and for Claude the `CLAUDE.md` bridge). Refresh the
        // tree immediately instead of waiting for the next index-status poll;
        // a cross-folder session refreshes its own folder's listing too.
        // (Library-wide sessions write no instruction files and have no
        // folder listing of their own.)
        if (folderPathRef.current) void actions.loadFiles(folderPathRef.current);
        if (connectedScopeRef.current?.kind === 'folder' && connectedScopeRef.current.path !== folderPathRef.current) {
          setSessionListingNonce((n) => n + 1);
        }
        // A fresh session always starts at permissionMode 'default'; if the
        // user had picked a non-default mode, re-apply it so a reconnect
        // (Retry / effort change) doesn't silently reset it. Read through
        // the ref: this handler is bound once per connection and must see
        // the mode as of ready time, not connect time.
        if (modeRef.current !== 'default') {
          wsRef.current?.send(JSON.stringify({ t: 'set-mode', mode: modeRef.current }));
        }
        break;
      case 'session-id':
        sessionIdRef.current = ev.id;
        break;
      case 'models':
        setModelControl((current) => applyModelEvent(current, ev));
        break;
      case 'skills': setSkills(ev.skills); setSkillState(ev.state); break;
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
        setBlocks((bs) => [...bs, { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' }]);
        break;
      case 'tool-delta':
        setBlocks((bs) => bs.map((b) =>
          b.kind === 'tool' && b.id === ev.id && b.status !== 'denied'
            ? { ...b, result: (b.result ?? '') + ev.delta }
            : b));
        break;
      case 'tool-result':
        setBlocks((bs) => bs.map((b) =>
          b.kind === 'tool' && b.id === ev.id && b.status !== 'denied'
            ? { ...b, status: ev.isError ? 'error' : 'done', result: ev.content }
            : b));
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
      case 'permission':
        openKind.current = null;
        setBlocks((bs) => {
          const idx = bs.findIndex((b) => b.kind === 'tool' && b.id === ev.toolUseId);
          if (idx >= 0) {
            const next = bs.slice();
            next[idx] = { ...(next[idx] as ToolBlock), status: 'awaiting', permId: ev.id, permTitle: ev.title };
            return next;
          }
          // Race fallback: permission arrived before the tool card.
          return [...bs, { kind: 'tool', id: ev.toolUseId, name: ev.name, input: ev.input, status: 'awaiting', permId: ev.id, permTitle: ev.title }];
        });
        break;
      case 'steer-result':
        setQueuedPromptStatus(ev.id, ev.ok ? 'steered' : 'waiting');
        if (!ev.ok) {
          if (ev.message) {
            setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: `Could not steer Codex: ${ev.message}` }]);
          }
          // A steer that lost its turn (ended mid-flight) re-queues as
          // 'waiting'; with no turn running nothing else would ever send
          // it, so run the queue now.
          if (!turnActiveRef.current) runNextQueuedPrompt();
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
        setConnectedScope(next);
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
      case 'turn-end': {
        const terminal = turnErrorTrackerRef.current.finish(ev.isError);
        if (terminal.duplicate) break;
        openKind.current = null;
        // A completed turn cannot retain an in-flight tool. Codex normally
        // emits `item/completed` for every tool, but an omitted or unmatched
        // notification must not leave the transcript permanently "Running".
        setBlocks((bs) => bs.map((block) =>
          block.kind === 'tool' && block.status === 'running'
            ? { ...block, status: ev.isError ? 'error' : 'done' }
            : block));
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
          (message) => setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: message }]),
          runNextQueuedPrompt,
        );
        break;
      }
      case 'error':
        openKind.current = null;
        // Runtime bridges record terminal failures in the shared catalog.
        // Refresh for both startup and active-session errors: regular turn
        // errors leave the descriptor unchanged, while an app-server exit
        // immediately flips the runtime's descriptor from available to failed.
        refreshRuntimes();
        // An error before the session is ready is fatal (e.g. no folder
        // open / not authenticated); mid-session it's just a notice.
        if (!readyRef.current) {
          resetSessionState({ nextFatal: ev.message, nextPhase: 'closed', startConnection: false });
        } else {
          turnErrorTrackerRef.current.explain();
          setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: ev.message }]);
        }
        break;
      case 'exit':
        exitReceivedRef.current = true;
        finishRendererSession({ ready: readyRef.current, exitReceived: true, message: ev.message });
        if (ev.message) refreshRuntimes();
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
      return [...bs, { kind, id: nextId(), text: delta }];
    });
  }

  function setQueuedPromptStatus(id: string, status: QueuedPrompt['status']) {
    mutateQueue((queue) => queue.map((p) => (p.id === id ? { ...p, status } : p)));
  }

  function send(text: string, skill?: string) {
    const atts = attachments;
    const titleHint = capabilities?.titleHint && isDefaultChatTitle(titleRef.current) ? text : undefined;
    if (turnActiveRef.current) {
      mutateQueue((queue) => [...queue, { id: nextId(), text, attachments: atts, titleHint, skill, status: 'waiting' }]);
      setAttachments([]);
      return;
    }
    void sendPromptNow({ text, attachments: atts, titleHint, skill, appendBlock: true, clearAttachments: true });
  }

  function resend(text: string) {
    if (!turnActiveRef.current) {
      send(text);
      return;
    }

    // Use the composer's current attachment chips, not the original turn's
    // historical attachments: resend is a new prompt, not a replay. While a
    // turn is active, edit-and-resend means "replace what I just asked next",
    // unlike a composer follow-up that deliberately waits behind the active
    // turn.
    // Put the edited prompt at the front before interrupting so even an
    // already-populated queue cannot run a different follow-up first. The
    // normal turn-end handoff owns the actual send, preserving the barrier
    // that prevents abandoned output from crossing into the edited turn.
    const atts = attachmentsRef.current;
    const titleHint = capabilitiesRef.current?.titleHint && isDefaultChatTitle(titleRef.current) ? text : undefined;
    mutateQueue((queue) => [
      { id: nextId(), text, attachments: atts, titleHint, status: 'waiting' },
      ...queue,
    ]);
    setAttachments([]);
    stop();
  }

  function refreshSkills() {
    if (phase !== 'live') return;
    wsRef.current?.send(JSON.stringify({ t: 'refresh-skills' }));
  }

  function runNextQueuedPrompt() {
    let next: QueuedPrompt | undefined;
    mutateQueue((queue) => {
      // Keep in-flight steers: the turn may have ended under them, in which
      // case their steer-result comes back failed and must still find the
      // prompt here to demote it to 'waiting' — dropping it lost the user's
      // text. Only consumed ('steered') prompts leave the queue.
      const kept = queue.filter((p) => p.status === 'waiting' || p.status === 'steering');
      next = kept.find((p) => p.status === 'waiting');
      return kept.filter((p) => p !== next);
    });
    // Close the settled turn first even when handing off to a queued prompt:
    // this records its "Worked for X" duration against the right turn instead
    // of letting the final turn absorb the whole span. sendPromptNow re-arms
    // the busy flag for the next turn.
    setTurnBusy(false);
    if (!next) return;
    void sendPromptNow({ ...next, appendBlock: true });
  }

  async function steerQueuedPrompt(id: string) {
    if (!capabilities?.steering) return;
    const prompt = queuedPromptsRef.current.find((p) => p.id === id && p.status === 'waiting');
    const ws = wsRef.current;
    if (!prompt || !ws || ws.readyState !== WebSocket.OPEN) return;
    setQueuedPromptStatus(id, 'steering');
    const ctx = await buildPromptContext(prompt.attachments);
    const wire = ctx.length ? `${prompt.text}${prompt.text ? '\n\n' : ''}${ctx.join('\n\n')}` : prompt.text;
    try {
      ws.send(JSON.stringify({ t: 'steer', id, text: wire }));
    } catch (err) {
      setQueuedPromptStatus(id, 'waiting');
      setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: `Could not steer Codex: ${errorMessage(err)}` }]);
    }
  }

  function copyUserMessage(text: string) {
    void navigator.clipboard.writeText(text)
      .then(() => actions.toast('Copied.', { level: 'info' }))
      .catch(() => actions.toast('Could not copy message.', { level: 'error' }));
  }

  async function sendPromptNow({
    text,
    attachments: atts,
    titleHint,
    skill,
    appendBlock,
    clearAttachments = false,
  }: PromptToSend) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setTurnBusy(false);
      setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: `${meta.shortName} is not connected.` }]);
      return;
    }
    if (appendBlock) {
      setBlocks((bs) => [...bs, { kind: 'user', id: nextId(), text, attachments: atts.length ? atts : undefined }]);
    }
    setTurnBusy(true);
    openKind.current = null;
    // Build the wire prompt from explicit context only. The current viewer
    // file is not attached automatically; users drag files in or pick them
    // when they want the Agent to use a document as context.
    const ctx = await buildPromptContext(atts);
    const wire = ctx.length ? `${text}${text ? '\n\n' : ''}${ctx.join('\n\n')}` : text;
    try {
      ws.send(JSON.stringify({
        t: 'prompt',
        text: wire,
        ...(titleHint ? { titleHint } : {}),
        ...(skill ? { skill } : {}),
      }));
      if (clearAttachments) clearComposerAttachments();
    } catch (err) {
      setTurnBusy(false);
      setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: `Could not send message: ${errorMessage(err)}` }]);
    }
  }

  async function buildPromptContext(atts: Attachment[]): Promise<string[]> {
    const lines: string[] = [];
    if (atts.length) {
      const rendered = await Promise.all(atts.map((a) => formatAttachmentContext(a)));
      lines.push(`Attached files:\n${rendered.join('\n')}`);
    }
    return lines;
  }

  async function resolveFolderContext(path: string): Promise<AgentContextFile | null> {
    if (!knownFilePathsRef.current.has(path)) return null;
    // Resolve against the session's bound folder — a cross-folder tab must
    // not look the file up under the window's current folder. (A library
    // chat never reaches here: its folder-file listing is empty.)
    const boundScope = connectedScopeRef.current;
    const contextFolder = boundScope?.kind === 'folder' ? boundScope.path : folderPathRef.current;
    if (!contextFolder) return null;
    try {
      return await api.agentContextFile(contextFolder, path);
    } catch {
      return null;
    }
  }

  async function formatAttachmentContext(att: Attachment): Promise<string> {
    const ctx = await resolveFolderContext(att.path);
    if (ctx?.kind === 'derived') {
      return `- ${ctx.sourcePath} (for text context, use mcp__stashbase__read_file with path ${ctx.path}; it returns the derived text representation for this ${ctx.sourceFormat})`;
    }
    if (ctx && !ctx.available && ['pdf', 'docx', 'audio'].includes(ctx.sourceFormat)) {
      return `- ${ctx.sourcePath} (derived text is not available yet; ${ctx.reason})`;
    }
    return `- ${att.path}`;
  }

  /** Attach OS files (dropped from Finder or picked via `+`) as transient
   *  context: they're written to a temp dir OUTSIDE the folder (so they
   *  never enter the library / file tree / index) and referenced by absolute
   *  path, which the agent reads. */
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    const eligible = files.slice(0, ATTACH_MAX_FILES).filter((f) => f.size <= ATTACH_MAX_BYTES);
    const skipped = files.length - eligible.length;
    if (skipped > 0) {
      actions.toast(`${skipped} file(s) were not attached because they are too large or exceed the batch limit.`, { level: 'warning' });
    }
    if (eligible.length === 0) return;
    uploadCountRef.current += 1;
    setUploading(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), ATTACH_TIMEOUT_MS);
    try {
      const result = await api.attachFiles(eligible, { signal: controller.signal });
      if (!mountedRef.current) return;
      // `result.files` is 1:1 with `files` (server preserves order). Keep a
      // renderer-local preview URL for image thumbnails; only the returned
      // temp path becomes Agent context.
      const entries = result.files ?? [];
      const added: Attachment[] = [];
      let failed = 0;
      for (let i = 0; i < entries.length; i++) {
        const r = entries[i];
        if (r.error || !r.path) { failed++; continue; }
        const orig = eligible[i];
        const previewUrl = orig && orig.type.startsWith('image/') ? URL.createObjectURL(orig) : undefined;
        if (previewUrl) attachmentPreviewUrlsRef.current.add(previewUrl);
        const dims = orig && orig.type.startsWith('image/') ? await readImageDims(orig) : undefined;
        added.push({ path: r.path, name: r.name, dims, previewUrl });
      }
      if (!mountedRef.current) {
        for (const attachment of added) {
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        }
        return;
      }
      if (added.length) setAttachments((a) => mergeAttachments(a, added));
      if (failed) actions.toast(`${failed} file(s) failed to attach.`, { level: 'error' });
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      actions.toast(aborted ? 'Attach timed out.' : 'Attach failed.', { level: 'error' });
    } finally {
      window.clearTimeout(timeout);
      uploadCountRef.current = Math.max(0, uploadCountRef.current - 1);
      if (mountedRef.current) setUploading(uploadCountRef.current > 0);
    }
  }

  /** Add chips for files already in the session's folder (dragged from the
   *  sidebar); no upload needed — just reference their existing path. */
  function addFolderFiles(paths: string[]) {
    const clean = paths.filter((p) => p && knownFilePaths.has(p));
    const skipped = paths.filter((p) => p && !knownFilePaths.has(p)).length;
    if (skipped) actions.toast("Only files from this chat's folder can be attached.", { level: 'warning' });
    const add = clean.map((p) => ({ path: p, name: basename(p) }));
    if (add.length) setAttachments((a) => mergeAttachments(a, add));
  }

  function removeAttachment(path: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.path === path);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
        attachmentPreviewUrlsRef.current.delete(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.path !== path);
    });
  }

  function clearComposerAttachments() {
    // Sent and queued turns retain their image thumbnail in the transcript.
    // The URL remains owned by the panel until its transcript is replaced.
    setAttachments([]);
  }

  function stop() {
    // Remember which turn the user interrupted so its settle records it as
    // "You stopped after X" rather than "Worked for X".
    interruptedKeyRef.current = currentTurnKey();
    wsRef.current?.send(JSON.stringify({ t: 'interrupt' }));
  }

  /** Switch permission mode and tell the server to apply it live. */
  function changeMode(m: PermMode) {
    setMode(m);
    wsRef.current?.send(JSON.stringify({ t: 'set-mode', mode: m }));
  }

  /** Change thinking effort. Restored idle transcripts reconnect to the same
   * native session; their visible history is retained. */
  function changeEffort(level: EffortLevel | undefined) {
    if (effortMenuLocked(blocks.length > 0, turnActive, restoredClaudeSession)) return;
    setEffort(level);
    setEffortInherited(false);
    if (blocks.length > 0 && sessionIdRef.current) {
      // Resume the same native session with the transcript kept. The guard
      // above means this runs only while idle, so the reset's queue,
      // tool-name, and turn-settle steps are no-ops (an idle session has
      // drained its queue and settled its turn) — the reset contributes
      // resumeId + phase + a connect-nonce bump, plus clearing any
      // leftover fatal exactly like the other reconnect paths.
      resetSessionState({ resumeId: sessionIdRef.current });
    } else {
      reconnect();
    }
  }

  /** Pick the session scope (a library folder, or the whole library) for
   * this tab's NEXT session. Like a model change it reconnects, and it is
   * refused once the conversation has content — a live session is never
   * rebound to another scope. Picking the window default returns the tab
   * to follow-the-window. */
  function changeScope(next: ChatScope) {
    if (blocks.length > 0 || turnActive || modelControl.resumedSession) return;
    setPickedScope(chatScopesEqual(next, newChatScope(folderPathRef.current)) ? undefined : next);
    reconnect();
  }

  /** Changing model starts a new native session. A resumed or populated
   * transcript is immutable here, so it can never silently switch models. */
  function changeModel(next: string | undefined) {
    if (blocks.length > 0 || turnActive) return;
    setModelControl((current) => ({ ...current, selectedModel: next, activeModel: undefined, notice: null, resumedSession: false }));
    reconnect();
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
      const nameScope = connectedScopeRef.current ?? newChatScope(folderPathRef.current);
      const sessions = await api.listSessions(agent, scopeRequestParams(nameScope));
      const t = tabTitleFromSession(sessions.find((x) => x.id === sid)?.title ?? '');
      if (t && !isDefaultChatTitle(t)) {
        dispatch({ type: 'CHAT_TAB_RENAME', id: tabId, title: t });
      }
    } catch { /* leave the placeholder if the lookup fails */ }
  }

  const effortLocked = effortMenuLocked(blocks.length > 0, turnActive, restoredClaudeSession);
  const modelLocked = modelMenuLocked(blocks.length > 0, turnActive);
  // Session-scope pill state. The shown scope is the live binding once
  // connected, else the scope the next session would bind (picked scope or
  // the window default, so unbound tabs follow the sidebar).
  const memberPaths = useMemo(() => state.recent.map((entry) => entry.path), [state.recent]);
  const folderEntries = useMemo(
    () => folderMenuEntries(state.recent, state.folderPath),
    [state.recent, state.folderPath],
  );
  const folderLocked = folderMenuLocked(blocks.length > 0, turnActive, modelControl.resumedSession);
  const sessionScope = chatScopePill({
    connectedScope,
    picked: pickedScope,
    windowFolder: state.folderPath,
    memberPaths,
  });
  // Cross-scope tabs stay legible: "in <folder>" for another folder's
  // chat, "in Library" for a library chat while the window shows a folder.
  const effectiveModel = modelControl.activeModel ?? modelControl.selectedModel;
  const supportedEfforts = modelControl.models.find((entry) => entry.id === effectiveModel)?.supportedEfforts;
  // Report blankness to the tab model: a COMPLETELY blank tab (no
  // transcript, no active turn, not resumed, no picked scope, no draft
  // text, no attachments) is the reusable welcome tab for New Chat and
  // window-folder switches.
  const storedBlank = state.chatTabs.find((tab) => tab.id === id)?.blank ?? true;
  const blankNow = isBlankChatTab({
    hasContent: blocks.length > 0 || queuedTurns.length > 0,
    turnActive,
    resumedSession: modelControl.resumedSession,
    picked: pickedScope,
    hasDraftText,
    attachmentCount: attachments.length,
  });
  useEffect(() => {
    if (storedBlank !== blankNow) dispatch({ type: 'CHAT_TAB_SET_BLANK', id, blank: blankNow });
  }, [blankNow, storedBlank, dispatch, id]);

  // Sidebar History handoff: the sidebar recorded a pending resume and
  // ensured a suitable tab is active; the ACTIVE, still-blank tab running
  // the request's agent takes it. Consume-and-clear BEFORE resuming so the
  // request can never double-fire, and never hijack a non-blank tab.
  const pendingResume = state.pendingResume;
  useEffect(() => {
    if (!pendingResume) return;
    if (!shouldConsumePendingResume({ active, tabAgent: agent, requestAgent: pendingResume.agent, blank: blankNow })) return;
    dispatch({ type: 'CHAT_RESUME_CONSUMED' });
    void resumeSession(
      pendingResume.sessionId,
      pendingResume.folder === null ? LIBRARY_SCOPE : folderScope(pendingResume.folder),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consume once per request/activation; the guards read latest values
  }, [pendingResume, active]);

  function handleDraftChange(hasText: boolean) {
    setHasDraftText(hasText);
  }

  function replyPermission(toolBlockId: string, permId: string, allow: boolean) {
    wsRef.current?.send(JSON.stringify({ t: 'permission-reply', id: permId, allow }));
    setBlocks((bs) => bs.map((b) =>
      b.kind === 'tool' && b.id === toolBlockId
        ? { ...b, status: allow ? 'running' : 'denied', permId: undefined }
        : b));
  }

  // Drag files anywhere onto the panel to attach them as context: OS files
  // (Finder screenshots / PDFs) become transient attachments (temp dir,
  // NOT the folder); sidebar files (FILE_MIME) reference their existing
  // path. `stopPropagation` is load-bearing: it stops the event before it
  // reaches the window-level `useGlobalDragDrop` listener, which would
  // otherwise *also* fire and import the file into the folder.
  function onPanelDragOver(e: React.DragEvent) {
    const kinds = dragPayloadKinds(e.dataTransfer);
    if (!acceptsAgentContextDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    // The sidebar drag source sets effectAllowed='move'; match it so the
    // drop isn't silently cancelled (OS files accept 'copy').
    e.dataTransfer.dropEffect = kinds.internalFile && !kinds.osFiles ? 'move' : 'copy';
    if (phase === 'live') setDragOver(true);
  }
  function onPanelDragLeave(e: React.DragEvent) {
    // Only clear when the pointer actually leaves the panel, not when it
    // crosses between child elements.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  }
  function onPanelDrop(e: React.DragEvent) {
    if (!acceptsAgentContextDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (phase !== 'live') return;
    const osFiles = Array.from(e.dataTransfer.files ?? []);
    if (osFiles.length) void uploadFiles(osFiles);
    else {
      const filePath = e.dataTransfer.getData(FILE_MIME);
      if (filePath) addFolderFiles([filePath]);
    }
  }

  /** Runtime-readiness gates, most fundamental first: discovery has not
   *  answered yet, preparation is running, preparation failed, CLI missing.
   *  Null once the runtime is usable — the chat UI below owns the pane. */
  function renderRuntimeGate(): ReactNode {
    if (!runtime) {
      return <AgentRuntimeChecking name={meta.name} onRefresh={() => void refreshRuntimes()} />;
    }
    const copyInstallHint = () => {
      void copyText(runtime.installHint).then((copied) => {
        actions.toast(copied ? 'Install command copied.' : 'Could not copy install command.', { level: copied ? 'info' : 'error' });
      });
    };
    if (bootstrapActive) {
      return <AgentRuntimeProgress runtime={runtime} fallbackName={meta.name} />;
    }
    if (bootstrapFailed) {
      return (
        <AgentRuntimeFailure
          runtime={runtime}
          fallbackName={meta.name}
          onRetry={() => void startRuntimeBootstrap()}
          onLogin={() => void loginToCodex()}
          onRefresh={() => void checkRuntime()}
          onCopyInstall={copyInstallHint}
          onOpenMcpSetup={() => openSettings('mcp')}
        />
      );
    }
    if (runtimeUnavailable) {
      return (
        <AgentRuntimeSetup
          runtime={runtime}
          fallbackName={meta.name}
          onInstall={() => void startRuntimeBootstrap()}
          onRefresh={() => void checkRuntime()}
        />
      );
    }
    return null;
  }

  // Empty chat (no turns yet, session usable) renders the hero layout:
  // greeting + centered composer + starter templates. Any transcript
  // content, a queued prompt, or a closed/failed session falls back to the
  // standard transcript-over-bottom-composer layout. The composer keeps its
  // `key` so the same mounted instance moves between the two layouts.
  const emptyChat = blocks.length === 0 && queuedTurns.length === 0 && phase !== 'closed' && !fatal;

  return (
    // `agent-view` stays as a routing hook: useGlobalDragDrop uses
    // `closest('.agent-view')` to keep panel drops out of folder import.
    <div
      // Documents are paper (base); chat sits on the CANVAS role — a cool
      // near-white between paper and chrome, identical in BOTH layouts,
      // floating its white cards (user turns, composer, code blocks). The
      // surface never changes with layout, so opening a document only
      // resizes the panel — no mode jump.
      className="agent-view relative flex min-h-0 flex-1 flex-col bg-canvas"
      onDragOver={onPanelDragOver}
      onDragLeave={onPanelDragLeave}
      onDrop={onPanelDrop}
    >
      {dragOver && (
        // pointer-events-none so the overlay never steals the drop or
        // flickers dragenter/leave; the panel's own handlers take the drop.
        <div className="pointer-events-none absolute inset-1.5 z-20 grid place-items-center rounded-xl border-2 border-dashed border-accent/55 bg-accent/7 backdrop-blur-[1.5px]">
          <div className="rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground shadow-elevation">Drop files to add as context</div>
        </div>
      )}
      {/* No pane header: the chat tab already names the conversation and
        * the composer's scope pill carries the binding — repeating either
        * here was pure noise. */}
      {renderRuntimeGate() ?? <>
        {emptyChat ? (
          // Empty chat: the composer is the hero. The greeting bottoms out
          // this flex-[3] band and the rotating suggestion bottoms out the
          // flex-[4] band below the composer, so the input rests just above
          // the vertical center (Cursor-style) at every panel height.
          <div key="empty-above" className="flex min-h-0 flex-[3] flex-col justify-end overflow-hidden px-2">
            <div className="mx-auto w-[min(640px,100%)]">
              <EmptyChatGreeting
                agentShortName={meta.shortName}
                connecting={phase === 'connecting'}
              />
            </div>
          </div>
        ) : (
          <MessageList
            key="messages"
            blocks={blocks}
            queuedTurns={queuedTurns}
            turnActive={turnActive}
            turnMeta={turnMeta}
            phase={phase}
            fatal={fatal}
            fatalRecoveryLabel={fatalRecoveryLabel}
            agentShortName={meta.shortName}
            onPermission={replyPermission}
            onSteerQueued={steerQueuedPrompt}
            onCopyUserMessage={copyUserMessage}
            onResendUserMessage={resend}
            onRetry={reconnectAfterFatal}
            onOpenArtifact={(path) => {
              const action = resolveAssistantLink(path, {
                scopeFolder: connectedScopeRef.current?.kind === 'folder' ? connectedScopeRef.current.path : null,
                windowFolder: folderPathRef.current || null,
                members: state.recent.map((entry) => entry.path),
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
            }}
          />
        )}
        {phase === 'closed' && !fatal && (
          <div className="flex items-center justify-between gap-2.5 border-t border-border px-3 py-2 text-sm text-muted-foreground">
            <span>Session ended.</span>
            <Button className={buttonVariants({ variant: 'outline', size: 'sm' })} onPress={reconnect}>Reconnect</Button>
          </div>
        )}
      <AgentComposer
        key="composer"
        hero={emptyChat}
        phase={phase}
        disabled={phase !== 'live'}
        turnActive={turnActive}
        active={active}
        agentShortName={meta.shortName}
        prefill={prefill}
        mode={{ show: capabilities?.modes === true, value: mode, onSet: changeMode }}
        effort={{
          show: capabilities?.effort === true,
          level: effort,
          inherited: effortInherited,
          locked: effortLocked,
          supported: supportedEfforts,
          onSet: changeEffort,
        }}
        model={{
          show: modelMenuVisible(capabilities?.models === true, modelControl.models),
          selected: modelControl.selectedModel,
          active: modelControl.activeModel,
          models: modelControl.models,
          locked: modelLocked,
          notice: modelControl.notice,
          resumedSession: modelControl.resumedSession,
          onSet: changeModel,
        }}
        scope={{
          current: sessionScope,
          entries: folderEntries,
          homeDir: state.homeDir,
          locked: folderLocked,
          onSet: changeScope,
        }}
        mentions={{ files: mentionFiles, folders: mentionFolders }}
        skills={{ list: skills, state: skillState, onRefresh: refreshSkills }}
        attachments={{
          items: attachments,
          uploading,
          onPick: uploadFiles,
          onPasteImages: pasteImages,
          onRemove: removeAttachment,
        }}
        onDraftChange={handleDraftChange}
        onFocusChange={setAgentComposerFocused}
        onSend={send}
        onStop={stop}
      />
      {emptyChat && (
        <div key="empty-below" className="scrollbar-quiet flex min-h-0 flex-[4] flex-col overflow-y-auto px-2">
          {/* mt-auto pins the suggestion toward the pane's bottom edge when
            * there is room, turning the leftover space into deliberate
            * composition; on short panels it simply sits below the composer. */}
          <div className="mt-auto shrink-0">
            <EmptyChatSuggestion
              onPrefill={(text) => setPrefill({ text, nonce: Date.now() })}
              libraryScoped={sessionScope.kind === 'library'}
            />
          </div>
        </div>
      )}
      </>}
    </div>
  );
}

const runtimeCardWrapClass = 'grid min-h-45 flex-1 place-items-center px-3 py-6';
/* One text rhythm with the app's dialogs (ManagedModalShell): body-size
 * medium title, body-size muted copy at mt-2. Card surface is bg-card —
 * chat is canvas, its cards float on the card role. */
const runtimeCardClass = 'w-[min(440px,100%)] rounded-xl border border-border bg-card p-4 text-foreground';
const runtimeCardTitleClass = 'm-0 text-base font-medium leading-snug';
const runtimeCardCopyClass = 'mt-2 mb-3 text-base leading-normal text-muted-foreground';
const runtimeCardActionsClass = 'mt-3 flex justify-end gap-2';

function AgentRuntimeSetup({
  runtime,
  fallbackName,
  onInstall,
  onRefresh,
}: {
  runtime: Agent | undefined;
  fallbackName: string;
  onInstall: () => void;
  onRefresh: () => void;
}) {
  const name = runtime?.label ?? fallbackName;
  return (
    <div className={runtimeCardWrapClass} role="status">
      <div className={runtimeCardClass}>
        <h2 className={runtimeCardTitleClass}>{name} is not installed</h2>
        {/* First-run install keeps ONE primary path: no manual-command
          * escape hatch and no PATH/implementation caveats here — that
          * recovery detail lives on the failure card, where an install
          * has actually gone wrong. */}
        <p className={runtimeCardCopyClass}>StashBase can set up the official runtime for you.</p>
        <div className={runtimeCardActionsClass}>
          <Button className={buttonVariants({ variant: 'outline', size: 'sm' })} onPress={onRefresh}>Check again</Button>
          <Button className={buttonVariants({ variant: 'default', size: 'sm' })} onPress={onInstall}>Install and continue</Button>
        </div>
      </div>
    </div>
  );
}

function AgentRuntimeProgress({ runtime, fallbackName }: { runtime: Agent; fallbackName: string }) {
  const status = runtime.bootstrap;
  const name = runtime.label || fallbackName;
  const progress = typeof status?.progress === 'number' ? Math.max(0, Math.min(1, status.progress)) : null;
  return (
    <div className={runtimeCardWrapClass} role="status" aria-live="polite">
      <div className={runtimeCardClass}>
        <h2 className={runtimeCardTitleClass}>Preparing {name}</h2>
        <p className={runtimeCardCopyClass}>{status?.message ?? `Installing ${name}…`}</p>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={'h-full rounded-full bg-accent transition-[width] duration-standard ' + (progress == null ? 'w-1/3 animate-pulse' : '')}
            style={progress == null ? undefined : { width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <p className="mt-2 mb-0 text-xs text-muted-foreground">You can keep browsing while this finishes.</p>
      </div>
    </div>
  );
}

function AgentRuntimeFailure({
  runtime,
  fallbackName,
  onRetry,
  onLogin,
  onRefresh,
  onCopyInstall,
  onOpenMcpSetup,
}: {
  runtime: Agent;
  fallbackName: string;
  onRetry: () => void;
  onLogin: () => void;
  onRefresh: () => void;
  onCopyInstall: () => void;
  onOpenMcpSetup: () => void;
}) {
  const name = runtime.label || fallbackName;
  const presentation = runtimeFailurePresentation(runtime.bootstrap, name);
  const manualAction = presentation.manualAction === 'copy-install-command'
    ? onCopyInstall
    : presentation.manualAction === 'open-mcp-settings'
      ? onOpenMcpSetup
      : null;
  const primaryAction = presentation.primaryAction === 'start-codex-login' ? onLogin : onRetry;
  return (
    <div className={runtimeCardWrapClass} role="alert">
      <div className={runtimeCardClass}>
        <h2 className={runtimeCardTitleClass}>{presentation.title}</h2>
        <p className={runtimeCardCopyClass}>{presentation.message}</p>
        <div className={runtimeCardActionsClass}>
          {manualAction && presentation.manualLabel && (
            <Button className={buttonVariants({ variant: 'outline', size: 'sm' })} onPress={manualAction}>
              {presentation.manualLabel}
            </Button>
          )}
          {runtime.bootstrap?.failure?.stage !== 'mcp' && (
            <Button className={buttonVariants({ variant: 'outline', size: 'sm' })} onPress={onRefresh}>
              Check again
            </Button>
          )}
          <Button className={buttonVariants({ variant: 'default', size: 'sm' })} onPress={primaryAction}>
            {presentation.retryLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AgentRuntimeChecking({ name, onRefresh }: { name: string; onRefresh: () => void }) {
  return (
    <div className={runtimeCardWrapClass} role="status">
      <div className={runtimeCardClass}>
        <h2 className={runtimeCardTitleClass}>Checking {name}</h2>
        <p className={runtimeCardCopyClass}>Checking whether its local CLI is installed.</p>
        <div className={runtimeCardActionsClass}>
          <Button className={buttonVariants({ variant: 'outline', size: 'sm' })} onPress={onRefresh}>Refresh status</Button>
        </div>
      </div>
    </div>
  );
}

/** Clipboard access can be unavailable in an unfocused Electron webview. */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    try {
      textarea.select();
      return document.execCommand('copy');
    } finally {
      textarea.remove();
    }
  } catch {
    return false;
  }
}

function shouldRefreshAfterTool(name: string | undefined): boolean {
  if (!name) return false;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return true;
  return /^mcp__/.test(name) && /(write|delete|rename|update|set_|create|move)/i.test(name);
}

function isSafeFolderRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

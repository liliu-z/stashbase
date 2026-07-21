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
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getWindowId, type AgentContextFile, type AgentsResponse } from '../api';
import { AGENT_META, type AgentKind } from '../agentCatalog';
import { FILE_MIME } from '../dragMime';
import { acceptsAgentContextDrop, dragPayloadKinds } from '../dragRouting';
import { useApp } from '../store/AppContext';
import { makeChatTab } from '../store/state';
import { NewChatIcon } from '../icons';
import { AgentComposer } from './agent/AgentComposer';
import { AgentHistoryMenu } from './agent/AgentHistoryMenu';
import { MessageList, type QueuedTurnPreview } from './agent/AgentMessages';
import { baseName, mergeAttachments, readImageDims } from './agent/attachments';
import type { Attachment, Block, EffortLevel, PermMode, ServerEvent, ToolBlock } from './agent/types';

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
  status: 'waiting' | 'steering' | 'steered';
}

interface PromptToSend {
  text: string;
  attachments: Attachment[];
  titleHint?: string;
  appendBlock: boolean;
  clearAttachments?: boolean;
}

/** A chat tab still wearing its auto-generated placeholder name, so we
 *  know it's safe to overwrite with the session's derived title. */
function isDefaultChatTitle(t: string): boolean {
  return /^Untitled( \d+)?$/.test(t.trim());
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
  const capabilities = runtime?.capabilities ?? meta.capabilities;
  const folderPathRef = useRef(state.folderPath);
  folderPathRef.current = state.folderPath;
  const mountedRef = useRef(true);
  const uploadCountRef = useRef(0);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [editableUserMessageIds, setEditableUserMessageIds] = useState<Set<string>>(() => new Set());
  const [turnActive, setTurnActive] = useState(false);
  const turnActiveRef = useRef(false);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurnPreview[]>([]);
  // Composer attachments (context files) — lifted here so a drop anywhere
  // on the panel, the composer `+`, and the send path all share one list.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Connection lifecycle. `connecting` → waiting for the session to come
  // up; `live` → session ready, accepting prompts; `closed` → ended or
  // failed (see `fatal`). `nonce` bumps to force a reconnect.
  const [phase, setPhase] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [fatal, setFatal] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Permission mode for this session — drives the composer's Modes
  // dropdown. Switching it sends `set-mode` so the agent applies it live.
  const [mode, setMode] = useState<PermMode>('default');
  const modeRef = useRef<PermMode>('default');
  // Thinking effort — fixed per session (no live SDK setter), so it rides
  // the connect URL. `effortRef` lets the connect effect read the latest
  // value without resubscribing on every change.
  const [effort, setEffort] = useState<EffortLevel>('high');
  const effortRef = useRef<EffortLevel>('high');
  // The live session's SDK id (from the `session-id` event) — lets the
  // History dropdown mark the current session active. `resumeIdRef` holds
  // a session id to resume on the next connect; it rides the connect URL
  // (like effort) and is consumed-and-cleared there.
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const resumeIdRef = useRef<string | null>(null);
  // Refs mirror the live session id + this tab's id/title so the WS
  // message handler (bound once per connection) reads current values
  // when it renames the tab on the first turn-end.
  const sessionIdRef = useRef<string | null>(null);
  const idRef = useRef(id); idRef.current = id;
  const titleRef = useRef(title); titleRef.current = title;
  const [historyOpen, setHistoryOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const toolNamesRef = useRef<Map<string, string>>(new Map());
  // Which streaming block kind is currently "open" (so consecutive text
  // deltas append to one bubble; a tool call closes it).
  const openKind = useRef<'assistant' | 'thinking' | null>(null);
  const knownFilePaths = useMemo(() => new Set(state.files.map((f) => f.name)), [state.files]);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  function setTurnBusy(active: boolean) {
    turnActiveRef.current = active;
    setTurnActive(active);
  }

  useEffect(() => {
    readyRef.current = false;
    // Consume-and-clear the resume id: it belongs to this one connection,
    // so a later reconnect (Retry / effort change) starts fresh instead of
    // re-resuming.
    const resume = resumeIdRef.current;
    resumeIdRef.current = null;
    const endpoint = runtime?.endpoint ?? '/ws/agent';
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${endpoint}`
      + `?windowId=${encodeURIComponent(getWindowId())}&effort=${effortRef.current}`
      + `&access=${modeRef.current}`
      + `&agent=${encodeURIComponent(agent)}`
      + (resume ? `&resume=${encodeURIComponent(resume)}` : '');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      handleEvent(ev);
    };
    ws.onclose = () => {
      queuedPromptsRef.current = [];
      setQueuedTurns([]);
      setTurnBusy(false);
      // Closing before the session was ever ready is a startup failure,
      // not a normal end — surface it (with a Retry) rather than a quiet
      // "session ended".
      if (!readyRef.current) {
        setFatal((f) => f ?? `Connection closed before ${meta.shortName} started.`);
        refreshRuntimes();
      }
      setPhase('closed');
    };

    return () => {
      // Detach onclose so the reconnect path's teardown doesn't clobber
      // the fresh 'connecting' state with a stale 'closed'.
      ws.onclose = null;
      try { ws.send(JSON.stringify({ t: 'close' })); } catch { /* gone */ }
      ws.close();
    };
  }, [nonce, runtime?.endpoint, agent, meta.shortName]);

  /** Tear down and start a fresh session (Retry button / after the user
   *  reopens a folder). */
  function reconnect() {
    setBlocks([]);
    setEditableUserMessageIds(new Set());
    setFatal(null);
    queuedPromptsRef.current = [];
    setQueuedTurns([]);
    setTurnBusy(false);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    toolNamesRef.current.clear();
    openKind.current = null;
    setPhase('connecting');
    setNonce((n) => n + 1);
  }

  /** Refresh after a failed or successful connection so the chrome reflects
   * the contract's in-memory available/failed state. */
  function refreshRuntimes() {
    void api.listAgents().then((result: AgentsResponse) => {
      dispatch({ type: 'AGENTS_LOADED', agents: result.clis });
    }).catch(() => { /* retain the last known catalog */ });
  }

  /** Open a past session from the History dropdown: paint its transcript,
   *  then reconnect with `resume` so the SDK appends to it and the user can
   *  keep chatting. Unlike `reconnect`, blocks are pre-populated (not
   *  cleared) with the replayed history. */
  async function resumeSession(id: string) {
    setHistoryOpen(false);
    let hist: Block[] = [];
    try {
      hist = (await api.getSessionMessages(id, agent)) as Block[];
    } catch {
      actions.toast('Could not load that session.', { level: 'error' });
      return;
    }
    setBlocks(hist);
    setEditableUserMessageIds(new Set());
    setFatal(null);
    queuedPromptsRef.current = [];
    setQueuedTurns([]);
    setTurnBusy(false);
    setCurrentSessionId(id);
    sessionIdRef.current = id;
    toolNamesRef.current.clear();
    openKind.current = null;
    resumeIdRef.current = id;
    // Name the tab from the resumed session right away — otherwise a tab
    // opened to a past session stays "Untitled" until the user sends a
    // new prompt (the `turn-end` path that usually renames never fires on
    // a pure load). Safe: `maybeNameTab` only overwrites a placeholder.
    void maybeNameTab();
    setPhase('connecting');
    setNonce((n) => n + 1);
  }

  function handleEvent(ev: ServerEvent) {
    switch (ev.t) {
      case 'ready':
        readyRef.current = true;
        setPhase('live');
        refreshRuntimes();
        // Starting a built-in agent can create root-level instruction files
        // (`AGENTS.md`, and for Claude the `CLAUDE.md` bridge). Refresh the
        // tree immediately instead of waiting for the next index-status poll.
        void actions.loadFiles(folderPathRef.current || undefined);
        // A fresh session always starts at permissionMode 'default'; if the
        // user had picked a non-default mode, re-apply it so a reconnect
        // (Retry / effort change) doesn't silently reset it.
        if (mode !== 'default') wsRef.current?.send(JSON.stringify({ t: 'set-mode', mode }));
        break;
      case 'session-id':
        setCurrentSessionId(ev.id);
        sessionIdRef.current = ev.id;
        break;
      case 'session-title':
        if (isDefaultChatTitle(titleRef.current)) {
          const t = ev.title.trim();
          if (t) dispatch({ type: 'CHAT_TAB_RENAME', id: idRef.current, title: t.length > 60 ? t.slice(0, 60).trimEnd() + '…' : t });
        }
        break;
      case 'turn-start':
        openKind.current = null;
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
            const toolFolder = folderPathRef.current;
            const createdFile = fileInCurrentFolderFromToolResult(toolName, ev.content, toolFolder);
            void (async () => {
              await api.sync(toolFolder).catch(() => { /* turn-end / next poll will surface it */ });
              if (folderPathRef.current !== toolFolder) return;
              await actions.loadFiles();
              if (folderPathRef.current !== toolFolder) return;
              void actions.refreshIndexState();
              if (createdFile) await actions.selectFile(createdFile);
            })().catch((err) => {
              actions.toast(`Could not refresh files: ${errorText(err)}`, { level: 'error' });
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
        if (!ev.ok && ev.message) {
          setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: `Could not steer Codex: ${ev.message}` }]);
        }
        break;
      case 'turn-end':
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
        // the History list instead of staying "Untitled".
        void maybeNameTab();
        // The agent may have written files via shell during the turn —
        // reconcile now (deterministic, replaces fs.watch). MCP writes
        // already index on their own path; this catches `Bash`/editor
        // writes the moment the turn finishes.
        {
          const turnFolder = folderPathRef.current;
          void api.sync(turnFolder || undefined)
            .catch(() => { /* next status poll surfaces it */ })
            .finally(() => {
              if (folderPathRef.current === turnFolder) void actions.refreshIndexState();
            });
        }
        runNextQueuedPrompt();
        break;
      case 'error':
        openKind.current = null;
        // Runtime bridges record terminal failures in the shared catalog.
        // Refresh for both startup and active-session errors: regular turn
        // errors leave the descriptor unchanged, while an app-server exit
        // immediately changes the launcher from available to failed.
        refreshRuntimes();
        // An error before the session is ready is fatal (e.g. no folder
        // open / not authenticated); mid-session it's just a notice.
        if (!readyRef.current) {
          queuedPromptsRef.current = [];
          setQueuedTurns([]);
          setTurnBusy(false);
          setFatal(ev.message);
          setPhase('closed');
        } else {
          setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: ev.message }]);
        }
        break;
      case 'exit':
        queuedPromptsRef.current = [];
        setQueuedTurns([]);
        setTurnBusy(false);
        setPhase('closed');
        break;
    }
  }

  function appendStream(kind: 'assistant' | 'thinking', delta: string) {
    setBlocks((bs) => {
      const last = bs[bs.length - 1];
      if (openKind.current === kind && last && (last.kind === 'assistant' || last.kind === 'thinking')) {
        const next = bs.slice();
        next[next.length - 1] = { ...last, text: last.text + delta };
        return next;
      }
      openKind.current = kind;
      return [...bs, { kind, id: nextId(), text: delta }];
    });
  }

  function queuePreview(): QueuedTurnPreview[] {
    return queuedPromptsRef.current.map((p) => ({
      id: p.id,
      text: p.text,
      attachments: p.attachments.length ? p.attachments : undefined,
      status: p.status,
      canSteer: capabilities?.steering === true,
    }));
  }

  function setQueuedPromptStatus(id: string, status: QueuedPrompt['status']) {
    queuedPromptsRef.current = queuedPromptsRef.current.map((p) => (p.id === id ? { ...p, status } : p));
    setQueuedTurns(queuePreview());
  }

  function send(text: string) {
    const atts = attachments;
    const titleHint = capabilities?.titleHint && isDefaultChatTitle(titleRef.current) ? text : undefined;
    if (turnActiveRef.current) {
      const id = nextId();
      queuedPromptsRef.current.push({ id, text, attachments: atts, titleHint, status: 'waiting' });
      setQueuedTurns(queuePreview());
      setAttachments([]);
      return;
    }
    void sendPromptNow({ text, attachments: atts, titleHint, appendBlock: true, clearAttachments: true });
  }

  function runNextQueuedPrompt() {
    queuedPromptsRef.current = queuedPromptsRef.current.filter((p) => p.status === 'waiting');
    const next = queuedPromptsRef.current.shift();
    setQueuedTurns(queuePreview());
    if (!next) {
      setTurnBusy(false);
      return;
    }
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
      setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: `Could not steer Codex: ${errorText(err)}` }]);
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
      }));
      if (clearAttachments) setAttachments([]);
    } catch (err) {
      setTurnBusy(false);
      setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: `Could not send message: ${errorText(err)}` }]);
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
    if (!knownFilePaths.has(path)) return null;
    try {
      return await api.agentContextFile(folderPathRef.current, path);
    } catch {
      return null;
    }
  }

  async function formatAttachmentContext(att: Attachment): Promise<string> {
    const ctx = await resolveFolderContext(att.path);
    if (ctx?.kind === 'derived') {
      return `- ${ctx.sourcePath} (use StashBase read_file on ${ctx.path}; it returns the derived text representation for this ${ctx.sourceFormat})`;
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
      // `result.files` is 1:1 with `files` (server preserves order); pull
      // image dimensions off the original File for the chip label.
      const entries = result.files ?? [];
      const added: Attachment[] = [];
      let failed = 0;
      for (let i = 0; i < entries.length; i++) {
        const r = entries[i];
        if (r.error || !r.path) { failed++; continue; }
        const orig = eligible[i];
        const dims = orig && orig.type.startsWith('image/') ? await readImageDims(orig) : undefined;
        added.push({ path: r.path, name: r.name, dims });
      }
      if (!mountedRef.current) return;
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

  /** Add chips for files already in the folder (dragged from the sidebar);
   *  no upload needed — just reference their existing path. */
  function addFolderFiles(paths: string[]) {
    const clean = paths.filter((p) => p && knownFilePaths.has(p));
    const skipped = paths.filter((p) => p && !knownFilePaths.has(p)).length;
    if (skipped) actions.toast('Only files from the current folder can be attached.', { level: 'warning' });
    const add = clean.map((p) => ({ path: p, name: baseName(p) }));
    if (add.length) setAttachments((a) => mergeAttachments(a, add));
  }

  function removeAttachment(path: string) {
    setAttachments((a) => a.filter((x) => x.path !== path));
  }

  function stop() {
    const lastUser = [...blocks].reverse().find((b) => b.kind === 'user');
    if (lastUser) {
      setEditableUserMessageIds((prev) => {
        const next = new Set(prev);
        next.add(lastUser.id);
        return next;
      });
    }
    wsRef.current?.send(JSON.stringify({ t: 'interrupt' }));
  }

  /** Switch permission mode and tell the server to apply it live. */
  function changeMode(m: PermMode) {
    setMode(m);
    modeRef.current = m;
    wsRef.current?.send(JSON.stringify({ t: 'set-mode', mode: m }));
  }

  /** Change thinking effort. The SDK fixes effort at session construction
   *  (no live setter), so we apply it by reconnecting — but only when the
   *  chat is still empty, so we never discard a real conversation. With
   *  history present it takes effect on the next new chat. */
  function changeEffort(level: EffortLevel) {
    if (blocks.length > 0 || turnActive) return;
    setEffort(level);
    effortRef.current = level;
    reconnect();
  }

  /** Rename this tab from the session's server-derived title once the
   *  first turn lands. Only fires while the tab still wears its
   *  "Untitled" placeholder, so a user-set name (or a later turn) never
   *  clobbers it. Uses the same source as the History list, so the two
   *  stay consistent. */
  async function maybeNameTab() {
    const tabId = idRef.current;
    const sid = sessionIdRef.current;
    if (!tabId || !sid || !isDefaultChatTitle(titleRef.current)) return;
    try {
      const sessions = await api.listSessions(agent);
      const t = sessions.find((x) => x.id === sid)?.title?.trim();
      if (t && !isDefaultChatTitle(t)) {
        dispatch({ type: 'CHAT_TAB_RENAME', id: tabId, title: t.length > 60 ? t.slice(0, 60).trimEnd() + '…' : t });
      }
    } catch { /* leave the placeholder if the lookup fails */ }
  }

  /** Spawn a fresh chat tab for the same agent from the in-panel `+`. */
  function newChat() {
    dispatch({ type: 'CHAT_TAB_NEW', tab: makeChatTab(agent, state.chatTabs) });
  }

  /** Deleting the session currently shown in this tab leaves the tab open as
   * a fresh chat. Its old history title must not leak into that new session. */
  function resetAfterActiveSessionDeleted() {
    const otherAgentTabs = state.chatTabs.filter((tab) => tab.agent === agent && tab.id !== id);
    const freshTitle = otherAgentTabs.length === 0 ? 'Untitled' : `Untitled ${otherAgentTabs.length + 1}`;
    dispatch({ type: 'CHAT_TAB_RENAME', id, title: freshTitle });
    reconnect();
  }

  const effortLocked = blocks.length > 0 || turnActive;

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

  return (
    <div
      className="agent-view"
      onDragOver={onPanelDragOver}
      onDragLeave={onPanelDragLeave}
      onDrop={onPanelDrop}
    >
      {dragOver && (
        <div className="agent-drop-overlay">
          <div className="agent-drop-card">Drop files to add as context</div>
        </div>
      )}
      <div className="agent-head">
        <span className="agent-head-title">{title}</span>
        <div className="agent-head-actions">
          {capabilities?.history && (
            <AgentHistoryMenu
              open={historyOpen}
              currentSessionId={currentSessionId}
              agent={agent}
              onToggle={() => setHistoryOpen((o) => !o)}
              onClose={() => setHistoryOpen(false)}
              onResume={resumeSession}
              onActiveDeleted={resetAfterActiveSessionDeleted}
            />
          )}
          <button type="button" className="agent-head-btn" title={`New ${meta.name} chat`} onClick={newChat}>
            <NewChatIcon />
          </button>
        </div>
      </div>
      <MessageList
        blocks={blocks}
        queuedTurns={queuedTurns}
        turnActive={turnActive}
        phase={phase}
        fatal={fatal}
        agentName={meta.name}
        agentShortName={meta.shortName}
        Icon={meta.Icon}
        editableUserMessageIds={editableUserMessageIds}
        onPermission={replyPermission}
        onSteerQueued={steerQueuedPrompt}
        onCopyUserMessage={copyUserMessage}
        onResendUserMessage={send}
        onRetry={reconnect}
        onOpenArtifact={(path) => {
          const folder = folderPathRef.current;
          const rel = path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
          if (isSafeFolderRelativePath(rel)) void actions.selectFile(rel);
        }}
      />
      {phase === 'closed' && (
        !fatal && (
          <div className="agent-ended">
            <span>Session ended.</span>
            <button type="button" className="agent-btn" onClick={reconnect}>Reconnect</button>
          </div>
        )
      )}
      <AgentComposer
        phase={phase}
        disabled={phase !== 'live'}
        turnActive={turnActive}
        active={active}
        mode={mode}
        onSetMode={changeMode}
        effort={effort}
        onSetEffort={changeEffort}
        effortLocked={effortLocked}
        showModeMenu={capabilities?.modes === true}
        showEffortMenu={capabilities?.effort === true}
        agentShortName={meta.shortName}
        attachments={attachments}
        uploading={uploading}
        onPickFiles={uploadFiles}
        onRemoveAttachment={removeAttachment}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}

function shouldRefreshAfterTool(name: string | undefined): boolean {
  if (!name) return false;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return true;
  return /^mcp__/.test(name) && /(write|delete|rename|update|set_|create|move)/i.test(name);
}

function fileInCurrentFolderFromToolResult(toolName: string | undefined, content: string, folder: string): string | null {
  if (!toolName || !/write_file$/i.test(toolName) || !folder) return null;
  try {
    const parsed = JSON.parse(content) as { path?: unknown; ok?: unknown };
    if (parsed.ok !== true || typeof parsed.path !== 'string') return null;
    const prefix = `${folder}/`;
    if (!parsed.path.startsWith(prefix)) return null;
    const rel = parsed.path.slice(prefix.length);
    return isSafeFolderRelativePath(rel) ? rel : null;
  } catch {
    return null;
  }
}

function isSafeFolderRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

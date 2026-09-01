import { useState, type RefObject } from 'react';
import { api, type AgentContextFile } from '@/common/api/api';
import { errorMessage } from '@/common/api/apiTransport';
import type { AgentPanelCapabilities } from '@/common/lib/agentCatalog';
import type { QueuedTurnPreview } from '@/features/agent-panel/components/AgentMessages';
import { nextBlockId } from '@/features/agent-panel/lib/blockIds';
import { isDefaultChatTitle } from '@/features/agent-panel/lib/agentSessionText';
import type { Attachment, Block } from '@/features/agent-panel/lib/types';

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Attachment[];
  titleHint?: string;
  skill?: string;
  status: 'waiting' | 'steering' | 'steered' | 'cancelled';
}

interface PromptToSend {
  text: string;
  /** Optional concise text for the transcript. Presets use this to keep the
   * user-visible turn natural while sending a fuller operating contract. */
  displayText?: string;
  attachments: Attachment[];
  titleHint?: string;
  skill?: string;
  appendBlock: boolean;
  clearAttachments?: boolean;
}

/** Everything the renderer sends OUTBOUND on a live session: the follow-up
 *  queue, its rendered preview, and the wire prompt each send builds from
 *  the composer's attachment chips.
 *
 *  It owns no transport and no turn state — the core hook injects `wsRef`,
 *  `setTurnBusy`, `setBlocks`, and `stop`, and drives the queue back from
 *  its event routing (`turn-end` and `steer-result` call
 *  `runNextQueuedPrompt`/`setQueuedPromptStatus`). `queuedPromptsRef` is
 *  created by the core because the scope-follow rule reads it too; every
 *  mutation still funnels through `mutateQueue` here.
 *
 *  Capabilities and attachments arrive only as their always-current refs:
 *  nothing here reads them during render, so a second render-value
 *  parameter for each would only be a second way to say the same thing. */
export function useAgentPromptQueue({
  agentShortName,
  capabilitiesRef,
  attachmentsRef,
  clearComposerAttachments,
  titleRef,
  queuedPromptsRef,
  turnActiveRef,
  setTurnBusy,
  setBlocks,
  openKindRef,
  wsRef,
  stop,
  knownFilePathsRef,
  sessionFolder,
}: {
  agentShortName: string;
  capabilitiesRef: RefObject<AgentPanelCapabilities>;
  attachmentsRef: RefObject<Attachment[]>;
  clearComposerAttachments: () => void;
  titleRef: RefObject<string>;
  queuedPromptsRef: RefObject<QueuedPrompt[]>;
  turnActiveRef: RefObject<boolean>;
  setTurnBusy: (active: boolean) => void;
  setBlocks: (next: Block[] | ((current: Block[]) => Block[])) => void;
  /** The stream block the transcript currently appends to. A send closes
   *  it so the next assistant delta opens a fresh bubble. */
  openKindRef: RefObject<'assistant' | 'thinking' | null>;
  wsRef: RefObject<WebSocket | null>;
  stop: () => void;
  knownFilePathsRef: RefObject<Set<string>>;
  /** The folder an attachment path resolves against — the session's bound
   *  folder, else the window's. Null for a library chat with no folder. */
  sessionFolder: () => string | null;
}) {
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurnPreview[]>([]);

  /** Rewrite the prompt queue and derive its rendered preview in the same
   *  step. The ref stays the queue's single source of truth; every mutation
   *  (and the session resets) must go through here or `clearQueue`. */
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

  /** Keep every queued follow-up visible as user-authored history when its
   * folder scope is retired, but make it inert so no later transition can
   * send it into another session. */
  function retireQueue() {
    mutateQueue((queue) => queue.map((prompt) => ({ ...prompt, status: 'cancelled' })));
  }

  function setQueuedPromptStatus(promptId: string, status: QueuedPrompt['status']) {
    mutateQueue((queue) => queue.map((p) => (p.id === promptId ? { ...p, status } : p)));
  }

  /** Remove one prompt only while it is still local and unsent. A stale
   * click must not discard a steer that already moved in flight. */
  function deleteQueuedPrompt(promptId: string) {
    mutateQueue((queue) => queue.filter((prompt) => prompt.id !== promptId || prompt.status !== 'waiting'));
  }

  function send(text: string, skill?: string) {
    const atts = attachmentsRef.current;
    const titleHint = capabilitiesRef.current?.titleHint && isDefaultChatTitle(titleRef.current) ? text : undefined;
    if (turnActiveRef.current) {
      mutateQueue((queue) => [...queue, { id: nextBlockId(), text, attachments: atts, titleHint, skill, status: 'waiting' }]);
      clearComposerAttachments();
      return;
    }
    void sendPromptNow({ text, attachments: atts, titleHint, skill, appendBlock: true, clearAttachments: true });
  }

  /** Send a product action while idle without borrowing composer attachments.
   * Its visible transcript text and wire text are deliberately identical. */
  function sendPreset(text: string) {
    if (turnActiveRef.current) return false;
    const titleHint = capabilitiesRef.current?.titleHint && isDefaultChatTitle(titleRef.current) ? text : undefined;
    void sendPromptNow({ text, attachments: [], titleHint, appendBlock: true });
    return true;
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
      { id: nextBlockId(), text, attachments: atts, titleHint, status: 'waiting' },
      ...queue,
    ]);
    clearComposerAttachments();
    stop();
  }

  /** Resend a failed prompt on a recovery card's behalf: explicit historical
   *  attachments (not the composer's chips), queued behind an active turn so
   *  an old card acted on mid-turn never races a concurrent prompt. */
  function resendFailedPrompt(retry: { text: string; attachments: Attachment[] }) {
    if (turnActiveRef.current) {
      mutateQueue((queue) => [...queue, { id: nextBlockId(), ...retry, status: 'waiting' }]);
      return;
    }
    void sendPromptNow({ ...retry, appendBlock: true });
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

  async function steerQueuedPrompt(promptId: string) {
    if (!capabilitiesRef.current?.steering) return;
    const prompt = queuedPromptsRef.current.find((p) => p.id === promptId && p.status === 'waiting');
    const ws = wsRef.current;
    if (!prompt || !ws || ws.readyState !== WebSocket.OPEN) return;
    setQueuedPromptStatus(promptId, 'steering');
    const ctx = await buildPromptContext(prompt.attachments);
    const wire = ctx.length ? `${prompt.text}${prompt.text ? '\n\n' : ''}${ctx.join('\n\n')}` : prompt.text;
    try {
      ws.send(JSON.stringify({ t: 'steer', id: promptId, text: wire }));
    } catch (err) {
      setQueuedPromptStatus(promptId, 'waiting');
      setBlocks((bs) => [...bs, { kind: 'error', id: nextBlockId(), text: `Could not steer Codex: ${errorMessage(err)}` }]);
    }
  }

  async function sendPromptNow({
    text,
    displayText,
    attachments: atts,
    titleHint,
    skill,
    appendBlock,
    clearAttachments = false,
  }: PromptToSend) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setTurnBusy(false);
      setBlocks((bs) => [...bs, { kind: 'error', id: nextBlockId(), text: `${agentShortName} is not connected.` }]);
      return;
    }
    if (appendBlock) {
      setBlocks((bs) => [...bs, { kind: 'user', id: nextBlockId(), text: displayText ?? text, attachments: atts.length ? atts : undefined, at: Date.now() }]);
    }
    setTurnBusy(true);
    openKindRef.current = null;
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
      setBlocks((bs) => [...bs, { kind: 'error', id: nextBlockId(), text: `Could not send message: ${errorMessage(err)}` }]);
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
    const contextFolder = sessionFolder();
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

  return {
    queuedTurns,
    clearQueue,
    retireQueue,
    setQueuedPromptStatus,
    deleteQueuedPrompt,
    runNextQueuedPrompt,
    steerQueuedPrompt,
    send,
    sendPreset,
    resend,
    resendFailedPrompt,
  };
}

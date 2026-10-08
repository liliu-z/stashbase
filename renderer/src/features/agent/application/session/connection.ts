/** The session's transport: opening a socket, retiring the one it replaces,
 *  and climbing the reconnect ladder when a live socket drops. Every callback
 *  a connection installs is tagged with the generation that created it, so a
 *  socket the runtime has already replaced can neither deliver events nor arm
 *  a reconnect. Nothing here reads the transcript; it only reports events. */
import type {
  AgentConnectionListener,
  AgentReconnectScheduler,
  AgentSessionPort,
  AgentSocket,
} from '@/features/agent/application/ports';
import type { AgentAccessMode } from '@/features/agent/domain/access';
import {
  agentReconnectAttempt,
  type AgentSessionAction,
  type AgentSessionEvent,
  type AgentSessionState,
} from '@/features/agent/domain/session';
import type { AgentSessionCommand } from '@/features/agent/domain/session-command';

const RECONNECT_DELAYS_MS = [250, 1_000, 3_000] as const;

const INTERRUPTED = 'Agent connection was interrupted. Reconnect to continue this conversation.';

/** The real clock: jittered waits that a runtime disposal cancels. A test
 *  substitutes its own so the ladder runs without wall time. */
export function createDefaultScheduler(): AgentReconnectScheduler {
  return {
    jitter(delayMs) {
      return Math.round(delayMs * (0.85 + Math.random() * 0.3));
    },
    wait(delayMs, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const timeout = setTimeout(resolve, delayMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
}

export interface AgentTransportOptions {
  disposed(): boolean;
  /** Delivers one server event, already known to belong to the live socket. */
  onEvent(event: AgentSessionEvent): void;
  port: AgentSessionPort;
  scheduler: AgentReconnectScheduler;
  signal: AbortSignal;
  state(): AgentSessionState;
  transition(action: AgentSessionAction): void;
}

export interface AgentTransport {
  /** Opens a socket, replacing whatever is open. `attempt` seeds the
   *  reconnect ladder; omit it to carry the current position forward. */
  open(options?: { resume?: string | undefined; attempt?: number | undefined }): void;
  /** Closes the socket and stops any pending reconnect from firing. */
  close(): void;
  /** Retires every in-flight generation, so late callbacks are ignored. */
  invalidate(): void;
  send(command: AgentSessionCommand): boolean;
  /** Records that the server ended this session, so the close that follows
   *  is not treated as a drop worth reconnecting from. */
  expectClose(): void;
  /** Sends a mode change and remembers it as the connected one. */
  applyAccessMode(mode: AgentAccessMode): boolean;
  /** Re-applies a mode the user picked while the socket was still opening. */
  syncAccessMode(): void;
  /** Sends a model choice and remembers it as the connected one. */
  applyModel(model: string | null): boolean;
  /** Re-applies a model the user picked while the socket was still opening. */
  syncModel(): void;
}

export function createAgentTransport({
  disposed,
  onEvent,
  port,
  scheduler,
  signal,
  state,
  transition,
}: AgentTransportOptions): AgentTransport {
  let connection: AgentSocket | null = null;
  let generation = 0;
  let closeExpected = false;
  let exitReceived = false;
  let appliedAccessMode: AgentAccessMode | null = null;
  let appliedModel: string | null = null;

  const closeSocket = () => {
    closeExpected = true;
    connection?.close();
    connection = null;
  };

  /** Waits out the next rung of the ladder and reopens, unless the runtime
   *  replaced this connection while the timer ran. */
  const scheduleReconnect = (capturedGeneration: number) => {
    const spent = agentReconnectAttempt(state().connection);
    const nextDelayMs = RECONNECT_DELAYS_MS[spent];
    if (nextDelayMs === undefined) {
      transition({ message: INTERRUPTED, kind: 'fail' });
      return;
    }
    transition({ attempt: spent + 1, kind: 'schedule-reconnect' });
    void scheduler.wait(scheduler.jitter(nextDelayMs), signal).then(
      () => {
        if (disposed() || signal.aborted || capturedGeneration !== generation) return;
        open({ resume: state().nativeSessionId ?? undefined });
      },
      () => undefined,
    );
  };

  function listenerFor(capturedGeneration: number): AgentConnectionListener {
    const current = () => !disposed() && capturedGeneration === generation;
    return {
      onClose() {
        if (!current() || closeExpected || exitReceived) return;
        scheduleReconnect(capturedGeneration);
      },
      onEvent(event) {
        if (!current()) return;
        onEvent(event);
      },
      onInvalidResponse() {
        if (!current()) return;
        closeExpected = true;
        connection?.close();
        transition({ message: 'Agent returned an invalid response.', kind: 'fail' });
      },
    };
  }

  function open(options: { resume?: string | undefined; attempt?: number | undefined } = {}) {
    if (disposed()) return;
    closeSocket();
    const capturedGeneration = ++generation;
    closeExpected = false;
    exitReceived = false;
    const session = state();
    appliedAccessMode = session.accessMode;
    // The socket URL carries the model, so the open itself applies it.
    appliedModel = session.model;
    transition({
      attempt: options.attempt ?? agentReconnectAttempt(session.connection),
      kind: 'connect',
    });
    try {
      connection = port.connect(
        {
          access: session.accessMode,
          agent: session.agent,
          effort: session.effort ?? undefined,
          model: session.model ?? undefined,
          persona: session.persona ?? undefined,
          resume: options.resume,
          scope: session.scope,
        },
        listenerFor(capturedGeneration),
      );
    } catch {
      transition({ message: 'Agent connection could not start.', kind: 'fail' });
    }
  }

  return {
    open,
    close: closeSocket,
    invalidate() {
      generation += 1;
    },
    send(command) {
      return connection?.send?.(command) ?? false;
    },
    expectClose() {
      exitReceived = true;
      closeExpected = true;
      connection?.close();
    },
    applyAccessMode(mode) {
      const sent = connection?.send?.({ kind: 'set-access-mode', mode }) ?? false;
      if (sent) appliedAccessMode = mode;
      return sent;
    },
    syncAccessMode() {
      const mode = state().accessMode;
      if (mode === appliedAccessMode) return;
      if (connection?.send?.({ kind: 'set-access-mode', mode })) appliedAccessMode = mode;
    },
    applyModel(model) {
      const sent = connection?.send?.({ kind: 'select-model', model }) ?? false;
      if (sent) appliedModel = model;
      return sent;
    },
    syncModel() {
      const model = state().model;
      if (model === appliedModel) return;
      if (connection?.send?.({ kind: 'select-model', model })) appliedModel = model;
    },
  };
}

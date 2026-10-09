/**
 * Which runtimes a conversation can run on, and what the catalog of them
 * looks like once it has left the transport.
 *
 * The registry below is the single place a runtime is declared: its id, the
 * label chats and titlebars read, and which entry a new chat falls back to.
 * Adding a runtime is one entry, so nothing else in the feature spells an
 * agent id out by hand.
 */
import type { AgentAccessMode } from '@/features/agent/domain/access';
import type { AgentModel } from '@/features/agent/domain/runtime-catalog';
import type { AgentId } from '@/features/agent/domain/session';

/** What a turn on this runtime may use. The service advertises capabilities it
 *  may omit entirely; a conversation only ever asks yes or no, so absence is
 *  resolved at the adapter rather than at every read. */
export interface AgentAbilities {
  /** Whether this runtime can read transient uploaded bytes: an image or PDF
   *  picked, pasted, or dragged in from outside the project. It says nothing
   *  about referencing a project source, which is a path the agent reads back
   *  through MCP and which every runtime can use. A text-only model reports
   *  false here and still takes mentions and source drags. */
  readonly attachments: boolean;
  readonly effort: boolean;
  readonly models: boolean;
  /** The permission promises this runtime can honor, in the composer's
   *  order; empty means the mode control is not shown for it. */
  readonly modes: readonly AgentAccessMode[];
  readonly skills: boolean;
}

/**
 * One runtime as a conversation reads it: whether it can carry a turn right
 * now, what stands in the way when it cannot, and what a turn on it may use.
 *
 * Settings reads the same endpoint for a different question — how far staged
 * preparation has got — and models it separately for that reason. Neither
 * feature reads the other's shape, and neither reads the transport's.
 */
export interface Agent {
  readonly id: AgentId;
  readonly label: string;
  /** Whether this runtime can carry a conversation right now. */
  readonly ready: boolean;
  /** Whether the one thing between it and ready is the user signing in. */
  readonly needsSignIn: boolean;
  readonly preparing?: boolean;
  /** Whether the host can update this runtime. */
  readonly updatable?: boolean;
  readonly setupFailure?: AgentSetupFailure;
  readonly abilities: AgentAbilities;
  /** The catalog the service remembers for this runtime, so a fresh chat can
   *  name the model and level it will run on before a session exists. Empty
   *  until the runtime has been read once. */
  readonly models: readonly AgentModel[];
  /** A model the runtime says it is too old to run, when it says so. A
   *  conversation reads it to offer the update once; absence is the normal
   *  state and says nothing. */
  readonly upgrade?: AgentUpgradeOffer;
}

/** The step that stopped preparation and the service's explanation. */
export interface AgentSetupFailure {
  readonly stage: 'discovery' | 'installation' | 'authentication' | 'mcp';
  readonly message: string;
}

/** A model an installed runtime cannot run yet, named by that runtime. */
export interface AgentUpgradeOffer {
  /** What the runtime calls the model. */
  readonly model: string;
  /** The runtime's own sentence about what using it takes. */
  readonly note: string;
}

/** What the Agent service says it can run right now. `agents` — never the
 *  transport's own field name — is the vocabulary every reader uses. */
export interface AgentCatalog {
  readonly agents: readonly Agent[];
}

/** A declared runtime: the id the transport names it by and the label a
 *  reader sees. */
interface AgentRuntimeEntry {
  readonly id: AgentId;
  readonly label: string;
}

/** The runtime a project uses until the user chooses another Agent. */
const BUILT_IN: AgentRuntimeEntry = { id: 'stashbase', label: 'Default' };

/** Every runtime this window can hold a conversation with, in the order
 *  chats and history lists present them. */
const AGENT_RUNTIMES: readonly AgentRuntimeEntry[] = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  BUILT_IN,
];

/** The one declared default. Nothing else may name a runtime id literally. */
export const DEFAULT_AGENT_ID: AgentId = BUILT_IN.id;

export const AGENT_ORDER: readonly AgentId[] = AGENT_RUNTIMES.map((entry) => entry.id);

export function agentLabel(id: AgentId): string {
  return AGENT_RUNTIMES.find((entry) => entry.id === id)?.label ?? id;
}

/** A runtime the catalog has not described yet: selectable by name, ready
 *  for nothing, able to use nothing until the catalog answers for it. */
export function undescribedAgent(id: AgentId): Agent {
  return {
    id,
    label: agentLabel(id),
    ready: false,
    needsSignIn: false,
    models: [],
    abilities: { attachments: false, effort: false, models: false, modes: [], skills: false },
  };
}

/**
 * What stands between this window and a sendable conversation.
 *
 * `checking` holds the offer back until the catalog has answered: treating an
 * unanswered catalog as "nothing ready" shows the setup offer for a moment and
 * then withdraws it from a reader who is already set up.
 */
export type AgentGate =
  | { readonly kind: 'ready'; readonly agent: Agent }
  | { readonly kind: 'checking' }
  | { readonly kind: 'setup'; readonly pending: readonly Agent[] };

/**
 * Which of the three the window is in. The selected runtime decides it — a
 * conversation is bound to one, and another runtime being ready does not make
 * this conversation sendable.
 */
export function agentGate(input: {
  agents: readonly Agent[];
  /** The catalog has not answered yet. */
  loading: boolean;
  selected: AgentId;
}): AgentGate {
  const ready = input.agents.find((agent) => agent.id === input.selected && agent.ready);
  if (ready) return { agent: ready, kind: 'ready' };
  if (input.loading) return { kind: 'checking' };
  return { kind: 'setup', pending: input.agents.filter((agent) => !agent.ready) };
}

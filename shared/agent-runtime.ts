/**
 * Agent runtime discovery and bootstrap vocabulary, shared by the server
 * that performs a bootstrap and the renderer that reports its progress.
 *
 * Every field here reaches the user as chrome: a phase drives the Agents
 * panel's button, and a failure decides whether that button offers a retry
 * or a manual recovery route. Both processes therefore have to agree on the
 * exact spelling of each state, which is what makes this a contract rather
 * than an implementation detail of either side.
 */

export type AgentBootstrapPhase = 'idle' | 'installing' | 'authenticating' | 'configuring' | 'ready' | 'failed';

/** The product's four permission promises, in the order the composer offers
 * them: Ask, Edit, Plan, Auto. A runtime declares which of them it can honor
 * in its `modes` capability; the wording of each promise is the product's,
 * and each adapter owns how its native policy fulfils it. */
export const AGENT_ACCESS_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];

export type AgentBootstrapFailureStage = 'discovery' | 'installation' | 'authentication' | 'mcp';

export type AgentBootstrapFailureCode =
  | 'simulated'
  | 'operation-failed'
  | 'runtime-unavailable'
  | 'account-required'
  | 'authentication-required'
  | 'authentication-check-failed';

export type AgentBootstrapManualRecovery = 'install-command' | 'mcp-settings';
export type AgentBootstrapAction = 'bootstrap' | 'login' | 'update';

export interface AgentBootstrapFailure {
  stage: AgentBootstrapFailureStage;
  code: AgentBootstrapFailureCode;
  message: string;
  retryable: boolean;
  manualRecovery?: AgentBootstrapManualRecovery;
  /** Retry the operation that failed, rather than only rechecking readiness. */
  retryAction?: AgentBootstrapAction;
}

export interface AgentBootstrapStatus {
  phase: AgentBootstrapPhase;
  progress?: number;
  message?: string;
  failure?: AgentBootstrapFailure;
}


export type AgentSetupFailureSimulation = 'none' | 'installation' | 'authentication' | 'mcp';

export type AgentTurnFailureSimulation =
  | 'none'
  | 'rate-limit'
  | 'quota'
  | 'auth-expired'
  | 'network'
  | 'crash';

export interface AgentRuntimeDebugState {
  enabled: boolean;
  /** Development-only, mutually exclusive failure for the next matching
   * readiness stage. A consumed failure resets this field to `none`. */
  nextFailure: AgentSetupFailureSimulation;
  /** Development-only failure for the next prompt in any live Agent session.
   * One-shot like `nextFailure`; independent of the setup simulation. */
  nextTurnFailure: AgentTurnFailureSimulation;
}

/** What a runtime was last seen offering: its models in its own order, the
 * model it ran when nothing was chosen, and when that was read. A property
 * of the runtime rather than of any chat, remembered by the server. */
export interface AgentModelCatalog {
  models: import('./agent-protocol.ts').AgentModel[];
  defaultModel?: string;
  readAt: string;
}

/** A model an installed runtime says it is too old to run, in that runtime's
 * own words. StashBase compares no versions of its own: the runtime knows
 * which models its account may use and which of them its build cannot run,
 * and this carries that answer through. */
export interface AgentUpgradeOffer {
  model: string;
  note: string;
}

export interface Agent {
  id: import('./agent-protocol.ts').AgentId;
  label: string;
  vendor: string;
  installHint: string;
  installed: boolean;
  /** Runtime ownership. `bundled` ships with StashBase, `system` is a provider-owned
   * installation discovered on the user’s machine. */
  source?: 'bundled' | 'system' | null;
  /** The installed runtime's own version string, when its executable reports
   * one; null for a runtime that is missing or does not say. */
  version?: string | null;
  /** Whether StashBase can update this runtime through its official native installer. */
  updatable?: boolean;
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
    attachments: boolean;
    /** The permission promises this runtime can honor; empty hides the control. */
    modes: readonly AgentAccessMode[];
    effort: boolean;
    models: boolean;
    skills: boolean;
    steering: boolean;
    titleHint: boolean;
  };
  /** Present once the runtime's catalog has been read at least once. */
  catalog?: AgentModelCatalog;
  /** Present only while the runtime names a model it is too old to run. */
  upgrade?: AgentUpgradeOffer;
}

export interface AgentsResponse {
  clis: Agent[];
  debug?: AgentRuntimeDebugState;
}

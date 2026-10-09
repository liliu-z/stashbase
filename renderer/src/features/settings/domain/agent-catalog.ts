/**
 * What the Agents panel reads once the transport's own envelope is gone.
 *
 * The service answers with a CLI list, a per-agent bootstrap block whose phase
 * sits beside a nullable failure, and a debug block it decides whether to send
 * at all. None of those shapes is what a panel wants to read: this feature says
 * `runtimes`, carries a failure only inside the preparation that failed, names
 * its stages the way the track draws them, and treats withheld debug controls
 * as an explicit absence. The adapter is the one place the two vocabularies
 * meet, so a rename on the wire is an adapter change rather than a sweep
 * through the panel.
 */
import type { AgentId } from '@/shared/domain/agent-id';

/** The four staged-preparation segments the track renders, in order, plus the
 *  terminal `ready` state that owns no segment of its own. */
const AGENT_RUNTIME_STAGES = ['discover', 'install', 'authenticate', 'configure', 'ready'] as const;

export type AgentRuntimeStage = (typeof AGENT_RUNTIME_STAGES)[number];

/** A stage a preparation can still be standing on. Neither terminal stage is
 *  one: `discover` is where a runtime sits before anything has run, and `ready`
 *  is where it sits once everything has. */
export type AgentPreparationStage = Exclude<AgentRuntimeStage, 'discover' | 'ready'>;

/** Who owns a runtime's installation. `bundled` ships with StashBase,
 *  `system` is installed and owned by the user/provider. */
type AgentRuntimeOwnership = 'bundled' | 'system';

/** Why a staged preparation stopped. The panel offers a different recovery for
 *  an account that has to exist first than for a step that can simply be run
 *  again, so the reason is named rather than buried in a sentence. */
type AgentPreparationRefusal =
  | 'simulated'
  | 'operation-failed'
  | 'runtime-unavailable'
  | 'account-required'
  | 'authentication-required'
  | 'authentication-check-failed';

export interface AgentPreparationFailure {
  /** Which stage stopped. */
  readonly stage: AgentRuntimeStage;
  readonly refusal: AgentPreparationRefusal;
  /** The service's own sentence, or null when it sent none. Only the service
   *  knows which piece is missing, so its wording is what the row shows. */
  readonly note: string | null;
  readonly retryAction?: 'install' | 'login' | 'update';
}

/**
 * Where one runtime's staged preparation stands.
 *
 * A failure belongs to a preparation that failed and to nothing else, so it
 * lives inside that member: "still installing, with a reason attached" is no
 * longer a state anything can spell.
 */
export type AgentPreparation =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly stage: AgentPreparationStage;
      /** What the service is narrating, or null when it narrates nothing. */
      readonly note: string | null;
    }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly failure: AgentPreparationFailure };

/** One agent runtime, as the Agents panel presents it. */
export interface AgentRuntime {
  readonly id: AgentId;
  /** What the reader sees this runtime called. */
  readonly label: string;
  /** Whether a runtime is present on this machine at all. */
  readonly installed: boolean;
  /** Who owns the installation, or null when the service did not say. */
  readonly ownership: AgentRuntimeOwnership | null;
  /** Where staged preparation stands. A runtime the service has not reported
   *  a bootstrap for is `idle`. */
  readonly preparation: AgentPreparation;
  /** The installed runtime's own version, or null when it reports none. */
  readonly version: string | null;
  /** Whether the host can update the runtime's native installation. */
  readonly updatable: boolean;
  /** A model the runtime says it is too old to run, when it says so. Null is
   *  the normal state, and a runtime that reports nothing reads the same as
   *  one with nothing to report, because the row says nothing extra either
   *  way. */
  readonly upgrade: AgentUpgradeOffer | null;
}

/** A model an installed runtime cannot run yet, named by that runtime. */
interface AgentUpgradeOffer {
  /** What the runtime calls the model. */
  readonly model: string;
  /** The runtime's own sentence about what using it takes. */
  readonly note: string;
}

/** A one-shot simulated outcome for the next staged preparation. */
export type AgentSetupSimulation = 'none' | 'installation' | 'authentication' | 'mcp';

/** A one-shot simulated outcome for the next prompt in any live session. */
export type AgentTurnSimulation =
  | 'none'
  | 'rate-limit'
  | 'quota'
  | 'auth-expired'
  | 'network'
  | 'crash';

/** The development-only controls, as the block that renders them reads them.
 *  The service's own `enabled` flag never reaches here: a catalog either
 *  carries these controls or it does not. */
export interface AgentDebugControls {
  readonly nextSetupResult: AgentSetupSimulation;
  readonly nextTurnResult: AgentTurnSimulation;
}

/** A change to one or more debug controls. */
export type AgentDebugPatch = Partial<AgentDebugControls>;

export interface AgentCatalog {
  readonly runtimes: readonly AgentRuntime[];
  /** Development-only controls, or null when the service withheld them. */
  readonly debug: AgentDebugControls | null;
}

/** The standing hosted allowance, as the allowance row presents it. */
export interface AgentAllowance {
  /** How much of the 7-day window is left, as a percentage. */
  readonly remainingPercent: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** When the window closes, or null before the allowance is first used. */
  readonly windowEndsAt: string | null;
}

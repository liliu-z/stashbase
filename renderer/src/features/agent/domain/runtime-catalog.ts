/** What a runtime says it can offer in this scope: the models a turn can run
 *  on and the skills a prompt can arm. Detail the runtime withheld is a
 *  missing key rather than an undefined one, so a reader tests for it once. */

export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  /** The release an alias resolves to ("Opus 5.5" for Claude's "Opus"),
   *  where the runtime names models by alias. */
  release?: string;
  /** Effort levels this model accepts; a model that names none runs only at
   *  whatever the runtime defaults to. */
  supportedEfforts?: string[];
  /** The effort the runtime runs this model at when none is chosen. */
  defaultEffort?: string;
  /** Whether the runtime runs this model when none is chosen. Codex flags its
   *  newest model; a runtime that says nothing leaves every entry unflagged. */
  isDefault?: boolean;
  /** Price relative to the runtime's default model (1). Only the hosted
   *  StashBase Agent reports it; the picker flags models well above 1. */
  relativeCost?: number;
}

export interface AgentSkill {
  id: string;
  label: string;
  description?: string;
  argumentHint?: string;
}

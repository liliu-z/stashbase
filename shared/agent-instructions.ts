/** A concrete working directory whose product-owned Agent Instructions can
 * customize the packaged default. Instructions never belong to Library-wide
 * retrieval scope and are never stored in the user's source folder. */
export type AgentInstructionsScope = { kind: 'folder'; path: string };

export interface AgentInstructionsState {
  scope: AgentInstructionsScope;
  text: string;
  customized: boolean;
}

/** Large enough for durable workspace guidance, bounded so one setting cannot
 * dominate every Agent prompt or make config.json grow without limit. */
export const MAX_AGENT_INSTRUCTIONS_LENGTH = 32_000;

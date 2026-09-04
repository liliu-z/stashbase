/** The scope whose product-owned Agent Instructions can customize a packaged
 * default: a concrete working directory, or the Library as a whole (a Chat
 * with no working folder). Each kind has its own packaged default, and
 * instructions are never stored in the user's source folder. */
export type AgentInstructionsScope = { kind: 'folder'; path: string } | { kind: 'library' };

export interface AgentInstructionsState {
  scope: AgentInstructionsScope;
  text: string;
  customized: boolean;
}

/** Large enough for durable workspace guidance, bounded so one setting cannot
 * dominate every Agent prompt or make config.json grow without limit. */
export const MAX_AGENT_INSTRUCTIONS_LENGTH = 32_000;

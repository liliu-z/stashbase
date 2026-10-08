/**
 * A persona: who the Agent is when it talks and writes.
 *
 * The reader keeps a library of them, shared by every project. Each Chat runs
 * under one persona or none, and a project remembers the one its next new
 * Chat starts with. The prompt is the exact text a session receives.
 */

/** The icons a persona may wear. Names are lucide's, so the renderer maps
 *  each to its glyph; anything else reads as the default. */
export const AGENT_PERSONA_ICONS = [
  'drama',
  'hammer',
  'megaphone',
  'newspaper',
  'book-open',
  'pen-line',
  'feather',
  'graduation-cap',
  'briefcase',
  'lightbulb',
  'mic',
  'heart',
  'scale',
  'code',
  'compass',
  'flask-conical',
  'message-circle',
  'smile',
] as const;

export type AgentPersonaIcon = (typeof AGENT_PERSONA_ICONS)[number];

export const DEFAULT_AGENT_PERSONA_ICON: AgentPersonaIcon = 'drama';

export function isAgentPersonaIcon(value: unknown): value is AgentPersonaIcon {
  return (AGENT_PERSONA_ICONS as readonly unknown[]).includes(value);
}

/** Large enough for a detailed persona, bounded so one persona cannot
 * dominate every Agent prompt. */
export const MAX_AGENT_PERSONA_LENGTH = 32_000;
export const MAX_AGENT_PERSONA_NAME_LENGTH = 80;
export const MAX_AGENT_PERSONA_DESCRIPTION_LENGTH = 200;

/** Lowercase, filesystem-safe, and never a path: an id names one file in the
 *  library directory. */
export const AGENT_PERSONA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,95}$/u;

export function isAgentPersonaId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_PERSONA_ID_PATTERN.test(value);
}

export interface AgentPersona {
  id: string;
  name: string;
  /** One line under the name in the picker. */
  description: string;
  icon: AgentPersonaIcon;
  prompt: string;
  /** The Gallery entry this persona was added from. A copy: later Gallery
   *  changes never reach it. Null for the reader's own. */
  gallery: string | null;
}

/** What a reader writes when creating or editing a persona. */
export interface AgentPersonaInput {
  name: string;
  description: string;
  icon: AgentPersonaIcon;
  prompt: string;
  gallery?: string | null;
}

/** How much a turn may do on its own. The four modes are the product's own
 *  promises, worded the same for every Agent: Ask asks before every change
 *  and command, Edit edits inside the folder and asks for anything else,
 *  Plan reads and explores and changes nothing, Auto lets the runtime's own
 *  reviewer pass routine actions and pause for risky ones. A runtime declares
 *  which of them it can honor; a session carries the one in force, and the
 *  transport's spelling of them is mapped in `infrastructure/session-api`. */
export type AgentAccessMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

/** Every promise, in the order the composer offers them. */
export const AGENT_ACCESS_MODES: readonly AgentAccessMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'auto',
];

/** Where a session settles when its runtime cannot honor the mode it is in:
 *  Auto when the runtime offers it, else Edit, else Ask, else whatever comes
 *  first, so a new chat starts as hands-off as the runtime can keep. A
 *  runtime that honors nothing takes no mode at all, so the current one is
 *  left alone rather than replaced with a promise nobody keeps. */
export function honoredAccessMode(
  honored: readonly AgentAccessMode[],
  current: AgentAccessMode,
): AgentAccessMode {
  if (honored.length === 0 || honored.includes(current)) return current;
  const preferred = (['auto', 'acceptEdits', 'default'] as const).find((mode) =>
    honored.includes(mode),
  );
  return preferred ?? honored[0] ?? current;
}

/** Shared mode choices. Each runtime owns its permission rules; the composer
 *  describes those differences. Native mode reports reconcile the session's
 *  selection when the runtime rejects or falls back from a requested mode. */
export type AgentAccessMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

/** Every mode, in the order the composer offers them. */
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

import type { AgentBootstrapStatus } from '../../apiTypes';

export type AgentRuntimeFailureAction = 'copy-install-command' | 'open-mcp-settings';
export type AgentRuntimeFailurePrimaryAction = 'retry-bootstrap' | 'start-codex-login';

export interface AgentRuntimeFailurePresentation {
  title: string;
  message: string;
  retryLabel: string;
  primaryAction: AgentRuntimeFailurePrimaryAction;
  manualAction?: AgentRuntimeFailureAction;
  manualLabel?: string;
}

/** Convert the server-owned readiness failure into UI copy and actions.
 * The renderer never infers a recovery from an error string: a manual action
 * exists only when the structured contract explicitly advertises one. */
export function runtimeFailurePresentation(
  status: AgentBootstrapStatus | undefined,
  name: string,
): AgentRuntimeFailurePresentation {
  const failure = status?.failure;
  const message = failure?.message ?? 'The runtime setup did not finish.';
  const manual = failure?.manualRecovery;
  const manualAction = manual === 'install-command'
    ? 'copy-install-command'
    : manual === 'mcp-settings'
      ? 'open-mcp-settings'
      : undefined;
  const manualLabel = manual === 'install-command'
    ? 'Copy install command'
    : manual === 'mcp-settings'
      ? 'View manual setup'
      : undefined;

  switch (failure?.stage) {
    case 'installation':
      return {
        title: `Couldn’t install ${name}`,
        message,
        retryLabel: 'Retry',
        primaryAction: 'retry-bootstrap',
        manualAction,
        manualLabel,
      };
    case 'authentication':
      if (failure.code === 'authentication-check-failed') {
        return {
          title: `Couldn’t check ${name} sign-in`,
          message,
          retryLabel: 'Retry',
          primaryAction: 'retry-bootstrap',
        };
      }
      return {
        title: failure.code === 'authentication-required' ? `Sign in to ${name}` : `Couldn’t sign in to ${name}`,
        message,
        retryLabel: failure.code === 'authentication-required' ? 'Sign in with ChatGPT' : 'Retry sign-in',
        primaryAction: 'start-codex-login',
      };
    case 'mcp':
      return {
        title: `Couldn’t connect StashBase to ${name}`,
        message,
        retryLabel: 'Retry connection',
        primaryAction: 'retry-bootstrap',
        manualAction,
        manualLabel,
      };
    case 'discovery':
      return {
        title: `Couldn’t check ${name}`,
        message,
        retryLabel: 'Retry',
        primaryAction: 'retry-bootstrap',
        manualAction,
        manualLabel,
      };
    default:
      return {
        title: `Couldn’t prepare ${name}`,
        message,
        retryLabel: 'Retry',
        primaryAction: 'retry-bootstrap',
      };
  }
}

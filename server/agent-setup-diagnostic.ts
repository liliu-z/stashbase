/** The runtime is signed in, but its provider refuses the account (a region
 * or eligibility rule). Signing in again cannot help, so readiness reports it
 * apart from a missing or unreadable sign-in. The message is the provider's. */
export class AgentAccountRefusedError extends Error {}

/** The provider explicitly rejected the stored credential during a status
 * probe. A later cached signed-in result cannot replace a new browser login. */
export class AgentAuthenticationRequiredError extends Error {}

/** Native configuration prevents the runtime from checking sign-in. A
 * browser login cannot repair it; recheck after the reader fixes the config. */
export class AgentConfigurationError extends Error {}

/** Preserve bounded, plain-text setup diagnostics, including Node fetch causes. */
export function agentSetupDiagnostic(error: unknown): string {
  const seen = new Set<unknown>();
  function describe(value: unknown, depth: number): string {
    if (depth > 4 || seen.has(value)) return '';
    seen.add(value);
    if (!(value instanceof Error)) return String(value ?? '');
    const code = 'code' in value ? String(value.code) : '';
    const message = value.message;
    const children = value instanceof AggregateError ? value.errors : [value.cause];
    return [code && !message.includes(code) ? `${code}: ${message}` : message,
      ...children.filter(Boolean).map((child) => describe(child, depth + 1))].filter(Boolean).join('\n');
  }
  const text = describe(error, 0).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  // Leave room for Agent/action/stage inside the wire's 2,000-character bound.
  return text.length > 1800 ? `${text.slice(0, 850)}\n…\n${text.slice(-900)}` : text;
}

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

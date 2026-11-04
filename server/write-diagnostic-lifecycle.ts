/** Keep consent invalidation independent of the telemetry/store import graph. */
const resets = new Set<() => void>();
export function onWriteDiagnosticsReset(reset: () => void): () => void { resets.add(reset); return () => resets.delete(reset); }
export function resetWriteDiagnostics(): void { for (const reset of resets) { try { reset(); } catch { /* Fail closed at admission too. */ } } }

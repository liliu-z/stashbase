import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import packageInfo from '../package.json' with { type: 'json' };
import { markDiagnosticReported } from './error-diagnostics.ts';
import { WRITE_STAGES, type DiagnosticValue, type WriteStage, type WriteOperationDiagnostic, type WriteFailure } from '../shared/protocols/write-diagnostics.ts';
export type { DiagnosticValue, WriteStage } from '../shared/protocols/write-diagnostics.ts';

type Trace = { operation: WriteOperationDiagnostic; start: number; sequence: number; bytes: number; resolvedTarget: boolean;
  resolvingTarget?: string; observedRealTarget?: string;
  failures: WeakMap<object, { stage: WriteStage; action: string }> };
const traces = new AsyncLocalStorage<Trace>();
const stages = new AsyncLocalStorage<WriteStage>();
const errorIds = new WeakMap<object, { operation_id: string; diagnostic_id: string }>();
const MAX_EVIDENCE_BYTES = 768 * 1024;
export function escapeDiagnosticPath(raw: string): string {
  return JSON.stringify(raw).replace(/[^\x20-\x7e]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function isWriteDiagnosticActive(): boolean { return !!traces.getStore(); }
export function writeDiagnosticErrorIds(error: unknown) {
  return error && typeof error === 'object' ? errorIds.get(error) : undefined;
}
export function attachWriteDiagnosticErrorIds(error: object, ids: { operation_id?: unknown; diagnostic_id?: unknown }): void {
  const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
  if (typeof ids.operation_id === 'string' && uuid.test(ids.operation_id) && typeof ids.diagnostic_id === 'string' && uuid.test(ids.diagnostic_id))
    errorIds.set(error, { operation_id: ids.operation_id, diagnostic_id: ids.diagnostic_id });
}
export function copyWriteDiagnosticErrorIds(from: unknown, to: object): void {
  const ids = writeDiagnosticErrorIds(from);
  if (ids) errorIds.set(to, ids);
}
/** No exception messages: third-party messages and the first stack line may
 * contain document excerpts. Paths are retained only in explicit path fields. */
export function writeDiagnosticError(error: unknown): WriteFailure {
  const e = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const safeLabel = (v: unknown) => typeof v === 'string' && /^[\w.:-]{1,100}$/.test(v) ? v : undefined;
  return { name: safeLabel(e.name) ?? 'Error', code: safeLabel(e.code) ?? 'UNCLASSIFIED_EXCEPTION',
    ...(typeof e.errno === 'number' || safeLabel(e.errno) ? { errno: e.errno as string | number } : {}),
    ...(safeLabel(e.syscall) ? { syscall: e.syscall as string } : {}),
    ...(typeof e.path === 'string' ? { path: e.path } : {}),
    ...(typeof e.dest === 'string' ? { dest: e.dest } : {}),
    stack: typeof e.stack === 'string' ? e.stack.split('\n').slice(1).filter(line => /^\s+at .*(?:\/server\/|\/dist\/server\/|\\server\\)/.test(line) && !line.includes('eval')).slice(0, 24) : [],
  };
}
function append(trace: Trace, step: WriteOperationDiagnostic['steps'][number]): void {
  const size = JSON.stringify(step).length * 2;
  if (trace.operation.steps.length >= 2048 || trace.bytes + size > MAX_EVIDENCE_BYTES) {
    trace.operation.completeness = 'partial';
    if (!trace.operation.gaps.includes('evidence_limit')) trace.operation.gaps.push('evidence_limit');
    return;
  }
  trace.bytes += size;
  trace.operation.steps.push(structuredClone(step));
}
export function writeDiagnosticEvidence(action: string, evidence: Record<string, DiagnosticValue>): void {
  const trace = traces.getStore();
  if (!trace) return;
  if (action === 'path.resolve_under.inputs' && typeof evidence.target_native === 'string') {
    trace.resolvingTarget = evidence.target_native; trace.observedRealTarget = undefined;
  }
  if (action === 'path.realpath' && evidence.path === trace.resolvingTarget && evidence.outcome === 'ok' && typeof evidence.result === 'string') {
    // Only the exact existing target, never a missing target's ancestor. This
    // reuses the identity already computed by the containment owner below.
    trace.observedRealTarget = evidence.result;
  }
  if (!trace.resolvedTarget && action === 'path.contains' && typeof evidence.candidate === 'string' && typeof evidence.candidate_identity === 'string') {
    if (evidence.candidate === trace.observedRealTarget) setWriteDiagnosticTarget(evidence.candidate_identity);
    const target = [...trace.operation.steps].reverse().find(step => step.action === 'project_path.absolute')?.evidence.normalized_path;
    if (!trace.resolvedTarget && target === evidence.candidate) trace.operation.target_identity = evidence.candidate_identity;
  }
  append(trace, { sequence: ++trace.sequence, stage: stages.getStore() ?? 'path_resolution', action,
    started_ms: performance.now() - trace.start, duration_ms: 0, result: 'observed', evidence });
}
export function writeDiagnosticStep<T>(stage: WriteStage, action: string, work: () => T, evidence: Record<string, DiagnosticValue> = {}): T {
  const trace = traces.getStore();
  if (!trace) return work();
  const start = performance.now();
  const sequence = ++trace.sequence;
  const finish = (error?: unknown) => {
    trace.operation.stages[stage] = error === undefined ? 'success' : 'failed';
    if (error && typeof error === 'object' && !trace.failures.has(error)) trace.failures.set(error, { stage, action });
    append(trace, { sequence, stage, action, started_ms: start - trace.start, duration_ms: performance.now() - start,
      result: error === undefined ? 'success' : 'failed', evidence, ...(error === undefined ? {} : { error: writeDiagnosticError(error) }) });
  };
  return stages.run(stage, () => {
    try {
      const result = work();
      if (result && typeof (result as any).then === 'function') {
        return Promise.resolve(result).then(value => { finish(); return value; }, error => { finish(error); throw error; }) as T;
      }
      finish(); return result;
    } catch (error) { finish(error); throw error; }
  });
}
export function setWriteDiagnosticTarget(identity: string): void {
  const trace = traces.getStore();
  if (trace) { trace.operation.target_identity = identity; trace.resolvedTarget = true; }
}
export interface WriteDiagnosticInput {
  operation: 'write' | 'edit'; path: unknown; origin: 'agent' | 'http' | 'mcp'; runtime?: string;
  request_id?: string; turn_id?: string; tool_call_id?: string; runtime_version?: string;
  session_root?: string | null;
}
/** Exposed for deterministic fixture capture. Admission and persistence belong
 * to the production owner, so observation never depends on I/O. */
export async function traceWriteOperation<T>(input: WriteDiagnosticInput, work: () => Promise<T>, complete: (operation: WriteOperationDiagnostic) => void): Promise<T> {
  if (traces.getStore()) return work();
  const raw = typeof input.path === 'string' ? input.path : null;
  const limited = raw !== null && raw.length > 32768;
  const operation: WriteOperationDiagnostic = {
    operation_id: randomUUID(), diagnostic_id: randomUUID(), operation: input.operation, origin: input.origin,
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.request_id ? { request_id: input.request_id } : {}), ...(input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(input.tool_call_id ? { tool_call_id: input.tool_call_id } : {}),
    correlation: { request: input.request_id ? 'linked' : 'unavailable', turn: input.turn_id ? 'linked' : 'unavailable', tool: input.tool_call_id ? 'linked' : 'unavailable' },
    runtime_version: input.runtime_version ?? null, app_version: packageInfo.version, node_version: process.version, os: process.platform, arch: process.arch,
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 0,
    raw_path: limited ? raw!.slice(0, 32768) : raw, escaped_path: raw === null ? null : escapeDiagnosticPath(limited ? raw.slice(0, 32768) : raw), raw_path_type: typeof input.path,
    session_root: input.session_root ?? null, session_scope: input.session_root === undefined ? 'external' : input.session_root === null ? 'no_project' : 'bound',
    target_id: randomUUID(), target_identity: null, target_relation: 'unavailable', outcome: 'success',
    stages: Object.fromEntries(WRITE_STAGES.map(stage => [stage, 'not_reached'])) as WriteOperationDiagnostic['stages'], steps: [],
    completeness: limited ? 'partial' : 'complete', gaps: limited ? ['raw_path_limit'] : [],
  };
  const trace: Trace = { operation, start: performance.now(), sequence: 0, bytes: 0, resolvedTarget: false, failures: new WeakMap() };
  let failed: object | undefined;
  return traces.run(trace, async () => {
    try {
      const result = await work();
      if (result && typeof result === 'object' && 'changed' in result && typeof result.changed === 'boolean') operation.changed = result.changed;
      return result;
    } catch (error) {
      operation.outcome = 'failed'; operation.error = writeDiagnosticError(error);
      if (error && typeof error === 'object') {
        const failure = trace.failures.get(error);
        if (failure) { operation.failed_stage = failure.stage; operation.failed_action = failure.action; operation.stages[failure.stage] = 'failed'; }
        else { operation.completeness = 'partial'; operation.gaps.push('unobserved_failure_branch'); }
        errorIds.set(error, { operation_id: operation.operation_id, diagnostic_id: operation.diagnostic_id });
        markDiagnosticReported(error);
        failed = error;
      }
      throw error;
    } finally {
      operation.duration_ms = performance.now() - trace.start; operation.finished_at = new Date().toISOString();
      operation.steps.sort((a, b) => a.sequence - b.sequence);
      try { complete(operation); } catch { /* Diagnostic failures never change a write outcome. */ }
      if (failed) errorIds.set(failed, { operation_id: operation.operation_id, diagnostic_id: operation.diagnostic_id });
    }
  });
}

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appDataRoot } from './local-data.ts';
import { telemetry } from './telemetry.ts';
import { onWriteDiagnosticsReset } from './write-diagnostic-lifecycle.ts';
import { traceWriteOperation, type WriteDiagnosticInput } from './write-diagnostic-context.ts';
import { diagnosticScope } from './diagnostic-context.ts';
import { writeDiagnosticBundleSchema, type WriteDiagnosticBundle, type WriteOperationDiagnostic } from '../shared/protocols/write-diagnostics.ts';

export const WRITE_DIAGNOSTIC_TTL = 7 * 24 * 60 * 60 * 1000;
export const WRITE_DIAGNOSTIC_BYTES = 1024 * 1024;
const LIMIT = 32;
type Health = { stored: number; storage_failed: number; queue_refused: number; expired: number; truncated: number; upload_failed: number; upload_unavailable: number };
type Pending = { bundle: WriteDiagnosticBundle; valid: () => boolean };
/** Injected uploader must use an approved private destination, authenticate
 * retrieval, honor abort, and enforce this same expiry server-side. No default
 * analytics transport is permitted to receive this attachment. */
export function createWriteDiagnosticStore(options: {
  directory: string; now?: () => number;
  upload?: (bundle: WriteDiagnosticBundle, signal: AbortSignal) => Promise<void>;
  report?: (bundle: WriteDiagnosticBundle, status: 'stored' | 'failed' | 'unavailable' | 'uploaded' | 'refused') => void;
}) {
  const now = options.now ?? Date.now;
  const health: Health = { stored: 0, storage_failed: 0, queue_refused: 0, expired: 0, truncated: 0, upload_failed: 0, upload_unavailable: 0 };
  const turns = new Map<string, { at: number; valid: () => boolean; operations: WriteOperationDiagnostic[]; bundles: Set<string>; targets: Map<string, string> }>();
  const samples = new Map<string, WriteDiagnosticBundle>();
  const fingerprints = new Map<string, string>();
  const admissions = new Map<string, () => boolean>();
  const pending = new Map<string, Pending>();
  const staging = new Set<string>();
  let draining: Promise<void> | undefined;
  let clearing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let transport: AbortController | undefined;
  const report = (bundle: WriteDiagnosticBundle, status: Parameters<NonNullable<typeof options.report>>[1]) => {
    try { options.report?.(bundle, status); } catch { health.storage_failed++; }
  };
  const names = async () => {
    try {
      const directory = await fs.lstat(options.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe_diagnostic_directory');
      return (await fs.readdir(options.directory)).filter(name => /^[\da-f-]{36}\.(json|tmp)$/.test(name));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  async function prune(reserve = false): Promise<void> {
    const files = await names();
    const kept: { name: string; at: number }[] = [];
    for (const name of files) {
      const file = path.join(options.directory, name);
      if (name.endsWith('.tmp')) { if (!staging.has(file)) { await fs.rm(file, { force: true }); health.expired++; } continue; }
      const stat = await fs.lstat(file);
      let expired = now() - stat.mtimeMs > WRITE_DIAGNOSTIC_TTL;
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= WRITE_DIAGNOSTIC_BYTES) {
        try { const expires = Date.parse(JSON.parse(await fs.readFile(file, 'utf8')).expires_at); expired ||= !Number.isFinite(expires) || expires <= now(); }
        catch { expired = true; }
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > WRITE_DIAGNOSTIC_BYTES || expired) {
        await fs.unlink(file); health.expired++; continue;
      }
      kept.push({ name, at: stat.mtimeMs });
    }
    kept.sort((a, b) => a.at - b.at);
    for (const item of kept.slice(0, Math.max(0, kept.length - LIMIT + (reserve ? 1 : 0)))) { await fs.unlink(path.join(options.directory, item.name)); health.expired++; }
  }
  function bound(bundle: WriteDiagnosticBundle): string {
    while (bundle.operations.length > 1 && Buffer.byteLength(JSON.stringify(bundle)) > WRITE_DIAGNOSTIC_BYTES) {
      // Keep the actual failed sample; removing follow-ups is explicit.
      bundle.operations.pop(); bundle.completeness = 'partial';
      if (!bundle.gaps.includes('timeline_size_limit')) bundle.gaps.push('timeline_size_limit');
      health.truncated++;
    }
    if (Buffer.byteLength(JSON.stringify(bundle)) > WRITE_DIAGNOSTIC_BYTES) {
      const operation = bundle.operations[0];
      operation.steps = []; operation.completeness = 'partial'; operation.gaps.push('attachment_size_limit');
      bundle.completeness = 'partial'; bundle.gaps.push('attachment_size_limit'); health.truncated++;
    }
    const encoded = JSON.stringify(writeDiagnosticBundleSchema.parse(bundle));
    if (Buffer.byteLength(encoded) > WRITE_DIAGNOSTIC_BYTES) throw new Error('attachment_size_limit');
    return encoded;
  }
  async function persist(bundle: WriteDiagnosticBundle, valid: () => boolean, expected: number): Promise<void> {
    if (!valid() || expected !== generation) return;
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(options.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe_diagnostic_directory');
    await fs.chmod(options.directory, 0o700);
    const file = path.join(options.directory, `${bundle.diagnostic_id}.json`);
    const temporary = path.join(options.directory, `${randomUUID()}.tmp`);
    staging.add(temporary);
    try {
      await fs.writeFile(temporary, bound(bundle), { flag: 'wx', mode: 0o600 });
      if (!valid() || expected !== generation) return;
      await fs.rename(temporary, file);
      if (!valid() || expected !== generation) await fs.rm(file, { force: true });
    } finally { staging.delete(temporary); await fs.rm(temporary, { force: true }); }
  }
  async function drain(): Promise<void> {
    while (pending.size && !clearing) {
      const [id, item] = pending.entries().next().value!;
      pending.delete(id);
      const expected = generation;
      if (!item.valid()) continue;
      const bundle = structuredClone(item.bundle);
      try {
        bound(item.bundle);
        await prune(true);
        if (!item.valid() || generation !== expected) continue;
        bundle.delivery = { status: options.upload ? 'pending' : 'unavailable', attempts: 0 };
        await persist(bundle, item.valid, expected);
        if (!item.valid() || generation !== expected) continue;
        health.stored++;
        if (!options.upload) {
          health.upload_unavailable++; report(bundle, 'unavailable'); continue;
        }
        transport = new AbortController();
        const controller = transport;
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (!item.valid() || generation !== expected) break;
          bundle.delivery.attempts = attempt;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([options.upload(bundle, controller.signal), new Promise<never>((_, reject) => {
              timeout = setTimeout(() => { controller.abort(); reject(new Error('upload_timeout')); }, 5000); timeout.unref();
            })]);
            bundle.delivery.status = 'uploaded'; break;
          } catch {
            bundle.delivery.status = 'failed'; bundle.delivery.last_error = controller.signal.aborted ? 'upload_timeout_or_cancelled' : 'upload_failed';
            health.upload_failed++;
            if (controller.signal.aborted) break;
          } finally { clearTimeout(timeout); }
        }
        transport = undefined;
        await persist(bundle, item.valid, expected);
        if (item.valid() && generation === expected) report(bundle, bundle.delivery.status === 'uploaded' ? 'uploaded' : 'failed');
      } catch { health.storage_failed++; if (item.valid() && generation === expected) report(bundle, 'failed'); }
    }
  }
  function startDrain(): Promise<void> {
    const current = drain().finally(() => {
      if (draining === current) draining = undefined;
      if (pending.size) schedule();
    });
    draining = current;
    return current;
  }
  function schedule(): void {
    if (timer || draining || clearing) return;
    timer = setTimeout(() => { timer = undefined; if (!clearing && !draining) void startDrain(); }, 0);
    timer.unref();
  }
  function enqueue(bundle: WriteDiagnosticBundle, valid: () => boolean): void {
    if (!pending.has(bundle.diagnostic_id) && pending.size >= LIMIT) { health.queue_refused++; report(bundle, 'refused'); return; }
    pending.set(bundle.diagnostic_id, { bundle, valid }); schedule();
  }
  return {
    health: () => ({ ...health, pending: pending.size, remote_available: !!options.upload }),
    async maintain(): Promise<void> {
      try { await prune(); } catch { health.storage_failed++; }
      for (const [id, bundle] of samples) if (Date.parse(bundle.expires_at) <= now()) { samples.delete(id); admissions.delete(id); }
      for (const [key, id] of fingerprints) if (!samples.has(id)) fingerprints.delete(key);
      for (const turn of turns.values()) for (const id of turn.bundles) if (!samples.has(id)) turn.bundles.delete(id);
    },
    record(operation: WriteOperationDiagnostic, valid: () => boolean): void {
      if (!valid()) return;
      for (const [id, turn] of turns) if (now() - turn.at > 30 * 60_000) turns.delete(id);
      const key = operation.turn_id;
      let turn = key ? turns.get(key) : undefined;
      if (turn && !turn.valid()) { turns.delete(key!); turn = undefined; }
      if (key && !turn) {
        if (turns.size >= 128) turns.delete(turns.keys().next().value!);
        turn = { at: now(), valid, operations: [], bundles: new Set(), targets: new Map() }; turns.set(key, turn);
      }
      if (turn) {
        const previous = turn.operations.at(-1);
        const identity = operation.target_identity ?? operation.raw_path;
        if (identity !== null) {
          operation.target_id = turn.targets.get(identity) ?? operation.target_id;
          if (turn.targets.size < LIMIT) turn.targets.set(identity, operation.target_id);
          else if (!turn.targets.has(identity) && previous && (previous.target_identity ?? previous.raw_path) === identity) operation.target_id = previous.target_id;
        }
        operation.target_relation = previous ? identity === null ? 'unavailable' : previous.target_id === operation.target_id ? 'same_target' : 'changed_target' : 'first';
        if (previous) { operation.previous_operation_id = previous.operation_id; operation.path_changed = previous.raw_path !== operation.raw_path; }
        turn.operations = [operation]; turn.at = now();
      }
      if (operation.outcome === 'failed') {
        const temporary = new Set(operation.steps.map(step => step.evidence.temporary_path).filter((item): item is string => typeof item === 'string'));
        const fingerprint = createHash('sha256').update(JSON.stringify([operation.turn_id, operation.raw_path, operation.session_root, operation.operation, operation.error,
          operation.steps.map(({ stage, action, result, evidence, error }) => ({ stage, action, result, evidence, error }))],
        (key, value) => key === 'wait_duration_ms' || key === 'duration_ms' ? undefined : typeof value === 'string' && temporary.has(value) ? '<staging-file>' : value)).digest('hex');
        const previousId = fingerprints.get(fingerprint) ?? '';
        const previous = admissions.get(previousId)?.() ? samples.get(previousId) : undefined;
        if (previous) { operation.diagnostic_id = previous.diagnostic_id; previous.occurrences++; previous.last_seen = operation.finished_at; }
        else {
          const bundle: WriteDiagnosticBundle = { schema_version: 1, diagnostic_id: operation.diagnostic_id, first_seen: operation.started_at, last_seen: operation.finished_at,
            expires_at: new Date(now() + WRITE_DIAGNOSTIC_TTL).toISOString(), occurrences: 1, operations: [operation], completeness: operation.completeness, gaps: [...operation.gaps], delivery: { status: 'pending', attempts: 0 } };
          if (samples.size >= LIMIT) { const oldest = samples.keys().next().value!; samples.delete(oldest); admissions.delete(oldest); for (const [hash, id] of fingerprints) if (id === oldest) fingerprints.delete(hash); for (const item of turns.values()) item.bundles.delete(oldest); }
          samples.set(bundle.diagnostic_id, bundle); fingerprints.set(fingerprint, bundle.diagnostic_id);
        }
        turn?.bundles.add(operation.diagnostic_id);
        if (!admissions.has(operation.diagnostic_id)) admissions.set(operation.diagnostic_id, valid);
        enqueue(samples.get(operation.diagnostic_id)!, admissions.get(operation.diagnostic_id)!);
      }
      // Only failed-operation timelines persist successes. A success at another
      // target is never interpreted as recovery of a failed target.
      for (const id of turn?.bundles ?? []) {
        const bundle = samples.get(id);
        const originalAdmission = admissions.get(id);
        if (!bundle || !originalAdmission?.()) continue;
        if (!bundle.operations.some(item => item.operation_id === operation.operation_id)) {
          if (bundle.operations.length < LIMIT) bundle.operations.push(operation);
          else { bundle.completeness = 'partial'; if (!bundle.gaps.includes('timeline_limit')) bundle.gaps.push('timeline_limit'); }
        }
        enqueue(bundle, originalAdmission);
      }
    },
    linkTool(ids: { diagnostic_id: string; operation_id: string }, toolCallId: string, expected: { turn_id?: string; runtime?: string }): boolean {
      if (!toolCallId || toolCallId.length > 512) return false;
      const bundle = samples.get(ids.diagnostic_id);
      const valid = admissions.get(ids.diagnostic_id);
      if (!bundle || !valid?.()) return false;
      const operation = bundle.operations.find(item => item.operation_id === ids.operation_id);
      if (!operation || !operation.turn_id || operation.turn_id !== expected.turn_id
        || (operation.runtime && operation.runtime !== expected.runtime)
        || (operation.tool_call_id && operation.tool_call_id !== toolCallId)) return false;
      operation.tool_call_id = toolCallId; operation.correlation.tool = 'linked';
      enqueue(bundle, valid);
      return true;
    },
    async read(id: string): Promise<WriteDiagnosticBundle | null> {
      if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return null;
      const file = path.join(options.directory, `${id}.json`);
      try {
        const directory = await fs.lstat(options.directory);
        if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
        if ((await fs.lstat(file)).isSymbolicLink()) return null;
        const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > WRITE_DIAGNOSTIC_BYTES) return null;
          const bundle = writeDiagnosticBundleSchema.parse(JSON.parse(await handle.readFile('utf8')));
          if (bundle.diagnostic_id !== id) return null;
          if (Date.parse(bundle.expires_at) <= now()) { await fs.rm(file, { force: true }); health.expired++; return null; }
          return bundle;
        } finally { await handle.close(); }
      } catch { return null; }
    },
    async flush(): Promise<void> {
      for (;;) {
        if (clearing) { await clearing; continue; }
        clearTimeout(timer); timer = undefined;
        if (draining) { await draining; continue; }
        if (!pending.size) return;
        await startDrain();
      }
    },
    clear(): Promise<void> {
      generation++; transport?.abort(); pending.clear(); turns.clear(); samples.clear(); fingerprints.clear(); admissions.clear(); clearTimeout(timer); timer = undefined;
      const previousClear = clearing;
      const previousDrain = draining;
      // New admissions may queue while cleanup waits for an old upload. Keep
      // their disk writes behind every overlapping clear, so an older cleanup
      // can never remove a freshly admitted attachment.
      const current = (async () => {
        await previousClear;
        await previousDrain;
        try { for (const name of await names()) await fs.rm(path.join(options.directory, name), { force: true }); }
        catch { health.storage_failed++; }
      })().finally(() => {
        if (clearing === current) {
          clearing = undefined;
          if (pending.size) schedule();
        }
      });
      clearing = current;
      return current;
    },
  };
}

export const writeDiagnostics = createWriteDiagnosticStore({
  directory: path.join(appDataRoot(), 'write-diagnostics'),
  report: (bundle, status) => telemetry.capture({ event: 'write_diagnostic_delivery', diagnostic_id: bundle.diagnostic_id,
    status, completeness: bundle.completeness, occurrences: bundle.occurrences }),
});
onWriteDiagnosticsReset(() => { void writeDiagnostics.clear(); });
// Idle running applications expire attachments too; a stopped application is
// swept on its next start. Neither timer waits in the write operation.
const maintain = () => { void (telemetry.diagnosticAdmission() ? writeDiagnostics.maintain() : writeDiagnostics.clear()); };
const maintenance = setInterval(maintain, 5 * 60_000);
maintenance.unref();
const startupMaintenance = setTimeout(maintain, 0);
startupMaintenance.unref();

export function diagnoseFileWrite<T>(input: WriteDiagnosticInput, work: () => Promise<T>, complete?: (operation: WriteOperationDiagnostic) => void): Promise<T> {
  const valid = telemetry.diagnosticAdmission();
  if (!valid) return work();
  const scope = diagnosticScope.getStore();
  return traceWriteOperation({ ...input, request_id: input.request_id ?? scope?.request_id,
    turn_id: input.turn_id ?? scope?.turn_id, tool_call_id: input.tool_call_id ?? scope?.context?.tool_call_id,
    runtime_version: input.runtime_version ?? scope?.context?.runtime_version }, work, (operation) => {
    writeDiagnostics.record(operation, valid); complete?.(operation);
  });
}

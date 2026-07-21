/**
 * In-memory scheduler for derived-content conversion work.
 *
 * This module owns *when* work runs: lane capacity, priority, ageing,
 * deduplication, cancellation, queue positions, and renderer refresh
 * revisions. Conversion correctness (derived markers, source signatures,
 * durable failures, indexing, cleanup) stays in `conversion.ts`.
 */
import {
  createFilesystemPath,
  type FilesystemPathModule,
  type FilesystemPlatform,
} from './filesystem-path.ts';

export type ConversionLane = 'light' | 'heavy';
export type ConversionUrgency = 'interactive' | 'active-folder' | 'background';
export type ScheduledConversionState = 'queued' | 'running' | 'yielded';
export type ConversionCancellationReason =
  | 'source-change'
  | 'folder-removed'
  | 'shutdown'
  | 'request-aborted'
  | 'interactive-preview'
  | 'user-request'
  | 'file-operation'
  | 'model-removed'
  | 'conversion-started';

export interface ConversionRunContext {
  signal: AbortSignal;
  /**
   * Cooperatively release this task's lane between durable work units.
   * The same task identity and completion promise are retained while another
   * queued task may run. Resolves after this task reacquires the lane, or
   * rejects when cancellation retires it while yielded.
   */
  yieldLane: () => Promise<void>;
}

export interface ConversionJob {
  /** Canonical absolute task identity. Normally the source path; auxiliary
   *  work may use its derived output path so it can share the same lanes
   *  without colliding with the source's text conversion. */
  key: string;
  /** Source path used for subtree cancellation and active-folder priority. */
  scope?: string;
  /** Hidden tasks consume capacity and affect queue positions but do not
   *  appear as user-visible source conversions in scheduler snapshots. */
  visible?: boolean;
  lane: ConversionLane;
  urgency: ConversionUrgency;
  /** Lower values run first after urgency. */
  cost: number;
  /** Optional bounded preflight that refines cost while the task is queued. */
  classifyCost?: (signal: AbortSignal) => Promise<number>;
  run: (context: ConversionRunContext) => Promise<void>;
  /** Runs synchronously after this task identity is retired. */
  onSettled?: () => void;
}

export interface ScheduledConversion {
  key: string;
  lane: ConversionLane;
  state: ScheduledConversionState;
  urgency: ConversionUrgency;
  cost: number;
  queuedAt: number;
  startedAt?: number;
  /** Same-lane running/queued tasks selected before this queued task. */
  tasksAhead?: number;
}

export interface ConversionSchedulerSnapshot {
  revision: number;
  tasks: ScheduledConversion[];
  /** Per-source refresh token, retained for this process lifetime. */
  versions: Record<string, number>;
}

export interface ScheduleResult {
  created: boolean;
  completion: Promise<void>;
}

interface SchedulerOptions {
  laneCapacity?: Partial<Record<ConversionLane, number>>;
  /** Capacity for auxiliary cost classifiers. They never consume lane slots. */
  classifierCapacity?: number;
  ageingMs?: number;
  now?: () => number;
  isActive?: (key: string) => boolean;
  /** Overrides production platform semantics for deterministic tests. */
  pathPlatform?: FilesystemPlatform;
}

interface Task extends ConversionJob {
  seq: number;
  state: ScheduledConversionState;
  queuedAt: number;
  startedAt?: number;
  aged: boolean;
  classifierState: 'queued' | 'running' | 'done';
  controller: AbortController;
  runStarted: boolean;
  ownsLane: boolean;
  cancelling: boolean;
  resumeYield?: () => void;
  completion: Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (error: unknown) => void;
}

interface ClassifierRun {
  key: string;
  scope: string;
  controller: AbortController;
  completion: Promise<void>;
}

const DEFAULT_LANE_CAPACITY: Record<ConversionLane, number> = {
  light: 2,
  heavy: 1,
};
const DEFAULT_AGEING_MS = 60_000;
const DEFAULT_CLASSIFIER_CAPACITY = 4;

const URGENCY_RANK: Record<ConversionUrgency, number> = {
  interactive: 0,
  'active-folder': 1,
  background: 2,
};

export class ConversionScheduler {
  private readonly capacity: Record<ConversionLane, number>;
  private readonly classifierCapacity: number;
  private readonly ageingMs: number;
  private readonly now: () => number;
  private readonly isActive: (key: string) => boolean;
  private readonly paths: FilesystemPathModule;
  private readonly tasks = new Map<string, Task>();
  private readonly versions = new Map<string, number>();
  private readonly classifierRuns = new Set<ClassifierRun>();
  private readonly running: Record<ConversionLane, number> = { light: 0, heavy: 0 };
  private classifiersRunning = 0;
  private seq = 0;
  private revision = 0;
  private drainScheduled = false;
  private classifierDrainScheduled = false;
  private ageingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SchedulerOptions = {}) {
    this.capacity = {
      light: positiveInteger(options.laneCapacity?.light, DEFAULT_LANE_CAPACITY.light),
      heavy: positiveInteger(options.laneCapacity?.heavy, DEFAULT_LANE_CAPACITY.heavy),
    };
    this.classifierCapacity = positiveInteger(
      options.classifierCapacity,
      DEFAULT_CLASSIFIER_CAPACITY,
    );
    this.ageingMs = Math.max(0, options.ageingMs ?? DEFAULT_AGEING_MS);
    this.now = options.now ?? Date.now;
    this.isActive = options.isActive ?? (() => false);
    this.paths = createFilesystemPath({ platform: options.pathPlatform });
  }

  schedule(job: ConversionJob): ScheduleResult {
    const identity = this.identity(job.key);
    const current = this.tasks.get(identity);
    if (current) {
      if (current.lane !== job.lane) {
        throw new Error(`conversion task ${job.key} changed lane from ${current.lane} to ${job.lane}`);
      }
      if (current.state === 'running') {
        return { created: false, completion: current.completion };
      }
      let changed = false;
      if (URGENCY_RANK[job.urgency] < URGENCY_RANK[current.urgency]) {
        current.urgency = job.urgency;
        changed = true;
      }
      if (job.cost < current.cost) {
        current.cost = job.cost;
        changed = true;
      }
      if (changed) this.noteLaneChange(current.lane);
      return { created: false, completion: current.completion };
    }

    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // Most conversion callers intentionally fire-and-forget. Attach a handler
    // here so a cancelled/rejected generic job never becomes an unhandled
    // rejection; callers that await the original promise still see the error.
    void completion.catch(() => undefined);

    const task: Task = {
      ...job,
      seq: ++this.seq,
      state: 'queued',
      queuedAt: this.now(),
      aged: false,
      classifierState: job.classifyCost ? 'queued' : 'done',
      controller: new AbortController(),
      runStarted: false,
      ownsLane: false,
      cancelling: false,
      completion,
      resolveCompletion,
      rejectCompletion,
    };
    this.tasks.set(identity, task);
    this.noteLaneChange(task.lane);
    this.scheduleClassifierDrain();
    this.scheduleDrain();
    this.scheduleAgeingCheck();
    return { created: true, completion };
  }

  promote(key: string, urgency: ConversionUrgency): boolean {
    const task = this.tasks.get(this.identity(key));
    if (!task || task.state === 'running') return false;
    if (URGENCY_RANK[urgency] >= URGENCY_RANK[task.urgency]) return false;
    task.urgency = urgency;
    this.noteLaneChange(task.lane);
    this.scheduleDrain();
    this.scheduleAgeingCheck();
    return true;
  }

  has(key: string): boolean {
    return this.tasks.has(this.identity(key));
  }

  hasUnder(prefix: string): boolean {
    for (const task of this.tasks.values()) {
      if (this.paths.contains(prefix, this.scopeOf(task))) return true;
    }
    return false;
  }

  hasRunningUnder(prefix: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.ownsLane && this.paths.contains(prefix, this.scopeOf(task))) return true;
    }
    return false;
  }

  cancel(key: string, reason?: ConversionCancellationReason): Promise<void> | null {
    const identity = this.identity(key);
    const task = this.tasks.get(identity);
    const classifierCompletions = this.abortClassifierRuns(key, reason);
    if (!task && classifierCompletions.length === 0) return null;
    if (task) {
      if (!task.runStarted) {
        this.tasks.delete(identity);
        task.controller.abort(reason);
        task.resolveCompletion();
        this.noteLaneChange(task.lane, [task.key]);
        this.scheduleDrain();
      } else {
        task.cancelling = true;
        task.controller.abort(reason);
        // A yielded task has no active child work to deliver the abort. Wake
        // its suspended run so yieldLane() can reject and normal retirement
        // can settle the shared completion promise.
        task.resumeYield?.();
        this.bump([task.key]);
      }
    }
    this.scheduleClassifierDrain();
    this.scheduleAgeingCheck();
    return settleAll([
      ...(task ? [task.completion] : []),
      ...classifierCompletions,
    ]);
  }

  cancelUnder(prefix: string, reason?: ConversionCancellationReason): Array<{ key: string; completion: Promise<void> }> {
    const keys = new Set<string>();
    for (const task of this.tasks.values()) {
      if (this.paths.contains(prefix, this.scopeOf(task))) keys.add(task.key);
    }
    for (const run of this.classifierRuns) {
      if (this.paths.contains(prefix, run.scope)) keys.add(run.key);
    }
    return [...keys].map((key) => ({
      key,
      completion: this.cancel(key, reason) ?? Promise.resolve(),
    }));
  }

  cancelScope(scope: string, reason?: ConversionCancellationReason): Array<{ key: string; completion: Promise<void> }> {
    const keys = new Set<string>();
    for (const task of this.tasks.values()) {
      if (this.paths.equal(scope, this.scopeOf(task))) keys.add(task.key);
    }
    for (const run of this.classifierRuns) {
      if (this.paths.equal(scope, run.scope)) keys.add(run.key);
    }
    return [...keys].map((key) => ({
      key,
      completion: this.cancel(key, reason) ?? Promise.resolve(),
    }));
  }

  cancelAll(reason?: ConversionCancellationReason): Array<{ key: string; completion: Promise<void> }> {
    const keys = new Set([
      ...[...this.tasks.values()].map((task) => task.key),
      ...[...this.classifierRuns].map((run) => run.key),
    ]);
    return [...keys].map((key) => ({
      key,
      completion: this.cancel(key, reason) ?? Promise.resolve(),
    }));
  }

  /** Notify the scheduler that its injected active-folder classifier changed. */
  prioritiesChanged(): void {
    const queued = [...this.tasks.values()].filter((task) => task.state !== 'running');
    if (queued.length === 0) return;
    this.bump(queued.map((task) => task.key));
    this.scheduleDrain();
  }

  snapshot(): ConversionSchedulerSnapshot {
    this.applyDueAgeing();
    this.scheduleAgeingCheck();
    const tasks: ScheduledConversion[] = [];
    for (const lane of ['light', 'heavy'] as const) {
      const running = [...this.tasks.values()]
        .filter((task) => task.lane === lane && task.state === 'running')
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.seq - b.seq);
      const queued = this.sortedQueued(lane);
      tasks.push(...running
        .filter((task) => task.visible !== false)
        .map((task) => this.publicTask(task)));
      tasks.push(...queued
        .map((task, index) => ({ task, index }))
        .filter(({ task }) => task.visible !== false)
        .map(({ task, index }) => ({
          ...this.publicTask(task),
          tasksAhead: running.length + index,
        })));
    }
    return {
      revision: this.revision,
      tasks,
      versions: Object.fromEntries(this.versions),
    };
  }

  private publicTask(task: Task): ScheduledConversion {
    return {
      key: task.key,
      lane: task.lane,
      state: task.state,
      urgency: this.effectiveUrgency(task),
      cost: task.cost,
      queuedAt: task.queuedAt,
      ...(task.startedAt == null ? {} : { startedAt: task.startedAt }),
    };
  }

  get(key: string): ScheduledConversion | null {
    const task = this.tasks.get(this.identity(key));
    if (!task) return null;
    const scheduled = this.publicTask(task);
    if (task.state === 'running') return scheduled;
    const runningAhead = [...this.tasks.values()]
      .filter((candidate) => candidate.lane === task.lane && candidate.state === 'running')
      .length;
    const queuedIndex = this.sortedQueued(task.lane).indexOf(task);
    return {
      ...scheduled,
      tasksAhead: runningAhead + Math.max(0, queuedIndex),
    };
  }

  private effectiveUrgency(task: Task): ConversionUrgency {
    if (task.urgency === 'interactive') return 'interactive';
    if (task.urgency === 'active-folder') return 'active-folder';
    if (this.isActive(this.scopeOf(task))) return 'active-folder';
    if (task.aged) return 'active-folder';
    return 'background';
  }

  private compare = (a: Task, b: Task): number => {
    return URGENCY_RANK[this.effectiveUrgency(a)] - URGENCY_RANK[this.effectiveUrgency(b)]
      || a.cost - b.cost
      || a.seq - b.seq;
  };

  private sortedQueued(lane: ConversionLane): Task[] {
    return [...this.tasks.values()]
      .filter((task) => task.lane === lane && task.state !== 'running' && !task.cancelling)
      .sort(this.compare);
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.applyDueAgeing();
      this.drainLane('light');
      this.drainLane('heavy');
      this.scheduleAgeingCheck();
    });
  }

  private drainLane(lane: ConversionLane): void {
    while (this.running[lane] < this.capacity[lane]) {
      const task = this.sortedQueued(lane)[0];
      if (!task) return;
      const resuming = task.state === 'yielded';
      task.state = 'running';
      task.ownsLane = true;
      task.startedAt ??= this.now();
      this.running[lane] += 1;
      this.noteLaneChange(lane);
      this.scheduleClassifierDrain();
      this.scheduleAgeingCheck();
      if (resuming) {
        const resume = task.resumeYield;
        task.resumeYield = undefined;
        resume?.();
        continue;
      }
      task.runStarted = true;
      this.abortClassifierRuns(task.key, 'conversion-started');
      void Promise.resolve()
        .then(() => task.run({
          signal: task.controller.signal,
          yieldLane: () => this.yieldLane(task),
        }))
        .then(
          () => this.finish(task),
          (error) => this.finish(task, error),
        );
    }
  }

  private finish(task: Task, error?: unknown): void {
    const identity = this.identity(task.key);
    if (this.tasks.get(identity) !== task) return;
    this.tasks.delete(identity);
    if (task.ownsLane) {
      this.running[task.lane] = Math.max(0, this.running[task.lane] - 1);
      task.ownsLane = false;
    }
    task.resumeYield = undefined;
    this.noteLaneChange(task.lane, [task.key]);
    if (error == null) task.resolveCompletion();
    else task.rejectCompletion(error);
    try { task.onSettled?.(); } catch { /* task retirement must keep draining */ }
    this.scheduleClassifierDrain();
    this.scheduleDrain();
    this.scheduleAgeingCheck();
  }

  private async yieldLane(task: Task): Promise<void> {
    if (task.controller.signal.aborted) throw cancelledYieldError(task);
    if (task.state !== 'running' || !task.ownsLane) {
      throw new Error(`conversion task ${task.key} can only yield while it owns the ${task.lane} lane`);
    }

    let resume!: () => void;
    const reacquired = new Promise<void>((resolve) => { resume = resolve; });
    task.resumeYield = resume;
    task.state = 'yielded';
    task.ownsLane = false;
    this.running[task.lane] = Math.max(0, this.running[task.lane] - 1);
    this.noteLaneChange(task.lane);
    this.scheduleDrain();
    this.scheduleAgeingCheck();

    await reacquired;
    if (task.controller.signal.aborted) throw cancelledYieldError(task);
  }

  private scheduleClassifierDrain(): void {
    if (this.classifierDrainScheduled) return;
    this.classifierDrainScheduled = true;
    queueMicrotask(() => {
      this.classifierDrainScheduled = false;
      while (this.classifiersRunning < this.classifierCapacity) {
        const task = [...this.tasks.values()]
          .filter((candidate) => candidate.state === 'queued' && candidate.classifierState === 'queued')
          .sort((a, b) => a.seq - b.seq)[0];
        if (!task) return;
        this.startClassifier(task);
      }
    });
  }

  private startClassifier(task: Task): void {
    const classifyCost = task.classifyCost;
    if (!classifyCost || task.state !== 'queued' || task.classifierState !== 'queued') return;
    task.classifierState = 'running';
    this.classifiersRunning += 1;
    const controller = new AbortController();
    let run!: ClassifierRun;
    const completion = Promise.resolve()
      .then(() => classifyCost(controller.signal))
      .then((cost) => {
        if (controller.signal.aborted || !Number.isFinite(cost)) return;
        if (this.tasks.get(this.identity(task.key)) !== task || task.state !== 'queued') return;
        if (task.cost === cost) return;
        task.cost = cost;
        this.noteLaneChange(task.lane);
        this.scheduleDrain();
      })
      .catch(() => undefined)
      .finally(() => {
        this.classifierRuns.delete(run);
        this.classifiersRunning = Math.max(0, this.classifiersRunning - 1);
        if (task.classifierState === 'running') task.classifierState = 'done';
        this.scheduleClassifierDrain();
      });
    run = { key: task.key, scope: this.scopeOf(task), controller, completion };
    this.classifierRuns.add(run);
  }

  private abortClassifierRuns(key: string, reason?: ConversionCancellationReason): Promise<void>[] {
    const completions: Promise<void>[] = [];
    const identity = this.identity(key);
    for (const run of this.classifierRuns) {
      if (this.identity(run.key) !== identity) continue;
      run.controller.abort(reason);
      completions.push(run.completion);
    }
    const task = this.tasks.get(identity);
    if (task?.classifierState === 'queued') task.classifierState = 'done';
    return completions;
  }

  private applyDueAgeing(): boolean {
    const now = this.now();
    const lanes = new Set<ConversionLane>();
    for (const task of this.tasks.values()) {
      if (task.state === 'running' || task.urgency !== 'background' || task.aged) continue;
      if (now - task.queuedAt < this.ageingMs) continue;
      task.aged = true;
      lanes.add(task.lane);
    }
    for (const lane of lanes) this.noteLaneChange(lane);
    return lanes.size > 0;
  }

  private scheduleAgeingCheck(): void {
    if (this.ageingTimer) {
      clearTimeout(this.ageingTimer);
      this.ageingTimer = null;
    }
    let nextAt = Number.POSITIVE_INFINITY;
    for (const task of this.tasks.values()) {
      if (task.state === 'running' || task.urgency !== 'background' || task.aged) continue;
      nextAt = Math.min(nextAt, task.queuedAt + this.ageingMs);
    }
    if (!Number.isFinite(nextAt)) return;
    this.ageingTimer = setTimeout(() => {
      this.ageingTimer = null;
      if (this.applyDueAgeing()) this.scheduleDrain();
      this.scheduleAgeingCheck();
    }, Math.max(0, nextAt - this.now()));
    this.ageingTimer.unref?.();
  }

  private noteLaneChange(lane: ConversionLane, extraKeys: string[] = []): void {
    const affected = [...this.tasks.values()]
      .filter((task) => task.lane === lane && task.visible !== false)
      .map((task) => task.key);
    this.bump([...affected, ...extraKeys]);
  }

  private bump(keys: string[]): void {
    this.revision += 1;
    for (const key of new Set(keys)) {
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    }
  }

  private identity(key: string): string {
    return this.paths.identity(key);
  }

  private scopeOf(task: Pick<ConversionJob, 'key' | 'scope'>): string {
    return task.scope ?? task.key;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function settleAll(completions: Promise<void>[]): Promise<void> {
  return Promise.allSettled(completions).then(() => undefined);
}

function cancelledYieldError(task: Task): Error {
  const reason = task.controller.signal.reason;
  return new Error(`conversion task ${task.key} cancelled while yielded${reason ? `: ${String(reason)}` : ''}`);
}

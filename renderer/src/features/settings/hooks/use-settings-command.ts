/**
 * One Settings write, and the poll a Settings read runs while the server is
 * still working.
 *
 * Every panel hook used to restate the same four things per command: an abort
 * lane of its own, a mutation over it, the thrown value read into a sentence,
 * and a busy flag assembled by hand. They are here once instead, so a panel
 * hook is left with the part that is actually about its panel — what the
 * command calls, and what its answer does to the cache.
 */
import { useMutation } from '@tanstack/react-query';

import { settingsFailure } from '@/features/settings/application/failure-messages';
import type { FailureView } from '@/shared/domain/feature-error';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';

/** What a panel sees of one command. It never holds a mutation object. */
export interface SettingsCommand<Input, Output> {
  /** The command is open. */
  readonly busy: boolean;
  /** What the last attempt refused with, already read as sentence and tone. */
  readonly failure: FailureView | null;
  /** What the last successful attempt answered. */
  readonly result: Output | undefined;
  /** Aborts the current attempt and clears its transient result/error. */
  cancel(): void;
  /** Starts the command, aborting one of its own already in flight. */
  run(input: Input, onDone?: (result: Output) => void): void;
}

export interface SettingsCommandOptions<Input, Output> {
  readFailure?: ((error: unknown) => FailureView) | undefined;
  /** Runs before the call, so a panel can hold an optimistic value. The call
   *  waits for it, which is what lets a panel cancel a read in flight first. */
  onStart?: ((input: Input) => Promise<void> | void) | undefined;
  /** Runs when the call refused, so a panel can put back what it held. */
  onFailed?: ((input: Input, error: unknown) => void) | undefined;
  /** Runs on success, before the caller's own `onDone`. */
  onDone?:
    | ((result: Output, input: Input, signal: AbortSignal) => Promise<void> | void)
    | undefined;
  /** Runs however the call ended. */
  onSettled?: (() => Promise<void> | void) | undefined;
}

/**
 * Runs one Settings command in a lane of its own: asking for it again aborts
 * the call already running under the same name, and leaving the panel aborts
 * whatever is still open. Lanes are independent, so two panels' writes — or
 * two rows' — never cancel each other.
 */
export function useSettingsCommand<Input = void, Output = void>(
  lane: string,
  call: (input: Input, signal: AbortSignal) => Promise<Output>,
  options: SettingsCommandOptions<Input, Output> = {},
): SettingsCommand<Input, Output> {
  const signalFor = useRequestSignals();
  const { onDone, onFailed, onSettled, onStart, readFailure = settingsFailure } = options;
  type Attempt = { input: Input; signal: AbortSignal };
  const mutation = useMutation({
    mutationFn: async ({ input, signal }: Attempt) => {
      signal.throwIfAborted();
      const result = await call(input, signal);
      signal.throwIfAborted();
      return result;
    },
    onMutate: async ({ input, signal }: Attempt) => {
      signal.throwIfAborted();
      await onStart?.(input);
    },
    onError: (error, { input, signal }) => {
      if (!signal.aborted) return onFailed?.(input, error);
    },
    onSuccess: (result, { input, signal }) => {
      if (!signal.aborted) return onDone?.(result, input, signal);
    },
    onSettled: (_result, _error, { signal }) => {
      if (!signal.aborted) return onSettled?.();
    },
  });

  return {
    busy: mutation.isPending,
    failure: mutation.isError ? readFailure(mutation.error) : null,
    result: mutation.data,
    cancel: () => {
      signalFor(lane);
      mutation.reset();
    },
    run: (input, done) => {
      const attempt = { input, signal: signalFor(lane) };
      // The caller's completion is handed the answer alone; react-query's own
      // extra arguments are this module's business, not a panel's.
      if (done)
        mutation.mutate(attempt, {
          onSuccess: (result) => {
            if (!attempt.signal.aborted) done(result);
          },
        });
      else mutation.mutate(attempt);
    },
  };
}

/** The first refusal among commands that share one notice. */
export function firstCommandFailure(
  ...commands: readonly { readonly failure: FailureView | null }[]
): FailureView | null {
  return commands.find((command) => command.failure !== null)?.failure ?? null;
}

/** True while any of these commands is open. */
export function anyBusy(...commands: readonly { readonly busy: boolean }[]): boolean {
  return commands.some((command) => command.busy);
}

/** Polls a Settings read while the server still has work in flight, and stops
 *  the moment it does not. Written once so a panel states only its own
 *  interval and its own idea of busy. */
export function pollWhileBusy<Data>(
  busy: (data: Data) => boolean,
  intervalMs: number,
): (query: { state: { data: Data | undefined } }) => number | false {
  return (query) => {
    const data = query.state.data;
    return data !== undefined && busy(data) ? intervalMs : false;
  };
}

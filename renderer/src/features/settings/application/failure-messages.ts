import type { EmbedderFailureKind } from '@/features/settings/application/embedder-port';
import type {
  AgentRuntimeFailureKind,
  SettingsFailureKind,
} from '@/features/settings/application/ports';
import { AgentRuntimeError } from '@/features/settings/application/ports';
/**
 * How a Settings failure reaches the reader.
 *
 * Every panel used to invent its own fallback sentence per call site — "Setup
 * failed.", "Sign-in failed.", "Reset failed." — which meant the same
 * unreachable server read three different ways. The three Settings ladders are
 * consumed here instead: one sentence per kind, and one decision about whether
 * the reader is being told to fix something or told that a capability is gone.
 */
import type { LocalComponentStatus } from '@/features/settings/domain/local-component';
import { readFailure, type FailureView } from '@/shared/domain/feature-error';

/** Every failure kind any Settings capability can report. */
export type SettingsAreaFailureKind =
  | AgentRuntimeFailureKind
  | EmbedderFailureKind
  | SettingsFailureKind;

const MESSAGES: Readonly<Record<SettingsAreaFailureKind, string>> = {
  'invalid-request': 'StashBase could not accept that change.',
  'invalid-response': 'StashBase returned an unexpected response.',
  rejected: 'StashBase could not accept that.',
  'scope-lost': 'That setting is no longer available in this window.',
  unauthorized: 'This window can no longer change that setting.',
  unavailable: 'StashBase is unavailable.',
};

/** The two kinds that are the reader's own request coming back. */
const INPUT_KINDS: readonly SettingsAreaFailureKind[] = ['invalid-request', 'rejected'];

/** The sentence a kind reads as when the thrown error carries none of its own. */
export function failureMessage(kind: SettingsAreaFailureKind): string {
  return MESSAGES[kind];
}

/** Reads one thrown value as the sentence and tone a panel presents. A value
 *  that is not a Settings failure at all is reported as an unreachable
 *  capability rather than guessed at. */
export function settingsFailure(error: unknown): FailureView {
  return readFailure<'invalid-request' | 'rejected'>(error, MESSAGES, {
    inputKinds: INPUT_KINDS,
    serverSentenceFor: error instanceof AgentRuntimeError ? [error.kind] : [],
  });
}

/** The first failure among several commands that share one notice. */
export function firstFailure(
  ...errors: ReadonlyArray<{ readonly isError: boolean; readonly error: unknown }>
): FailureView | null {
  const failed = errors.find((candidate) => candidate.isError);
  return failed ? settingsFailure(failed.error) : null;
}

const COMPONENT_FAILURES = {
  network: 'The download could not finish. Check your connection and retry.',
  verification: 'The download could not be verified. Retry to download a fresh copy.',
  installation: 'The component could not be installed. Check available disk space and retry.',
  manifest: 'Component information is invalid or missing. Update or reinstall StashBase.',
  interrupted: 'The download was interrupted.',
} as const;

export function localComponentDescription(component: LocalComponentStatus): string {
  switch (component.status) {
    case 'not-installed':
      return 'Not downloaded. Downloads automatically when first needed.';
    case 'downloading':
      return 'Downloading and installing… Waiting files will continue automatically.';
    case 'installed':
      return 'Installed. Ready for offline use.';
    case 'failed':
      if (component.error === 'unsupported-system')
        return 'PDF and image text extraction requires macOS 15 or later on Intel Macs. You can still open projects and edit files.';
      return `${COMPONENT_FAILURES[component.error ?? 'interrupted']} Waiting files stay queued. Retry here or restart StashBase to try again.`;
  }
}

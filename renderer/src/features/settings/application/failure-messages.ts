import type { EmbedderFailureKind } from '@/features/settings/application/embedder-port';
import type {
  AgentRuntimeFailureKind,
  SettingsFailureKind,
} from '@/features/settings/application/ports';
import { AgentRuntimeError, AccountAccessError } from '@/features/settings/application/ports';
import type { LocalComponentStatus } from '@/features/settings/domain/local-component';
/**
 * How a Settings failure reaches the reader.
 *
 * Every panel used to invent its own fallback sentence per call site — "Setup
 * failed.", "Sign-in failed.", "Reset failed." — which meant the same
 * unreachable server read three different ways. The three Settings ladders are
 * consumed here instead: one sentence per kind, and one decision about whether
 * the reader is being told to fix something or told that a capability is gone.
 */
import { ReferralRequestError } from '@/features/settings/domain/referrals';
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

const REFERRAL_ERRORS: Readonly<Record<string, string>> = {
  auth_required: 'Sign in again to continue.',
  billing_checkout_closed: 'The payment page closed. Review the plan and open Checkout again.',
  client_upgrade_required: 'Update StashBase to continue.',
  idempotency_conflict: 'This request changed. Refresh and confirm again.',
  referral_account_changed: 'Your signed-in account changed. Open Account again to continue.',
  referral_already_bound: 'An invitation is already attached to this account.',
  referral_benefit_unavailable:
    'This Checkout choice is unavailable. Review your invitation and try again.',
  referral_campaign_capacity_reached: 'This invitation campaign is full right now.',
  referral_campaign_unavailable: 'This invitation campaign is unavailable.',
  referral_checkout_in_progress:
    'Finish or close your earlier payment page before accepting an invitation.',
  referral_code_unavailable: 'This invitation code is unavailable.',
  referral_cursor_invalid: 'This list changed. Refresh it from the first page.',
  referral_decision_required:
    'Accept your invitation or choose Continue without invitation before opening Checkout.',
  referral_not_new_account: 'This account does not meet the new-account requirements.',
  referral_operation_in_progress:
    'An account request is already in progress. Wait a moment and retry.',
  referral_preview_changed: 'The invitation preview changed. Check the code again.',
  referral_price_changed: 'The price changed. Review the current offer before trying again.',
  referral_revision_changed: 'Your invitation status changed. Review it and confirm again.',
  referral_self_invite: 'You can’t accept your own invitation.',
  referral_terms_changed:
    'The invitation terms changed. Check the code and review the updated offer.',
};

function referralErrorMessage(code: string, retryAfterSeconds?: number): string {
  if (code === 'rate_limited') {
    return retryAfterSeconds
      ? `Too many requests. Try again in ${retryAfterSeconds} seconds.`
      : 'Too many requests. Wait a moment and retry.';
  }
  return REFERRAL_ERRORS[code] ?? 'The account service is unavailable. Try again.';
}

/** Reads one thrown value as the sentence and tone a panel presents. A value
 *  that is not a Settings failure at all is reported as an unreachable
 *  capability rather than guessed at. */
export function settingsFailure(error: unknown): FailureView {
  if (error instanceof ReferralRequestError) {
    return {
      message: referralErrorMessage(error.code, error.retryAfterSeconds),
      tone: error.status < 500 ? 'input' : 'capability',
    };
  }
  return readFailure<'invalid-request' | 'rejected'>(error, MESSAGES, {
    inputKinds: INPUT_KINDS,
    serverSentenceFor:
      error instanceof AgentRuntimeError || error instanceof AccountAccessError ? [error.kind] : [],
  });
}

export function checkoutFailure(error: unknown): FailureView {
  if (error instanceof ReferralRequestError) return settingsFailure(error);
  return { message: 'Could not open the payment page. Try again.', tone: 'capability' };
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

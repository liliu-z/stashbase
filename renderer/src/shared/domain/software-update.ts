/** The Software updates row in Settings, named here because the feature that
 *  fills it in and the panel that renders it are separate features and may not
 *  import each other. */
import type { FailureView } from '@/shared/domain/feature-error';

export interface SoftwareUpdateRow {
  readonly autoCheckEnabled: boolean;
  /** A command is in flight, or the phase is one where asking again would be
   *  refused, so the button is never offered as if it would do something. */
  readonly busy: boolean;
  readonly failure: FailureView | null;
  /** What the current phase reads as, in one sentence. */
  readonly status: string;
  /** The build that is running. */
  readonly version: string;
  readonly actionLabel: string;
  /** Available alongside Restart when a downloaded installer can be superseded. */
  readonly checkAgain: (() => void) | null;
  act(): void;
  readonly setAutoCheck: ((enabled: boolean) => void) | null;
}

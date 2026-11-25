/** What one window knows about updating itself.
 *
 *  A union on the phase rather than one object of optional fields, so a version
 *  exists only where there is a version to name and a percentage only while
 *  bytes are moving. This is the feature's own shape: the wire union is mapped
 *  into it in infrastructure, and no layer above that sees the schema. */
export type UpdateStatus =
  | { readonly phase: 'unsupported' }
  | { readonly phase: 'store' }
  | { readonly phase: 'idle' }
  | { readonly phase: 'checking' }
  | { readonly phase: 'current' }
  | { readonly phase: 'available'; readonly version: string }
  | {
      /** null when main is downloading but could not read a percentage. */
      readonly percent: number | null;
      readonly phase: 'downloading';
      readonly version: string;
    }
  | { readonly phase: 'ready'; readonly version: string; readonly checkFailed?: true }
  | { readonly phase: 'installing'; readonly version: string }
  | { readonly phase: 'error' };

export type UpdatePhaseName = UpdateStatus['phase'];

/** Everything one window is told at once: which build it is, whether it looks
 *  on its own, and where it has got to. */
export interface UpdateState {
  readonly autoCheckEnabled: boolean;
  readonly currentVersion: string;
  readonly status: UpdateStatus;
}

/** Identifies one thing the window has to say. The same phase about the same
 *  version is the same sentence, so a dismissal keyed on this comes back the
 *  moment either changes. */
export function updateStatusKey(status: UpdateStatus): string {
  return 'version' in status ? `${status.phase}:${status.version}` : status.phase;
}

/** True in the phases where main is already working, so asking it to look
 *  again would be refused. */
export function updateInProgress(status: UpdateStatus): boolean {
  return (
    status.phase === 'checking' || status.phase === 'downloading' || status.phase === 'installing'
  );
}

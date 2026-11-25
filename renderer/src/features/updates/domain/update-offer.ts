/**
 * What the window offers for each update phase, as one table.
 *
 * Every sentence a reader sees about updating, every button word, and the
 * decision whether the window volunteers a phase at all live here and nowhere
 * else, so no component branches on a phase string. The table is parameterised
 * by phase, so a row's sentence can only read the fields its own phase carries,
 * and `updateOffer` switches without a default: a new phase fails to compile
 * both at the table and at the resolver until it says what it offers.
 */
import type { UpdatePhaseName, UpdateStatus } from '@/features/updates/domain/update-status';

/** The one thing a phase invites. `primary` runs whatever main decided this
 *  phase's next step is; `check` asks again. */
interface UpdateAction {
  readonly kind: 'primary' | 'check';
  readonly label: string;
}

/** One row, tied to its phase so `sentence` cannot read a field the phase does
 *  not have. */
interface UpdateOfferFor<Phase extends UpdatePhaseName> {
  readonly action: UpdateAction | null;
  /** Whether the window volunteers this on its own. A phase the window stays
   *  quiet about is only an answer Settings gives when asked. */
  readonly announce: boolean;
  sentence(status: Extract<UpdateStatus, { phase: Phase }>): string;
}

/** What one status resolves to: the row, with its sentence already read. */
export interface UpdateOffer {
  readonly action: UpdateAction | null;
  readonly announce: boolean;
  readonly sentence: string;
}

const UPDATE_OFFERS: { readonly [Phase in UpdatePhaseName]: UpdateOfferFor<Phase> } = {
  store: {
    action: { kind: 'primary', label: 'Open Microsoft Store' },
    announce: false,
    sentence: () => 'Microsoft Store manages updates for this app.',
  },
  unsupported: {
    action: null,
    announce: false,
    sentence: () => 'This build of StashBase does not check for updates.',
  },
  idle: {
    action: null,
    announce: false,
    sentence: () => 'No update check yet.',
  },
  checking: {
    action: null,
    announce: false,
    sentence: () => 'Checking for updates…',
  },
  current: {
    action: null,
    announce: false,
    sentence: () => 'StashBase is up to date.',
  },
  // Main downloads a found release on its own, so the window stays quiet
  // until there is something to restart into. Settings still answers.
  available: {
    action: null,
    announce: false,
    sentence: (status) => `StashBase ${status.version} is available.`,
  },
  downloading: {
    action: null,
    announce: false,
    sentence: (status) =>
      status.percent === null
        ? `Downloading StashBase ${status.version}…`
        : `Downloading StashBase ${status.version}… ${status.percent}%`,
  },
  ready: {
    action: { kind: 'primary', label: 'Restart to update' },
    announce: true,
    sentence: (status) =>
      status.checkFailed
        ? `Could not check for a newer version. StashBase ${status.version} is still ready to install.`
        : `StashBase ${status.version} is ready to install.`,
  },
  installing: {
    action: null,
    announce: true,
    sentence: () => 'Installing the update. StashBase will restart.',
  },
  // Deliberately generic. Main publishes this same phase for a check that
  // failed and for an install that failed, and the snapshot carries no
  // installer sentence, so anything more specific would be a guess.
  error: {
    action: { kind: 'check', label: 'Retry' },
    announce: true,
    sentence: () => 'StashBase could not finish the update.',
  },
};

function resolved<Phase extends UpdatePhaseName>(
  row: UpdateOfferFor<Phase>,
  status: Extract<UpdateStatus, { phase: Phase }>,
): UpdateOffer {
  return {
    action: row.action,
    announce: row.announce,
    sentence: row.sentence(status),
  };
}

export function updateOffer(status: UpdateStatus): UpdateOffer {
  switch (status.phase) {
    case 'store':
      return resolved(UPDATE_OFFERS.store, status);
    case 'unsupported':
      return resolved(UPDATE_OFFERS.unsupported, status);
    case 'idle':
      return resolved(UPDATE_OFFERS.idle, status);
    case 'checking':
      return resolved(UPDATE_OFFERS.checking, status);
    case 'current':
      return resolved(UPDATE_OFFERS.current, status);
    case 'available':
      return resolved(UPDATE_OFFERS.available, status);
    case 'downloading':
      return resolved(UPDATE_OFFERS.downloading, status);
    case 'ready':
      return resolved(UPDATE_OFFERS.ready, status);
    case 'installing':
      return resolved(UPDATE_OFFERS.installing, status);
    case 'error':
      return resolved(UPDATE_OFFERS.error, status);
  }
}

/** The offer table: one sentence per phase, the version and the percentage
 *  where they belong, and which phases the window volunteers at all. */
import { describe, expect, it } from 'vite-plus/test';

import { updateOffer } from './update-offer';
import type { UpdatePhaseName, UpdateStatus } from './update-status';

/** One status per phase, as a record over the phase union, so a phase added to
 *  the domain fails to compile here until this fixture names it too. */
const STATUS: { readonly [Phase in UpdatePhaseName]: Extract<UpdateStatus, { phase: Phase }> } = {
  available: { phase: 'available', version: '2.1.0' },
  checking: { phase: 'checking' },
  current: { phase: 'current' },
  downloading: { percent: 42, phase: 'downloading', version: '2.1.0' },
  error: { phase: 'error' },
  idle: { phase: 'idle' },
  installing: { phase: 'installing', version: '2.1.0' },
  ready: { phase: 'ready', version: '2.1.0' },
  unsupported: { phase: 'unsupported' },
  store: { phase: 'store' },
};

const EVERY_STATUS: readonly UpdateStatus[] = Object.values(STATUS);

const phasesWhere = (matches: (status: UpdateStatus) => boolean): UpdatePhaseName[] =>
  EVERY_STATUS.filter(matches)
    .map((status) => status.phase)
    .toSorted();

describe('updateOffer', () => {
  it('gives every phase a sentence of its own', () => {
    const sentences = EVERY_STATUS.map((status) => updateOffer(status).sentence);
    for (const sentence of sentences) expect(sentence.trim()).not.toBe('');
    expect(new Set(sentences).size).toBe(EVERY_STATUS.length);
  });

  it('names the version in every phase that has one to name', () => {
    expect(updateOffer(STATUS.available).sentence).toBe('StashBase 2.1.0 is available.');
    expect(updateOffer(STATUS.downloading).sentence).toBe('Downloading StashBase 2.1.0… 42%');
    expect(updateOffer(STATUS.ready).sentence).toBe('StashBase 2.1.0 is ready to install.');
  });

  it('reads the percentage only when main could read one', () => {
    // Absent is not zero: a download main cannot measure still says it is
    // downloading rather than claiming no progress.
    expect(updateOffer({ percent: null, phase: 'downloading', version: '2.1.0' }).sentence).toBe(
      'Downloading StashBase 2.1.0…',
    );
    expect(updateOffer({ percent: 0, phase: 'downloading', version: '2.1.0' }).sentence).toBe(
      'Downloading StashBase 2.1.0… 0%',
    );
  });

  it('volunteers only the phases worth interrupting a reader for', () => {
    // A found release downloads on its own, so the reader first hears of it
    // when there is something to restart into.
    expect(phasesWhere((status) => updateOffer(status).announce)).toEqual([
      'error',
      'installing',
      'ready',
    ]);
  });

  it('names what each phase invites, and invites nothing in the rest', () => {
    expect(updateOffer(STATUS.ready).action).toEqual({
      kind: 'primary',
      label: 'Restart to update',
    });
    // A failed check and a failed install reach the same phase, and asking
    // again is the one recovery that fits both.
    expect(updateOffer(STATUS.error).action).toEqual({ kind: 'check', label: 'Retry' });
    expect(phasesWhere((status) => updateOffer(status).action !== null)).toEqual([
      'error',
      'ready',
      'store',
    ]);
  });
});

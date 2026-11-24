import { describe, expect, it } from 'vite-plus/test';

import type { AgentRuntime } from '@/features/settings/domain/agent-catalog';
import { agentRuntime } from '@/test/fakes/settings';

import { describeRuntime } from './agent-runtime-status';

/** A runtime nothing has run for yet: discovered, not installed, no ownership
 *  reported. Every case below names only the part it is about. */
function codex(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return agentRuntime({
    id: 'codex',
    installed: false,
    label: 'Codex',
    ownership: null,
    preparation: { kind: 'idle' },
    ...overrides,
  });
}

describe('describeRuntime', () => {
  it('reports null stage while the catalog has not loaded this agent', () => {
    expect(describeRuntime(undefined, false)).toEqual({
      description: 'Checking…',
      stage: null,
      action: null,
      working: null,
    });
  });

  it('offers Install for a not-yet-installed idle runtime, and names it as the work while busy', () => {
    expect(describeRuntime(codex({ installed: false }), false)).toEqual({
      description: 'Not installed',
      stage: 'discover',
      action: { kind: 'install', label: 'Install' },
      working: null,
    });
    expect(describeRuntime(codex({ installed: false }), true)).toEqual({
      description: 'Not installed',
      stage: 'discover',
      action: null,
      working: { label: 'Install', stoppable: false },
    });
  });

  it.each(['install', 'configure'] as const)(
    'reads a running %s preparation as its own note with no action',
    (stage) => {
      const display = describeRuntime(
        codex({
          installed: true,
          preparation: { kind: 'running', note: 'Setting things up…', stage },
        }),
        false,
      );
      expect(display).toEqual({
        description: 'Setting things up…',
        stage,
        action: null,
        working: null,
      });
    },
  );

  it('reads a running sign-in as a wait the reader can stop, under Sign in', () => {
    const signingIn = codex({
      installed: true,
      preparation: {
        kind: 'running',
        note: 'Finish signing in to Codex in your browser.',
        stage: 'authenticate',
      },
    });
    expect(describeRuntime(signingIn, false)).toEqual({
      description: 'Finish signing in to Codex in your browser.',
      stage: 'authenticate',
      action: null,
      working: { label: 'Sign in', stoppable: true },
    });
    // A stop already on its way is not offered twice.
    expect(describeRuntime(signingIn, true).working).toEqual({
      label: 'Sign in',
      stoppable: false,
    });
  });

  it('leaves an account-required failure to the Account row, whatever its stage', () => {
    const display = describeRuntime(
      codex({
        installed: true,
        preparation: {
          kind: 'failed',
          failure: {
            note: 'An account is required to use the StashBase Agent.',
            refusal: 'account-required',
            stage: 'install',
          },
        },
      }),
      false,
    );
    expect(display).toEqual({
      description: 'Needs sign-in',
      stage: 'install',
      action: null,
      working: null,
    });
  });

  it('offers sign-in for an authenticate-stage failure without an account-required refusal', () => {
    const display = describeRuntime(
      codex({
        installed: true,
        preparation: {
          kind: 'failed',
          failure: {
            note: 'Codex needs you to sign in.',
            refusal: 'authentication-required',
            stage: 'authenticate',
          },
        },
      }),
      false,
    );
    expect(display.action).toEqual({ kind: 'login', label: 'Sign in' });
    expect(display.stage).toBe('authenticate');
  });

  // A refused account is signed in already, and a sign-in check that could
  // not answer may be a copy that does not run: connecting again, not
  // another sign-in, is what can change either.
  it.each([
    ['account-refused', 'Signed in, but the provider refused this account.'],
    ['authentication-check-failed', 'Could not check Codex sign-in (exit 1: spawn ENOENT).'],
  ] as const)('offers a recheck, not sign-in, for %s', (refusal, note) => {
    const display = describeRuntime(
      codex({
        installed: true,
        preparation: {
          kind: 'failed',
          failure: { note, refusal, retryAction: 'install', stage: 'authenticate' },
        },
      }),
      false,
    );
    expect(display.action).toEqual({ kind: 'install', label: 'Retry' });
    expect(display.description).toBe(note);
  });

  it('labels a configure-stage failure as a plain retry too', () => {
    const display = describeRuntime(
      codex({
        installed: true,
        preparation: {
          kind: 'failed',
          failure: { note: 'MCP failed.', refusal: 'operation-failed', stage: 'configure' },
        },
      }),
      false,
    );
    expect(display.action).toEqual({ kind: 'retry', label: 'Retry' });
    expect(display.stage).toBe('configure');
  });

  it('labels an install-stage failure as a plain retry', () => {
    const display = describeRuntime(
      codex({
        installed: false,
        preparation: {
          kind: 'failed',
          failure: { note: 'Install failed.', refusal: 'operation-failed', stage: 'install' },
        },
      }),
      false,
    );
    expect(display.action).toEqual({ kind: 'retry', label: 'Retry' });
    expect(display.stage).toBe('install');
  });

  it('withholds the failure action while a retry is already in flight', () => {
    const display = describeRuntime(
      codex({
        installed: true,
        preparation: {
          kind: 'failed',
          failure: { note: 'MCP failed.', refusal: 'operation-failed', stage: 'configure' },
        },
      }),
      true,
    );
    expect(display.action).toBeNull();
    expect(display.description).toBe('MCP failed.');
  });

  it('treats an installed runtime with an idle preparation as already ready, without saying Ready', () => {
    const display = describeRuntime(
      codex({ installed: true, ownership: 'system', preparation: { kind: 'idle' } }),
      false,
    );
    expect(display).toEqual({
      description: 'Installed',
      stage: 'ready',
      action: null,
      working: null,
    });
  });

  it('offers Update for an installed runtime that the host can update, naming the installed and newer versions', () => {
    const display = describeRuntime(
      codex({
        id: 'claude',
        installed: true,
        label: 'Claude',
        ownership: 'system',
        preparation: { kind: 'ready' },
        updatable: true,
        version: '2.1.220',
        availableVersion: '2.1.302',
      }),
      false,
    );
    expect(display).toEqual({
      description: 'Ready · 2.1.220 · 2.1.302 available',
      stage: 'ready',
      action: { kind: 'update', label: 'Update' },
      working: null,
    });
  });

  it('names a model the runtime is too old to run ahead of its readiness', () => {
    const display = describeRuntime(
      codex({
        id: 'claude',
        installed: true,
        label: 'Claude',
        ownership: 'system',
        preparation: { kind: 'ready' },
        updatable: true,
        upgrade: { model: 'Opus 5.5', note: 'Update to 2.1.280+ to use Opus 5.5' },
        version: '2.1.276',
      }),
      false,
    );
    expect(display).toEqual({
      description: 'Opus 5.5 needs a newer Claude · 2.1.276',
      stage: 'ready',
      action: { kind: 'update', label: 'Update' },
      working: null,
    });
  });

  it('withholds Update while the runtime has a command of its own in flight', () => {
    const display = describeRuntime(
      codex({
        installed: true,
        ownership: 'system',
        preparation: { kind: 'ready' },
        updatable: true,
      }),
      true,
    );
    expect(display.action).toBeNull();
  });

  it.each([
    ['bundled', 'Ready · Included with StashBase'],
    ['system', 'Ready'],
  ] as const)(
    'describes a ready %s runtime, naming only the bundled one as included',
    (ownership, label) => {
      const display = describeRuntime(
        codex({ installed: true, ownership, preparation: { kind: 'ready' } }),
        false,
      );
      expect(display).toEqual({
        description: label,
        stage: 'ready',
        action: null,
        working: null,
      });
    },
  );
});

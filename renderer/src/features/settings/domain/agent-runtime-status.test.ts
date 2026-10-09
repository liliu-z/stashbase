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
    });
  });

  it('offers Install for a not-yet-installed idle runtime, and withholds it while busy', () => {
    expect(describeRuntime(codex({ installed: false }), false)).toEqual({
      description: 'Not installed',
      stage: 'discover',
      action: { kind: 'install', label: 'Install' },
    });
    expect(describeRuntime(codex({ installed: false }), true)).toEqual({
      description: 'Not installed',
      stage: 'discover',
      action: null,
    });
  });

  it.each(['install', 'authenticate', 'configure'] as const)(
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
      });
    },
  );

  it('routes an account-required failure to sign-in regardless of failure stage', () => {
    const display = describeRuntime(
      codex({
        installed: true,
        preparation: {
          kind: 'failed',
          failure: {
            note: 'An account is required to use the Default Agent.',
            refusal: 'account-required',
            stage: 'install',
          },
        },
      }),
      false,
    );
    expect(display).toEqual({
      description: 'An account is required to use the Default Agent.',
      stage: 'install',
      action: { kind: 'account', label: 'Sign in' },
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

  it('labels a configure-stage failure as a connection retry', () => {
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
    expect(display.action).toEqual({ kind: 'retry', label: 'Retry connection' });
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

  it('treats an installed runtime with an idle preparation as already ready, without the "Ready to chat" prefix', () => {
    const display = describeRuntime(
      codex({ installed: true, ownership: 'system', preparation: { kind: 'idle' } }),
      false,
    );
    expect(display).toEqual({
      description: 'Installed on your system',
      stage: 'ready',
      action: null,
    });
  });

  it('offers Update for an installed runtime that the host can update, naming the installed version', () => {
    const display = describeRuntime(
      codex({
        id: 'claude',
        installed: true,
        label: 'Claude',
        ownership: 'system',
        preparation: { kind: 'ready' },
        updatable: true,
        version: '2.1.220',
      }),
      false,
    );
    expect(display).toEqual({
      description: 'Ready to chat · Installed on your system · 2.1.220',
      stage: 'ready',
      action: { kind: 'update', label: 'Update' },
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
      description: 'Opus 5.5 needs a newer Claude · Installed on your system · 2.1.276',
      stage: 'ready',
      action: { kind: 'update', label: 'Update' },
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
    ['bundled', 'Included with StashBase'],
    ['system', 'Installed on your system'],
  ] as const)(
    'describes a ready %s runtime with the "Ready to chat" prefix and matching ownership text',
    (ownership, label) => {
      const display = describeRuntime(
        codex({ installed: true, ownership, preparation: { kind: 'ready' } }),
        false,
      );
      expect(display).toEqual({
        description: `Ready to chat · ${label}`,
        stage: 'ready',
        action: null,
      });
    },
  );
});

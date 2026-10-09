import { describe, expect, it } from 'vite-plus/test';

import { AgentSetupRefused } from './connect-agent';
import { agentAccessFailure, agentFailure, failureKind, failureMessage } from './failure-messages';
import { AgentContextError, AgentSessionError } from './ports';

describe('agent failure messages', () => {
  it('keeps service and unexpected error details in the access prompt', () => {
    expect(
      agentAccessFailure(
        new AgentSessionError('unavailable', 'Request failed', {
          cause: new Error('Codex sign-in exited with code 1.'),
        }),
      ),
    ).toContain('Codex sign-in exited with code 1.');
    expect(agentAccessFailure(new Error('Connection timed out.'))).toContain(
      'Connection timed out.',
    );
  });

  it('keeps recovery readable when no detail was supplied, without repeating a mapped sentence', () => {
    const fallback = 'Could not connect.\n\nYour message was kept. Try again.';
    expect(agentAccessFailure(null)).toBe(fallback);
    expect(agentAccessFailure(new AgentSetupRefused(undefined))).toBe(fallback);
    const summary = failureMessage('unavailable');
    expect(
      agentAccessFailure(
        new AgentSessionError('unavailable', summary, { cause: new Error(summary) }),
      ),
    ).toBe(`${summary}\n\nYour message was kept. Try again.`);
  });

  it('names every kind either Agent ladder can report', () => {
    expect(failureMessage('not-found')).toBe('That file is no longer in this folder.');
    expect(failureMessage('unsupported')).toContain('cannot be given to the Agent');
    expect(failureMessage('scope-lost')).toContain('no longer available');
    expect(failureMessage('unauthorized')).toContain('no longer');
    expect(failureMessage('invalid-response')).toContain('unexpected response');
    expect(failureMessage('unavailable')).toContain('could not reach the Agent service');
  });

  it('reads a refusal by its kind and never repeats its own sentence', () => {
    const refusal = new AgentContextError('not-found', 'HTTP 404 /api/agent/context');
    expect(agentFailure(refusal).message).toBe(failureMessage('not-found'));
    expect(agentFailure(new AgentSessionError('scope-lost', 'grant expired')).message).toBe(
      failureMessage('scope-lost'),
    );
  });

  it('treats anything off the ladder as an unreachable Agent service', () => {
    expect(agentFailure(new Error('socket hang up')).message).toBe(failureMessage('unavailable'));
    expect(agentFailure(null).message).toBe(failureMessage('unavailable'));
    expect(failureKind('nonsense')).toBe('unavailable');
  });

  it('separates a file the reader can change from a capability that is gone', () => {
    expect(agentFailure(new AgentContextError('unsupported', 'raw')).tone).toBe('input');
    expect(agentFailure(new AgentSessionError('unavailable', 'raw')).tone).toBe('capability');
  });

  it('answers the kind for decisions that turn on which refusal it was', () => {
    expect(failureKind(new AgentContextError('not-found', 'raw'))).toBe('not-found');
  });
});

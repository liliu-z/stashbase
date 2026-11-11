import { describe, expect, it } from 'vite-plus/test';

import { agentComposerAccepts } from './session';
import { createAgentSessionState, MAX_QUEUED_PROMPTS } from './session-state';

const scope = { kind: 'folder', path: '/project/Research' } as const;
const queued = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    context: [],
    id: `q${index}`,
    skill: null,
    text: 'next',
  }));

describe('createAgentSessionState', () => {
  it('opens a conversation as an unconnected draft with nothing bound to it', () => {
    const state = createAgentSessionState({ agent: 'codex', id: 'chat-1', scope });

    expect(state).toMatchObject({
      accessMode: 'auto',
      activeModel: null,
      agent: 'codex',
      connection: { kind: 'draft' },
      context: [],
      contextIssue: null,
      draft: '',
      effort: null,
      id: 'chat-1',
      lastModified: 0,
      model: null,
      models: [],
      nativeSessionId: null,
      queuedPrompts: [],
      scope,
      skill: null,
      skillCatalog: { kind: 'empty' },
      title: 'Untitled',
      transcript: [],
    });
  });

  it('falls back to the default title for one that is blank', () => {
    expect(
      createAgentSessionState({ agent: 'codex', id: 'chat-1', scope, title: '  ' }).title,
    ).toBe('Untitled');
    expect(
      createAgentSessionState({ agent: 'codex', id: 'chat-1', scope, title: ' Saved ' }).title,
    ).toBe('Saved');
  });

  it('refuses a conversation that could not be addressed later', () => {
    expect(() => createAgentSessionState({ agent: 'codex', id: ' ', scope })).toThrow(
      /must not be empty/u,
    );
    expect(() =>
      createAgentSessionState({
        agent: 'codex',
        id: 'chat-1',
        scope: { kind: 'folder', path: '  ' },
      }),
    ).toThrow(/must not be empty/u);
  });

  it('accepts messages until the queue holds a screen of them or a send is settling', () => {
    const draft = createAgentSessionState({ agent: 'codex', id: 'chat-1', scope });
    const running = {
      ...draft,
      connection: { kind: 'live' as const, turn: { promptBlockId: 'p' } },
    };

    expect(agentComposerAccepts(draft)).toBe(true);
    expect(agentComposerAccepts({ ...running, queuedPrompts: queued(19) })).toBe(true);
    expect(MAX_QUEUED_PROMPTS).toBe(20);
    expect(agentComposerAccepts({ ...running, queuedPrompts: queued(20) })).toBe(false);
    for (const delivery of ['preparing', 'stopping', 'unknown'] as const) {
      expect(agentComposerAccepts({ ...draft, delivery })).toBe(false);
    }
    expect(agentComposerAccepts({ ...draft, connection: { kind: 'retired' } })).toBe(false);
  });
});

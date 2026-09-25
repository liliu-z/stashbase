import { describe, expect, it } from 'vite-plus/test';

import { idleAgentSessionPort } from '@/test/fakes/agent';

import { askAbout } from './ask-about';
import { createAgentWorkspaceRuntime } from './workspace-runtime';

describe('askAbout', () => {
  it('binds an asked-about passage to a chat in its folder and asks for the caret', () => {
    let nextId = 0;
    const runtime = createAgentWorkspaceRuntime({
      createId: () => `chat-${++nextId}`,
      folderPath: '/project/Research',
      port: idleAgentSessionPort(),
    });
    const source = { folderPath: '/project/Research', path: 'drafts/essay.md' };

    askAbout(runtime, source, '  The opening line.\n');
    const active = runtime.activeSession();
    expect(active.store.getState()).toMatchObject({
      composerFocusRequested: true,
      context: [{ kind: 'passage', quote: 'The opening line.', source }],
    });
    active.requestComposerFocus(false);
    askAbout(runtime, source, '   ');
    expect(active.store.getState().composerFocusRequested).toBe(false);

    const elsewhere = { folderPath: '/project/Plans', path: 'plan.md' };
    askAbout(runtime, elsewhere, 'Another folder.');
    expect(runtime.activeSession()).not.toBe(active);
    expect(runtime.activeSession().store.getState()).toMatchObject({
      context: [{ kind: 'passage', source: elsewhere }],
      scope: { kind: 'folder', path: '/project/Plans' },
    });
  });
});

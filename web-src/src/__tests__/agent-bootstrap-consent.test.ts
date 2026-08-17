import assert from 'node:assert/strict';
import test from 'node:test';
import { api, type AgentsResponse } from '../api';
import { activateChatTabForAgent } from '../components/agent/chatActivation';
import type { Action } from '../store/state';

test('switching a blank Codex tab to Claude does not install Claude before confirmation', async () => {
  const originalBootstrap = api.prepareAgent;
  const requested: string[] = [];
  api.prepareAgent = async (agent): Promise<AgentsResponse> => {
    requested.push(agent);
    return { clis: [] };
  };
  try {
    const actions: Action[] = [];
    activateChatTabForAgent(
      {
        chatTabs: [{ id: 'codex-blank', agent: 'codex', title: 'New Chat', blank: true }],
        chatOpen: true,
      },
      (action) => actions.push(action),
      'claude',
    );
    await Promise.resolve();

    assert.deepEqual(actions, [
      { type: 'CHAT_TAB_SET_AGENT', id: 'codex-blank', agent: 'claude' },
      { type: 'CHAT_TAB_ACTIVATE', id: 'codex-blank' },
    ]);
    assert.deepEqual(requested, []);
  } finally {
    api.prepareAgent = originalBootstrap;
  }
});

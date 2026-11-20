import { describe, expect, it, vi } from 'vite-plus/test';

import { modelChoice } from '@/features/agent/domain/model-choice';
import { agentSessionPort } from '@/test/fakes/agent';

import type { AgentPreferencesPort } from './ports';
import { createAgentWorkspaceRuntime } from './workspace-runtime';

const scope = { kind: 'folder', path: '/project' } as const;
const models = [
  { id: 'standard', label: 'Standard', isDefault: true, supportedEfforts: ['medium'] },
  { id: 'writer', label: 'Writer', supportedEfforts: ['high'] },
];

function workspace(preferences?: AgentPreferencesPort) {
  let id = 0;
  const transport = agentSessionPort();
  const runtime = createAgentWorkspaceRuntime({
    createId: () => String(++id),
    folderPath: scope.path,
    preferences,
    port: transport.port,
  });
  return { runtime, ...transport };
}

describe('project model preferences', () => {
  it('restores each agent model and effort on switching and new chats without losing the draft', async () => {
    const { runtime, port } = workspace();
    await runtime.chooseAgent('codex');
    const draft = runtime.activeSession();
    draft.seedModels(models);
    draft.setDraft('Keep this idea');
    draft.setModel('writer');
    draft.setEffort('high');

    await runtime.chooseAgent('claude');
    draft.seedModels(models);
    expect(draft.store.getState()).toMatchObject({ model: null, effort: null });
    draft.setModel('standard');
    draft.setEffort('medium');
    await runtime.chooseAgent('codex');
    draft.seedModels(models);
    expect(draft.store.getState()).toMatchObject({
      model: 'writer',
      effort: 'high',
      draft: 'Keep this idea',
    });

    const next = runtime.newChat();
    next.seedModels(models);
    expect(next.store.getState()).toMatchObject({
      model: 'writer',
      effort: 'high',
    });
    next.start();
    expect(port.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ agent: 'codex', model: 'writer', effort: 'high' }),
      expect.anything(),
    );
    await runtime.chooseAgent('claude');
    runtime.activeSession().seedModels(models);
    expect(runtime.activeSession().store.getState()).toMatchObject({
      model: 'standard',
      effort: 'medium',
    });
    runtime.setWindowFolder('/other');
    await runtime.chooseAgent('codex');
    runtime.activeSession().seedModels(models);
    expect(runtime.activeSession().store.getState()).toMatchObject({
      model: 'writer',
      effort: 'high',
    });
    runtime.activeSession().start();
    expect(port.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ agent: 'codex', model: 'writer', effort: 'high' }),
      expect.anything(),
    );
    runtime.dispose();
  });

  it('loads saved models, keeps native history independent, and does not save catalog fallbacks', async () => {
    const preferences: AgentPreferencesPort = {
      load: vi.fn<AgentPreferencesPort['load']>(async () => ({
        defaultAgent: 'stashbase',
        defaultModels: { codex: 'standard', claude: 'writer' },
        defaultEfforts: { codex: 'medium', claude: 'high' },
        projects: [
          {
            scope: scope.path,
            agent: 'codex',
            models: { codex: 'writer' },
            efforts: { codex: 'high' },
          },
          {
            scope: '/native-default',
            agent: 'codex',
            models: { codex: null },
            efforts: { codex: null },
          },
        ],
      })),
      save: vi.fn(async () => undefined),
    };
    const { runtime, port, listeners } = workspace(preferences);
    await runtime.loadPreferences();
    const first = runtime.activeSession();
    first.seedModels(models);
    expect(first.store.getState()).toMatchObject({ model: 'writer', effort: 'high' });
    first.setDraft('An unfinished conversation');
    first.start();
    listeners[0]?.onEvent({ kind: 'ready' });
    listeners[0]?.onEvent({ kind: 'identified', id: 'native-first' });

    runtime.start(['codex']);
    await runtime.restore({
      id: 'history',
      hasContent: true,
      agent: 'codex',
      scope,
      title: 'Earlier',
      lastModified: 1,
    });
    expect(port.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ resume: 'history', model: undefined, effort: undefined }),
      expect.anything(),
    );
    expect(first.store.getState().model).toBe('writer');

    const next = runtime.newChat();
    next.seedModels(models.filter((model) => model.id === 'standard'));
    expect(next.store.getState()).toMatchObject({ model: 'writer', effort: 'high' });
    expect(modelChoice(next.store.getState())).toMatchObject({
      model: { id: 'writer' },
      effort: 'high',
    });
    next.start();
    listeners.at(-1)?.onEvent({ kind: 'models', models: [], activeModel: null, fallback: null });
    expect(next.store.getState()).toMatchObject({ model: 'writer', effort: 'high' });
    expect(preferences.save).not.toHaveBeenCalled();
    next.setDraft('Keep the fallback chat');
    const availableAgain = runtime.newChat();
    availableAgain.seedModels(models);
    expect(availableAgain.store.getState()).toMatchObject({ model: 'writer', effort: 'high' });
    availableAgain.start();
    listeners.at(-1)?.onEvent({
      kind: 'models',
      models,
      activeModel: 'standard',
      fallback: 'Model unavailable',
    });
    expect(availableAgain.store.getState().model).toBeNull();
    expect(preferences.save).not.toHaveBeenCalled();
    runtime.dispose();

    const reopened = workspace(preferences);
    await reopened.runtime.loadPreferences();
    reopened.runtime.activeSession().seedModels(models);
    expect(reopened.runtime.activeSession().store.getState().model).toBe('writer');
    reopened.runtime.setWindowFolder('/new-after-restart');
    await reopened.runtime.chooseAgent('codex');
    expect(reopened.runtime.activeSession().store.getState()).toMatchObject({
      model: 'standard',
      effort: 'medium',
    });
    await reopened.runtime.chooseAgent('claude');
    expect(reopened.runtime.activeSession().store.getState()).toMatchObject({
      model: 'writer',
      effort: 'high',
    });
    reopened.runtime.setWindowFolder('/native-default');
    expect(reopened.runtime.activeSession().store.getState()).toMatchObject({
      agent: 'codex',
      model: null,
      effort: null,
    });
    reopened.runtime.dispose();
  });

  it('saves explicit changes in order, clears the saved model, and ignores refused choices', async () => {
    const preferences: AgentPreferencesPort = {
      load: vi.fn<AgentPreferencesPort['load']>(async () => ({
        defaultAgent: 'stashbase',
        projects: [{ scope: scope.path, agent: 'codex' }],
      })),
      save: vi.fn(async () => undefined),
    };
    const { runtime, listeners } = workspace(preferences);
    await runtime.loadPreferences();
    const session = runtime.activeSession();
    session.seedModels(models);
    session.setModel('unknown');
    expect(preferences.save).not.toHaveBeenCalled();
    session.setModel('writer');
    session.setModel('writer');
    session.setModel('standard');
    session.setModel(null);
    await vi.waitFor(() => expect(preferences.save).toHaveBeenCalledTimes(3));
    expect(vi.mocked(preferences.save).mock.calls.map((call) => call[3])).toEqual([
      { model: 'writer' },
      { model: 'standard' },
      { model: null },
    ]);
    session.setDraft('Keep this chat');
    const next = runtime.newChat();
    next.seedModels(models);
    expect(next.store.getState().model).toBeNull();
    next.start();
    listeners.at(-1)?.onEvent({ kind: 'ready' });
    listeners.at(-1)?.onEvent({ kind: 'turn-started' });
    next.setModel('writer');
    expect(next.store.getState().model).toBeNull();
    expect(preferences.save).toHaveBeenCalledTimes(3);
    runtime.dispose();
    next.setModel('writer');
    expect(preferences.save).toHaveBeenCalledTimes(3);
  });

  it('retains the selected model and draft when saving fails', async () => {
    const preferences: AgentPreferencesPort = {
      load: vi.fn<AgentPreferencesPort['load']>(async () => ({
        defaultAgent: 'stashbase',
        projects: [],
      })),
      save: vi.fn(async () => {
        throw new Error('Read-only');
      }),
    };
    const { runtime } = workspace(preferences);
    await runtime.loadPreferences();
    const session = runtime.activeSession();
    session.seedModels(models);
    session.setDraft('Keep this idea');
    session.setModel('writer');
    await vi.waitFor(() =>
      expect(runtime.preferences.getState().failure).toContain('Could not save'),
    );
    expect(session.store.getState()).toMatchObject({ model: 'writer', draft: 'Keep this idea' });
    runtime.dispose();
  });

  it('does not seed an incompatible old effort after deliberately changing models', async () => {
    const { runtime } = workspace();
    await runtime.chooseAgent('codex');
    const session = runtime.activeSession();
    session.seedModels(models);
    session.setModel('writer');
    session.setEffort('high');
    session.setModel('standard');
    session.setDraft('Keep this draft');
    const next = runtime.newChat();
    expect(next.store.getState()).toMatchObject({ model: 'standard', effort: null });
    runtime.dispose();
  });
});

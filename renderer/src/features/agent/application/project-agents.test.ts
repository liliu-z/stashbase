import { describe, expect, it, vi } from 'vite-plus/test';

import { idleAgentSessionPort } from '@/test/fakes/agent';
import { agentCatalogPort, CODEX_AGENT } from '@/test/fakes/agent';

import { connectAgent } from './connect-agent';
import type { AgentPreferencesPort, ProjectAgentPreference } from './ports';
import { createAgentWorkspaceRuntime } from './workspace-runtime';

const scope = { kind: 'folder', path: '/project' } as const;
function workspace(preferences: AgentPreferencesPort) {
  let id = 0;
  return createAgentWorkspaceRuntime({
    createId: () => String(++id),
    folderPath: scope.path,
    preferences,
    port: idleAgentSessionPort(),
  });
}

describe('project Agent preferences', () => {
  it('keeps the chosen effort and draft while surfacing a failed preference write', async () => {
    const preferences: AgentPreferencesPort = {
      load: vi.fn<AgentPreferencesPort['load']>(async () => ({
        defaultAgent: 'claude',
        projects: [{ scope: scope.path, agent: 'codex' }],
      })),
      save: vi.fn(async () => {
        throw new Error('Read-only');
      }),
    };
    const runtime = workspace(preferences);
    await runtime.loadPreferences();
    const session = runtime.activeSession();
    session.seedModels([
      { id: 'codex', label: 'Codex', isDefault: true, supportedEfforts: ['high'] },
    ]);
    session.setDraft('Keep my idea');
    session.setEffort('high');
    await vi.waitFor(() =>
      expect(runtime.preferences.getState().failure).toContain('Could not save'),
    );
    expect(session.store.getState()).toMatchObject({ draft: 'Keep my idea', effort: 'high' });
    runtime.dispose();
  });
  it('persists effort per project and Agent without adopting history or catalog defaults', async () => {
    const entries = new Map<string, ProjectAgentPreference>();
    let defaultEfforts: ProjectAgentPreference['efforts'];
    const preferences: AgentPreferencesPort = {
      load: vi.fn<AgentPreferencesPort['load']>(async () => ({
        defaultAgent: 'stashbase',
        defaultEfforts,
        projects: [...entries.values()],
      })),
      save: vi.fn(async (project, agent, _signal, change = {}) => {
        const { effort } = change;
        if (effort !== undefined) defaultEfforts = { ...defaultEfforts, [agent]: effort };
        const previous = entries.get(project.path);
        entries.set(project.path, {
          ...previous,
          scope: project.path,
          agent: effort === undefined ? agent : (previous?.agent ?? agent),
          ...(effort === undefined ? {} : { efforts: { ...previous?.efforts, [agent]: effort } }),
        });
      }),
    };
    const models = [
      {
        id: 'model',
        label: 'Model',
        isDefault: true,
        defaultEffort: 'medium',
        supportedEfforts: ['medium', 'high'],
      },
    ];
    const first = workspace(preferences);
    await first.loadPreferences();
    await first.chooseAgent('codex');
    first.activeSession().seedModels(models);
    first.activeSession().setEffort('high');
    first.activeSession().setEffort('medium');
    first.activeSession().setEffort('high');
    await first.loadPreferences();
    expect(entries.get(scope.path)?.efforts?.codex).toBe('high');
    await first.chooseAgent('claude');
    first.activeSession().seedModels(models);
    expect(first.activeSession().store.getState().effort).toBeNull();
    first.activeSession().setEffort('medium');
    await first.chooseAgent('codex');
    expect(first.activeSession().store.getState().effort).toBe('high');
    first.setWindowFolder('/other');
    await first.chooseAgent('codex');
    expect(first.activeSession().store.getState().effort).toBe('high');
    first.dispose();

    const reopened = workspace(preferences);
    await reopened.loadPreferences();
    reopened.activeSession().seedModels(models);
    expect(reopened.activeSession().store.getState()).toMatchObject({
      agent: 'codex',
      effort: 'high',
    });
    const writes = vi.mocked(preferences.save).mock.calls.length;
    await reopened.restore({
      id: 'history',
      hasContent: true,
      agent: 'codex',
      scope,
      title: 'Earlier',
      lastModified: 1,
    });
    expect(vi.mocked(preferences.save).mock.calls.length).toBe(writes);
    expect(reopened.newChat().store.getState().effort).toBe('high');
    reopened
      .activeSession()
      .seedModels(models.map((model) => ({ ...model, supportedEfforts: ['medium'] })));
    expect(reopened.activeSession().store.getState().effort).toBe('high');
    expect(vi.mocked(preferences.save).mock.calls.length).toBe(writes);
    reopened.activeSession().seedModels(models);
    reopened.activeSession().setEffort('medium');
    reopened.activeSession().setEffort(null);
    await reopened.loadPreferences();
    expect(entries.get(scope.path)?.efforts?.codex).toBeNull();
    reopened.dispose();
  });
  it('carries explicit thinking effort into a new Codex chat and its connection', async () => {
    let id = 0;
    const port = idleAgentSessionPort();
    const runtime = createAgentWorkspaceRuntime({
      createId: () => String(++id),
      folderPath: scope.path,
      port,
    });
    await runtime.chooseAgent('codex');
    const first = runtime.activeSession();
    const models = [
      {
        id: 'gpt-codex',
        label: 'Codex',
        isDefault: true,
        defaultEffort: 'medium',
        supportedEfforts: ['medium', 'high'],
      },
    ];
    first.seedModels(models);
    first.setEffort('high');
    first.setDraft('Keep this conversation');
    const next = runtime.newChat();
    next.seedModels(models);
    expect(next.store.getState().effort).toBe('high');
    next.start();
    expect(port.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ agent: 'codex', effort: 'high' }),
      expect.anything(),
    );
    runtime.dispose();
  });
  it('inherits the latest choice in new projects and preserves existing project choices across restarts', async () => {
    const entries: ProjectAgentPreference[] = [];
    let defaultAgent: ProjectAgentPreference['agent'] = 'stashbase';
    const preferences: AgentPreferencesPort = {
      load: vi.fn<AgentPreferencesPort['load']>(async () => ({ defaultAgent, projects: entries })),
      save: vi.fn(async (selectedScope, agent) => {
        defaultAgent = agent;
        const previous = entries.findIndex((entry) => entry.scope === selectedScope.path);
        if (previous >= 0) entries.splice(previous, 1);
        entries.push({ scope: selectedScope.path, agent });
      }),
    };
    const first = workspace(preferences);
    await first.loadPreferences();
    first.activeSession().setDraft('Unsent work');
    await first.chooseAgent('codex');
    expect(first.activeSession().store.getState().draft).toBe('Unsent work');
    expect(first.newChat().store.getState().agent).toBe('codex');
    first.setWindowFolder('/other');
    expect(first.activeSession().store.getState().agent).toBe('codex');
    await first.chooseAgent('claude');
    first.setWindowFolder('/third');
    expect(first.activeSession().store.getState().agent).toBe('claude');
    first.dispose();
    const reopened = workspace(preferences);
    await reopened.loadPreferences();
    expect(reopened.activeSession().store.getState().agent).toBe('codex');
    reopened.setWindowFolder('/new-after-restart');
    expect(reopened.activeSession().store.getState().agent).toBe('claude');
    await reopened.chooseAgent('stashbase');
    reopened.setWindowFolder('/explicit-default');
    expect(reopened.activeSession().store.getState().agent).toBe('stashbase');
    reopened.dispose();
  });
  it('exposes preference failure without overwriting a saved choice or losing work', async () => {
    const preferences: AgentPreferencesPort = {
      load: vi
        .fn()
        .mockRejectedValueOnce(new Error('Offline'))
        .mockResolvedValue({
          defaultAgent: 'claude',
          projects: [{ scope: scope.path, agent: 'claude' }],
        }),
      save: vi.fn(async () => {
        throw new Error('Read-only');
      }),
    };
    const runtime = workspace(preferences);
    runtime.activeSession().setDraft('Keep this');
    await runtime.loadPreferences();
    expect(runtime.preferences.getState().failure).not.toBeNull();
    expect(await runtime.chooseAgent('codex')).toBe(false);
    expect(preferences.save).not.toHaveBeenCalled();
    await runtime.loadPreferences();
    expect(runtime.activeSession().store.getState().agent).toBe('claude');
    expect(await runtime.chooseAgent('codex')).toBe(false);
    expect(runtime.activeSession().store.getState()).toMatchObject({
      agent: 'claude',
      draft: 'Keep this',
    });
    runtime.dispose();
  });
  it('waits for acknowledged setup and the requested native login to finish', async () => {
    const port = agentCatalogPort([], {
      prepareAgent: vi
        .fn()
        .mockResolvedValueOnce({
          agents: [{ ...CODEX_AGENT, ready: false, preparation: { step: 'install' } }],
        })
        .mockResolvedValueOnce({
          agents: [{ ...CODEX_AGENT, ready: false, preparation: { step: 'install' } }],
        }),
      listAgents: vi
        .fn()
        .mockResolvedValueOnce({ agents: [{ ...CODEX_AGENT, ready: false, needsSignIn: true }] })
        .mockResolvedValueOnce({ agents: [CODEX_AGENT] }),
    });
    await connectAgent(port, 'codex', undefined, new AbortController().signal, {
      wait: async () => undefined,
    });
    expect(vi.mocked(port.prepareAgent).mock.calls.map((call) => call[1])).toEqual([
      'bootstrap',
      'login',
    ]);
  });
});

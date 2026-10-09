import { describe, expect, it } from 'vite-plus/test';

import { agentUpdateFailure } from '@/features/agent/application/failure-messages';
import { httpClient } from '@/test/fakes/http';

import { createAgentCatalogAdapter } from './catalog-api';

const capabilities = {
  approvals: true,
  attachments: true,
  connection: true,
  effort: true,
  history: true,
  interrupt: true,
  models: true,
  modes: ['default', 'acceptEdits', 'plan', 'auto'],
  prompts: true,
  skills: true,
  steering: true,
  titleHint: true,
  transcript: true,
};

function runtime(overrides: Record<string, unknown>) {
  return {
    bootstrap: { phase: 'ready' },
    capabilities,
    id: 'codex',
    installHint: '',
    installed: true,
    label: 'Codex',
    launchCommand: 'codex',
    source: 'system',
    state: 'available',
    vendor: 'OpenAI',
    ...overrides,
  };
}

const signal = new AbortController().signal;

describe('agent catalog adapter', () => {
  it('preserves an HTTP rejection all the way to the Update failure message', async () => {
    const detail = 'Codex is already running login. Wait for it to finish, then retry update.';
    const adapter = createAgentCatalogAdapter({
      request: async () => ({ status: 409, body: { error: detail } }),
    });
    await expect(adapter.prepareAgent('codex', 'update', signal)).rejects.toSatisfy(
      (error) => agentUpdateFailure(error) === detail,
    );
  });
  it('keeps the failed setup step and explanation for the first-send dialog', async () => {
    const adapter = createAgentCatalogAdapter(
      httpClient({
        clis: [
          runtime({
            state: 'failed',
            bootstrap: {
              phase: 'failed',
              failure: {
                stage: 'mcp',
                code: 'operation-failed',
                retryable: true,
                message: 'Could not read Codex config.toml: permission denied.',
              },
            },
          }),
        ],
      }),
    );
    const { agents } = await adapter.prepareAgent('codex', 'bootstrap', signal);
    expect(agents[0]?.ready).toBe(false);
    expect(agents[0]?.setupFailure).toEqual({
      stage: 'mcp',
      message: 'Could not read Codex config.toml: permission denied.',
    });
  });

  it('hands a fresh chat the catalog the service remembers, flags and all', async () => {
    const adapter = createAgentCatalogAdapter(
      httpClient({
        clis: [
          runtime({
            catalog: {
              models: [
                {
                  defaultEffort: 'medium',
                  id: 'gpt-6',
                  isDefault: true,
                  label: 'GPT-6',
                  supportedEfforts: ['low', 'medium'],
                },
                { id: 'gpt-5', label: 'GPT-5' },
              ],
              readAt: '2026-09-11T00:00:00.000Z',
            },
          }),
        ],
      }),
    );

    const { agents } = await adapter.listAgents(signal);
    expect(agents[0]?.models).toEqual([
      {
        defaultEffort: 'medium',
        id: 'gpt-6',
        isDefault: true,
        label: 'GPT-6',
        supportedEfforts: ['low', 'medium'],
      },
      { id: 'gpt-5', label: 'GPT-5' },
    ]);
  });

  it('marks the model a runtime last ran when its catalog flags no default of its own', async () => {
    const adapter = createAgentCatalogAdapter(
      httpClient({
        clis: [
          runtime({
            catalog: {
              defaultModel: 'opus',
              models: [
                { id: 'sonnet', label: 'Sonnet' },
                { id: 'opus', label: 'Opus', supportedEfforts: ['low', 'high'] },
              ],
              readAt: '2026-09-11T00:00:00.000Z',
            },
            id: 'claude',
            label: 'Claude',
          }),
        ],
      }),
    );

    const { agents } = await adapter.listAgents(signal);
    expect(agents[0]?.models).toEqual([
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', isDefault: true, label: 'Opus', supportedEfforts: ['low', 'high'] },
    ]);
  });

  it('leaves a runtime nothing has read with no models and every promise honored by default', async () => {
    const adapter = createAgentCatalogAdapter(
      httpClient({ clis: [runtime({ capabilities: undefined })] }),
    );

    const { agents } = await adapter.listAgents(signal);
    expect(agents[0]?.models).toEqual([]);
    expect(agents[0]?.abilities.modes).toEqual(['default', 'plan', 'acceptEdits', 'auto']);
  });
});

import { describe, expect, it, vi } from 'vite-plus/test';

import { settingsFailure } from '@/features/settings/application/failure-messages';
import type { HttpClient } from '@/platform/http/client';

import { createAgentRuntimeAdapter } from './agent-runtime-api';

const catalogBody = {
  clis: [
    {
      id: 'stashbase',
      label: 'Default',
      vendor: 'StashBase',
      installHint: '',
      installed: true,
      source: 'bundled',
      bootstrap: { phase: 'ready' },
      launchCommand: 'stashbase',
    },
  ],
  debug: { enabled: true, nextFailure: 'none', nextTurnFailure: 'none' },
};

describe('agent runtime API', () => {
  it('preserves the service diagnostic through the Settings failure presenter', async () => {
    const detail = 'EACCES: unable to write /Users/example/.local/bin/codex';
    const adapter = createAgentRuntimeAdapter({
      request: async () => ({ status: 500, body: { error: detail } }),
    });
    await expect(
      adapter.prepareAgent('codex', 'update', new AbortController().signal),
    ).rejects.toSatisfy((error) => settingsFailure(error).message === detail);
  });
  it('lists the catalog and maps a well-formed response', async () => {
    const client: HttpClient = { request: vi.fn(async () => ({ body: catalogBody, status: 200 })) };
    const signal = new AbortController().signal;

    await expect(createAgentRuntimeAdapter(client).listAgents(signal)).resolves.toEqual({
      runtimes: [
        {
          id: 'stashbase',
          installed: true,
          label: 'Default',
          ownership: 'bundled',
          preparation: { kind: 'ready' },
          updatable: false,
          upgrade: null,
          version: null,
        },
      ],
      debug: { nextSetupResult: 'none', nextTurnResult: 'none' },
    });
    expect(client.request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/terminal/clis',
      signal,
    });
  });

  it('reads debug controls the server disabled as no controls at all', async () => {
    const client: HttpClient = {
      request: vi.fn(async () => ({
        body: { ...catalogBody, debug: { ...catalogBody.debug, enabled: false } },
        status: 200,
      })),
    };

    await expect(
      createAgentRuntimeAdapter(client).listAgents(new AbortController().signal),
    ).resolves.toMatchObject({ debug: null });
  });

  it('prepares an agent with the requested action', async () => {
    const client: HttpClient = { request: vi.fn(async () => ({ body: catalogBody, status: 200 })) };
    const signal = new AbortController().signal;

    await createAgentRuntimeAdapter(client).prepareAgent('codex', 'bootstrap', signal);

    expect(client.request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/terminal/clis/codex/bootstrap',
      signal,
    });
  });

  it('preserves the failed operation so a runtime retry does not become a readiness check', async () => {
    const client: HttpClient = {
      request: vi.fn(async () => ({
        status: 200,
        body: {
          clis: [
            {
              ...catalogBody.clis[0],
              id: 'claude',
              label: 'Claude',
              bootstrap: {
                phase: 'failed',
                failure: {
                  stage: 'installation',
                  code: 'operation-failed',
                  message: 'Download failed',
                  retryable: true,
                  retryAction: 'update',
                },
              },
            },
          ],
        },
      })),
    };
    const result = await createAgentRuntimeAdapter(client).listAgents(new AbortController().signal);
    expect(result.runtimes[0]?.preparation).toEqual({
      kind: 'failed',
      failure: {
        stage: 'install',
        refusal: 'operation-failed',
        note: 'Download failed',
        retryAction: 'update',
      },
    });
  });

  it('sends a validated debug patch over PUT', async () => {
    const client: HttpClient = { request: vi.fn(async () => ({ body: catalogBody, status: 200 })) };
    const signal = new AbortController().signal;

    await createAgentRuntimeAdapter(client).updateDebug({ nextSetupResult: 'mcp' }, signal);

    expect(client.request).toHaveBeenCalledWith({
      body: { nextFailure: 'mcp' },
      method: 'PUT',
      path: '/api/terminal/debug',
      signal,
    });
  });

  it('fetches the allowance and drops the fields no reader has', async () => {
    const allowance = {
      profile: 'stashbase-agent-default',
      remainingPercent: 62,
      inputTokens: 128_402,
      outputTokens: 41_208,
      cacheReadTokens: 9_014,
      windowStartedAt: '2026-09-01T00:00:00.000Z',
      windowEndsAt: '2026-09-08T00:00:00.000Z',
    };
    const client: HttpClient = { request: vi.fn(async () => ({ body: allowance, status: 200 })) };

    await expect(
      createAgentRuntimeAdapter(client).getAllowance(new AbortController().signal),
    ).resolves.toEqual({
      cacheReadTokens: 9_014,
      inputTokens: 128_402,
      outputTokens: 41_208,
      remainingPercent: 62,
      windowEndsAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('rejects malformed success and sanitizes server failures', async () => {
    const malformed = createAgentRuntimeAdapter({
      request: vi.fn(async () => ({ body: { clis: 'wrong' }, status: 200 })),
    });
    await expect(malformed.listAgents(new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid-response',
    });

    const unavailable = createAgentRuntimeAdapter({
      request: vi.fn(async () => ({ body: { error: 'private filesystem detail' }, status: 500 })),
    });
    await expect(unavailable.listAgents(new AbortController().signal)).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'Agent runtimes are unavailable.',
    });
  });
});

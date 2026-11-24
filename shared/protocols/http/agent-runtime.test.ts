import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentRuntimeDebugPatchRequestSchema,
  agentRuntimeFailureSchema,
  agentsResponseSchema,
  hostedAgentAllowanceSchema,
} from './agent-runtime.ts';

test('a runtime entry carries the catalog the service remembers for it, and nothing else inside it', () => {
  const entry = {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    installHint: '',
    installed: true,
    source: 'system',
    version: '0.104.0',
    updatable: false,
    bootstrap: { phase: 'ready' },
    launchCommand: 'codex',
    state: 'available',
    catalog: {
      models: [
        { id: 'gpt-6', label: 'GPT-6', supportedEfforts: ['low', 'medium'], defaultEffort: 'medium', isDefault: true },
        { id: 'gpt-5', label: 'GPT-5' },
      ],
      defaultModel: 'gpt-6',
      readAt: '2026-09-11T00:00:00.000Z',
    },
  };
  const parsed = agentsResponseSchema.parse({ clis: [entry] });
  assert.deepEqual(parsed.clis[0]?.catalog, entry.catalog);
  assert.equal(parsed.clis[0]?.version, '0.104.0');
  assert.equal(parsed.clis[0]?.updatable, false);
  assert.throws(() => agentsResponseSchema.parse({ clis: [{ ...entry, catalog: { ...entry.catalog, stale: true } }] }));
});

test('a runtime entry carries a model the runtime says it is too old to run', () => {
  const entry = {
    id: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    installHint: '',
    installed: true,
    source: 'system',
    version: '2.1.276',
    updatable: true,
    upgrade: { model: 'Opus 5.5', note: 'Update to 2.1.280+ to use Opus 5.5' },
    bootstrap: { phase: 'ready' },
    launchCommand: 'claude',
    state: 'available',
  };
  assert.deepEqual(agentsResponseSchema.parse({ clis: [entry] }).clis[0]?.upgrade, entry.upgrade);
  // Absent is the normal state: an up-to-date runtime sends no offer at all.
  const { upgrade: _omitted, ...current } = entry;
  assert.equal(agentsResponseSchema.parse({ clis: [current] }).clis[0]?.upgrade, undefined);
  assert.throws(() =>
    agentsResponseSchema.parse({ clis: [{ ...entry, upgrade: { ...entry.upgrade, url: 'https://example' } }] }),
  );
});

test('agents response accepts a mixed catalog of installed, mid-bootstrap, and failed runtimes', () => {
  const result = agentsResponseSchema.parse({
    clis: [
      {
        id: 'stashbase',
        label: 'Built-in',
        vendor: 'StashBase',
        installHint: '',
        installed: true,
        source: 'bundled',
        bootstrap: { phase: 'ready' },
        launchCommand: 'stashbase',
      },
      {
        id: 'codex',
        label: 'Codex',
        vendor: 'OpenAI',
        installHint: 'npm install -g codex',
        installed: false,
        bootstrap: { phase: 'idle' },
        launchCommand: 'codex',
      },
      {
        id: 'claude',
        label: 'Claude',
        vendor: 'Anthropic',
        installHint: 'curl -fsSL https://claude.ai/install.sh | bash',
        installed: true,
        source: 'system',
        bootstrap: {
          phase: 'failed',
          failure: {
            stage: 'authentication',
            code: 'authentication-required',
            message: 'Sign in required.',
            retryable: true,
          },
        },
        launchCommand: 'claude',
      },
    ],
    debug: {
      enabled: true,
      nextFailure: 'none',
      nextTurnFailure: 'none',
    },
  });
  assert.equal(result.clis.length, 3);
  assert.equal(result.clis[2]?.bootstrap?.failure?.code, 'authentication-required');
});

test('agents response rejects an unlisted field', () => {
  assert.equal(
    agentsResponseSchema.safeParse({
      clis: [],
      unexpected: true,
    }).success,
    false,
  );
});

test('debug patch accepts a partial update and rejects an unknown field', () => {
  assert.equal(
    agentRuntimeDebugPatchRequestSchema.safeParse({ nextFailure: 'mcp' }).success,
    true,
  );
  assert.equal(agentRuntimeDebugPatchRequestSchema.safeParse({}).success, true);
  assert.equal(agentRuntimeDebugPatchRequestSchema.safeParse({ enabled: true }).success, false);
});

test('agent runtime failure keeps an unlisted field and requires a non-empty error', () => {
  const parsed = agentRuntimeFailureSchema.safeParse({ error: 'unavailable', extra: 'kept' });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.extra, 'kept');
  assert.equal(agentRuntimeFailureSchema.safeParse({ error: '' }).success, false);
});

test('hosted agent allowance allows a not-yet-started window', () => {
  assert.equal(
    hostedAgentAllowanceSchema.parse({
      profile: 'stashbase-agent-default',
      remainingPercent: 100,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      windowStartedAt: null,
      windowEndsAt: null,
    }).windowStartedAt,
    null,
  );
});

test('hosted allowance preserves credits-v1 precision and does not use the base percentage as the total', () => {
  const zero = '0.000000000';
  const balances = { availableCredits: zero, consumedCredits: zero, reservedCredits: zero, provisionalCredits: zero };
  const at = '2026-11-23T10:00:00.000Z';
  const exact = '0.000000001';
  const creditBreakdown = {
    creditUnit: 'credits-v1', asOf: at, agentAvailableCredits: exact,
    base: { ...balances, grantedCredits: zero, windowStartedAt: null, windowEndsAt: null },
    bonus: { ...balances, availableCredits: exact, entitlementCredits: exact, nextExpiry: { at, availableCredits: exact } },
  };
  const usage = {
    profile: 'stashbase-agent-default', remainingPercent: 0, reservedPercent: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, windowStartedAt: null, windowEndsAt: null,
    creditBreakdown,
  };
  assert.deepEqual(hostedAgentAllowanceSchema.parse(usage).creditBreakdown, creditBreakdown);
  assert.equal(hostedAgentAllowanceSchema.safeParse({
    ...usage, creditBreakdown: { ...creditBreakdown, agentAvailableCredits: 1e-9 },
  }).success, false);
});

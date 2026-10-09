/**
 * The Agents panel's transport, and the one place the service's runtime
 * vocabulary becomes this feature's.
 *
 * The service names its list `clis`, keeps a bootstrap phase beside a nullable
 * failure, names its steps after the mechanism that runs them, and sends debug
 * controls with an `enabled` flag the renderer has no authority over. All four
 * translations happen here, so nothing above this file reads a wire shape.
 */

import { AgentRuntimeError, type AgentRuntimePort } from '@/features/settings/application/ports';
import type {
  AgentCatalog,
  AgentDebugControls,
  AgentPreparation,
  AgentPreparationFailure,
  AgentPreparationStage,
  AgentRuntime,
  AgentRuntimeStage,
  AgentAllowance,
} from '@/features/settings/domain/agent-catalog';
import type { BillingPlan, BillingStatus } from '@/features/settings/domain/billing';
import {
  request,
  requestOptions,
  type TransportCall,
  type TransportRequest,
} from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  agentRuntimeDebugPatchRequestSchema,
  agentRuntimeFailureSchema,
  agentsResponseSchema,
  hostedAgentAllowanceSchema,
  hostedBillingCheckoutRequestSchema,
  hostedBillingPlansSchema,
  hostedBillingRedirectSchema,
  hostedBillingStatusSchema,
  type AgentBootstrapFailureWire,
  type AgentBootstrapStatusWire,
  type AgentRuntimeDebugStateWire,
  type AgentsResponseWire,
  type AgentWire,
  type HostedAgentAllowanceWire,
  type HostedBillingPlanWire,
  type HostedBillingStatusWire,
} from '@/protocols/http/agent-runtime';

/** The service names a step after the mechanism that runs it; the track names
 *  it after what the reader is waiting for. */
function toStage(step: AgentBootstrapFailureWire['stage']): AgentRuntimeStage {
  switch (step) {
    case 'installation':
      return 'install';
    case 'authentication':
      return 'authenticate';
    case 'mcp':
      return 'configure';
    case 'discovery':
      return 'discover';
  }
}

/** The stage a still-running bootstrap is standing on, or null when its phase
 *  is not a preparation step at all. */
function runningStage(phase: AgentBootstrapStatusWire['phase']): AgentPreparationStage | null {
  switch (phase) {
    case 'installing':
      return 'install';
    case 'authenticating':
      return 'authenticate';
    case 'configuring':
      return 'configure';
    case 'idle':
    case 'ready':
    case 'failed':
      return null;
  }
}

/** The daemon writes its own note about a step that stopped — it names the
 *  binary, the port, the login — so it is carried as the failure's `note` and
 *  reaches the panel only where nothing on the ladder says more. */
function toFailure(wire: AgentBootstrapFailureWire): AgentPreparationFailure {
  return {
    note: wire.message.trim() === '' ? null : wire.message,
    refusal: wire.code,
    stage: toStage(wire.stage),
    ...(wire.retryAction
      ? { retryAction: wire.retryAction === 'bootstrap' ? ('install' as const) : wire.retryAction }
      : {}),
  };
}

/** A withheld bootstrap and an `idle` one mean the same thing to the panel:
 *  nothing has run yet. A `failed` phase without a failure body cannot say
 *  which stage stopped, so it reports the stage nothing has passed. */
function toPreparation(wire: AgentBootstrapStatusWire | undefined): AgentPreparation {
  if (!wire) return { kind: 'idle' };
  if (wire.phase === 'failed') {
    return {
      kind: 'failed',
      failure: wire.failure
        ? toFailure(wire.failure)
        : { note: null, refusal: 'operation-failed', stage: 'discover' },
    };
  }
  const stage = runningStage(wire.phase);
  if (stage) return { kind: 'running', note: wire.message ?? null, stage };
  return wire.phase === 'ready' ? { kind: 'ready' } : { kind: 'idle' };
}

function toRuntime(wire: AgentWire): AgentRuntime {
  return {
    id: wire.id,
    installed: wire.installed,
    label: wire.label,
    ownership: wire.source ?? null,
    preparation: toPreparation(wire.bootstrap),
    updatable: wire.updatable ?? false,
    upgrade: wire.upgrade ?? null,
    version: wire.version ?? null,
  };
}

/** Debugging is the service's call, not the renderer's: controls it sends with
 *  `enabled` false are an absence here rather than a disabled block. */
function toDebugControls(wire: AgentRuntimeDebugStateWire | undefined): AgentDebugControls | null {
  if (!wire?.enabled) return null;
  return {
    nextSetupResult: wire.nextFailure,
    nextTurnResult: wire.nextTurnFailure,
  };
}

/** The one place the service's `clis` field becomes this feature's `runtimes`. */
function toAgentCatalog(wire: AgentsResponseWire): AgentCatalog {
  return { debug: toDebugControls(wire.debug), runtimes: wire.clis.map(toRuntime) };
}

/** The panel shows a window and a balance; the profile name and window start
 *  the service also sends have no reader. */
function toAllowance(wire: HostedAgentAllowanceWire): AgentAllowance {
  return {
    cacheReadTokens: wire.cacheReadTokens,
    inputTokens: wire.inputTokens,
    outputTokens: wire.outputTokens,
    remainingPercent: wire.remainingPercent,
    windowEndsAt: wire.windowEndsAt,
  };
}

/** The catalog's plan key and Stripe product metadata have no reader. */
function toBillingPlan(wire: HostedBillingPlanWire): BillingPlan {
  return {
    amount: wire.amount,
    available: wire.available,
    currency: wire.currency,
    interval: wire.interval,
    name: wire.name,
    priceId: wire.priceId,
  };
}

function toBillingStatus(wire: HostedBillingStatusWire): BillingStatus {
  return {
    cancelAtPeriodEnd: wire.cancelAtPeriodEnd,
    canManage: wire.canManage,
    paidThrough: wire.paidThrough,
    planName: wire.plan?.name ?? null,
    status: wire.status,
  };
}

const BILLING_INVALID = 'Billing returned an invalid response.';

function runtime(
  path: string,
  signal: AbortSignal,
  invalid: string,
  extra?: { body?: unknown; method?: TransportCall['method'] },
): TransportRequest {
  return requestOptions({
    ...extra,
    error: AgentRuntimeError,
    failureSchema: agentRuntimeFailureSchema,
    messages: {
      'invalid-response': invalid,
      'scope-lost': 'Agent runtimes are unavailable.',
      unauthorized: 'Agent runtimes are unavailable.',
      unavailable: 'Agent runtimes are unavailable.',
    },
    path,
    signal,
  });
}

const CATALOG_INVALID = 'Agent catalog returned an invalid response.';

async function catalog(
  client: HttpClient,
  path: string,
  signal: AbortSignal,
  extra?: { body?: unknown; method?: TransportRequest['method'] },
): Promise<AgentCatalog> {
  return toAgentCatalog(
    await request(client, {
      ...runtime(path, signal, CATALOG_INVALID, extra),
      schema: agentsResponseSchema,
    }),
  );
}

export function createAgentRuntimeAdapter(client: HttpClient): AgentRuntimePort {
  return {
    listAgents(signal) {
      return catalog(client, '/api/terminal/clis', signal, { method: 'GET' });
    },
    prepareAgent(id, action, signal) {
      return catalog(client, `/api/terminal/clis/${id}/${action}`, signal, { method: 'POST' });
    },
    updateDebug(patch, signal) {
      return catalog(client, '/api/terminal/debug', signal, {
        body: agentRuntimeDebugPatchRequestSchema.parse({
          ...(patch.nextSetupResult === undefined ? {} : { nextFailure: patch.nextSetupResult }),
          ...(patch.nextTurnResult === undefined ? {} : { nextTurnFailure: patch.nextTurnResult }),
        }),
        method: 'PUT',
      });
    },
    async getAllowance(signal) {
      return toAllowance(
        await request(client, {
          ...runtime(
            '/api/account/agent-usage',
            signal,
            'Agent allowance returned an invalid response.',
            { method: 'GET' },
          ),
          schema: hostedAgentAllowanceSchema,
        }),
      );
    },
    async getBillingPlans(signal) {
      const answer = await request(client, {
        ...runtime('/api/account/billing/plans', signal, BILLING_INVALID, { method: 'GET' }),
        schema: hostedBillingPlansSchema,
      });
      return answer.plans.map(toBillingPlan);
    },
    async getBillingStatus(signal) {
      return toBillingStatus(
        await request(client, {
          ...runtime('/api/account/billing/status', signal, BILLING_INVALID, { method: 'GET' }),
          schema: hostedBillingStatusSchema,
        }),
      );
    },
    async startCheckout(priceId, signal) {
      const answer = await request(client, {
        ...runtime('/api/account/billing/checkout', signal, BILLING_INVALID, {
          body: hostedBillingCheckoutRequestSchema.parse({ priceId }),
          method: 'POST',
        }),
        schema: hostedBillingRedirectSchema,
      });
      return answer.url;
    },
    async openBillingPortal(signal) {
      const answer = await request(client, {
        ...runtime('/api/account/billing/portal', signal, BILLING_INVALID, { method: 'POST' }),
        schema: hostedBillingRedirectSchema,
      });
      return answer.url;
    },
  };
}

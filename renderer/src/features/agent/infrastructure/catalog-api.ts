/**
 * The runtime catalog a conversation reads, and the one place the service's
 * runtime vocabulary becomes this feature's.
 *
 * The Agents panel reads the same endpoint to answer a different question, so
 * the two features map it separately: this one only ever asks whether a runtime
 * can carry a turn, what stands in the way when it cannot, and what a turn on
 * it may use. Capabilities the service omits are resolved here, so no view
 * repeats a `?? true` of its own.
 */
import { AgentSessionError, type AgentCatalogPort } from '@/features/agent/application/ports';
import { AGENT_ACCESS_MODES } from '@/features/agent/domain/access';
import type { Agent, AgentAbilities, AgentCatalog } from '@/features/agent/domain/agent-catalog';
import type { AgentModel } from '@/features/agent/domain/runtime-catalog';
import { toModel } from '@/features/agent/infrastructure/model-wire';
import { request, type TransportRequest } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  agentRuntimeFailureSchema,
  agentsResponseSchema,
  type AgentsResponseWire,
  type AgentWire,
} from '@/protocols/http/agent-runtime';

/** A runtime that advertises nothing runs plain prompts. `modes` is the one
 *  capability every runtime has unless it says otherwise: a service that
 *  omits capabilities honors every promise, and one that lists them is taken
 *  at its word, in the composer's order rather than the wire's. */
function toAbilities(wire: AgentWire['capabilities']): AgentAbilities {
  const honored = wire?.modes;
  return {
    attachments: wire?.attachments === true,
    effort: wire?.effort === true,
    models: wire?.models === true,
    modes:
      honored === undefined
        ? AGENT_ACCESS_MODES
        : AGENT_ACCESS_MODES.filter((mode) => honored.includes(mode)),
    skills: wire?.skills === true,
  };
}

/** The catalog the service remembers for a runtime. A runtime that flags no
 *  default of its own gets the model it last ran with nothing chosen marked
 *  as one, so the composer names it the same way. */
function markedDefault(model: AgentModel): AgentModel {
  return { ...model, isDefault: true };
}

function toRememberedModels(remembered: AgentWire['catalog']): readonly AgentModel[] {
  if (!remembered) return [];
  const models = remembered.models.map(toModel);
  const flagged = models.some((model) => model.isDefault === true);
  if (flagged || remembered.defaultModel === undefined) return models;
  return models.map((model) =>
    model.id === remembered.defaultModel ? markedDefault(model) : model,
  );
}

function toAgent(wire: AgentWire): Agent {
  return {
    id: wire.id,
    abilities: toAbilities(wire.capabilities),
    label: wire.label,
    models: toRememberedModels(wire.catalog),
    needsSignIn: wire.bootstrap?.failure?.code === 'authentication-required',
    preparing: ['installing', 'authenticating', 'configuring'].includes(
      wire.bootstrap?.phase ?? '',
    ),
    ...(wire.bootstrap?.failure
      ? {
          setupFailure: {
            stage: wire.bootstrap.failure.stage,
            message: wire.bootstrap.failure.message,
          },
        }
      : {}),
    ready: wire.bootstrap?.phase === 'ready' && wire.state !== 'failed',
    updatable: wire.updatable === true,
    ...(wire.upgrade ? { upgrade: wire.upgrade } : {}),
  };
}

function toCatalog(wire: AgentsResponseWire): AgentCatalog {
  return { agents: wire.clis.map(toAgent) };
}

function catalogRequest(
  path: string,
  signal: AbortSignal,
  method: 'GET' | 'POST',
): TransportRequest {
  return {
    error: AgentSessionError,
    failureSchema: agentRuntimeFailureSchema,
    messages: {
      'invalid-response': 'The Agent service returned an unexpected response.',
      'scope-lost': 'Agent runtimes are unavailable.',
      unauthorized: 'Agent runtimes are unavailable.',
      unavailable: 'StashBase could not reach the Agent service.',
    },
    method,
    path,
    signal,
  };
}

async function catalog(
  client: HttpClient,
  path: string,
  signal: AbortSignal,
  method: 'GET' | 'POST',
): Promise<AgentCatalog> {
  return toCatalog(
    await request(client, {
      ...catalogRequest(path, signal, method),
      schema: agentsResponseSchema,
    }),
  );
}

export function createAgentCatalogAdapter(client: HttpClient): AgentCatalogPort {
  return {
    listAgents(signal) {
      return catalog(client, '/api/terminal/clis', signal, 'GET');
    },
    prepareAgent(id, action, signal) {
      return catalog(client, `/api/terminal/clis/${id}/${action}`, signal, 'POST');
    },
  };
}

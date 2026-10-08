/**
 * The reader's persona library.
 *
 * Which persona a Chat runs under never crosses here: it travels with the
 * Chat's own connection, and the service composes the prompt a session
 * actually carries.
 */
import {
  AgentSessionError,
  type AgentPersona,
  type AgentPersonaInput,
  type AgentPersonaPort,
} from '@/features/agent/application/ports';
import { request, type TransportRequest } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  agentPersonaInputSchema,
  agentPersonaListSchema,
  agentPersonaRemovedSchema,
  agentPersonaSchema,
  type AgentPersonaInputWire,
  type AgentPersonaWire,
} from '@/protocols/http/agent-persona';
import { agentRuntimeFailureSchema } from '@/protocols/http/agent-runtime';

const PATH = '/api/agent-personas';

/** Both directions are typed, so the wire's icons and the renderer's icons
 *  cannot drift apart without this file failing to compile. */
function toPersona(wire: AgentPersonaWire): AgentPersona {
  return { ...wire };
}

function toInput(input: AgentPersonaInput): AgentPersonaInputWire {
  return agentPersonaInputSchema.parse({
    ...input,
    gallery: input.gallery ?? null,
  } satisfies AgentPersonaInputWire);
}

function personaRequest(
  path: string,
  signal: AbortSignal,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
): TransportRequest {
  return {
    error: AgentSessionError,
    failureSchema: agentRuntimeFailureSchema,
    messages: {
      'invalid-response': 'The persona service returned an unexpected response.',
      unauthorized: 'Personas are unavailable.',
      unavailable: 'StashBase could not reach the Agent service.',
    },
    method,
    path,
    serverMessage: true,
    signal,
  };
}

const itemPath = (id: string) => `${PATH}/${encodeURIComponent(id)}`;

export function createAgentPersonaAdapter(client: HttpClient): AgentPersonaPort {
  return {
    async list(signal) {
      return (
        await request(client, {
          ...personaRequest(PATH, signal, 'GET'),
          schema: agentPersonaListSchema,
        })
      ).map(toPersona);
    },
    async create(input, signal) {
      return toPersona(
        await request(client, {
          ...personaRequest(PATH, signal, 'POST'),
          body: toInput(input),
          schema: agentPersonaSchema,
        }),
      );
    },
    async update(id, input, signal) {
      return toPersona(
        await request(client, {
          ...personaRequest(itemPath(id), signal, 'PUT'),
          body: toInput(input),
          schema: agentPersonaSchema,
        }),
      );
    },
    async remove(id, signal) {
      await request(client, {
        ...personaRequest(itemPath(id), signal, 'DELETE'),
        schema: agentPersonaRemovedSchema,
      });
    },
  };
}

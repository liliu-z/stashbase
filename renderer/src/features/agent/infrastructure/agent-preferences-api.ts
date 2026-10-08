import { AgentSessionError, type AgentPreferencesPort } from '@/features/agent/application/ports';
import { agentScopeKey } from '@/features/agent/domain/session';
import { request } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  agentPreferencesSchema,
  projectAgentPreferenceSchema,
} from '@/protocols/http/agent-preferences';

const options = (signal: AbortSignal) => ({
  error: AgentSessionError,
  messages: {
    unavailable: 'Could not read or save your project’s Agent choice.',
    'invalid-response': 'The Agent preference response was invalid.',
  },
  path: '/api/agent-preferences',
  signal,
});

export function createAgentPreferencesAdapter(client: HttpClient): AgentPreferencesPort {
  return {
    load: (signal) => request(client, { ...options(signal), schema: agentPreferencesSchema }),
    async save(scope, agent, signal, change = {}) {
      await request(client, {
        ...options(signal),
        method: 'PUT',
        body: {
          scope: agentScopeKey(scope),
          agent,
          ...(change.effort === undefined ? {} : { effort: change.effort }),
          ...(change.persona === undefined ? {} : { persona: change.persona }),
        },
        schema: projectAgentPreferenceSchema,
      });
    },
  };
}

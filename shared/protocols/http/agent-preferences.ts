import { z } from 'zod';
import { agentIdSchema } from './agent-runtime';
import { agentPersonaIdSchema } from './agent-persona';

const effortSchema = z.string().min(1).max(64).nullable();
export const projectAgentPreferenceUpdateSchema = z.object({
  scope: z.string().min(1).max(4096),
  agent: agentIdSchema,
  effort: effortSchema.optional(),
  /** Choosing a persona in a Chat makes it the project's choice for new
   *  Chats; null starts them with none. */
  persona: agentPersonaIdSchema.nullable().optional(),
});
export const projectAgentPreferenceSchema = z.object({
  scope: z.string().min(1).max(4096),
  agent: agentIdSchema,
  efforts: z.object({
    stashbase: effortSchema.optional(),
    codex: effortSchema.optional(),
    claude: effortSchema.optional(),
  }).optional(),
  persona: agentPersonaIdSchema.nullable().optional(),
});
export const agentPreferencesSchema = z.array(projectAgentPreferenceSchema);

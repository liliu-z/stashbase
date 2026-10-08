import { z } from 'zod';

import {
  AGENT_PERSONA_ICONS,
  AGENT_PERSONA_ID_PATTERN,
  MAX_AGENT_PERSONA_DESCRIPTION_LENGTH,
  MAX_AGENT_PERSONA_LENGTH,
  MAX_AGENT_PERSONA_NAME_LENGTH,
} from '../../agent-persona';

export const agentPersonaIdSchema = z.string().regex(AGENT_PERSONA_ID_PATTERN);

/** One persona in the reader's library, as the service answers it. */
export const agentPersonaSchema = z
  .object({
    id: agentPersonaIdSchema,
    name: z.string().min(1).max(MAX_AGENT_PERSONA_NAME_LENGTH),
    description: z.string().max(MAX_AGENT_PERSONA_DESCRIPTION_LENGTH),
    icon: z.enum(AGENT_PERSONA_ICONS),
    prompt: z.string().min(1).max(MAX_AGENT_PERSONA_LENGTH),
    gallery: agentPersonaIdSchema.nullable(),
  })
  .strip();

export const agentPersonaListSchema = z.array(agentPersonaSchema).max(10_000);

/** What a create or an edit sends. The service owns trimming and the
 *  readable limits; this only refuses a shape it could never accept. */
export const agentPersonaInputSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    icon: z.enum(AGENT_PERSONA_ICONS),
    prompt: z.string(),
    gallery: agentPersonaIdSchema.nullable().optional(),
  })
  .strict();

/** A delete answers with an empty object. */
export const agentPersonaRemovedSchema = z.object({}).strip();

export type AgentPersonaWire = z.infer<typeof agentPersonaSchema>;
export type AgentPersonaInputWire = z.infer<typeof agentPersonaInputSchema>;

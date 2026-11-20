import { z } from 'zod';
import { agentIdSchema } from './agent-runtime';

const effortSchema = z.string().min(1).max(64).nullable();
const modelSchema = z.string().min(1).max(200).nullable();
const modelsSchema = z.object({
  stashbase: modelSchema.optional(),
  codex: modelSchema.optional(),
  claude: modelSchema.optional(),
  antigravity: modelSchema.optional(),
});
const effortsSchema = z.object({
  stashbase: effortSchema.optional(),
  codex: effortSchema.optional(),
  claude: effortSchema.optional(),
  antigravity: effortSchema.optional(),
});
export const projectAgentPreferenceUpdateSchema = z.object({
  scope: z.string().min(1).max(4096),
  agent: agentIdSchema,
  effort: effortSchema.optional(),
  model: modelSchema.optional(),
});
export const projectAgentPreferenceSchema = z.object({
  scope: z.string().min(1).max(4096),
  agent: agentIdSchema,
  models: modelsSchema.optional(),
  efforts: effortsSchema.optional(),
});
export const agentPreferencesSchema = z.object({
  defaultAgent: agentIdSchema,
  defaultModels: modelsSchema.optional(),
  defaultEfforts: effortsSchema.optional(),
  projects: z.array(projectAgentPreferenceSchema),
});

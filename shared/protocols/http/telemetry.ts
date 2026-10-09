import { z } from 'zod';

const runtime = z.enum(['stashbase', 'claude', 'codex']);
const outcome = z.enum(['success', 'failed', 'cancelled', 'blocked']);
const diagnostic = z.object({
  message: z.string().max(1_000),
  name: z.string().max(80).optional(),
  code: z.string().max(80).optional(),
  stack: z.string().max(2_000).optional(),
  http_status: z.number().int().min(400).max(599).optional(),
  exit_code: z.number().int().optional(),
}).strict();
export type ErrorDiagnostic = z.infer<typeof diagnostic>;
export interface ErrorContext {
  source: 'server' | 'renderer' | 'agent';
  operation: string;
  runtime?: z.infer<typeof runtime>;
}

/** Strict field allowlist. The Node collection owner additionally redacts every
 * diagnostic; schema validation alone is not a privacy boundary. */
export const telemetryEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('app_opened') }).strict(),
  z.object({ event: z.literal('app_active'), mode: z.enum(['welcome', 'documents', 'chat']) }).strict(),
  z.object({ event: z.literal('document_engaged'), activity: z.enum(['read', 'edit']),
    format: z.enum(['md', 'txt', 'json', 'html', 'pdf', 'docx', 'image', 'audio', 'generic']) }).strict(),
  z.object({ event: z.literal('account_login_started') }).strict(),
  z.object({ event: z.literal('account_login_result'), outcome }).strict(),
  z.object({ event: z.literal('account_signed_out') }).strict(),
  z.object({ event: z.literal('billing_checkout_result'), outcome: z.enum(['success', 'failed']) }).strict(),
  z.object({ event: z.literal('billing_portal_result'), outcome: z.enum(['success', 'failed']) }).strict(),
  z.object({ event: z.literal('subscription_observed'), plan: z.enum(['free', 'plus', 'pro', 'other']),
    paid: z.boolean(), cancel_at_period_end: z.boolean() }).strict(),
  z.object({ event: z.literal('project_entry_result'), outcome }).strict(),
  z.object({ event: z.literal('agent_turn_started'), runtime, turn_id: z.string().uuid().optional() }).strict(),
  z.object({
    event: z.literal('agent_turn_finished'), runtime, outcome, turn_id: z.string().uuid().optional(),
    duration: z.enum(['under_10s', '10s_to_60s', '1m_to_5m', 'over_5m']),
  }).strict(),
  z.object({ event: z.literal('document_write_result'), outcome: z.enum(['success', 'failed', 'conflict']), changed: z.boolean().optional() }).strict(),
  z.object({ event: z.literal('agent_setup_result'), runtime,
    stage: z.enum(['prepare', 'login', 'update', 'connect']), outcome,
    failure_stage: z.enum(['discovery', 'installation', 'authentication', 'mcp']).optional(),
    diagnostic: diagnostic.optional(),
  }).strict(),
  z.object({ event: z.literal('application_error'),
    source: z.enum(['server', 'renderer', 'agent']), operation: z.string().max(100),
    runtime: runtime.optional(), diagnostic,
  }).strict(),
]);
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
/** Authentication, billing and persisted writes are host facts. Renderers
 * cannot manufacture identity links or account/conversion outcomes. */
export const rendererTelemetryEventSchema = telemetryEventSchema.refine((value) =>
  ['app_opened', 'app_active', 'document_engaged', 'agent_turn_started', 'agent_turn_finished'].includes(value.event));
export const telemetryPreferencesSchema = z.object({
  enabled: z.boolean(), available: z.boolean(),
}).strip();
export const telemetryPreferencesRequestSchema = z.object({
  enabled: z.boolean(),
}).strict();
export const telemetryFailureSchema = z.object({ error: z.string() }).passthrough();

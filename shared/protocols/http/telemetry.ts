import { z } from 'zod';
import { rendererDeliverySchema } from '../telemetry-delivery';
export { countDelivery, type RendererDelivery } from '../telemetry-delivery';

const runtime = z.enum(['stashbase', 'claude', 'codex', 'antigravity']);
export const agentStopReasonSchema = z.enum(['session_closed', 'window_closed', 'scope_removed', 'app_shutdown',
  'spare_expired', 'spare_replaced', 'spare_discarded', 'startup_failed', 'configuration_changed', 'process_exit', 'interrupted']);
export type AgentStopReason = z.infer<typeof agentStopReasonSchema>;
export const processTerminationSchema = z.object({
  method: z.enum(['signals', 'taskkill']),
  escalated: z.boolean().optional(),
  taskkill_state: z.enum(['pending', 'finished', 'spawn_failed']).optional(),
  taskkill_exit_code: z.number().int().optional(),
  taskkill_signal: z.string().max(80).optional(),
  taskkill_error: diagnostic.optional(),
  taskkill_stderr: z.string().max(8000).optional(),
  fallback_attempted: z.boolean().optional(),
  fallback_sent: z.boolean().optional(),
  fallback_error: diagnostic.optional(),
}).strict();
export const agentTurnStageSchema = z.enum(['preparing', 'host_accepted', 'runtime_dispatched', 'model_request_started', 'response_started', 'waiting_permission', 'tool_running']);
export const agentTurnReasonSchema = z.enum(['completed', 'runtime_error', 'user_cancelled', 'context_invalid', 'connection_lost', 'session_closed', 'scope_removed', 'app_shutdown', 'host_shutdown', 'app_update', 'host_restarted']);
export type AgentTurnStage = z.infer<typeof agentTurnStageSchema>;
export const AGENT_TOOL_RESULT_LIMIT = 1000;
export const agentToolCategorySchema = z.enum(['read', 'write', 'shell', 'search', 'agent', 'other']);
export const agentToolResultSchema = z.object({
  call_id: z.string().min(1).max(512), category: agentToolCategorySchema,
  outcome: z.enum(['success', 'failed']),
}).strict();
export type AgentToolResult = z.infer<typeof agentToolResultSchema>;
const toolCounts = z.object({
  success: z.number().int().min(0).max(AGENT_TOOL_RESULT_LIMIT),
  failed: z.number().int().min(0).max(AGENT_TOOL_RESULT_LIMIT),
}).strict();
/** Runtime tool outcomes, not file changes or proof that the user's goal was met.
 * Counts stop at the bounded call-ID limit instead of recounting forgotten IDs. */
export const agentToolSummarySchema = toolCounts.extend({
  by_category: z.object({ read: toolCounts.optional(), write: toolCounts.optional(),
    shell: toolCounts.optional(), search: toolCounts.optional(), agent: toolCounts.optional(), other: toolCounts.optional() }).strict(),
  limited: z.boolean(),
}).strict();
export type AgentToolSummary = z.infer<typeof agentToolSummarySchema>;
const outcome = z.enum(['success', 'failed', 'cancelled', 'blocked']);
export { errorDiagnostic } from '../diagnostics';
export type { ErrorDiagnostic } from '../diagnostics';
import { diagnosticText, diagnosticSchema as diagnostic } from '../diagnostics';
/** Occurrences since this installation last reported the same diagnostic,
 * including this one. Absent from envelopes queued by older builds. */
const occurrences = z.number().int().min(1).max(1_000_000).optional();
export const diagnosticContextSchema = z.object({
  operation_id: z.string().uuid().optional(), diagnostic_id: z.string().uuid().optional(),
  diagnostic_correlation: z.enum(['linked', 'unavailable']).optional(),
  window_id: z.string().uuid().optional(), host_instance_id: z.string().uuid().optional(),
  app_session_id: z.string().uuid().optional(), pid: z.number().int().positive().optional(),
  web_contents_id: z.number().int().positive().optional(),
  socket_error_code: z.string().max(160).optional(), socket_error_errno: z.number().int().optional(),
  method: z.string().max(16).optional(), route: z.string().max(500).optional(),
  action: z.string().max(200).optional(), stage: z.string().max(100).optional(),
  model: z.string().max(200).optional(), runtime_version: z.string().max(100).optional(),
  turn_id: z.string().uuid().optional(),
  call_id: z.string().uuid().optional(), call_attempt: z.number().int().positive().optional(),
  tool_call_id: z.string().max(512).optional(), tool_category: agentToolCategorySchema.optional(),
  tool_failure_kind: z.enum(['not_found', 'permission_denied', 'invalid_arguments', 'timeout', 'path_rejected', 'edit_mismatch', 'edit_ambiguous', 'version_conflict', 'unsupported_file', 'unknown']).optional(),
  close_code: z.number().int().min(0).max(65535).optional(), was_clean: z.boolean().optional(),
  close_initiator: z.enum(['client', 'server', 'unknown']).optional(),
  close_reason: z.enum(['client_close', 'socket_closed', 'socket_error', 'process_exit', 'session_disposed', 'scope_removed', 'rpc_timeout']).optional(),
  process_start_id: z.string().uuid().optional(), process_generation: z.number().int().positive().optional(),
  pending_rpc_methods: z.array(z.string().max(100)).max(20).optional(),
  probe_count: z.number().int().nonnegative().optional(), probe_duration_ms: z.number().nonnegative().optional(),
  probe_result: z.enum(['ready', 'connection_refused', 'connect_timeout', 'response_timeout', 'transport_error', 'http_error', 'invalid_json', 'identity_mismatch', 'not_ready']).optional(),
  probe_http_status: z.number().int().min(100).max(599).optional(),
  probe_mismatch: z.enum(['app', 'ok', 'protocolVersion', 'appRoot', 'resourcesPath', 'instanceId']).optional(),
  connection_id: z.string().uuid().optional(), native_session_id: z.string().max(512).optional(),
  attempt_id: z.string().uuid().optional(), retry_of: z.string().uuid().optional(),
  target_version: z.string().max(100).optional(), process: z.string().max(100).optional(),
  reason: z.string().max(500).optional(), elapsed_ms: z.number().nonnegative().optional(),
  occurred_at: z.string().datetime().optional(), app_version: z.string().max(100).optional(),
}).strict();
export type DiagnosticContext = z.infer<typeof diagnosticContextSchema>;
/** Bound known diagnostic strings before validation; unknown fields still fail. */
export function boundedDiagnosticContext(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const limits: Record<string, number> = { method: 16, route: 500, action: 200, stage: 100,
    socket_error_code: 160, model: 200, runtime_version: 100, tool_call_id: 512, native_session_id: 512, target_version: 100, process: 100, reason: 500, app_version: 100 };
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
    typeof value === 'string' && limits[key] ? diagnosticText(value, limits[key])
      : key === 'pending_rpc_methods' && Array.isArray(value)
        ? value.slice(0, 20).map(method => typeof method === 'string' ? diagnosticText(method, 100) : method) : value]));
}

const correlation = { request_id: z.string().uuid().optional(), context: diagnosticContextSchema.optional() };
const diagnosticFields = {
  source: z.enum(['server', 'renderer', 'agent', 'native']), operation: z.string().max(200),
  runtime: runtime.optional(), diagnostic, occurrences,
  turn_id: z.string().uuid().optional(), request_id: z.string().uuid().optional(),
  context: diagnosticContextSchema.optional(),
};
export interface ErrorContext {
  source: 'server' | 'renderer' | 'agent' | 'native';
  turn_id?: string | undefined;
  request_id?: string | undefined;
  context?: DiagnosticContext | undefined;
  operation: string;
  runtime?: z.infer<typeof runtime>;
}

/** Strict field allowlist. The Node collection owner additionally redacts every
 * diagnostic; schema validation alone is not a privacy boundary. */
export const telemetryEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('app_opened') }).strict(),
  z.object({ event: z.literal('app_active'), mode: z.enum(['welcome', 'documents', 'chat']) }).strict(),
  z.object({ event: z.literal('document_engaged'), activity: z.enum(['read', 'edit']),
    format: z.enum(['md', 'txt', 'json', 'csv', 'html', 'pdf', 'docx', 'image', 'audio', 'generic']) }).strict(),
  z.object({ event: z.literal('account_login_started') }).strict(),
  z.object({ event: z.literal('account_login_result'), ...correlation, outcome }).strict(),
  z.object({ event: z.literal('account_signed_out') }).strict(),
  z.object({ event: z.literal('billing_checkout_result'), ...correlation, outcome: z.enum(['success', 'failed']) }).strict(),
  z.object({ event: z.literal('billing_portal_result'), ...correlation, outcome: z.enum(['success', 'failed']) }).strict(),
  z.object({ event: z.literal('subscription_observed'), plan: z.enum(['free', 'plus', 'pro', 'other']),
    paid: z.boolean(), cancel_at_period_end: z.boolean() }).strict(),
  z.object({ event: z.literal('project_entry_result'), ...correlation, outcome }).strict(),
  z.object({ event: z.literal('agent_turn_started'), runtime, turn_id: z.string().uuid().optional(),
    source: z.enum(['renderer', 'host']).optional() }).strict(),
  z.object({
    event: z.literal('agent_turn_finished'), runtime, outcome: z.enum(['success', 'failed', 'cancelled', 'blocked', 'interrupted']), turn_id: z.string().uuid().optional(),
    duration: z.enum(['under_10s', '10s_to_60s', '1m_to_5m', 'over_5m']).optional(),
    reason: agentTurnReasonSchema.optional(),
    source: z.enum(['renderer', 'host', 'recovery']).optional(),
    last_stage: agentTurnStageSchema.optional(), sequence: z.number().int().nonnegative().optional(),
    started_at: z.string().datetime().optional(), last_observed_at: z.string().datetime().optional(),
    finished_at: z.string().datetime().optional(), recovered_at: z.string().datetime().optional(),
    tool_summary: agentToolSummarySchema.optional(),
    context: diagnosticContextSchema.optional(),
  }).strict(),
  z.object({ event: z.literal('agent_turn_stage'), runtime, turn_id: z.string().uuid(),
    stage: agentTurnStageSchema, sequence: z.number().int().nonnegative(),
    context: diagnosticContextSchema.optional(),
  }).strict(),
  z.object({ event: z.literal('document_write_result'), ...correlation, outcome: z.enum(['success', 'failed', 'conflict']), changed: z.boolean().optional() }).strict(),
  z.object({ event: z.literal('project_file_operation'), ...correlation,
    operation_id: z.string().uuid().optional(), diagnostic_id: z.string().uuid().optional(),
    error_code: z.string().regex(/^[\w.:-]{1,100}$/).optional(), failed_stage: z.string().max(40).optional(),
    target_id: z.string().uuid().optional(), target_relation: z.enum(['first', 'same_target', 'changed_target', 'unavailable']).optional(),
    turn_id: z.string().uuid().optional(),
    operation: z.enum(['read', 'write', 'edit']), origin: z.enum(['agent', 'mcp', 'http']),
    runtime: runtime.optional(), outcome: z.enum(['success', 'failed', 'conflict']),
    changed: z.boolean().optional(),
  }).strict(),
  z.object({ event: z.literal('write_diagnostic_delivery'), diagnostic_id: z.string().uuid(),
    status: z.enum(['stored', 'failed', 'unavailable', 'uploaded', 'refused']), completeness: z.enum(['complete', 'partial']),
    occurrences: z.number().int().positive(),
  }).strict(),
  z.object({ event: z.literal('agent_setup_result'), runtime,
    stage: z.enum(['prepare', 'login', 'update', 'connect']), outcome,
    ...correlation,
    failure_stage: z.enum(['discovery', 'installation', 'authentication', 'mcp']).optional(),
    diagnostic: diagnostic.optional(),
  }).strict(),
  z.object({ event: z.literal('agent_connection_closed'), runtime, turn_id: z.string().uuid().optional(), ...correlation }).strict(),
  z.object({ event: z.literal('agent_runtime_start_result'), runtime, turn_id: z.string().uuid().optional(),
    purpose: z.enum(['history', 'chat', 'prewarm']), outcome: z.enum(['success', 'failed', 'cancelled']),
    stage: z.enum(['prepare', 'spawn', 'waiting_ready', 'ready', 'cleanup']),
    attempt_id: z.string().uuid(), retry_of: z.string().uuid().optional(),
    elapsed_ms: z.number().nonnegative(), first_output_ms: z.number().nonnegative().optional(),
    timings: z.object({
      prepare_ms: z.number().nonnegative().optional(), spawn_ms: z.number().nonnegative().optional(),
      ready_wait_ms: z.number().nonnegative().optional(), cleanup_ms: z.number().nonnegative().optional(),
    }).strict().optional(),
    diagnostic: diagnostic.optional(), ...correlation,
  }).strict(),
  z.object({ event: z.literal('agent_runtime_stop_result'), runtime,
    purpose: z.enum(['history', 'chat', 'prewarm', 'models']), reason: agentStopReasonSchema,
    attempt_id: z.string().uuid(), outcome: z.enum(['success', 'timeout', 'closed_after_timeout']),
    elapsed_ms: z.number().nonnegative(), deadline_ms: z.number().positive(),
    exit_observed: z.boolean(), pipes_closed: z.boolean(), process_tree_alive: z.boolean().optional(),
    exit_code: z.number().int().optional(), signal: z.string().max(80).optional(),
    termination: processTerminationSchema.optional(), diagnostic: diagnostic.optional(), ...correlation,
  }).strict(),
  z.object({ event: z.literal('agent_setup_stage'), runtime, attempt_id: z.string().uuid(), stage: z.enum(['discovery', 'installation', 'authentication', 'mcp']), outcome: z.enum(['started', 'success']), ...correlation }).strict(),
  z.object({ event: z.literal('application_error'), ...diagnosticFields }).strict(),
  z.object({ event: z.literal('application_warning'), ...diagnosticFields }).strict(),
  z.object({ event: z.literal('native_lifecycle'), operation: z.string().max(200), diagnostic, context: diagnosticContextSchema }).strict(),
  // A closed HTTP response does not establish failure: it may be a deliberate
  // cancellation. Keep transport observations outside user failure counts.
  z.object({ event: z.literal('http_request_lifecycle'), request_id: z.string().uuid(),
    state: z.enum(['pending', 'finished', 'closed']), elapsed_ms: z.number().nonnegative(),
    headers_sent: z.boolean(), http_status: z.number().int().min(100).max(599).optional(),
    context: diagnosticContextSchema,
  }).strict(),
]);
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
/** Authentication, billing and persisted writes are host facts. Renderers
 * cannot manufacture identity links or account/conversion outcomes. */
export const rendererTelemetryEventSchema = telemetryEventSchema.refine((value) =>
  ['app_opened', 'app_active', 'document_engaged', 'agent_turn_started', 'agent_turn_finished'].includes(value.event)
  && !('tool_summary' in value && value.tool_summary !== undefined)
  && (!('source' in value) || value.source === undefined || value.source === 'renderer'));
export const rendererTelemetryRequestSchema = z.object({
  id: z.string().uuid(), timestamp: z.string().datetime(), event: rendererTelemetryEventSchema,
  delivery: rendererDeliverySchema.optional(),
}).strict();
export type RendererTelemetryRequest = z.infer<typeof rendererTelemetryRequestSchema>;
export const telemetryReceiptSchema = z.object({
  status: z.enum(['accepted', 'duplicate', 'disabled', 'retry', 'discarded']),
  reset_delivery: z.boolean().optional(),
}).strict();
export type TelemetryReceiptStatus = z.infer<typeof telemetryReceiptSchema>['status'];
export const telemetryPreferencesSchema = z.object({
  enabled: z.boolean(), available: z.boolean(),
}).strip();
export const telemetryPreferencesRequestSchema = z.object({
  enabled: z.boolean(),
}).strict();
export const telemetryFailureSchema = z.object({ error: z.string() }).passthrough();

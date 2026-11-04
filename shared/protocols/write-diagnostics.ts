import { z } from 'zod';

/** Restricted attachment, deliberately separate from the analytics schema. */
export const WRITE_STAGES = ['validation', 'path_resolution', 'project_match', 'session_scope', 'read', 'edit_match', 'version_check', 'persist'] as const;
export type WriteStage = typeof WRITE_STAGES[number];
export type DiagnosticValue = string | number | boolean | null | DiagnosticValue[] | { [key: string]: DiagnosticValue };
const value: z.ZodType<DiagnosticValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(value), z.record(value)]));
export const writeFailureSchema = z.object({
  name: z.string(), code: z.string(), errno: z.union([z.number(), z.string()]).optional(),
  syscall: z.string().optional(), path: z.string().optional(), dest: z.string().optional(),
  stack: z.array(z.string()),
}).strict();
export const writeStepSchema = z.object({
  sequence: z.number().int(), stage: z.enum(WRITE_STAGES), action: z.string(),
  started_ms: z.number(), duration_ms: z.number(), result: z.enum(['success', 'failed', 'observed']),
  evidence: z.record(value), error: writeFailureSchema.optional(),
}).strict();
export const writeOperationSchema = z.object({
  operation_id: z.string().uuid(), diagnostic_id: z.string().uuid(),
  request_id: z.string().optional(), turn_id: z.string().optional(), tool_call_id: z.string().optional(),
  correlation: z.object({ request: z.enum(['linked', 'unavailable']), turn: z.enum(['linked', 'unavailable']), tool: z.enum(['linked', 'unavailable']) }).strict(),
  operation: z.enum(['write', 'edit']), origin: z.enum(['agent', 'http', 'mcp']), runtime: z.string().optional(),
  runtime_version: z.string().nullable(), app_version: z.string(), node_version: z.string(), os: z.string(), arch: z.string(),
  started_at: z.string().datetime(), finished_at: z.string().datetime(), duration_ms: z.number(),
  raw_path: z.string().nullable(), escaped_path: z.string().nullable(), raw_path_type: z.string(),
  session_root: z.string().nullable(), session_scope: z.enum(['bound', 'no_project', 'external']),
  target_id: z.string().uuid(), target_identity: z.string().nullable(),
  previous_operation_id: z.string().optional(), target_relation: z.enum(['first', 'same_target', 'changed_target', 'unavailable']),
  path_changed: z.boolean().optional(),
  outcome: z.enum(['success', 'failed']), changed: z.boolean().optional(), error: writeFailureSchema.optional(),
  failed_stage: z.enum(WRITE_STAGES).optional(), failed_action: z.string().optional(),
  stages: z.record(z.enum(WRITE_STAGES), z.enum(['not_reached', 'success', 'failed'])),
  steps: z.array(writeStepSchema).max(2048), completeness: z.enum(['complete', 'partial']), gaps: z.array(z.string()),
}).strict();
export type WriteOperationDiagnostic = z.infer<typeof writeOperationSchema>;
export type WriteFailure = z.infer<typeof writeFailureSchema>;
export const writeDiagnosticBundleSchema = z.object({
  schema_version: z.literal(1), diagnostic_id: z.string().uuid(),
  first_seen: z.string().datetime(), last_seen: z.string().datetime(), occurrences: z.number().int().positive(),
  expires_at: z.string().datetime(), operations: z.array(writeOperationSchema).max(100),
  completeness: z.enum(['complete', 'partial']), gaps: z.array(z.string()),
  delivery: z.object({ status: z.enum(['local_only', 'pending', 'uploaded', 'failed', 'unavailable']), attempts: z.number().int(), last_error: z.string().optional() }).strict(),
}).strict();
export type WriteDiagnosticBundle = z.infer<typeof writeDiagnosticBundleSchema>;

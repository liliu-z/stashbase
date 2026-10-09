import { z } from 'zod';

import { agentModelSchema } from '../agent-model';

export const agentIdSchema = z.enum(['stashbase', 'claude', 'codex']);

export const agentBootstrapPhaseSchema = z.enum([
  'idle',
  'installing',
  'authenticating',
  'configuring',
  'ready',
  'failed',
]);

export const agentBootstrapFailureStageSchema = z.enum([
  'discovery',
  'installation',
  'authentication',
  'mcp',
]);

export const agentBootstrapFailureCodeSchema = z.enum([
  'simulated',
  'operation-failed',
  'runtime-unavailable',
  'account-required',
  'authentication-required',
  'authentication-check-failed',
]);

export const agentBootstrapManualRecoverySchema = z.enum(['install-command', 'mcp-settings']);

export const agentBootstrapFailureSchema = z
  .object({
    stage: agentBootstrapFailureStageSchema,
    code: agentBootstrapFailureCodeSchema,
    message: z.string().max(2000),
    retryable: z.boolean(),
    manualRecovery: agentBootstrapManualRecoverySchema.optional(),
    retryAction: z.enum(['bootstrap', 'login', 'update']).optional(),
  })
  .strict();

export const agentBootstrapStatusSchema = z
  .object({
    phase: agentBootstrapPhaseSchema,
    progress: z.number().finite().optional(),
    message: z.string().max(2000).optional(),
    failure: agentBootstrapFailureSchema.optional(),
  })
  .strict();


export const agentSetupFailureSimulationSchema = z.enum([
  'none',
  'installation',
  'authentication',
  'mcp',
]);

export const agentTurnFailureSimulationSchema = z.enum([
  'none',
  'rate-limit',
  'quota',
  'auth-expired',
  'network',
  'crash',
]);

export const agentRuntimeDebugStateSchema = z
  .object({
    enabled: z.boolean(),
    nextFailure: agentSetupFailureSimulationSchema,
    nextTurnFailure: agentTurnFailureSimulationSchema,
  })
  .strict();

export const agentRuntimeDebugPatchRequestSchema = z
  .object({
    nextFailure: agentSetupFailureSimulationSchema.optional(),
    nextTurnFailure: agentTurnFailureSimulationSchema.optional(),
  })
  .strict();

export const agentSourceSchema = z.enum(['bundled', 'system']);

export const agentCapabilitiesSchema = z
  .object({
    connection: z.literal(true),
    prompts: z.literal(true),
    interrupt: z.literal(true),
    transcript: z.literal(true),
    approvals: z.literal(true),
    history: z.literal(true),
    attachments: z.boolean(),
    /** The permission promises the runtime can honor; empty hides the control. */
    modes: z.array(z.enum(['default', 'acceptEdits', 'plan', 'auto'])).max(8),
    effort: z.boolean(),
    models: z.boolean(),
    skills: z.boolean(),
    steering: z.boolean(),
    titleHint: z.boolean(),
  })
  .strict();

/** What the service remembers a runtime offering, so a fresh chat can name
 * the model and level it will run on before any session exists. */
export const agentModelCatalogSchema = z
  .object({
    models: z.array(agentModelSchema).max(256),
    /** The model the runtime last ran when nothing was chosen. */
    defaultModel: z.string().max(200).optional(),
    readAt: z.string().max(64),
  })
  .strict();

/** A model the runtime says it is too old to run, named and explained by the
 * runtime itself. An offer, never a requirement: absent is the normal state,
 * and a runtime that says nothing is absent too. */
export const agentUpgradeOfferSchema = z
  .object({
    model: z.string().min(1).max(200),
    note: z.string().min(1).max(500),
  })
  .strict();

export const agentSchema = z
  .object({
    id: agentIdSchema,
    label: z.string().min(1).max(200),
    vendor: z.string().min(1).max(200),
    installHint: z.string().max(2000),
    installed: z.boolean(),
    source: agentSourceSchema.nullable().optional(),
    version: z.string().max(64).nullable().optional(),
    updatable: z.boolean().optional(),
    upgrade: agentUpgradeOfferSchema.optional(),
    bootstrap: agentBootstrapStatusSchema.optional(),
    launchCommand: z.string().max(2000),
    endpoint: z.string().max(2000).optional(),
    state: z.enum(['available', 'unavailable', 'failed']).optional(),
    error: z.string().max(2000).optional(),
    capabilities: agentCapabilitiesSchema.optional(),
    catalog: agentModelCatalogSchema.optional(),
  })
  .strict();

export const agentsResponseSchema = z
  .object({
    clis: z.array(agentSchema).max(64),
    debug: agentRuntimeDebugStateSchema.optional(),
  })
  .strict();

export const hostedAgentAllowanceSchema = z
  .object({
    profile: z.string().min(1).max(200),
    remainingPercent: z.number().finite(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    windowStartedAt: z.string().nullable(),
    windowEndsAt: z.string().nullable(),
  })
  .strict();

/** `GET /api/account/billing/plans`: the hosted Stripe catalog. */
export const hostedBillingPlanSchema = z
  .object({
    priceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
    planKey: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    amount: z.number().int().nonnegative(),
    currency: z.string().min(3).max(3),
    interval: z.enum(['month', 'year']),
    available: z.boolean(),
  })
  .passthrough();

export const hostedBillingPlansSchema = z
  .object({ plans: z.array(hostedBillingPlanSchema).max(20) })
  .passthrough();

/** `GET /api/account/billing/status`: subscription rights the API confirmed. */
export const hostedBillingStatusSchema = z
  .object({
    plan: hostedBillingPlanSchema.nullable(),
    status: z.string().min(1).max(64),
    paidThrough: z.string().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    canManage: z.boolean(),
  })
  .passthrough();

export const hostedBillingCheckoutRequestSchema = z
  .object({ priceId: z.string().regex(/^price_[A-Za-z0-9]+$/) })
  .strict();

/** A Stripe-hosted Checkout or Customer Portal page. */
export const hostedBillingRedirectSchema = z
  .object({ url: z.string().url().max(4096) })
  .passthrough();

export const agentRuntimeFailureSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    error: z.string().trim().min(1).max(500),
  })
  .passthrough();

export type AgentBootstrapPhaseWire = z.infer<typeof agentBootstrapPhaseSchema>;
export type AgentBootstrapFailureWire = z.infer<typeof agentBootstrapFailureSchema>;
export type AgentBootstrapStatusWire = z.infer<typeof agentBootstrapStatusSchema>;
export type AgentRuntimeDebugStateWire = z.infer<typeof agentRuntimeDebugStateSchema>;
export type AgentRuntimeDebugPatchRequestWire = z.infer<typeof agentRuntimeDebugPatchRequestSchema>;
export type AgentUpgradeOfferWire = z.infer<typeof agentUpgradeOfferSchema>;
export type AgentWire = z.infer<typeof agentSchema>;
export type AgentsResponseWire = z.infer<typeof agentsResponseSchema>;
export type HostedAgentAllowanceWire = z.infer<typeof hostedAgentAllowanceSchema>;
export type HostedBillingPlanWire = z.infer<typeof hostedBillingPlanSchema>;
export type HostedBillingStatusWire = z.infer<typeof hostedBillingStatusSchema>;

/**
 * The hosted StashBase Agent's model profiles, as the StashBase API approves them.
 *
 * A profile is the hosted service's name for one configured model: the
 * service owns its upstream model, price, and reasoning level, and the client
 * only ever names it by `id` and the `version` it was shown. Sending that
 * version lets the service refuse a turn whose configuration changed after
 * the reader chose it, rather than silently billing a different model.
 */
import { z } from 'zod';
import type { AgentModel } from '../shared/agent-protocol.ts';
import { hostedAccessToken, stashbaseClientVersion, STASHBASE_API_URL } from './hosted-account.ts';

/** The profile an unversioned request runs on. Older chats recorded it, and a
 * runtime without a readable list keeps using it. */
export const DEFAULT_HOSTED_AGENT_PROFILE = 'stashbase-agent-default';

const hostedAgentProfileSchema = z.object({
  id: z.string().trim().min(1).max(100),
  version: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(200),
  contextTokenLimit: z.number().int().positive(),
  outputTokenLimit: z.number().int().positive(),
  isDefault: z.boolean(),
  // A cost the client cannot read leaves the row unflagged, not hidden.
  relativeCost: z.number().positive().max(10_000).optional().catch(undefined),
}).passthrough();

export interface HostedAgentProfile {
  id: string;
  version: number;
  displayName: string;
  contextTokenLimit: number;
  outputTokenLimit: number;
  isDefault: boolean;
  /** Price relative to the default profile (1), as the service ranks it. */
  relativeCost?: number;
}

export interface HostedAgentModelDependencies {
  accessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

const defaultDependencies: HostedAgentModelDependencies = {
  accessToken: hostedAccessToken,
  fetch: (input, init) => globalThis.fetch(input, init),
};

/** Entries this client cannot read are left out rather than failing the
 * whole list, so a later API field never hides the models it can run. */
export function parseHostedAgentProfiles(payload: unknown): HostedAgentProfile[] {
  const models = (payload as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new Error('The agent model list has an unexpected shape.');
  const profiles: HostedAgentProfile[] = [];
  for (const entry of models) {
    const parsed = hostedAgentProfileSchema.safeParse(entry);
    if (!parsed.success || profiles.some((profile) => profile.id === parsed.data.id)) continue;
    const { id, version, displayName, contextTokenLimit, outputTokenLimit, isDefault, relativeCost } = parsed.data;
    profiles.push({
      id, version, displayName, contextTokenLimit, outputTokenLimit, isDefault,
      ...(relativeCost === undefined ? {} : { relativeCost }),
    });
  }
  return profiles;
}

export async function fetchHostedAgentProfiles(
  dependencies: HostedAgentModelDependencies = defaultDependencies,
  forceRefresh = false,
): Promise<HostedAgentProfile[]> {
  const token = await dependencies.accessToken({ forceRefresh });
  const response = await dependencies.fetch(`${STASHBASE_API_URL}/v1/agent/models`, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${token}`,
      'x-stashbase-client-version': stashbaseClientVersion(),
    },
  });
  if (response.status === 401 && !forceRefresh) {
    await response.body?.cancel();
    return fetchHostedAgentProfiles(dependencies, true);
  }
  const payload = await response.json().catch(() => null) as { message?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof payload?.message === 'string' && payload.message
      ? payload.message
      : `The agent model list is unavailable (HTTP ${response.status}).`);
  }
  return parseHostedAgentProfiles(payload);
}

/** The profile a turn runs on when nothing was chosen: the one the service
 * flags, else the first it lists. */
export function defaultHostedAgentProfile(profiles: readonly HostedAgentProfile[]): HostedAgentProfile | undefined {
  return profiles.find((profile) => profile.isDefault) ?? profiles[0];
}

/** Providers state limits in both decimal (128,000) and binary (65,536)
 * units; each reads in the unit it was set in, as 128K and 64K. */
function tokenCount(value: number): string {
  const [kilo, mega] = value % 1_000 !== 0 && value % 1_024 === 0 ? [1_024, 1_048_576] : [1_000, 1_000_000];
  if (value >= mega) return `${Number((value / mega).toFixed(1))}M`;
  if (value >= kilo) return `${Math.round(value / kilo)}K`;
  return String(value);
}

/** Until every deployed service reports `relativeCost`, the approved premium
 * profiles carry the multiple their published prices give against the Gemini
 * default, so the picker locks them either way. A reported cost wins. */
const KNOWN_RELATIVE_COST: Readonly<Record<string, number>> = {
  'claude-opus-5-5': 5.3,
  'gpt-6-1-sol': 4.2,
  'claude-sonnet-5-5': 2.7,
};

/** The picker's view of a profile. Versions and limits stay on the host. */
export function hostedAgentCatalogModels(profiles: readonly HostedAgentProfile[]): AgentModel[] {
  return profiles.map((profile) => {
    const relativeCost = profile.relativeCost ?? KNOWN_RELATIVE_COST[profile.id];
    return {
      id: profile.id,
      label: profile.displayName,
      description: `${tokenCount(profile.contextTokenLimit)} context · ${tokenCount(profile.outputTokenLimit)} output`,
      ...(profile.isDefault ? { isDefault: true } : {}),
      ...(relativeCost === undefined ? {} : { relativeCost }),
    };
  });
}

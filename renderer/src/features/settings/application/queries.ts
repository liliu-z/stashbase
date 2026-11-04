/**
 * Settings query identities and shared request behavior live here.
 * Credits and billing refresh host-owned account state after authentication
 * refusal, coordinating readers without replaying commands or replacing a
 * newer sign-in with an old response.
 */
import type { QueryClient } from '@tanstack/react-query';

import type { EmbedderPort } from '@/features/settings/application/embedder-port';
import {
  AgentRuntimeError,
  type AccountPort,
  type AgentRuntimePort,
  type AppearancePort,
  type McpAccessPort,
  type SystemTextPort,
} from '@/features/settings/application/ports';
import type { HostedAccount } from '@/features/settings/domain/account';

export const settingsQueryKeys = {
  localComponent: ['settings', 'local-component'] as const,
  account: ['settings', 'account'] as const,
  agentAllowance: ['settings', 'agent-allowance'] as const,
  agentCatalog: ['settings', 'agent-catalog'] as const,
  billingPlans: ['settings', 'billing-plans'] as const,
  billingStatus: ['settings', 'billing-status'] as const,
  appearance: ['settings', 'appearance'] as const,
  embedder: ['settings', 'embedder'] as const,
  mcpAccess: ['settings', 'mcp-access'] as const,
  systemFonts: ['settings', 'system-fonts'] as const,
  spellcheckLanguages: ['settings', 'spellcheck-languages'] as const,
};

/** The installed fonts change only when fonts are installed, so one read
 *  serves the whole session. */
export function systemFontsQuery(port: SystemTextPort) {
  return {
    queryFn: () => port.listFonts(),
    queryKey: settingsQueryKeys.systemFonts,
    retry: false,
    staleTime: Infinity,
  } as const;
}

export function spellcheckLanguagesQuery(port: SystemTextPort) {
  return {
    queryFn: () => port.spellcheckLanguages(),
    queryKey: settingsQueryKeys.spellcheckLanguages,
    retry: false,
    staleTime: Infinity,
  } as const;
}

export function accountQuery(port: AccountPort) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => port.load(signal),
    queryKey: settingsQueryKeys.account,
    retry: false,
  } as const;
}

export function embedderQuery(port: EmbedderPort) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => port.load(signal),
    queryKey: settingsQueryKeys.embedder,
    retry: false,
  } as const;
}

export function agentCatalogQuery(port: AgentRuntimePort) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => port.listAgents(signal),
    queryKey: settingsQueryKeys.agentCatalog,
    retry: false,
  } as const;
}

export function agentAllowanceQuery(port: AgentRuntimePort) {
  return {
    queryFn: ({ client, signal }: { client: QueryClient; signal: AbortSignal }) =>
      accountRequest(client, signal, () => port.getAllowance(signal)),
    queryKey: settingsQueryKeys.agentAllowance,
    refetchInterval: 30_000,
    retry: false,
  } as const;
}

export function billingPlansQuery(port: AgentRuntimePort) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => port.getBillingPlans(signal),
    queryKey: settingsQueryKeys.billingPlans,
    retry: false,
    staleTime: 10 * 60_000,
  } as const;
}

export function billingStatusQuery(port: AgentRuntimePort) {
  return {
    queryFn: ({ client, signal }: { client: QueryClient; signal: AbortSignal }) =>
      accountRequest(client, signal, () => port.getBillingStatus(signal)),
    queryKey: settingsQueryKeys.billingStatus,
    retry: false,
  } as const;
}

const accountRecoveries = new WeakMap<
  QueryClient,
  { account: HostedAccount; pending: Promise<void> }
>();

function recoverAccount(client: QueryClient, account: HostedAccount): Promise<void> {
  const current = accountRecoveries.get(client);
  if (current?.account === account) return current.pending;
  // Replace a read that may have captured the session before the host retired
  // it. Concurrent authentication refusals share this fresh read.
  const pending = client
    .invalidateQueries({ queryKey: settingsQueryKeys.account, exact: true })
    .finally(() => {
      if (accountRecoveries.get(client)?.pending === pending) accountRecoveries.delete(client);
    });
  accountRecoveries.set(client, { account, pending });
  return pending;
}

/** Credits and billing can discover that the host retired a session. Re-read
 * its account rather than inferring sign-out from a failed request. A refusal
 * from an older account cannot disturb a newer sign-in, and no work is replayed. */
export async function accountRequest<T>(
  client: QueryClient,
  signal: AbortSignal,
  request: () => Promise<T>,
): Promise<T> {
  const account = client.getQueryData<HostedAccount>(settingsQueryKeys.account);
  try {
    return await request();
  } catch (error) {
    if (
      !signal.aborted &&
      error instanceof AgentRuntimeError &&
      error.kind === 'unauthorized' &&
      account?.signedIn &&
      client.getQueryData(settingsQueryKeys.account) === account
    ) {
      await recoverAccount(client, account);
      const refreshed = client.getQueryData<HostedAccount>(settingsQueryKeys.account);
      if (
        !signal.aborted &&
        refreshed &&
        (refreshed.signedIn !== account.signedIn || refreshed.email !== account.email)
      ) {
        void client.invalidateQueries(
          { queryKey: settingsQueryKeys.agentCatalog },
          { cancelRefetch: false },
        );
      }
    }
    throw error;
  }
}

export function mcpAccessQuery(port: McpAccessPort) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => port.status(signal),
    queryKey: settingsQueryKeys.mcpAccess,
    retry: false,
  } as const;
}

/** This window's saves write the cache, so a mounted reading menu never needs
 *  to refetch. Returning to the window catches a change made in another one. */
export function appearanceQuery(port: AppearancePort) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => port.load(signal),
    queryKey: settingsQueryKeys.appearance,
    refetchOnWindowFocus: 'always',
    retry: false,
    staleTime: Infinity,
  } as const;
}

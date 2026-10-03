import type { EmbedderPort } from '@/features/settings/application/embedder-port';
import type {
  AccountPort,
  AgentRuntimePort,
  AppearancePort,
  McpAccessPort,
  SystemTextPort,
} from '@/features/settings/application/ports';

export const settingsQueryKeys = {
  localComponent: ['settings', 'local-component'] as const,
  account: ['settings', 'account'] as const,
  agentAllowance: ['settings', 'agent-allowance'] as const,
  agentCatalog: ['settings', 'agent-catalog'] as const,
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
    queryFn: ({ signal }: { signal: AbortSignal }) => port.getAllowance(signal),
    queryKey: settingsQueryKeys.agentAllowance,
    retry: false,
  } as const;
}

export function mcpAccessQuery(port: McpAccessPort) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => port.status(signal),
    queryKey: settingsQueryKeys.mcpAccess,
    retry: false,
  } as const;
}

export function appearanceQuery(port: AppearancePort) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => port.load(signal),
    queryKey: settingsQueryKeys.appearance,
    retry: false,
  } as const;
}

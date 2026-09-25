export {
  type AccountPort,
  type LocalComponentPort,
  type AgentRuntimePort,
  type AppearancePort,
  type McpAccessPort,
} from './application/ports';
export { type EmbedderPort } from './application/embedder-port';
export { createAccountAdapter } from './infrastructure/account-api';
export { createAgentRuntimeAdapter } from './infrastructure/agent-runtime-api';
export { createMcpAccessAdapter } from './infrastructure/mcp-access-api';
export { createEmbedderAdapter } from './infrastructure/embedder-api';
export { createAppearanceAdapter } from './infrastructure/appearance-api';
export { appearanceSurface } from './domain/appearance';
export { useSearchKeyConfigured } from './hooks/use-embedder';
export { AccountProvider, useAccountView } from './hooks/account-context';
export { SidebarAccountRow } from './ui/account/sidebar-account-row';
export { DeveloperTools, Settings } from './ui/settings';
export type { SettingsSectionId, SettingsTarget } from './ui/settings-types';
export { createLocalComponentAdapter } from './infrastructure/local-component-api';

export type { TelemetryPort } from './application/telemetry-port';
export { createTelemetryAdapter } from './infrastructure/telemetry-api';
export { LocalComponentRecovery } from './ui/general/local-component-recovery';
export { ReadingTextMenu } from './ui/appearance/reading-text-menu';

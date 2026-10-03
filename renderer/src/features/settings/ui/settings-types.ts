import type { ReactNode } from 'react';

import type { EmbedderPort } from '@/features/settings/application/embedder-port';
import type {
  AgentRuntimePort,
  AppearancePort,
  McpAccessPort,
  SystemTextPort,
} from '@/features/settings/application/ports';
import type { TelemetryPort } from '@/features/settings/application/telemetry-port';
import type { SoftwareUpdateRow } from '@/shared/domain/software-update';

/** Every section the Settings shell registers, in nav order. A section id
 *  that is not one of these cannot be registered — the mistake fails to
 *  typecheck instead of quietly rendering an empty pane. */
const SETTINGS_SECTION_IDS = ['general', 'agents', 'advanced'] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export type SettingsTarget = SettingsSectionId | 'search' | 'mcp';

export interface SettingsProps {
  /** Optional app-composed development surfaces; absent in production. */
  revisionPreview?: ReactNode;
  telemetryApi?: TelemetryPort;
  agentRuntimeApi: AgentRuntimePort;
  appearanceApi?: AppearancePort;
  systemTextApi?: SystemTextPort;
  embedderApi?: EmbedderPort;
  mcpAccessApi?: McpAccessPort;
  onClose: () => void;
  onOpenExternal?: (href: string) => void;
  onSectionChange: (id: SettingsSectionId) => void;
  open: boolean;
  /** The section the app asked for. */
  section: SettingsTarget;
  /** How this build keeps itself current, filled in by whoever owns updating.
   *  Null or absent where the build has no updater, and then General says
   *  nothing about updates at all. */
  softwareUpdate?: SoftwareUpdateRow | null;
}

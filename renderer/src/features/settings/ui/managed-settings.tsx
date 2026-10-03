import { Bot, Settings as SettingsIcon, SlidersHorizontal } from 'lucide-react';

import { AdvancedPanel } from './advanced-panel';
import { AgentRuntimesPanel } from './agents/agents-panel';
import { GeneralPanel } from './general/general-panel';
import type { SettingsProps } from './settings-types';
import { SettingsShell, type SettingsSectionDef } from './shell';

export default function ManagedSettings({
  agentRuntimeApi,
  appearanceApi,
  embedderApi,
  mcpAccessApi,
  onClose,
  onOpenExternal,
  onSectionChange,
  open,
  revisionPreview,
  section,
  softwareUpdate = null,
  systemTextApi,
  telemetryApi,
}: SettingsProps) {
  const sections: SettingsSectionDef[] = [
    {
      available: true,
      icon: SettingsIcon,
      id: 'general',
      label: 'General',
      render: () => (
        <GeneralPanel
          appearanceApi={appearanceApi}
          systemTextApi={systemTextApi}
          telemetryApi={telemetryApi}
          onOpenExternal={onOpenExternal}
          revisionPreview={revisionPreview}
          softwareUpdate={softwareUpdate}
        />
      ),
    },
    {
      available: true,
      icon: Bot,
      id: 'agents',
      label: 'Agents',
      render: () => <AgentRuntimesPanel agentRuntimeApi={agentRuntimeApi} />,
    },
    {
      available: true,
      icon: SlidersHorizontal,
      id: 'advanced',
      label: 'Advanced',
      render: () => (
        <AdvancedPanel
          key={section}
          initialPage={section === 'search' || section === 'mcp' ? section : null}
          embedderApi={embedderApi}
          mcpAccessApi={mcpAccessApi}
        />
      ),
    },
  ];
  return (
    <SettingsShell
      onClose={onClose}
      onSectionChange={onSectionChange}
      open={open}
      section={section === 'search' || section === 'mcp' ? 'advanced' : section}
      sections={sections}
    />
  );
}

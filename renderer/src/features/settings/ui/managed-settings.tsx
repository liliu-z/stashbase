import {
  Bell,
  Bot,
  Palette,
  Type,
  UserRound,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from 'lucide-react';

import { AccountPanel } from './account/account-panel';
import { AdvancedPanel } from './advanced-panel';
import { AgentRuntimesPanel } from './agents/agents-panel';
import { AppearancePanel } from './appearance/appearance-panel';
import { EditorPanel } from './appearance/editor-panel';
import { GeneralPanel } from './general/general-panel';
import { NotificationsGroup } from './general/notifications-group';
import { SettingsPane } from './rows';
import type { SettingsProps } from './settings-types';
import { SettingsShell, type SettingsSectionDef } from './shell';

export default function ManagedSettings({
  notifications,
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
  voiceModelApi,
}: SettingsProps) {
  const sections: SettingsSectionDef[] = [
    {
      available: true,
      icon: UserRound,
      id: 'account',
      label: 'Account',
      render: () => <AccountPanel agentRuntimeApi={agentRuntimeApi} />,
    },
    appearanceApi
      ? {
          available: true,
          icon: Palette,
          id: 'appearance',
          label: 'Appearance',
          render: () => <AppearancePanel appearanceApi={appearanceApi} />,
        }
      : { available: false, icon: Palette, id: 'appearance', label: 'Appearance' },
    appearanceApi
      ? {
          available: true,
          icon: Type,
          id: 'editor',
          label: 'Editor',
          render: () => <EditorPanel appearanceApi={appearanceApi} systemTextApi={systemTextApi} />,
        }
      : { available: false, icon: Type, id: 'editor', label: 'Editor' },
    {
      available: true,
      icon: Bot,
      id: 'agents',
      label: 'Agents',
      render: () => (
        <AgentRuntimesPanel
          agentRuntimeApi={agentRuntimeApi}
          onOpenAccount={() => onSectionChange('account')}
        />
      ),
    },
    notifications
      ? {
          available: true,
          icon: Bell,
          id: 'notifications',
          label: 'Notifications',
          render: () => (
            <SettingsPane title="Notifications">
              <NotificationsGroup port={notifications} />
            </SettingsPane>
          ),
        }
      : { available: false, icon: Bell, id: 'notifications', label: 'Notifications' },
    {
      available: true,
      icon: SettingsIcon,
      id: 'general',
      label: 'General',
      render: () => (
        <GeneralPanel
          voiceModelApi={voiceModelApi}
          telemetryApi={telemetryApi}
          onOpenExternal={onOpenExternal}
          softwareUpdate={softwareUpdate}
        />
      ),
    },
    {
      available: true,
      icon: SlidersHorizontal,
      id: 'advanced',
      label: 'Advanced',
      render: () => (
        <AdvancedPanel
          key={section}
          revisionPreview={revisionPreview}
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

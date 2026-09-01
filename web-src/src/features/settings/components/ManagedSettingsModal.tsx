import { useState, type ReactNode } from 'react';
import { CloseIcon } from '@/common/components/icons';
import type { SettingsSection } from '@/common/lib/settingsTrigger';
import type { SettingsModalProps } from '@/features/settings/components/SettingsModal';
import { AppearancePanel } from '@/features/settings/components/AppearancePanel';
import { AgentRuntimePanel } from '@/features/settings/components/AgentRuntimePanel';
import { EmbeddingPanel } from '@/features/settings/components/EmbeddingPanel';
import { GeneralPanel } from '@/features/settings/components/GeneralPanel';
import { McpAccessPanel } from '@/features/settings/components/McpAccessPanel';
import { TranscriptionPanel } from '@/features/settings/components/TranscriptionPanel';
import { Button } from '@/common/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/common/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/common/components/ui/tabs';

const SECTIONS: { id: SettingsSection; label: string; render: () => ReactNode }[] = [
  { id: 'general', label: 'General', render: () => <GeneralPanel /> },
  { id: 'appearance', label: 'Appearance', render: () => <AppearancePanel /> },
  { id: 'agents', label: 'Agents', render: () => <AgentRuntimePanel /> },
  { id: 'embedding', label: 'Similarity Search', render: () => <EmbeddingPanel /> },
  { id: 'transcription', label: 'Transcription', render: () => <TranscriptionPanel /> },
  { id: 'mcp', label: 'MCP', render: () => <McpAccessPanel /> },
];

export default function ManagedSettingsModal({
  initialSection,
  isTopmost,
  onClose,
}: SettingsModalProps) {
  const [current, setCurrent] = useState<SettingsSection>(initialSection);

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open && isTopmost) onClose();
      }}
    >
      <DialogContent
        className="flex h-[min(78vh,640px)] w-overlay-2xl flex-col overflow-hidden border border-border p-0 shadow-elevation"
        showCloseButton={false}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <DialogTitle>Settings</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Close settings"
            onClick={onClose}
          >
            <CloseIcon aria-hidden="true" />
          </Button>
        </div>
        {/* Base UI owns roving focus and arrow-key movement between
          * sections, plus the aria-controls/aria-labelledby pairing. The
          * hand-rolled tablist this replaces had none of them: the section
          * list announced itself as tabs and then could not be operated as
          * tabs. Inactive panels stay unmounted (Panel's default), which is
          * load-bearing here — each one fetches on mount. */}
        <Tabs
          value={current}
          onValueChange={(value) => { setCurrent(value as SettingsSection); }}
          orientation="vertical"
          className="grid min-h-0 flex-1 grid-cols-[180px_1fr]"
        >
          <TabsList className="border-r border-border bg-pane px-2 py-3">
            {SECTIONS.map((section) => (
              <TabsTrigger key={section.id} value={section.id}>
                {section.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {SECTIONS.map((section) => (
            <TabsContent
              key={section.id}
              value={section.id}
              className="overflow-y-auto px-6 py-5"
            >
              {section.render()}
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

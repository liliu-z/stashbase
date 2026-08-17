import { useState, type ReactNode } from 'react';
import { CloseIcon } from '../icons';
import type { SettingsModalProps, SettingsSection } from './SettingsModal';
import { AppearancePanel } from './settings/AppearancePanel';
import { AgentRuntimePanel } from './settings/AgentRuntimePanel';
import { EmbeddingPanel } from './settings/EmbeddingPanel';
import { GeneralPanel } from './settings/GeneralPanel';
import { McpAccessPanel } from './settings/McpAccessPanel';
import { TranscriptionPanel } from './settings/TranscriptionPanel';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

const SECTIONS: { id: SettingsSection; label: string; render: () => ReactNode }[] = [
  { id: 'general', label: 'General', render: () => <GeneralPanel /> },
  { id: 'appearance', label: 'Appearance', render: () => <AppearancePanel /> },
  { id: 'agents', label: 'Agents', render: () => <AgentRuntimePanel /> },
  { id: 'embedding', label: 'AI Index', render: () => <EmbeddingPanel /> },
  { id: 'transcription', label: 'Transcription', render: () => <TranscriptionPanel /> },
  { id: 'mcp', label: 'MCP', render: () => <McpAccessPanel /> },
];

export default function ManagedSettingsModal({
  initialSection,
  isTopmost,
  onClose,
}: SettingsModalProps) {
  const [current, setCurrent] = useState<SettingsSection>(initialSection);
  const active = SECTIONS.find((section) => section.id === current) ?? SECTIONS[0];

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open && isTopmost) onClose();
      }}
    >
      <DialogContent
        className="flex h-[min(78vh,640px)] w-[min(760px,94vw)] !max-w-[94vw] flex-col !gap-0 overflow-hidden border border-border bg-background p-0 shadow-elevation"
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
        <div className="grid min-h-0 flex-1 grid-cols-[180px_1fr]">
          <nav className="flex flex-col gap-0.5 border-r border-border bg-pane px-2 py-3" role="tablist" aria-orientation="vertical">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                role="tab"
                aria-selected={section.id === current}
                className="cursor-pointer rounded-md border-0 bg-transparent px-3 py-1.75 text-left text-base text-foreground transition-colors duration-fast hover:bg-muted aria-selected:bg-active aria-selected:hover:bg-active"
                onClick={() => setCurrent(section.id)}
              >
                {section.label}
              </button>
            ))}
          </nav>
          <div className="min-w-0 overflow-y-auto px-6 py-5" role="tabpanel">
            {active.render()}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

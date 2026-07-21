/**
 * Unified Settings modal — left nav (sections) + right content panel.
 * Replaces the old standalone MCP modal and the chrome-row dropdowns
 * for Embedder. Sections are imported as panels so each one keeps its
 * own state / auxiliary modals independent. Agent launches live in the
 * chrome-row chat buttons and tabbed chat panel.
 *
 * Open from anywhere via the `openSettings(section?)` helper or by
 * dispatching the `stashbase-open-settings` event with an optional
 * `detail.section` payload — Welcome's MCP CTA and the chrome gear
 * button both go through this.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { EmbeddingPanel } from './settings/EmbeddingPanel';
import { McpClientsPanel } from './settings/McpClientsPanel';
import { TranscriptionPanel } from './settings/TranscriptionPanel';

export type SettingsSection = 'embedding' | 'transcription' | 'mcp';

const SECTIONS: { id: SettingsSection; label: string; render: () => ReactNode }[] = [
  { id: 'embedding', label: 'Embedding', render: () => <EmbeddingPanel /> },
  { id: 'transcription', label: 'Transcription', render: () => <TranscriptionPanel /> },
  { id: 'mcp', label: 'MCP', render: () => <McpClientsPanel /> },
];

interface OpenDetail {
  section?: SettingsSection;
}

interface LockDetail {
  locked?: boolean;
}

/** Fire from anywhere to open the Settings modal. Optional `section`
 *  picks the initial pane (default: embedding). */
export function openSettings(section?: SettingsSection): void {
  window.dispatchEvent(
    new CustomEvent<OpenDetail>('stashbase-open-settings', { detail: { section } }),
  );
}

/** Mount once at the app root; listens for `openSettings` events and
 *  renders the modal when triggered. */
export function SettingsPortal() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>('embedding');
  const [interactionLocked, setInteractionLocked] = useState(false);

  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<OpenDetail>).detail;
      if (detail?.section && !interactionLocked) setSection(detail.section);
      setOpen(true);
    }
    function onLock(e: Event) {
      const detail = (e as CustomEvent<LockDetail>).detail;
      setInteractionLocked(detail?.locked === true);
    }
    window.addEventListener('stashbase-open-settings', onOpen);
    window.addEventListener('stashbase-settings-lock', onLock);
    return () => {
      window.removeEventListener('stashbase-open-settings', onOpen);
      window.removeEventListener('stashbase-settings-lock', onLock);
    };
  }, [interactionLocked]);

  return open ? (
    <SettingsModal
      initialSection={section}
      interactionLocked={interactionLocked}
      onClose={() => {
        if (!interactionLocked) setOpen(false);
      }}
    />
  ) : null;
}

function SettingsModal({
  initialSection,
  interactionLocked,
  onClose,
}: {
  initialSection: SettingsSection;
  interactionLocked: boolean;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState<SettingsSection>(initialSection);
  const active = SECTIONS.find((s) => s.id === current) ?? SECTIONS[0];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !interactionLocked) {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactionLocked, onClose]);

  return (
    // Backdrop click deliberately does NOT close — Settings holds
    // in-progress config (for example, an API key being typed) that a
    // stray click outside shouldn't discard. Close via the × button or Esc.
    <div className="modal-veil">
      <div
        className="modal-card settings-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h3>Settings</h3>
          <button
            type="button"
            className="settings-close"
            aria-label="Close settings"
            onClick={onClose}
            disabled={interactionLocked}
          >×</button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav" role="tablist" aria-orientation="vertical">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === current}
                className={'settings-nav-item' + (s.id === current ? ' current' : '')}
                disabled={interactionLocked}
                onClick={() => setCurrent(s.id)}
              >{s.label}</button>
            ))}
          </nav>
          <div className="settings-content" role="tabpanel">
            {active.render()}
          </div>
        </div>
      </div>
    </div>
  );
}

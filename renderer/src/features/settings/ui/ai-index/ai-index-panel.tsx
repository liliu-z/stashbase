/**
 * Where search by meaning gets its embeddings: a key the reader brings. There
 * is no other source, so the panel is one row that either holds a key or asks
 * for one. Nothing here signs anyone in; the StashBase account belongs to the
 * Agents section and buys the Agent's credits, not search.
 */

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { InputField, InputGroup } from '@/components/ui/input-group';
import { TabsSubtle, TabsSubtleItem } from '@/components/ui/tabs-subtle';
import type { EmbedderPort } from '@/features/settings/application/embedder-port';
import {
  describeEmbedderSource,
  EMBEDDER_PROVIDER_LABELS,
  EMBEDDER_PROVIDERS,
  keyIsActive,
  type EmbedderProvider,
  type EmbedderState,
} from '@/features/settings/domain/embedder';
import { useEmbedder, type EmbedderViewModel } from '@/features/settings/hooks/use-embedder';
import {
  SettingsGroup,
  SettingsList,
  SettingsMessage,
  SettingsPane,
  SettingsRow,
  StatusChip,
} from '@/features/settings/ui/rows';
import { FailureNotice } from '@/shared/ui/failure-notice';

/** The pane keeps its title and lede while the read is in flight or has
 *  failed, so the section never collapses into a bare sentence. */
const TITLE = 'Search by Meaning';
const LEDE =
  'Find files by meaning, even when the words differ. Keyword search works without a key.';

export interface AiIndexPanelProps {
  embedderApi: EmbedderPort;
}

function KeyRow({ embedder, state }: { embedder: EmbedderViewModel; state: EmbedderState }) {
  const [provider, setProvider] = useState<EmbedderProvider>(state.provider);
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(!state.hasKey);
  const active = keyIsActive(state);
  const busy = embedder.keyBusy;
  const label = EMBEDDER_PROVIDER_LABELS[state.provider];

  const openEditor = () => {
    setKey('');
    setEditing(true);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;
    embedder.saveKey({ key: trimmed, provider }, () => {
      setKey('');
      setEditing(false);
    });
  };

  return (
    <SettingsRow
      detail={
        state.hasKey
          ? `${label} API key saved`
          : 'Use an OpenAI, OpenRouter, or Requesty key. Your provider bills indexing and search to your account.'
      }
      title={
        <>
          API key
          {active && <StatusChip>Active</StatusChip>}
        </>
      }
      trail={
        editing ? null : state.hasKey ? (
          <>
            <Button disabled={busy} onClick={openEditor} size="compact" variant="ghost">
              Replace key
            </Button>
            <Button
              disabled={busy}
              onClick={() => embedder.removeKey()}
              size="compact"
              variant="ghost"
            >
              Remove key
            </Button>
          </>
        ) : (
          <Button disabled={busy} onClick={openEditor} size="compact" variant="tertiary">
            Add key
          </Button>
        )
      }
    >
      {editing && (
        <form className="flex max-w-[440px] flex-col items-start gap-2.5" onSubmit={submit}>
          <TabsSubtle
            aria-label="Key provider"
            onSelect={(index) => setProvider(EMBEDDER_PROVIDERS[index] ?? 'openai')}
            selectedIndex={Math.max(0, EMBEDDER_PROVIDERS.indexOf(provider))}
            size="compact"
          >
            {EMBEDDER_PROVIDERS.map((candidate) => (
              <TabsSubtleItem key={candidate} label={EMBEDDER_PROVIDER_LABELS[candidate]} />
            ))}
          </TabsSubtle>
          {/* Field and submit on one line, the shape every short form in
              Settings takes. The row already says "API key", so the field
              carries its label for assistive tech only. */}
          <div className="flex w-full items-start gap-1.5">
            <InputGroup className="flex-1" size="compact">
              <InputField
                autoComplete="off"
                label={`${EMBEDDER_PROVIDER_LABELS[provider]} API key`}
                labelHidden
                onChange={setKey}
                placeholder="Paste your API key"
                resting="outline"
                spellCheck={false}
                type="password"
                value={key}
              />
            </InputGroup>
            <Button
              disabled={busy || key.trim().length === 0}
              loading={embedder.savingKey}
              size="compact"
              type="submit"
              variant="tertiary"
            >
              Save key
            </Button>
            {state.hasKey && (
              <Button
                disabled={busy}
                onClick={() => setEditing(false)}
                size="compact"
                variant="ghost"
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
      {embedder.keyWarning && (
        <p className="mt-1.5 text-caption text-muted-foreground" role="status">
          Key saved, but could not be verified: {embedder.keyWarning}
        </p>
      )}
      {embedder.keyFailure && <FailureNotice className="mt-1.5" failure={embedder.keyFailure} />}
    </SettingsRow>
  );
}

export function AiIndexPanel({ embedderApi }: AiIndexPanelProps) {
  const embedder = useEmbedder(embedderApi);
  const state = embedder.state;

  if (embedder.loading || !state) {
    return (
      <SettingsPane lede={LEDE} title={TITLE}>
        <SettingsList>
          {embedder.loading ? (
            <SettingsMessage message="Loading search settings…" />
          ) : (
            <SettingsMessage
              message="Could not load search settings."
              onRetry={() => embedder.reload()}
            />
          )}
        </SettingsList>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane lede={LEDE} title={TITLE}>
      {/* No group heading: the pane's title names the setting, the row names
          the key, and a third heading between them says nothing. */}
      <SettingsGroup hint={describeEmbedderSource(state)}>
        <SettingsList>
          <KeyRow embedder={embedder} state={state} />
        </SettingsList>
      </SettingsGroup>
    </SettingsPane>
  );
}

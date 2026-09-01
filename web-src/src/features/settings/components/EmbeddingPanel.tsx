/**
 * Settings → Similarity Search panel. The user can choose the signed-in StashBase
 * allowance, direct OpenAI, or OpenRouter's OpenAI-compatible endpoint. With
 * no active source, Similarity Search is unavailable (files still save,
 * preview, and use Exact Search); the setup modal on folder load lives in
 * `EmbedderRequireKeyGate` so it fires whether or not Settings is open.
 */
import { useState } from 'react';
import { type EmbedderProvider, type HostedAccountState } from '@/common/api/apiTypes';
import { useEmbedderSettings } from '@/features/settings/hooks/useEmbedderSettings';
import { EmbeddingAuthChoice } from '@/features/settings/components/embedder/EmbeddingAuthChoice';
import { KeyModal } from '@/features/settings/components/embedder/KeyModal';
import { RemoveKeyModal } from '@/features/settings/components/embedder/RemoveKeyModal';
import { Button } from '@/common/components/ui/button';
import { Input } from '@/common/components/ui/input';
import { SegmentedControl, SegmentedControlItem } from '@/common/components/ui/segmented-control';
import { FieldLegend, FieldSet } from '@/common/components/ui/field';
import { Progress, ProgressIndicator, ProgressTrack } from '@/common/components/ui/progress';
import { AccountSignInForm } from '@/common/components/AccountSignInForm';
import { hostedQuotaRemainingPercent, hostedQuotaResetLabel } from '@/common/lib/hostedQuota';
import { SectionDescription, SectionHeading } from '@/common/components/ui/section';
import { Card } from '@/common/components/ui/card';
import { AccountAvatar, accountDisplayLabel } from '@/common/components/AccountIdentity';
import { cn } from '@/common/lib/utils';

const PROVIDERS: Record<EmbedderProvider, { label: string; model: string; placeholder: string; costHint: string }> = {
  openai: {
    label: 'OpenAI',
    model: 'text-embedding-3-small',
    placeholder: 'sk-...',
    costHint: 'about $0.02 per million tokens',
  },
  openrouter: {
    label: 'OpenRouter',
    model: 'openai/text-embedding-3-small',
    placeholder: 'sk-or-v1-...',
    costHint: 'billed by OpenRouter',
  },
};

const PROVIDER_ORDER: EmbedderProvider[] = ['openai', 'openrouter'];

function AccountSummary({
  account,
  labelPrefix,
  description,
  heading = false,
}: {
  account: HostedAccountState;
  labelPrefix?: string;
  description: string;
  heading?: boolean;
}) {
  const label = `${labelPrefix ?? ''}${accountDisplayLabel(account)}`;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <AccountAvatar account={account} />
      <div className="min-w-0">
        {heading
          ? <SectionHeading level={4} className="truncate">{label}</SectionHeading>
          : <div className="truncate text-sm font-medium">{label}</div>}
        {account.displayName && account.email && (
          <div className="truncate text-xs text-muted-foreground">{account.email}</div>
        )}
        <div className={cn('text-xs text-muted-foreground', heading && 'mt-0.5')}>{description}</div>
      </div>
    </div>
  );
}

export function EmbeddingPanel() {
  const {
    state,
    loadError,
    retryLoad,
    selectedProvider,
    selectProvider,
    addKey,
    addBusy,
    addError,
    setAddKey,
    submitAddKey,
    accountBusy,
    saveKey,
    removeKey,
    refreshAccount,
    signOut,
    useAccountAllowance,
    useApiKeySource,
    applySignedIn,
  } = useEmbedderSettings();
  const [keyEditOpen, setKeyEditOpen] = useState(false);
  const [keyRemoveOpen, setKeyRemoveOpen] = useState(false);
  // Whether the bring-your-own-key form is revealed. Only relevant when
  // nothing is authorized yet: that is the one state where Settings shows
  // the same fork the Files-panel callout does, so a user who arrived here
  // from either direction sees the two options with equal weight instead of
  // a key field plus a footnote about accounts.
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [signInFormOpen, setSignInFormOpen] = useState(false);

  if (loadError) {
    return (
      <div>
        {/* role="alert": the failure replaces the panel after an async
          * load, so it must announce itself — nothing else changes on
          * screen for a listener to notice. */}
        <div role="alert" className="text-sm text-destructive">Couldn’t load Similarity Search settings: {loadError}</div>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={retryLoad}>Retry</Button>
        </div>
      </div>
    );
  }
  if (!state) return <div className="py-3 text-base text-muted-foreground">Loading…</div>;
  const selected = PROVIDERS[selectedProvider];
  const activeProviderSelected = state.provider === selectedProvider;
  const hasSelectedProviderKey = state.hasKey && activeProviderSelected;
  const directSourceActive = state.source === selectedProvider;
  // Provider and model are bring-your-own-key concerns. While the fork is
  // up they would be answering a question the user has not reached yet, so
  // the panel shows the choice alone until a path is picked.
  const hostedActive = state.source === 'stashbase-account' && state.account.signedIn;
  const showingHostedSummary = hostedActive && !keyFormOpen && !signInFormOpen;
  const showingAuthChoice = !state.authorized && !keyFormOpen && !signInFormOpen;

  return (
    <>
      <div>
        <div>
          <SectionHeading level={3} className="mb-1">Similarity Search</SectionHeading>
          <SectionDescription className="mb-2.5">
            Find related Sources and Wiki Pages even when the wording differs. The model stays fixed so local search data remains compatible.
          </SectionDescription>
          {showingHostedSummary && (
            <Card surface="raised" className="p-4">
              <div className="flex items-start justify-between gap-3">
                {/* The card's own title, so a heading rather than a bold
                  * line: level 4 sits under the panel's level 3, which in
                  * turn sits under the Settings dialog title's h2. */}
                <AccountSummary
                  account={state.account}
                  description="Using the StashBase account allowance"
                  heading
                />
                {state.account.quota && (
                  <div className="text-right">
                    <div className="text-base font-semibold">{hostedQuotaRemainingPercent(state.account.quota)}%</div>
                    <div className="text-2xs text-muted-foreground">remaining</div>
                  </div>
                )}
              </div>
              {state.account.quota && (
                <div className="mt-3">
                  {/* The primitive, not an inline-width div: Root carries
                    * role="progressbar" with aria-valuenow/max, so the
                    * remaining allowance is a number and not only a
                    * coloured rectangle. The track takes the card's full
                    * width instead of the primitive's inline step. */}
                  <Progress
                    className="block"
                    aria-label="Remaining Similarity Search allowance"
                    value={hostedQuotaRemainingPercent(state.account.quota)}
                  >
                    <ProgressTrack className="w-full">
                      <ProgressIndicator className="bg-accent" />
                    </ProgressTrack>
                  </Progress>
                  <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
                    <span>{state.account.quota.remainingTokens.toLocaleString()} tokens left</span>
                    <span>{hostedQuotaResetLabel(state.account.quota)}</span>
                  </div>
                </div>
              )}
              {state.account.quotaUnavailable && <div className="mt-2 text-xs text-muted-foreground">Usage is temporarily unavailable.</div>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={accountBusy} onClick={() => { void refreshAccount(); }}>Refresh usage</Button>
                <Button variant="outline" size="sm" disabled={accountBusy} onClick={() => setKeyFormOpen(true)}>Use your own key</Button>
                <Button variant="ghost" size="sm" disabled={accountBusy} onClick={() => { void signOut(); }}>Sign out</Button>
              </div>
            </Card>
          )}
          {signInFormOpen && (
            <AccountSignInForm
              purpose="embedding"
              onBack={() => setSignInFormOpen(false)}
              onSignedIn={(account) => {
                applySignedIn(account);
                setSignInFormOpen(false);
              }}
            />
          )}
          {state.account.signedIn && !hostedActive && !signInFormOpen && (
            <Card surface="raised" className="mb-3 flex items-center justify-between gap-3 px-3 py-2.5">
              <AccountSummary
                account={state.account}
                labelPrefix="Signed in as "
                description="Your own API key is currently active."
              />
              <Button
                variant="outline"
                size="sm"
                disabled={accountBusy}
                onClick={() => {
                  setKeyFormOpen(false);
                  void useAccountAllowance();
                }}
              >Use account allowance</Button>
            </Card>
          )}
          {!showingHostedSummary && !signInFormOpen && !showingAuthChoice && (
            <FieldSet className="mt-0.5 mb-2 w-fit">
            {/* A single-choice group, so fieldset/legend rather than an
              * aria-label on the control. The legend is hidden because the
              * panel heading above already carries the visible name for
              * this block; the fieldset still announces the grouping. */}
            <FieldLegend className="sr-only">Similarity Search provider</FieldLegend>
            <SegmentedControl
              disabled={addBusy}
              value={[selectedProvider]}
              onValueChange={(next) => {
                const picked = next[0] as EmbedderProvider | undefined;
                if (!picked || picked === selectedProvider) return;
                selectProvider(picked);
              }}
            >
              {PROVIDER_ORDER.map((provider) => (
                <SegmentedControlItem key={provider} value={provider} className="min-w-24 text-sm">
                  {PROVIDERS[provider].label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            </FieldSet>
          )}
          {!showingHostedSummary && !signInFormOpen && !showingAuthChoice && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm leading-normal text-muted-foreground [&_code]:font-mono [&_code]:text-xs [&_code]:whitespace-nowrap [&_code]:text-accent">
            {state.hasKey && <span>Current: {PROVIDERS[state.provider].label}</span>}
            <span>Model: <code>{selected.model}</code></span>
            <span>{selected.costHint}</span>
          </div>
          )}
          {!showingHostedSummary && !signInFormOpen && (hasSelectedProviderKey ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 text-sm leading-8 text-muted-foreground">{directSourceActive ? 'Key active' : 'Key configured'}</div>
              <div className="flex flex-wrap gap-2">
                {!directSourceActive && (
                  <Button
                    size="sm"
                    disabled={accountBusy}
                    onClick={() => {
                      setKeyFormOpen(false);
                      void useApiKeySource();
                    }}
                  >Use this key</Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => setKeyEditOpen(true)}
                >Change key…</Button>
                <Button
                  variant="destructive-outline"
                  onClick={() => setKeyRemoveOpen(true)}
                >Remove key…</Button>
              </div>
            </div>
          ) : (
            <>
              {state.hasKey && !activeProviderSelected && (
                <SectionDescription className="mb-2.5">
                  Save a {selected.label} key to switch from {PROVIDERS[state.provider].label}.
                </SectionDescription>
              )}
              {/* Nothing authorized yet: lead with the fork, the same one
                * the Files-panel callout shows. Switching providers with a
                * key already on file is a different question and keeps the
                * plain form. */}
              {showingAuthChoice && (
                <EmbeddingAuthChoice
                  onSignIn={() => setSignInFormOpen(true)}
                  onUseOwnKey={() => setKeyFormOpen(true)}
                />
              )}
              {!showingAuthChoice && (
              /* A real `form`, so Enter in the field submits through the
               * browser's own implicit-submission rule rather than through a
               * hand-rolled keydown branch that had to re-decide preventDefault
               * and IME composition for itself. `type="submit"` is spelled out
               * because Base UI's `useButton` sets `type="button"` on every
               * Button — a converted confirm action does NOT submit without
               * it. There is no visible label for this field (the panel
               * heading names the feature, not the control), so `aria-label`
               * is the honest naming here. */
              <form
                className="flex min-w-0 items-center gap-2"
                onSubmit={(event) => { event.preventDefault(); void submitAddKey(); }}
              >
                <Input
                  type="password"
                  className="h-8 flex-1 font-mono text-sm"
                  aria-label={`${selected.label} API key`}
                  placeholder={selected.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  value={addKey}
                  disabled={addBusy}
                  onChange={(e) => setAddKey(e.target.value)}
                />
                <Button
                  type="submit"
                  disabled={addBusy || !addKey.trim()}
                >{addBusy ? 'Validating…' : 'Add key'}</Button>
              </form>
              )}
              {addError && <div role="alert" className="mt-1.5 text-sm text-destructive">{addError}</div>}
            </>
          ))}
          {!showingHostedSummary && !signInFormOpen && !showingAuthChoice && (
            <SectionDescription className="mt-3.5 [&_code]:font-mono [&_code]:text-xs [&_code]:whitespace-nowrap [&_code]:text-accent">
              Stored locally in <code>~/.stashbase/config.json</code>. Used only for Similarity Search, never Chat.
            </SectionDescription>
          )}
        </div>
      </div>

      {keyEditOpen && (
        <KeyModal
          mode="change"
          provider={selectedProvider}
          model={selected.model}
          placeholder={selected.placeholder}
          onCancel={() => setKeyEditOpen(false)}
          onSaved={async (key) => { setKeyEditOpen(false); await saveKey(key); }}
        />
      )}
      {keyRemoveOpen && (
        <RemoveKeyModal
          onCancel={() => setKeyRemoveOpen(false)}
          onConfirm={async () => { setKeyRemoveOpen(false); await removeKey(); }}
        />
      )}
    </>
  );
}

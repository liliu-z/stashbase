/**
 * The first-folder Similarity Search setup dialog (see `EmbedderRequireKeyGate`).
 *
 * Setting up an indexing source is strongly recommended, not forced: an
 * unindexed library still browses, edits, previews, and keyword-searches —
 * those are local computations, and open-source, local-first software must
 * not lock them behind a remote service. So the dialog has an exit, but a
 * low-emphasis, deliberate one; there is no casual dismiss (Escape / backdrop
 * do nothing), so the user makes an explicit choice rather than swatting a
 * prompt.
 *
 * Two views:
 *   • choice — sign in (recommended, hosted) · use your own key · a quiet
 *     "Not now" exit.
 *   • key    — provider toggle + key field; "Save key" activates. A Back link
 *     returns to the choice.
 *
 * The exit is one deliberate, low-emphasis button, not a confirm hop. The
 * Files-panel entry reopens this later, while a confirm that itemised the surviving local abilities
 * would package keyword search as a peer feature — which it is not meant to
 * be.
 *
 * Exits:
 *   • Save key — validates + persists via `/api/embedder/key`, daemon
 *     hot-swap; the dialog closes and the library is activated.
 *   • Not now — the caller remembers the one-time dismissal; the Files panel
 *     and Settings keep explicit setup routes for later.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { type EmbedderProvider } from '@/common/api/apiTypes';
import { useApiKeyEntry } from '@/features/settings/hooks/useApiKeyEntry';
import ManagedModalShell from '@/common/components/ManagedModalShell';
import { EmbeddingAuthChoice } from '@/features/settings/components/embedder/EmbeddingAuthChoice';
import { Button } from '@/common/components/ui/button';
import { Input } from '@/common/components/ui/input';
import { SegmentedControl, SegmentedControlItem } from '@/common/components/ui/segmented-control';
import { FieldLegend, FieldSet } from '@/common/components/ui/field';
import { StatusMessage } from '@/common/components/ui/status';
import { AccountSignInForm } from '@/common/components/AccountSignInForm';

const PROVIDERS: Record<EmbedderProvider, { label: string; model: string; placeholder: string }> = {
  openai: {
    label: 'OpenAI',
    model: 'text-embedding-3-small',
    placeholder: 'sk-...',
  },
  openrouter: {
    label: 'OpenRouter',
    model: 'openai/text-embedding-3-small',
    placeholder: 'sk-or-v1-...',
  },
};

const PROVIDER_ORDER: EmbedderProvider[] = ['openai', 'openrouter'];

type View = 'choice' | 'signin' | 'key';

const TITLES: Record<View, string> = {
  choice: 'Set up Similarity Search',
  signin: 'Sign in to StashBase',
  key: 'Add your API key',
};

/* One line, scannable at a glance. The old subtitle explained the
 * mechanism ("…even when the wording is different") — product copy in a
 * dialog whose job is a choice, and the sentence that started every layer
 * of this screen running two lines deep. */
const DESCRIPTIONS: Record<View, ReactNode> = {
  choice: 'Find related Sources and Wiki Pages even when the wording differs.',
  /* The free allowance is the one thing this view has to say, so it takes
   * the view's single accent moment: the same `accent/8` wash the tinted
   * card that led here wears at rest, laid over the operative phrase.
   *
   * Geometry follows the app's other `<mark>` (the library-search hit):
   * `-xs` because the corner ramp assigns that step to an inline run of
   * text, `px-px`, and inherited ink. The wash IS the signal — adding
   * `text-foreground` inside a muted DialogDescription put the phrase at
   * the same size and colour as the dialog title above it, so a subtitle
   * carried three emphasis signals and out-weighed its own heading. The
   * hue differs from the search mark's amber on purpose: amber is
   * reserved for search hits. */
  signin: (
    <>
      Use your{' '}
      <mark className="rounded-xs bg-accent/8 box-decoration-clone px-px text-inherit">
        included monthly Similarity Search allowance
      </mark>.
    </>
  ),
  key: 'Paste an OpenAI or OpenRouter API key for Similarity Search.',
};

export function RequireApiKeyModal({
  initialProvider = 'openai',
  isTopmost,
  onSaved,
  onSignedIn,
  onSkip,
}: {
  initialProvider?: EmbedderProvider;
  isTopmost: boolean;
  onSaved: (provider: EmbedderProvider, model: string, backfillStarted?: boolean, warning?: string) => void;
  onSignedIn: (backfillStarted?: boolean) => void;
  onSkip: () => void;
}) {
  const [provider, setProvider] = useState<EmbedderProvider>(initialProvider);
  const [view, setView] = useState<View>('choice');
  const { key, busy, error, setKey, clearError, submit } = useApiKeyEntry(
    provider,
    // `changeApiKey` server-side rejects definite provider auth failures,
    // persists to `~/.stashbase/config.json`, and rebinds so the next
    // search uses the new key (creating the collection on first key).
    useCallback(
      (result) => onSaved(result.provider, result.model, result.backfillStarted, result.warning),
      [onSaved],
    ),
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Opening focus for the choice view. Base UI otherwise hands focus to
  // the first enabled card, and a focus ring around a full-width card reads as "this
  // one is already picked", the single thing this screen must not say.
  // A tabindex=-1 wrapper takes the focus silently (globals.css drops the
  // ring for elements the keyboard cannot tab to) and Tab still steps
  // into the cards from there.
  const choiceRef = useRef<HTMLDivElement | null>(null);

  return (
    <ManagedModalShell
      title={TITLES[view]}
      description={DESCRIPTIONS[view]}
      // A tight column: this is a short, choice-style dialog, and the default
      // width let the description prose run past a comfortable measure.
      narrow
      // Per view, and never nothing: focusing a ref whose element is not
      // mounted drops focus to the document and strands keyboard users.
      // The key view lands in the field; the choice view lands on its
      // inert wrapper rather than on a card (see `choiceRef`).
      initialFocus={view === 'key' ? inputRef : choiceRef}
      // No casual dismiss. Backdrop clicks are disabled and the close request
      // (Escape) is swallowed — the way out is an explicit choice: activate,
      // or take the deliberate "Not now" path.
      closeOnBackdrop={false}
      onCancel={() => { /* no casual dismiss — choose activate or skip */ }}
      isTopmost={isTopmost}
    >
      {view === 'choice' && (
        <div ref={choiceRef} tabIndex={-1} className="outline-none">
          <EmbeddingAuthChoice
            onSignIn={() => setView('signin')}
            onUseOwnKey={() => setView('key')}
            onSkip={onSkip}
          />
        </div>
      )}

      {view === 'signin' && (
        <div ref={choiceRef} tabIndex={-1} className="outline-none">
          <AccountSignInForm
            purpose="embedding"
            onBack={() => setView('choice')}
            // The signed-in account carries no backfill flag: see the Known
            // Gap on `HostedAccountActivation` in `shared/account.ts`.
            onSignedIn={() => onSignedIn(undefined)}
          />
        </div>
      )}

      {view === 'key' && (
      <>
      {/* The shared segmented control, not a hand-rolled radio row: that
        * one marked its selection with a heavier font, which at one size
        * reads as "these two words are different sizes", and it stretched
        * to the dialog width so the two providers got unequal shares. */}
      <FieldSet className="mb-2 w-fit">
      <FieldLegend className="sr-only">Similarity Search provider</FieldLegend>
      <SegmentedControl
        disabled={busy}
        value={[provider]}
        onValueChange={(next) => {
          const picked = next[0] as EmbedderProvider | undefined;
          if (!picked || picked === provider) return;
          setProvider(picked);
          setKey('');
          clearError();
        }}
      >
        {PROVIDER_ORDER.map((optionProvider) => (
          <SegmentedControlItem key={optionProvider} value={optionProvider} className="min-w-24 text-sm">
            {PROVIDERS[optionProvider].label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      </FieldSet>
      {/* Detail, not body: at 13px these two lines carried the same
        * weight as the question above them. */}
      <div className="mb-2.5 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-normal text-muted-foreground [&_code]:font-mono [&_code]:text-2xs [&_code]:text-accent">
        <span>Model: <code>{PROVIDERS[provider].model}</code></span>
        <span>Stored locally in <code>~/.stashbase/config.json</code></span>
      </div>
      {/* A real `form` for the field-plus-confirm pair, so Enter submits
        * through implicit submission. That also retires the hand-rolled IME
        * guard: a composing Enter never fires implicit submission in the
        * first place, because the keystroke belongs to the input method and
        * not to the form. `type="submit"` is spelled out because Base UI's
        * `useButton` puts `type="button"` on every Button. `Back` stays
        * `type="button"` — a form's default for a bare button is submit,
        * and this one is the way OUT. */}
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Input
        ref={inputRef}
        type="password"
        className="font-mono text-sm"
        aria-label="API key"
        placeholder={PROVIDERS[provider].placeholder}
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        disabled={busy}
      />
      {error && (
        <StatusMessage tone="error" className="mt-2.5 max-h-overlay-xs overflow-y-auto wrap-anywhere">
          {error}
        </StatusMessage>
      )}
      <div className="mt-3.5 flex items-center justify-between gap-2">
        {/* Same quiet text exit as the choice view's "Not now": both
          * are the low-emphasis way OUT of this dialog, so they read as
          * one control at two moments — no resting underline, no button
          * box beside the primary action, underline on hover only. */}
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto cursor-pointer border-0 p-0 text-muted-foreground underline-offset-2 hover:text-foreground disabled:opacity-60"
          onClick={() => { setView('choice'); clearError(); }}
          disabled={busy}
        >Back</Button>
        <Button
          type="submit"
          disabled={busy}
        >{busy ? 'Validating…' : 'Save key'}</Button>
      </div>
      </form>
      </>
      )}
    </ManagedModalShell>
  );
}

/**
 * The Similarity Search setup choice: how to power indexing.
 *
 * This is a two-option question, so it reads as two objects, not a form. Each
 * option is ONE card with its explanation stacked inside it (title over a
 * muted subtitle), left-aligned to a single edge — so the eye reads
 * header → cards → exit → disclosure, instead of hopping between a
 * button and a caption line beneath it.
 *
 * Wording keeps the first-run choice at the product level; "embeddings"
 * appears only in the bottom disclosure line (and the key form), while the
 * technical Similarity Search name remains in Settings.
 *   • Sign in to StashBase — hosted, free monthly indexing; the low-friction
 *     default. The recommended card carries a soft brand TINT and the same
 *     neutral border as its sibling: tint plus a brand-toned border read as
 *     "already selected" rather than "recommended", which is the one thing
 *     this screen must not say — nothing is chosen until the user clicks.
 *     Supabase OAuth opens Google in the system browser; the local Node
 *     service owns PKCE and the shared hosted quota session.
 *     Deployments may still disable the card explicitly; the quiet corner
 *     mark keeps that state distinguishable from a broken control.
 *   • Use your own API key — OpenAI or OpenRouter, for advanced users;
 *     choosing it reveals the key field in place (the parent owns that swap).
 *
 * `onSkip`, when present (first-run gate only), renders the deliberate exit: a
 * low-emphasis "Not now" text button. NOT an
 * underlined link at rest — a standing underline is browser furniture and
 * pulled the whole card stack toward web-page register; the underline appears
 * on hover, where it says "clickable" without the styling cost. It sits far
 * enough below the cards to read as the alternative and far enough above the
 * hairline not to look like the footer's heading. It stays ONE line: a
 * reassurance note under it ("You can enable it later in Settings") was
 * logically true but gave the screen's lightest element a subtitle, making a
 * borderless card out of the exit. Settings renders this component
 * without `onSkip`.
 *
 * Every layer here holds to one line of its own — title, subtitle, each
 * card's title and its short detail, skip, disclosure. The dialog asks
 * one question; anything that has to be read rather than scanned belongs in
 * Settings, not in the way of the answer. The cards are padded for two
 * short lines, not for the paragraphs they used to hold: type left, box
 * unchanged is what makes a trimmed card look hollow.
 *
 * Width: all cards span the full dialog column (`w-full`). A `<button>`
 * shrinks to fit its own text even at `display: grid`, so without it the
 * list sized to its longest subtitle and the cards ended on different
 * right edges — a ragged edge reads as unrelated controls rather than
 * one set of peers, and the left-aligned stack depends on both edges
 * being shared.
 *
 * Corners: these are BOXES, so they take `--radius-container` (the
 * `rounded-xl` step) like the composer, the inputs, and the dialog around
 * them — not the smaller `--radius-ui` used by rows and menu items INSIDE
 * a box. Peer boxes seen together are expected to wear the same corner.
 *
 * The two cards are a standing exemption from the Button primitive, and
 * they are NOT a radio group. Nothing is selected here — each card fires
 * immediately (sign-in opens the system browser; the key card swaps the
 * view in place), there is no pending selection and no submit, and the
 * header comment above says why a "chosen" reading is the one thing this
 * screen must not give. So radio semantics would misdescribe them.
 * `Button` does not fit either: it is an inline-flex, centred, single-line
 * ITEM at the `-ui` corner, while these are two-line, left-aligned BOXES
 * at the `-container` corner, and the disabled card deliberately keeps
 * full opacity so its corner mark reads as "unavailable" rather than
 * "broken". Adopting the primitive would mean neutralising its display,
 * height, alignment, wrapping, corner, and disabled treatment to arrive
 * back at this markup. What the primitive genuinely owns — the press
 * response — is duplicated here instead, the same way `ErrorBoundary` and
 * the lightbox toolbar duplicate it.
 */

import { Button } from '@/common/components/ui/button';
import { cn } from '@/common/lib/utils';

export function EmbeddingAuthChoice({ onUseOwnKey, onSignIn, signInDisabled = false, onSkip }: {
  onUseOwnKey: () => void;
  onSignIn?: () => void;
  /** Allows deployments without hosted accounts to hide the action while
   * retaining the finished layout. */
  signInDisabled?: boolean;
  /** When provided (first-run gate only), renders the quiet exit to basic
   *  mode. Omitted in Settings, where continuing without indexing is moot. */
  onSkip?: () => void;
}) {
  return (
    <div className="mt-1">
      {/* Two peer options, so a real list: the set announces its count and
        * its item boundaries instead of arriving as one run of text. Not a
        * radio group and not a listbox — each card FIRES on click and
        * nothing is ever pre-selected, so neither ARIA pattern supersedes
        * the list here. */}
      <ul className="m-0 grid list-none gap-2.5 p-0">
        <li>
        {/* Recommended — sign in. Brand-tinted card; title over its own subtitle. */}
        <button
          type="button"
          disabled={signInDisabled}
          onClick={onSignIn}
          className="relative grid w-full gap-0.5 rounded-xl border border-border bg-accent/8 px-4 py-1.5 text-left transition-control enabled:cursor-pointer enabled:hover:border-stroke-strong enabled:hover:bg-accent/14 enabled:active:scale-97 disabled:cursor-default"
        >
          <span className="text-base font-semibold leading-snug text-foreground">Sign in to StashBase</span>
          <span className="text-xs leading-snug text-muted-foreground">Included monthly allowance</span>
          {signInDisabled && (
            /* Corner mark, not a chip: a filled badge would compete with
             * the card's own title for the eye that is choosing. Sits on
             * the title's line so the card keeps its two-line shape. */
            <span className="absolute top-2 right-4 text-2xs leading-none text-muted-foreground">Unavailable</span>
          )}
        </button>
        </li>

        <li>
        {/* Secondary — bring your own key. Outlined card, same shape. */}
        <button
          type="button"
          onClick={onUseOwnKey}
          className="grid w-full gap-0.5 rounded-xl border border-border bg-background px-4 py-1.5 text-left transition-control enabled:cursor-pointer enabled:hover:border-stroke-strong enabled:hover:bg-muted enabled:active:scale-97 disabled:cursor-wait disabled:opacity-70"
        >
          <span className="text-base font-semibold leading-snug text-foreground">Use your own API key</span>
          <span className="text-xs leading-snug text-muted-foreground">OpenAI or OpenRouter</span>
        </button>
        </li>
      </ul>

      {onSkip && (
        /* Right-aligned, where a dialog's tertiary action lives. Dropping
         * the standing underline cost this its only "I am a control"
         * signal, and left-aligned under the cards it read as one more
         * line of body copy; going smaller and fainter would only have
         * made it a caption. Position restores the role, so the type can
         * stay quiet. 20px below the cards — far enough not to read as a
         * footnote on the last card, close enough to stay tied to the
         * choices it is an alternative to. */
        <div className="mt-5 flex justify-end">
          {/* `size="xs"` for the type step only; the height and padding
            * come back off so the exit sits as a line of text. Muted
            * rather than the link variant's primary, and no resting
            * underline — the underline arrives on hover. */}
          <Button
            variant="link"
            size="xs"
            className="h-auto cursor-pointer border-0 p-0 text-muted-foreground underline-offset-2 hover:text-foreground"
            onClick={onSkip}
          >
            Not now
          </Button>
        </div>
      )}

      {/* 28px above the hairline (12px without the skip): closer to the
        * rule than to the choice above it would make the skip read as the
        * footer's heading. Below the rule, 8px — the line belongs to its
        * divider, so the footer reads as one thin band rather than a
        * fourth block. The privacy line is a full muted: it names what
        * leaves the machine, which people do read. */}
      <p className={cn(
        'm-0 border-t border-border pt-2 text-2xs leading-relaxed text-muted-foreground',
        onSkip ? 'mt-7' : 'mt-3',
      )}>
        Hosted and API-key modes send text to the selected service for Similarity Search embeddings.
      </p>
    </div>
  );
}

import { BotIcon } from '@/common/components/icons';
import { Button } from '@/common/components/ui/button';

/**
 * Persistent Agent-panel action, icon-only.
 *
 * It shares a row with the chat tabs, and a labelled button there was
 * spending ~150px of a strip whose job is to show which conversations are
 * open — in a docked panel that is the difference between reading a tab's
 * title and reading an ellipsis. Every other control in the app's chrome
 * strips is a glyph with a tooltip (the sidebar's bottom row, the titlebar),
 * so a text button here was also the odd one out.
 *
 * `BotIcon` is the same mark the tree gives `AGENTS.md`, which is the point:
 * both are durable guidance an Agent reads before it starts. Where each one
 * LIVES is the distinction, and the editor says so — it is not a difference
 * a second glyph could carry.
 *
 * The customized dot stays a dot. With the label gone it is the only thing
 * saying this working folder overrides the product default, and it has to do that
 * without becoming status copy in a navigation strip.
 */
export function AgentInstructionsControl({
  scopeName,
  customized,
  onOpen,
}: {
  scopeName: string;
  customized: boolean | null;
  onOpen: () => void;
}) {
  /* Icon-only, so this string is the accessible name AND the tooltip —
   * one label, no chance of the two drifting. It names the working folder
   * because the button cannot: which folder it edits follows the active tab. */
  const label = `Agent Instructions for ${scopeName}${customized ? ' — customized' : ''}`;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      /* Aligned to the chat-panel toggle it sits beside, NOT to the tabs.
       * Those two follow different rules: tabs bottom-align to the pane
       * edge, while the toggle floats centred in the 36px titlebar band
       * (`.titlebar-controls-right`), so an `icon-sm` control there spans
       * 4–32px from the pane top. `self-start` measures from the row's top
       * instead of its tab-driven bottom — which is what makes this
       * independent of how tall a tab happens to be — and the row's 6px
       * `pt-1.5` then needs 2px back to land on that same line. Two
       * adjacent glyph buttons have to share a centre line; matching the
       * tab baseline instead left this one sitting low.
       *
       * Both are `icon-sm`; the glyph matches `controlButtonClass`'s 3.5
       * so the pair is one control size in one glyph size. */
      className="relative -mt-0.5 shrink-0 self-start text-muted-foreground"
      aria-label={label}
      title={label}
      data-customized={customized == null ? 'unknown' : String(customized)}
      onClick={onOpen}
    >
      <BotIcon className="size-3.5" />
      {customized && (
        /* Clear of the glyph, but tucked inside the corner radius: at the
         * button's very edge the dot crossed the curve and read as
         * something escaping the control rather than a badge on it. Four
         * pixels is a mark; six was a second object competing with the
         * icon it annotates. */
        <span className="absolute top-1 right-1 size-1 rounded-full bg-accent" aria-hidden="true" />
      )}
    </Button>
  );
}

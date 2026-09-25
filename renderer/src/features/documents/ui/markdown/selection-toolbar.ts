/**
 * The product actions on Crepe's selection toolbar: Humanize and Ask Agent.
 *
 * They are words, not glyphs. Crepe's own items are formatting marks every
 * editor draws the same way; these are product actions nothing draws, and a
 * sparkle beside them said neither "human" nor "rewrite". The site names the
 * tools in words too. Crepe takes an item's content as an HTML string, so
 * each label is one span `document.css` gives its width and type; the button
 * Crepe renders has no label of its own, so the word is also the control's
 * accessible name.
 */
import type { ToolbarFeatureConfig } from '@milkdown/crepe/feature/toolbar';
import type { Ctx } from '@milkdown/kit/ctx';

/** What each action does when clicked, Ask Agent with the editor's context.
 *  An absent action has no item. */
export interface SelectionActions {
  askAgent?: ((ctx: Ctx) => void) | null | undefined;
  humanize?: (() => void) | undefined;
}

const label = (word: string) => `<span class="markdown-toolbar-label">${word}</span>`;

/** The toolbar with the present actions as one group after Crepe's formatting
 *  and function groups, or Crepe's default toolbar when there are none. */
export function selectionToolbar({
  askAgent,
  humanize,
}: SelectionActions): ToolbarFeatureConfig | undefined {
  if (!askAgent && !humanize) return undefined;
  return {
    buildToolbar: (builder) => {
      const group = builder.addGroup('selection', 'Selection');
      if (humanize) {
        group.addItem('humanize', {
          active: () => false,
          icon: label('Humanize'),
          onRun: () => humanize(),
        });
      }
      if (askAgent) {
        group.addItem('ask-agent', {
          active: () => false,
          icon: label('Ask Agent'),
          onRun: (ctx) => askAgent(ctx),
        });
      }
    },
  };
}

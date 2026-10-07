/**
 * The Markdown surface's seam onto Milkdown's diff plugin.
 *
 * Only the two plugins the review needs are registered — the diff state
 * machine and its decorations — rather than Crepe's composite AI feature,
 * which would also bring a streaming plugin, an instruction tooltip, AI
 * orchestration commands and a second floating Accept-all panel that this
 * product answers for in its own header bar. Taking the two directly means
 * the configuration the composite would have supplied is passed here
 * instead, and that nothing in the bundle depends on an upstream guard
 * staying where it is.
 *
 * The plugin holds the only authoritative count of changes still pending and
 * recomputes it on every transaction, so the watcher below reports that
 * number upward rather than anything recomputing it.
 *
 * `@milkdown/plugin-diff` is patched under `patches/`. Upstream keys a
 * rejection by the span a change holds in the proposal, and a pure deletion
 * holds none, so its own Reject left it pending and the click did nothing.
 * The patch matches such a rejection by its point and by the text it removes,
 * which `revision-engine.test.ts` proves; a Milkdown upgrade carries the patch
 * until upstream resolves it.
 */
import type { CrepeBuilder } from '@milkdown/crepe/builder';
import { diffComponent, diffComponentConfig } from '@milkdown/kit/component/diff';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import type { CmdKey } from '@milkdown/kit/core';
import {
  acceptAllDiffsCmd,
  clearDiffReviewCmd,
  diff,
  diffConfig,
  diffPluginKey,
  getPendingChanges,
  startDiffReviewCmd,
} from '@milkdown/kit/plugin/diff';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import { revisionHoverPlugin } from './revision-hover';

/** The outline adapter stamps heading ids into the document, so a diff that
 *  compared them would report every heading as changed. Milkdown writes every
 *  bullet list loose, whatever the list was, so a proposal that went through
 *  its serializer would report every tight list as changed; whether a list is
 *  loose is spacing, not a change a reader should have to reject. */
const IGNORED_ATTRIBUTES = {
  bullet_list: ['spread'],
  heading: ['id'],
  list_item: ['spread'],
  ordered_list: ['spread'],
};
/** Node types drawn by a custom node view, which inline decorations cannot
 *  reach: their changes are merged into one block-level replacement. */
const CUSTOM_BLOCK_TYPES = ['table', 'image-block', 'code_block'];

const pendingWatchKey = new PluginKey('STASHBASE_REVISION_PENDING');

/** How many changes the review on `view` still has to decide. Zero covers both
 *  a review with nothing left and no review at all. */
function pendingIn(view: EditorView): number {
  const state = diffPluginKey.getState(view.state);
  return state ? getPendingChanges(state).length : 0;
}

export interface RevisionSurface {
  /** Takes every change still pending, which edits the document and so runs
   *  through the ordinary dirty and autosave path. */
  undoAll(): void;
  /** Ends the review without reserializing: the source stays byte-identical
   *  unless something was accepted. */
  clear(): void;
  /** Compare the saved document with its pre-turn body. A review without
   *  any changes reports zero instead of leaving the editor locked. */
  start(beforeBody: string): void;
}

/**
 * Registers the review plugins on `editor` and reports the pending-change
 * count whenever it moves. Call before `create()`; the returned commands are
 * usable once the editor is ready.
 */
export function attachRevisionReview(
  editor: CrepeBuilder,
  reportPending: (pending: number) => void,
): RevisionSurface {
  /** Null while a review has been started and no count has gone out for it
   *  yet, so its first count reaches the caller even when that count is zero.
   *  A plain number could not: zero is also what the watcher last sent before
   *  any review existed. */
  let lastReported: number | null = 0;
  const publish = (view: EditorView) => {
    const pending = pendingIn(view);
    if (pending === lastReported) return;
    lastReported = pending;
    reportPending(pending);
  };

  editor.editor
    .config((context) => {
      context.update(diffConfig.key, (previous) => ({
        ...previous,
        ignoreAttrs: IGNORED_ATTRIBUTES,
      }));
      context.update(diffComponentConfig.key, (previous) => ({
        ...previous,
        customBlockTypes: CUSTOM_BLOCK_TYPES,
        acceptLabel: 'Undo',
        rejectLabel: 'Keep',
      }));
    })
    .use(diff)
    .use(diffComponent)
    .use(revisionHoverPlugin())
    .use(
      $prose(
        () =>
          new Plugin({
            key: pendingWatchKey,
            view: (view) => {
              publish(view);
              return { update: publish };
            },
          }),
      ),
    );

  const run = <Payload>(command: { key: CmdKey<Payload> }, payload?: Payload) => {
    editor.editor.action((context) => {
      context.get(commandsCtx).call(command.key, payload);
    });
  };
  const pendingNow = () => editor.editor.action((context) => pendingIn(context.get(editorViewCtx)));

  return {
    undoAll: () => run(acceptAllDiffsCmd),
    clear: () => run(clearDiffReviewCmd),
    start: (beforeBody) => {
      lastReported = null;
      run(startDiffReviewCmd, beforeBody);
      // A proposal that parses to the document it revises opens a review with
      // nothing in it, and upstream's start returns before the auto-deactivate
      // every other action falls through to. The plugin is then active with no
      // change to resolve: its transaction filter blocks every edit and it
      // draws no control, which is the document frozen with nothing to click.
      // The callers that refuse an empty proposal compare Markdown text, and
      // one document has many spellings, so neither of them can see this
      // coming. Here is where both the proposal and the count it produced are
      // known, so here is where it ends.
      if (pendingNow() === 0) run(clearDiffReviewCmd);
    },
  };
}

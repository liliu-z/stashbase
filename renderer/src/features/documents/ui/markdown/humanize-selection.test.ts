/**
 * What Humanize hands the service and what it makes of the answer, proven
 * against the real Milkdown build: the selection widens to whole blocks,
 * refuses blocks that are not prose, and the rewrite lands in exactly the
 * selection's place in a whole-document proposal. Ask Agent, by contrast,
 * takes exactly what is selected, code included.
 */
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { diffComponent, diffComponentConfig } from '@milkdown/kit/component/diff';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import {
  diff,
  diffConfig,
  diffPluginKey,
  getPendingChanges,
  startDiffReviewCmd,
} from '@milkdown/kit/plugin/diff';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { humanizeProposal, humanizeTarget } from './humanize-selection';
import { selectedMarkdown } from './selection-markdown';

const SOURCE =
  '# Title\n\nThe first line.\n\nThe second line, comprehensively.\n\n```js\nconst code = 1;\n```\n\n- one\n- two\n';

interface Probe {
  action<T>(run: (ctx: Ctx) => T): T;
  destroy(): Promise<unknown>;
  /** The live document as the editor itself spells it. */
  markdown(): string;
  /** Opens a review on `proposal` and answers how many changes it holds. */
  review(proposal: string): number;
  select(text: string, through?: string): void;
}

const live: Probe[] = [];

afterEach(async () => {
  for (const probe of live.splice(0)) await probe.destroy();
});

async function openProbe(source = SOURCE): Promise<Probe> {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new CrepeBuilder({ root: host, defaultValue: source });
  // The review plugins the surface registers, so a proposal here is judged
  // by the same diff the reader would see.
  editor.editor
    .config((context) => {
      context.update(diffConfig.key, (previous) => ({
        ...previous,
        ignoreAttrs: {
          bullet_list: ['spread'],
          heading: ['id'],
          list_item: ['spread'],
          ordered_list: ['spread'],
        },
      }));
      context.update(diffComponentConfig.key, (previous) => ({
        ...previous,
        customBlockTypes: ['table', 'image-block', 'code_block'],
      }));
    })
    .use(diff)
    .use(diffComponent);
  await editor.create();
  const action = <T>(run: (ctx: Ctx) => T): T => editor.editor.action(run);
  /** The document position where `text` starts, found in the live document
   *  rather than counted by hand. */
  const positionOf = (text: string): number =>
    action((ctx) => {
      const { doc } = ctx.get(editorViewCtx).state;
      let found = -1;
      doc.descendants((node, pos) => {
        if (found >= 0 || !node.isText || !node.text?.includes(text)) return found < 0;
        found = pos + node.text.indexOf(text);
        return false;
      });
      if (found < 0) throw new Error(`"${text}" is not in the document`);
      return found;
    });
  const probe: Probe = {
    action,
    destroy: () => editor.destroy(),
    markdown: () => editor.getMarkdown(),
    review(proposal) {
      return action((ctx) => {
        ctx.get(commandsCtx).call(startDiffReviewCmd.key, proposal);
        const state = diffPluginKey.getState(ctx.get(editorViewCtx).state);
        return state ? getPendingChanges(state).length : 0;
      });
    },
    select(text, through = text) {
      const from = positionOf(text);
      const to = positionOf(through) + through.length;
      action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
      });
    },
  };
  live.push(probe);
  return probe;
}

describe('humanize target', () => {
  it('widens a few selected words to the whole paragraph they sit in', async () => {
    const probe = await openProbe();
    probe.select('second line');

    const target = probe.action(humanizeTarget);

    expect(target).not.toBeTypeOf('string');
    if (typeof target === 'string') return;
    expect(target.markdown.trim()).toBe('The second line, comprehensively.');
  });

  it('takes every block a selection crosses, headings and lists included', async () => {
    const probe = await openProbe();
    probe.select('Title', 'first');

    const target = probe.action(humanizeTarget);

    expect(target).not.toBeTypeOf('string');
    if (typeof target === 'string') return;
    expect(target.markdown.trim()).toBe('# Title\n\nThe first line.');

    probe.select('one', 'two');
    const list = probe.action(humanizeTarget);
    // The editor spells a list its own way; what matters is that both items
    // went and nothing else did.
    expect(typeof list === 'string' ? list : list.markdown.trim()).toMatch(
      /^[-*] one\n\n?[-*] two$/u,
    );
  });

  it('refuses a selection that reaches into a code block, and an empty one', async () => {
    const probe = await openProbe();
    probe.select('comprehensively', 'code');
    expect(probe.action(humanizeTarget)).toBe('not-prose');

    probe.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1)));
    });
    expect(probe.action(humanizeTarget)).toBe('empty');
  });
});

describe('humanize proposal', () => {
  it("puts the rewrite in the selection's place and leaves the rest of the document alone", async () => {
    const probe = await openProbe();
    probe.select('second line');
    const target = probe.action(humanizeTarget);
    if (typeof target === 'string') throw new Error(target);

    const proposal = probe.action((ctx) =>
      humanizeProposal(ctx, target, 'The second line, plainly.\n'),
    );

    // Spelled the way the editor spells the rest, so the only difference the
    // review can find is the one paragraph. The list beyond the code block is
    // the case that would betray a spelling drift: the editor writes it loose.
    expect(proposal).toBe(
      probe.markdown().replace('The second line, comprehensively.', 'The second line, plainly.'),
    );
    expect(probe.review(proposal)).toBe(1);
  });

  it('may answer one paragraph with two, and reports a rewrite that changes nothing', async () => {
    const probe = await openProbe();
    probe.select('first line');
    const target = probe.action(humanizeTarget);
    if (typeof target === 'string') throw new Error(target);

    const split = probe.action((ctx) => humanizeProposal(ctx, target, 'One.\n\nTwo.\n'));
    expect(split).toContain('# Title\n\nOne.\n\nTwo.\n\nThe second line');

    expect(probe.action((ctx) => humanizeProposal(ctx, target, 'The first line.'))).toBe(
      'unchanged',
    );
    expect(probe.action((ctx) => humanizeProposal(ctx, target, '   \n'))).toBe('unusable');
  });
});

describe('selected markdown', () => {
  it('takes exactly the selected words, not the paragraph around them', async () => {
    const probe = await openProbe();
    probe.select('second line');

    expect(probe.action(selectedMarkdown)).toBe('second line');
  });

  it('keeps the blocks a selection crosses, code included', async () => {
    const probe = await openProbe();
    probe.select('Title', 'first');
    expect(probe.action(selectedMarkdown)).toBe('# Title\n\nThe first');

    probe.select('comprehensively', 'code');
    expect(probe.action(selectedMarkdown)).toBe('comprehensively.\n\n```js\nconst code\n```');
  });

  it('answers nothing for an empty or whitespace-only selection', async () => {
    const probe = await openProbe();
    const selectRange = (from: number, to: number) =>
      probe.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
      });
    selectRange(1, 1);
    expect(probe.action(selectedMarkdown)).toBeNull();

    probe.select('The first line.');
    const end = probe.action((ctx) => ctx.get(editorViewCtx).state.selection.to);
    // The gap between two paragraphs holds no text at all.
    selectRange(end, end + 2);
    expect(probe.action(selectedMarkdown)).toBeNull();
  });
});

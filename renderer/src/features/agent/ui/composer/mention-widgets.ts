/** What a marker looks like. Each chip is built as DOM for the editor's own
 *  document — never a global one — so the composer renders correctly inside a
 *  detached window, and each announces itself in the text layer because the
 *  chip carries no role of its own. The decoration set that maps markers onto
 *  these widgets lives here too, since it is the only reader of both. */
import { EditorView, WidgetType, type DecorationSet, Decoration } from '@codemirror/view';

import type { ContextStatus } from '@/features/agent/domain/context';
import { shapeTokens } from '@/lib/shape-context';
import { prefersReducedMotion } from '@/shared/runtime/appearance-surface';
import { basePathName } from '@/shared/utils/file-path';

import { mentionField, statusField } from './mention-markers';

/** The word a bound source wears while it is not ready. The chip in the
 *  editor and the tile below it are naming the same state, so they read it
 *  from one map. */
export const STATUS_WORD: Record<ContextStatus, string> = {
  blocked: 'Blocked',
  failed: 'Failed',
  preparing: 'Preparing',
  ready: 'Ready',
  stale: 'Stale',
};

const CHIP_CLASS = `mx-px inline-flex max-w-full items-center gap-1 ${shapeTokens.chip} bg-foreground/8 px-1.5 align-baseline font-medium whitespace-nowrap text-foreground`;

function popIn(chip: HTMLElement, root: Document) {
  if (typeof chip.animate !== 'function' || prefersReducedMotion(root.defaultView)) return;
  chip.animate(
    [
      { opacity: 0, transform: 'scale(0.92)' },
      { opacity: 1, transform: 'scale(1)' },
    ],
    { duration: 80, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
  );
}

class SkillWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly fresh: boolean,
  ) {
    super();
  }

  override eq(other: SkillWidget) {
    return this.label === other.label;
  }

  override toDOM(view: EditorView) {
    const root = view.dom.ownerDocument;
    const chip = root.createElement('span');
    chip.className = CHIP_CLASS;
    chip.setAttribute('data-skill', this.label);

    const name = root.createElement('span');
    name.textContent = `/${this.label}`;
    chip.append(name);

    const spoken = root.createElement('span');
    spoken.className = 'sr-only';
    spoken.textContent = ` (selected skill: ${this.label})`;
    chip.append(spoken);

    if (this.fresh) popIn(chip, root);
    return chip;
  }

  override ignoreEvent() {
    return false;
  }
}

class MentionWidget extends WidgetType {
  constructor(
    private readonly path: string,
    private readonly status: ContextStatus,
    private readonly fresh: boolean,
  ) {
    super();
  }

  override eq(other: MentionWidget) {
    return this.path === other.path && this.status === other.status;
  }

  override toDOM(view: EditorView) {
    // The widget builds DOM for the editor's own document, never a global.
    const root = view.dom.ownerDocument;
    const chip = root.createElement('span');
    chip.className = CHIP_CLASS;
    chip.title = this.path;
    chip.setAttribute('data-mention', this.path);

    const glyph = root.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glyph.setAttribute('width', '12');
    glyph.setAttribute('height', '12');
    glyph.setAttribute('viewBox', '0 0 24 24');
    glyph.setAttribute('fill', 'none');
    glyph.setAttribute('stroke', 'currentColor');
    glyph.setAttribute('stroke-width', '1.5');
    glyph.setAttribute('stroke-linecap', 'round');
    glyph.setAttribute('stroke-linejoin', 'round');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.classList.add('shrink-0', 'text-muted-foreground');
    for (const d of ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5']) {
      const path = root.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      glyph.append(path);
    }
    chip.append(glyph);

    const name = root.createElement('span');
    name.textContent = basePathName(this.path);
    chip.append(name);

    if (this.status !== 'ready') {
      const dot = root.createElement('span');
      const alarming = this.status === 'stale' || this.status === 'failed';
      dot.className = `size-1.5 shrink-0 rounded-full ${alarming ? 'bg-destructive' : 'bg-muted-foreground'}`;
      dot.title = STATUS_WORD[this.status];
      dot.setAttribute('aria-hidden', 'true');
      chip.append(dot);
    }

    // The chip has no role, so a label on it would be dropped; the full
    // path travels in the text layer instead.
    const spoken = root.createElement('span');
    spoken.className = 'sr-only';
    spoken.textContent =
      this.status === 'ready'
        ? ` (file mention: ${this.path})`
        : ` (file mention: ${this.path}, ${STATUS_WORD[this.status].toLowerCase()})`;
    chip.append(spoken);

    if (this.fresh) popIn(chip, root);
    return chip;
  }

  override ignoreEvent() {
    return false;
  }
}

export const mentionDecorations = EditorView.decorations.compute(
  [mentionField, statusField],
  (state): DecorationSet => {
    const statuses = state.field(statusField);
    const decorations: ReturnType<Decoration['range']>[] = [];
    state.field(mentionField).between(0, state.doc.length, (from, to, mention) => {
      decorations.push(
        Decoration.replace({
          widget:
            mention.kind === 'skill'
              ? new SkillWidget(mention.path, mention.fresh)
              : new MentionWidget(mention.path, statuses[mention.path] ?? 'ready', mention.fresh),
        }).range(from, to),
      );
    });
    return Decoration.set(decorations, true);
  },
);

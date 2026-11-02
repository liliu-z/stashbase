import { TooltipProvider } from '@milkdown/kit/plugin/tooltip';
/**
 * A single-dollar formula can be a misread price or variable. While the caret
 * is in one, a small toolbar above it offers to keep it as text: this one, or
 * every single-dollar formula in the document at once. Either escapes the
 * dollar signs in the source, so the file reads the same in any Markdown tool,
 * and one Undo restores the formulas.
 */
import { posToDOMRect } from '@milkdown/kit/prose';
import { Plugin, PluginKey, type EditorState, type PluginView } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import { singleDollarFormulas } from './math-presentation';
import type { MathSourceRange } from './math-source';

const offerKey = new PluginKey('stashbase-math-text-offer');

function formulaAtCaret(state: EditorState): MathSourceRange | undefined {
  const { from, to } = state.selection;
  if (from !== to) return undefined;
  return singleDollarFormulas(state).find((range) => from > range.from && from < range.to);
}

/** One transaction, so one Undo returns every formula. Later ranges first,
 *  so earlier positions stay valid. */
function keepAsText(view: EditorView, ranges: MathSourceRange[]): void {
  const transaction = view.state.tr;
  for (const range of ranges.toSorted((a, b) => b.from - a.from)) {
    transaction.insertText('\\', range.to - 1);
    transaction.insertText('\\', range.from);
  }
  view.dispatch(transaction.scrollIntoView());
  view.focus();
}

function item(ownerDocument: Document, onAct: () => void) {
  const button = ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'markdown-math-offer-item';
  const label = ownerDocument.createElement('span');
  label.className = 'markdown-toolbar-label';
  button.append(label);
  button.addEventListener('click', onAct);
  return { button, label };
}

class MathTextOffer implements PluginView {
  private readonly element: HTMLElement;
  private readonly one: ReturnType<typeof item>;
  private readonly all: ReturnType<typeof item>;
  private readonly divider: HTMLElement;
  private readonly provider: TooltipProvider;
  private readonly refresh = () => this.update(this.view);

  constructor(private view: EditorView) {
    const ownerDocument = view.dom.ownerDocument;
    this.element = ownerDocument.createElement('div');
    this.element.className = 'markdown-math-offer';
    this.element.setAttribute('role', 'toolbar');
    this.element.setAttribute('aria-label', 'Formula');
    // Keep the caret, and so this offer, in place while a button is pressed.
    this.element.addEventListener('mousedown', (event) => event.preventDefault());
    this.one = item(ownerDocument, () => {
      const formula = formulaAtCaret(this.view.state);
      if (formula) keepAsText(this.view, [formula]);
    });
    this.all = item(ownerDocument, () =>
      keepAsText(this.view, singleDollarFormulas(this.view.state)),
    );
    this.divider = ownerDocument.createElement('span');
    this.divider.className = 'markdown-math-offer-divider';
    this.one.label.textContent = 'Show as text';
    this.element.append(this.one.button, this.divider, this.all.button);
    this.provider = new TooltipProvider({
      content: this.element,
      offset: 8,
      shift: { padding: 8 },
    });
    (view.dom.parentElement ?? ownerDocument.body).append(this.element);
    view.dom.addEventListener('focus', this.refresh);
    view.dom.addEventListener('blur', this.refresh);
    this.update(view);
  }

  update(view: EditorView): void {
    this.view = view;
    const formula = view.editable && view.hasFocus() ? formulaAtCaret(view.state) : undefined;
    if (!formula) {
      this.provider.hide();
      return;
    }
    const count = singleDollarFormulas(view.state).length;
    this.all.label.textContent = `Show all as text (${count})`;
    this.all.button.hidden = count < 2;
    this.divider.hidden = count < 2;
    this.provider.show(
      { getBoundingClientRect: () => posToDOMRect(view, formula.from, formula.to) },
      view,
    );
  }

  destroy(): void {
    this.view.dom.removeEventListener('focus', this.refresh);
    this.view.dom.removeEventListener('blur', this.refresh);
    this.provider.destroy();
    this.element.remove();
  }
}

export function mathTextOffer() {
  return $prose(() => new Plugin({ key: offerKey, view: (view) => new MathTextOffer(view) }));
}

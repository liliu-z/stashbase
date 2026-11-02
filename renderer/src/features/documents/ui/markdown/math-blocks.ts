/**
 * Formula blocks own only their disclosure and preview. Milkdown's CodeMirror
 * node view still owns source edits, selection and ProseMirror history; mode
 * changes refresh the disclosure without reparsing or editing the document.
 */
import { EditorView as CodeMirror } from '@codemirror/view';
import { CodeMirrorBlock } from '@milkdown/kit/component/code-block';
import { nodeViewCtx } from '@milkdown/kit/core';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import type { NodeView } from '@milkdown/kit/prose/view';
import { $prose, $view } from '@milkdown/kit/utils';

import { renderMath } from './math-presentation';

function isMath(node: ProseMirrorNode): boolean {
  return /^(?:latex|math)$/iu.test(String(node.attrs.language));
}

class MathBlock implements NodeView {
  readonly dom: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly source: HTMLElement;
  private readonly done: HTMLButtonElement;
  private editing = false;
  private editable: boolean;

  constructor(
    private readonly block: CodeMirrorBlock,
    private readonly dispose: () => void,
  ) {
    const owner = block.dom.ownerDocument;
    this.dom = owner.createElement('div');
    this.preview = owner.createElement('div');
    this.source = owner.createElement('div');
    this.done = owner.createElement('button');
    this.editable = block.view.editable;
    // The upstream node view mounts CodeMirror lazily. Configure it before that
    // mount, and keep its raw placeholder hidden even when it is off screen.
    block.config = {
      ...block.config,
      extensions: [...block.config.extensions, CodeMirror.lineWrapping],
      renderPreview: () => null,
    };
    this.dom.className = 'stashbase-math-block';
    this.dom.contentEditable = 'false';
    this.preview.className = 'stashbase-math-block-preview';
    this.source.className = 'stashbase-math-block-source';
    this.done.type = 'button';
    this.done.textContent = 'Done editing formula';
    this.done.addEventListener('click', () => {
      this.collapse();
      this.preview.focus();
    });
    this.preview.addEventListener('click', () => this.edit());
    this.preview.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.edit();
    });
    this.source.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.collapse();
      this.preview.focus();
    });
    this.source.append(block.dom, this.done);
    this.dom.append(this.preview, this.source);
    this.render();
    this.sync();
  }

  private render(): void {
    if (this.block.node.textContent) {
      this.preview.innerHTML = renderMath(this.block.node.textContent, true);
    } else {
      this.preview.textContent = 'Empty formula';
    }
  }

  private collapse(): void {
    this.editing = false;
    this.source.hidden = true;
    this.preview.hidden = false;
  }

  private edit(): void {
    const { view, getPos } = this.block;
    const position = getPos();
    if (!view.editable || position === undefined) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position + 1)));
    this.setSelection(0, 0);
  }

  sync(): void {
    const { view } = this.block;
    if (this.editable !== view.editable) {
      this.editable = view.editable;
      // A mode change need not update the node. Refresh the native source
      // editor's readonly compartment even when its document is unchanged.
      this.block.update(this.block.node);
    }
    if (view.editable) {
      this.preview.setAttribute('role', 'button');
      this.preview.setAttribute('aria-label', 'Edit formula');
      this.preview.tabIndex = 0;
    } else {
      this.preview.removeAttribute('role');
      this.preview.removeAttribute('aria-label');
      this.preview.removeAttribute('tabindex');
    }
    if (!view.editable || !this.editing) this.collapse();
  }

  setSelection(anchor: number, head: number): void {
    if (!this.block.view.editable) return;
    this.editing = true;
    this.preview.hidden = true;
    this.source.hidden = false;
    this.block.setSelection(anchor, head);
  }

  update(node: ProseMirrorNode): boolean {
    if (!isMath(node)) return false;
    const changed = node.textContent !== this.block.node.textContent;
    if (!this.block.update(node)) return false;
    if (changed) this.render();
    return true;
  }

  selectNode(): void {
    if (this.block.view.editable) {
      this.setSelection(0, this.block.node.content.size);
      this.block.selectNode();
    }
  }

  deselectNode(): void {
    this.block.deselectNode();
  }

  stopEvent(event: Event): boolean {
    // CodeMirror handles its own keys. A focused formula preview still uses
    // the document's keyboard commands, including Undo after closing source.
    return (
      event.type !== 'keydown' ||
      (event.target instanceof Node && this.block.dom.contains(event.target))
    );
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dispose();
    this.block.destroy();
  }
}

/** Register after codeMirror so non-math blocks keep their existing view. */
export function mathBlocks() {
  const blocks = new Set<MathBlock>();
  return [
    $view(codeBlockSchema.node, (context) => {
      const original = context
        .get(nodeViewCtx)
        .findLast(([name]) => name === codeBlockSchema.type(context).name)?.[1];
      if (!original) throw new Error('Math blocks require the CodeMirror feature.');
      return (...args) => {
        const block = original(...args);
        if (!isMath(args[0]) || !(block instanceof CodeMirrorBlock)) {
          const update = block.update?.bind(block);
          block.update = (node, decorations, innerDecorations) =>
            !isMath(node) && Boolean(update?.(node, decorations, innerDecorations));
          return block;
        }
        const formula = new MathBlock(block, () => blocks.delete(formula));
        blocks.add(formula);
        return formula;
      };
    }),
    $prose(
      () => new Plugin({ view: () => ({ update: () => blocks.forEach((block) => block.sync()) }) }),
    ),
  ];
}

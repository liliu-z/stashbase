/** Preserve Milkdown's list editing while exposing one list item per source node. */
import { nodeViewCtx, type Editor } from '@milkdown/kit/core';
import { listItemSchema } from '@milkdown/kit/preset/commonmark';
import { $view } from '@milkdown/kit/utils';

/** The native view wraps its <li> in a <div>. Put the list-item role on that
 * direct list child and make the nested <li> presentational, retaining the
 * native contentDOM, selection, checkbox behavior and disposal. */
export function listItemSemantics(editor: Editor): void {
  editor.use(
    $view(listItemSchema.node, (context) => {
      const original = context
        .get(nodeViewCtx)
        .findLast(([name]) => name === listItemSchema.type(context).name)?.[1];
      if (!original) throw new Error('List semantics require the list-item feature.');
      return (...args) => {
        const item = original(...args);
        if (item.dom instanceof HTMLElement) {
          item.dom.setAttribute('role', 'listitem');
          const nested = item.dom.firstElementChild;
          if (nested?.tagName === 'LI') nested.setAttribute('role', 'presentation');
        }
        return item;
      };
    }),
  );
}

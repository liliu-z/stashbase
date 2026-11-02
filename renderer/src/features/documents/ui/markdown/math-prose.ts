/** Presents ordinary inline Markdown over editable source while preserving its original bytes. */
import { sanitizeLinkHref } from '@milkdown/kit/preset/commonmark';
import { DOMSerializer } from '@milkdown/kit/prose/model';
import { Decoration } from '@milkdown/kit/prose/view';
import type { RemarkParser } from '@milkdown/kit/transformer';

export type { RemarkParser } from '@milkdown/kit/transformer';

export interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  alt?: string | null;
  identifier?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const tags: Record<string, string> = { strong: 'strong', emphasis: 'em', delete: 'del' };

/** Keep micromark's original positions. Milkdown's later transforms resolve
 * reference links and replace soft breaks with nodes without source offsets. */
export function parseMathProse(
  source: string,
  parser: RemarkParser,
  references = '',
): MarkdownNode {
  return parser.parse(references ? `${source}\n\n${references}` : source) as MarkdownNode;
}

/** Let the existing Markdown writer escape destinations and titles while the
 * editor retains the source spelling of an already parsed link label. */
export function markdownLinkParts(parser: RemarkParser, url: string, title?: string | null) {
  const label = 'STASHBASELINKLABEL';
  const written = parser
    .stringify({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url,
              title: title ?? null,
              children: [{ type: 'text', value: label }],
            },
          ],
        },
      ],
    })
    .trimEnd();
  const at = written.indexOf(label);
  return { before: written.slice(0, at), after: written.slice(at + label.length) };
}

/** Present ordinary inline Markdown in protected source without replacing its
 * editable characters. Parsing the whole run also covers markup whose closing
 * delimiter lies outside the single-dollar span. */
export function mathProseDecorations(
  source: string,
  from: number,
  parser: RemarkParser,
  selectionFrom: number,
  selectionTo: number,
  tree = parseMathProse(source, parser),
): Decoration[] {
  const decorations: Decoration[] = [];
  const definitions = new Map<string, MarkdownNode>();
  const collectDefinitions = (node: MarkdownNode) => {
    if (
      node.type === 'definition' &&
      node.identifier &&
      !definitions.has(node.identifier.toUpperCase())
    )
      definitions.set(node.identifier.toUpperCase(), node);
    node.children?.forEach(collectDefinitions);
  };
  collectDefinitions(tree);
  const hide = (start: number, end: number) => {
    if (start < end)
      decorations.push(
        Decoration.inline(from + start, from + end, { class: 'stashbase-math-source' }),
      );
  };
  const editing = (start: number, end: number) =>
    selectionFrom === selectionTo && selectionFrom > from + start && selectionFrom < from + end;
  const replace = (start: number, end: number, value: string) => {
    hide(start, end);
    decorations.push(
      Decoration.widget(
        from + start,
        (view) => {
          const element = view.dom.ownerDocument.createElement('span');
          element.textContent = value;
          element.dataset.mathFrom = String(from + start);
          return element;
        },
        { key: `math-prose:${from + start}:${end}:${value}`, side: -1 },
      ),
    );
  };
  const lineBreak = (start: number, end: number, inline: boolean) => {
    hide(start, end);
    decorations.push(
      Decoration.widget(
        from + start,
        (view) => {
          const ownerDocument = view.dom.ownerDocument;
          const type = view.state.schema.nodes.hardbreak;
          return type
            ? DOMSerializer.fromSchema(view.state.schema).serializeNode(
                type.create({ isInline: inline }),
                { document: ownerDocument },
              )
            : ownerDocument.createElement('br');
        },
        { key: `math-prose-break:${from + start}:${end}`, side: -1 },
      ),
    );
  };
  const decodeText = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (
        source[index] === '\\' &&
        /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/u.test(source[index + 1] ?? '')
      ) {
        if (!editing(index, index + 2)) hide(index, index + 1);
        index += 1;
      } else if (source[index] === '\r' || source[index] === '\n') {
        const size = source.startsWith('\r\n', index) ? 2 : 1;
        let begin = index;
        while (begin > start && /[\t ]/u.test(source[begin - 1] ?? '')) begin -= 1;
        lineBreak(begin, index + size, true);
        index += size - 1;
      } else if (source[index] === '&') {
        const entity = /^&(?:#[0-9]{1,7}|#x[\da-f]{1,6}|[a-z][a-z0-9]{1,31});/iu.exec(
          source.slice(index, end),
        );
        if (!entity) continue;
        const parsed = parser.parse(entity[0]) as MarkdownNode;
        const decoded = parsed.children?.[0]?.children?.[0]?.value;
        if (decoded && decoded !== entity[0] && !editing(index, index + entity[0].length)) {
          replace(index, index + entity[0].length, decoded);
        }
        index += entity[0].length - 1;
      }
    }
  };
  const visit = (node: MarkdownNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start !== 'number' || typeof end !== 'number') {
      node.children?.forEach(visit);
      return;
    }
    if (start >= source.length) return;
    if (node.type === 'text') {
      decodeText(start, end);
      return;
    }
    if (node.type === 'inlineMath' && source.slice(start, end) === '\\$') {
      decodeText(start, end);
      return;
    }
    if (node.type === 'break') {
      if (!editing(start, end)) lineBreak(start, end, false);
      return;
    }
    if (node.type === 'inlineCode') {
      if (editing(start, end)) return;
      const ticks = /^`+/u.exec(source.slice(start, end))?.[0].length ?? 0;
      let innerStart = start + ticks;
      let innerEnd = end - ticks;
      const content = source.slice(innerStart, innerEnd).replace(/\r\n?|\n/gu, ' ');
      if (content.startsWith(' ') && content.endsWith(' ') && /[^ ]/u.test(content)) {
        innerStart += source.startsWith('\r\n', innerStart) ? 2 : 1;
        innerEnd -= source.slice(innerEnd - 2, innerEnd) === '\r\n' ? 2 : 1;
      }
      hide(start, innerStart);
      hide(innerEnd, end);
      if (innerStart < innerEnd)
        decorations.push(
          Decoration.inline(from + innerStart, from + innerEnd, { nodeName: 'code' }),
        );
      for (let index = innerStart; index < innerEnd; index += 1) {
        if (source[index] !== '\r' && source[index] !== '\n') continue;
        const size = source.startsWith('\r\n', index) ? 2 : 1;
        replace(index, index + size, ' ');
        index += size - 1;
      }
      return;
    }
    const reference = node.identifier ? definitions.get(node.identifier.toUpperCase()) : undefined;
    if (node.type === 'image' || (node.type === 'imageReference' && reference)) {
      if (editing(start, end)) return;
      const image = reference ?? node;
      hide(start, end);
      decorations.push(
        Decoration.widget(
          from + start,
          (view) => {
            const ownerDocument = view.dom.ownerDocument;
            const type = view.state.schema.nodes.image;
            if (!type) return ownerDocument.createTextNode(node.alt ?? '');
            const element = DOMSerializer.fromSchema(view.state.schema).serializeNode(
              type.create({ src: image.url ?? '', alt: node.alt ?? '', title: image.title ?? '' }),
              { document: ownerDocument },
            );
            if (element.nodeType === 1) {
              (element as HTMLElement).dataset.mathFrom = String(from + start);
            }
            return element;
          },
          { key: `math-prose-image:${from + start}:${source.slice(start, end)}`, side: -1 },
        ),
      );
      return;
    }
    const link = node.type === 'link' || (node.type === 'linkReference' && reference);
    const tag = link ? 'a' : tags[node.type];
    if (tag) {
      if (editing(start, end)) return;
      const children = node.children ?? [];
      const innerStart = children[0]?.position?.start.offset;
      const innerEnd = children.at(-1)?.position?.end.offset;
      if (typeof innerStart === 'number' && typeof innerEnd === 'number') {
        hide(start, innerStart);
        hide(innerEnd, end);
        const target = reference ?? node;
        if (innerStart < innerEnd)
          decorations.push(
            Decoration.inline(from + innerStart, from + innerEnd, {
              nodeName: tag,
              ...(link
                ? {
                    href: sanitizeLinkHref(target.url),
                    ...(target.title ? { title: target.title } : {}),
                  }
                : {}),
            }),
          );
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return decorations;
}

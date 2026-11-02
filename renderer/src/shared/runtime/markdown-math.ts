/**
 * Shared Markdown math syntax for Chat and Documents. Micromark protects TeX
 * before CommonMark decodes escapes; original positions support exact copying,
 * and Documents can retain editable inline source with container prefixes removed.
 */
import type { RemarkPluginRaw } from '@milkdown/kit/transformer';
import remarkMath from 'remark-math';

/** Tokenize LaTeX before CommonMark can consume escapes or emphasis. Using a
 * text construct lets the Markdown parser own code spans, fences and nesting. */
type Parser = ThisParameterType<RemarkPluginRaw<MathSyntaxOptions>>;
const dataOf = (parser: Parser) => parser.data();
type ParserData = ReturnType<typeof dataOf>;
type SyntaxExtension = NonNullable<ParserData['micromarkExtensions']>[number];
type Construct = Exclude<
  NonNullable<NonNullable<SyntaxExtension['text']>[number]>,
  readonly unknown[]
>;
type State = ReturnType<Construct['tokenize']>;
type FromExtension = Exclude<NonNullable<ParserData['fromMarkdownExtensions']>[number], unknown[]>;
type FromHandler = NonNullable<FromExtension['exit']>[string];

/** Capture inline source from micromark's content stream. Unlike slicing file
 * offsets, this excludes list/quote continuation prefixes on subsequent lines. */
const captureSource: FromHandler = function (token) {
  const node = this.stack.at(-1);
  if (node) node.data = Object.assign(node.data ?? {}, { mathSource: this.sliceSerialize(token) });
};
const captureAndExit: FromHandler = function (token) {
  captureSource.call(this, token);
  this.exit(token);
};

function sourceMath(singleDollar: boolean): Construct {
  return {
    name: 'stashbaseMath',
    tokenize(effects, ok, nok) {
      let closing = 0;
      let multiline = false;
      let dollars = 0;
      let closingDollars = 0;
      // remark-math registers these handlers at runtime but does not export
      // the corresponding token-map augmentation from its public types.
      type Token = Parameters<typeof effects.enter>[0];
      return start;
      function start(code: number | null): ReturnType<State> {
        effects.enter('mathText' as Token);
        effects.enter('mathTextData' as Token);
        effects.consume(code);
        if (code === 36) {
          dollars = 1;
          multiline = true;
          return dollarOpening;
        }
        return opening;
      }
      function dollarOpening(code: number | null): ReturnType<State> {
        if (code === 36) {
          dollars += 1;
          effects.consume(code);
          return dollarOpening;
        }
        if (dollars === 1 && !singleDollar) return nok(code);
        return content(code);
      }
      function opening(code: number | null): ReturnType<State> {
        if (code === 36) {
          effects.consume(code);
          return finish;
        }
        if (code !== 40 && code !== 91) return nok(code);
        closing = code === 40 ? 41 : 93;
        multiline = code === 91;
        effects.consume(code);
        return content;
      }
      function content(code: number | null): ReturnType<State> {
        if (code === null || (!multiline && code < -2)) return nok(code);
        if (code < -2) {
          effects.exit('mathTextData' as Token);
          effects.enter('lineEnding');
          effects.consume(code);
          effects.exit('lineEnding');
          return afterLine;
        }
        effects.consume(code);
        if (code === 92) return afterSlash;
        if (code === 36 && dollars) {
          closingDollars = 1;
          return dollarClosing;
        }
        return content;
      }
      function dollarClosing(code: number | null): ReturnType<State> {
        if (code === 36) {
          closingDollars += 1;
          effects.consume(code);
          return dollarClosing;
        }
        return closingDollars === dollars ? finish(code) : content(code);
      }
      function afterSlash(code: number | null): ReturnType<State> {
        if (code === closing) {
          effects.consume(code);
          return finish;
        }
        if (code === null || (!multiline && code < -2)) return nok(code);
        if (code < -2) return content(code);
        effects.consume(code);
        return content;
      }
      function afterLine(code: number | null): ReturnType<State> {
        if (code === null || code < -2) return nok(code);
        effects.enter('mathTextData' as Token);
        return content(code);
      }
      function finish(code: number | null): ReturnType<State> {
        effects.exit('mathTextData' as Token);
        effects.exit('mathText' as Token);
        return ok(code);
      }
    },
  };
}

export interface MathSyntaxOptions {
  singleDollarTextMath?: boolean;
  /** Editors retain editable source text, including delimiters and escapes. */
  sourceText?: boolean;
}

/** Shared syntax for the transcript and editable Markdown. Original positions
 * survive so copying and saving can retain the original spelling. */
export const remarkMathSyntax = function (this: Parser, options: MathSyntaxOptions = {}) {
  const sourceText = options.sourceText ?? false;
  const singleDollar = sourceText || options.singleDollarTextMath === true;
  remarkMath.call(this, { singleDollarTextMath: singleDollar });
  const data = dataOf(this);
  if (sourceText) {
    data.fromMarkdownExtensions ??= [];
    data.fromMarkdownExtensions.push({
      exit: {
        paragraph: captureAndExit,
        tableData: captureAndExit,
        tableHeader: captureAndExit,
        atxHeadingText: captureSource,
        setextHeadingText(token) {
          captureSource.call(this, token);
          this.data.setextHeadingSlurpLineEnding = true;
        },
      },
    });
    // Protected formulas have their own serializer. Ordinary unpaired dollar
    // amounts should keep the existing double-dollar-only escaping rules.
    const extension = data.toMarkdownExtensions?.at(-1);
    for (const unsafe of extension?.unsafe ?? []) {
      if (unsafe.character === '$' && unsafe.inConstruct === 'phrasing') unsafe.after = '\\$';
    }
  }
  const syntax = data.micromarkExtensions?.at(-1);
  if (syntax) syntax.text = { 36: sourceMath(singleDollar), 92: sourceMath(singleDollar) };
  return (tree: MathNode, file: { value: unknown }) => {
    const source = String(file.value);
    // Definitions are resolved away by the editor's ordinary remark pipeline.
    // Retain their source only as parsing context for editable inline runs.
    const definitions: string[] = [];
    if (sourceText) {
      const collect = (node: MathNode) => {
        if (node.type === 'definition') {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start !== undefined && end !== undefined) definitions.push(source.slice(start, end));
        }
        node.children?.forEach(collect);
      };
      collect(this.parse(source));
    }
    const visit = (node: MathNode): void => {
      if (node.type === 'inlineMath') {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const raw =
          node.value ?? (start === undefined || end === undefined ? '' : source.slice(start, end));
        if (raw === '\\$' || sourceText) {
          node.type = sourceText ? 'mathSource' : 'text';
          node.value = sourceText ? raw : '$';
          delete node.data;
        } else {
          const delimiter = raw.startsWith('$') ? (raw.match(/^\$+/u)?.[0].length ?? 1) : 2;
          node.value = raw.slice(delimiter, -delimiter);
          node.data = {
            hName: 'code',
            hProperties: {
              className: ['language-math', raw.startsWith('\\[') ? 'math-display' : 'math-inline'],
            },
            hChildren: [{ type: 'text', value: node.value }],
          };
        }
      }
      if (!sourceText && node.type === 'code' && /^(?:math|latex)$/iu.test(node.lang ?? '')) {
        node.lang = 'math';
      }
      node.children?.forEach(visit);
      const only = node.children?.length === 1 ? node.children[0] : undefined;
      if (
        sourceText &&
        node.type === 'paragraph' &&
        only?.type === 'mathSource' &&
        only.value?.startsWith('\\[')
      ) {
        node.type = 'math';
        node.value = only.value.slice(2, -2).replace(/^\n|\n$/gu, '');
        delete node.children;
      } else if (sourceText && node.children && typeof node.data?.mathSource === 'string') {
        const raw = node.data.mathSource;
        // Keep the complete inline run when syntax could change interpretation
        // with Math. Ordinary Markdown is presented from this same raw source.
        if (/\$|\\[([]|&(?:dollar|#0*36|#x0*24);/iu.test(raw)) {
          node.children = [
            { type: 'mathSource', value: raw, prose: true, references: definitions.join('\n') },
          ];
        }
      }
    };
    visit(tree);
  };
};

interface MathNode {
  type: string;
  value?: string | undefined;
  lang?: string | null | undefined;
  position?:
    | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
  data?:
    | {
        mathSource?: unknown;
        hName?: string | undefined;
        hProperties?: object | undefined;
        hChildren?: object[] | undefined;
      }
    | undefined;
  prose?: boolean;
  references?: string;
  children?: MathNode[] | undefined;
}

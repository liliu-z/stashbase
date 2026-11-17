/** Read Antigravity's file citations before Markdown interprets their paths.
 * A text construct keeps code examples literal and works on replay as well as
 * streamed replies, without rewriting the stored conversation. */
import {
  markdownParserData as dataOf,
  type MarkdownConstruct as Construct,
  type MarkdownParser as Parser,
} from '@/shared/runtime/markdown-parser';

const PREFIX = '[::cite_file{';
const TOKEN = 'stashbaseFileCitation';

function citation(source: string) {
  const match =
    /^\[::cite_file\{path="([^"\r\n]+)"(?:\s+lines="([1-9]\d*(?:-[1-9]\d*)?)")?\}::\]$/u.exec(
      source,
    );
  const path = match?.[1];
  if (!path) return null;
  const lines = match[2];
  const name = path.split(/[/\\]/u).at(-1) || path;
  return {
    url: encodeURIComponent(path),
    title: lines ? `${path}:${lines}` : path,
    label: lines ? `${name}:${lines}` : name,
  };
}

const fileCitation: Construct = {
  name: TOKEN,
  tokenize(effects, ok, nok) {
    let source = '';
    // This private token's compiler handlers are registered below.
    type Token = Parameters<typeof effects.enter>[0];
    const token = TOKEN as Token;
    return start;
    function start(code: number | null) {
      effects.enter(token);
      return consume(code);
    }
    function consume(code: number | null): ReturnType<ReturnType<Construct['tokenize']>> {
      if (code === null || code < 0) return nok(code);
      if (source.length < PREFIX.length && code !== PREFIX.charCodeAt(source.length)) {
        return nok(code);
      }
      source += String.fromCodePoint(code);
      effects.consume(code);
      if (source.endsWith('}::]')) {
        if (!citation(source)) return nok(code);
        effects.exit(token);
        return ok;
      }
      return consume;
    }
  },
};

export const remarkFileCitations = function (this: Parser) {
  const data = dataOf(this);
  (data.micromarkExtensions ??= []).push({ text: { 91: fileCitation } });
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      [TOKEN](token) {
        const source = this.sliceSerialize(token);
        const reference = citation(source);
        // A citation quoted as a link label must not create nested anchors.
        if (
          !reference ||
          this.stack.some((node) => node.type === 'link' || node.type === 'image')
        ) {
          this.enter({ type: 'text', value: source }, token);
          return;
        }
        this.enter(
          { type: 'link', url: reference.url, title: reference.title, children: [] },
          token,
        );
        this.enter({ type: 'text', value: reference.label }, token);
        this.exit(token);
      },
    },
    exit: {
      [TOKEN](token) {
        this.exit(token);
      },
    },
  });
};

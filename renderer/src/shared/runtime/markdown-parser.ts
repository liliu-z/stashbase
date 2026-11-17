/** Shared micromark types for syntax extensions hosted by Milkdown/remark. */
import type { RemarkPluginRaw } from '@milkdown/kit/transformer';

export type MarkdownParser = ThisParameterType<RemarkPluginRaw<undefined>>;
export const markdownParserData = (parser: MarkdownParser) => parser.data();
export type MarkdownParserData = ReturnType<typeof markdownParserData>;
type SyntaxExtension = NonNullable<MarkdownParserData['micromarkExtensions']>[number];
export type MarkdownConstruct = Exclude<
  NonNullable<NonNullable<SyntaxExtension['text']>[number]>,
  readonly unknown[]
>;

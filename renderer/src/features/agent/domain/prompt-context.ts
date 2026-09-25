/**
 * The bound context as the Agent reads it: each source resolved to the path
 * its runtime should open, each passage quoted, appended to the typed text.
 */
import type { AgentContextItem } from '@/features/agent/domain/context';

export interface ResolvedContextFile {
  path: string;
  sourcePath: string;
  readPath: string;
  kind: 'direct' | 'derived';
  sourceFormat: string;
  available: boolean;
  reason: string;
}

export interface ResolvedContextLine {
  item: AgentContextItem;
  resolved: ResolvedContextFile | null;
}

const PREPARED_FORMATS = new Set(['pdf', 'docx', 'audio']);

function absolutePath(item: AgentContextItem): string {
  return item.kind === 'transient' ? item.path : `${item.source.folderPath}/${item.source.path}`;
}

function contextLine({ item, resolved }: ResolvedContextLine): string {
  if (resolved?.kind === 'derived') {
    return `- ${resolved.sourcePath} (for text context, use mcp__stashbase__read_file with path ${resolved.path}; it returns the derived text representation for this ${resolved.sourceFormat})`;
  }
  if (resolved && !resolved.available && PREPARED_FORMATS.has(resolved.sourceFormat)) {
    return `- ${resolved.sourcePath} (derived text is not available yet; ${resolved.reason})`;
  }
  return `- ${absolutePath(item)}`;
}

/** Each passage as its file's path with the quote indented under it, one
 *  `> ` per line, which history replay reads back line by line. */
function passageLines(item: Extract<AgentContextItem, { kind: 'passage' }>): string {
  const quote = item.quote
    .split(/\r?\n/u)
    .map((line) => (line ? `  > ${line}` : '  >'))
    .join('\n');
  return `- ${absolutePath(item)}\n${quote}`;
}

/** The wire prompt: the typed text, then any `Selected passages:`, then the
 *  `Attached files:` suffix every runtime and history replay understand. */
export function renderPromptContext(text: string, lines: readonly ResolvedContextLine[]): string {
  const blocks: string[] = [];
  const passages = lines.flatMap(({ item }) => (item.kind === 'passage' ? [item] : []));
  const files = lines.filter(({ item }) => item.kind !== 'passage');
  if (passages.length > 0)
    blocks.push(`Selected passages:\n${passages.map(passageLines).join('\n')}`);
  if (files.length > 0) blocks.push(`Attached files:\n${files.map(contextLine).join('\n')}`);
  if (blocks.length === 0) return text;
  return `${text}${text ? '\n\n' : ''}${blocks.join('\n\n')}`;
}

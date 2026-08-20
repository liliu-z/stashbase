/**
 * Pure classification of tool blocks for the transcript's activity UI:
 * collapsed group summaries, per-row verb/target parts, permission ask
 * titles, and the file changes a tool leaves behind. Rendering lives in
 * AgentMessages.
 */
import { basename } from '@/common/lib/paths';
import type { ToolBlock } from '@/features/agent-panel/lib/types';
import { clipInline, mcpArgs } from '@/features/agent-panel/lib/toolPayload';

export type CommandAction = { type?: unknown; path?: unknown };

export function commandActions(input: Record<string, unknown>): CommandAction[] {
  return Array.isArray(input.actions)
    ? input.actions.filter((action): action is CommandAction => !!action && typeof action === 'object')
    : [];
}

/** One tool-kind vocabulary shared by the row verb (`toolRowParts`), the
 * group rollup (`activitySummary`), and the row icon (`ToolTypeIcon` in
 * AgentMessages), so verb, summary, and icon can never drift. `write`,
 * `edit`, and `file-change` stay distinct because verbs and icons
 * distinguish them; the summary folds all three into "edited files". */
export type ToolKind = 'read' | 'list' | 'search' | 'command' | 'write' | 'edit' | 'file-change' | 'other';

/** Kind of one structured Bash action (`input.actions[i]`). */
export function commandActionKind(action: CommandAction | undefined): 'read' | 'list' | 'search' | 'command' {
  if (action?.type === 'read') return 'read';
  if (action?.type === 'listFiles') return 'list';
  if (action?.type === 'search') return 'search';
  return 'command';
}

/** THE tool-name classification ladder — the one place the
 * `/read_file$/ … /write_file$/ … Bash` matching lives. Bash classifies by
 * its first structured action (`activitySummary` walks every action via
 * `commandActionKind`). Match order is significant: a name matching an
 * earlier test never reaches a later one. */
export function classifyTool(name: string, input: Record<string, unknown>): ToolKind {
  if (name === 'Bash') return commandActionKind(commandActions(input)[0]);
  if (/read_file$/i.test(name)) return 'read';
  if (/write_file$/i.test(name)) return 'write';
  if (/edit_file$/i.test(name)) return 'edit';
  if (/list_directory$/i.test(name)) return 'list';
  if (/search/i.test(name)) return 'search';
  if (name === 'File change') return 'file-change';
  return 'other';
}

/** Question-form title for a pending approval — the card head carries the
 * ask, so the body needs no separate prompt line. */
export function askTitle(name: string): string {
  if (name === 'Bash') return 'Run this command?';
  if (name === 'File change') return 'Apply these changes?';
  return `Allow ${name}?`;
}

/** Codex-style parts for an activity row: an action verb and, when there
 * is one, its object — a file name (rendered underlined, like a link) or
 * a command / query (rendered mono). The collapsed group summary uses its
 * own count-free rollup (activitySummary). */
export function toolRowParts(name: string, input: Record<string, unknown>): { verb: string; target?: string; mono?: boolean } {
  const kind = classifyTool(name, input);
  if (name === 'Bash') {
    const action = commandActions(input)[0];
    if (kind === 'read' && typeof action?.path === 'string') return { verb: 'Read', target: basename(action.path) };
    if (kind === 'list') return { verb: 'Listed files' };
    if (kind === 'search') return { verb: 'Searched files' };
    // 'command' — and a read action without a usable path, same as before.
    return { verb: 'Ran', target: clipInline(String(input.command ?? ''), 120), mono: true };
  }
  switch (kind) {
    case 'read': {
      const path = mcpArgs(input).path ?? input.file_path;
      return typeof path === 'string' ? { verb: 'Read', target: basename(path) } : { verb: 'Read file' };
    }
    case 'write': {
      const path = mcpArgs(input).path;
      return typeof path === 'string' ? { verb: 'Wrote', target: basename(path) } : { verb: 'Wrote file' };
    }
    case 'edit': {
      const path = mcpArgs(input).path;
      return typeof path === 'string' ? { verb: 'Edited', target: basename(path) } : { verb: 'Edited file' };
    }
    case 'list':
      return { verb: 'Listed files' };
    case 'search': {
      const args = mcpArgs(input);
      const q = args.query ?? args.pattern ?? input.query ?? input.pattern;
      return typeof q === 'string' ? { verb: 'Searched', target: clipInline(q, 120), mono: true } : { verb: 'Searched' };
    }
    case 'file-change':
      return { verb: 'Changed files' };
    default:
      return { verb: name };
  }
}

/** A quiet, count-free description of a group's work (Codex register:
 * "Read files, ran commands"). It omits exact counts but uses each category's
 * count to keep singular and plural labels grammatical. Live and done states
 * keep the same wording; an active group appends "…". */
export function activitySummary(tools: ToolBlock[], active?: boolean): string {
  let reads = 0;
  let lists = 0;
  let searches = 0;
  let commands = 0;
  let changes = 0;
  let toolsUsed = 0;
  for (const tool of tools) {
    if (tool.name === 'Bash') {
      const actions = commandActions(tool.input);
      if (!actions.length) { commands++; continue; }
      for (const action of actions) {
        const kind = commandActionKind(action);
        if (kind === 'read') reads++;
        else if (kind === 'list') lists++;
        else if (kind === 'search') searches++;
        else commands++;
      }
      continue;
    }
    switch (classifyTool(tool.name, tool.input)) {
      case 'read': reads++; break;
      case 'write': case 'edit': case 'file-change': changes++; break;
      case 'list': lists++; break;
      case 'search': searches++; break;
      default: toolsUsed++; break;
    }
  }
  const labels = [
    reads && `read ${reads === 1 ? 'file' : 'files'}`,
    lists && `listed ${lists === 1 ? 'folder' : 'folders'}`,
    searches && 'searched',
    commands && `ran ${commands === 1 ? 'command' : 'commands'}`,
    changes && `edited ${changes === 1 ? 'file' : 'files'}`,
    toolsUsed && `used ${toolsUsed === 1 ? 'tool' : 'tools'}`,
  ].filter(Boolean);
  const summary = labels.length ? labels.join(', ') : 'worked';
  const capped = summary.charAt(0).toUpperCase() + summary.slice(1);
  return active ? `${capped}…` : capped;
}

export function fileChanges(block: ToolBlock): Array<{ path: string; kind: string }> {
  const kind = classifyTool(block.name, block.input);
  // MCP file mutations (write_file / edit_file) surface as artifacts too:
  // "work leaves an openable result" is a system guarantee, not something
  // the model must remember to link in prose.
  if (kind === 'write' || kind === 'edit') {
    const path = mcpArgs(block.input).path;
    if (typeof path !== 'string' || !path) return [];
    return [{ path, kind: kind === 'edit' ? 'edited' : 'wrote' }];
  }
  if (kind !== 'file-change') return [];
  const raw = Array.isArray(block.input.changes) ? block.input.changes : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const change = item as Record<string, unknown>;
    const path = [change.path, change.filePath, change.file_path].find((value): value is string => typeof value === 'string' && value.length > 0);
    if (!path) return [];
    const kind = typeof change.kind === 'string' ? change.kind : typeof change.type === 'string' ? change.type : 'Changed';
    return [{ path, kind }];
  });
}

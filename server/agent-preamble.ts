/**
 * StashBase orientation preamble for the built-in Claude panel.
 *
 * Appended to the SDK's `claude_code` system prompt in server/agent.ts.
 * Without it the panel runs *bare*: cwd happens to be a folder, but the
 * model has no idea it's inside StashBase, what the library MCP tools are for,
 * or what the house rules are — so it behaves exactly like a `claude`
 * launched in a random folder (architecture.md §8.4).
 *
 * The MCP `instructions` field + a `library_info` round-trip advertise the same
 * facts, but only *advisorily* and only if the model bothers to call
 * `library_info`. This puts orientation into the system prompt deterministically
 * instead.
 *
 * Built per session: cwd is fixed for a session's lifetime (switching
 * folders tears the session down), so the live context here — current folder,
 * sibling folders — is always current.
 */
import fs from 'node:fs';
import path from 'node:path';

export function buildStashbasePreamble(cwd: string): string {
  const current = path.basename(cwd);

  const lines: string[] = [
    `You are operating inside **StashBase**, a local file-based knowledge base. Current folder: **${current}** (\`${cwd}\`).`,
    '',
    'Use the StashBase MCP tools when they fit:',
    '- `search_library` finds relevant library content by meaning across folders; pass `folder` or `path_prefix` to narrow the search.',
    '- `read_file` reads files through StashBase; for PDFs it returns extracted Markdown when available.',
    '- `reindex` refreshes the index after you create, edit, delete, or move files so search reflects the latest content on disk.',
  ];

  const memoryStore = memflywheelStoreLines(cwd);
  if (memoryStore.length) lines.push('', ...memoryStore);

  return lines.join('\n');
}

/**
 * MemFlywheel (https://github.com/iflytek/memflywheel) stores agent memory as
 * ordinary Markdown: a root `MEMORY.md` index over typed memory documents,
 * with source traces and learned skills alongside. Those files index and
 * search like any other Markdown, but a bare folder listing invites the model
 * to bulk-load every memory file. When the opened folder is such a store,
 * orient the model on the layout so it reads the index first and follows it.
 *
 * Detection requires both the index and the `.memflywheel/` trace directory —
 * a folder that merely contains a MEMORY.md is not a store.
 */
function memflywheelStoreLines(cwd: string): string[] {
  try {
    if (!fs.statSync(path.join(cwd, 'MEMORY.md')).isFile()) return [];
    if (!fs.statSync(path.join(cwd, '.memflywheel')).isDirectory()) return [];
  } catch {
    return [];
  }
  return [
    'This folder is a MemFlywheel memory store: file-native agent memory kept as Markdown.',
    '- `MEMORY.md` is the index of memory cues. Read it first and follow its links instead of scanning the folder.',
    '- Typed subfolders (for example `preference/`, `workflow/`) hold the memory bodies the index points to.',
    '- `.memflywheel/sources/` holds JSONL source traces behind each memory; `learned-skills/*/SKILL.md` holds learned skills. Open these only when a memory body is not enough.',
  ];
}

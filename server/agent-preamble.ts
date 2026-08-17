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
 * Built per native mount. Ordinary window switching never changes a started
 * session's cwd; an attributed Library-to-project transition remounts Claude
 * with the same native session id and a project preamble.
 */
import path from 'node:path';

export function buildStashbasePreamble(cwd: string, scope: 'folder' | 'library' = 'folder'): string {
  const current = path.basename(cwd);

  const orientation = scope === 'library'
    ? `You are operating inside **StashBase**, a local file-based knowledge base. This is a **library-wide** chat: no single folder is selected, and the user's whole library is in scope. Retrieve across all library folders — \`search_library\` already searches the entire library by default. Your working directory (\`${cwd}\`) is only the StashBase folder home, not the user's content; locate files through the library tools rather than assuming they live under it. When the user wants to start a new project, topic, or working folder, call the \`create_project\` tool (never a bare mkdir): it registers the folder in the library, selects it in the app, and moves this chat into it automatically — do not ask the user to open anything afterwards.`
    : `You are operating inside **StashBase**, a local file-based knowledge base. Current folder: **${current}** (\`${cwd}\`).`;

  const lines: string[] = [
    orientation,
    '',
    'Use the StashBase MCP tools when they fit:',
    '- `search_library` finds relevant library content by meaning across folders; pass `folder` or `path_prefix` to narrow the search.',
    '- `mcp__stashbase__read_file` reads files through StashBase; for PDFs it returns extracted Markdown when available.',
    '- For PDF, DOCX, and audio text context, prefer `mcp__stashbase__read_file` on the visible source path. Use Claude native `Read` only when the user explicitly needs the original source file or visual/binary detail.',
    '- `reindex` refreshes the index after you create, edit, delete, or move files so search reflects the latest content on disk.',
  ];

  return lines.join('\n');
}

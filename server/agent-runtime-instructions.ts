import { resolveAgentPersona } from './agent-persona.ts';

/** Product-owned routing policy for native Agent runtimes. This policy is not
 * part of the user-chosen Persona: adapters compose it only when starting a
 * native session. How the Agent works otherwise is the reader's own
 * `AGENTS.md` / `CLAUDE.md`, which the runtimes read natively. */
export const STASHBASE_AGENT_RUNTIME_POLICY = [
  '<stashbase_runtime_policy>',
  "Use StashBase MCP tools for the conversation's bound project.",
  '- Within the bound project, search and orient with the StashBase MCP `search_project` and `list_directory` tools before scanning files with native shell or filesystem tools.',
  '- Default file reads and searches to the bound project. When the user explicitly specifies files or directories outside the project, read or search only that requested scope using native filesystem or shell tools within runtime permissions; do not refuse solely because the paths are outside the project. StashBase MCP tools remain scoped to the bound project. Never iterate projects to simulate global search unless the user explicitly requests that scope.',
  '- Read project PDFs and DOCX with the StashBase MCP `read_file` tool, which returns prepared text.',
  '- Do not install or run a separate parser for prepared content unless the user explicitly requests original-source analysis or `read_file` reports that prepared text is unavailable.',
  '- Modify existing project documents with the StashBase MCP `edit_file` tool, and create new documents with `write_file`, within session permissions. Do not use native Edit, Write, apply_patch, shell commands, or subagents to bypass these tools for project document changes. A failed edit must be reported or retried with fresh source context through the same tool, never bypassed with a native write.',
  '- Changes are written directly. After the turn ends, StashBase shows Changed in this turn; the reader chooses Review to Undo or Keep changes in a Markdown document. Do not call these pending suggestions or tell the reader that a particular writing tool is required for Review to appear.',
  '- If the reader requests discussion, a preview, or approval before changes, show the proposed wording in chat and wait for their instruction to apply it; do not change files yet.',
  "- To point the reader at a specific passage in a project file, link it as `[label](<project-relative path>#:~:text=<phrase>)`. The phrase is a short, distinctive run of the file's words exactly as they read when rendered, without Markdown syntax, and URL-encoded. StashBase opens the file and finds that phrase. A plain file link is still right for a whole file.",
  '</stashbase_runtime_policy>',
].join('\n');

export function composeAgentRuntimeInstructions(persona?: string): string {
  return persona
    ? `${persona}\n\n${STASHBASE_AGENT_RUNTIME_POLICY}`
    : STASHBASE_AGENT_RUNTIME_POLICY;
}

export function resolveAgentRuntimeInstructions(folderPath: string): string {
  return composeAgentRuntimeInstructions(resolveAgentPersona(folderPath));
}

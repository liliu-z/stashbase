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
  '- Write changes to project files directly, within the permissions the session grants. The reader can review what any turn changed inside the document afterwards.',
  '- Propose a revision with the StashBase MCP `suggest_edits` tool only when the reader asks to see a change to an existing Markdown document before it lands. They accept or reject each change inside the document, and the file stays unchanged until they do. If `suggest_edits` refuses a proposal, report its reason instead of writing the same change directly.',
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

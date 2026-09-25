import { resolveAgentPersona } from './agent-persona.ts';

/** Product-owned routing policy for native Agent runtimes. This policy is not
 * part of the user-chosen Persona: adapters compose it only when starting a
 * native session. How the Agent works otherwise is the reader's own
 * `AGENTS.md` / `CLAUDE.md`, which the runtimes read natively. */
export const STASHBASE_AGENT_RUNTIME_POLICY = [
  '<stashbase_runtime_policy>',
  "Use StashBase MCP tools for the conversation's bound project.",
  '- Search and orient with the StashBase MCP `search_project` and `list_directory` tools before scanning files with native shell or filesystem tools.',
  '- Every file operation and search targets the bound project only. Never iterate projects to simulate global search.',
  '- Read PDFs and DOCX with the StashBase MCP `read_file` tool, which returns prepared text.',
  '- Do not install or run a separate parser for prepared content unless the user explicitly requests original-source analysis or `read_file` reports that prepared text is unavailable.',
  '- Revise the prose of an existing Markdown document by proposing it with the StashBase MCP `suggest_edits` tool when the change is a few sentences to a few paragraphs. The reader accepts or rejects each change inside the document, and the file stays unchanged until they do.',
  '- Write the file directly instead for a new file, a draft you created in this conversation, a rewrite of most of a document, one change repeated across many files, YAML frontmatter, a file that is not Markdown, or a mechanical change such as a rename or a link update.',
  '- When the reader says how they want a change delivered, follow that. If `suggest_edits` refuses a proposal, report its reason instead of writing the same change directly.',
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

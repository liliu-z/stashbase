# Project Entry and Lifetime

## Scope

Open, Create, Recent, GitHub Import, and Gallery Copy converge on one local
project identity and window decision. Entry is complete when the workspace is
usable; Agent setup and indexing are independent.

## Shared Rules

- Identity follows the directory, not its display name. Distinct directories
  may share a name; aliases of one directory reuse one project.
- Apply the window rule in order: focus the project's existing window; otherwise
  reuse the initiating Welcome window; otherwise open another window.
- Repeated or superseded requests cannot create duplicate copies or windows.
  Existing work remains available until a replacement entry succeeds.
- Startup reaches Welcome without seeding projects or native instruction files.
  Explicit entry restores saved work. Only explicit removal forgets registration.
- Removing a project preserves source files and separately registered nested
  projects. It retires that project's background work and disables sending in
  retained conversations; it never moves them into another project.

## Entry Differences

| Entry | Work before the shared entry decision |
|---|---|
| Open / Create | Select an existing directory, or create one in the system picker. An empty project is valid. |
| Recent | Resolve a remembered directory; retain the record if it is unavailable. |
| GitHub / Gallery | Download a public repository’s default-branch file snapshot and register the local copy before attempting window entry. |
| MCP-created project | Explicit authorized creation registers a folder. Opening it follows ordinary entry; existing conversations keep their project. |

GitHub Import and Gallery Copy require neither a local Git installation nor a
GitHub account. A copy contains project files without the source repository’s
Git metadata or history; later upstream changes do not update it. Repositories
using submodules or Git LFS remain unsupported.

## Failure and Recovery

- New-copy conflicts preserve the destination and the proposed name. Choose
  another name or explicitly open the existing folder; never silently merge or
  overwrite. Existing directory names do not inherit new-copy naming restrictions.
- Copy failure cleans only work owned by the attempt. A retained usable copy is
  reported; entry failure retries entering that copy without another download.
- Unknown outcomes must be resolved before repeating a mutation. A matching
  directory name alone does not establish successful acquisition.
- Cancel preserves existing folders, picker-created folders, and committed copies.
  Failed removal remains recoverable; source deletion is a separate operation.

## Related Journeys

[J01](../journeys/README.md#j01-complete-onboarding-and-reach-first-value),
[J02](../journeys/README.md#j02-add-and-open-a-folder),
[J10](../journeys/README.md#j10-turn-a-local-project-into-durable-agent-assisted-work),
[J11](../journeys/README.md#j11-turn-a-conversation-into-a-project),
[J13](../journeys/README.md#j13-download-a-ready-made-wiki-from-the-gallery).

Work preservation: [files](project-files.md#saving-and-release) and
[sessions](agent-sessions.md). Implementation ownership:
[project boundary](../../code-review/architecture.md#project-scope-and-paths).

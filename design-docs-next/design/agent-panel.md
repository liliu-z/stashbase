# Agent Panel

Product design for StashBase's VS Code-like Agent Panel.

## Panel Shape

- [Implemented] The Agent Panel is a side panel next to the file workspace.
- [Implemented] The panel can be expanded, collapsed, and resized.
- [Implemented] The panel supports Claude and Codex.
- [Implemented] The Claude / Codex entries select or switch agents.
- [Implemented] Selecting an agent shows that agent's chat tabs.
- [Implemented] The panel has a transcript area.
- [Implemented] The panel has a bottom input box.
- [Implemented] The input area includes Access mode and Effort controls.
- [Implemented] The input area supports send and stop behavior.
- [Planned] The panel visual design should continue moving toward low chrome, light borders, and compact controls.

## Chat

- [Implemented] Users can send text messages.
- [Implemented] Agent responses stream into the transcript.
- [Implemented] Users can stop the active response.
- [Implemented] After stopping, users can edit the interrupted prompt and resend it.
- [Implemented] Users can copy historical user prompts.
- [Implemented] Follow-up input during an active turn can be visibly queued.
- [Implemented] Codex can support steering during an active turn.
- [Implemented] Long prompts and queued follow-ups can collapse to avoid dominating the transcript.
- [Planned] Retry and recovery for failed turns can be polished further.

## Tabs / History

- [Implemented] Each agent can have multiple chat tabs.
- [Implemented] Users can create a new chat.
- [Implemented] Users can switch chats.
- [Implemented] Users can close chats.
- [Implemented] Users can delete chats.
- [Implemented] Users can restore chats from history.
- [Implemented] Agent top-level entries do not create new chats; the in-panel `+` creates new chats.
- [Implemented] Closing the final tab does not leave an empty history workspace behind.
- [Planned] The relationship between multi-agent tabs, history, and the current folder can be simplified further.

## Input / Attachments

- [Implemented] The input box accepts text.
- [Implemented] Users can `@` mention files in the current folder.
- [Implemented] `@` file mention suggestions support keyboard navigation.
- [Implemented] Users can add attachments by drag and drop.
- [Implemented] Users can add attachments through a file picker.
- [Implemented] The currently open document is not implicit agent context.
- [Implemented] Users must explicitly add file context.
- [Planned] File mention and attachment selection can be improved.
- [Planned] Selected text or current section can become a more granular context handoff.
- [Planned] Image attachment display and removal should be made clearer.

## Tool Activity

- [Implemented] Agent file reads, searches, writes, commands, and other activities appear in the transcript.
- [Implemented] Ordinary tool activity can be collapsed or grouped.
- [Implemented] Tool activity is compact by default and inspectable when needed.
- [Implemented] Permission cards requiring user action are not hidden inside collapsed activity.
- [Implemented] File outputs provide lightweight open affordances.
- [Implemented] Local Markdown file links can open the matching file.
- [Implemented] External links keep external-open behavior.
- [Planned] Tool activity can become easier to scan.
- [Planned] Diffs and file-change presentation can become clearer.
- [Planned] MCP and context diagnostics can become more explicit inside the panel.

## Permissions / Access Mode

- [Implemented] Supports a read-only / Plan-like mode.
- [Implemented] Supports Ask mode with confirmations.
- [Implemented] Supports Edit mode for limited automatic edits.
- [Implemented] Access mode is an action-permission setting and stays visible during chat.
- [Implemented] Edit mode only auto-accepts ordinary file writes/edits inside the currently opened folder.
- [Implemented] Delete, move, command execution, network, and broader filesystem access require explicit approval.
- [Implemented] Claude and Codex permission requests are normalized into the same permission-card experience.
- [Implemented] Codex MCP tool approvals use the same allow / deny flow.

## Error / Empty States

- [Implemented] Unavailable agent runtimes show actionable error states.
- [Implemented] Agent startup or runtime fatal errors appear in the message area and provide Retry.
- [Implemented] Empty chats keep the input box and necessary state without a marketing-style welcome.
- [Implemented] Terminal turns clean up stale running tool states.
- [Planned] Per-agent settings and status explanations can become clearer.

## Not In Scope

- [Not planned] Separate AI workspace.
- [Not planned] StashBase-owned closed agent product.
- [Not planned] Transcript as a new file management center.
- [Not planned] Changing file, indexing, or MCP boundaries just for panel presentation.

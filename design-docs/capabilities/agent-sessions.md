# Agent Sessions

## Scope

Chat mode and the Agent pane in Documents share conversation identity, execution,
and unfinished requests. Default, Codex, and Claude expose their actual
capabilities through this common experience.

## Identity and Continuity

- A conversation belongs to a project, Agent, and native session. Restore it once;
  duplicate titles are valid. Automatic naming never replaces a manual title.
- A completely blank chat may be reused. Drafts, context, queued requests, and
  started transcripts remain reachable when navigating or switching modes.
- Changing Agent before the first send preserves the draft and resets model,
  thinking, and skill choices without a switch notice. The selected Agent's saved
  thinking preference applies when supported. Unsupported context still needs an
  actionable explanation. Changing Agent after starting creates another
  conversation; it does not transfer history.
- Project removal stops active work, retains transcripts, and disables sending.
  A conversation never migrates to another project.

## Choice and Readiness

An unchosen project uses **Default**, even when signed out. Remember only explicit
project choices; readiness and history restoration never rewrite them.
[Account and Settings](account-settings.md) owns access prerequisites and credentials.
The [Chat journey](../journeys/chat.md#first-send) owns the first-send interaction.

Setup acknowledgement is not readiness. Standalone setup never sends a draft.
Only the still-current submission that explicitly requested access may continue
once setup succeeds; changed work or cancelled consent rejects late completion.

## Submission and Execution

- Capture text, context, and choices on Send. Clear only the accepted snapshot.
  Refused delivery retains it; uncertain delivery forbids automatic resend.
- One turn runs per conversation. Follow-ups queue explicitly; normal completion
  may advance the queue. Stop, failure, or connection loss pauses it.
- Validate context before sending. Opening a document does not attach it; missing
  or changed context needs replacement, refresh, or explicit removal.
- The Agent pane beside Documents suggests the document in front of the reader
  as a quiet chip. One click attaches it like a mention; dismissing it hides the
  suggestion until another document comes to the front. Chat mode shows no
  suggestion, since no document is on screen there.
- A **passage** is selected text bound as context, from **Ask Agent** on a
  Markdown selection. Its words travel with the request, so later edits to the
  file do not change what was asked about; it is refused only when its file
  leaves the project or it exceeds 6,000 characters. Reloaded history shows it
  as the same passage chip.
- A runtime that advertises attachments accepts ordinary local files through the
  picker, drop, or paste. Images and PDFs may have visual previews; other files
  remain named file cards. Attachment acceptance does not promise that every
  runtime can interpret every binary format, and a refused read must stay visible.
- Model, effort, skills, and permission options follow the selected runtime.
  Remember explicitly chosen thinking effort per project and Agent for new chats,
  including after restart. A model that does not support that effort uses its own
  default. Restoring history keeps that conversation's effort and never changes
  the preference; selecting Default explicitly clears the saved effort.
  Without an explicit model choice, a chat runs on the model the runtime's own
  settings name; StashBase never resets a runtime to a built-in default the user
  did not choose. A model named by an alias shows the release that alias
  resolves to, in the runtime's own words, so the reader can tell which model
  the choice actually runs. A model chosen while a session is still starting applies
  before its first turn.
  Options remain fixed during a turn. A persona is standing session guidance
  chosen per project in the composer: a packaged persona, the reader's own
  Custom prompt, or none. Choosing one applies from the chat's next message by
  resuming its own conversation, and to new chats in the project. It is
  distinct from permissions, requests, and user-owned native instruction files,
  which own how the Agent works.
- Approval applies to its pending action only. Stop cancels unanswered approvals,
  retires model/tool work, and preserves transcripts and completed file edits.
  Cancellation is confirmed before reporting Stopped; it does not roll back edits.
- A reply may cite a passage in a project file with a link carrying a short
  quoted phrase. Opening it shows the file in Documents and locates that
  phrase; when the file no longer holds it, the file stays open and says so.
  A link without a phrase opens its file at the top. Citing is standing
  guidance to the Agent, not a guarantee that every reply cites.
- A clarifying question is answered in place on its own pending request. Answers
  return keyed by question text; Skip or Stop leaves it unanswered rather than
  guessing on the reader's behalf.

## Failure and Recovery

Keep usable history, partial output, and unsent work. Distinguish setup/account
repair, an outdated runtime, provider limits, transport loss, and turn failure so
recovery addresses the actual cause. An outdated runtime updates in place from
the failed turn; the conversation reconnects on it and resends the refused
request. A failed history load never becomes an empty conversation.

Reconnect to the same session and establish uncertain outcomes before continuing.
Retry uses the retained submission after checking context; Reuse message prepares
a new turn without truncating history or replacing another draft. Neither restores
missing attachment bytes nor promises that repeated file operations are safe.
Temporary attachments remain available to live drafts/queues across mode changes;
history metadata alone cannot restore them after loss or cleanup.

## Related Journeys

[J01](../journeys/README.md#j01-complete-onboarding-and-reach-first-value),
[J06](../journeys/README.md#j06-start-and-continue-an-agent-chat),
[J07](../journeys/README.md#j07-converge-chat-into-a-document),
[J10](../journeys/README.md#j10-turn-a-local-project-into-durable-agent-assisted-work),
[J11](../journeys/README.md#j11-turn-a-conversation-into-a-project),
[J12](../journeys/README.md#j12-build-wiki-pages-from-a-local-folder).

[Agent boundary](../../code-review/architecture.md#agent-sessions-and-permissions)
owns runtime integration and permissions; [Project Files](project-files.md) owns
file results, and [Project Context](project-context.md) owns source evidence.

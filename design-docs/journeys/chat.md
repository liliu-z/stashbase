# Working in Chat

Explore ideas, draft, and revise with an Agent. A conversation needs no source
files, wiki, or intended deliverable. This journey owns the interaction;
[Agent Sessions](../capabilities/agent-sessions.md) owns shared behavior across
Chat, Documents assistance, and runtimes.

## Flow

1. Start a chat in the project or return through history. The sidebar keeps drafts
   reachable and makes conversation identity and working state clear. Search names
   its scope; conversation navigation follows actual visits.
2. Compose an idea, optionally attach context and choose supported Agent options.
   The action clearly sends, queues, or stops work. A persona sets how the Agent
   talks and writes from the next message on and remains distinct from the
   current request.
3. Follow replies and useful progress. Routine tools and provided thinking are
   grouped per turn and collapsed. The group holding a running turn names the
   step in hand so long work visibly advances; a settled group states what it
   did. Approvals, turn failures, and file results remain individually
   actionable. An Agent's clarifying questions appear as a card with its
   options and a line for the reader's own answer; answering continues the
   turn, and skipping tells the Agent no answer was given. Tool-call failures
   do not appear in chat, including activity summaries and expanded details. The Agent explains task outcomes; native
   execution history retains the failed attempts.
   Only successful file operations contribute to changed-file results. A
   write made through a shell command or a subagent names no file and shows
   no result; when such a turn settles, the project's files refresh so the
   file appears in Documents. New output preserves reading position.
4. Continue, queue a follow-up, stop, or reuse a message for another turn. Open a
   file result or a local file link to switch to Documents and show that file,
   retaining the conversation and unsent input. A link that cites a passage
   also locates the quoted phrase, or says the file no longer holds it. Agent writes do not take focus.
5. Return through history or change modes without losing the conversation or unsent
   work. Rename is deliberate; deleting a chat does not delete project files.
   New Chat reuses the last explicitly selected thinking effort for that project's
   Agent when supported, instead of resetting to the runtime default.

## First Send

With no explicit project choice, the draft uses Default even while signed out.
If the selected Agent is unavailable, Send presents its access prompt before
starting login, installation, or a session:

- Default offers Sign in for free Agent credits.
- A native Agent offers Connect Codex or Connect Claude.
- Not now keeps the request. Another Agent can be selected from the draft.

The prompt is about the selected Agent. On explicit confirmation, keep the request
while access is prepared. Readiness may continue only this same submission once.
Changing the request, project, conversation, or Agent, or cancelling the prompt,
retires that continuation. Standalone Settings setup never sends a draft.

## Failure and Return

Show what was retained and the required next action. A runtime too old for the
selected model offers its update in the failed turn; after the update, the same
request is sent again. A runtime that reports a model its installed
version cannot run offers the same update beside the composer, in that
runtime's own words; the offer is dismissed for the window, never blocks a
turn, and is absent whenever the runtime reports nothing. Repair setup/account failures
without losing the idea. Keep partial output and file results after a turn fails.
A missing context item needs refresh, replacement, or deliberate removal.

Stop remains Stopping until confirmed and leaves queued work paused. Lost delivery
or unconfirmed cancellation stays uncertain; reconnect/recover the same session
before considering another send. Retry and Reuse follow
[session recovery](../capabilities/agent-sessions.md#failure-and-recovery).

## Related Journeys

[J06](README.md#j06-start-and-continue-an-agent-chat),
[J07](README.md#j07-converge-chat-into-a-document),
[J10](README.md#j10-turn-a-local-project-into-durable-agent-assisted-work).
[Account and Settings](../capabilities/account-settings.md) owns access policy;
[J06 evidence](../../code-review/journey-coverage.md#j06-agent) records runtime limits.

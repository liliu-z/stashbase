# Working in Chat

Explore ideas, draft, and revise with an agent. A conversation needs no source
files, wiki, or intended deliverable. This journey owns the interaction;
[Agent Sessions](../capabilities/agent-sessions.md) owns shared behavior across
Chat, Documents assistance, and runtimes.

## Flow

1. Start a chat in the project or return through history. The sidebar keeps drafts
   reachable and makes conversation identity and working state clear. Search names
   its scope; conversation navigation follows actual visits.
2. Compose an idea, optionally attach context and choose supported agent options.
   The action clearly sends, queues, or stops work. A persona sets how the agent
   talks and writes in this Chat from the next message on and remains distinct
   from the current request. The reader can switch personas between messages,
   write a new one, or browse ready-made personas to add one. Default also offers
   Crew: select who handles matching work in this chat and choose each member's
   model. Existing chats keep their choices; new chats inherit the last selection.
3. Follow replies and useful progress. Routine tools and provided thinking are
   grouped per turn and collapsed. The group holding a running turn names the
   step in hand so long work visibly advances; a settled group states what it
   did. Approvals, turn failures, and file results remain individually
   actionable. An agent's clarifying questions appear as a card with its
   options and a line for the reader's own answer; answering continues the
   turn, and skipping tells the agent no answer was given. Ordinary tool-call failures
   do not appear in activity summaries or expanded details; the agent explains
   task outcomes and native history retains the failed attempts. Selected Crew
   calls have their own cards, including failed calls and their explanations.
   After a turn completes successfully, more than eight visible process
   messages fold behind a counted row. Intermediate replies, notices, and
   routine activity groups count once each, independent of raw tool-event
   count. One click reveals the entire process and can fold it again; a manual
   choice lasts while that chat remains open, including switches to other chats.
   Prompts, accepted follow-ups, the final reply, file results, Crew calls,
   pending decisions, and denied or cancelled actions stay visible in order.
   Running, failed, stopped, and history turns without a confirmed outcome
   stay expanded. Completion never folds underneath a reader who has scrolled
   away or placed keyboard focus inside the process. Manual expansion pauses
   following so the newly revealed messages remain readable.
   Only successful file operations contribute to changed-file results. A
   write made through a shell command or a subagent names no file and shows
   no result; when such a turn settles, the project's files refresh so the
   file appears in Documents. New output follows the end until the reader
   scrolls toward the start, however little; it then preserves reading
   position. Sending a message glides back to the end. Deciding
   an approval preserves that position too; keyboard focus can follow the
   decided tool into its activity group without scrolling to the group header.
4. Continue, send a follow-up into the running turn or queue it for after,
   stop, or reuse a message for another turn. Copy a prompt, a settled reply,
   or only a block the reply sets apart, such as a drafted post. An agent that
   can take a follow-up mid-turn gets it there by default; it shows as not yet read until
   the agent reads it, then stays where the agent read it. Open a
   file result or a local file link to switch to Documents and show that file,
   retaining the conversation and unsent input. A link that cites a passage
   also locates the quoted phrase, or says the file no longer holds it. Agent writes do not take focus.
5. Return through history or change modes without losing the conversation or unsent
   work. Rename is deliberate; deleting a chat does not delete project files.
   Switching agents and New Chat reuse the last explicitly selected model and
   thinking effort for that project's agent when supported. Without a project
   choice, they inherit that agent's last explicit choice across projects, even
   after using a different agent in between.

## First Send

The draft starts with the [remembered agent choice](../capabilities/agent-sessions.md#choice-and-readiness),
inheriting the user's choice from other projects when this project has none.
If the selected agent is unavailable, Send presents its access prompt before
starting login, installation, or a session:

- Default offers Sign in for free agent credits.
- A native agent offers Connect Codex, Connect Claude, or Connect Antigravity
  when it may need installing, and Sign in when only its own sign-in is
  missing, such as an expired one.
- Not now drops only the held send; the draft stays, and a sign-in or setup
  already started carries on. Another agent can be selected from the draft.

The prompt is about the selected agent. On explicit confirmation, keep the request
while access is prepared. Readiness may continue only this same submission once.
Changing the request, project, conversation, or agent, or cancelling the prompt,
retires that continuation. Standalone Settings setup never sends a draft.
Only one dialog is open at a time: Default's Sign in hands over to the
account's sign-in dialog instead of staying open beneath it, still holding the
send, which goes once the account is signed in. If the reader leaves that
dialog without signing in, the prompt returns saying the message was kept,
with Retry.
If preparation fails, the same prompt stays open with the failed step and the
service's own explanation, including any supplied error code or file location.
Keep the diagnostic visible as wrapping plain text, followed once by "Your
message was kept." and the prompt's Retry; users do not need to visit Settings
to explain the failure.
Claude, Codex, and Antigravity continue from installation into their provider's
browser sign-in when needed, and resume the retained submission only after
readiness. While preparation runs, the prompt names the step the service is on
in its own words and how long the wait has lasted, so a slow download or a
pending browser sign-in never reads as a failure. During sign-in it offers Stop
waiting, which ends the runtime's login and returns the prompt to its question
with the send still held. A send that joined a sign-in already running reports
how it ended when it ends without signing in, for example stopped in Settings,
rather than opening another. For a browser that did not open, it also offers the
provider page the runtime printed when that page finishes sign-in by itself, as
Codex's does. Claude's printed page ends with a code to paste into its terminal,
so Claude's wait offers none.

## Failure and Return

Show what was retained and the required next action. A runtime too old for the
selected model offers its update in the failed turn; after the update, the same
request is sent again. A runtime that reports a model its installed
version cannot run offers the same update beside the composer, in that
runtime's own words; the offer is dismissed for the window, never blocks a
turn, and is absent whenever the runtime reports nothing. An executable override
the app cannot replace offers no Update; an outdated turn explains external
update or override removal instead. Repair setup/account failures
without losing the idea. Keep partial output and file results after a turn fails.
A missing context item needs refresh, replacement, or deliberate removal.

Stop remains Stopping until confirmed, then queued work carries on. Lost delivery
or unconfirmed cancellation stays uncertain; reconnect/recover the same session
before considering another send. Retry and Reuse follow
[session recovery](../capabilities/agent-sessions.md#failure-and-recovery).

## Related Journeys

[J06](README.md#j06-start-and-continue-an-agent-chat),
[J07](README.md#j07-converge-chat-into-a-document),
[J10](README.md#j10-turn-a-local-project-into-durable-agent-assisted-work).
[Account and Settings](../capabilities/account-settings.md) owns access policy;
[J06 evidence](../../code-review/journey-coverage.md#j06-agent) records runtime limits.

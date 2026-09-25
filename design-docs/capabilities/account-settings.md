# Account and Settings

## Scope and Access

Settings, first-send access, and external-client setup share current configuration
and recovery rules. Local browsing, editing, preview, and keyword search require
no account.

| Capability | Access source |
|---|---|
| Default Agent | StashBase account and free Agent credits |
| Humanize | StashBase-run rewrite service; no account today |
| Codex / Claude | The native runtime's installation and authentication |
| Search by meaning | User-supplied embedding key in Settings, billed independently |
| External HTTP MCP | Current Settings token; separate opt-in for Docker access |

Selecting an Agent is not login or installation consent. Account sign-in does not
enable search. Credentials remain outside projects, renderer persistence, and
Agent history; supplied environment variables do not configure BYOK access.

## Settings Organization

Settings owns lasting preferences and connection configuration:

- **General:** appearance (theme, interface size, reading text size and font),
  usage statistics, and updates.
- **Agents:** group account, credit balance/refill, and connection state under
  Default; manage Codex and Claude individually. An installed runtime shows its
  version; a runtime whose own updater StashBase can run offers Update, which
  runs that updater in place and never replaces a provider-owned installation
  with a second copy. A runtime that reports a model its
  installed version cannot run leads its row with that model instead of its
  readiness; the requirement shown is the runtime's own, never one StashBase
  worked out. Credits refresh automatically; token accounting is not a
  user setting.
- **Advanced:** search by meaning and external apps (MCP). Search links directly
  to its configuration without discarding the current query. MCP reveals HTTP
  credentials only for that connection method; Docker details follow explicit
  configuration. Port changes require Docker access to be off.

PDF/OCR setup is automatic. Waiting documents expose failed-download recovery
through the same shared component owner. Help owns bug reporting; development
simulators use a separate development-only entry. Neither belongs in normal Settings.

## Shared State and Recovery

- Settings declare their scope. Project Agent preferences follow the project;
  current account and embedding configuration are shared across windows.
- A failed read is not an empty configuration. Failed writes preserve unrelated
  settings and report failure; disposable caches cannot overwrite unreadable state.
- Later changes supersede pending validation or authentication. Stale completion
  cannot restore a removed key or signed-out account. Reconfigure only the dependent
  service; report a persisted change separately from a failed runtime restart.
- One browser sign-in wait serves each window's surfaces and survives closing
  Settings. Cancelling the local wait does not revoke browser authorization;
  new attempts and sign-out retire prior local continuations across windows.
- Network/provider failure preserves credentials. Clear a session only on explicit
  sign-out or confirmed invalidation; repair does not implicitly send or replay work.
- A runtime too old for a chosen model is repaired where it failed: the turn
  offers the runtime's update, the conversation reconnects on the updated
  runtime, and the refused request is sent again. Settings offers the same
  update without a conversation.
- A persona applies from the chat's next message and to new chats; a running
  turn keeps its guidance. It does not rewrite native instruction files or
  change permissions.
- External MCP rotation invalidates the old token. Disable retires exposed access
  promptly, including unfinished requests, while ordinary local work remains usable.

## Other Settings Decisions

- Update installation is explicit and waits for affected document saves. Failure
  leaves the current application and downloaded update recoverable. Development
  notification previews have no authority to invoke the updater.
- Official builds disclose default-on basic usage statistics and offer opt-out.
  Collection excludes content, paths, account identity, and raw diagnostics.
  Opt-out stops pending collection; re-enabling starts a fresh identity without
  backfilling activity. [Usage statistics](../../docs/usage-statistics.md) owns details.
  Test launches of official builds suppress collection before startup without
  changing the user's saved preference or installation identity.
- Bug reporting is a separate explicit review and local handoff. The approved
  snapshot cannot change during preparation; StashBase does not submit the report.

## Related Journeys

[J01](../journeys/README.md#j01-complete-onboarding-and-reach-first-value),
[J06](../journeys/README.md#j06-start-and-continue-an-agent-chat),
[J08](../journeys/README.md#j08-connect-an-external-agent-through-mcp),
[J09](../journeys/README.md#j09-prepare-and-hand-off-a-bug-report).

[Chat](../journeys/chat.md) owns first-send interaction. Implementation:
[credentials](../../code-review/architecture.md#credentials-and-external-access),
[updates](../../code-review/architecture.md#native-lifecycle-and-updates), and
[reporting](../../code-review/architecture.md#bug-report).

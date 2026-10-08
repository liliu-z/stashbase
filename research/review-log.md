# Feature Review Log

Map reviewed features to related files for a later code redundancy review.
Paths are relative to the repository root.

## Project Agent choice and first-send access

- `renderer/src/features/agent/application/project-agents.ts`
- `renderer/src/features/agent/application/connect-agent.ts`
- `renderer/src/features/agent/application/workspace-runtime.ts`
- `renderer/src/features/agent/hooks/use-agent-access.ts`
- `renderer/src/features/agent/ui/access-dialog.tsx`
- `renderer/src/features/agent/ui/workspace.tsx`
- `renderer/src/features/settings/hooks/use-account.ts`
- `server/routes/agent-preferences.ts`
- `server/app-config.ts`
- `server/folder.ts`

## Sign in, account state, and sign out

- `renderer/src/app/shell.tsx`
- `renderer/src/app/composition/layout/workspace-dialogs.tsx`
- `renderer/src/app/composition/layout/workspace-sidebar.test.tsx`
- `renderer/src/features/settings/hooks/account-context.tsx`
- `renderer/src/features/settings/hooks/use-account.ts`
- `renderer/src/features/settings/hooks/use-settings-command.ts`
- `renderer/src/features/settings/application/queries.ts`
- `renderer/src/features/settings/infrastructure/account-api.ts`
- `renderer/src/features/settings/ui/account/sidebar-account-row.tsx`
- `renderer/src/features/settings/ui/agents/agents-panel.tsx`
- `server/routes/account.ts`
- `server/hosted-account.ts`
- `server/hosted-account-profile.ts`
- `server/app-config.ts`
- `server/oauth-result-page.ts`
- `shared/account.ts`
- `electron/main.cjs`
- `electron/multi-window.cjs`
- `server/hosted-account.test.ts`
- `server/account-route.test.ts`

## Welcome and recent projects

- `renderer/src/features/workspace/ui/welcome.tsx`
- `renderer/src/features/workspace/ui/welcome.test.tsx`
- `renderer/src/features/workspace/domain/project.ts`
- `renderer/src/features/workspace/infrastructure/api.ts`
- `server/folder.ts`
- `electron/renderer/smoke.cjs`

## Open / create a project

- `renderer/src/features/workspace/application/open-folder.ts`
- `renderer/src/features/workspace/infrastructure/api.ts`
- `renderer/src/platform/electron/folder-picker.ts`
- `shared/protocols/electron/project.ts`
- `electron/project/dialog.ts`
- `electron/project/dialog.test.cjs`
- `server/folder.ts`

## Import a project from GitHub

- `renderer/src/features/workspace/ui/import-github-dialog.tsx`
- `renderer/src/features/workspace/infrastructure/github-import-api.ts`

- `server/github-import.ts`
- `server/__tests__/github-import.test.ts`
- Shares the project-open path listed above.

## Start from a Gallery project

- `renderer/src/features/workspace/ui/welcome.tsx`
- `renderer/src/app/composition/gallery/use-gallery-shop.tsx`
- `renderer/src/app/composition/gallery/gallery-shop.test.tsx`
- `renderer/src/features/gallery/ui/shop.tsx`
- `renderer/src/features/gallery/ui/card.tsx`
- `renderer/src/features/gallery/ui/overlay.tsx`
- `renderer/src/features/gallery/ui/detail.tsx`
- `renderer/src/features/gallery/ui/screenshots.tsx`
- `renderer/src/features/gallery/ui/image.tsx`
- `renderer/src/features/gallery/ui/index-recovery.tsx`
- `renderer/src/features/gallery/hooks/use-gallery.ts`
- `renderer/src/features/gallery/domain/entry.ts`
- `renderer/src/features/gallery/domain/snapshot.ts`
- `renderer/src/features/gallery/infrastructure/gallery-api.ts`
- `renderer/src/features/gallery/application/ports.ts`
- `shared/protocols/http/gallery.ts`
- `server/routes/gallery.ts`
- `server/routes/gallery.test.ts`
- `electron/renderer/gallery-smoke.cjs`
- `renderer/src/app/dependencies.ts`
- Shares the GitHub import path listed above.

## Shared project opening and registration

- `design-docs/capabilities/project-entry.md`
- `renderer/src/features/workspace/hooks/use-project-entry.ts`
- `renderer/src/features/workspace/hooks/use-project-entry.test.ts`
- `renderer/src/features/workspace/hooks/use-project-entry-receiver.ts`
- `renderer/src/features/workspace/hooks/use-project-entry-receiver.test.ts`
- `server/project-import-operations.ts`

- `renderer/src/features/workspace/application/open-folder.ts`
- `renderer/src/features/workspace/application/queries.ts`
- `renderer/src/features/workspace/application/failure-messages.ts`
- `renderer/src/features/workspace/infrastructure/api.ts`
- `server/routes/project.ts`
- `server/routes/project.test.ts`
- `server/folder.ts`
- `server/project-open.test.ts`
- `server/state.ts`

## Enter the workspace and restore saved work

- `renderer/src/app/shell.tsx`
- `renderer/src/app/bootstrap/use-boot-progress.ts`
- `renderer/src/app/composition/commands/use-workspace-commands.ts`
- `renderer/src/app/composition/layout/workspace-layout.tsx`
- `renderer/src/app/composition/layout/workspace-layout.test.tsx`
- `renderer/src/app/composition/folder/use-document-workspace.ts`
- `renderer/src/app/composition/folder/use-document-sources.ts`
- `renderer/src/features/workspace/hooks/use-project.ts`
- `renderer/src/features/workspace/hooks/use-workspace.ts`
- `renderer/src/features/workspace/hooks/use-workspace-session.ts`
- `renderer/src/features/workspace/hooks/use-workspace-session.test.ts`
- `renderer/src/features/workspace/hooks/use-project-lifecycle.ts`
- `renderer/src/features/workspace/application/session-runtime.ts`

## Shared window selection and workspace acknowledgement

- `renderer/src/app/dependencies.ts`
- `renderer/src/platform/electron/project-lifecycle.ts`
- `renderer/src/features/workspace/infrastructure/project-lifecycle.ts`
- `shared/protocols/electron/project.ts`
- `electron/project/lifecycle.ts`
- `electron/main.cjs`
- `electron/multi-window.cjs`
- The destination window uses the shared project-opening and restoration paths above.

## Project identity, destination naming, and shared creation rules

- `shared/folder-name.ts`
- `shared/protocols/http/project.ts`
- `shared/protocols/http/github-import.ts`
- `server/filesystem-path.ts`
- `server/agent-projects.ts`
- `server/project-operations/index.ts`
- `renderer/src/features/gallery/domain/entry.ts`
- `renderer/src/features/workspace/infrastructure/github-import-api.ts`

## Chat mode, sidebar, and conversation navigation

- `design-docs/journeys/chat.md`
- `renderer/src/app/composition/layout/workspace-sidebar.tsx`
- `renderer/src/app/composition/layout/sidebar-panels.tsx`
- `renderer/src/app/composition/layout/workspace-panes.tsx`
- `renderer/src/features/agent/ui/chats/chats.tsx`
- `renderer/src/features/agent/ui/chats/conversation-tree.tsx`
- `renderer/src/features/agent/ui/chats/history-popover.tsx`
- `renderer/src/features/agent/ui/chat-nav-buttons.tsx`
- `renderer/src/features/agent/ui/chat-header.tsx`
- `renderer/src/features/agent/ui/chat-title.tsx`
- `renderer/src/features/agent/domain/conversation-history.ts`
- `renderer/src/features/agent/domain/workspace.ts`
- `renderer/src/features/agent/application/workspace-runtime.ts`
- `renderer/src/features/agent/application/workspace-runtime.test.ts`

## Chat messages, activity, approvals, and reading

- `renderer/src/features/agent/ui/workspace.tsx`
- `renderer/src/features/agent/ui/transcript/transcript.tsx`
- `renderer/src/features/agent/ui/transcript/transcript.test.tsx`
- `renderer/src/features/agent/ui/transcript/activity.tsx`
- `renderer/src/features/agent/ui/transcript/tool-presentation.ts`
- `renderer/src/features/agent/ui/transcript/markdown.tsx`
- `renderer/src/features/agent/domain/session-transcript.ts`
- `renderer/src/features/agent/application/session/events.ts`
- `renderer/src/shared/runtime/use-stick-to-bottom.ts`
- `server/opencode-agent.ts`
- `server/codex-session-runtime.ts`

## Chat composer, drafts, follow-ups, and failure recovery

- `renderer/src/features/agent/ui/composer/context-composer.tsx`
- `renderer/src/features/agent/ui/composer/provider.tsx`
- `renderer/src/features/agent/ui/composer/thinking.tsx`
- `renderer/src/components/ui/input-message-queue.tsx`
- `renderer/src/components/ui/input-message.test.tsx`
- `renderer/src/features/agent/domain/session.ts`
- `renderer/src/features/agent/domain/session-selectors.ts`
- `renderer/src/features/agent/application/session-runtime.ts`
- `renderer/src/features/agent/application/session-runtime.turns.test.ts`
- `renderer/src/features/agent/application/session/controls.ts`
- `renderer/src/features/agent/application/session-runtime.recovery.test.ts`
- `renderer/src/features/agent/ui/work-status.tsx`
- `renderer/src/features/agent/application/session/dispatch.ts`
- `renderer/src/features/agent/application/session/prompts.ts`
- `renderer/src/features/agent/infrastructure/session-api.ts`

## Chat starters and project persona

- `renderer/src/features/agent/domain/starters.ts`
- `renderer/src/features/agent/ui/persona/agent-persona-control.tsx`
- `assets/agent-personas/`
- `server/agent-persona.ts`
- `server/opencode-runtime.ts`

## Documents mode, sidebar, and Agent pane

- `design-docs/journeys/documents.md`
- `renderer/src/app/composition/layout/sidebar-panels.tsx`
- `renderer/src/app/composition/layout/sidebar-navigator.tsx`
- `renderer/src/app/composition/layout/workspace-panes.tsx`
- `renderer/src/app/composition/layout/agent-document-workspace.tsx`
- `renderer/src/app/composition/folder/use-tree-follows-document.ts`
- `renderer/src/features/documents/ui/workspace/outline.tsx`

## File creation, rename, and deletion

- `renderer/src/features/workspace/ui/file-tree.tsx`
- `renderer/src/features/workspace/ui/file-tree-menu.tsx`
- `renderer/src/features/workspace/ui/file-tree-draft.ts`
- `renderer/src/features/workspace/ui/file-tree-naming.tsx`
- `renderer/src/features/workspace/hooks/use-file-operations.ts`
- `renderer/src/app/workflows/mutate-documents.ts`
- `renderer/src/app/workflows/mutate-documents.test.ts`
- `server/project-file-mutations.ts`
- `server/routes/file-operations.ts`
- `renderer/src/features/workspace/infrastructure/file-operation.ts`

## Document tabs, navigation, and continuity

- `renderer/src/app/composition/folder/use-document-sources.ts`
- `renderer/src/app/workflows/open-document.ts`
- `renderer/src/features/documents/application/tabs-runtime.ts`
- `renderer/src/features/documents/application/prepare-document.ts`
- `renderer/src/features/documents/ui/workspace/reading-surface.tsx`
- `renderer/src/features/documents/application/history-runtime.ts`
- `renderer/src/features/documents/application/navigation-runtime.ts`
- `renderer/src/features/documents/hooks/use-document-commands.ts`
- `renderer/src/features/documents/hooks/use-new-tab.ts`
- `renderer/src/features/documents/ui/workspace/tabs.tsx`
- `renderer/src/features/documents/ui/workspace/new-tab.tsx`
- `renderer/src/features/documents/ui/workspace/workspace.tsx`

## Document editing, preview, saving, and conflicts

- `renderer/src/features/documents/application/document-runtime.ts`
- `renderer/src/features/documents/ui/markdown/changes.ts`
- `renderer/src/features/documents/domain/conflict-diff.ts`
- `renderer/src/features/documents/hooks/use-document-source.ts`
- `renderer/src/features/documents/hooks/use-document-save-barrier.ts`
- `renderer/src/features/documents/ui/source/registry.tsx`
- `renderer/src/features/documents/ui/source/text.tsx`
- `renderer/src/features/documents/ui/source/asset.tsx`
- `renderer/src/features/documents/ui/source/conflict.tsx`
- `renderer/src/features/documents/ui/source/document-conflict.test.tsx`
- `renderer/src/features/documents/ui/markdown/document.tsx`
- `renderer/src/features/documents/ui/code-editor/use-editor-session.ts`
- `renderer/src/features/documents/ui/html/document.tsx`
- `server/file-save.ts`
- `server/text-file-transaction.ts`
- `server/markdown-source-format.ts`

## Search and opening source matches

- `renderer/src/features/retrieval/ui/project-search.tsx`
- `renderer/src/features/retrieval/ui/project-search.test.tsx`
- `renderer/src/features/retrieval/ui/search/surface.tsx`
- `renderer/src/features/retrieval/ui/search/exact-backend.tsx`
- `renderer/src/features/retrieval/ui/managed-quick-open.tsx`
- `renderer/src/features/retrieval/domain/exact-search.ts`
- `renderer/src/features/documents/domain/link-target.ts`

## Infrastructure coverage audit (entry points and callers only)

- `renderer/src/features/settings/ui/managed-settings.tsx`
- `renderer/src/app/dependencies.ts`
- `server/index.ts`
- `server/routes/upload.ts`
- `server/terminal.ts`
- `server/routes/terminal.ts`
- `server/agent-cli.ts`
- `server/agent-runtime-installer.ts`
- `server/agent-runtime-paths.ts`
- `server/watcher.ts`
- `server/state-db.ts`
- `server/conversion-status.ts`
- `server/index-status.ts`
- `mcp/server.ts`
- `mcp/project-server.ts`
- `mcp/project-operations-http.ts`
- `electron/main.cjs`
- `renderer/knip.json`
- `renderer/src/features/agent/application/failure-messages.ts`
- `renderer/src/features/agent/domain/agent-catalog.ts`

## Agent installation, discovery, session startup, and process retirement

- `server/agent-runtime-installer.ts`
- `server/agent-runtime-paths.ts`
- `server/agent-cli.ts`
- `server/agent-probe.ts`
- `server/routes/terminal.ts`
- `server/agent-mcp.ts`
- `server/agent-rules.ts`
- `server/agent-contract.ts`
- `server/agent-adapters.ts`
- `server/agent-model-catalog.ts`
- `server/claude-model-catalog.ts`
- `server/codex-model-catalog.ts`
- `server/codex-app-server-process.ts`
- `server/codex-rpc-transport.ts`
- `server/codex-session-runtime.ts`
- `server/codex-history.ts`
- `server/agent.ts`
- `server/opencode-runtime.ts`
- `server/opencode-agent.ts`
- `server/agent-process.ts`
- `server/extractor-process.ts`
- `server/index.ts`
- `renderer/src/features/agent/infrastructure/catalog-api.ts`
- `renderer/src/features/settings/domain/agent-runtime-status.ts`
- `server/__tests__/agent-runtime-recovery.test.ts`
- `renderer/src/features/settings/hooks/use-agent-runtimes.ts`
- `renderer/src/features/settings/infrastructure/agent-runtime-api.ts`
- `renderer/src/features/settings/ui/agents/agents-panel.tsx`
- `renderer/src/features/settings/ui/agents/debug-block.tsx`
- `renderer/src/features/settings/ui/agents/runtime-row.tsx`

## Parsing and background preparation

- `server/conversion-dispatch.ts`
- `server/conversion.ts`
- `server/conversion-scheduler.ts`
- `server/conversion-status.ts`
- `server/pdf.ts`
- `server/image.ts`
- `server/docx.ts`
- `server/prepared-validation.ts`
- `server/derived-store.ts`
- `server/routes/indexing.ts`
- `server/python-host.ts`
- `server/extractor-runtime.ts`
- `server/extractor-process.ts`
- `server/background-recovery.test.ts`
- `server/extractor-runtime.test.ts`
- `python/pdf_extract.py`
- `python/ocr_extract.py`

## Index reconciliation and daemon lifecycle

- `server/sync.ts`
- `server/state.ts`
- `server/indexer.mfs.ts`
- `server/mfs-daemon.ts`
- `server/indexable.ts`
- `server/watcher.ts`
- `server/index.ts`
- `python/stashbase_daemon.py`
- `python/stashbase_daemon_test.py`
- `server/semantic-index-inputs.test.ts`
- `server/semantic-indexing-state.test.ts`

## External MCP connection, authorization, and project operations

- `mcp/server.ts`
- `mcp/stdio-guard.ts`
- `mcp/project-server.ts`
- `mcp/project-operations-http.ts`
- `server/agent-mcp.ts`
- `server/mcp-http-service.ts`
- `server/mcp-http-settings.ts`
- `server/routes/mcp.ts`
- `server/routes/mcp-http.ts`
- `server/routes/project-files.ts`
- `server/project-operations/index.ts`
- `server/project-request-scope.ts`
- `server/project-file-access.ts`
- `renderer/src/features/settings/hooks/use-mcp-access.ts`
- `renderer/src/features/settings/domain/mcp-access.ts`

## Settings, credentials, and local persistence

- `server/app-config.ts`
- `server/agent-model-catalog.ts`
- `server/state-db.ts`
- `server/local-data.ts`
- `server/routes/embedder.ts`
- `server/http.ts`
- `renderer/src/features/settings/ui/managed-settings.tsx`
- `renderer/src/features/settings/ui/ai-index/ai-index-panel.tsx`
- `renderer/src/features/settings/hooks/use-settings-command.ts`
- `renderer/src/features/settings/hooks/use-appearance.ts`
- `renderer/src/features/settings/hooks/use-embedder.ts`

## File import and transient Chat attachments

- `server/routes/upload.ts`
- `server/import-publication.ts`
- `server/routes/attach.ts`
- `renderer/src/features/workspace/ui/file-import.tsx`
- `renderer/src/features/workspace/hooks/use-file-import.ts`
- `renderer/src/features/workspace/infrastructure/upload-api.ts`
- `renderer/src/features/workspace/infrastructure/adapters.ts`
- `renderer/src/features/agent/infrastructure/context-api.ts`
- `renderer/src/features/agent/application/session/dispatch.ts`
- `renderer/src/features/agent/application/session-runtime.ts`

## Desktop startup, request trust, crash, and shutdown

- `electron/main.cjs`
- `electron/main-probe.cjs`
- `electron/window/lifecycle.ts`
- `electron/window-security.cjs`
- `electron/app-protocol.cjs`
- `electron/renderer/requests.cjs`
- `server/middleware/renderer-origin.ts`
- `server/parent-watchdog.ts`
- `server/stale-lock.ts`

## Default Agent model requests and cancellation

- `server/hosted-agent-broker.ts`
- `server/opencode-agent.ts`
- `server/opencode-runtime.ts`
- `server/__tests__/hosted-agent-broker.test.ts`

## Bug reports and usage statistics

- `electron/bug-report-service.cjs`
- `electron/bug-report-handoff.cjs`
- `electron/bug-report/review-ipc.ts`
- `electron/bug-report-redaction.cjs`
- `electron/bug-report-log.cjs`
- `electron/bug-report-screenshot.cjs`
- `server/telemetry.ts`
- `renderer/src/features/settings/hooks/use-telemetry.ts`
- `renderer/src/features/settings/ui/general/general-panel.tsx`

## Updates, packaging, and release publication

- `electron/update-manager.cjs`
- `electron/update-window-barrier.cjs`
- `electron/update-install-strategy.cjs`
- `scripts/package-desktop.mjs`
- `scripts/require-green-ci.mjs`
- `scripts/publish-github-release.mjs`
- `scripts/update-artifact-contract.mjs`
- `.github/workflows/release.yml`
- `.github/workflows/release-ci-gate.yml`
- `.github/workflows/release-macos.yml`
- `.github/workflows/release-windows.yml`
- `.github/workflows/release-linux.yml`
- `.github/actions/prepare-native-components/action.yml`

## Remaining infrastructure and caller audit

- `server/routes/folders.ts`
- `server/project-file-mutations.ts`
- `server/routes/upload.ts`
- `renderer/src/features/workspace/ui/file-tree.tsx`
- `renderer/src/features/workspace/infrastructure/adapters.ts`
- `scripts/check-test-inventory.mjs`
- `package.json`

## Settings information architecture and contextual setup

- `renderer/src/features/settings/ui/managed-settings.tsx`
- `renderer/src/features/settings/ui/shell.tsx`
- `renderer/src/features/settings/ui/general/general-panel.tsx`
- `renderer/src/features/settings/ui/general/local-component-group.tsx`
- `renderer/src/features/settings/ui/general/telemetry-group.tsx`
- `renderer/src/features/settings/ui/appearance/appearance-panel.tsx`
- `renderer/src/features/settings/domain/appearance.ts`
- `renderer/src/features/settings/ui/agents/agents-panel.tsx`
- `renderer/src/features/settings/ui/agents/runtime-row.tsx`
- `renderer/src/features/settings/ui/agents/allowance-row.tsx`
- `renderer/src/features/settings/ui/agents/debug-block.tsx`
- `renderer/src/features/settings/ui/account/sidebar-account-row.tsx`
- `renderer/src/features/settings/ui/ai-index/ai-index-panel.tsx`
- `renderer/src/features/settings/ui/mcp/mcp-access-panel.tsx`
- `renderer/src/features/agent/hooks/use-agent-access.ts`
- `renderer/src/features/preparation/ui/status-line.tsx`
- `renderer/src/features/retrieval/domain/semantic-readiness.ts`
- `renderer/src/features/settings/hooks/use-local-component.ts`
- `electron/multi-window.cjs`
- `renderer/src/features/settings/ui/advanced-panel.tsx`
- `renderer/src/features/settings/ui/general/local-component-recovery.tsx`
- `renderer/src/features/settings/ui/developer-tools.tsx`
- `renderer/src/app/composition/layout/workspace-dialogs.tsx`
- `renderer/src/app/composition/layout/workspace-panes.tsx`

## Product necessity and project-first sessions

- Conversation scope and history → `server/agent-contract.ts`, `server/agent-session-registry.ts`, `server/claude-history.ts`, `server/codex-history-adapter.ts`, `server/opencode-agent.ts`, `server/routes/agent-sessions.ts`, `renderer/src/features/agent/application/workspace-runtime.ts`.
- Persona and project creation → `server/agent-persona.ts`, `server/agent-projects.ts`, `mcp/project-server.ts`.
- Source mutation and derived ownership → `server/active-file-operations.ts`, `server/project-file-mutations.ts`, `server/derived-store.ts`.
- Native report entry and package dependencies → `electron/main.cjs`, `electron/renderer/preload.ts`, `package.json`, `renderer/package.json`.

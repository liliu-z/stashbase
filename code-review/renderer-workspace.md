# Renderer Workspace

> Review contract for one window's active-folder workspace, document tabs,
> retrieval presentation, shell overlays, and renderer liveness.

## Scope and Ownership

The active-folder workspace is the deep renderer Module. It owns folder,
document, file-mutation, and retrieval transitions behind one Interface. The
application shell owns presentation composition—Chat, dialogs, toasts, Find,
and layout—and calls that Interface instead of duplicating transition rules.

Renderer state is retained presentation state, not durable truth. The server
owns membership, source bytes, source versions, preparation completion, and
semantic readiness.

## Workspace Invariants

- Every asynchronous folder open, file load, index refresh, and binary stat
  applies only while its captured folder, tab, and generation remain current.
- Folder switching resets folder-scoped documents and readiness without
  clearing library search or silently rebinding a started or drafted Chat.
- An out-of-folder result retains its owning member folder and stays read-only;
  it never resolves against a same-named file in the active folder.
- Document navigation and native context release cross the same save barrier.
  A failed save blocks the transition and keeps the recoverable buffer mounted.
- Tabs, trees, overlays, and dialogs expose semantic selection/focus state.
  Overlay dismissal restores focus to the initiating control.
- JSON Tree/Source mode, expansion, selected path, and tree query are retained
  per recent tab. Only the active JSON tab owns Find/editor registration, and
  the bounded tree entry remains lazy.
- Polling, timers, controllers, and native subscriptions retire when their
  generation or window context ends. Late results cannot repopulate reset
  state.
- The blank-chat lifecycle follows [Agent Panel](agent-panel.md); the workspace
  may reveal or dock it but does not redefine Agent session scope.

## Shell Performance Contract

The initial renderer contains only window chrome and the minimum workspace
shell. Feature surfaces that open on demand remain dynamic entries. The
authoritative budget is `423 KiB` of initial static JavaScript, and the current
required dynamic-entry set lives in `scripts/check-renderer-chunks.mjs`.
Change that list or budget only when the ownership of eager shell behavior
changes, never to make an accidental dependency pass.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Interface | `ActiveFolderWorkspace` in `web-src/src/store/useActiveFolderWorkspace.ts` |
| Primary owners | `web-src/src/store/state.ts`, `stateReducer.ts`, `stateHelpers.ts`, `folderScopedReset.ts`, and the internal `useDocumentActions.ts`, `useFileActions.ts`, `useFolderActions.ts`, `useSearchActions.ts` Modules |
| Shell Adapter | `web-src/src/store/AppContext.tsx`, `web-src/src/App.tsx`, `web-src/src/components/MainPane.tsx` |
| Server transport Adapter | `web-src/src/api.ts`, `web-src/src/apiTransport.ts` |
| Electron lifecycle Adapter | `onPrepareContextRelease` and folder/library events consumed by `useActiveFolderWorkspace.ts` |
| Focused evidence | `web-src/src/store/__tests__/`, `web-src/src/__tests__/folder-transition.test.ts`, `workspace-layout.test.ts`, `index-status-request.test.ts`, `overlay-stack.test.ts`, `lazy-load.test.ts`, `api-transport.test.ts`, and `scripts/check-renderer-chunks.mjs` |

The four action hooks are private Seams inside the workspace Module. Do not make
components depend on them directly; that would create a second transition
Interface.

## Validation

Run:

```bash
pnpm typecheck
pnpm test:renderer
pnpm build:web
```

Run `pnpm test:e2e:smoke` for launch/navigation/save behavior and
`pnpm test:e2e:functional` for affected folder, tab, search, focus, or layout
journeys. Use `pnpm test:e2e:visual` only for representative composition
changes.

Related journeys: [J01](../design-docs/user-journeys.md#j01-complete-onboarding-and-reach-first-value),
[J02](../design-docs/user-journeys.md#j02-add-and-open-a-folder), and
[J03](../design-docs/user-journeys.md#j03-read-and-edit-source-documents), plus
[J05](../design-docs/user-journeys.md#j05-search-and-open-source-evidence) for
search presentation and result navigation, and
[J10](../design-docs/user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
for the complete cross-surface loop, and
[J11](../design-docs/user-journeys.md#j11-turn-a-conversation-into-a-project)
for project registration and originating-window entry.
Related contracts: [Window Lifecycle](window-lifecycle.md),
[File Transactions](file-transactions.md), [Agent Panel](agent-panel.md), and
[UI Regression Testing](ui-regression-testing.md).

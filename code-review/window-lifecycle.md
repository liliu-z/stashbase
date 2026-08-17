# Window Lifecycle

> Review contract for native window identity, renderer durability, shared
> service ownership, and application shutdown.

## Scope and Owners

- Electron main owns `BrowserWindow` identities, native accelerators, close
  orchestration, the single-instance lock, and the child server process.
- The renderer owns the live edit and reports when its save handler is ready.
- The Node server owns per-window folder and Agent bindings plus identity
  retirement.

## State Transitions

```text
created → renderer loaded → save handler ready → context release requested
        → save acknowledged → close: identity retired → native window closed
                            → reload: identity retained → renderer replaced
```

`did-finish-load` is not save readiness. Navigation invalidates the previous
registration. Before readiness there cannot yet be a renderer-owned edit;
after readiness, a save failure or timeout keeps the window open.

## Invariants

- Each window has one stable identity used by HTTP, asset URLs, Agent sockets,
  and server-side folder context.
- Native close awaits the current renderer save barrier before retiring the
  identity. Retirement installs a bounded tombstone so an in-flight open
  request cannot recreate a ghost binding.
- Product-owned reload is error recovery, not ordinary navigation. Native
  Reload and Force Reload menu and keyboard bypasses are absent. Recovery crosses
  main's awaited save barrier; if the failed renderer can no longer answer,
  reload requires a second explicit risk confirmation.
- Closing one window releases only that window's folder and Agent state,
  revokes all active preview grants registered for it, and cleans up its
  pending native-open queue. Shared server, daemon, settings, MCP, and other
  windows remain live.
- Native file-open requests from OS events, CLI arguments, and second-instance
  launches are queued for one target window identity rather than drained
  globally, so cold startup and focused windows receive only their own files.
- Removing a library folder flushes every window showing it, commits membership
  removal, and broadcasts the transition. Recovery may rebind only if durable
  membership still contains the folder.
- A single-flight initial-window operation plus the single-instance lock
  prevents startup races from creating duplicate windows.
- An Electron-owned source server is always launched with the general
  development-runtime marker, which keeps live Python sources and development
  controls available. The narrower Vite marker is present only when a Vite
  renderer is actually running; a direct source launch and the lifecycle smoke
  serve the built renderer instead of proxying to an absent process. Those
  non-Vite launches use the actual server as Electron's one child so shutdown
  cannot orphan a listener behind a watch wrapper. Packaged launches explicitly
  remove both markers.
- Browser-owned OAuth returns focus only through the packaged `stashbase://`
  handler, which accepts the exact data-free `oauth-complete` authority.
  Renderer polling updates account state without racing that browser-owned
  handoff. Node retains the initiating window identity on the opaque flow, and
  the callback records return intent before opening the fixed deep link so
  Electron can restore that live window rather than whichever window was
  focused most recently. macOS `open-url`, Windows/Linux second instances, and
  cold-start arguments converge on the same bounded focus path; all other
  protocol URLs are inert and a cold invalid launch exits without creating a
  window. Electron authenticates its loopback acknowledgement with a random
  per-launch child-process token so the browser page closes only on evidence
  from the exact native handler.
- macOS may remain alive without a window and recreate one on activation.
  Windows and Linux quit after the final window closes. Platform window
  accelerators never masquerade as document-tab commands.
- Native Help remains main-process-owned and usable when the renderer cannot
  paint. Website, Community Discord, and Report an Issue open fixed shared URLs
  in the system browser; Report a Bug enters the J09 review flow. These are
  cross-cutting support routes, not separate product journeys.
- Electron main owns release checks and installation. The renderer receives a
  bounded state snapshot and may request Check or one Update operation; it
  cannot select a feed or installer path. Update downloads, crosses every ready
  renderer save barrier, invokes the platform installer, and relaunches. A save
  failure leaves the downloaded update ready for retry. Windows uses silent
  NSIS after the explicit click; Authenticode publisher verification applies
  when the installed build was signed. Linux deb may request elevation. The
  AppImage Adapter applies without force-running a competing instance and asks
  Electron to relaunch the final filename after the old process exits.
- Frameless chrome remains draggable on every desktop platform; macOS
  traffic-light layout is selected only by the exact Darwin platform marker.

## Shutdown

Electron sends a random per-launch token to the child server, requests loopback
shutdown with that token, and waits for the cleanup ladder. The ladder isolates
MCP listeners, conversions/native children, state storage, and index closure so
one failure cannot skip later owners. OS signals are bounded fallbacks because
Windows signal behavior is not a graceful child shutdown contract.

## Bug-report review windows

The review is an independent dialog-sized window, never a child or modal of its
source, so an open review survives the source closing. It cannot enter full
screen. When created from a full-screen source, it floats in that space instead
of switching macOS to a separate desktop. Closing the review retires its native
identity and tells the owning Bug Reporting Module to discard the bound draft.

Draft authority, preload/IPC scope, privacy, approval, and handoff are owned by
[Bug Reporting](bug-reporting.md); this contract owns only the native window's
creation, presentation, survival, and retirement.

## Failure and Recovery

- Save error or timeout: leave the native window open and surface the failure.
- Reload save error or timeout: keep the current renderer and buffer; never
  turn the error-recovery button into a force reload.
- Late request after retirement: reject it; never recreate window state.
- Initial quit cancelled by an asynchronous window guard: resume quit through
  the platform-specific final-window path.
- Child cleanup timeout: use the bounded fallback and retain diagnostics.
- Second launch during startup: route to the existing application instance.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Native window Module | `electron/multi-window.cjs` |
| Process owner Adapter | `electron/main.cjs`; child-environment construction in `electron/main-probe.cjs` |
| Renderer bridge Adapter | `electron/preload.cjs` and `useActiveFolderWorkspace.ts` |
| Server context Interface | window-scoped registry and retirement in `server/folder.ts` |
| HTTP Adapters | `server/routes/window-context.ts`, `server/routes/internal-shutdown.ts` |
| Cleanup Interface | `server/shutdown-cleanup.ts` |
| Bug-report window Adapter | `electron/bug-report-review-window.cjs`; draft authority lives in [Bug Reporting](bug-reporting.md) |
| Desktop update Module | `electron/update-manager.cjs`; platform install strategy in `electron/update-install-strategy.cjs`; all-window save barrier in `electron/update-window-barrier.cjs`; IPC and native Adapters in `electron/main.cjs` and `electron/preload.cjs` |
| Focused evidence | `electron/multi-window.test.cjs`, `electron/update-manager.test.cjs`, `electron/update-install-strategy.test.cjs`, `electron/update-window-barrier.test.cjs`, `electron/multi-window-smoke.cjs`, `server/folder-window.test.ts`, `server/window-context-route.test.ts`, `server/internal-shutdown-route.test.ts`, `server/__tests__/shutdown-cleanup.test.ts` |

## Validation

Run:

```bash
pnpm typecheck
pnpm test:electron
pnpm test:electron:smoke
pnpm test:conversion-scheduler
pnpm test:mcp
```

The last two broad server suites own the current window-context, internal
shutdown, and cleanup tests. Cover save readiness, failed save, two independent
windows, folder removal, last-window platform behavior, clean port release,
and a second launch against the same state.

Related journeys: [J01](../design-docs/user-journeys.md#j01-complete-onboarding-and-reach-first-value),
[J02](../design-docs/user-journeys.md#j02-add-and-open-a-folder), and
[J03](../design-docs/user-journeys.md#j03-read-and-edit-source-documents), plus
[J09](../design-docs/user-journeys.md#j09-prepare-and-hand-off-a-bug-report) for
the dedicated review window.

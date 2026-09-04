/**
 * Session-history popover for one history scope: the active folder's
 * header row lists that folder's sessions, and the New Chat row lists
 * ALL sessions across the library (each row labeled with its home and
 * resumed in its own scope). The menu merges every Agent's sessions
 * (newest first, each row carrying its agent's glyph — the New Chat
 * row's agent label is only the default for NEW chats, never a history
 * filter); rename/delete route through the row's agent and scope, and
 * resume hands off through the store's pending-resume channel (see
 * `sessionHistory.ts`).
 *
 * The sidebar owns the clock trigger and lazy-mounts this component at
 * the interaction boundary, so the popover is standalone: `triggerRef`
 * anchors it and it is open for exactly as long as it is mounted.
 */
import { useMemo, useState, type RefObject } from 'react';
import { Button } from '@/common/components/ui/button';
import { Popover, PopoverContent } from '@/common/components/ui/popover';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/common/components/ui/alert-dialog';
import { AGENTS, AGENT_META, type AgentKind } from '@/common/lib/agentCatalog';
import { EditIcon, TrashIcon } from '@/common/components/icons';
import { basename } from '@/common/lib/paths';
import { Input } from '@/common/components/ui/input';
import { EmptyState } from '@/common/components/ui/empty-state';
import type { HistoryScope } from '@/common/lib/libraryScope';
import { rowResumeFolder, type MergedSessionRow } from '@/features/agent-panel/lib/sessionHistory';
import { useSessionHistory } from '@/features/agent-panel/hooks/useSessionHistory';

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString();
}

const rowKey = (row: MergedSessionRow) => `${row.agent}:${row.id}`;

export function SessionHistoryMenu({
  scope, ariaLabel, triggerRef, onClose, onResume,
}: {
  /** The scope whose sessions this menu lists — fixed per anchor,
   *  independent of any chat tab's picked scope. `all` (the New Chat
   *  row) lists every session across the library, each row labeled and
   *  resumed in its own scope. */
  scope: HistoryScope;
  ariaLabel: string;
  /** The sidebar clock button this popover anchors to. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** Dismissal (outside press / Escape). Selecting a session calls
   *  `onResume` instead; the owner closes in both paths. */
  onClose: () => void;
  onResume: (agent: AgentKind, sessionId: string, folder: string | null) => void;
}) {
  const { rows, failedAgents, pendingAgents, rename, remove } = useSessionHistory(scope);
  const [q, setQ] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /* Which row's confirmation is open. Controlled rather than left to the
   * trigger, because a failed delete must KEEP the dialog open so its
   * error stays where the action was taken. */
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? rows.filter((row) => row.title.toLowerCase().includes(needle)) : rows;
  }, [rows, q]);

  /* "Loading…" only while NOTHING has answered: the first settled agent's
   * rows render immediately and stragglers get the quiet note below, so
   * one slow runtime (Codex lists through a spawned app-server) never
   * holds the menu blank. */
  const loading = pendingAgents.length === AGENTS.length;
  const allFailed = failedAgents.length === AGENTS.length;

  async function commitRename(row: MergedSessionRow) {
    const title = editText.trim();
    setEditingKey(null);
    if (!title) return;
    await rename(row, title);
  }

  async function removeRow(row: MergedSessionRow): Promise<boolean> {
    const ok = await remove(row);
    if (!ok) setDeleteError('Could not delete this session. Try again.');
    return ok;
  }

  return (
    <Popover open onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* The trigger lives in the pane header, not here, so the popup is
        * anchored to it by ref rather than wrapped around it. */}
      <PopoverContent
        anchor={triggerRef}
        side="bottom"
        align="end"
        aria-label={ariaLabel}
        className="session-history-popover w-80 max-w-overlay-fit p-1.5"
      >
        <div className="px-0.5 pt-0.5 pb-1.5">
          <Input
            type="text"
            autoFocus
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="max-h-80 overflow-y-auto">
          {loading && <EmptyState>Loading…</EmptyState>}
          {!loading && allFailed && <EmptyState>Could not load sessions.</EmptyState>}
          {!loading && !allFailed && failedAgents.length > 0 && (
            // Partial failure stays quiet: the loaded Agents' rows render
            // normally with one muted note for the missing runtime.
            <div className="px-2.5 pt-0.5 pb-1 text-xs text-muted-foreground" role="status">
              {failedAgents.map((agent) => AGENT_META[agent].shortName).join(' and ')} history could not be loaded.
            </div>
          )}
          {!loading && pendingAgents.length > 0 && (
            // A straggler follows the same quiet idiom while its rows are
            // still on the way.
            <div className="px-2.5 pt-0.5 pb-1 text-xs text-muted-foreground" role="status">
              {pendingAgents.map((agent) => AGENT_META[agent].shortName).join(' and ')} history is still loading…
            </div>
          )}
          {!loading && !allFailed && pendingAgents.length === 0 && shown.length === 0 && (
            <EmptyState>{q ? 'No matches.' : 'No sessions yet.'}</EmptyState>
          )}
          {/* Sessions are a list. The empty/partial-failure notices above
            * stay outside it so the list holds only `<li>`s and its count
            * is the number of sessions. */}
          {!loading && !allFailed && shown.length > 0 && (
            <ul className="m-0 list-none p-0">
              {shown.map((row) => {
                const key = rowKey(row);
                const AgentIcon = AGENT_META[row.agent].Icon;
                return (
                  // Time and hover-revealed actions share the one right-hand
                  // slot: time shows at rest, hover/focus swaps in edit/delete.
                  <li
                    key={key}
                    className="group/row relative flex items-center rounded-md hover:bg-muted"
                  >
                    {editingKey === key ? (
                      // Same `Input` primitive as the search field above, sized
                      // down to sit inside a row, keeping the primitive's own
                      // neutral stroke — an edit box is delimited, not
                      // "selected". This field is autofocused the moment it
                      // appears.
                      <Input
                        className="mx-1.5 my-1 h-auto w-auto flex-1 rounded-md px-2 py-1"
                        autoFocus
                        aria-label={`Rename ${row.title}`}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void commitRename(row); }
                          else if (e.key === 'Escape') setEditingKey(null);
                        }}
                        onBlur={() => void commitRename(row)}
                      />
                    ) : (
                      <Button
                        variant="ghost"
                        className="h-auto min-w-0 flex-1 justify-start gap-2 px-2.5 py-2 text-left text-foreground"
                        aria-label={`Resume ${row.title}`}
                        onClick={() => onResume(row.agent, row.id, rowResumeFolder(scope, row))}
                      >
                        <AgentIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-base">{row.title}</span>
                        <span className="shrink-0 truncate text-xs text-muted-foreground group-hover/row:hidden group-focus-within/row:hidden">
                          {/* The all-scope listing names each row's home so
                            * "which folder was this?" never needs a click. */}
                          {scope.kind === 'all' && `${row.folder ? basename(row.folder) : 'Library'} · `}
                          {relTime(row.lastModified)}
                        </span>
                      </Button>
                    )}
                    <div className="hidden shrink-0 gap-px pr-1.5 group-hover/row:flex group-focus-within/row:flex">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground [&_svg]:size-3.5"
                        aria-label={`Rename ${row.title}`}
                        onClick={() => { setEditingKey(key); setEditText(row.title); }}
                      >
                        <EditIcon />
                      </Button>
                      <AlertDialog
                        open={confirmKey === key}
                        onOpenChange={(isOpen) => {
                          setConfirmKey(isOpen ? key : null);
                          if (isOpen) setDeleteError(null);
                        }}
                      >
                        <AlertDialogTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="text-muted-foreground [&_svg]:size-3.5"
                              aria-label={`Delete ${row.title}`}
                            />
                          }
                        >
                          <TrashIcon />
                        </AlertDialogTrigger>
                        {/* States its own rhythm now that the primitive ships
                          * none — the same 14px the app's other confirmation
                          * (ManagedAlertConfirmModal) puts under its header.
                          *
                          * `layer="menu"`: this dialog is raised from a row
                          * INSIDE the history popover, which stays open
                          * behind it (the popover is controlled `open` and
                          * only closes by unmounting). On the ordinary
                          * modal pair it renders behind that popover and
                          * its backdrop dims everything except the one
                          * surface it has to block. */}
                        <AlertDialogContent layer="menu" className="w-overlay-md gap-3.5">
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Delete “{row.title}”? This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          {deleteError && <p className="m-0 text-sm text-status-danger" role="alert">{deleteError}</p>}
                          <AlertDialogFooter>
                            <AlertDialogCancel render={<Button variant="outline" />}>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              render={<Button variant="destructive" />}
                              onClick={(event) => {
                                event.preventDefault();
                                void removeRow(row).then((deleted) => {
                                  if (deleted) setConfirmKey(null);
                                });
                              }}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

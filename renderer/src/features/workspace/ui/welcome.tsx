/** What a window shows before any folder is open: the project's recent
 *  folders, the three ways to add one, and the Gallery band the caller
 *  composes in. */
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import type {
  ProjectLifecyclePort,
  ProjectRegistryPort,
} from '@/features/workspace/application/ports';
import { projectQuery } from '@/features/workspace/application/queries';
import {
  displayFolderPath,
  folderName,
  isTemporaryFolderPath,
  parentFolderPath,
} from '@/features/workspace/domain/project';
import type { ProjectEntry } from '@/features/workspace/hooks/use-project-entry';
import { useRemoveFolder } from '@/features/workspace/hooks/use-remove-folder';
import { focusRing } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { useSize } from '@/lib/size-context';
import { cn } from '@/lib/utils';
import { Logo } from '@/shared/brand/logo';
import { FailureLine } from '@/shared/ui/failure-notice';
import { PathTail } from '@/shared/ui/path-tail';
import { holdsTextSelection } from '@/shared/utils/click-intent';

import { RemoveFolderDialog } from './remove-folder-dialog';

export interface ProjectWelcomeProps {
  api: ProjectRegistryPort;
  entry: ProjectEntry;
  /** The Gallery band. Composed rather than owned here: the shop is its own
   *  feature, and this screen is only one of the two ways in. */
  gallery?: ReactNode;
  isRestoringSession?: boolean;
  lifecycle: ProjectLifecyclePort;
}

/** One of the screen's two framed columns: paper, hairline, and a caption
 *  header, so Start and Recent read as one titled pair. */
function FramedColumn({ children, title }: { children: ReactNode; title: string }) {
  const shape = useShape();
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col border border-border bg-surface-2 shadow-surface-2',
        shape.card,
      )}
    >
      <h2 className="border-b border-border px-4 py-3 text-caption font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </div>
  );
}

/** The row's one action, shown on hover: a direct ✕ that asks the remove
 *  dialog, the way an editor clears a recents row — one action needs no
 *  menu. It is a sibling of the row rather than a child, because the row is
 *  itself a button and a button cannot hold another. A bare button rather
 *  than the kit's ghost: its hover fill would nest a second gray box inside
 *  the row's own tint, so the hover feedback here is ink alone, and
 *  only the press paints a fill. */
function RecentFolderActions({
  disabled,
  name,
  onRemove,
}: {
  disabled: boolean;
  name: string;
  onRemove(): void;
}) {
  const shape = useShape();
  return (
    <button
      aria-label={`Remove ${name}`}
      className={cn(
        'absolute top-1/2 right-2 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center text-muted-foreground opacity-0 transition-[color,opacity] duration-fast outline-none',
        shape.item,
        // group-has-[:focus-visible], not group-focus-within: a mouse click
        // on the row leaves focus inside it, and focus-within would then keep
        // the ✕ standing over an untinted row long after the pointer left.
        // Keyboard focus still reveals it, which is the case focus was for.
        'group-hover:opacity-100 group-has-[:focus-visible]:opacity-100',
        'hover:text-foreground active:bg-hover disabled:pointer-events-none',
        '[&_svg]:size-4 [&_svg]:stroke-[1.5]',
        focusRing(),
      )}
      disabled={disabled}
      onClick={onRemove}
      type="button"
    >
      <X aria-hidden="true" />
    </button>
  );
}

export function ProjectWelcome({
  api,
  entry: folders,
  gallery,
  isRestoringSession = false,
  lifecycle,
}: ProjectWelcomeProps) {
  const project = useQuery(projectQuery(api));
  const removal = useRemoveFolder(api, lifecycle);
  const importDialog = folders.importDialog;
  const sizeClasses = useSize();

  if (!project.data || project.data.activeFolder || isRestoringSession) return null;

  const { homeDirectory } = project.data;
  // The list is a memory of the places the reader works, so the scratch
  // directories a smoke test or an import registers stay out of it, as they
  // do from the sidebar's switcher. They remain projects.
  const recent = project.data.projects.filter((member) => !isTemporaryFolderPath(member.path));
  const creating = folders.pendingRequest?.kind === 'create';
  const opening = folders.pendingRequest?.kind === 'open';

  // Each button is one verb; the row's text says what the verb acts on. The
  // accessible name keeps the object, because a button read on its own has
  // no row beside it.
  const ways = [
    {
      action: (
        <Button
          aria-label="Open a project"
          className="w-24 shrink-0"
          disabled={folders.isPending}
          loading={folders.isPending && opening}
          onClick={folders.open}
        >
          Open
        </Button>
      ),
      detail: 'Choose a local folder.',
      title: 'Open a project',
    },
    {
      action: (
        <Button
          aria-label="Create a project"
          className="w-24 shrink-0"
          disabled={folders.isPending}
          loading={folders.isPending && creating}
          onClick={() => folders.create(homeDirectory)}
          variant="tertiary"
        >
          Create
        </Button>
      ),
      detail: 'Create a new folder.',
      title: 'Create a project',
    },
    {
      action: (
        <Button
          aria-label="Import from GitHub"
          className="w-24 shrink-0"
          disabled={folders.isPending}
          onClick={importDialog.start}
          variant="tertiary"
        >
          Import
        </Button>
      ),
      detail: 'Copy a public repository to your computer.',
      title: 'Import from GitHub',
    },
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-11">
      <main className="@container my-auto flex w-full flex-col items-center">
        {/* The mark is a lockup, not a paragraph: name on one line, tagline
         * on one line. The measure is wide enough for the tagline to stay
         * single at the default size, so a centered two-line block never
         * argues with the hard left edge below it. */}
        <div className="flex w-full max-w-2xl flex-col items-center text-center">
          <div className="flex items-center gap-3">
            <Logo aria-hidden="true" className="size-10" />
            <h1 className="brand-wordmark text-display">StashBase</h1>
          </div>
          <p className="mt-3 text-body leading-relaxed text-muted-foreground">
            Keep your context in one place for recurring work.
          </p>
        </div>

        {/* Everything under the mark shares one measure, one left edge, and
         * one grid: the ways in, the recent list, and the shelf. Only the
         * mark stays centered, because it is a mark rather than a column.
         * The two cards are equal halves with the shelf's own gutter, so
         * their outer and inner edges land on the shelf's column lines
         * below; any other split leaves the screen with two grids. The card
         * leads: left of the list once the pane can hold both without the
         * card's rows stacking, above the list when it cannot. The two
         * columns share one height, so the card's rows spread to meet the
         * foot of the list's frame rather than leaving the card hanging
         * short beside it. The pane is what is measured, not the window: a
         * sidebar takes its share before this screen sees any width. */}
        <section aria-label="Choose a project" className="mt-10 w-full max-w-5xl">
          <div className="grid grid-cols-1 gap-6 @min-[44rem]:grid-cols-2">
            {/* Rules run edge to edge, as they do in every framed list in the
             * app, so the inset lives on the rows rather than the frame. */}
            <FramedColumn title="Start">
              <ul
                aria-label="Add a project"
                className="flex flex-1 flex-col divide-y divide-border"
              >
                {ways.map((way) => (
                  <li className="flex flex-1 items-center gap-4 px-4 py-3.5" key={way.title}>
                    <div className="min-w-0 flex-1">
                      <p className="text-body font-medium">{way.title}</p>
                      <p className="mt-0.5 text-caption leading-snug text-muted-foreground">
                        {way.detail}
                      </p>
                    </div>
                    {way.action}
                  </li>
                ))}
              </ul>
            </FramedColumn>

            {/* The list gets a frame of its own, the same paper and hairline
             * as the card beside it, so the column's weight is the box and
             * not however long the reader's paths happen to be: a short path
             * no longer leaves the right half empty, and a long one truncates
             * at the frame instead of running off. */}
            <FramedColumn title="Recent">
              {recent.length > 0 ? (
                /* Five 2.75rem rows plus the ring padding, so the list ends on
                 * a whole row: the fade at its foot then sits in the blank
                 * below the fifth row's text, never across a sliver of the
                 * sixth. Keep this sum in step with the row height below.
                 * The rows share the list's two columns through subgrid, so
                 * every path starts on one line. The split is fixed at two to
                 * three rather than sized to the longest name, so opening or
                 * removing a project never moves every path. */
                <ul
                  aria-label="Recent projects"
                  className="scroll-fade grid max-h-[14.25rem] grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 overflow-y-auto p-1 [--scroll-fade-size:1rem]"
                >
                  {recent.map((member) => {
                    const name = folderName(member.path);
                    const isOpening =
                      folders.pendingRequest?.kind === 'select' &&
                      folders.pendingRequest.path === member.path;
                    return (
                      <li
                        className="group relative col-span-2 grid grid-cols-subgrid"
                        key={member.path}
                      >
                        <button
                          className={cn(
                            // One line, no leading glyph: every row here is
                            // a folder, so the name carries the row and the
                            // path follows in the caption voice. The two-line
                            // stack read as a dense text block against the
                            // card's empty right.
                            // group-hover, not hover: the remove control is the row's sibling,
                            // outside this button, so the tint follows the pointer
                            // over the whole row, the ✕ included.
                            'col-span-2 grid h-11 cursor-pointer grid-cols-subgrid items-center pr-12 pl-4 text-left transition-colors duration-fast outline-none group-hover:bg-hover disabled:pointer-events-none disabled:opacity-50',
                            // The row is 44px, taller than the 28px sidebar
                            // row `shape.item` is cut for, so it takes the
                            // ladder's own corner for a full-size control.
                            sizeClasses.radius,
                            focusRing(),
                          )}
                          disabled={folders.isPending}
                          // The row's own text is selectable (see the spans
                          // below), so a drag that ends inside it arrives here
                          // as a click. Opening the project on the gesture that
                          // just copied its path would be the wrong answer.
                          onClick={(event) => {
                            if (holdsTextSelection(event.currentTarget)) return;
                            folders.select(member.path);
                          }}
                          title={member.path}
                          type="button"
                        >
                          {/* select-text: a button's text is not selectable by
                              default, and the name and the path beneath the
                              pointer are exactly what a reader reaches for
                              when they want to paste this project somewhere. */}
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 truncate text-body font-medium select-text">
                              {name}
                            </span>
                            {isOpening && (
                              <LoaderCircle
                                aria-label="Opening"
                                className="size-3.5 shrink-0 motion-safe:animate-spin"
                                strokeWidth={1.5}
                              />
                            )}
                          </span>
                          {/* The path trails the name in the caption voice,
                           * left-anchored in its column, because pushing it to
                           * the card's far edge leaves a dead gap this wide
                           * card cannot close. It stops at the directory the
                           * folder sits in; the name is already the row. */}
                          <PathTail
                            className="text-caption text-muted-foreground select-text"
                            path={displayFolderPath(parentFolderPath(member.path), homeDirectory)}
                          />
                        </button>
                        <RecentFolderActions
                          disabled={folders.isPending || removal.isPending}
                          name={name}
                          onRemove={() => removal.request(member.path)}
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-4 py-3 text-body leading-relaxed text-muted-foreground">
                  Projects you open will appear here.
                </p>
              )}
            </FramedColumn>
          </div>
          {folders.failure && (
            <FailureLine className="mt-3" tone="input">
              {folders.failure}
            </FailureLine>
          )}
          {removal.warning && (
            <p className="mt-3 text-caption text-muted-foreground" role="status">
              {removal.warning}
            </p>
          )}
        </section>

        {gallery && (
          <section className="mt-10 w-full max-w-5xl">
            <h2 className="text-title font-medium">Or start from a project in the Gallery</h2>
            <p className="mt-1 text-body leading-relaxed text-muted-foreground">
              Find ideas for your own workflow.
            </p>
            <div className="mt-4">{gallery}</div>
          </section>
        )}
      </main>
      <RemoveFolderDialog
        failure={removal.failure}
        folderPath={removal.target}
        homeDirectory={homeDirectory}
        onCancel={removal.cancel}
        onConfirm={removal.confirm}
        pending={removal.isPending}
      />
    </div>
  );
}

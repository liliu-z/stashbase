/** Where the document in front lives: its project, the folders under it, and
 *  its own name, in one quiet row above the page. Tabs show only a name, so
 *  this is what tells two files of one name apart. Each folder is a button
 *  that shows that folder in Files; the project and the document itself are
 *  only read. A file opened from outside the project names its directory
 *  and offers nothing to reveal, because the tree does not hold it. */
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';

import { sourceName } from '@/features/documents/domain/document';
import { focusRing } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { useSize } from '@/lib/size-context';
import { cn } from '@/lib/utils';
import { isExternalSource } from '@/shared/domain/external-source';
import type { SourceReference } from '@/shared/domain/source-reference';
import { basePathName } from '@/shared/utils/file-path';

interface Crumb {
  label: string;
  /** The project-relative folder a button reveals; absent, the crumb is text. */
  folder?: string;
}

/** The project and each folder above the document, outermost first. */
function breadcrumbTrail(source: SourceReference): Crumb[] {
  const path = source.path.replace(/\\/gu, '/');
  const cut = path.lastIndexOf('/');
  // An absolute path keeps the separators the system wrote it with.
  if (isExternalSource(source)) return cut > 0 ? [{ label: source.path.slice(0, cut) }] : [];
  const folders = cut > 0 ? path.slice(0, cut).split('/') : [];
  return [
    { label: basePathName(source.folderPath) },
    ...folders.map((label, index) => ({ folder: folders.slice(0, index + 1).join('/'), label })),
  ];
}

export function DocumentBreadcrumb({
  onRevealFolder,
  source,
}: {
  /** Shows a project-relative folder in Files. Absent, folders are text. */
  onRevealFolder?: ((folder: string) => void) | undefined;
  source: SourceReference;
}) {
  const sizeClasses = useSize();
  const shape = useShape();
  const trail = breadcrumbTrail(source);
  const separator = (
    <ChevronRight aria-hidden="true" className="shrink-0 opacity-60" size={12} strokeWidth={1.75} />
  );
  return (
    <nav
      aria-label="Document location"
      className={cn('flex min-w-0 shrink-0 px-3 pt-1 text-muted-foreground', sizeClasses.caption)}
    >
      <ol className="flex min-w-0 items-center gap-0.5">
        {trail.map(({ folder, label }, index) => (
          // The outer folders give way first, so the document's own name and
          // the folder nearest it stay readable in a narrow pane.
          <Fragment key={folder ?? `root-${index}`}>
            <li
              className="flex min-w-0 items-center"
              style={{ flexShrink: trail.length - index + 1 }}
            >
              {folder !== undefined && onRevealFolder ? (
                <button
                  className={cn(
                    'min-w-0 cursor-pointer truncate px-1 py-0.5 transition-colors duration-fast hover:bg-hover hover:text-foreground',
                    shape.chip,
                    focusRing(),
                  )}
                  onClick={() => onRevealFolder(folder)}
                  title={`Show ${folder} in Files`}
                  type="button"
                >
                  {label}
                </button>
              ) : (
                <span className="min-w-0 truncate px-1 py-0.5" title={label}>
                  {label}
                </span>
              )}
            </li>
            <li aria-hidden="true" className="flex shrink-0 items-center">
              {separator}
            </li>
          </Fragment>
        ))}
        <li className="flex min-w-0 shrink items-center">
          <span aria-current="page" className="min-w-0 truncate px-1 py-0.5 text-foreground">
            {sourceName(source)}
          </span>
        </li>
      </ol>
    </nav>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/common/components/ui/dialog';
import { Button } from '@/common/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/common/components/ui/tabs';
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FileGenericIcon,
  FolderIcon,
} from '@/common/components/icons';
import { cn } from '@/common/lib/utils';
import { useAppActions } from '@/store/contexts/AppContext';
import type { GalleryWiki } from '@/features/templates/gallery';
import { useDownloadWiki } from '@/features/templates/detail/useDownloadWiki';

/**
 * The gallery entry's detail — a product-page dialog over the gallery,
 * the shape of a Notion Marketplace template page rather than a
 * workspace.
 *
 * Full-width header: name over one grey sub-line, and at its right THE
 * action of the page — "Make a copy" acquires the entry's public
 * repository into the folder home (the existing GitHub import) and
 * opens it in a new window. Below, a fixed 300px column of two tabs:
 * "What's inside" is the copy's real file list as a collapsible
 * read-only tree (the index's inventory line stands in until an entry
 * publishes its list), and "How it's built" is the Build Wiki request
 * that produced the wiki, full-height with Copy pinned at the column's
 * foot. The right side belongs to curated screenshots (hero + thumbnail
 * switcher) once entries publish them; the placeholder doubles as the
 * offline state. Deliberately NOT a live file browser: the real files
 * travel only with the copy.
 */

interface TreeFolder {
  name: string;
  path: string;
  folders: TreeFolder[];
  files: string[];
}

function buildTree(paths: readonly string[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], files: [] };
  for (const filePath of paths) {
    const parts = filePath.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.find((folder) => folder.name === part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push(parts.at(-1) ?? filePath);
  }
  const sort = (node: TreeFolder) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.localeCompare(b));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** What's inside, truthfully: the copy's file list as a compact
 *  collapsible tree. Listing only — the screenshots carry content, and
 *  reading beyond them is what the copy is for. */
function FileTree({ paths }: { paths: readonly string[] }) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  function renderLevel(folder: TreeFolder, depth: number) {
    return (
      <>
        {folder.folders.map((child) => (
          <li key={child.path}>
            <button
              type="button"
              onClick={() => setCollapsed((previous) => {
                const next = new Set(previous);
                if (next.has(child.path)) next.delete(child.path);
                else next.add(child.path);
                return next;
              })}
              style={{ paddingLeft: depth * 14 }}
              className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent pr-2 text-sm text-foreground outline-none transition-tint hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ChevronDownIcon
                className={cn('size-3 flex-none text-placeholder transition-transform duration-fast', collapsed.has(child.path) && '-rotate-90')}
              />
              <FolderIcon className="size-3.5 flex-none text-muted-foreground" />
              <span className="min-w-0 truncate">{child.name}</span>
            </button>
            {!collapsed.has(child.path) && (
              <ul className="m-0 list-none p-0">{renderLevel(child, depth + 1)}</ul>
            )}
          </li>
        ))}
        {folder.files.map((name) => (
          <li
            key={`${folder.path}/${name}`}
            style={{ paddingLeft: depth * 14 + 18 }}
            className="flex h-6 items-center gap-1.5 pr-2 text-sm text-muted-foreground"
          >
            <FileGenericIcon className="size-3.5 flex-none text-placeholder" />
            <span className="min-w-0 truncate">{name}</span>
          </li>
        ))}
      </>
    );
  }

  return <ul className="m-0 mt-2 list-none p-0">{renderLevel(tree, 0)}</ul>;
}

function DetailBody({ wiki }: { wiki: GalleryWiki }) {
  const { actions } = useAppActions();
  const [shot, setShot] = useState(0);
  const [copied, setCopied] = useState(false);
  // Which sides of the thumbnail scroller still have content — drives
  // the arrows, updated from real scroll geometry, never counted.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [stripCanScroll, setStripCanScroll] = useState({ left: false, right: false });
  const updateStripArrows = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    setStripCanScroll({
      left: strip.scrollLeft > 4,
      right: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 4,
    });
  }, []);
  // One thumb plus its gap, smooth: the native scroller supplies the
  // easing and momentum; the arrow only picks the destination.
  function nudgeStrip(direction: 1 | -1) {
    const strip = stripRef.current;
    if (!strip) return;
    const gap = 8;
    const step = Math.round((strip.clientWidth - 2 * gap) / 3) + gap;
    strip.scrollBy({ left: direction * step, behavior: 'smooth' });
  }
  const { downloading, downloadAndOpen } = useDownloadWiki(
    (message) => actions.toast(message, { level: 'error' }),
  );

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const screenshots = wiki.screenshots ?? [];

  useEffect(() => {
    updateStripArrows();
  }, [screenshots.length, updateStripArrows]);

  return (
    <DialogContent className="max-h-overlay-stage w-overlay-3xl overflow-y-auto rounded-xl border border-border bg-background p-8 text-foreground">
      {/* Full-width header, the gallery page's own headline idiom: name
        * over one grey sub-line, with room for the floating close.
        * Bottom-aligned: the button's foot shares the sub-line's edge;
        * its right edge sits on the gallery column's line. */}
      <div className="flex items-end justify-between gap-6">
        <div className="min-w-0">
          <DialogTitle className="m-0 text-2xl font-semibold tracking-tight text-foreground">
            {wiki.name}
          </DialogTitle>
          <DialogDescription className="m-0 mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {wiki.description}
          </DialogDescription>
        </div>
        {/* "Make a copy": item-agnostic and mechanism-honest in the
          * Google Docs tradition. No ellipsis: nothing further to
          * answer — the copy lands in the folder home and opens
          * itself. */}
        <Button
          size="lg"
          disabled={downloading}
          className="flex-none"
          onClick={() => { void downloadAndOpen(wiki); }}
        >
          {downloading ? 'Copying…' : 'Make a copy'}
        </Button>
      </div>
      {/* Fixed-width text column, images take the rest: the tree can
        * truncate but never widen the page, and the gallery's left edge
        * stays put across entries. */}
      <div className="mt-6 grid grid-cols-[300px_minmax(0,1fr)] gap-10">
        {/* The text column OPTS OUT of driving the row's height (its
          * content lives in an absolute inset box): the image column
          * alone sets the page's height, and a long file tree scrolls
          * inside the column instead of stretching the dialog. */}
        <div className="relative min-w-0">
          <div className="absolute inset-0 flex flex-col">
          {/* The column's two occupants as switchable tabs, each with
            * the full height to itself. What's inside leads — it
            * answers the browsing question; the prompt is the
            * act-phase artifact. */}
          <Tabs defaultValue="files" className="min-h-0 flex-1">
            {/* "How it's built" is phrase-parallel with "What's inside"
              * and teaches what a prompt IS by role: the tab opens on
              * the very request that produced the wiki on display.
              * Both tabs stand REGARDLESS of what the entry has
              * published: an unpublished field empties its slot, it
              * never reshapes the page. */}
            <TabsList>
              <TabsTrigger value="files">What's inside</TabsTrigger>
              <TabsTrigger value="prompt">How it's built</TabsTrigger>
            </TabsList>
            <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto">
              {wiki.files ? (
                <FileTree paths={wiki.files} />
              ) : (
                /* The index's inventory line stands in until the entry
                 * publishes its real file list. */
                <p className="m-0 mt-3 text-sm leading-relaxed text-muted-foreground">
                  {wiki.contents}
                </p>
              )}
            </TabsContent>
            <TabsContent value="prompt" className="flex min-h-0 flex-1 flex-col">
              {/* The box owns the column's full height — a steady
                * frame whose text sits at the top, not a floating
                * snippet. */}
              <div
                className={cn(
                  'mt-3 min-h-0 flex-1 rounded-md border border-border bg-muted/40 p-3 text-sm leading-relaxed',
                  wiki.wikiPrompt ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {wiki.wikiPrompt ?? "The build prompt for this Wiki isn't published yet."}
              </div>
              {/* Pinned to the column's foot, level with the
                * thumbnail strip across the gutter. */}
              <div className="pt-4">
                <Button
                  variant="outline"
                  disabled={!wiki.wikiPrompt}
                  onClick={() => {
                    void navigator.clipboard.writeText(wiki.wikiPrompt ?? '').then(() => setCopied(true));
                  }}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? 'Copied' : 'Copy prompt'}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
          </div>
        </div>

        {/* The screenshot carousel, the Notion product-page shape: one
          * big hero in a FIXED landscape frame, a strip of exactly
          * three thumbnail slots below, and round side arrows sliding
          * the strip when more than three exist. ONE geometry across
          * every state — fixed 16:10 frames, and the strip keeps its
          * row even for one image or none: unpublished content empties
          * slots, it never reshapes the page. */}
        <div className="min-w-0">
          {screenshots.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-low">
              <img
                src={screenshots[shot]}
                alt={`${wiki.name} screenshot ${shot + 1}`}
                className="block aspect-[16/10] w-full object-cover object-top"
              />
            </div>
          ) : (
            /* Also the offline state when assets cannot be fetched. */
            <div className="flex aspect-[16/10] items-center justify-center rounded-lg border border-dashed border-border bg-card">
              <p className="m-0 max-w-xs text-center text-sm text-muted-foreground">
                Screenshots for this Wiki aren't published yet.
              </p>
            </div>
          )}
          {/* The strip is a NATIVE horizontal scroller — trackpad
            * momentum and rubber-banding for free, snap alignment per
            * thumbnail, quiet scrollbar. Three thumbs fill the view
            * (basis = a third minus the two gaps); the round arrows
            * smooth-scroll one thumb and appear only when that side
            * has more. */}
          <div className="relative mt-3">
            <div
              ref={stripRef}
              onScroll={updateStripArrows}
              className="scrollbar-none flex snap-x gap-2 overflow-x-auto"
            >
              {screenshots.length === 0 && <div aria-hidden className="aspect-[16/10] w-[calc((100%-1rem)/3)] flex-none" />}
              {screenshots.map((url, index) => (
                <button
                  key={url}
                  type="button"
                  aria-label={`Screenshot ${index + 1}`}
                  aria-current={index === shot || undefined}
                  onClick={() => setShot(index)}
                  className={cn(
                    'w-[calc((100%-1rem)/3)] flex-none snap-start',
                    'block cursor-pointer overflow-hidden rounded-md border bg-card p-0 outline-none transition-tint focus-visible:ring-3 focus-visible:ring-ring/50',
                    /* Selected = ink, not accent: cyan stays reserved for
                     * key actions/focus/progress, and these thumbs repeat. */
                    index === shot ? 'border-foreground' : 'border-border hover:border-muted-foreground/40',
                  )}
                >
                  <img src={url} alt="" className="block aspect-[16/10] w-full object-cover object-top" />
                </button>
              ))}
            </div>
            {stripCanScroll.left && (
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous screenshots"
                onClick={() => nudgeStrip(-1)}
                className="absolute top-1/2 -left-3.5 -translate-y-1/2 rounded-full shadow-low"
              >
                <ChevronDownIcon className="rotate-90" />
              </Button>
            )}
            {stripCanScroll.right && (
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="More screenshots"
                onClick={() => nudgeStrip(1)}
                className="absolute top-1/2 -right-3.5 -translate-y-1/2 rounded-full shadow-low"
              >
                <ChevronDownIcon className="-rotate-90" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </DialogContent>
  );
}

export function GalleryDetailOverlay({ wiki, onClose }: {
  wiki: GalleryWiki | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={wiki !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {wiki && <DetailBody wiki={wiki} />}
    </Dialog>
  );
}

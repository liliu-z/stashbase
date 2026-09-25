/**
 * Bound context outside the text. A visual source (an image or a PDF) is a
 * square tile like the composer's own thumbnails; a non-visual source sent
 * without a mention is a compact chip with its type glyph and name, and a
 * selected passage is the same chip with a quote glyph and its first words.
 * All share one box surface and one spring. State reads as a dot and a
 * word, and only a missing or failed source turns red.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { TextQuote, X } from 'lucide-react';

import { FileThumbnail } from '@/components/ui/file-thumbnail';
import { FileTypeIcon } from '@/components/ui/file-type-icon';
import { Tooltip } from '@/components/ui/tooltip';
import {
  contextItemKey,
  contextItemName,
  type AgentContextItem,
  type ContextStatus,
  type ContextValidation,
} from '@/features/agent/domain/context';
import { focusRing } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { spring } from '@/lib/springs';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';

import { STATUS_WORD } from './mention-widgets';

type SourceItem = Extract<AgentContextItem, { kind: 'source' }>;
type PassageItem = Extract<AgentContextItem, { kind: 'passage' }>;
type TransientItem = Extract<AgentContextItem, { kind: 'transient' }>;

const PASSAGE_EXCERPT_WORDS = 6;

/** The passage's opening words, enough to tell two passages of one file apart. */
function passageExcerpt(quote: string): string {
  const words = quote.split(/\s+/u).filter(Boolean);
  const head = words.slice(0, PASSAGE_EXCERPT_WORDS).join(' ');
  return words.length > PASSAGE_EXCERPT_WORDS ? `${head}…` : head;
}

/** Only a source with something to look at earns a square tile. */
export function isVisualSource(item: SourceItem): boolean {
  return item.format === 'image' || item.format === 'pdf';
}

/** The square every tile shares with `FileThumbnail`. */
function TileBox({
  children,
  className,
  size,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  size: number;
  title?: string;
}) {
  const shape = useShape();
  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden border border-border bg-accent',
        shape.bg,
        className,
      )}
      style={{ height: size, width: size }}
      title={title}
    >
      {children}
    </div>
  );
}

/** State as form under the name: a dot and a word, never a colored tile. */
function StatusLine({ status }: { status: Exclude<ContextStatus, 'ready'> }) {
  const alarming = status === 'stale' || status === 'failed';
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center gap-1 text-[10px] leading-tight font-medium',
        alarming ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      {STATUS_WORD[status]}
    </span>
  );
}

/** The hover-revealed remove badge, the composer's own recipe: a fixed dark
 *  circle with a white X so it reads over any tile content. */
function RemoveBadge({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <Tooltip content="Remove" side="top">
      <button
        aria-label={`Remove ${name}`}
        className={cn(
          'absolute top-1 right-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-neutral-900 text-white opacity-0 transition-opacity duration-fast outline-none group-hover/tile:opacity-100 focus-visible:opacity-100',
          focusRing(),
        )}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        type="button"
      >
        <X size={12} strokeWidth={2.5} />
      </button>
    </Tooltip>
  );
}

/** The retry a failed source offers. The frame differs between a tile and a
 *  chip; the label, the action, and keeping the click off the surface behind
 *  it do not. */
function ReprocessButton({
  className,
  onReprocess,
  source,
}: {
  className: string;
  onReprocess: (source: SourceReference) => void;
  source: SourceReference;
}) {
  return (
    <button
      className={cn(className, focusRing())}
      onClick={(event) => {
        event.stopPropagation();
        onReprocess(source);
      }}
      type="button"
    >
      Reprocess
    </button>
  );
}

function SourceTile({
  item,
  onReprocess,
  reason,
  size,
  status = 'ready',
}: {
  item: SourceItem;
  onReprocess?: ((source: SourceReference) => void) | undefined;
  reason?: string | null;
  size: number;
  status?: ContextStatus;
}) {
  const shape = useShape();
  const name = contextItemName(item);
  const reprocessable = status === 'failed' && onReprocess !== undefined;
  return (
    <TileBox className="flex flex-col" size={size} title={reason ?? item.source.path}>
      <div
        aria-label={name}
        className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
        role="img"
      >
        <FileTypeIcon aria-hidden="true" path={item.source.path} size={Math.max(16, size * 0.3)} />
      </div>
      <div className="flex flex-col items-center gap-px px-1.5 pb-1.5">
        <div
          className={cn(
            'line-clamp-2 max-w-full text-center leading-tight font-medium break-words text-foreground',
            size >= 72 ? 'text-[11px]' : 'text-[10px]',
          )}
        >
          {name}
        </div>
        {status !== 'ready' && <StatusLine status={status} />}
      </div>
      {reprocessable && (
        <ReprocessButton
          className={cn(
            'absolute inset-x-1 bottom-1 cursor-pointer bg-neutral-900 py-0.5 text-[10px] font-medium text-white opacity-0 transition-opacity duration-fast outline-none group-hover/tile:opacity-100 focus-visible:opacity-100',
            shape.chip,
          )}
          onReprocess={onReprocess}
          source={item.source}
        />
      )}
    </TileBox>
  );
}

/** A non-visual source: the glyph and name in one line, state beside them.
 *  Same surface and radius as a tile, at the composer's control height. */
function SourceChip({
  item,
  onReprocess,
  reason,
  status = 'ready',
}: {
  item: SourceItem;
  onReprocess?: ((source: SourceReference) => void) | undefined;
  reason?: string | null;
  status?: ContextStatus;
}) {
  const shape = useShape();
  const name = contextItemName(item);
  return (
    <div
      className={cn(
        'inline-flex h-7 max-w-64 items-center gap-1.5 border border-border bg-accent pr-2.5 pl-2 text-[12px] font-medium text-foreground',
        shape.bg,
      )}
      title={reason ?? item.source.path}
    >
      <FileTypeIcon
        aria-hidden="true"
        className="shrink-0 text-muted-foreground"
        path={item.source.path}
        size={14}
      />
      <span className="min-w-0 truncate">{name}</span>
      {status !== 'ready' && <StatusLine status={status} />}
      {status === 'failed' && onReprocess && (
        <ReprocessButton
          className={cn(
            '-mr-1 shrink-0 cursor-pointer px-1 text-[11px] font-medium text-foreground transition-colors duration-fast outline-none hover:bg-hover',
            shape.chip,
          )}
          onReprocess={onReprocess}
          source={item.source}
        />
      )}
    </div>
  );
}

/** A selected passage: the source chip's frame with a quote glyph, the file
 *  name, and the passage's first words; the whole quote is its tooltip. */
function PassageChip({
  item,
  reason,
  status = 'ready',
}: {
  item: PassageItem;
  reason?: string | null;
  status?: ContextStatus;
}) {
  const shape = useShape();
  return (
    <div
      className={cn(
        'inline-flex h-7 max-w-72 items-center gap-1.5 border border-border bg-accent pr-2.5 pl-2 text-[12px]',
        shape.bg,
      )}
      title={reason ?? `${item.source.path}\n\n${item.quote}`}
    >
      <TextQuote aria-hidden="true" className="shrink-0 text-muted-foreground" size={14} />
      <span className="max-w-32 shrink-0 truncate font-medium text-foreground">
        {contextItemName(item)}
      </span>
      <span className="min-w-0 truncate text-muted-foreground">{passageExcerpt(item.quote)}</span>
      {status !== 'ready' && <StatusLine status={status} />}
    </div>
  );
}

/** A sent upload whose File is gone, which is every replayed history record:
 *  the same box over a server preview or a type glyph. */
function RemoteTile({ item, size }: { item: TransientItem; size: number }) {
  return (
    <TileBox size={size} title={item.name}>
      {item.previewUrl ? (
        <img
          alt={item.name}
          className="absolute inset-0 h-full w-full object-cover"
          src={item.previewUrl}
        />
      ) : (
        <div
          aria-label={item.name}
          className="absolute inset-0 flex items-center justify-center text-muted-foreground"
          role="img"
        >
          <FileTypeIcon aria-hidden="true" path={item.path} size={Math.max(16, size * 0.35)} />
        </div>
      )}
    </TileBox>
  );
}

/** The draft's tiles and passage chips, rendered inside the composer's preview row
 *  ahead of its file thumbnails with the thumbnails' own enter and exit. */
export function DraftSourceTiles({
  onRemove,
  onReprocess,
  size,
  validations,
}: {
  onRemove: (item: AgentContextItem) => void;
  onReprocess?: ((source: SourceReference) => void) | undefined;
  size: number;
  validations: ContextValidation[];
}) {
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {validations.map((validation) => {
        const { item } = validation;
        return (
          <motion.div
            animate={{ opacity: 1, scale: 1 }}
            className="group/tile relative shrink-0 cursor-default"
            exit={{ opacity: 0, scale: 0.9, transition: spring.fast.exit }}
            initial={{ opacity: 0, scale: 0.9 }}
            key={validation.key}
            layout
            role="listitem"
            transition={spring.fast}
          >
            {item.kind === 'source' ? (
              <SourceTile
                item={item}
                onReprocess={onReprocess}
                reason={validation.reason}
                size={size}
                status={validation.status}
              />
            ) : item.kind === 'passage' ? (
              <PassageChip item={item} reason={validation.reason} status={validation.status} />
            ) : (
              <div
                className="flex flex-col items-center gap-1"
                title={validation.reason ?? undefined}
              >
                <RemoteTile item={item} size={size} />
                <span className="text-caption text-destructive">Unavailable</span>
              </div>
            )}
            <RemoveBadge name={contextItemName(item)} onRemove={() => onRemove(item)} />
          </motion.div>
        );
      })}
    </AnimatePresence>
  );
}

/** Context as it was sent: sources and uploads in one row above the bubble,
 *  the way the chat message shows its own files. */
export function SentContextTiles({
  align = 'end',
  fileFor,
  items,
  size = 64,
}: {
  align?: 'start' | 'end';
  fileFor?: ((path: string) => File | undefined) | undefined;
  items: readonly AgentContextItem[];
  size?: number;
}) {
  if (items.length === 0) return null;
  return (
    <div
      aria-label="Sent attachments"
      className={cn(
        'flex flex-wrap items-center gap-1.5',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
      role="group"
    >
      {items.map((item) => {
        if (item.kind === 'source') {
          return isVisualSource(item) ? (
            <SourceTile item={item} key={contextItemKey(item)} size={size} />
          ) : (
            <SourceChip item={item} key={contextItemKey(item)} />
          );
        }
        if (item.kind === 'passage') return <PassageChip item={item} key={contextItemKey(item)} />;
        const file = fileFor?.(item.path);
        return file ? (
          <FileThumbnail file={file} key={item.path} size={size} />
        ) : (
          <RemoteTile item={item} key={item.path} size={size} />
        );
      })}
    </div>
  );
}

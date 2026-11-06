/**
 * Bound context outside the text. A visual source (an image or a PDF) is a
 * square tile like the composer's own thumbnails; any other source bound
 * without a mention, and a file the reader opened here, is a compact chip
 * with its type glyph and name, and a selected passage is the same chip with
 * a quote glyph and its first words. The draft and the sent turn make that
 * choice with one predicate, so a file looks the same before and after it is
 * sent. Tiles and chips are paper, a hairline with no fill, and share one
 * spring. State reads as a dot and a word, and only a missing or failed
 * source turns red.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';

import { FileGlyphFace, FileThumbnail } from '@/components/ui/file-thumbnail';
import { FileTypeIcon } from '@/components/ui/file-type-icon';
import {
  contextItemKey,
  contextItemName,
  type AgentContextItem,
  type ContextStatus,
  type ContextValidation,
} from '@/features/agent/domain/context';
import { showsAsDocumentChip } from '@/features/agent/domain/draft-context';
import { focusRing } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { spring } from '@/lib/springs';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';

import { CHIP_FRAME, ChipRemove } from './chip';
import { PassageChip } from './passage-chip';
import { RemoveBadge, StatusLine, TileBox } from './tile-parts';

type SourceItem = Extract<AgentContextItem, { kind: 'source' }>;
type TransientItem = Extract<AgentContextItem, { kind: 'transient' }>;
type OpenSource = (
  source: SourceReference,
  phrase: string | null,
  quoteFormat?: 'markdown',
) => void;

/** What a source or passage is told: the item, why it is unavailable, and
 *  its state. */
interface ItemProps<Item> {
  item: Item;
  reason?: string | null;
  status?: ContextStatus;
}

type SourceProps = ItemProps<SourceItem> & {
  onReprocess?: ((source: SourceReference) => void) | undefined;
};

/** Only a source with something to look at earns a square tile. */
export function isVisualSource(item: SourceItem): boolean {
  return item.format === 'image' || item.format === 'pdf';
}

/** Whether a bound source is drawn as a square tile rather than a chip. The
 *  draft and the sent turn both ask this one question, so a file keeps its
 *  look across the send: a visual source is a tile, unless the reader opened
 *  it here, by a drop or as an external file, when it keeps the chip it was
 *  offered as. */
function showsAsSquareTile(item: SourceItem): boolean {
  return isVisualSource(item) && !showsAsDocumentChip(item);
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
}: SourceProps & { size: number }) {
  const shape = useShape();
  const name = contextItemName(item);
  const reprocessable = status === 'failed' && onReprocess !== undefined;
  return (
    <TileBox size={size} title={reason ?? item.source.path}>
      <FileGlyphFace name={name} path={item.source.path} size={size}>
        {status !== 'ready' && <StatusLine status={status} />}
      </FileGlyphFace>
      {reprocessable && (
        <ReprocessButton
          className={cn(
            'absolute inset-x-1 bottom-1 cursor-pointer bg-neutral-900 py-0.5 text-ui-10 font-medium text-white opacity-0 transition-opacity duration-fast outline-none group-hover/tile:opacity-100 focus-visible:opacity-100',
            shape.chip,
          )}
          onReprocess={onReprocess}
          source={item.source}
        />
      )}
    </TileBox>
  );
}

/** A source known by its name rather than its look: the glyph and name in one
 *  line, state beside them. In a draft it carries its own remove. */
function SourceChip({
  item,
  onRemove,
  onReprocess,
  reason,
  status = 'ready',
}: SourceProps & { onRemove?: (() => void) | undefined }) {
  const shape = useShape();
  const name = contextItemName(item);
  return (
    <div
      className={cn(
        CHIP_FRAME,
        'max-w-64 gap-1.5 pl-2 text-foreground',
        onRemove ? 'pr-0' : 'pr-2.5',
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
            '-mr-1 shrink-0 cursor-pointer px-1 text-ui-11 font-medium text-foreground transition-colors duration-fast outline-none hover:bg-hover',
            shape.chip,
          )}
          onReprocess={onReprocess}
          source={item.source}
        />
      )}
      <ChipRemove name={name} onRemove={onRemove} />
    </div>
  );
}

/** A sent upload whose File is gone, which is every replayed history record:
 *  the same box over a server preview or a type glyph. */
function RemoteTile({ item, size }: { item: TransientItem; size: number }) {
  const [failedPreview, setFailedPreview] = useState<string>();
  const previewFailed = Boolean(item.previewUrl && item.previewUrl === failedPreview);
  return (
    <TileBox size={size} title={item.name}>
      {item.previewUrl && !previewFailed ? (
        <img
          alt={item.name}
          className="absolute inset-0 h-full w-full object-cover"
          src={item.previewUrl}
          onError={() => setFailedPreview(item.previewUrl)}
        />
      ) : (
        <FileGlyphFace name={item.name} path={item.path} size={size}>
          {previewFailed && (
            <span className="text-center text-ui-10 text-muted-foreground">
              Preview unavailable
            </span>
          )}
        </FileGlyphFace>
      )}
    </TileBox>
  );
}

/** The draft's tiles and passage chips, rendered inside the composer's preview row
 *  ahead of its file thumbnails with the thumbnails' own enter and exit. */
export function DraftSourceTiles({
  onOpenSource,
  onRemove,
  onReprocess,
  size,
  validations,
}: {
  onOpenSource?: OpenSource | undefined;
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
            {item.kind === 'source' && !showsAsSquareTile(item) ? (
              <SourceChip
                item={item}
                onRemove={() => onRemove(item)}
                onReprocess={onReprocess}
                reason={validation.reason}
                status={validation.status}
              />
            ) : item.kind === 'source' ? (
              <SourceTile
                item={item}
                onReprocess={onReprocess}
                reason={validation.reason}
                size={size}
                status={validation.status}
              />
            ) : item.kind === 'passage' ? (
              <PassageChip
                item={item}
                onOpenSource={onOpenSource}
                onRemove={() => onRemove(item)}
                reason={validation.reason}
                status={
                  validation.status !== 'ready' ? <StatusLine status={validation.status} /> : null
                }
              />
            ) : (
              <div
                className="flex flex-col items-center gap-1"
                title={validation.reason ?? undefined}
              >
                <RemoteTile item={item} size={size} />
                <span className="text-caption text-destructive">Unavailable</span>
              </div>
            )}
            {/* A chip carries its own remove; only a tile needs the badge. */}
            {(item.kind === 'transient' || (item.kind === 'source' && showsAsSquareTile(item))) && (
              <RemoveBadge name={contextItemName(item)} onRemove={() => onRemove(item)} />
            )}
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
  onOpenSource,
  fileFor,
  items,
  size = 64,
}: {
  align?: 'start' | 'end';
  onOpenSource?: OpenSource | undefined;
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
          return showsAsSquareTile(item) ? (
            <SourceTile item={item} key={contextItemKey(item)} size={size} />
          ) : (
            <SourceChip item={item} key={contextItemKey(item)} />
          );
        }
        if (item.kind === 'passage')
          return <PassageChip item={item} key={contextItemKey(item)} onOpenSource={onOpenSource} />;
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

/** Renders a preview tile for one `File`: an image is drawn directly, a PDF
 *  has its first page rasterised through pdf.js, and anything else falls back
 *  to the shared file-type glyph. The pdf.js worker URL is imported so the bundler owns
 *  it; object URLs created for previews are revoked when the tile unmounts. */

'use client';

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useState, type ReactNode } from 'react';

import { FileTypeIcon } from '@/components/ui/file-type-icon';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';

// ─── Lazy pdfjs loader ────────────────────────────────────────────────────
// Imports pdfjs-dist on first PDF, caches the module, and points the worker
// at the bundled build. Electron's renderer trust boundary forbids remote
// scripts, so the registry component's CDN URL is adapted to Vite's URL asset.
type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((mod) => {
      if (!mod.GlobalWorkerOptions.workerSrc) {
        mod.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      }
      return mod;
    });
  }
  return pdfjsPromise;
}

async function renderPdfFirstPage(file: File, targetWidth: number): Promise<string> {
  const pdfjs = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = (targetWidth * 2) / baseViewport.width; // 2× for retina
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvas, viewport }).promise;
  return canvas.toDataURL('image/png');
}

// ─── Glyph face ───────────────────────────────────────────────────────────
// A file with nothing to look at: its type glyph over its name. A project
// source, a live upload and a replayed one all wear this face, so a file reads
// the same before and after it is sent. `children` adds lines under the name.
interface FileGlyphFaceProps {
  children?: ReactNode;
  name: string;
  /** The path or file name the glyph is chosen from. */
  path: string;
  size: number;
}

function FileGlyphFace({ children, name, path, size }: FileGlyphFaceProps) {
  return (
    <div className="absolute inset-0 flex flex-col">
      <div
        aria-label={name}
        className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
        role="img"
      >
        <FileTypeIcon aria-hidden="true" path={path} size={Math.max(16, size * 0.3)} />
      </div>
      <div className="flex flex-col items-center gap-px px-1.5 pb-1.5">
        <div
          className={cn(
            'line-clamp-2 max-w-full text-center leading-tight font-medium break-words text-foreground',
            size >= 72 ? 'text-ui-11' : 'text-ui-10',
          )}
        >
          {name}
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── File thumbnail ───────────────────────────────────────────────────────
// Read-only square preview of a File. Images use object-cover via
// `URL.createObjectURL`; PDFs render the first page via pdfjs; while either is
// resolving a spinner is shown. Self-contained (frame + sizing) so it can be
// reused both inside the composer's preview row and to render already-sent
// attachments in a chat transcript. The frame is paper, a light hairline with
// no fill of its own, so a tile reads as the surface it sits on.
interface FileThumbnailProps {
  file: File;
  /** Side length of the square thumbnail in pixels. */
  size: number;
  className?: string;
}

function FileThumbnail({ file, size, className }: FileThumbnailProps) {
  const shape = useShape();
  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf';

  // Create blob URL inside an effect (NOT useMemo) so the cleanup-revoke
  // and the URL-creation stay in sync. In React 18 StrictMode dev, a
  // useMemo-created URL gets revoked by the simulated effect-cleanup but
  // useMemo doesn't re-run on the simulated re-mount (no re-render happens),
  // leaving the DOM with a stale, revoked `blob:` URL — broken image.
  // Putting both in the same effect means the simulated re-mount creates a
  // fresh URL and updates state. The one-frame "before URL" state shows the
  // pending spinner rather than a fallback icon, so the transition is
  // visually clean.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) {
      // Clear stale state if the `file` prop swaps type on the same mount —
      // otherwise a revoked blob URL would keep winning over the new preview.
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [isImage, file]);

  // PDFs need async rendering — loading flash is unavoidable for the first
  // ~100–300ms while pdfjs loads. Falls back to the generic icon on error
  // (corrupt/password-protected file, bundled worker unavailable).
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState(false);
  useEffect(() => {
    setPdfError(false);
    if (!isPdf) {
      setPdfUrl(null);
      return;
    }
    let cancelled = false;
    renderPdfFirstPage(file, size)
      .then((url) => {
        if (!cancelled) setPdfUrl(url);
      })
      .catch(() => {
        if (!cancelled) setPdfError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file, isPdf, size]);

  const previewUrl = imageUrl ?? pdfUrl;
  // Spinner only while a preview is genuinely pending; anything that can't
  // produce one (failed PDF, unsupported type) gets the generic icon instead.
  const isPending = (isImage && !imageUrl) || (isPdf && !pdfUrl && !pdfError);

  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden border border-border/50',
        shape.bg,
        className,
      )}
      style={{ width: size, height: size }}
      title={file.name}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : isPending ? (
        // Circular spinner while we wait for the preview to be ready.
        // Used for both images (brief URL-creation gap) and PDFs (longer
        // pdfjs render). The thin ring is mostly subtle (border-border)
        // with one quadrant accented (border-t-muted-foreground) so the
        // `animate-spin` rotation reads as a moving arc.
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-muted-foreground"
            aria-label="Loading preview"
            role="status"
          />
        </div>
      ) : (
        // A file with no renderable preview shows its glyph and name: the
        // face a sent upload falls back to once its File is gone, so the tile
        // looks the same before and after the turn is replayed.
        <FileGlyphFace name={file.name} path={file.name} size={size} />
      )}
    </div>
  );
}

export { FileGlyphFace, FileThumbnail };

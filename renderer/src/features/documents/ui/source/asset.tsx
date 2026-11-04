import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useRef, type ReactNode } from 'react';

import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import type { DocumentAsset, DocumentAssetPort } from '@/features/documents/application/ports';
import { documentAssetQuery } from '@/features/documents/application/queries';
import { useDocumentRefresh } from '@/features/documents/hooks/use-document-refresh';
import { usePreparedRead } from '@/features/documents/hooks/use-prepared-read';
import { RefreshFailedBanner } from '@/features/documents/ui/banner';
import type { SourceReference } from '@/shared/domain/source-reference';

import type { DocumentViewerStatus, PreparationSlotFormat, PreparedOnOpenFormat } from './viewer';

/** The loaded asset, plus the retry a viewer offers when the bytes are not
 *  the shape it can render. */
interface AssetSurfaceSlot {
  asset: DocumentAsset;
  retry(): void;
}

export interface AssetSurfaceProps {
  active: boolean;
  api: DocumentAssetPort;
  children(slot: AssetSurfaceSlot): ReactNode;
  name: string;
  onOpenPrepared?: ((source: SourceReference, format: PreparedOnOpenFormat) => void) | undefined;
  /** Opening this format is the explicit gesture that promotes preparation. */
  prepareOnOpen?: PreparedOnOpenFormat | undefined;
  /** Composes a preparation status row above the viewer. */
  preparationSlot?: PreparationSlotFormat | undefined;
  renderPreparation?:
    | ((source: SourceReference, format: PreparationSlotFormat) => ReactNode)
    | undefined;
  runtime: DocumentRuntime;
  status(status: DocumentViewerStatus): ReactNode;
}

/**
 * The frame every byte-backed viewer shares: resolve the versioned asset URL,
 * promote preparation once per open, and compose the preparation status row.
 */
export function AssetSurface({
  active,
  api,
  children,
  name,
  onOpenPrepared,
  prepareOnOpen,
  preparationSlot,
  renderPreparation,
  runtime,
  status,
}: AssetSurfaceProps) {
  const assetQuery = documentAssetQuery(api, runtime.scope);
  const prepared = usePreparedRead(assetQuery.queryKey);
  const asset = useQuery({ ...assetQuery, enabled: active, refetchOnMount: !prepared });
  useDocumentRefresh(active, asset.refetch, prepared);
  const source = runtime.scope.source;

  // Fire once per mounted document, independent of the asset load.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current || prepareOnOpen === undefined) return;
    openedRef.current = true;
    onOpenPrepared?.(source, prepareOnOpen);
  }, [onOpenPrepared, prepareOnOpen, source]);

  const retry = () => void asset.refetch();
  if (asset.isPending) return <>{status({ name })}</>;
  if (!asset.data) {
    return <>{status({ error: asset.error ?? new Error(name), name, retry })}</>;
  }

  // The preparation row sits outside the boundary so it is readable while the
  // viewer's own chunk is still arriving.
  return (
    <>
      {asset.isError && <RefreshFailedBanner onRetry={retry} />}
      {preparationSlot === undefined ? null : renderPreparation?.(source, preparationSlot)}
      <Suspense fallback={status({ name })}>{children({ asset: asset.data, retry })}</Suspense>
    </>
  );
}

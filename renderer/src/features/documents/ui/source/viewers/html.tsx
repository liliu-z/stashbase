import { lazy } from 'react';
import { useStore } from 'zustand';

import type { HtmlDataSession } from '@/features/documents/application/html-data-session';
import type { DocumentAsset } from '@/features/documents/application/ports';
import { useDocumentRefresh } from '@/features/documents/hooks/use-document-refresh';
import { RefreshFailedBanner } from '@/features/documents/ui/banner';
import { AssetSurface } from '@/features/documents/ui/source/asset';
import type { DocumentViewerProps } from '@/features/documents/ui/source/viewer';

const HtmlDocument = lazy(async () => {
  const module = await import('@/features/documents/ui/html/document');
  return { default: module.HtmlDocument };
});

export default function HtmlViewer({
  active,
  assetApi,
  name,
  navigation,
  onNavigate,
  onOpenExternal,
  runtime,
  status,
}: DocumentViewerProps<'assetApi' | 'navigation' | 'onNavigate' | 'onOpenExternal'>) {
  return (
    <AssetSurface active={active} api={assetApi} name={name} runtime={runtime} status={status}>
      {({ asset }) => (
        <FormPreview active={active} asset={asset} data={runtime.htmlData}>
          {(resource, revision) => (
            <HtmlDocument
              active={active}
              name={name}
              navigation={navigation}
              onNavigate={onNavigate}
              onOpenExternal={onOpenExternal}
              resource={resource}
              revision={revision}
              data={runtime.htmlData}
              source={runtime.scope.source}
              tabId={runtime.scope.id}
            />
          )}
        </FormPreview>
      )}
    </AssetSurface>
  );
}

function FormPreview({
  active,
  asset,
  data,
  children,
}: {
  active: boolean;
  asset: DocumentAsset;
  data: HtmlDataSession | undefined;
  children(resource: DocumentAsset, revision: number): React.ReactNode;
}) {
  return data ? (
    <BoundPreview active={active} asset={asset} data={data}>
      {children}
    </BoundPreview>
  ) : (
    children(asset, 0)
  );
}

function BoundPreview({
  active,
  asset,
  data,
  children,
}: {
  active: boolean;
  asset: DocumentAsset;
  data: HtmlDataSession;
  children(resource: DocumentAsset, revision: number): React.ReactNode;
}) {
  const document = useStore(data.store, (state) => state.document);
  const revision = useStore(data.store, (state) => state.revision);
  const refreshFailed = useStore(data.store, (state) => state.refreshFailed);
  useDocumentRefresh(active && document !== null, data.refresh);
  // A new page loads the shared draft again, so HTML and data changes both
  // load a replacement page.
  return (
    <>
      {refreshFailed && <RefreshFailedBanner onRetry={() => void data.refresh()} />}
      {children(asset, revision)}
    </>
  );
}

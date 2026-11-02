/** Compose retained document sessions, navigation feedback, and the active viewer. */
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { DocumentUsageEvent } from '@/features/documents/application/document-runtime-contract';
import { SEARCH_NOTICES } from '@/features/documents/application/navigation-runtime';
import type {
  DelimitedTablePort,
  DocumentAssetPort,
  DocumentSourcePort,
  DocxPreviewPort,
  GenericFilePreviewPort,
  SubscribeDocumentInput,
} from '@/features/documents/application/ports';
import type { DocumentTabsRuntime } from '@/features/documents/application/tabs-runtime';
import { sourceName } from '@/features/documents/domain/document';
import {
  documentTextFormat,
  documentViewerFormat,
} from '@/features/documents/domain/document-format';
import { retainDocumentTabIds } from '@/features/documents/domain/retained-tabs';
import type { DocumentSelection } from '@/features/documents/domain/selection';
import { useDocumentTabs } from '@/features/documents/hooks/use-document-tabs';
import { DocumentSource } from '@/features/documents/ui/source/document';
import { documentViewerEntry } from '@/features/documents/ui/source/registry';
import type {
  DocumentNavigationTarget,
  DocumentViewerRegistry,
  PreparationSlotFormat,
  PreparedOnOpenFormat,
} from '@/features/documents/ui/source/viewer';
import type { SourceReference } from '@/shared/domain/source-reference';
import { FloatingNotice, FloatingNotices, NoticeStrip } from '@/shared/ui/notice';

import { DiscardDraftDialog } from './discard-draft-dialog';
import { DocumentFind } from './find';
import { DocumentReadingSurface } from './reading-surface';

const ignoreNavigation = () => undefined;
const rejectExternalNavigation = async () => false;

export interface DocumentWorkspaceProps {
  /** False while Chat mode or the New tab page covers the retained documents. */
  active?: boolean;
  recordUsage?: ((event: DocumentUsageEvent) => void) | undefined;
  onInputActivity?: SubscribeDocumentInput | undefined;
  assetApi: DocumentAssetPort;
  docxPreviewApi: DocxPreviewPort;
  genericPreviewApi: GenericFilePreviewPort;
  /** Binds a selected Markdown passage to the Agent beside the document. */
  onAskAgent?: ((selection: DocumentSelection) => void) | undefined;
  referencedPassages?: readonly DocumentSelection[] | undefined;
  onNavigate?: ((target: DocumentNavigationTarget) => void) | undefined;
  onOpenExternal?: ((href: string) => Promise<boolean>) | undefined;
  /** Fired once when a DOCX or media document mounts so preparation can be
   *  queued at interactive priority. Fire-and-forget. */
  onOpenPrepared?: ((source: SourceReference, format: PreparedOnOpenFormat) => void) | undefined;
  onReveal(source: SourceReference, signal: AbortSignal): Promise<void>;
  /** Composes a preparation status row above PDF, image, and DOCX viewers. */
  renderPreparation?:
    | ((source: SourceReference, format: PreparationSlotFormat) => ReactNode)
    | undefined;
  renderReadingControl?: (() => ReactNode) | undefined;
  revealLabel: string;
  runtime: DocumentTabsRuntime;
  sourceApi: DocumentSourcePort;
  tableApi: DelimitedTablePort;
  /** Overridable so a test can register a viewer of its own. */
  viewers?: DocumentViewerRegistry | undefined;
}

export function DocumentWorkspace({
  active = true,
  assetApi,
  docxPreviewApi,
  genericPreviewApi,
  onAskAgent,
  referencedPassages,
  onNavigate = ignoreNavigation,
  onOpenExternal = rejectExternalNavigation,
  onOpenPrepared,
  onReveal,
  renderPreparation,
  renderReadingControl,
  revealLabel,
  recordUsage,
  onInputActivity,
  runtime,
  sourceApi,
  tableApi,
  viewers,
}: DocumentWorkspaceProps) {
  const searchNotice = useStore(runtime.navigation.store, (state) => state.searchNotice);
  const searchPurpose = useStore(runtime.navigation.store, (state) => state.searchPurpose);
  const openFailure = useStore(runtime.store, (state) => state.openFailure);
  const closeDecision = useStore(runtime.store, (state) => state.closeDecision);
  const { activeTab, activeTabId, tabs } = useDocumentTabs(runtime);
  const [retention, setRetention] = useState<{ ids: string[]; runtime: DocumentTabsRuntime }>(
    () => ({
      ids: [],
      runtime,
    }),
  );
  const retainedIds = retainDocumentTabIds(
    retention.runtime === runtime ? retention.ids : [],
    tabs,
    activeTabId,
  );
  useEffect(() => {
    setRetention((current) => {
      const ids = retainDocumentTabIds(
        current.runtime === runtime ? current.ids : [],
        tabs,
        activeTabId,
      );
      if (
        current.runtime === runtime &&
        current.ids.length === ids.length &&
        current.ids.every((id, index) => id === ids[index])
      ) {
        return current;
      }
      return { ids, runtime };
    });
  }, [activeTabId, runtime, tabs]);
  if (tabs.length === 0 && !openFailure) return null;
  const activeIsRetained = activeTab ? retainedIds.includes(activeTab.id) : false;
  // A format that never claims a find controller shows no find bar at all.
  const activeFindable = activeTab
    ? documentViewerEntry(documentViewerFormat(activeTab.source.path), viewers).find
    : false;

  const renderDocument = (tabId: string, hidden: boolean) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    const document = runtime.getDocument(tabId);
    if (!tab || !document) return null;
    return (
      <div
        aria-label={`${sourceName(tab.source)} document`}
        className={hidden ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
        hidden={hidden}
        key={tab.id}
        role="region"
      >
        <DocumentReadingSurface
          onInputActivity={onInputActivity}
          runtime={document}
          history={runtime.history}
          active={active && !hidden}
          onRead={() =>
            recordUsage?.({
              event: 'document_engaged',
              activity: 'read',
              format: documentViewerFormat(tab.source.path),
            })
          }
        >
          <DocumentSource
            active={active && !hidden}
            assetApi={assetApi}
            docxPreviewApi={docxPreviewApi}
            genericPreviewApi={genericPreviewApi}
            navigation={runtime.navigation}
            onAskAgent={onAskAgent}
            referencedPassages={referencedPassages}
            onNavigate={onNavigate}
            onOpenExternal={onOpenExternal}
            onOpenPrepared={onOpenPrepared}
            onReveal={onReveal}
            renderPreparation={renderPreparation}
            renderReadingControl={renderReadingControl}
            revealLabel={revealLabel}
            runtime={document}
            sourceApi={sourceApi}
            tableApi={tableApi}
            viewers={viewers}
          />
        </DocumentReadingSurface>
      </div>
    );
  };

  return (
    <section aria-label="Document workspace" className="relative flex h-full min-h-0 flex-col">
      <DiscardDraftDialog
        onCancel={runtime.dismissCloseDecision}
        onConfirm={() => void runtime.closeWithoutSaving()}
        source={closeDecision?.source ?? null}
      />
      {/* Nothing opened to carry it, so it floats over the pane. */}
      {openFailure && (
        <FloatingNotices>
          <FloatingNotice
            actions={[{ label: 'Retry', onAct: () => void runtime.retryOpen() }]}
            onDismiss={runtime.dismissOpenFailure}
            role="alert"
          >
            Could not open {openFailure.source.path}. {openFailure.message}
          </FloatingNotice>
        </FloatingNotices>
      )}
      {searchNotice && (
        <NoticeStrip onDismiss={runtime.navigation.dismissSearchNotice} role="status">
          {activeFindable ? searchNotice : SEARCH_NOTICES[searchPurpose].unavailable}
        </NoticeStrip>
      )}
      {retainedIds.map((tabId) => renderDocument(tabId, tabId !== activeTabId))}
      {activeTab &&
        documentTextFormat(activeTab.source.path) !== 'md' &&
        !activeIsRetained &&
        renderDocument(activeTab.id, false)}
      {activeFindable && <DocumentFind runtime={runtime.navigation} />}
    </section>
  );
}

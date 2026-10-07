import type {
  DocumentAssetPort,
  DocumentSourcePort,
  DocumentTurnChangesPort,
  DocumentWindowLifecyclePort,
  DocxPreviewPort,
  GenericFilePreviewPort,
} from '@/features/documents/application/ports';
import type { WindowLifecycleBridge } from '@/platform/electron/window-lifecycle';
import type { HttpClient } from '@/platform/http/client';

import { createDocumentAssetAdapter } from './asset-api';
import { createDocxPreviewAdapter } from './docx-preview-api';
import { createGenericFilePreviewAdapter } from './generic-preview-api';
import { createDocumentSourceAdapter } from './source-api';
import { createDocumentTurnChangesAdapter } from './turn-change-api';
import { createDocumentWindowLifecycleAdapter } from './window-lifecycle';

/** Every port the Documents feature needs a real implementation of, in one
 *  record so the app wires the feature rather than individual transports. */
export interface DocumentAdapters {
  asset: DocumentAssetPort;
  docxPreview: DocxPreviewPort;
  genericPreview: GenericFilePreviewPort;
  source: DocumentSourcePort;
  turnChanges: DocumentTurnChangesPort;
  windowLifecycle: DocumentWindowLifecyclePort;
}

export interface DocumentAdapterOptions {
  http: HttpClient;
  serverOrigin: string;
  windowLifecycle: WindowLifecycleBridge;
}

/**
 * The Documents feature, bound to this window's transports.
 *
 * Seven factories used to leave the feature one by one, so adding a viewer that
 * needed another changed the app's dependency shape and every fake with it.
 * The feature answers for its own wiring here instead; which transport each
 * port ends up on is not the app's business.
 */
export function createDocumentAdapters({
  http,
  serverOrigin,
  windowLifecycle,
}: DocumentAdapterOptions): DocumentAdapters {
  return {
    asset: createDocumentAssetAdapter(http, serverOrigin),
    docxPreview: createDocxPreviewAdapter(),
    genericPreview: createGenericFilePreviewAdapter(http),
    source: createDocumentSourceAdapter(http),
    turnChanges: createDocumentTurnChangesAdapter(http),
    windowLifecycle: createDocumentWindowLifecycleAdapter(windowLifecycle),
  };
}

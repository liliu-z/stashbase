/**
 * Everything the documents feature asks of the outside world, and every way
 * those asks are refused.
 *
 * A port is the call shape only: no transport, no wording, no retry. Each
 * capability names its own failure ladder beside its port, so a hook selects
 * recovery by `kind` and `failure-messages` owns the sentence. Adapters
 * implement these in `../infrastructure`; nothing here knows they exist.
 */
import type {
  DocumentTextSaveResult,
  DocumentTextSource,
} from '@/features/documents/domain/document';
import type { GenericFilePreview } from '@/features/documents/domain/generic-preview';
import {
  featureErrorClass,
  FeatureError,
  type FeatureFailureKind,
} from '@/shared/domain/feature-error';
import type { SourceReference } from '@/shared/domain/source-reference';

export interface DocumentSourcePort {
  load(source: SourceReference, signal: AbortSignal): Promise<DocumentTextSource>;
  overwrite(
    source: SourceReference,
    input: { content: string },
    signal: AbortSignal,
  ): Promise<DocumentTextSaveResult>;
  save(
    source: SourceReference,
    input: { baseVersion: string; content: string },
    signal: AbortSignal,
  ): Promise<DocumentTextSaveResult>;
}

export interface GenericFilePreviewPort {
  load(source: SourceReference, signal: AbortSignal): Promise<GenericFilePreview>;
}

interface SourceDocumentAsset {
  kind: 'source';
  url: string;
  version: string;
}

export interface DocxDocumentAsset {
  fallbackUrl: string;
  kind: 'docx';
  url: string;
  version: string;
}

export interface MediaDocumentAsset {
  kind: 'media';
  url: string;
  version: string;
}

export type DocumentAsset = DocxDocumentAsset | MediaDocumentAsset | SourceDocumentAsset;

export interface DocumentAssetPort {
  load(source: SourceReference, signal: AbortSignal): Promise<DocumentAsset>;
}

interface DocxPreview {
  html: string;
}

export interface DocxPreviewPort {
  load(resource: DocxDocumentAsset, signal: AbortSignal): Promise<DocxPreview>;
}

export interface DocumentQueryScope {
  cancel(): Promise<void>;
  remove(): void;
  replaceSource(source: DocumentTextSource): void;
}

export interface DocumentWindowLifecyclePort {
  onPrepareContextRelease(handler: () => boolean | Promise<boolean>): () => void;
}

/** What one Markdown file held before an Agent turn, kept by the host so the
 *  reader can review the turn inside the document. `afterVersion` is the
 *  version the turn left on disk; a file that moved on since then is no longer
 *  the text the turn produced. */
export interface DocumentTurnChange {
  readonly afterVersion: string;
  readonly before: string;
  readonly source: SourceReference;
  readonly turnId: string;
}

export interface DocumentTurnChangesPort {
  /** The file's text from before `turnId`. Refused `expired` once the host
   *  no longer holds that turn or that file in it. */
  load(
    request: { source: SourceReference; turnId: string },
    signal: AbortSignal,
  ): Promise<DocumentTurnChange>;
}

export type DocumentTurnChangesError = FeatureError<'expired'>;
export const DocumentTurnChangesError = featureErrorClass<'expired'>('DocumentTurnChangesError');

export type DocumentSourceFailureKind = FeatureFailureKind<'unsupported-encoding' | 'missing'>;

export type DocumentSourceError = FeatureError<'unsupported-encoding' | 'missing'>;
export const DocumentSourceError = featureErrorClass<'unsupported-encoding' | 'missing'>(
  'DocumentSourceError',
);

export type GenericFilePreviewFailureKind = FeatureFailureKind<'not-generic' | 'missing'>;

export type GenericFilePreviewError = FeatureError<'not-generic' | 'missing'>;
export const GenericFilePreviewError = featureErrorClass<'not-generic' | 'missing'>(
  'GenericFilePreviewError',
);

export type DocumentAssetFailureKind = FeatureFailureKind<'missing'>;

export type DocumentAssetError = FeatureError<'missing'>;
export const DocumentAssetError = featureErrorClass<'missing'>('DocumentAssetError');

export type DocxPreviewFailureKind = FeatureFailureKind<'timeout'>;

export type DocxPreviewError = FeatureError<'timeout'>;
export const DocxPreviewError = featureErrorClass<'timeout'>('DocxPreviewError');

export type DocumentSaveFailureKind = FeatureFailureKind<'conflict' | 'missing'>;

/** The only failure that carries state: a conflict reports the version the
 *  server holds so the editor can offer an overwrite against a known base. */
export class DocumentSaveError extends FeatureError<'conflict' | 'missing'> {
  readonly currentVersion: string | null;

  constructor(
    kind: DocumentSaveFailureKind,
    message: string,
    options?: ErrorOptions & { currentVersion?: string | null | undefined },
  ) {
    super('DocumentSaveError', kind, message, options);
    this.currentVersion = options?.currentVersion ?? null;
  }
}

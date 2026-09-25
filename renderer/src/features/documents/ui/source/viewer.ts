/**
 * The contract every document viewer meets.
 *
 * A format is one registry entry (see `registry.tsx`) plus one viewer module
 * that takes these props, so adding a format never means editing a chain of
 * `format === …` tests spread across the workspace.
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import type { DocumentNavigationRuntime } from '@/features/documents/application/navigation-runtime';
import type {
  DocumentAssetPort,
  DocumentHumanizePort,
  DocumentSourcePort,
  DocxPreviewPort,
  GenericFilePreviewPort,
} from '@/features/documents/application/ports';
import type { DocumentViewerFormat } from '@/features/documents/domain/document-format';
import type { DocumentSelection } from '@/features/documents/domain/selection';
import type { SourceReference } from '@/shared/domain/source-reference';

/** Formats that can show a preparation status row above their content. */
export type PreparationSlotFormat = Extract<DocumentViewerFormat, 'docx' | 'image' | 'pdf'>;

/** Formats whose preparation is promoted the moment a tab opens them. */
export type PreparedOnOpenFormat = Extract<DocumentViewerFormat, 'docx'>;

export interface DocumentNavigationTarget {
  anchor?: string | undefined;
  source: SourceReference;
}

/** Every service a viewer may be handed. No viewer is handed all of them:
 *  each registry entry names the ones its viewer takes, and that list is what
 *  the viewer's props are checked against. Ports stay injected so no viewer
 *  picks its own adapter, and the navigation callbacks stay the workspace's. */
export interface DocumentViewerServices {
  assetApi: DocumentAssetPort;
  docxPreviewApi: DocxPreviewPort;
  genericPreviewApi: GenericFilePreviewPort;
  /** Absent where no rewrite service is wired; the Markdown surface then
   *  offers no Humanize control rather than one that cannot answer. */
  humanizeApi?: DocumentHumanizePort | undefined;
  navigation: DocumentNavigationRuntime;
  /** Absent where no Agent sits beside the document; the Markdown surface
   *  then offers no Ask Agent control. */
  onAskAgent?: ((selection: DocumentSelection) => void) | undefined;
  onNavigate(target: DocumentNavigationTarget): void;
  onOpenExternal(href: string): Promise<boolean>;
  onOpenPrepared?: ((source: SourceReference, format: PreparedOnOpenFormat) => void) | undefined;
  onReveal(source: SourceReference, signal: AbortSignal): Promise<void>;
  renderPreparation?:
    | ((source: SourceReference, format: PreparationSlotFormat) => ReactNode)
    | undefined;
  /** The reading-font control the Markdown surface places in its top-left
   *  corner. Composed by the app, so the preference stays Settings'. */
  renderReadingControl?: (() => ReactNode) | undefined;
  revealLabel: string;
  sourceApi: DocumentSourcePort;
}

/** A load in flight (`error` absent) or one that refused. */
export interface DocumentViewerStatus {
  readonly error?: unknown;
  readonly name: string;
  readonly retry?: (() => void) | undefined;
}

/** The name of one service a viewer can be handed. */
export type DocumentViewerService = keyof DocumentViewerServices;

/** What every viewer is given, whatever it reads. */
interface DocumentViewerContext {
  active: boolean;
  format: DocumentViewerFormat;
  name: string;
  runtime: DocumentRuntime;
  /** This format's own loading and failure panel. */
  status(status: DocumentViewerStatus): ReactNode;
}

/** One viewer's props: the context every viewer gets, plus exactly the
 *  services its registry entry names. A viewer that reaches for a service its
 *  entry did not name has no such prop, so the entry fails to compile. */
export type DocumentViewerProps<Service extends DocumentViewerService = DocumentViewerService> =
  DocumentViewerContext & Pick<DocumentViewerServices, Service>;

/** A viewer is a function of its props, not a class: that is what lets an
 *  entry that takes four services sit in a registry typed over all of them. */
type DocumentViewer<Service extends DocumentViewerService = DocumentViewerService> = (
  props: DocumentViewerProps<Service>,
) => ReactNode;

export interface DocumentViewerEntry<
  Service extends DocumentViewerService = DocumentViewerService,
> {
  readonly component: DocumentViewer<Service>;
  /** The viewer claims a find controller once its content is on screen. */
  readonly find: boolean;
  readonly icon: (path: string) => LucideIcon;
  /** The viewer publishes a heading outline. */
  readonly outline: boolean;
  /** The services this viewer takes. Naming them is what narrows its props. */
  readonly services: readonly Service[];
  readonly status: (status: DocumentViewerStatus) => ReactNode;
}

export type DocumentViewerRegistry = Readonly<Record<DocumentViewerFormat, DocumentViewerEntry>>;

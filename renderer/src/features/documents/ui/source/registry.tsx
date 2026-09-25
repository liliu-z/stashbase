/**
 * The one table that says what each document format is.
 *
 * Adding a format is one entry here plus one module under `viewers/`: the
 * viewer chunk, whether the viewer claims Find and publishes an outline, the
 * tab icon, and the loading/failure panel that format shows. Nothing else in
 * the workspace tests a format by name.
 */
import {
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileType2,
  FileVideo,
  type LucideIcon,
} from 'lucide-react';
import { lazy } from 'react';

import {
  DOCUMENT_ASSET_MESSAGES,
  DOCUMENT_SOURCE_MESSAGES,
  GENERIC_PREVIEW_MESSAGES,
} from '@/features/documents/application/failure-messages';
import type { DocumentViewerFormat } from '@/features/documents/domain/document-format';
import { mediaKind } from '@/features/documents/domain/media';

import { documentStatusRenderer } from './status';
import type { DocumentViewerEntry, DocumentViewerRegistry, DocumentViewerService } from './viewer';

/** One entry, with its viewer checked against exactly the services it names.
 *  A viewer that destructures a service its entry left out has no such prop,
 *  so the mismatch is a compile error here rather than an undefined at
 *  runtime. */
function viewerEntry<const Service extends DocumentViewerService>(
  entry: DocumentViewerEntry<Service>,
): DocumentViewerEntry {
  return entry;
}

const sourceStatus = documentStatusRenderer<'unsupported-encoding' | 'missing'>(
  'DocumentSourceError',
  DOCUMENT_SOURCE_MESSAGES,
);
const assetStatus = documentStatusRenderer<'missing'>(
  'DocumentAssetError',
  DOCUMENT_ASSET_MESSAGES,
);
const genericStatus = documentStatusRenderer<'not-generic' | 'missing'>(
  'GenericFilePreviewError',
  GENERIC_PREVIEW_MESSAGES,
);

const constantIcon = (icon: LucideIcon) => () => icon;

const markdown = viewerEntry({
  component: lazy(() => import('./viewers/markdown')),
  find: true,
  icon: constantIcon(FileText),
  outline: true,
  services: [
    'humanizeApi',
    'navigation',
    'onAskAgent',
    'onNavigate',
    'onOpenExternal',
    'renderReadingControl',
    'sourceApi',
  ],
  status: sourceStatus,
});

const json = viewerEntry({
  component: lazy(() => import('./viewers/json')),
  find: true,
  icon: constantIcon(FileText),
  outline: false,
  services: ['navigation', 'sourceApi'],
  status: sourceStatus,
});

const plainText = viewerEntry({
  component: lazy(() => import('./viewers/plain-text')),
  find: true,
  icon: constantIcon(FileText),
  outline: false,
  services: ['navigation', 'sourceApi'],
  status: sourceStatus,
});

const html = viewerEntry({
  component: lazy(() => import('./viewers/html')),
  find: true,
  icon: constantIcon(FileCode2),
  outline: false,
  services: ['assetApi', 'navigation', 'onNavigate', 'onOpenExternal'],
  status: assetStatus,
});

const docx = viewerEntry({
  component: lazy(() => import('./viewers/docx')),
  find: true,
  icon: constantIcon(FileText),
  outline: true,
  services: [
    'assetApi',
    'docxPreviewApi',
    'navigation',
    'onNavigate',
    'onOpenExternal',
    'onOpenPrepared',
    'renderPreparation',
  ],
  status: assetStatus,
});

const image = viewerEntry({
  component: lazy(() => import('./viewers/image')),
  find: false,
  icon: constantIcon(FileImage),
  outline: false,
  services: ['assetApi', 'renderPreparation'],
  status: assetStatus,
});

const pdf = viewerEntry({
  component: lazy(() => import('./viewers/pdf')),
  find: true,
  icon: constantIcon(FileType2),
  outline: false,
  services: ['assetApi', 'navigation', 'renderPreparation'],
  status: assetStatus,
});

const audio = viewerEntry({
  component: lazy(() => import('./viewers/audio')),
  find: false,
  icon: (path) => (mediaKind(path) === 'video' ? FileVideo : FileAudio),
  outline: false,
  services: ['assetApi'],
  status: assetStatus,
});

const generic = viewerEntry({
  component: lazy(() => import('./viewers/generic')),
  find: true,
  icon: constantIcon(FileText),
  outline: false,
  services: ['genericPreviewApi', 'navigation', 'onReveal', 'revealLabel'],
  status: genericStatus,
});

export const documentViewers: DocumentViewerRegistry = {
  audio,
  docx,
  generic,
  html,
  image,
  json,
  md: markdown,
  pdf,
  txt: plainText,
};

export function documentViewerEntry(
  format: DocumentViewerFormat,
  registry: DocumentViewerRegistry = documentViewers,
): DocumentViewerEntry {
  return registry[format];
}

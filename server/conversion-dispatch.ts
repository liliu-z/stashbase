/**
 * Deep dispatch module for AppData-derived source formats.
 *
 * Format adapters stay private. Callers ask for lifecycle operations without
 * repeating format switches, cleanup rules, or interactive-promotion logic.
 */
import fs from 'node:fs';
import {
  configuredTranscriptionBlock,
  discoverNewAudio,
  indexFreshAudio,
  maybeConvertAudio,
  resetAudioTranscription,
} from './audio-transcription.ts';
import { promoteConversion } from './conversion.ts';
import { clearRecord } from './conversion-status.ts';
import { derivedHtmlPathForDocx, discoverNewDocx, indexFreshDocx, maybeConvertDocx } from './docx.ts';
import { filesystemPath } from './filesystem-path.ts';
import { isAudioFile, isDocxFile, isImageFile } from './format.ts';
import { derivedNotePathForImage, discoverNewImages, indexFreshImage, maybeConvertImage } from './image.ts';
import { derivedPathsForPdf, discoverNewPdfs, indexFreshPdf, maybeConvertPdf } from './pdf.ts';
import type { ConfiguredTranscriptionBlock } from '../shared/transcription.ts';

export interface ConvertibleOptions {
  urgency?: 'interactive';
  language?: string;
}

export type ConvertibleReprocessResult =
  | { status: 'unsupported' }
  | { status: 'blocked'; block: ConfiguredTranscriptionBlock }
  | { status: 'queued' };

interface ConvertibleFormatAdapter {
  matches(path: string): boolean;
  queue(sourceAbs: string, options: ConvertibleOptions): void;
  discover(folderAbs: string): void;
  indexFresh(sourceAbs: string): Promise<boolean>;
  reset(sourceAbs: string): void;
  interactive: boolean;
  reprocessBlock?(): ConfiguredTranscriptionBlock | null;
}

const FORMATS: readonly ConvertibleFormatAdapter[] = [
  {
    matches: (candidate) => /\.pdf$/i.test(candidate),
    queue: (sourceAbs, options) => maybeConvertPdf(sourceAbs, urgencyOnly(options)),
    discover: discoverNewPdfs,
    indexFresh: indexFreshPdf,
    reset: (sourceAbs) => {
      const { notePath, bundleDir } = derivedPathsForPdf(sourceAbs);
      fs.rmSync(notePath, { force: true });
      fs.rmSync(bundleDir, { recursive: true, force: true });
    },
    interactive: false,
  },
  {
    matches: isImageFile,
    queue: (sourceAbs, options) => maybeConvertImage(sourceAbs, urgencyOnly(options)),
    discover: discoverNewImages,
    indexFresh: indexFreshImage,
    reset: (sourceAbs) => fs.rmSync(derivedNotePathForImage(sourceAbs), { force: true }),
    interactive: false,
  },
  {
    matches: isDocxFile,
    queue: (sourceAbs, options) => maybeConvertDocx(sourceAbs, urgencyOnly(options)),
    discover: discoverNewDocx,
    indexFresh: indexFreshDocx,
    reset: (sourceAbs) => fs.rmSync(derivedHtmlPathForDocx(sourceAbs), { force: true }),
    interactive: true,
  },
  {
    matches: isAudioFile,
    queue: (sourceAbs, options) => { maybeConvertAudio(sourceAbs, options); },
    discover: discoverNewAudio,
    indexFresh: indexFreshAudio,
    reset: resetAudioTranscription,
    interactive: true,
    reprocessBlock: configuredTranscriptionBlock,
  },
];

export function queueConvertibleSource(
  sourceAbs: string,
  displayName = sourceAbs,
  options: ConvertibleOptions = {},
): boolean {
  const format = findFormat(displayName);
  if (!format) return false;
  format.queue(sourceAbs, options);
  return true;
}

export function reprocessConvertibleSource(
  sourceAbs: string,
  displayName = sourceAbs,
  options: ConvertibleOptions = {},
): ConvertibleReprocessResult {
  const format = findFormat(displayName);
  if (!format) return { status: 'unsupported' };
  const block = format.reprocessBlock?.();
  if (block) return { status: 'blocked', block };
  clearRecord(filesystemPath.absolute(sourceAbs));
  format.reset(sourceAbs);
  format.queue(sourceAbs, { ...options, urgency: 'interactive' });
  return { status: 'queued' };
}

export function prepareConvertibleSource(sourceAbs: string, displayName = sourceAbs): boolean {
  const format = findFormat(displayName);
  if (!format?.interactive) return false;
  const sourcePath = filesystemPath.absolute(sourceAbs);
  if (!promoteConversion(sourcePath, 'interactive')) {
    format.queue(sourceAbs, { urgency: 'interactive' });
  }
  return true;
}

export function discoverConvertibleSources(folderAbs: string): void {
  for (const format of FORMATS) format.discover(folderAbs);
}

export function indexFreshConvertibleSource(sourceAbs: string, displayName = sourceAbs): Promise<boolean> {
  return findFormat(displayName)?.indexFresh(sourceAbs) ?? Promise.resolve(false);
}

function findFormat(candidate: string): ConvertibleFormatAdapter | null {
  return FORMATS.find((format) => format.matches(candidate)) ?? null;
}

function urgencyOnly(options: ConvertibleOptions): { urgency?: 'interactive' } {
  return options.urgency ? { urgency: options.urgency } : {};
}

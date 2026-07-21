import fs from 'node:fs';
import { getApiKey } from './app-config.ts';
import { getConversionSchedulerSnapshot, getInFlightConversions } from './conversion.ts';
import { clearRecord, listPreparationProblems, readProgress, type ConversionProgress } from './conversion-status.ts';
import { blockedAudioSourcesForFolder } from './audio-transcription.ts';
import { filesystemPath } from './filesystem-path.ts';
import { hasNoExtractableText, shouldIndexFilePath } from './indexable.ts';
import { displayPathForHit } from './pdf.ts';
import { getFsChangeCounter } from './watcher.ts';
import { getIndexWarning, indexer } from './state.ts';

type SchedulerSnapshot = ReturnType<typeof getConversionSchedulerSnapshot>;

export interface PreparationFailure {
  path: string;
  lastError: string;
  attempts: number;
  status: 'failed' | 'cancelled';
}

export async function buildIndexStatus(folderRoot: string): Promise<Record<string, unknown>> {
  const curRoot = filesystemPath.absolute(folderRoot);
  const status = await indexer.status(curRoot);
  const treeVersion = getFsChangeCounter();
  const semanticEnabled = !!getApiKey();
  const pending = semanticEnabled ? pendingVisibleFiles(status.pending, curRoot, folderRoot) : [];
  const orphaned = status.orphaned
    .map((p) => filesystemPath.relative(curRoot, p))
    .filter((p): p is string => p != null);
  const schedulerSnapshot = getConversionSchedulerSnapshot();

  return {
    folder: curRoot,
    ...status,
    semanticEnabled,
    ...(semanticEnabled ? {} : { semanticDisabledReason: 'OpenAI API key required' }),
    pending,
    pendingCount: pending.length,
    orphaned,
    orphanedCount: orphaned.length,
    visibleIndexingSettled: !semanticEnabled || pending.length === 0,
    pendingConversions: getInFlightConversions(curRoot),
    blockedConversions: await blockedAudioSourcesForFolder(curRoot, treeVersion),
    conversionProgress: conversionProgressForFolder(curRoot, schedulerSnapshot),
    conversionRevision: schedulerSnapshot.revision,
    conversionVersions: conversionVersionsForFolder(curRoot, schedulerSnapshot),
    preparationFailures: preparationFailuresForFolder(curRoot),
    treeVersion,
    indexWarning: getIndexWarning(curRoot),
  };
}

function pendingVisibleFiles(sourcePaths: string[], folderRootAbs: string, folderRoot: string): string[] {
  const pendingSet = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const rel = filesystemPath.relative(folderRootAbs, sourcePath);
    if (rel == null) continue;
    if (!shouldIndexFilePath(rel)) continue;
    if (hasNoExtractableText(filesystemPath.join(folderRoot, rel))) continue;
    const visible = displayPathForHit(rel, folderRoot);
    if (visible) pendingSet.add(visible);
  }
  return [...pendingSet].sort();
}

export function preparationFailuresForFolder(folderRoot: string): PreparationFailure[] {
  const root = filesystemPath.absolute(folderRoot);
  const out: PreparationFailure[] = [];
  for (const { path: sourcePath, entry } of listPreparationProblems()) {
    const rel = filesystemPath.relative(root, sourcePath);
    if (rel == null) continue;
    if (!fs.existsSync(sourcePath)) {
      clearRecord(sourcePath);
      continue;
    }
    out.push({
      path: rel,
      lastError: entry.lastError ?? '',
      attempts: entry.attempts,
      status: entry.status === 'cancelled' ? 'cancelled' : 'failed',
    });
  }
  return out;
}

export function conversionProgressForFolder(
  folderRoot: string,
  snapshot: SchedulerSnapshot = getConversionSchedulerSnapshot(),
): Record<string, ConversionProgress> {
  const root = filesystemPath.absolute(folderRoot);
  const out: Record<string, ConversionProgress> = {};
  for (const task of snapshot.tasks) {
    const rel = filesystemPath.relative(root, task.key);
    if (rel == null) continue;
    if (task.state === 'queued' || task.state === 'yielded') {
      out[rel] = { phase: task.state, lane: task.lane, tasksAhead: task.tasksAhead ?? 0 };
      continue;
    }
    const progress = readProgress(task.key);
    if (progress) out[rel] = progress;
  }
  return out;
}

export function conversionVersionsForFolder(
  folderRoot: string,
  snapshot: SchedulerSnapshot = getConversionSchedulerSnapshot(),
): Record<string, number> {
  const root = filesystemPath.absolute(folderRoot);
  const out: Record<string, number> = {};
  for (const [sourcePath, version] of Object.entries(snapshot.versions)) {
    const rel = filesystemPath.relative(root, sourcePath);
    if (rel != null) out[rel] = version;
  }
  return out;
}

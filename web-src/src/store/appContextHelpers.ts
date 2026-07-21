import type { SearchHit } from '../api';
import type { State } from './state';

const SEMANTIC_SEARCH_MAX_VISIBLE = 8;
const SEMANTIC_MIN_TOP_RATIO = 0.8;
const SEMANTIC_KNEE_DROP_RATIO = 0.18;
const SEMANTIC_KNEE_TOP_RATIO = 0.88;

export function shallowEqualIndexWarning(
  a: State['indexWarning'],
  b: State['indexWarning'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.message === b.message && a.at === b.at;
}

export function shallowEqualPreparationFailures(
  a: State['preparationFailures'],
  b: State['preparationFailures'],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((f, i) =>
    f.path === b[i].path
      && f.attempts === b[i].attempts
      && f.lastError === b[i].lastError
      && f.status === b[i].status,
  );
}

export function shallowEqualConversionProgress(
  a: State['conversionProgress'],
  b: State['conversionProgress'],
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((key) => {
    const av = a[key];
    const bv = b[key];
    if (!bv || av.phase !== bv.phase) return false;
    if (av.phase === 'extracting' && bv.phase === 'extracting') {
      return av.currentPage === bv.currentPage
        && av.completedUnits === bv.completedUnits
        && av.totalUnits === bv.totalUnits;
    }
    if (
      (av.phase === 'queued' || av.phase === 'yielded')
      && bv.phase === av.phase
    ) {
      return av.lane === bv.lane && av.tasksAhead === bv.tasksAhead;
    }
    return true;
  });
}

export function shallowEqualNumberRecord(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((key) => a[key] === b[key]);
}

export function filterGuiSemanticHits(hits: SearchHit[]): SearchHit[] {
  if (hits.length <= 1) return hits;
  const top = hits[0]?.score ?? 0;
  if (!Number.isFinite(top) || top <= 0) {
    return hits.slice(0, SEMANTIC_SEARCH_MAX_VISIBLE);
  }

  let cutoff = Math.min(hits.length, SEMANTIC_SEARCH_MAX_VISIBLE);
  for (let i = 1; i < hits.length; i++) {
    const current = hits[i]?.score ?? 0;
    const previous = hits[i - 1]?.score ?? top;
    const topRatio = current / top;
    const prevDrop = previous > 0 ? (previous - current) / previous : 0;

    if (topRatio < SEMANTIC_MIN_TOP_RATIO) {
      cutoff = Math.min(cutoff, i);
      break;
    }
    if (i >= 2 && prevDrop >= SEMANTIC_KNEE_DROP_RATIO && topRatio < SEMANTIC_KNEE_TOP_RATIO) {
      cutoff = Math.min(cutoff, i);
      break;
    }
  }

  return hits.slice(0, Math.max(1, cutoff));
}

export function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export function keywordFindCaseSensitive(query: string, caseStrict: boolean): boolean {
  return caseStrict || query !== query.toLowerCase();
}

export function isFolderFileTab(t: { file: State['tabs'][number]['file'] }, name: string): boolean {
  return t.file?.name === name;
}

import type { State } from './state';

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

/** True when the tab holds the ACTIVE folder's file `name`. Out-of-folder
 *  or external tabs (`file.folder` set or `file.isExternal` set) are a
 *  different document even under the same rel name, so they never match. */
export function isFolderFileTab(t: { file: State['tabs'][number]['file'] }, name: string): boolean {
  return t.file?.name === name && !t.file.folder && !t.file.isExternal;
}

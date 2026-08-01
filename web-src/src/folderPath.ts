export function isAbsoluteFolderRef(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]/.test(value);
}

function comparisonKey(value: string): { key: string; windows: boolean } {
  let key = value.trim().replace(/\\/g, '/');
  const windows = /^[A-Za-z]:\//.test(key) || key.startsWith('//');
  if (key.length > 1 && key.endsWith('/')) key = key.replace(/\/+$/, '');
  return { key: windows ? key.toLowerCase() : key, windows };
}

/** Renderer-side identity check used only for server-returned absolute folder
 * references. Windows drive/UNC paths fold separators and case; POSIX paths
 * remain case-sensitive. */
export function folderRefsEqual(a: string, b: string): boolean {
  const left = comparisonKey(a);
  const right = comparisonKey(b);
  return left.windows === right.windows && left.key === right.key;
}

export function isFolderStillInLibrary(
  folder: string,
  library: { recent?: readonly { path: string }[] },
): boolean {
  return library.recent?.some((entry) => folderRefsEqual(entry.path, folder)) ?? false;
}

export async function rebindFolderIfStillInLibrary<
  Library extends { recent?: readonly { path: string }[] },
  Opened,
>(
  folder: string,
  operations: {
    getLibrary: () => Promise<Library>;
    openFolder: (path: string) => Promise<Opened>;
    /** Re-check ownership after the library read and before issuing a
     * recovery mutation. A newer navigation may have started while the read
     * was in flight. */
    shouldContinue?: () => boolean;
  },
): Promise<{ library: Library; opened: Opened | null }> {
  const library = await operations.getLibrary();
  if (!isFolderStillInLibrary(folder, library)) return { library, opened: null };
  if (operations.shouldContinue && !operations.shouldContinue()) return { library, opened: null };
  return { library, opened: await operations.openFolder(folder) };
}

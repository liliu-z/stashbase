import fs from 'node:fs';
import path from 'node:path';

/** Directory links that need no privilege: junctions on Windows, so
 * containment tests through a linked directory run on every platform. */
export const DIRECTORY_LINK = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * Creates a file symlink, or returns false when Windows refuses one. File
 * symlinks there need Developer Mode or administrator rights, which is a
 * property of the machine rather than of StashBase. The caller skips only the
 * link-specific assertions and reports them as not exercised.
 */
export function fileSymlink(
  target: string,
  link: string,
  report: { diagnostic(message: string): void },
): boolean {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    report.diagnostic(`file symlinks need Windows Developer Mode; the ${path.basename(link)} link case was not exercised`);
    return false;
  }
}

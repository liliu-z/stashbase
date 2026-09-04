import { useRef, useState } from 'react';
import { api, errorMessage } from '@/common/api/api';
import { electronBridge } from '@/common/lib/electronBridge';
import type { GalleryWiki } from '@/features/templates/gallery';

/** The take-this-Wiki action: acquire the entry's public repository into
 *  the folder home through the existing GitHub import, and open the
 *  result in a NEW window.
 *
 *  Always a new window, by decision: the gallery window is the shop the
 *  user returns to for the next entry, so a copy never takes it over.
 *  And always the folder home, dialog-free: a gallery copy is a
 *  disposable "give me one", not a commitment worth interrupting with a
 *  location picker — the home is visible, and Show in Finder plus the
 *  switcher can always find it.
 *
 *  A hook because the request owns a lifecycle: an in-flight latch (the
 *  big button invites double clicks; two copies must be two deliberate
 *  acts, not one bounce), and failure feedback through the caller's
 *  toast. */
export function useDownloadWiki(onError: (message: string) => void) {
  const [downloading, setDownloading] = useState(false);
  const inFlight = useRef(false);

  async function downloadAndOpen(wiki: GalleryWiki): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setDownloading(true);
    try {
      const created = await api.importPublicGitHubRepository({
        url: wiki.repo,
        folderName: wiki.name,
      });
      const opened = await electronBridge()?.openFolderWindow?.(created.path);
      if (!opened) throw new Error('the copy was created but no window could open it');
    } catch (err: unknown) {
      onError(`Could not get this Wiki: ${errorMessage(err)}`);
    } finally {
      inFlight.current = false;
      setDownloading(false);
    }
  }

  return { downloading, downloadAndOpen };
}

import { useEffect, useRef, useState } from 'react';
import { FILE_MIME } from '../dragMime';
import { acceptsKnowledgeBaseDrop } from '../dragRouting';
import { useApp } from '../store/AppContext';

/**
 * Window-level drag/drop coordinator.
 *
 *  - Veil overlay shows the moment a file drag enters the window
 *    (`dataTransfer.types` includes "Files").
 *  - The folder row / FOLDER header under the cursor gets a
 *    `.drop-target` highlight while dragover fires. We compute it from
 *    `e.target.closest(...)` each event because React's drag events on
 *    individual rows fight us if a row scrolls in/out mid-drag.
 *  - On drop we either move an internal file (custom mime present) or
 *    import an external batch via `webkitGetAsEntry` recursion. The
 *    sync-collect-entries-before-await pattern below is **load-bearing**:
 *    Chromium invalidates `DataTransfer.items` on the first `await`,
 *    so an inline loop would silently drop every entry after the first.
 *
 * Returns the boolean veil-visibility flag for `<DropVeil>` to read.
 */
export function useGlobalDragDrop(): { hot: boolean; activeZone: 'sidebar' | 'main' | null } {
  const [veilHot, setVeilHot] = useState(false);
  const [activeZone, setActiveZone] = useState<'sidebar' | 'main' | null>(null);
  const { actions } = useApp();
  const dragDepth = useRef(0);
  const hotRef = useRef(false);
  const dropTargetFolder = useRef('');

  useEffect(() => {
    function clearDropHighlights() {
      for (const r of document.querySelectorAll('.tree-row.folder.drop-target')) {
        r.classList.remove('drop-target');
      }
      document.getElementById('sideHead')?.classList.remove('drop-target');
    }
    // Single hard-reset path for the veil. The enter/leave depth counter
    // can strand (OS file drags don't always balance enter/leave —
    // dropping into an iframe, releasing outside the window, or pressing
    // Esc can leave the count > 0 with no `drop` firing on window), so we
    // also call this from the `dragend` and `mousemove` safety nets below.
    function hideVeil() {
      dragDepth.current = 0;
      hotRef.current = false;
      dropTargetFolder.current = '';
      setVeilHot(false);
      setActiveZone(null);
      clearDropHighlights();
    }
    // The chat panel (AgentView) manages its own file drops — files
    // dropped there are transient context, NOT library imports. So the global
    // coordinator (which imports into the folder) sits out over that
    // region: no veil, no folder-highlight, no upload.
    function inChatPanel(e: DragEvent): boolean {
      return e.target instanceof Element && !!e.target.closest('.agent-view');
    }
    function onDragEnter(e: DragEvent) {
      if (!e.dataTransfer || !acceptsKnowledgeBaseDrop(e.dataTransfer)) return;
      if (inChatPanel(e)) return;
      dragDepth.current += 1;
      hotRef.current = true;
      setVeilHot(true);

      const tgt = e.target instanceof Element ? e.target : null;
      const isSidebar = tgt && !!tgt.closest('.sidebar');
      setActiveZone(isSidebar ? 'sidebar' : 'main');
    }
    function onDragLeave() {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) hideVeil();
    }
    // Safety nets so a mis-counted drag can't strand the veil. A real
    // HTML5 drag suppresses `mousemove`, so the first normal pointer move
    // after a drag means the gesture is over — if the veil is still up,
    // it's stuck; clear it. `dragend` covers cancelled internal drags.
    function onDragEnd() {
      if (hotRef.current) hideVeil();
    }
    function onMouseMove() {
      if (hotRef.current) hideVeil();
    }
    function onDragOver(e: DragEvent) {
      if (inChatPanel(e)) { hideVeil(); return; } // panel handles its own dragover
      if (e.dataTransfer && !acceptsKnowledgeBaseDrop(e.dataTransfer)) return;
      e.preventDefault();
      const tgt = e.target instanceof Element ? e.target : null;
      const isSidebar = tgt && !!tgt.closest('.sidebar');
      const nextZone = isSidebar ? 'sidebar' : 'main';
      setActiveZone(nextZone);
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = isSidebar ? 'copy' : 'link';
      }

      const folderEl = tgt?.closest('.tree-row.folder') as HTMLElement | null;
      const headEl = !folderEl ? (tgt?.closest('#sideHead') as HTMLElement | null) : null;
      const newTarget = folderEl?.dataset?.path ?? '';

      for (const r of document.querySelectorAll('.tree-row.folder.drop-target')) {
        r.classList.remove('drop-target');
      }
      const head = document.getElementById('sideHead');
      head?.classList.remove('drop-target');
      if (folderEl) folderEl.classList.add('drop-target');
      else if (headEl) head?.classList.add('drop-target');
      dropTargetFolder.current = newTarget;
    }
    async function onDrop(e: DragEvent) {
      if (inChatPanel(e)) { hideVeil(); return; } // panel handles its own drop
      e.preventDefault();
      const tgt = e.target instanceof Element ? e.target : null;
      const isSidebar = tgt && !!tgt.closest('.sidebar');
      const targetDir = dropTargetFolder.current;
      hideVeil();

      const internal = e.dataTransfer?.getData(FILE_MIME);
      if (internal) {
        await actions.moveFile(internal, targetDir);
        return;
      }
      const items = e.dataTransfer?.items;
      if (!items || items.length === 0) return;
      // Sync-collect entries before any await — see top-of-file note.
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      if (isSidebar) {
        const collected: { file: File; relPath: string }[] = [];
        for (const entry of entries) {
          await walkEntry(entry, '', collected);
        }
        if (collected.length) await actions.upload(collected, targetDir);
      } else {
        const files: File[] = [];
        let hasDirectories = false;
        for (const entry of entries) {
          if (entry.isFile) {
            const file = await new Promise<File>((res, rej) =>
              (entry as FileSystemFileEntry).file(res, rej),
            );
            files.push(file);
          } else if (entry.isDirectory) {
            hasDirectories = true;
          }
        }
        if (hasDirectories) {
          actions.toast('Directories cannot be opened temporarily; drop folders onto the Files sidebar to import them.', { level: 'warning' });
        }
        if (files.length > 0) {
          await actions.openExternalFiles(files);
        }
      }
    }

    async function onIframeDrop(e: Event) {
      const { entries } = (e as CustomEvent<{ entries: FileSystemEntry[] }>).detail;
      hideVeil();
      const files: File[] = [];
      let hasDirectories = false;
      for (const entry of entries) {
        if (entry.isFile) {
          const file = await new Promise<File>((res, rej) =>
            (entry as FileSystemFileEntry).file(res, rej),
          );
          files.push(file);
        } else if (entry.isDirectory) {
          hasDirectories = true;
        }
      }
      if (hasDirectories) {
        actions.toast('Directories cannot be opened temporarily; drop folders onto the Files sidebar to import them.', { level: 'warning' });
      }
      if (files.length > 0) {
        await actions.openExternalFiles(files);
      }
    }

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onDragEnd);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('stashbase:iframe-drop', onIframeDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('stashbase:iframe-drop', onIframeDrop);
    };
  }, [actions]);

  return { hot: veilHot, activeZone };
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: { file: File; relPath: string }[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej),
    );
    out.push({ file, relPath: prefix + entry.name });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const dirPath = prefix + entry.name + '/';
  // readEntries returns at most ~100 children per call — keep pulling
  // until it yields an empty batch.
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
      reader.readEntries(res, rej),
    );
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, dirPath, out);
  }
}

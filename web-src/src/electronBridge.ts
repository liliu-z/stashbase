import type { ClipboardOffer } from './components/ClipboardImportModal';
import type { FileFormat } from './apiTypes';

/** The renderer-visible surface of `electron/preload.cjs`. One declaration
 * for the whole renderer — feature code must not re-declare partial copies
 * or cast `window` inline. Every member is optional because the browser dev
 * shell has no bridge at all. */
export interface ElectronBridge {
  /** Stable per-window identity assigned by the main process at spawn. */
  windowId?: string;
  openFolderDialog?: (opts?: {
    title?: string;
    buttonLabel?: string;
    defaultPath?: string;
    allowCreateDirectory?: boolean;
  }) => Promise<string | null>;
  openExternal?: (url: string) => Promise<boolean>;
  /** Opens the main-process bug-report review for the sender's window. */
  reportBug?: () => Promise<boolean>;
  openFolderWindow?: (folder: string) => Promise<boolean>;
  setWindowFolder?: (folder: string | null) => Promise<boolean>;
  onPrepareContextRelease?: (handler: (reason: string) => Promise<boolean>) => (() => void);
  contextReleaseReady?: () => boolean;
  prepareFolderRemoval?: (folder: string) => Promise<boolean>;
  notifyFolderRemoved?: (folder: string) => Promise<boolean>;
  notifyLibraryFolderAdded?: (folder: string) => Promise<boolean>;
  onFolderRemoved?: (handler: (folder: string) => void) => (() => void);
  onLibraryFolderAdded?: (handler: (folder: string) => void) => (() => void);
  onClipboardImage?: (handler: (offer: ClipboardOffer) => void) => (() => void);
  setClipboardWatch?: (enabled: boolean) => Promise<boolean>;
  markClipboardHandled?: (hash: string) => void;
  markCurrentClipboardImageHandled?: () => void;
  setAgentComposerFocused?: (focused: boolean) => void;
  registerPreviewGrant?: (filePath: string) => Promise<{
    isInternal: boolean;
    relPath: string;
    grantId: string;
    name: string;
    format: FileFormat;
    absolutePath: string;
  }>;
  revokePreviewGrant?: (grantId: string) => Promise<boolean>;
  getPathForFile?: (file: File) => string;
  onOpenExternalFiles?: (handler: (filePaths: string[]) => void) => (() => void);
  notifyRendererReadyForNativeFiles?: () => void;
}

/** The preload bridge, or undefined outside Electron (browser dev shell). */
export function electronBridge(): ElectronBridge | undefined {
  return (window as { electron?: ElectronBridge }).electron;
}

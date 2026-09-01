/**
 * Library orientation.
 *
 * `getLibraryInfo()` is the agent's orientation card: where the default
 * folder home is and which folders ("Your Folders") are in the library.
 * Members can live anywhere on disk, so each is reported by its ABSOLUTE
 * source spelling (the path exposed through MCP) plus a short label. Everything else
 * (reading/writing notes, listing files) the agent does with the StashBase
 * file tools against those absolute paths; semantic facts come from
 * `search_library`. Agent Instructions are injected through the runtime and
 * do not ride in this capability response.
 */
import path from 'node:path';
import { getFolderHome, getRecentFolders } from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { getEmbedderProvider, type EmbedderProvider } from './app-config.ts';

export interface LibraryInfo {
  /** Absolute filesystem path of the default home (where new folders
   *  are created). Members may live outside it. */
  folder_home: string;
  /** The library folders ("Your Folders"): every folder the user has
   *  opened and not removed. `path` is the ABSOLUTE folder root — the
   *  source spelling the file tools and `search_library` use. `name` is a display label
   *  (basename). */
  folders: Array<{
    path: string;
    name: string;
    provider: EmbedderProvider;
  }>;
}

/** The agent's orientation card: the folder home + member folders. No
 *  daemon call — agents enumerate files themselves under each folder;
 *  semantic facts come from `search_library`. */
export function getLibraryInfo(): LibraryInfo {
  const provider = getEmbedderProvider();
  return {
    folder_home: getFolderHome(),
    folders: getRecentFolders().map((folder) => ({
      path: filesystemPath.absolute(folder.path),
      name: path.basename(folder.path),
      provider,
    })),
  };
}

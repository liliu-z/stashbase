/**
 * The file explorer's tree model: the pure transform from the flat
 * `files` / `folders` / `fileOrder` slices of workspace state into the
 * nested shape the explorer renders, plus the flattening that decides
 * which rows are on screen.
 *
 * It lives apart from `FileTree.tsx` because it is the part with rules —
 * recursive folder creation, manual-rank ordering, the folders-first
 * fallback, stale-order pruning — and none of them need React to be
 * exercised. See `__tests__/file-tree-model.test.ts`.
 */
import type { FileMeta, FolderMeta } from '@/common/api/api';
import { hasName, type NameSet } from '@/store/state/state';

export interface FolderNode {
  type: 'folder';
  name: string;
  path: string;
  kind?: FolderMeta['kind'];
  children: TreeNode[];
}

export interface FileNode {
  type: 'file';
  name: string;
  path: string;
  meta: FileMeta;
}

export type TreeNode = FolderNode | FileNode;

/**
 * Builds the explorer tree.
 *
 * `folders` and `files` are both flat and both carry slash-separated
 * paths, so every intermediate folder is created on demand — a file at
 * `a/b/note.md` materialises `a` and `a/b` even when neither appears in
 * `folders`.
 */
export function buildTree(
  files: FileMeta[],
  folders: FolderMeta[],
  fileOrder: Record<string, string[]>,
): FolderNode {
  const root: FolderNode = { type: 'folder', name: '', path: '', children: [] };
  const folderMap = new Map<string, FolderNode>();
  folderMap.set('', root);

  const ensureFolder = (folderPath: string, meta?: FolderMeta): FolderNode => {
    const cached = folderMap.get(folderPath);
    if (cached) {
      if (meta?.kind) cached.kind = meta.kind;
      return cached;
    }
    const segs = folderPath.split('/');
    const parentPath = segs.slice(0, -1).join('/');
    const parent = ensureFolder(parentPath);
    const node: FolderNode = {
      type: 'folder',
      name: segs[segs.length - 1],
      path: folderPath,
      kind: meta?.kind,
      children: [],
    };
    parent.children.push(node);
    folderMap.set(folderPath, node);
    return node;
  };
  for (const f of folders) ensureFolder(f.path, f);

  for (const f of files) {
    const segs = f.name.split('/');
    const parentPath = segs.slice(0, -1).join('/');
    const parent = ensureFolder(parentPath);
    parent.children.push({
      type: 'file',
      name: segs[segs.length - 1],
      path: f.name,
      meta: f,
    });
  }

  // Sort: items the user has manually ordered come first (in the
  // recorded order), unranked items follow in folders-first +
  // alphabetical order. Names in `fileOrder` that no longer exist on
  // disk are dropped silently (renamed / deleted files don't keep
  // their slot).
  const sortNodes = (nodes: TreeNode[], parentPath: string) => {
    const order = fileOrder[parentPath];
    if (order && order.length > 0) {
      const rank = new Map<string, number>();
      order.forEach((name, i) => rank.set(name, i));
      nodes.sort((a, b) => {
        const ai = rank.get(a.name);
        const bi = rank.get(b.name);
        if (ai != null && bi != null) return ai - bi;
        if (ai != null) return -1;
        if (bi != null) return 1;
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } else {
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    for (const n of nodes) if (n.type === 'folder') sortNodes(n.children, n.path);
  };
  sortNodes(root.children, '');
  return root;
}

/**
 * Whether a row lives in the hidden-directory namespace the Show Hidden
 * Files preference controls: a dot-prefixed DIRECTORY segment anywhere on
 * its path. Ordinary dotfiles (`.env` at the root) are always-visible user
 * content and deliberately do not match, so their presentation never
 * changes with the preference.
 */
export function isHiddenEntryPath(path: string, kind: 'file' | 'folder'): boolean {
  const segments = path.split('/');
  const directorySegments = kind === 'file' ? segments.slice(0, -1) : segments;
  return directorySegments.some((segment) => segment.startsWith('.'));
}

/**
 * The rows the user can actually see, in render order: a depth-first
 * walk that descends into a folder only while it is expanded.
 *
 * This is also the tree's keyboard order — `useTreeRoving` navigates
 * over exactly this list rather than re-deriving visibility from the DOM.
 */
export function visibleNodePaths(nodes: TreeNode[], expanded: NameSet, paths: string[] = []): string[] {
  for (const node of nodes) {
    paths.push(node.path);
    if (node.type === 'folder' && hasName(expanded, node.path)) {
      visibleNodePaths(node.children, expanded, paths);
    }
  }
  return paths;
}

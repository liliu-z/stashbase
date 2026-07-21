import { api } from '../api';
import { useApp } from '../store/AppContext';
import { getPreparationProblem } from '../store/fileReadiness';
import { Menu, type MenuItem } from './Menu';

/** Drag-import veil. Visibility flows from the global drag handler in
 *  the parent (`useGlobalDragDrop`) via the `hot` prop. */
export function DropVeil({ hot }: { hot: boolean }) {
  return <div className={'drop-veil' + (hot ? ' hot' : '')}>Release to import</div>;
}

/**
 * Right-click menu on file / folder rows. Rendered at cursor position
 * when `state.ctxMenu` is set. Positioning, dismissal (click-outside /
 * Escape / blur) and keyboard nav all live in the shared `<Menu>`.
 */
export function ContextMenu() {
  const { state, dispatch, actions } = useApp();
  if (!state.ctxMenu) return null;
  const { x, y, target, kind } = state.ctxMenu;
  const folderPathAtOpen = state.folderPath;
  const close = () => dispatch({ type: 'CTX_MENU', menu: null });

  // Reprocess only appears when the file already has a persisted
  // preparation failure. That keeps recovery off healthy files while
  // allowing any failed source file to ask the server to rebuild its
  // searchable representation.
  const preparationFailure = kind === 'file'
    ? getPreparationProblem(state, target)
    : undefined;
  const canReprocess = Boolean(preparationFailure);

  const items: MenuItem[] = [
    {
      label: 'Rename…',
      onSelect: () => dispatch({ type: 'RENAMING', renaming: { path: target, kind } }),
    },
    { label: revealLabel(), onSelect: () => void api.revealFile(target) },
    ...(canReprocess
      ? [
          {
            label: 'Reprocess',
            title: 'Rebuild the searchable version of this file',
            // Fire-and-forget — the failures-list / marker updates on the
            // next index-status poll (~1.5s in pending mode). If the API
            // itself 4xx's we log; user-facing feedback comes via that
            // marker clearing or staying failed.
            onSelect: () => {
              actions.toast('Reprocessing…', { level: 'info' });
              void api.reprocessFile(target, { folder: folderPathAtOpen || undefined })
                .then(() => actions.refreshIndexState())
                .catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  actions.toast('Reprocess could not start. Try again.', { level: 'error' });
                  console.warn('[ctxmenu] reprocess failed:', msg);
                });
            },
          } satisfies MenuItem,
        ]
      : []),
    { separator: true },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => (kind === 'folder' ? void actions.deleteFolder(target) : void actions.deleteFile(target)),
    },
  ];

  return <Menu anchor={{ x, y }} items={items} onClose={close} />;
}

/** OS-appropriate label for the reveal-in-file-manager action. macOS
 *  users expect "Finder"; Windows users expect "Explorer"; other
 *  platforms fall back to the generic "File Manager". */
function revealLabel(): string {
  const p = (navigator.platform || '').toLowerCase();
  if (p.includes('mac')) return 'Reveal in Finder';
  if (p.includes('win')) return 'Reveal in Explorer';
  return 'Show in File Manager';
}

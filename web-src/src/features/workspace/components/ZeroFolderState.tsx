import { CubeLogoIcon } from '@/common/components/icons';
import { Button } from '@/common/components/ui/button';
import { errorMessage } from '@/common/api/api';
import { electronBridge } from '@/common/lib/electronBridge';
import { useAppActions } from '@/store/contexts/AppContext';

/** Zero-folder library: the one place sidebar chrome is allowed a small
 *  brand-warmth moment (see visual-style's warmth budget) — the app mark,
 *  a single line of guidance, and the primary add-folder action. */
export function ZeroFolderState() {
  const { actions } = useAppActions();
  const bridge = electronBridge();

  async function addFolder() {
    try {
      const picked = await bridge!.openFolderDialog!({
        title: 'Select folder',
        buttonLabel: 'Select folder',
        allowCreateDirectory: true,
      });
      if (picked) await actions.openFolder(picked);
    } catch (err) {
      actions.toast('Could not open the folder: ' + errorMessage(err), { level: 'error' });
    }
  }

  return (
    <div className="flex flex-col items-start gap-3 px-4 pt-5 pb-4">
      <div className="size-9 *:size-full"><CubeLogoIcon /></div>
      <p className="m-0 text-sm leading-snug text-muted-foreground">
        Add a folder to your Wiki.
      </p>
      {typeof bridge?.openFolderDialog === 'function' && (
        <Button onClick={() => { void addFolder(); }}>Add Folder…</Button>
      )}
    </div>
  );
}

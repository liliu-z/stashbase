import { useEffect, useState } from 'react';
import { api, errorMessage, type CapturePreferences, type UpdatePreferences } from '../../api';
import { electronBridge } from '../../electronBridge';
import { useDesktopUpdate } from '../../hooks/useDesktopUpdate';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';

export function GeneralPanel() {
  const [preferences, setPreferences] = useState<CapturePreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updatePreferences, setUpdatePreferences] = useState<UpdatePreferences | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [savingUpdates, setSavingUpdates] = useState(false);
  const { state: updateState, check, runPrimaryAction, openDownloadPage, refreshPreference } = useDesktopUpdate();

  useEffect(() => {
    let cancelled = false;
    void api.capturePreferences()
      .then((next) => {
        if (!cancelled) setPreferences(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    void api.updatePreferences()
      .then((next) => {
        if (!cancelled) setUpdatePreferences(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setUpdateError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, []);

  async function setClipboardImageImport(enabled: boolean) {
    if (!preferences) return;
    const previous = preferences;
    setPreferences({ ...preferences, clipboardImageImport: enabled });
    setSaving(true);
    setError(null);
    try {
      const saved = await api.setCapturePreferences({ clipboardImageImport: enabled });
      setPreferences(saved);
      try {
        const applied = await electronBridge()?.refreshClipboardWatch?.();
        if (applied !== undefined && applied !== saved.clipboardImageImport) {
          setError('Saved, but the desktop capture service could not apply the change. Restart StashBase to retry.');
        }
      } catch {
        setError('Saved, but the desktop capture service could not apply the change. Restart StashBase to retry.');
      }
    } catch (err: unknown) {
      setPreferences(previous);
      try {
        await electronBridge()?.refreshClipboardWatch?.();
      } catch { /* The persisted setting remains the authority. */ }
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function setAutomaticUpdateChecks(enabled: boolean) {
    if (!updatePreferences) return;
    const previous = updatePreferences;
    setUpdatePreferences({ autoCheck: enabled });
    setSavingUpdates(true);
    setUpdateError(null);
    try {
      const saved = await api.setUpdatePreferences({ autoCheck: enabled });
      setUpdatePreferences(saved);
      try {
        await refreshPreference();
      } catch {
        setUpdateError('Saved, but the desktop update service could not apply the change. Restart StashBase to retry.');
      }
    } catch (err: unknown) {
      setUpdatePreferences(previous);
      setUpdateError(errorMessage(err));
    } finally {
      setSavingUpdates(false);
    }
  }

  async function checkNow() {
    setUpdateError(null);
    try {
      await check();
    } catch (err: unknown) {
      setUpdateError(errorMessage(err));
    }
  }

  function updateStatus() {
    if (!updateState) return 'Update status is available in the desktop app.';
    switch (updateState.phase) {
      case 'checking': return 'Checking for updates…';
      case 'current': return `StashBase ${updateState.currentVersion} is up to date.`;
      case 'available': return `StashBase ${updateState.availableVersion} is available.`;
      case 'downloading': return `Downloading StashBase ${updateState.availableVersion}${updateState.percent === undefined ? '…' : ` — ${updateState.percent}%`}`;
      case 'ready': return `StashBase ${updateState.availableVersion} is ready to install.`;
      case 'installing': return `Installing StashBase ${updateState.availableVersion} and restarting…`;
      case 'error': return updateState.message || 'The update check failed.';
      case 'unsupported': return updateState.message || 'Update checks are unavailable in this build.';
      default: return `Current version: ${updateState.currentVersion}`;
    }
  }

  if (!preferences) {
    return error
      ? <div className="text-sm text-destructive">Couldn’t load capture settings: {error}</div>
      : <div className="py-3 text-base text-muted-foreground">Loading…</div>;
  }

  return (
    <div>
      <div className="mb-1 text-base font-semibold">Knowledge capture</div>
      <div className="text-sm leading-normal text-muted-foreground">
        Choose which ambient sources StashBase may notice. Nothing is added to a folder without confirmation.
      </div>
      <div className="mt-5.5 flex items-start gap-2 text-sm text-foreground">
        <Checkbox
          id="clipboard-image-import"
          className="mt-0.5"
          checked={preferences.clipboardImageImport}
          disabled={saving}
          onCheckedChange={(checked) => { void setClipboardImageImport(checked); }}
        />
        <label htmlFor="clipboard-image-import" className="cursor-pointer">
          <span className="block font-semibold">Offer to add clipboard screenshots</span>
          <span className="mt-0.5 block leading-normal text-muted-foreground">
            While a StashBase window is focused, notice copied images and ask before adding one to the current folder for OCR and search.
          </span>
        </label>
      </div>
      {error && <div className="mt-2.5 text-sm text-destructive">Couldn’t save capture settings: {error}</div>}

      <div className="mt-7 border-t border-border pt-6">
        <div className="mb-1 text-base font-semibold">Application updates</div>
        <div className="text-sm leading-normal text-muted-foreground">
          StashBase verifies updates published through the official GitHub release channel. Clicking Update downloads, installs, and restarts the app after open edits are saved.
        </div>
        {updatePreferences ? (
          <div className="mt-5.5 flex items-start gap-2 text-sm text-foreground">
            <Checkbox
              id="automatic-update-checks"
              className="mt-0.5"
              checked={updatePreferences.autoCheck}
              disabled={savingUpdates}
              onCheckedChange={(checked) => { void setAutomaticUpdateChecks(checked); }}
            />
            <label htmlFor="automatic-update-checks" className="cursor-pointer">
              <span className="block font-semibold">Automatically check for updates</span>
              <span className="mt-0.5 block leading-normal text-muted-foreground">
                Check shortly after launch and periodically while StashBase is running. This is enabled by default.
              </span>
            </label>
          </div>
        ) : (
          <div className="mt-5 text-sm text-muted-foreground">Loading update preferences…</div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!electronBridge()?.checkForUpdates || updateState?.phase === 'checking' || updateState?.phase === 'downloading' || updateState?.phase === 'installing'}
            onClick={() => { void checkNow(); }}
          >
            {updateState?.phase === 'checking' ? 'Checking…' : 'Check for updates'}
          </Button>
          {updateState?.availableVersion && (
            <Button
              size="sm"
              disabled={updateState.phase === 'downloading' || updateState.phase === 'installing'}
              onClick={() => { void runPrimaryAction(); }}
            >
              {updateState.phase === 'ready'
                ? 'Install update'
                : updateState.phase === 'downloading'
                  ? `Downloading ${updateState.percent ?? 0}%`
                  : updateState.phase === 'installing'
                    ? 'Installing…'
                    : 'Update and restart'}
            </Button>
          )}
          {(updateState?.phase === 'error' || updateState?.phase === 'unsupported') && (
            <Button variant="ghost" size="sm" onClick={() => { void openDownloadPage(); }}>
              Open download page
            </Button>
          )}
        </div>
        <div className={`mt-2.5 text-sm ${updateState?.phase === 'error' || updateError ? 'text-destructive' : 'text-muted-foreground'}`}>
          {updateError || updateStatus()}
        </div>
        {updateState?.platform === 'linux' && (
          <div className="mt-1 text-xs leading-normal text-muted-foreground">
            Linux package installs may ask for administrator approval before StashBase can restart.
          </div>
        )}
      </div>
    </div>
  );
}

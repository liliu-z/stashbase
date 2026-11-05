import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InputField, InputGroup } from '@/components/ui/input-group';
import type { GitHubImportView } from '@/features/workspace/hooks/use-project-entry';
import { FailureNotice } from '@/shared/ui/failure-notice';

export interface ImportGitHubDialogProps {
  import: GitHubImportView;
  onClose(): void;
  open: boolean;
}

/**
 * Import one public GitHub repository as a project folder, or make a local
 * copy of a Gallery entry, which is the same acquisition with its repository
 * fixed: the URL is then not the reader's to see, and the dialog asks only
 * for the folder name and where it goes. Nothing is downloaded until the
 * primary action is pressed.
 *
 * The URL and the destination name are refused inline by the same rules the
 * request will meet, so a reader is not told a URL is fine and then refused by
 * the server. Closing while a request is open cancels it; the server cleans
 * its own staging, and no partial member is left behind.
 */
export function ImportGitHubDialog({ import: request, onClose, open }: ImportGitHubDialogProps) {
  const close = () => {
    request.cancel();
    onClose();
  };

  const gallery = request.source !== null;

  return (
    <Dialog onOpenChange={(next) => !next && close()} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{gallery ? 'Make a copy' : 'Import from GitHub'}</DialogTitle>
          <DialogDescription>
            {gallery
              ? `Copy “${request.source}” to your computer as a new project.`
              : 'Create a new local project from a public repository. The original is never changed.'}
          </DialogDescription>
        </DialogHeader>
        {/* One group, not two: the group is a proximity row, and a lone field
         * in its own group loses the reveal and reads as static text. */}
        <InputGroup className="w-full" size="compact">
          {!gallery && (
            <InputField
              disabled={request.inputLocked}
              autoComplete="off"
              error={request.urlIssue ?? undefined}
              label="Repository URL"
              onChange={request.setUrl}
              placeholder="https://github.com/owner/repo"
              resting="filled"
              spellCheck={false}
              value={request.url}
            />
          )}
          <InputField
            disabled={request.inputLocked}
            autoComplete="off"
            error={request.nameIssue ?? undefined}
            label="Folder name"
            onChange={request.setFolderName}
            placeholder="repo"
            resting="filled"
            spellCheck={false}
            value={request.folderName}
          />
          {/* Where the folder is created. The path is chosen in the system
           * picker rather than typed, so the field is read-only and Change…
           * beside it, a button of its own level with the box, edits it. */}
          <div className="flex items-end gap-2">
            <InputField
              className="min-w-0 flex-1"
              disabled={request.inputLocked}
              label="Location"
              onChange={() => {}}
              placeholder="Choose a location"
              readOnly
              resting="filled"
              spellCheck={false}
              title={request.location ?? undefined}
              value={request.location ?? ''}
            />
            <Button
              className="shrink-0"
              disabled={request.inputLocked}
              onClick={request.chooseLocation}
              size="compact"
              variant="tertiary"
            >
              Change…
            </Button>
          </div>
        </InputGroup>
        {request.retainedPath && (
          <p className="m-0 pl-2 text-caption text-muted-foreground">
            Local project: {request.retainedPath}
          </p>
        )}
        {request.failure && <FailureNotice className="m-0 pl-2" failure={request.failure} />}
        <DialogFooter>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          {(request.retainedPath || request.checkingOutcome) && (
            <Button
              disabled={request.pending}
              onClick={request.startAnotherCopy}
              variant="tertiary"
            >
              Start another copy
            </Button>
          )}
          {request.existingPath && (
            <Button disabled={request.pending} onClick={request.openExisting} variant="tertiary">
              Open existing folder
            </Button>
          )}
          <Button disabled={!request.canSubmit} loading={request.pending} onClick={request.submit}>
            {request.retainedPath
              ? 'Open project'
              : request.checkingOutcome
                ? 'Check result'
                : gallery
                  ? 'Make a copy'
                  : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

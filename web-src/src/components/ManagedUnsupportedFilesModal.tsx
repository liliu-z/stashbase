import type { UnsupportedFileSummary } from '../apiTypes';
import { formatUnsupportedExtensions } from '../unsupportedFiles';
import ManagedModalShell from './ManagedModalShell';
import { Button } from './ui/button';

export default function ManagedUnsupportedFilesModal({
  unsupportedFiles,
  isTopmost,
  onCancel,
  onConfirm,
}: {
  unsupportedFiles: UnsupportedFileSummary;
  isTopmost: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { sourceCode, other, otherExtensions } = unsupportedFiles;
  const showSource = sourceCode > 0;
  const showOther = other > 0;
  const extensionCopy = formatUnsupportedExtensions(otherExtensions);

  let title: string;
  let content: React.ReactNode;
  if (showSource && showOther) {
    title = "Some files in this folder aren't supported";
    content = (
      <>
        <ul className="list-disc space-y-2 pl-5 text-sm text-imglytext/80 dark:text-dark-imglytext/80">
          <li><strong>{sourceCode} source-code and project files</strong> are not shown or indexed.</li>
          <li><strong>{other} files in other unsupported formats</strong> are not shown or indexed: {extensionCopy}.</li>
        </ul>
        <p className="text-sm text-imglytext/60 dark:text-dark-imglytext/60">
          These files remain unchanged on disk, but they will not appear in the Files view or StashBase search.
        </p>
      </>
    );
  } else if (showSource) {
    title = "Source code files aren't supported";
    content = (
      <>
        <p className="text-sm text-imglytext/80 dark:text-dark-imglytext/80">
          StashBase found <strong>{sourceCode} source-code and project files</strong> in this folder.
        </p>
        <p className="text-sm text-imglytext/60 dark:text-dark-imglytext/60">
          StashBase currently shows and indexes supported documents and media, not source code. These files remain unchanged on disk, but they will not appear in the Files view or StashBase search.
        </p>
      </>
    );
  } else {
    title = "Some file formats aren't supported yet";
    content = (
      <>
        <p className="text-sm text-imglytext/80 dark:text-dark-imglytext/80">
          StashBase found <strong>{other} files in unsupported formats</strong>: {extensionCopy}.
        </p>
        <p className="text-sm text-imglytext/60 dark:text-dark-imglytext/60">
          These files remain unchanged on disk, but they will not appear in the Files view or StashBase search.
        </p>
      </>
    );
  }

  return (
    <ManagedModalShell title={title} onCancel={onCancel} top isTopmost={isTopmost}>
      <div className="unsupported-files-modal-content space-y-4">{content}</div>
      <div className="modal-actions mt-6 flex justify-end">
        <Button type="button" className="modal-btn primary" autoFocus onClick={onConfirm}>
          Continue with supported files
        </Button>
      </div>
    </ManagedModalShell>
  );
}

import { Paperclip } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

export function attachmentSlot(attachments: boolean, children: ReactNode) {
  return ({ openFilePicker }: { openFilePicker: () => void }) => (
    <>
      {attachments && (
        <Tooltip content="Attach files" side="top">
          <Button
            aria-label="Attach files"
            onClick={() => openFilePicker()}
            size="icon-compact"
            variant="ghost"
          >
            <Paperclip />
          </Button>
        </Tooltip>
      )}
      {children}
    </>
  );
}

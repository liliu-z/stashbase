import { Paperclip } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

export function attachmentSlot(attachments: boolean) {
  return ({ openFilePicker }: { openFilePicker: () => void }) =>
    attachments && (
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
    );
}

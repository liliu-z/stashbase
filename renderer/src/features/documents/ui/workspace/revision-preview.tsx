import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { shapeTokens } from '@/lib/shape-context';
import { textFieldClass } from '@/shared/ui/text-field';

const FIELD_CLASS = textFieldClass(
  'resize-y bg-background font-mono text-caption text-foreground',
  shapeTokens.input,
);

export interface RevisionPreviewProps {
  onStart(before: string): void;
  refusal: string | null;
}

/** Development controls that open a revision review on the document in front
 *  of the reader, using the text from before an Agent turn. */
export function RevisionPreview({ onStart, refusal }: RevisionPreviewProps) {
  const id = useId();
  const [before, setBefore] = useState('');

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-muted-foreground">
        Paste the Markdown from before the turn. Compare it with the document in front of you, then
        undo or keep each change.
      </p>
      <label className="text-caption" htmlFor={id}>
        Document before the turn
      </label>
      <textarea
        className={FIELD_CLASS}
        id={id}
        onChange={(event) => setBefore(event.target.value)}
        placeholder={'# Title\n\nThe revised opening line.\n'}
        rows={8}
        value={before}
      />
      {refusal && (
        <p className="text-caption text-destructive" role="alert">
          {refusal}
        </p>
      )}
      <Button
        className="self-start"
        disabled={before.trim().length === 0}
        onClick={() => onStart(before)}
        size="compact"
        variant="tertiary"
      >
        Start review
      </Button>
    </div>
  );
}

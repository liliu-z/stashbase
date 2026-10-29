/** Pushes the project's Math mode into the open Markdown editor as a
 *  decoration-only transaction. Reading the switch and applying it live here so
 *  the document surface stays about the document: turning the mode on or off
 *  edits nothing, so the save stays clean and undo, selection and scroll hold. */
import type { CrepeBuilder } from '@milkdown/crepe/builder';
import { useEffect, type RefObject } from 'react';

import { useMathMode } from '@/shared/ui/math-mode';

import { setDollarMathMode } from './math';

/** `ready` gates the push: an editor that has not been created yet has no view
 *  to decorate, and a mode that arrives later is applied on the transition. */
export function useDollarMathMode(ready: boolean, editorRef: RefObject<CrepeBuilder | null>): void {
  const { enabled } = useMathMode();
  useEffect(() => {
    if (!ready) return;
    setDollarMathMode(editorRef.current, enabled);
  }, [enabled, editorRef, ready]);
}

import { useState } from 'react';

import { DOCUMENT_REVISION_MESSAGES } from '@/features/documents/application/failure-messages';
import type { DocumentTabsRuntime } from '@/features/documents/application/tabs-contract';
import { splitLeadingYamlFrontmatter } from '@/features/documents/domain/markdown';

export interface RevisionPreview {
  /** What the last attempt refused for, or null when the review opened. */
  refusal: string | null;
  start(before: string): void;
}

const NO_DOCUMENT = 'Open a Markdown document first.';

/**
 * The development harness that opens a review with no agent involved.
 *
 * It is a harness, not a preference: the build flag decides whether the
 * control exists and this hook refuses again on its own, so a packaged build
 * cannot reach it even if a stray prop arrives. Nothing here is stored, and
 * the earlier text is read once when review starts.
 */
export function useRevisionPreview(
  enabled: boolean,
  documents: DocumentTabsRuntime | null,
): RevisionPreview {
  const [refusal, setRefusal] = useState<string | null>(null);

  return {
    refusal,
    start(before) {
      if (!enabled || !documents) return;
      const activeTabId = documents.store.getState().activeTabId;
      const active = activeTabId ? documents.getDocument(activeTabId) : null;
      const editor = active?.store.getState().editor ?? null;
      if (!active || !editor) {
        setRefusal(NO_DOCUMENT);
        return;
      }
      const reason = active.startRevision(
        {
          baseVersion: editor.version,
          id: `preview-${Date.now()}`,
          before: splitLeadingYamlFrontmatter(before).body,
        },
        splitLeadingYamlFrontmatter(editor.value).body,
      );
      setRefusal(reason === null ? null : DOCUMENT_REVISION_MESSAGES[reason]);
    },
  };
}

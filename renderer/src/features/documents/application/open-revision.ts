/** Load the earlier text of a turn and open it as an inline review. A freshly
 * opened tab may not have an editor yet, so wait for its source before checking
 * the disk version and entering review. Every refusal is returned to the caller. */
import type { DocumentEditorState } from '@/features/documents/domain/document';
import { splitLeadingYamlFrontmatter } from '@/features/documents/domain/markdown';
import type { RevisionRefusal } from '@/features/documents/domain/revision';

import type { DocumentRuntime } from './document-runtime';
import {
  DocumentTurnChangesError,
  type DocumentSourcePort,
  type DocumentTurnChange,
  type DocumentTurnChangesPort,
} from './ports';

/** Bound the wait for a newly opened document to finish loading. */
const EDITOR_WAIT_MS = 20_000;

/** A refusal opening the requested review. */
type TurnReviewFailure = RevisionRefusal | 'not-opened' | 'not-verified';

/** Why a turn the reader asked to review never became a review. `expired` is
 *  the host no longer holding the text from before the turn. */
export type TurnChangeReviewFailure = TurnReviewFailure | 'expired';

/** The document's editor once it has text, or null when the runtime was
 *  disposed or the wait ran out first. */
function waitForEditor(runtime: DocumentRuntime): Promise<DocumentEditorState | null> {
  const present = runtime.store.getState().editor;
  if (present) return Promise.resolve(present);
  if (runtime.signal.aborted) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let release: (() => void) | null = null;
    const abort = () => settle(null);
    const timer = setTimeout(() => settle(null), EDITOR_WAIT_MS);

    function settle(editor: DocumentEditorState | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release?.();
      runtime.signal.removeEventListener('abort', abort);
      resolve(editor);
    }

    runtime.signal.addEventListener('abort', abort);
    release = runtime.store.subscribe((state) => {
      if (state.editor) settle(state.editor);
    });
  });
}

/** The text a review offers and the version the turn left on disk. */
interface ReviewOffer {
  readonly baseVersion: string;
  /** The whole file, frontmatter included. */
  readonly content: string;
  readonly id: string;
}

/** Opens `offer` as a review on `runtime` once its editor exists and the file
 *  on disk still matches the turn. Returns a refusal or null once review is up. */
async function openDocumentRevision(
  runtime: DocumentRuntime,
  offer: ReviewOffer,
  sourceApi: DocumentSourcePort,
): Promise<TurnReviewFailure | null> {
  const editor = await waitForEditor(runtime);
  if (!editor) return 'not-opened';
  const scope = runtime.capture();
  let currentVersion: string;
  try {
    const source = await sourceApi.load(runtime.scope.source, runtime.signal);
    currentVersion = source.version;
  } catch {
    return 'not-verified';
  }
  let result: TurnReviewFailure | null = 'not-opened';
  const accepted = runtime.accept(scope, () => {
    if (currentVersion !== offer.baseVersion) {
      result = 'stale-version';
      return;
    }
    const current = splitLeadingYamlFrontmatter(
      runtime.store.getState().editor?.value ?? editor.value,
    );
    const proposed = splitLeadingYamlFrontmatter(offer.content);
    if (current.source !== proposed.source) {
      result = 'frontmatter-changed';
      return;
    }
    result = runtime.startRevision(
      {
        baseVersion: offer.baseVersion,
        id: offer.id,
        before: proposed.body,
      },
      current.body,
    );
  });
  return accepted ? result : 'not-opened';
}

/** Opens what Agent turn `turnId` changed in `runtime`'s document as a
 *  reversed review: the editor keeps the turn's text and the offer is the text
 *  from before it, so the version gate means the file has not changed since
 *  the turn ended. Answers why it could not be opened, or null once the review
 *  is up. */
export async function openTurnChangeReview(
  runtime: DocumentRuntime,
  turnId: string,
  ports: { source: DocumentSourcePort; turnChanges: DocumentTurnChangesPort },
): Promise<TurnChangeReviewFailure | null> {
  let change: DocumentTurnChange;
  try {
    change = await ports.turnChanges.load({ source: runtime.scope.source, turnId }, runtime.signal);
  } catch (error) {
    if (runtime.signal.aborted) return 'not-opened';
    return error instanceof DocumentTurnChangesError && error.kind === 'expired'
      ? 'expired'
      : 'not-verified';
  }
  return openDocumentRevision(
    runtime,
    {
      baseVersion: change.afterVersion,
      content: change.before,
      id: `turn:${turnId}:${change.source.path}`,
    },
    ports.source,
  );
}

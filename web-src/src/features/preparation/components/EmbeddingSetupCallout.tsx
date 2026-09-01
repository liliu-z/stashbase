/**
 * The standing embedding-authorization affordance, in the Files panel.
 *
 * This quiet line is the persistent explicit route after a local-only user
 * chooses Not now during first-folder Similarity Search setup. It keeps setup reachable
 * without exposing technical index terminology in the everyday workspace.
 *
 * It lives in the sidebar's bottom chrome, above the account row, because
 * authorization is app-wide. Inside the file tree it sat between a folder
 * header and that folder's own files, which read as a claim about those
 * files and pushed the tree down for a secondary notice.
 *
 * This line owns the "not set up" prompt outright: the account row below it
 * deliberately shows no index state and no sign-in call to action, so the
 * offer is made once per screen rather than twice in adjacent rows.
 *
 * No dismiss control: it is already one quiet line, it disappears the
 * moment embedding is authorized, and the dialog is the thing that can be
 * waved off. A dismiss here would only hide the calm route and leave the
 * interrupting one.
 */
import { Button } from '@/common/components/ui/button';
import { openEmbeddingSetup } from '@/common/lib/embeddingSetupTrigger';
import { isEmbeddingAuthorized } from '@/common/lib/embeddingAuth';
import { useEmbedderState } from '@/common/hooks/useEmbedderState';

export default function EmbeddingSetupCallout() {
  const { embedder } = useEmbedderState();

  if (isEmbeddingAuthorized(embedder)) return null;
  if (!embedder) return null;

  return (
    // Bottom chrome, not a card: no fill and no border. A tinted band at
    // row width reads as grime on the sidebar's already-sunken surface —
    // the same failure the app bans for selection and hover rows — and the
    // notice does not need a surface to be found, because it is one line
    // above the account row with the only accent in the strip sitting on it.
    // Padding matches the account row so the two share a left edge.
    // `flex-none` because the sidebar is a flex column: without it a tall
    // tree squeezes this to nothing.
    <div className="mx-1.5 mb-1 flex flex-none items-center gap-2 px-2 py-1 text-xs leading-snug text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">Similarity Search isn't set up</span>
      {/* `size="xs"` for the type step only — the band's own padding places
        * the control, so height and padding come back off. Accent rather
        * than the link variant's primary: this is the one accent in the
        * strip. */}
      <Button
        variant="link"
        size="xs"
        className="h-auto flex-none cursor-pointer border-0 p-0 font-semibold text-accent underline underline-offset-2"
        onClick={() => openEmbeddingSetup()}
      >Set up</Button>
    </div>
  );
}

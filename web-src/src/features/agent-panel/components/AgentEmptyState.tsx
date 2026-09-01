/**
 * Empty-chat hero pieces. While a chat has no turns, AgentView centers the
 * composer in the panel: a title (plus a connecting status when applicable)
 * sits above it. A folder-scoped chat puts the fixed Build Wiki action
 * directly below the composer.
 */
import { Button } from '@/common/components/ui/button';
import { SectionHeading } from '@/common/components/ui/section';
import { spinnerClass } from '@/features/agent-panel/lib/panelStyles';

/** The primary first action for a folder. It sends immediately because it is
 * a complete product action rather than a prompt template that needs editing.
 *
 * So it wears the app's primary action, unmodified: a solid accent
 * `Button`, the same one the zero-folder sidebar and the empty main pane
 * put under their own one-line invitations. The capsule is the only thing
 * it adds, and it is semantic (see renderer-styling's corner rules) — this
 * is the fixed folder activation path, not an ordinary button drawn as a
 * pill. The tinted-outline treatment it replaces stacked a pale fill, a
 * pale stroke, and pale text: three washes of one hue that together read
 * as a status badge rather than as the thing to press.
 *
 * No leading glyph. The panel's other two hero actions carry none, and the
 * bolt this used to wear is the Auto permission mode's mark two rows
 * below — one glyph cannot mean both. */
export function BuildWikiPagesAction({
  pending,
  onBuild,
  onCancel,
}: {
  pending: boolean;
  onBuild: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 pt-4 text-center">
      <Button className="rounded-full px-4" disabled={pending} onClick={onBuild}>
        {pending ? 'Building Wiki…' : 'Build Wiki'}
      </Button>
      {pending && (
        // The waiting state's motion lives HERE rather than inside the
        // disabled button: the panel's one connecting arc is an accent
        // stroke, which is invisible on an accent fill, and a dimmed
        // button is the wrong place to look for progress anyway.
        <p className="m-0 flex max-w-measure-sm items-center gap-1.5 text-xs leading-snug text-muted-foreground" role="status">
          <span className={spinnerClass} aria-hidden="true" />
          Waiting for Agent setup. <Button type="button" variant="link" size="xs" className="h-auto border-0 p-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={onCancel}>Cancel</Button>
        </p>
      )}
    </div>
  );
}

/** Title + status slot above the centered composer. The title names the
 * space's promise; runtime identity still lives in the tab icon and the
 * composer's "Message <Agent>…" placeholder, and the scope pill carries
 * the scope — no wordmark or agent branding here. While a session
 * connects, a spinner row shows between the title and the composer. */
export function EmptyChatGreeting({ agentShortName, connecting }: {
  agentShortName: string;
  connecting: boolean;
}) {
  return (
    <>
      {/* Level 2, stated: pane-level surfaces top the chat pane's outline
        * at h2 (see the scheme note on RuntimeCard). */}
      <SectionHeading level={2} className="pb-6 text-center text-2xl">
        Your Wiki is here.
      </SectionHeading>
      {connecting && (
        <p className="m-0 flex items-center justify-center gap-2 pb-4 text-sm text-muted-foreground" role="status">
          <span className={spinnerClass} aria-hidden="true" />
          Connecting to {agentShortName}…
        </p>
      )}
    </>
  );
}

/**
 * Empty-chat hero pieces. While a chat has no turns, AgentView centers the
 * composer in the panel: a title (plus a connecting status when applicable)
 * sits above it.
 */
import { SectionHeading } from '@/common/components/ui/section';
import { spinnerClass } from '@/features/agent-panel/lib/panelStyles';

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

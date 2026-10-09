/**
 * The one moment a chat mentions a runtime update on its own.
 *
 * A runtime knows which models its account may use and which of them its own
 * build is too old to run; the service passes that answer through, and this
 * card is where a reader hears it, beside the composer where a model is
 * chosen. The sentence is the runtime's own, so the card never claims a
 * version requirement StashBase worked out for itself.
 *
 * It offers the update and nothing else. Dismissal lasts as long as the
 * window, because this is news rather than a setting: a reader who says not
 * now is not asked again this session, and a reader who updates sees the
 * offer withdrawn the moment the catalog is read again.
 */
import { X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import type { AgentUpgradeOffer } from '@/features/agent/domain/agent-catalog';
import type { AgentRuntimeUpdateView } from '@/features/agent/hooks/use-agent-runtime-update';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';

export function AgentUpgradeOfferCard({
  offer,
  runtimeUpdate,
}: {
  offer: AgentUpgradeOffer;
  runtimeUpdate: AgentRuntimeUpdateView;
}) {
  const shape = useShape();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || runtimeUpdate.completed) return null;
  return (
    <div className="mx-auto w-full max-w-[46rem] shrink-0 px-5 pb-2 max-sm:px-4">
      <section
        className={cn('flex items-center gap-3 border border-border bg-surface-2 p-3', shape.panel)}
      >
        <div className="min-w-0 flex-1">
          <p className="text-caption text-foreground">{offer.note}</p>
          <p className="mt-0.5 text-caption text-muted-foreground">
            StashBase installs the latest {runtimeUpdate.label} and reconnects this chat. Your
            conversation and existing installations are kept.
          </p>
          {runtimeUpdate.failure && (
            <p
              className="mt-1 text-caption wrap-anywhere whitespace-pre-wrap text-muted-foreground"
              role="alert"
            >
              {runtimeUpdate.failure}
            </p>
          )}
        </div>
        <Button
          disabled={runtimeUpdate.busy}
          loading={runtimeUpdate.busy}
          onClick={() => runtimeUpdate.update()}
          size="compact"
          variant="secondary"
        >
          {runtimeUpdate.busy
            ? `Updating ${runtimeUpdate.label}…`
            : `Update ${runtimeUpdate.label}`}
        </Button>
        <Button
          aria-label="Dismiss"
          disabled={runtimeUpdate.busy}
          onClick={() => setDismissed(true)}
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      </section>
    </div>
  );
}

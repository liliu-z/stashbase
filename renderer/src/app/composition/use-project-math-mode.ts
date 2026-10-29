/**
 * The open project's math mode, held for every surface that renders a formula.
 *
 * The server keeps the record, so a window reads it once per project and the
 * next window on the same folder reads it again after a restart. The read is
 * deliberately quiet: an unreadable record means dollars stay text, which is
 * the same thing the default says, and only a refused *write* is worth the
 * reader's attention — the switch rolls back and names it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { settingsFailure, type MathModePort } from '@/features/settings/public';
import type { FailureView } from '@/shared/domain/feature-error';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';
import type { MathModeState } from '@/shared/ui/math-mode';

export function useProjectMathMode(port: MathModePort, scope: string | null): MathModeState {
  const signalFor = useRequestSignals<'math-mode' | 'math-mode-save'>();
  const [stored, setStored] = useState<{ scope: string; enabled: boolean } | null>(null);
  const [failure, setFailure] = useState<FailureView | null>(null);
  // A rollback writes back the state the server last agreed to, so a refusal
  // after two quick clicks cannot invent a state nobody asked for.
  const applied = useRef<{ scope: string; enabled: boolean } | null>(null);

  useEffect(() => {
    if (!scope) {
      setStored(null);
      applied.current = null;
      return;
    }
    let settled = false;
    void port
      .load(scope, signalFor('math-mode'))
      .then((enabled) => {
        if (settled) return;
        setStored({ scope, enabled });
        applied.current = { scope, enabled };
      })
      // The default (dollars are text) is what an unreadable record means
      // anyway, and Settings reports the server. // swallowed: safe to drop.
      .catch(() => undefined);
    return () => {
      settled = true;
    };
  }, [port, scope, signalFor]);

  const setEnabled = useCallback(
    (next: boolean) => {
      if (!scope) return;
      setFailure(null);
      // Optimistic: both surfaces change with the click, before the write lands.
      setStored({ scope, enabled: next });
      void port
        .save(scope, next, signalFor('math-mode-save'))
        .then((enabled) => {
          const kept = { scope, enabled };
          applied.current = kept;
          setStored(kept);
        })
        .catch((error: unknown) => {
          setStored(applied.current);
          setFailure(settingsFailure(error));
        });
    },
    [port, scope, signalFor],
  );

  return useMemo<MathModeState>(
    () => ({
      enabled: stored?.scope === scope ? stored.enabled : false,
      failure,
      scope,
      setEnabled,
    }),
    [failure, scope, setEnabled, stored],
  );
}

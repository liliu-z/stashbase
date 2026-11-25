/**
 * The pages of one HTML preview. A newer version loads behind the page on
 * screen and replaces it once ready, so a reload never blanks the view; the
 * page it replaced stays beneath until the fade ends. The status spins from
 * the moment a newer version is found and turns into a check as the new page
 * appears, so the reader sees the two happen together.
 */
import { useCallback, useEffect, useState } from 'react';

export type PreviewStatus = 'updated' | 'updating';

export interface PreviewLayer {
  generation: string;
  id: number;
  /** The page has loaded and can be shown. */
  ready: boolean;
  /** Loaded after the first page, so its arrival is news. */
  replacement: boolean;
  /** The status has spun long enough to be read as work. */
  spun: boolean;
  state: 'loading' | 'retiring' | 'shown';
  url: string;
}

/** About half a turn, so even a quick reload reads as work that finished. */
const SPIN_MS = 600;
/** How long "Page updated" stays once the reader can see it: long enough to
 *  be seen by a reader who was looking at the chat when the page changed. */
const UPDATED_MS = 5_000;
/** Outlasts the replacement's fade before the page beneath is removed. */
const RETIRE_MS = 400;

let nextLayer = 0;

/** Shows a loading page once it is both ready and has spun. */
function settle(layers: PreviewLayer[], id: number, done: 'ready' | 'spun'): PreviewLayer[] {
  const target = layers.find((layer) => layer.id === id && layer.state === 'loading');
  if (!target) return layers;
  const next = { ...target, [done]: true };
  if (!next.ready || !next.spun) return layers.map((layer) => (layer === target ? next : layer));
  return layers.map((layer) => {
    if (layer === target) return { ...next, state: 'shown' };
    return layer.state === 'shown' ? { ...layer, state: 'retiring' } : layer;
  });
}

/** The layers and the generation they were built for. They are one state so
 *  that React can never keep one without the other: a render-phase update that
 *  React later discards (it does when a lower-priority update to the same
 *  state was skipped in that render) is then derived again on the next
 *  render, instead of leaving a newer version recorded but never loaded. */
interface PreviewLayersState {
  layers: PreviewLayer[];
  requested: string;
}

function request(state: PreviewLayersState, generation: string, url: string): PreviewLayersState {
  if (state.requested === generation) return state;
  // A newer version supersedes one still loading; returning to the page on
  // screen needs no load at all.
  const settled = state.layers.filter((layer) => layer.state !== 'loading');
  if (settled.at(-1)?.generation === generation) return { layers: settled, requested: generation };
  return {
    layers: [
      ...settled,
      {
        generation,
        id: ++nextLayer,
        ready: false,
        replacement: true,
        spun: false,
        state: 'loading',
        url,
      },
    ],
    requested: generation,
  };
}

export function usePreviewLayers(generation: string, url: string, active: boolean) {
  const [{ layers, requested }, setState] = useState<PreviewLayersState>(() => ({
    layers: [
      {
        generation,
        id: ++nextLayer,
        ready: true,
        replacement: false,
        spun: true,
        state: 'shown',
        url,
      },
    ],
    requested: generation,
  }));
  if (requested !== generation) setState((current) => request(current, generation, url));

  const setLayers = useCallback((update: (layers: PreviewLayer[]) => PreviewLayer[]) => {
    setState((current) => {
      const next = update(current.layers);
      return next === current.layers ? current : { ...current, layers: next };
    });
  }, []);

  const reveal = useCallback(
    (id: number) => {
      setLayers((current) => settle(current, id, 'ready'));
    },
    [setLayers],
  );

  const loading = layers.find((layer) => layer.state === 'loading')?.id;
  useEffect(() => {
    if (loading === undefined) return;
    const timer = setTimeout(
      () => setLayers((current) => settle(current, loading, 'spun')),
      SPIN_MS,
    );
    return () => clearTimeout(timer);
  }, [loading, setLayers]);

  const retiring = layers.some((layer) => layer.state === 'retiring');
  useEffect(() => {
    if (!retiring) return;
    const timer = setTimeout(
      () => setLayers((current) => current.filter((layer) => layer.state !== 'retiring')),
      RETIRE_MS,
    );
    return () => clearTimeout(timer);
  }, [retiring, setLayers]);

  // A replacement that lands while the document is covered is reported when
  // the reader returns to it.
  const shown = layers.find((layer) => layer.state === 'shown');
  const [acknowledged, setAcknowledged] = useState<number | null>(null);
  const updated = shown?.replacement === true && acknowledged !== shown.id;
  const shownId = shown?.id;
  useEffect(() => {
    if (!updated || !active || shownId === undefined) return;
    const timer = setTimeout(() => setAcknowledged(shownId), UPDATED_MS);
    return () => clearTimeout(timer);
  }, [active, shownId, updated]);

  let status: PreviewStatus | null = null;
  if (loading !== undefined) status = 'updating';
  else if (updated) status = 'updated';
  return { layers, reveal, replacing: loading !== undefined, status: active ? status : null };
}

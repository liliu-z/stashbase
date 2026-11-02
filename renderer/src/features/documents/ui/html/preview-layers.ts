/**
 * The pages of one HTML preview. A newer version loads behind the page on
 * screen and replaces it once ready, so a reload never blanks the view; the
 * page it replaced stays beneath until the fade ends.
 */
import { useCallback, useEffect, useState } from 'react';

export type PreviewStatus = 'updated' | 'updating';

export interface PreviewLayer {
  generation: string;
  id: number;
  /** Loaded after the first page, so its arrival is news. */
  replacement: boolean;
  state: 'loading' | 'retiring' | 'shown';
  url: string;
}

/** A quick reload shows no wait at all. */
const SLOW_MS = 400;
/** How long "Updated" stays once the reader can see it: long enough to be
 *  seen by a reader who was looking at the chat when the page changed. */
const UPDATED_MS = 5_000;
/** Outlasts the replacement's fade before the page beneath is removed. */
const RETIRE_MS = 400;

let nextLayer = 0;

export function usePreviewLayers(generation: string, url: string, active: boolean) {
  const [layers, setLayers] = useState<PreviewLayer[]>(() => [
    { generation, id: ++nextLayer, replacement: false, state: 'shown', url },
  ]);
  const [requested, setRequested] = useState(generation);
  if (requested !== generation) {
    setRequested(generation);
    setLayers((current) => {
      // A newer version supersedes one still loading; returning to the page
      // on screen needs no load at all.
      const settled = current.filter((layer) => layer.state !== 'loading');
      if (settled.at(-1)?.generation === generation) return settled;
      return [
        ...settled,
        { generation, id: ++nextLayer, replacement: true, state: 'loading', url },
      ];
    });
  }

  const reveal = useCallback((id: number) => {
    setLayers((current) => {
      if (!current.some((layer) => layer.id === id && layer.state === 'loading')) return current;
      return current.map((layer) => {
        if (layer.id === id) return { ...layer, state: 'shown' };
        return layer.state === 'shown' ? { ...layer, state: 'retiring' } : layer;
      });
    });
  }, []);

  const retiring = layers.some((layer) => layer.state === 'retiring');
  useEffect(() => {
    if (!retiring) return;
    const timer = setTimeout(
      () => setLayers((current) => current.filter((layer) => layer.state !== 'retiring')),
      RETIRE_MS,
    );
    return () => clearTimeout(timer);
  }, [retiring]);

  const loading = layers.find((layer) => layer.state === 'loading')?.id;
  const [slowLayer, setSlowLayer] = useState<number | null>(null);
  useEffect(() => {
    if (loading === undefined) return;
    const timer = setTimeout(() => setSlowLayer(loading), SLOW_MS);
    return () => clearTimeout(timer);
  }, [loading]);

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
  if (loading !== undefined && slowLayer === loading) status = 'updating';
  else if (updated) status = 'updated';
  return { layers, reveal, replacing: loading !== undefined, status: active ? status : null };
}

/** Route links from the retained editor through the current document scope. */
import { useEffect, useRef, useState, type RefObject } from 'react';

import { resolveDocumentLink } from '@/features/documents/domain/link-target';
import type { SourceReference } from '@/shared/domain/source-reference';

export function useDocumentLinks(
  hostRef: RefObject<HTMLElement | null>,
  source: SourceReference,
  onNavigate: (target: { anchor?: string | undefined; source: SourceReference }) => void,
  onOpenExternal: (href: string) => Promise<boolean>,
) {
  const current = useRef({ source, onNavigate, onOpenExternal });
  current.current = { source, onNavigate, onOpenExternal };
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const routeLink = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a');
      if (!anchor) return;
      event.preventDefault();
      const callbacks = current.current;
      const target = resolveDocumentLink(anchor.getAttribute('href') ?? '', callbacks.source);
      if (target.kind === 'anchor') {
        callbacks.onNavigate({ anchor: target.id, source: callbacks.source });
      } else if (target.kind === 'source') {
        callbacks.onNavigate({ anchor: target.anchor, source: target.source });
      } else if (target.kind === 'external') {
        setFailed(false);
        void callbacks
          .onOpenExternal(target.href)
          .then((opened) => setFailed(!opened))
          .catch(() => setFailed(true));
      }
    };
    host.addEventListener('click', routeLink);
    return () => host.removeEventListener('click', routeLink);
  }, [hostRef]);
  return { failed, dismiss: () => setFailed(false) };
}

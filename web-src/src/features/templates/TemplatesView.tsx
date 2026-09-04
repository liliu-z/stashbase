import { useEffect, useState } from 'react';
import { GALLERY_SNAPSHOT, loadGalleryWikis, type GalleryWiki } from '@/features/templates/gallery';
import { GalleryDetailOverlay } from '@/features/templates/detail/GalleryDetailOverlay';
import './templates.css';

/**
 * The Gallery — the scrollable band below a blank Chat's hero composer.
 * AgentView renders it for a tab carrying the gallery request (a bare
 * window's boot chat, or the sidebar's Gallery row); a started
 * conversation replaces it with the transcript.
 *
 * Every entry is a ready-made Wiki living in a public GitHub repository
 * (see `gallery.ts` — the index itself is a GitHub-hosted file, this
 * band renders the bundled snapshot immediately and swaps in the
 * fetched copy). A card opens the entry's detail overlay, where the one
 * big action downloads the whole folder through the existing public-
 * GitHub import and opens it in a new window. No open folder is
 * required to browse or download; "bring your own" stays with the
 * sidebar's Choose Folder row, never a precondition here.
 *
 * Part of the chat pane, not a tab or a modal, and deliberately drawn
 * in the MARKETING SITE's print language — hairline-grid cells, mono
 * ticks, corner-tick frames, square corners — because the same gallery
 * ships on the site (stashbase-web home-page.css is the reference).
 * Everything is spelled through the semantic tokens, so the idiom holds
 * in dark. Default export for the lazy chunk (AgentView loads it
 * through the `features/templates` barrel inside its own Suspense
 * boundary).
 */

export default function TemplatesView({ heading = 'Explore Gallery' }: { heading?: string } = {}) {
  // Snapshot first, published index when the fetch lands: the band is
  // never empty and never waits on the network to render.
  const [wikis, setWikis] = useState<readonly GalleryWiki[]>(GALLERY_SNAPSHOT);
  // The card's click target opens this entry's detail overlay.
  const [detailWiki, setDetailWiki] = useState<GalleryWiki | null>(null);

  useEffect(() => {
    let stale = false;
    void loadGalleryWikis().then((loaded) => {
      if (!stale) setWikis(loaded);
    });
    return () => { stale = true; };
  }, []);

  return (
    /* Full-width host = the container that the queries in templates.css
     * answer; the column inside is the site's page measure with a
     * breathing gutter. The HOST owns scrolling: in the chat pane this
     * is the content of the band under the composer. */
    <div className="templates-page">
      <div className="templates-column mx-auto w-measure-xl py-10">
        {/* One display-size title + one small grey sub-line, in the
          * app's own heading voice. An h2, stated: pane-level surfaces
          * top the chat pane's outline at h2 (the greeting holds the
          * same level above); the display size is presentation, not
          * outline rank. */}
        {/* "Explore Gallery" on the landing band (an invitation), plain
          * "Gallery" when the overlay hosts this view (a place the user
          * already chose to enter — places take noun titles). */}
        <h2 className="m-0 text-5xl font-normal tracking-tight text-foreground">
          {heading}
        </h2>
        {/* One grey body size page-wide: this sub-line and the card
          * descriptions both sit on text-base. One standing line in
          * both folder states, speaking the GALLERY model: what an
          * entry is (a real folder and its wiki) and how to take one. */}
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
          <p className="m-0 text-base text-muted-foreground">
            Every entry is a real folder with a wiki built from it.
            Make a copy to explore it, or copy the prompt for your own folder.
          </p>
        </div>

        {/* Standalone rounded media cards with real gaps: a FIXED 16:9
          * cover on top — the screenshot is why a person picks an
          * entry, so it stays a complete untreated picture (overflow
          * crops) — and the caption on the card's own paper below.
          * Text never sits on the image: a wiki's cover is a document
          * screenshot, mostly white, and any overlay either fogs it
          * (dark scrim) or hides it (caption block). Columns still
          * come from the container queries on .templates-grid. */}
        <ul className="templates-grid mt-8 grid list-none gap-5 p-0">
          {wikis.map((wiki) => {
            const cover = wiki.screenshots?.[0];
            return (
              <li key={wiki.id} className="flex min-w-0">
                <button
                  type="button"
                  onClick={() => setDetailWiki(wiki)}
                  className="group/card relative m-0 flex min-w-0 flex-1 cursor-pointer flex-col overflow-hidden rounded-2xl border border-border bg-card p-0 text-left font-sans shadow-low outline-none transition-control focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.99]"
                >
                  {/* Fixed 16:9 cover; a gentle zoom is the hover
                    * affordance. `object-top` because a wiki screenshot
                    * leads with its own title banner — the crop keeps
                    * that and drops the tail. The hairline below is
                    * load-bearing: a mostly white screenshot on the
                    * card's white caption would otherwise read as one
                    * unbounded blob. */}
                  <span aria-hidden className="relative block aspect-video w-full flex-none overflow-hidden border-b border-border">
                    {cover ? (
                      <img
                        src={cover}
                        alt=""
                        className="absolute inset-0 size-full object-cover object-top transition-transform duration-standard group-hover/card:scale-[1.03]"
                      />
                    ) : (
                      <span className="template-visual-card absolute inset-0" />
                    )}
                  </span>
                  {/* Caption on the card's own paper — no eyebrow;
                    * title leads (it is also the button's accessible
                    * name), one short description under it, and the
                    * category as a quiet mono small-caps label pinned
                    * to the foot. The caption is a flex column and the
                    * card a stretching flex item, so labels in one grid
                    * row bottom-align without reserving a dead line
                    * under short descriptions. Not a capsule: the
                    * capsule budget is for identity/status/terminal
                    * actions, and a passive category marker is the
                    * site's mono-tick voice. One ink treatment whether
                    * or not a cover exists. */}
                  <span className="flex flex-1 flex-col p-5">
                    <span className="block truncate text-lg leading-tight font-medium tracking-tight text-foreground">
                      {wiki.name}
                    </span>
                    {/* A fixed two-line window: short copy leaves air,
                      * long copy ellipsizes — every card holds one
                      * geometry. min-h = 2 lines at leading-relaxed. */}
                    <span className="mt-1.5 line-clamp-2 block min-h-[3.25em] text-base leading-relaxed text-muted-foreground">
                      {wiki.description}
                    </span>
                    <span className="mt-auto block pt-3 font-mono text-2xs tracking-wider text-muted-foreground uppercase">
                      {wiki.category}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <GalleryDetailOverlay wiki={detailWiki} onClose={() => setDetailWiki(null)} />
    </div>
  );
}

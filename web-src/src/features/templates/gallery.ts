/** The Gallery index — ready-made Wikis the user can download and open.
 *
 * The backend is a public GitHub repository
 * (`0-bingwu-0/stashbase-gallery`): its `gallery.json` is the entire
 * service contract, and the app reads it through jsDelivr's CDN
 * (raw.githubusercontent.com is unreachable for a large share of
 * users). The app also ships a bundled snapshot of the same index and
 * shows it immediately; the fetched copy replaces it when the network
 * cooperates. A shop window prefers a slightly stale list over a
 * spinner, and a bundled list over an empty state.
 *
 * Index fields are additive-only — consumers ignore fields they do not
 * recognize — and `schemaVersion` gates breaking shape changes: an
 * index this parser does not understand is treated as unreachable
 * rather than half-read.
 */

export interface GalleryWiki {
  /** Stable slug, never reused. */
  id: string;
  name: string;
  /** One word: `course`, `research`, `reference`, … */
  category: string;
  /** One sentence — source, then what's inside. */
  description: string;
  /** Short inventory line — the detail page's What's inside stand-in
   *  until the entry publishes its `files` list. */
  contents: string;
  /** Public repository where the whole Wiki lives in the files. */
  repo: string;
  /** Optional deep-dive page. Index data the app does not render yet
   *  (the site does); carried so published entries round-trip whole. */
  learnMore?: string;
  /** Questions worth asking the moment the folder is open. Not surfaced
   *  in the app yet — published for the site and a future chat handoff. */
  starterPrompts: readonly string[];
  /** Folder-relative paths of the copy's visible files — the detail
   *  page's What's inside tree. Dot-entries stay out, matching what the
   *  app's own tree would show. Absent until the entry publishes it. */
  files?: readonly string[];
  /** The Build Wiki request that produced this wiki — the detail page's
   *  How it's built tab. Absent until the entry publishes it. */
  wikiPrompt?: string;
  /** Absolute URLs of curated screenshots, gallery order, first one the
   *  hero. Pin image URLs to a commit (`@<sha>`) so replacing a shot
   *  busts the CDN cache. Absent until the entry publishes them. */
  screenshots?: readonly string[];
}

/** The renderer's CSP pins connect-src and img-src to 'self', so the
 *  index and every screenshot arrive through the local daemon's gallery
 *  proxy (`server/routes/gallery.ts` owns the upstream CDN URLs). */
export const GALLERY_INDEX_URL = '/api/gallery/index';

const SUPPORTED_SCHEMA_VERSION = 1;

/** The bundled snapshot of the published index. Refresh it when the
 *  gallery repository changes in a way the app should ship with; the
 *  runtime fetch covers everything between releases. */
export const GALLERY_SNAPSHOT: readonly GalleryWiki[] = [
  {
    id: 'how-to-start-a-startup',
    name: 'How to Start a Startup',
    category: 'course',
    description: "Sam Altman's Stanford CS183B course with YC.",
    contents: '20 lecture transcripts · distilled founder playbook · STASHBASE.md maintenance rules',
    repo: 'https://github.com/0-bingwu-0/stashbase-cs183b',
    learnMore: 'https://stashbase.ai/examples/cs183b/',
    starterPrompts: [
      'How do I find a startup idea?',
      'How do I know if I have product-market fit?',
      'Should I worry about competitors and being copied?',
    ],
    files: [
      'README.md',
      'STASHBASE.md',
      'founder_playbook.html',
      'transcripts/Lecture01-HowToStart.md',
      'transcripts/Lecture02-TeamExecution.md',
      'transcripts/Lecture03-BeforeStartup.md',
      'transcripts/Lecture04-BuildTalkGrow.md',
      'transcripts/Lecture05-BusinessMonopoly.md',
      'transcripts/Lecture06-Growth.md',
      'transcripts/Lecture07-ProductsUsersLove.md',
      'transcripts/Lecture08-DontScalePR.md',
      'transcripts/Lecture09-RaiseMoney.md',
      'transcripts/Lecture10-CultureTeamI.md',
      'transcripts/Lecture11-CultureTeamII.md',
      'transcripts/Lecture12-Enterprise.md',
      'transcripts/Lecture13-GreatFounder.md',
      'transcripts/Lecture14-Operate.md',
      'transcripts/Lecture15-Manage.md',
      'transcripts/Lecture16-UserInterview.md',
      'transcripts/Lecture17-Hardware.md',
      'transcripts/Lecture18-LegalAccounting.md',
      'transcripts/Lecture19-SalesMarketing.md',
      'transcripts/Lecture20-LaterStageAdvice.md',
    ],
    wikiPrompt:
      'Build or update Wiki Pages from these lecture transcripts: one page per lecture with its key ideas, and a founder playbook that connects them.',
  },
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Published screenshot URLs are absolute CDN links; the renderer can
 *  only load them through the daemon's image proxy. Anything already
 *  relative (tests, future local assets) passes through untouched. */
function proxiedImageUrl(url: string): string {
  return /^https?:\/\//i.test(url)
    ? `/api/gallery/image?src=${encodeURIComponent(url)}`
    : url;
}

function parseWiki(value: unknown): GalleryWiki | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    !isNonEmptyString(entry.id)
    || !isNonEmptyString(entry.name)
    || !isNonEmptyString(entry.category)
    || !isNonEmptyString(entry.description)
    || !isNonEmptyString(entry.contents)
    || !isNonEmptyString(entry.repo)
  ) return null;
  const prompts = Array.isArray(entry.starterPrompts)
    ? entry.starterPrompts.filter(isNonEmptyString)
    : [];
  const files = Array.isArray(entry.files)
    ? entry.files.filter(isNonEmptyString)
    : null;
  const screenshots = Array.isArray(entry.screenshots)
    ? entry.screenshots.filter(isNonEmptyString).map(proxiedImageUrl)
    : null;
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    description: entry.description,
    contents: entry.contents,
    repo: entry.repo,
    ...(isNonEmptyString(entry.learnMore) ? { learnMore: entry.learnMore } : {}),
    starterPrompts: prompts,
    ...(files && files.length ? { files } : {}),
    ...(isNonEmptyString(entry.wikiPrompt) ? { wikiPrompt: entry.wikiPrompt } : {}),
    ...(screenshots && screenshots.length ? { screenshots } : {}),
  };
}

/** The published index, validated. `null` when the payload is not an
 *  index this build understands — a malformed or future-schema payload
 *  must fall back whole, never render half. Exported for tests. */
export function parseGalleryIndex(data: unknown): GalleryWiki[] | null {
  if (typeof data !== 'object' || data === null) return null;
  const index = data as Record<string, unknown>;
  if (index.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return null;
  if (!Array.isArray(index.wikis)) return null;
  const wikis: GalleryWiki[] = [];
  for (const raw of index.wikis) {
    const wiki = parseWiki(raw);
    if (!wiki) return null;
    wikis.push(wiki);
  }
  return wikis;
}

/** The published index wins whole, but a build often knows MORE about
 *  an entry than the published index does yet (the app ships fields
 *  ahead of their publication). Same-id snapshot entries fill in the
 *  optional fields the published entry has not published; published
 *  values always win where present. */
function enrichedFromSnapshot(wiki: GalleryWiki): GalleryWiki {
  const bundled = GALLERY_SNAPSHOT.find((entry) => entry.id === wiki.id);
  if (!bundled) return wiki;
  return {
    ...wiki,
    ...(!wiki.files && bundled.files ? { files: bundled.files } : {}),
    ...(!wiki.wikiPrompt && bundled.wikiPrompt ? { wikiPrompt: bundled.wikiPrompt } : {}),
    ...(!wiki.screenshots && bundled.screenshots ? { screenshots: bundled.screenshots } : {}),
  };
}

let fetchedIndex: readonly GalleryWiki[] | null = null;

/** The freshest index this session can offer: the published one when it
 *  can be fetched and understood, the bundled snapshot otherwise. One
 *  fetch per session — the gallery is browsed, not watched. */
export async function loadGalleryWikis(
  fetchImpl: typeof fetch = fetch,
): Promise<readonly GalleryWiki[]> {
  if (fetchedIndex) return fetchedIndex;
  try {
    const response = await fetchImpl(GALLERY_INDEX_URL, {
      signal: AbortSignal.timeout(6000),
    });
    if (response.ok) {
      const parsed = parseGalleryIndex(await response.json());
      if (parsed) {
        fetchedIndex = parsed.map(enrichedFromSnapshot);
        return fetchedIndex;
      }
    }
  } catch {
    // Offline, blocked, or timed out — the snapshot below answers.
  }
  return GALLERY_SNAPSHOT;
}

/** Test seam: forget the session cache. */
export function resetGalleryCacheForTests(): void {
  fetchedIndex = null;
}

/** File-type categories the search surfaces can filter by. Shared
 *  vocabulary between the renderer (chips) and the server (extension
 *  mapping); the category → extension mapping itself stays in
 *  `server/format.ts` next to the other extension knowledge. */
export const SEARCH_TYPE_CATEGORIES = ['notes', 'pdf', 'image', 'docx', 'audio'] as const;

export type SearchTypeCategory = (typeof SEARCH_TYPE_CATEGORIES)[number];

export function isSearchTypeCategory(value: unknown): value is SearchTypeCategory {
  return typeof value === 'string' && (SEARCH_TYPE_CATEGORIES as readonly string[]).includes(value);
}

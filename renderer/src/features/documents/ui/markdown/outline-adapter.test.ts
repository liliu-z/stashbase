import { describe, expect, it } from 'vite-plus/test';

import type { DocumentHeading } from '@/features/documents/domain/outline';

import { activeHeadingAt } from './outline-adapter';

const headings: DocumentHeading[] = Array.from({ length: 9 }, (_, index) => ({
  id: `h${index}`,
  level: 2,
  position: index,
  text: `Heading ${index}`,
}));
const topOf = (heading: DocumentHeading) => heading.position * 100;

describe('activeHeadingAt', () => {
  it('picks the last heading at or above the threshold', () => {
    expect(activeHeadingAt(headings, topOf, 450)).toBe('h4');
    expect(activeHeadingAt(headings, topOf, 400)).toBe('h4');
    expect(activeHeadingAt(headings, topOf, 10_000)).toBe('h8');
  });

  it('falls back to the first heading above the first one, and to null with none', () => {
    expect(activeHeadingAt(headings, topOf, -1)).toBe('h0');
    expect(activeHeadingAt([], topOf, 0)).toBeNull();
  });

  it('skips headings without a rendered element', () => {
    const rendered = (hidden: ReadonlySet<string>) => (heading: DocumentHeading) =>
      hidden.has(heading.id) ? undefined : topOf(heading);
    expect(activeHeadingAt(headings, rendered(new Set(['h4'])), 650)).toBe('h6');
    expect(activeHeadingAt(headings, rendered(new Set(['h4', 'h5'])), 450)).toBe('h3');
    expect(activeHeadingAt(headings, rendered(new Set(['h8'])), 10_000)).toBe('h7');
  });

  it('reads a handful of rects, not every heading', () => {
    let reads = 0;
    activeHeadingAt(headings, (heading) => (reads++, topOf(heading)), 450);
    expect(reads).toBeLessThanOrEqual(4);
  });
});

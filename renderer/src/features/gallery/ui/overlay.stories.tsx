import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import type { GalleryEntry } from '@/features/gallery/domain/entry';

import { GalleryOverlay } from './overlay';

const ENTRIES: GalleryEntry[] = [
  {
    about:
      'A founder playbook built from twenty lecture transcripts. Read the course as a whole and connect the ideas across lectures.\n\n1. Set up: say "Set me up." and tell it which lectures you care about.\n\n2. Read: open the index and follow a theme across lectures.\n\n3. Ask: ask a question and get an answer from the lectures, with sources.\n\nA dashboard shows which lectures you have read and the themes they share.',
    category: 'course',
    description: "Sam Altman's Stanford CS183B course with YC.",
    id: 'cs183b',
    name: 'How to Start a Startup',
    repo: 'https://github.com/owner/cs183b',
    screenshot:
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="%236B97FF"/></svg>',
  },
  {
    about: null,
    category: 'reference',
    description: 'A working reference for typographic detail.',
    id: 'type-reference',
    name: 'Type Reference',
    repo: 'https://github.com/owner/type-reference',
    screenshot: null,
  },
];

function ShopPreview({
  opened = false,
  unpublished = false,
}: {
  opened?: boolean;
  unpublished?: boolean;
}) {
  const first = unpublished ? (ENTRIES[1] ?? null) : (ENTRIES[0] ?? null);
  const [entry, setEntry] = useState<GalleryEntry | null>(opened ? first : null);
  return (
    <GalleryOverlay
      copying={false}
      entries={ENTRIES}
      entry={entry}
      onBack={() => {
        setEntry(null);
      }}
      onClose={() => undefined}
      onCopy={() => undefined}
      onOpen={setEntry}
      open
    />
  );
}

const meta = {
  component: ShopPreview,
  parameters: { controls: { disable: true }, fluidCanvas: { minHeight: '52rem', width: '84rem' } },
  title: 'Gallery/Shop',
} satisfies Meta<typeof ShopPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The shelf: every card one target, opening one entry. */
export const Shelf: Story = {};

/** One entry's page, read top to bottom: the screenshot leads, then what it
 *  is, the introduction, then the one action, with the prompt
 *  folded beneath the introduction. */
export const EntryPage: Story = { args: { opened: true } };

/** The same page for an entry that has published no introduction,
 *  a cover. Every slot states itself; none reshapes the page. This is
 *  also what the shop looks like offline. */
export const UnpublishedEntry: Story = { args: { opened: true, unpublished: true } };

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import type { GalleryEntry } from '@/features/gallery/domain/entry';
import type { GalleryPersona } from '@/features/gallery/domain/persona';
import { GALLERY_PERSONA_SNAPSHOT } from '@/features/gallery/domain/persona-snapshot';

import { GalleryOverlay, type GallerySection } from './overlay';

const ENTRIES: GalleryEntry[] = [
  {
    about:
      'A founder playbook built from twenty lecture transcripts. Read the course as a whole and connect the ideas across lectures.',
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
  startOn = 'projects',
  unpublished = false,
}: {
  opened?: boolean;
  startOn?: GallerySection;
  unpublished?: boolean;
}) {
  const first = unpublished ? (ENTRIES[1] ?? null) : (ENTRIES[0] ?? null);
  const [entry, setEntry] = useState<GalleryEntry | null>(
    opened && startOn === 'projects' ? first : null,
  );
  const [persona, setPersona] = useState<GalleryPersona | null>(
    opened && startOn === 'personas' ? (GALLERY_PERSONA_SNAPSHOT[4] ?? null) : null,
  );
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set(['builder', 'journalist']));
  return (
    <GalleryOverlay
      copying={false}
      entries={ENTRIES}
      entry={entry}
      onBack={() => {
        setEntry(null);
        setPersona(null);
      }}
      onClose={() => undefined}
      onCopy={() => undefined}
      onOpen={setEntry}
      open
      personas={{
        added,
        adding: false,
        onAdd: (next) => setAdded((previous) => new Set([...previous, next.id])),
        onOpen: setPersona,
        persona,
        personas: GALLERY_PERSONA_SNAPSHOT,
      }}
      section={startOn}
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

/** The personas shop, opened from the composer's Browse personas: each card
 *  opens with the start of its own sample, so a voice can be judged before
 *  its page is opened. Added ones say so. */
export const PersonaShelf: Story = { args: { startOn: 'personas' } };

/** One persona's page: the sample reply to the shared request, then the
 *  exact prompt, and the one action that copies it into the library. */
export const PersonaPage: Story = { args: { opened: true, startOn: 'personas' } };

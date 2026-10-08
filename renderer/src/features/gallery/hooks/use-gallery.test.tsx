import { onlineManager } from '@tanstack/react-query';
/** What the shop shows before, during, and after the published index answers. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { GalleryIndex } from '@/features/gallery/application/ports';
import type { GalleryEntry } from '@/features/gallery/domain/entry';
import { GALLERY_PERSONA_SNAPSHOT } from '@/features/gallery/domain/persona-snapshot';
import { GALLERY_SNAPSHOT } from '@/features/gallery/domain/snapshot';
import { createTestQueryClient, queryWrapper } from '@/test/query';

import { useGallery } from './use-gallery';

const bundledId = GALLERY_SNAPSHOT[0]?.id ?? '';

function published(overrides: Partial<GalleryEntry> = {}): GalleryEntry {
  return {
    about: null,
    category: 'course',

    description: 'Published introduction',

    id: bundledId,

    name: 'How to Start a Startup',
    repo: 'https://github.com/owner/repo',
    screenshot: null,

    ...overrides,
  };
}

function mount(loadIndex: () => Promise<GalleryIndex | null>) {
  return renderHook(() => useGallery({ loadIndex }), {
    wrapper: queryWrapper(createTestQueryClient()),
  });
}

describe('useGallery', () => {
  it('paints the bundled shelf on the first frame rather than an empty state', () => {
    const { result } = mount(async () => ({ personas: null, wikis: [published()] }));
    expect(result.current.bundled).toBe(true);
    expect(result.current.entries).toEqual(GALLERY_SNAPSHOT);
  });

  it('replaces the shelf with the published index and fills its gaps', async () => {
    const { result } = mount(async () => ({ personas: null, wikis: [published()] }));
    await waitFor(() => expect(result.current.bundled).toBe(false));
    // Published values win; the build's own knowledge fills what the index has
    // not said yet.
    expect(result.current.entries[0]?.description).toBe('Published introduction');
    expect(result.current.entries[0]?.about).toEqual(GALLERY_SNAPSHOT[0]?.about);
  });

  it('keeps the bundled shelf when the index cannot be read', async () => {
    const loadIndex = vi.fn(async () => null);
    const { result } = mount(loadIndex);
    await waitFor(() => expect(loadIndex).toHaveBeenCalled());
    expect(result.current.bundled).toBe(true);
    expect(result.current.entries).toEqual(GALLERY_SNAPSHOT);
  });

  it('recovers a failed publication on reconnect without restarting the window', async () => {
    const loadIndex = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ personas: null, wikis: [published()] });
    const { result, unmount } = mount(loadIndex);
    try {
      await waitFor(() => expect(loadIndex).toHaveBeenCalledTimes(1));
      await act(async () => {
        await Promise.resolve();
      });
      act(() => onlineManager.setOnline(false));
      act(() => onlineManager.setOnline(true));
      await waitFor(() => expect(result.current.bundled).toBe(false));
    } finally {
      unmount();
      onlineManager.setOnline(true);
    }
  });

  it('keeps the bundled personas until the index publishes its own', async () => {
    const persona = {
      category: 'news',
      description: 'Published',
      icon: null,
      id: 'published',
      name: 'Published',
      prompt: 'Report.',
      sample: null,
    };
    const older = mount(async () => ({ personas: null, wikis: [published()] }));
    await waitFor(() => expect(older.result.current.bundled).toBe(false));
    expect(older.result.current.personas).toEqual(GALLERY_PERSONA_SNAPSHOT);

    const newer = mount(async () => ({ personas: [persona], wikis: [published()] }));
    await waitFor(() => expect(newer.result.current.personas).toEqual([persona]));
  });
});

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { createAgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import type { WindowReleaseReason } from '@/shared/domain/window-release';
import { agentSessionPort } from '@/test/fakes/agent';
import { speechFixture } from '@/test/fakes/speech';

import { VoiceReleaseBarrier } from './voice-release-barrier';

afterEach(cleanup);

it('keeps unsent dictated work behind the native close barrier until explicit discard', async () => {
  const fixture = speechFixture();
  const runtime = createAgentWorkspaceRuntime({
    createId: () => crypto.randomUUID(),
    folderPath: '/project',
    port: agentSessionPort().port,
    voice: fixture.ports,
  });
  const voice = runtime.activeSession().voice;
  if (!voice) throw new Error('Missing voice fixture');
  let prepare: (reason: WindowReleaseReason) => Promise<boolean> = vi.fn(async () => true);
  const unsubscribe = vi.fn();
  const subscribe = (handler: (reason: WindowReleaseReason) => Promise<boolean>) => {
    prepare = handler;
    return unsubscribe;
  };
  const view = render(<VoiceReleaseBarrier runtime={runtime} subscribe={subscribe} />);
  try {
    expect(await prepare('close')).toBe(true);
    await act(async () => {
      await voice.start();
      fixture.emit();
      await voice.stop();
    });
    let first: Promise<boolean> = Promise.resolve(true);
    act(() => {
      first = prepare('close');
    });
    await screen.findByRole('dialog', { name: 'Discard voice work and close?' });
    await userEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    expect(await first).toBe(false);
    expect(runtime.activeSession().store.getState().draft).toBe('A dictated idea.');
    await act(async () => {
      expect(await prepare('update')).toBe(false);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(voice.store.getState().error).toContain('retry installing the update');
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      second = prepare('close');
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Discard and close' }));
    expect(await second).toBe(true);
  } finally {
    view.unmount();
    runtime.dispose();
  }
  expect(unsubscribe).toHaveBeenCalled();
});

it('hiding the composer stops capture while preserving the conversation target', async () => {
  const fixture = speechFixture();
  const runtime = createAgentWorkspaceRuntime({
    createId: () => crypto.randomUUID(),
    folderPath: '/project',
    port: agentSessionPort().port,
    voice: fixture.ports,
  });
  const voice = runtime.activeSession().voice;
  if (!voice) throw new Error('Missing voice fixture');
  const subscribe = vi.fn(() => vi.fn());
  const view = render(<VoiceReleaseBarrier runtime={runtime} subscribe={subscribe} />);
  try {
    await act(async () => {
      await voice.start();
      fixture.emit();
    });
    view.rerender(<VoiceReleaseBarrier runtime={runtime} subscribe={subscribe} visible={false} />);
    await waitFor(() => expect(fixture.stop).toHaveBeenCalled());
    await waitFor(() =>
      expect(runtime.activeSession().store.getState().draft).toBe('A dictated idea.'),
    );
  } finally {
    view.unmount();
    runtime.dispose();
  }
});

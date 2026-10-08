import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AgentPersonaInput } from '@/features/agent/application/ports';
import { agentPersona, agentPersonaApi } from '@/test/fakes/agent';
import { createTestQueryClient, queryWrapper } from '@/test/query';

import { useAgentPersona, useAgentPersonaLibrary } from './use-agent-persona';

afterEach(cleanup);

const MINE: AgentPersonaInput = {
  description: 'Short and dry',
  icon: 'feather',
  name: 'My voice',
  prompt: 'Write short.',
};

function mount(port = agentPersonaApi(), current: string | null = null) {
  const choose = vi.fn();
  const edited = vi.fn();
  const client = createTestQueryClient();
  const wrapper = queryWrapper(client);
  const hook = renderHook(
    ({ chosen }: { chosen: string | null }) => useAgentPersona(port, chosen, choose, edited),
    { initialProps: { chosen: current }, wrapper },
  );
  return { choose, client, edited, hook, port, wrapper };
}

describe('useAgentPersona', () => {
  it('shows the Chat persona only while it is still in the library', async () => {
    const { hook } = mount(agentPersonaApi(), 'journalist');
    await waitFor(() => expect(hook.result.current.selected?.name).toBe('Journalist'));

    hook.rerender({ chosen: 'deleted-elsewhere' });
    expect(hook.result.current.selected).toBeNull();
  });

  it('runs a newly written persona in this Chat, and the list gains it', async () => {
    const { choose, hook, port } = mount();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    let saved = false;
    await act(async () => {
      saved = await hook.result.current.save(null, MINE);
    });

    expect(saved).toBe(true);
    expect(port.create).toHaveBeenCalledWith(MINE, expect.anything());
    expect(choose).toHaveBeenCalledWith('persona-1');
    await waitFor(() =>
      expect(hook.result.current.personas.map((persona) => persona.name)).toEqual([
        'Journalist',
        'My voice',
      ]),
    );
  });

  // A session reads its persona's prompt when it starts, so only an edit to
  // the persona this Chat runs needs the restart; another one waits for the
  // Chats that run it to start.
  it('restarts the Chat only when the persona it runs is edited', async () => {
    const { edited, hook } = mount(
      agentPersonaApi({}, [agentPersona(), agentPersona({ id: 'other', name: 'Other' })]),
      'journalist',
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await hook.result.current.save('other', { ...MINE, name: 'Other' });
    });
    expect(edited).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.save('journalist', { ...MINE, name: 'Reporter' });
    });
    expect(edited).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(hook.result.current.selected?.name).toBe('Reporter'));
  });

  it('falls back to none when the running persona is deleted', async () => {
    const { choose, hook } = mount(agentPersonaApi(), 'journalist');
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await hook.result.current.remove('journalist');
    });

    expect(choose).toHaveBeenCalledWith(null);
    await waitFor(() => expect(hook.result.current.personas).toEqual([]));
  });

  it('keeps the dialog open with the refusal when a save fails', async () => {
    const port = agentPersonaApi({
      create: vi.fn(async () => {
        throw new Error('Give the persona a name');
      }),
    });
    const { choose, hook } = mount(port);
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    let saved = true;
    await act(async () => {
      saved = await hook.result.current.save(null, MINE);
    });

    expect(saved).toBe(false);
    expect(choose).not.toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current.failure).not.toBeNull());
  });

  it('shares one library cache with the Gallery add', async () => {
    const { hook, port, wrapper } = mount();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const gallery = renderHook(() => useAgentPersonaLibrary(port), { wrapper });
    await waitFor(() => expect(gallery.result.current.loading).toBe(false));

    await act(async () => {
      await gallery.result.current.add({ ...MINE, gallery: 'newsletter' });
    });

    await waitFor(() => expect(hook.result.current.personas.at(-1)?.gallery).toBe('newsletter'));
  });
});

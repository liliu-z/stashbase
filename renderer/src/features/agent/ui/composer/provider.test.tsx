import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { agentDefinition, BUILT_IN_AGENT, CLAUDE_AGENT, CODEX_AGENT } from '@/test/fakes/agent';

import { AgentProviderControl } from './provider';

afterEach(cleanup);

describe('agent composer provider control', () => {
  it('names the running agent and offers every catalog entry with the current one marked', async () => {
    const onAgentChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentProviderControl
        activeAgent={BUILT_IN_AGENT}
        agents={[BUILT_IN_AGENT, CODEX_AGENT, CLAUDE_AGENT]}
        disabled={false}
        onAgentChange={onAgentChange}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Provider: StashBase Agent' });
    await user.click(trigger);

    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(3);
    expect(
      screen
        .getAllByRole('menuitemradio', { checked: true })
        .map((option) => option.getAttribute('aria-label')),
    ).toEqual(['StashBase Agent']);
    for (const name of ['Codex', 'Claude']) {
      expect(screen.getByRole('menuitemradio', { name })).not.toBeNull();
    }
    await user.click(screen.getByRole('menuitemradio', { name: 'Codex' }));
    expect(onAgentChange).toHaveBeenCalledWith('codex');
  });

  it('selects an unavailable Agent without starting setup or login', async () => {
    const onAgentChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentProviderControl
        activeAgent={CODEX_AGENT}
        agents={[CODEX_AGENT, agentDefinition({ ready: false })]}
        disabled={false}
        onAgentChange={onAgentChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Provider: Codex' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'StashBase Agent' }));
    expect(onAgentChange).toHaveBeenCalledWith('stashbase');
  });

  // At the composer's narrow steps the trigger folds down to its icon, so the
  // hover hint is the only thing left naming what it runs. The hint rides on a
  // dropdown trigger, where a tooltip that failed to compose would leave the
  // icon silent rather than break anything visible.
  it('names the running agent on hover while the trigger is an icon alone', async () => {
    const user = userEvent.setup();
    render(
      <AgentProviderControl
        activeAgent={CODEX_AGENT}
        agents={[BUILT_IN_AGENT, CODEX_AGENT]}
        disabled={false}
        onAgentChange={vi.fn()}
      />,
    );

    await user.hover(screen.getByRole('button', { name: 'Provider: Codex' }));
    // The popup is portalled, so it is found on the document rather than the
    // trigger's subtree.
    expect(await screen.findByText('Provider: Codex')).not.toBeNull();
  });

  it('binds the provider for the run of a streaming turn', () => {
    render(
      <AgentProviderControl
        activeAgent={CODEX_AGENT}
        agents={[BUILT_IN_AGENT, CODEX_AGENT]}
        disabled
        onAgentChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Provider: Codex' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AgentModel } from '@/features/agent/domain/runtime-catalog';
import { agentToolsApi, BUILT_IN_AGENT, CLAUDE_AGENT, CODEX_AGENT } from '@/test/fakes/agent';

import { AgentThinkingControl } from './thinking';

type ControlProps = ComponentProps<typeof AgentThinkingControl>;
type ControlState = ControlProps['state'];

/** The newest entry the way Codex lists it: flagged as the runtime's own
 *  default, with the level it runs at when none is chosen. */
const GPT: AgentModel = {
  defaultEffort: 'medium',
  id: 'gpt-codex',
  isDefault: true,
  label: 'Codex Max',
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
};
const MINI: AgentModel = { id: 'gpt-mini', label: 'Codex Mini' };
/** A Claude-shaped entry: levels, but no word on which one is the default. */
const OPUS: AgentModel = { id: 'opus', label: 'Opus', supportedEfforts: ['low', 'high'] };

function sessionState(overrides: Partial<ControlState> = {}): ControlState {
  return {
    activeModel: null,
    activeTurn: false,
    effort: null,
    model: null,
    models: [],
    transcript: [],
    ...overrides,
  };
}

function renderControl(overrides: Partial<ControlProps> = {}) {
  const spies = {
    onEffortChange: vi.fn<ControlProps['onEffortChange']>(),
    onModelChange: vi.fn<ControlProps['onModelChange']>(),
    onRequestCatalog: vi.fn<ControlProps['onRequestCatalog']>(),
  };
  render(
    <AgentThinkingControl
      {...spies}
      activeAgent={overrides.activeAgent ?? CODEX_AGENT}
      state={overrides.state ?? sessionState()}
      tools={{ chat: 'test-chat', api: agentToolsApi(), onChanged: vi.fn() }}
    />,
  );
  return { ...spies, user: userEvent.setup() };
}

/** The thinking slider's thumb, as assistive technology reaches it. */
function slider(): HTMLElement {
  return screen.getByRole('slider', { name: 'Thinking' });
}

/** The accessible names of the options the open model menu marks as selected. */
function checkedNames(): string[] {
  return screen
    .getAllByRole('menuitemradio', { checked: true })
    .map((option) => option.getAttribute('aria-label') ?? option.textContent ?? '');
}

/** The accessible names of every option the open model menu offers, in order. */
function optionNames(): string[] {
  return screen
    .getAllByRole('menuitemradio')
    .map((option) => option.getAttribute('aria-label') ?? option.textContent ?? '');
}

afterEach(cleanup);

describe('agent composer model-and-thinking control', () => {
  it('renders nothing for a runtime that advertises no model or level choice', () => {
    renderControl({ activeAgent: { ...BUILT_IN_AGENT, id: 'codex' } });

    expect(screen.queryByRole('button', { name: /^Model and thinking:/u })).toBeNull();
  });

  it('names the runtime default and its level before anything is chosen, and opens on the level', async () => {
    const { onEffortChange, onRequestCatalog, user } = renderControl({
      state: sessionState({ models: [GPT, MINI] }),
    });

    const trigger = screen.getByRole('button', { name: 'Model and thinking: Codex Max, Medium' });
    await user.click(trigger);
    expect(onRequestCatalog).toHaveBeenCalledTimes(1);

    // The ranked levels share one slider, from Low to Max; Auto does not
    // rank, so it is offered beside the slider.
    expect(slider().getAttribute('aria-valuetext')).toBe('Medium, Balanced');
    expect(slider().getAttribute('max')).toBe('4');
    expect(screen.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Model: Codex Max' })).not.toBeNull();
    // Already on the model's own level, so there is nothing to reset.
    expect(
      screen
        .getByRole('button', { name: "Reset thinking to the model's default" })
        .hasAttribute('disabled'),
    ).toBe(true);

    slider().focus();
    await user.keyboard('{ArrowRight}');
    expect(onEffortChange).toHaveBeenLastCalledWith('high');
    await user.click(screen.getByRole('button', { name: 'Auto' }));
    expect(onEffortChange).toHaveBeenLastCalledWith('auto');
    // A level change keeps the panel open, so the reader can see it land.
    expect(screen.getByRole('dialog', { name: 'Model and thinking' })).not.toBeNull();
  });

  it('keeps the model one step deeper and marks the one that will run', async () => {
    const { onModelChange, user } = renderControl({
      state: sessionState({ models: [GPT, MINI] }),
    });

    await user.click(screen.getByRole('button', { name: 'Model and thinking: Codex Max, Medium' }));
    await user.click(screen.getByRole('button', { name: 'Model: Codex Max' }));

    // The runtime named its default, so the list needs no Default row.
    expect(optionNames()).toEqual(['Codex Max', 'Codex Mini']);
    expect(checkedNames()).toEqual(['Codex Max']);

    await user.click(screen.getByRole('menuitemradio', { name: 'Codex Mini' }));
    expect(onModelChange).toHaveBeenCalledWith('gpt-mini');
  });

  it('closes on a model pick and opens on the level again', async () => {
    const { user } = renderControl({ state: sessionState({ models: [GPT, MINI] }) });
    const trigger = screen.getByRole('button', { name: 'Model and thinking: Codex Max, Medium' });

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Model: Codex Max' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Codex Mini' }));
    // The pick closes the menu and the panel, which leave once their exits
    // have played.
    await waitFor(
      () => {
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: 2000 },
    );

    await user.click(trigger);
    expect(await screen.findByRole('slider', { name: 'Thinking' })).not.toBeNull();
  });

  it('reads the explicit picks back and says when a model has no level to choose', async () => {
    renderControl({
      state: sessionState({ effort: 'high', model: 'gpt-codex', models: [GPT, MINI] }),
    });
    expect(
      screen.getByRole('button', { name: 'Model and thinking: Codex Max, High' }),
    ).not.toBeNull();
    cleanup();

    const { user } = renderControl({
      state: sessionState({ model: 'gpt-mini', models: [GPT, MINI] }),
    });
    await user.click(screen.getByRole('button', { name: 'Model and thinking: Codex Mini' }));
    expect(screen.getByText('Thinking is set by the runtime')).not.toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('button', { name: 'Model: Codex Mini' })).not.toBeNull();
  });

  /** A runtime's model labels are aliases: "Opus" is whichever Opus that
   *  build runs, so the label alone cannot tell a reader which release they
   *  are on. The runtime says that in its description, and the row shows it. */
  it('shows the release a model alias resolves to, where the runtime names one', async () => {
    const { user } = renderControl({
      activeAgent: CLAUDE_AGENT,
      state: sessionState({
        models: [{ ...OPUS, description: 'Opus 5.5 with 1M context · Best for everyday tasks' }],
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Model and thinking: Default' }));
    await user.click(screen.getByRole('button', { name: 'Model: Default' }));

    expect(
      screen.getByRole('menuitemradio', {
        name: 'Opus. Opus 5.5 with 1M context · Best for everyday tasks',
      }),
    ).not.toBeNull();
  });

  it('keeps a way back to the runtime default wherever the runtime has named none', async () => {
    const first = renderControl({
      activeAgent: CLAUDE_AGENT,
      state: sessionState({ models: [OPUS] }),
    });

    await first.user.click(screen.getByRole('button', { name: 'Model and thinking: Default' }));
    expect(screen.getByText('Thinking is set by the runtime')).not.toBeNull();
    await first.user.click(screen.getByRole('button', { name: 'Model: Default' }));
    expect(optionNames()).toEqual(['Default', 'Opus']);
    expect(checkedNames()).toEqual(['Default']);
    await first.user.click(screen.getByRole('menuitemradio', { name: 'Opus' }));
    expect(first.onModelChange).toHaveBeenCalledWith('opus');
    cleanup();

    // Opus declares no level of its own: until one is chosen the slider
    // stands at Default, and Reset returns there.
    const unplaced = renderControl({
      activeAgent: CLAUDE_AGENT,
      state: sessionState({ model: 'opus', models: [OPUS] }),
    });
    await unplaced.user.click(screen.getByRole('button', { name: 'Model and thinking: Opus' }));
    expect(slider().getAttribute('aria-valuetext')).toBe('Default');
    cleanup();

    const second = renderControl({
      activeAgent: CLAUDE_AGENT,
      state: sessionState({ effort: 'high', model: 'opus', models: [OPUS] }),
    });
    await second.user.click(screen.getByRole('button', { name: 'Model and thinking: Opus, High' }));
    expect(slider().getAttribute('aria-valuetext')).toBe('High, Deeper reasoning');
    await second.user.click(
      screen.getByRole('button', { name: "Reset thinking to the model's default" }),
    );
    expect(second.onEffortChange).toHaveBeenCalledWith(null);
  });

  /** Claude names models by alias and says the release only in its own
   *  description, which the catalog reads into `release`. */
  it('names an alias by the release it resolves to, and drops the parenthetical from names', async () => {
    const description = 'Opus 5.5 with 1M context · Best for everyday, complex tasks';
    const { user } = renderControl({
      activeAgent: CLAUDE_AGENT,
      state: sessionState({
        effort: 'high',
        models: [
          { description, id: 'default', label: 'Default (recommended)', release: 'Opus 5.5' },
          {
            description,
            id: 'opus[1m]',
            isDefault: true,
            label: 'Opus (1M context)',
            release: 'Opus 5.5',
            supportedEfforts: ['low', 'high'],
          },
        ],
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Model and thinking: Opus 5.5, High' }));
    await user.click(screen.getByRole('button', { name: 'Model: Opus 5.5' }));
    expect(optionNames()).toEqual([`Default. ${description}`, `Opus. ${description}`]);
  });

  it('keeps the parenthetical where dropping it would leave two models one name', async () => {
    const { user } = renderControl({
      activeAgent: CLAUDE_AGENT,
      state: sessionState({
        models: [
          { id: 'opus', isDefault: true, label: 'Opus', supportedEfforts: ['low', 'high'] },
          { id: 'opus[1m]', label: 'Opus (1M context)', supportedEfforts: ['low', 'high'] },
        ],
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Model and thinking: Opus' }));
    await user.click(screen.getByRole('button', { name: 'Model: Opus' }));
    expect(optionNames()).toEqual(['Opus', 'Opus (1M context)']);
  });

  it('falls back to the model the runtime is actually running when none is chosen', () => {
    renderControl({ state: sessionState({ activeModel: 'gpt-mini', models: [GPT, MINI] }) });

    expect(screen.getByRole('button', { name: 'Model and thinking: Codex Mini' })).not.toBeNull();
  });

  it('binds model and level for the run of a streaming turn', () => {
    renderControl({ state: sessionState({ activeTurn: true, models: [GPT] }) });

    expect(
      screen
        .getByRole('button', { name: 'Model and thinking: Codex Max, Medium' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('describes the model lock when opening a populated Claude chat panel with the keyboard', async () => {
    const { user } = renderControl({
      activeAgent: CLAUDE_AGENT,
      state: sessionState({
        effort: 'high',
        model: 'opus',
        models: [OPUS],
        transcript: [{ id: 'u1', kind: 'user', text: 'Summarize the plan' }],
      }),
    });

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Model and thinking: Opus, High' }),
    );
    await user.keyboard('{Enter}');
    expect(
      screen.getByRole('dialog', {
        description: 'Kept for this chat · Start a new chat to switch',
        name: 'Model and thinking',
      }),
    ).not.toBeNull();
    const model = screen.getByRole('button', {
      description: 'Kept for this chat · Start a new chat to switch',
      name: 'Model: Opus',
    });
    expect(model.hasAttribute('disabled')).toBe(true);
    expect(slider().hasAttribute('disabled')).toBe(false);
  });

  it('gives no lock reason while a Claude conversation is still empty', async () => {
    const { user } = renderControl({
      activeAgent: CLAUDE_AGENT,
      state: sessionState({ effort: 'high', model: 'opus', models: [OPUS] }),
    });

    await user.click(screen.getByRole('button', { name: 'Model and thinking: Opus, High' }));
    expect(screen.getByRole('button', { name: 'Model: Opus' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(screen.queryByText(/Kept for this chat/u)).toBeNull();
  });

  it('opens straight on the model list for a runtime with no level to choose', async () => {
    const { user } = renderControl({
      activeAgent: { ...CODEX_AGENT, abilities: { ...CODEX_AGENT.abilities, effort: false } },
      state: sessionState({ models: [GPT, MINI] }),
    });

    await user.click(screen.getByRole('button', { name: 'Model and thinking: Codex Max, Medium' }));
    expect(optionNames()).toEqual(['Codex Max', 'Codex Mini']);
    expect(screen.queryByRole('slider')).toBeNull();
  });
});

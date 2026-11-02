import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { expect, screen, userEvent, waitFor } from 'storybook/test';

import type {
  AgentPersonaPort,
  AgentToolChange,
  AgentToolsPort,
} from '@/features/agent/application/ports';
import { createAgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import type {
  Agent,
  AgentPreparation,
  AgentSetupFailure,
} from '@/features/agent/domain/agent-catalog';
import { cn } from '@/lib/utils';

import ManagedAgentWorkspace from './workspace';

const storyPersonas = [
  {
    description: 'Build-in-public updates',
    gallery: 'builder',
    icon: 'hammer',
    id: 'builder',
    name: 'Builder',
    prompt: 'Lead with what shipped.',
  },
  {
    description: 'A neutral news report',
    gallery: 'journalist',
    icon: 'newspaper',
    id: 'journalist',
    name: 'Journalist',
    prompt: 'Report what happened.',
  },
] as const;

const storyPersona: AgentPersonaPort = {
  list: async () => [...storyPersonas],
  create: async (input) => ({ ...input, gallery: input.gallery ?? null, id: 'story-persona' }),
  update: async (id, input) => ({ ...input, gallery: input.gallery ?? null, id }),
  remove: async () => {},
};

/** Default with every tool off, the state a new reader starts in. A change
 *  is kept for the story's life so the menu can be walked through. */
const STORY_TOOLS = [
  {
    id: 'writer',
    label: 'Writer',
    summary: 'Drafts and revises prose',
    icon: 'pen-line',
    model: 'claude-opus-5-5',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    summary: 'Suggests fixes to a draft',
    icon: 'search-check',
    model: 'gpt-6-1-sol',
  },
  {
    id: 'reader',
    label: 'Reader',
    summary: 'Reads a draft as its audience would',
    icon: 'book-open',
    model: 'gpt-6-1-sol',
  },
  {
    id: 'humanizer',
    label: 'Humanizer',
    summary: 'Makes prose read naturally',
    icon: 'sparkle',
    model: 'claude-sonnet-5-5',
  },
] as const;

const storyToolChoices: Partial<Record<string, AgentToolChange>> = {};
const storyToolList = () =>
  STORY_TOOLS.map(({ id, label, summary, icon, model }) => ({
    id,
    label,
    toolName: `${id}_draft`,
    summary,
    icon,
    enabled: storyToolChoices[id]?.enabled ?? false,
    unavailable: null,
    model: storyToolChoices[id]?.model ?? model,
    modelProblem: null,
    defaultModel: model,
    options: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', available: true, reason: null },
      { id: 'gpt-6-1-sol', label: 'GPT-6.1 Sol', available: true, reason: null },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', available: true, reason: null },
    ],
  }));
const storyTools: AgentToolsPort = {
  list: async () => storyToolList(),
  set: async (id, change) => {
    storyToolChoices[id] = { ...storyToolChoices[id], ...change };
    return storyToolList();
  },
};

const abilities: Agent['abilities'] = {
  attachments: true,
  effort: true,
  models: true,
  modes: ['default', 'plan', 'acceptEdits', 'auto'],
  skills: true,
  steering: true,
};

const codexModels = [
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.2-codex',
    label: 'GPT-5.2 Codex (recommended for agentic coding)',
    supportedEfforts: ['low', 'medium', 'high'],
  },
];

const agents: Agent[] = [
  {
    abilities,
    id: 'codex',
    label: 'Codex',
    models: codexModels,
    needsSignIn: false,
    ready: true,
    updatable: true,
    availableVersion: '0.163.0',
  },
  { abilities, id: 'claude', label: 'Claude', models: [], needsSignIn: false, ready: true },
  { abilities, id: 'stashbase', label: 'Default', models: [], needsSignIn: false, ready: true },
];

/** The same runtimes before any of them can carry a turn: one waiting on
 *  sign-in, the rest on installation. */
const pendingAgents: Agent[] = agents.map((agent) => ({
  ...agent,
  needsSignIn: agent.id === 'codex',
  ready: false,
}));

const STORY_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#6B97FF"/><path d="M24 124 65 74l26 31 19-18 26 37Z" fill="#fff"/></svg>';

const SKILLS = [
  { id: 'review', label: 'review', description: 'Review a draft', argumentHint: 'what to review' },
  { id: 'summarize', label: 'summarize', description: 'Summarize a folder' },
];

/** No provider work: each accepted decision produces the next local request. */
function approvalRequest(index: number) {
  return {
    kind: 'permission-requested' as const,
    id: `approval-${index}`,
    toolUseId: `edit-${index}`,
    name: 'Edit',
    title: null,
    input: {
      file_path: `/Library/Research/draft-${index}.md`,
      old_string: 'Original paragraph.',
      new_string: Array.from({ length: 40 }, (_, line) => `Revised paragraph ${line}.`).join('\n'),
    },
  };
}

/** The catalog answers asynchronously, so a story that means to show a working
 *  conversation has to wait for the setup gate to lift. Without it the canvas
 *  is scored mid-check, and the composer's controls are never looked at. */
const readyWorkspace = async () => {
  await waitFor(() => expect(screen.queryByText('Checking agents…')).toBeNull());
  await screen.findByRole('button', { name: /^Provider: / });
};

function WorkspacePreview({
  approvals = false,
  authRefused = false,
  context = false,
  currentDocument = false,
  docked = false,
  empty = false,
  followUp = false,
  interrupted = false,
  preparation,
  ready = true,
  setupFailure,
  skills = false,
  startupChecking = false,
  startupFailure,
}: {
  approvals?: boolean;
  authRefused?: boolean;
  context?: boolean;
  /** The document visible beside the Agent pane supplies the next request. */
  currentDocument?: boolean;
  docked?: boolean;
  empty?: boolean;
  /** A follow-up sent into the running turn waits for the agent to read it. */
  followUp?: boolean;
  interrupted?: boolean;
  /** The step Codex's preparation stays on once the reader connects it. */
  preparation?: AgentPreparation;
  /** False draws the window a reader meets before any runtime is set up. */
  ready?: boolean;
  setupFailure?: AgentSetupFailure;
  skills?: boolean;
  /** The first listing precedes the host's background readiness check. */
  startupChecking?: boolean;
  startupFailure?: 'auth-expired' | 'runtime-outdated' | 'app-outdated';
}) {
  const openedAt = useMemo(() => Date.now(), []);
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const runtime = useMemo(() => {
    const next = createAgentWorkspaceRuntime({
      autostart: false,
      context: {
        resolve: async (source) => ({
          available: true,
          folder: 'Research',
          kind: 'direct',
          path: `${source.folderPath}/${source.path}`,
          readPath: source.path,
          reason: '',
          sourceFormat: 'md',
          sourcePath: source.path,
        }),
        upload: async (files) =>
          files.map((file) => ({ name: file.name, path: `/tmp/attach/${file.name}` })),
      },
      createId: () => 'preview-chat',
      folderPath: '/Library/Research',
      port: {
        connect: (_request, listener) => {
          queueMicrotask(() => {
            listener.onEvent({ error: null, kind: 'skills', skills: SKILLS, state: 'available' });
            listener.onEvent({ kind: 'ready' });
            if (approvals) {
              listener.onEvent({ kind: 'turn-started' });
              listener.onEvent(approvalRequest(0));
            }
            if (followUp) {
              // A real turn that never answers, and a follow-up sent into it.
              const session = next.activeSession();
              void session
                .sendPrompt('Compare their export formats.')
                .then(() => session.steer('Check whether it exports PNG too.'));
            }
            if (interrupted) {
              listener.onEvent({
                kind: 'exited',
                message: 'Agent stream failed: connection reset by peer.',
              });
            }
          });
          let count = 1;
          let closed = false;
          return {
            close: () => {
              closed = true;
            },
            send: (command) => {
              if (approvals && command.kind === 'reply-permission') {
                queueMicrotask(() => {
                  if (!closed) listener.onEvent(approvalRequest(count++));
                });
              }
              return true;
            },
          };
        },
        list: async () => [],
        remove: async () => undefined,
        rename: async (entry) => entry,
        replay: async () => ({ effort: null, transcript: [] }),
      },
    });
    next.newChat(startupFailure === 'app-outdated' ? 'stashbase' : 'codex', {
      kind: 'folder',
      path: '/Library/Research',
    });
    next.activeSession().store.setState({
      accessMode: 'plan',
      activeModel: 'gpt-5.3-codex',
      effort: 'high',
      model: 'gpt-5.3-codex',
      models: codexModels,
      connection: interrupted
        ? { kind: 'closed', message: 'Agent stream failed: connection reset by peer.' }
        : empty
          ? { kind: 'draft' }
          : { kind: 'live', turn: null },
      delivery: interrupted ? 'unknown' : 'idle',
      title: empty ? 'Untitled' : 'Screenshot research',
      transcript: empty
        ? []
        : [
            {
              at: Date.now() - 86_400_000,
              id: 'user-1',
              kind: 'user',
              text: 'Find the best free tools for presenting lesson screenshots.',
            },
            {
              id: 'thinking-1',
              kind: 'thinking',
              text: 'Comparing browser-frame editors and export limits',
            },
            {
              id: 'read-1',
              input: { path: 'research/screenshot-tools.md' },
              kind: 'tool',
              name: 'Read',
              result: 'Loaded the current shortlist.',
              status: 'done',
            },
            {
              id: 'search-1',
              input: { query: 'free screenshot mockup tools' },
              kind: 'tool',
              name: 'Search',
              result: 'Found five relevant tools.',
              status: 'done',
            },
            {
              id: 'reply-1',
              kind: 'assistant',
              text: [
                'Here are the strongest options:',
                '',
                '1. **Screely** — fast browser frames, gradients, and generous PNG exports.',
                '2. **Screenshot.rocks** — simple, local processing with no account.',
                '3. **Pika** — polished templates, with some frames behind a paid plan.',
                '',
                'For a lesson screenshot, start with [Screely](https://www.screely.com).',
              ].join('\n'),
            },
            { at: Date.now(), id: 'user-2', kind: 'user', text: 'Which one exports SVG?' },
            { id: 'reply-2', kind: 'assistant', text: 'Only Screely does, on its free plan.' },
          ],
    });
    if (context) {
      next.setScopeEnvironment({
        folderPath: '/Library/Research',
        listing: {
          files: [
            { format: 'md', path: 'MISSION.md' },
            { format: 'md', path: 'NOTES.md' },
            { format: 'md', path: 'research/screenshot-tools.md' },
            { format: 'pdf', path: 'reference/style-guide.pdf' },
            { format: 'generic', path: 'scripts/build (test).mjs' },
          ],
          folders: ['assets', 'lessons', 'reference'],
        },
        readiness: { 'reference/style-guide.pdf': 'pending' },
        versions: {},
      });
      const session = next.activeSession();
      session.addContext({
        boundVersion: null,
        format: 'md',
        kind: 'source',
        source: { folderPath: '/Library/Research', path: 'research/screenshot-tools.md' },
      });
      session.addContext({
        boundVersion: null,
        format: 'pdf',
        kind: 'source',
        source: { folderPath: '/Library/Research', path: 'reference/style-guide.pdf' },
      });
      session.addContext({
        boundVersion: null,
        format: 'generic',
        kind: 'source',
        source: { folderPath: '/Library/Research', path: 'scripts/build (test).mjs' },
      });
      // Context first, then the draft: the editor's sync turns each known
      // `@path` run into an inline chip.
      session.setDraft(
        'Compare @research/screenshot-tools.md with @reference/style-guide.pdf and list gaps.',
      );
      void session.attachFiles([
        new File([STORY_IMAGE], 'workspace-cover.svg', { type: 'image/svg+xml' }),
      ]);
    }
    if (currentDocument) {
      next.setScopeEnvironment({
        activeSource: { folderPath: '/Library/Research', path: 'notes.md' },
        folderPath: '/Library/Research',
        listing: { files: [{ format: 'md', path: 'notes.md' }], folders: [] },
        readiness: {},
        versions: {},
      });
      next.activeSession().setDraft('What does this page say?');
    }
    if (approvals) next.activeSession().start();
    if (skills) {
      const session = next.activeSession();
      session.start();
      // The catalog arrives on the connection, so the armed skill waits for it.
      queueMicrotask(() => session.setSkill('review'));
    }
    if (authRefused) {
      next.activeSession().store.setState({
        delivery: 'failed',
        transcript: [
          { id: 'user-auth', kind: 'user', text: 'hi' },
          {
            id: 'error-auth',
            kind: 'error',
            failure: 'auth-expired',
            text: 'workspace routing discovery unauthorized (401)',
            retryablePrompt: 'hi',
          },
        ],
      });
    }
    if (startupFailure) {
      next.activeSession().store.setState({
        connection: {
          kind: 'closed',
          failure: startupFailure,
          message:
            startupFailure === 'auth-expired'
              ? 'workspace routing discovery unauthorized (401)'
              : startupFailure === 'app-outdated'
                ? 'StashBase 2.18.0 or newer is required.'
                : 'Run codex update',
        },
        delivery: 'failed',
        draft: 'Help me write my first article.',
        transcript: [],
      });
    }
    return next;
  }, [
    approvals,
    startupFailure,
    authRefused,
    context,
    currentDocument,
    empty,
    followUp,
    interrupted,
    skills,
  ]);

  useEffect(() => () => runtime.dispose(), [runtime]);

  return (
    <QueryClientProvider client={queryClient}>
      <div
        className={cn(
          approvals ? 'h-[28rem]' : 'h-[46rem]',
          docked ? 'w-[36rem] border-l border-border' : 'w-[64rem]',
        )}
      >
        <div className="relative h-full overflow-hidden">
          <ManagedAgentWorkspace
            onOpenAppSettings={() => undefined}
            catalog={{
              listAgents: async () => ({
                agents:
                  startupChecking && Date.now() - openedAt < 3_000
                    ? agents.map((agent) => ({
                        ...agent,
                        ready: false,
                        preparation: { step: 'check' as const },
                      }))
                    : authRefused
                      ? agents.map((agent) => ({ ...agent, ready: false, needsSignIn: true }))
                      : ready
                        ? agents
                        : pendingAgents,
              }),
              prepareAgent: async (id) => {
                const selected = agents.find((agent) => agent.id === id);
                if (preparation && selected) {
                  return { agents: [{ ...selected, ready: false, preparation }] };
                }
                return {
                  agents:
                    setupFailure && selected
                      ? [
                          {
                            ...selected,
                            ready: false,
                            needsSignIn: setupFailure.retryAction === 'login',
                            setupFailure,
                          },
                        ]
                      : agents,
                };
              },
            }}
            persona={storyPersona}
            tools={storyTools}
            onOpenExternal={() => undefined}
            onOpenAgentSettings={() => undefined}
            onSignIn={() => undefined}
            runtime={runtime}
          />
        </div>
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  component: WorkspacePreview,
  parameters: {
    controls: { disable: true },
    fluidCanvas: { minHeight: '50rem', width: '68rem' },
  },
  title: 'Agent/Working notebook',
} satisfies Meta<typeof WorkspacePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullWorkspace: Story = { play: readyWorkspace };

export const SignInRequired: Story = { args: { authRefused: true }, play: readyWorkspace };

export const StartupChecking: Story = {
  args: { empty: true, context: true, startupChecking: true },
  play: async () => {
    await screen.findByRole('button', { name: /^Model and thinking:/ }, { timeout: 5_000 });
  },
};

export const InterruptedTurn: Story = {
  args: { interrupted: true },
  play: async () => {
    await readyWorkspace();
    await screen.findByText('Agent stream failed: connection reset by peer.');
  },
};

/** A follow-up sent mid-turn waits, dimmed, until the agent reads it. */
export const FollowUpWaiting: Story = {
  args: { followUp: true },
  play: async () => {
    await readyWorkspace();
    await screen.findByText(/Check whether it exports PNG too/);
  },
};

export const EmptyWorkspace: Story = {
  args: { empty: true },
  play: readyWorkspace,
};

export const ModelPicker: Story = {
  args: { empty: true },
  play: async () => {
    await readyWorkspace();
    await userEvent.click(screen.getByRole('button', { name: /^Model and thinking:/ }));
    // The panel names the model; the model list opens one step under it.
    await userEvent.click(await screen.findByRole('button', { name: /^Model: / }));
    await screen.findByRole('menuitem', { name: /Update Codex/ });
  },
};

export const BoundContext: Story = {
  args: { context: true, empty: true },
  play: readyWorkspace,
};

/** The open document is already included; Send preserves it in the transcript. */
export const CurrentDocument: Story = {
  args: { currentDocument: true, docked: true, empty: true },
  parameters: { fluidCanvas: { minHeight: '50rem', width: '40rem' } },
  play: readyWorkspace,
};

export const ArmedSkill: Story = {
  args: { empty: true, skills: true },
  play: readyWorkspace,
};

export const Docked: Story = {
  args: { docked: true },
  parameters: { fluidCanvas: { minHeight: '50rem', width: '40rem' } },
  play: readyWorkspace,
};

/** Access is offered only after an explicit Send, while keeping the draft. It
 *  asks about the Agent this chat is on, which here is Codex, whose own
 *  sign-in is all it is missing. */
async function requestSetup() {
  const input = await screen.findByRole('textbox', { name: 'Message' });
  await userEvent.type(input, 'Help me write');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('dialog', { name: 'Sign in to use Codex' });
}

export const SetupOffer: Story = {
  args: { empty: true, ready: false },
  play: requestSetup,
};

/** Connecting waits on the provider's sign-in in the browser; the panel names
 *  that step, how long it has run, and the page for a browser that did not
 *  open. */
export const SetupProgress: Story = {
  args: {
    empty: true,
    preparation: {
      note: 'Finish signing in to Codex in your browser.',
      signInUrl: 'https://auth.openai.com/oauth/authorize',
      step: 'sign-in',
    },
    ready: false,
  },
  play: async () => {
    await requestSetup();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Open sign-in page' });
  },
};

export const SetupFailure: Story = {
  args: {
    empty: true,
    ready: false,
    setupFailure: {
      stage: 'mcp',
      message:
        'Could not read Codex configuration at /Users/writer/.codex/config.toml.\nInvalid TOML at line 12, column 1: duplicate key mcp_servers.stashbase.',
    },
  },
  play: async () => {
    await requestSetup();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(/Invalid TOML at line 12/);
  },
};

export const StartupSignInRequired: Story = {
  args: { empty: true, startupFailure: 'auth-expired' },
};
export const StartupUpdateRequired: Story = {
  args: { empty: true, startupFailure: 'runtime-outdated' },
};
export const AppUpdateRequired: Story = { args: { empty: true, startupFailure: 'app-outdated' } };

export const StartupUpdateRequiresSignIn: Story = {
  args: {
    empty: true,
    startupFailure: 'runtime-outdated',
    setupFailure: {
      stage: 'authentication',
      message: 'Codex is installed, but it is not signed in.',
      retryAction: 'login',
    },
  },
  play: async () => {
    await readyWorkspace();
    await userEvent.click(await screen.findByRole('button', { name: 'Update Codex' }));
    await screen.findByRole('button', { name: 'Continue after sign-in' });
  },
};

/** A short window with a long diff: hidden transcript labels must not create
 * a second scroll range in the pane as decisions collapse and new ones land. */
export const RepeatedApprovals: Story = {
  args: { approvals: true },
  parameters: { fluidCanvas: { minHeight: '34rem', width: '68rem' } },
  play: async () => {
    await readyWorkspace();
    const composer = await screen.findByRole('textbox', { name: 'Message' });
    const log = screen.getByRole('log', { name: 'Chat transcript' });
    const pane = log.parentElement?.parentElement;
    if (!pane) throw new Error('Expected the chat pane around the workspace');
    const top = composer.getBoundingClientRect().top;
    for (let index = 0; index < 5; index += 1) {
      await screen.findByRole('region', { name: `Edited draft-${index}.md` });
      const allow = screen.getByRole('button', { name: 'Allow' });
      // Browser focus/navigation can reveal a pending control before activation.
      // Layout assertions require running this Story in a real browser.
      allow.scrollIntoView({ block: 'nearest' });
      await userEvent.click(allow);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(pane.scrollHeight).toBe(pane.clientHeight);
      expect(pane.scrollTop).toBe(0);
      expect(composer.getBoundingClientRect().top).toBe(top);
    }
  },
};

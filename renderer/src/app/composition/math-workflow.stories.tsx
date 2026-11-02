/** A controlled Chat-to-document workspace for comparing the same formulas,
 * exercising real copy/paste, and reopening Markdown saved in memory. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ComponentProps } from 'react';
import { expect, waitFor, within } from 'storybook/test';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  AgentWorkspace,
  useAgentWorkspaceRuntime,
  type AgentCatalogPort,
  type AgentContextPort,
  type AgentPersonaPort,
  type AgentSessionPort,
  type AgentToolsPort,
} from '@/features/agent/public';
import {
  createDocumentQueryScope,
  createDocumentTabsRuntime,
  DocumentTabs,
  DocumentWorkspace,
} from '@/features/documents/public';
import { MATH_MARKDOWN } from '@/test/fixtures/math';

const FOLDER = '/math-workflow';
const SAMPLE = { folderPath: FOLDER, path: 'written-formulas.md' };
const TARGET = { folderPath: FOLDER, path: 'pasted-formulas.md' };
const ignore = () => {};
const subscribeFolderRemoved = () => ignore;
const unavailable = async (): Promise<never> => {
  throw new Error('This controlled fixture supports Markdown only.');
};

const catalog: AgentCatalogPort = {
  listAgents: async () => ({
    agents: [
      {
        id: 'codex',
        label: 'Fixture Agent',
        ready: true,
        needsSignIn: false,
        models: [],
        abilities: {
          attachments: false,
          effort: false,
          models: false,
          modes: [],
          skills: false,
          steering: false,
        },
      },
    ],
  }),
  prepareAgent: unavailable,
};
const context: AgentContextPort = {
  resolve: unavailable,
  upload: unavailable,
};
const persona: AgentPersonaPort = {
  list: async () => [],
  create: unavailable,
  update: unavailable,
  remove: unavailable,
};
const tools: AgentToolsPort = { list: async () => [], set: unavailable };
const session: AgentSessionPort = {
  connect: (_request, listener) => {
    let closed = false;
    queueMicrotask(() => {
      if (!closed) listener.onEvent({ kind: 'ready' });
    });
    return {
      close: () => {
        closed = true;
      },
      send: (command) => {
        if (closed) return false;
        if (command.kind === 'prompt') {
          queueMicrotask(() => {
            if (closed) return;
            listener.onEvent({ kind: 'turn-started' });
            listener.onEvent({ kind: 'text', delta: MATH_MARKDOWN });
            listener.onEvent({ kind: 'turn-ended', isError: false });
          });
        }
        return true;
      },
    };
  },
  list: async () => [],
  replay: async () => ({ effort: null, transcript: [] }),
  rename: async (entry, title) => ({ ...entry, title }),
  remove: async () => {},
};

type DocumentProps = ComponentProps<typeof DocumentWorkspace>;

function createFixture(onSaved: (path: string, content: string) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const files = new Map([
    [SAMPLE.path, { content: MATH_MARKDOWN, format: 'md' as const, version: 'sample-1' }],
    [TARGET.path, { content: '', format: 'md' as const, version: 'target-1' }],
  ]);
  let sequence = 0;
  const read = (path: string) => {
    const file = files.get(path);
    if (!file) throw new Error(`No fixture file: ${path}`);
    return file;
  };
  const sourceApi: DocumentProps['sourceApi'] = {
    load: async (source) => read(source.path),
    save: async (source, input) => {
      if (input.baseVersion !== read(source.path).version)
        throw new Error('The fixture source changed before it was saved.');
      const saved = {
        content: input.content,
        format: 'md' as const,
        version: `save-${++sequence}`,
      };
      files.set(source.path, saved);
      onSaved(source.path, saved.content);
      return saved;
    },
    overwrite: unavailable,
  };
  const documents = createDocumentTabsRuntime({
    api: sourceApi,
    createId: () => `document-${++sequence}`,
    createQueries: (scope) => createDocumentQueryScope(queryClient, scope),
    folderPath: FOLDER,
    generation: 1,
  });
  return { createId: () => `chat-${++sequence}`, documents, queryClient, read, sourceApi };
}

function MathWorkflowSession({ onReset }: { onReset(): void }) {
  const [mathMode, setMathMode] = useState(true);
  const [saved, setSaved] = useState({ path: SAMPLE.path, content: MATH_MARKDOWN });
  const [fixture] = useState(() => createFixture((path, content) => setSaved({ path, content })));
  const agent = useAgentWorkspaceRuntime({
    context,
    createId: fixture.createId,
    folderPath: FOLDER,
    session,
    subscribeFolderRemoved,
  });
  const open = async (source: typeof SAMPLE, reading = false) => {
    const document = await fixture.documents.open(source);
    document?.setMarkdownMode(reading ? 'reading' : 'writer');
    setSaved({ path: source.path, content: fixture.read(source.path).content });
  };
  useEffect(() => {
    agent.newChat('codex', { kind: 'folder', path: FOLDER });
    void agent.activeSession().sendPrompt('Show the formula notebook.');
    void fixture.documents.open(SAMPLE).then((document) => document?.setMarkdownMode('reading'));
    return () => {
      fixture.documents.dispose();
      fixture.queryClient.clear();
    };
  }, [agent, fixture]);
  const reopen = async () => {
    const source = fixture.documents.activeSource();
    if (!source || !(await fixture.documents.flush())) return;
    if (await fixture.documents.closeSource(source)) await open(source, true);
  };

  return (
    <QueryClientProvider client={fixture.queryClient}>
      <div className="flex w-full min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-ui-20 font-semibold">Math workflow</h1>
          <Switch checked={mathMode} label="Math" onToggle={() => setMathMode((value) => !value)} />
          <Button onClick={onReset} size="compact" variant="ghost">
            Reset
          </Button>
        </div>
        <p className="text-caption text-muted-foreground">
          Controlled sample; no provider or disk writes. Copy the reply or select a formula in Chat,
          open the paste target, and paste into the document. Every prompt returns this sample.
        </p>
        <div className="grid min-w-0 grid-cols-2 gap-4 max-lg:grid-cols-1">
          <section
            aria-label="Math in Chat"
            className="min-w-0 overflow-hidden rounded-lg border border-border"
          >
            <h2 className="border-b border-border px-4 py-2 text-caption font-medium">
              Chat output
            </h2>
            <div className="h-[44rem]">
              <AgentWorkspace
                catalog={catalog}
                mathMode={mathMode}
                onOpenAgentSettings={ignore}
                onOpenAppSettings={ignore}
                onOpenExternal={ignore}
                onSignIn={ignore}
                persona={persona}
                runtime={agent}
                tools={tools}
              />
            </div>
          </section>
          <section
            aria-label="Math in Documents"
            className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border"
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <h2 className="mr-auto text-caption font-medium">Document</h2>
              <Button onClick={() => void open(SAMPLE, true)} size="compact" variant="ghost">
                Written sample
              </Button>
              <Button onClick={() => void open(TARGET)} size="compact" variant="secondary">
                Paste target
              </Button>
              <Button onClick={() => void reopen()} size="compact" variant="ghost">
                Save and reopen
              </Button>
            </div>
            <div className="flex h-[44rem] min-h-0 flex-col">
              <DocumentTabs runtime={fixture.documents} />
              <div className="min-h-0 flex-1">
                <DocumentWorkspace
                  assetApi={{ load: unavailable }}
                  docxPreviewApi={{ load: unavailable }}
                  genericPreviewApi={{ load: unavailable }}
                  mathMode={mathMode}
                  onReveal={unavailable}
                  revealLabel="Reveal file"
                  runtime={fixture.documents}
                  sourceApi={fixture.sourceApi}
                  tableApi={{ load: unavailable }}
                />
              </div>
            </div>
          </section>
        </div>
        <details className="min-w-0 rounded-lg border border-border px-4 py-3">
          <summary className="cursor-pointer text-caption">Saved Markdown: {saved.path}</summary>
          <pre className="mt-3 max-h-64 overflow-auto text-caption break-words whitespace-pre-wrap">
            {saved.content || '(Empty document)'}
          </pre>
        </details>
      </div>
    </QueryClientProvider>
  );
}

function MathWorkflow() {
  const [generation, setGeneration] = useState(0);
  return (
    <MathWorkflowSession key={generation} onReset={() => setGeneration((value) => value + 1)} />
  );
}

const meta = {
  component: MathWorkflow,
  parameters: { controls: { disable: true }, fluidCanvas: { width: '96rem', minHeight: '56rem' } },
  title: 'Compositions/Math workflow',
} satisfies Meta<typeof MathWorkflow>;

export default meta;
type Story = StoryObj<typeof meta>;
export const ChatToDocument: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: 'Copy response' }, { timeout: 10_000 });
    await waitFor(
      () => expect(canvas.getByRole('document').getAttribute('data-markdown-state')).toBe('ready'),
      { timeout: 10_000 },
    );
  },
};

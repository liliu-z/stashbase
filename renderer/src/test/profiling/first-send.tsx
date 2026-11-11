/** Isolated native-startup fixture for scripts/profiling/first-send.mjs. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';

import { createAgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import ManagedAgentWorkspace from '@/features/agent/ui/workspace';

export function mount(startupMs: number) {
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const sent: string[] = [];
  let sentAt: number | null = null;
  const runtime = createAgentWorkspaceRuntime({
    autostart: false,
    createId: () => 'profile-first-send',
    folderPath: '/profiling/first-send',
    port: {
      connect: (_request, listener) => {
        readyTimer = setTimeout(() => listener.onEvent({ kind: 'ready' }), startupMs);
        return {
          close: () => clearTimeout(readyTimer),
          send: (command) => {
            if (command.kind === 'prompt') {
              sentAt = performance.now();
              sent.push(command.text);
            }
            return true;
          },
        };
      },
      list: async () => [],
      remove: async () => {},
      rename: async (entry) => entry,
      replay: async () => ({ effort: null, transcript: [] }),
    },
  });
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--background)';
  document.body.append(container);
  const root = createRoot(container);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <QueryClientProvider client={query}>
      <ManagedAgentWorkspace
        runtime={runtime}
        catalog={{
          listAgents: async () => ({
            agents: [
              {
                id: 'stashbase',
                label: 'Default',
                ready: true,
                needsSignIn: false,
                models: [],
                abilities: {
                  attachments: false,
                  effort: false,
                  models: false,
                  modes: ['auto'],
                  skills: false,
                  steering: false,
                },
              },
            ],
          }),
          prepareAgent: async () => ({ agents: [] }),
        }}
        persona={{
          list: async () => [],
          create: async () => {
            throw new Error('unused');
          },
          update: async () => {
            throw new Error('unused');
          },
          remove: async () => {},
        }}
        tools={{ list: async () => [], set: async () => [] }}
        onOpenAgentSettings={() => {}}
        onOpenAppSettings={() => {}}
        onOpenExternal={() => {}}
        onSignIn={() => {}}
      />
    </QueryClientProvider>,
  );
  return {
    sent,
    get sentAt() {
      return sentAt;
    },
    dispose() {
      root.unmount();
      runtime.dispose();
      query.clear();
      container.remove();
    },
  };
}

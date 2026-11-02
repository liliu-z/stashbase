import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type {
  AppearancePort,
  ProjectMathPort,
  SystemTextPort,
} from '@/features/settings/application/ports';
import type { AppearancePreferences } from '@/features/settings/domain/appearance';
import { appearanceSurface } from '@/test/fakes/settings';

import { AppearancePanel } from './appearance-panel';
import { EditorPanel } from './editor-panel';
import { ReadingTextMenu } from './reading-text-menu';

function Queries({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const saved: AppearancePreferences = appearanceSurface();

const systemText: SystemTextPort = {
  listFonts: async () => [
    { family: 'Georgia', monospace: false },
    { family: 'Courier New', monospace: true },
  ],
  spellcheckLanguages: async () => ['en-US', 'fr'],
};

const appearancePort: AppearancePort = {
  load: async () => saved,
  update: async (change) => ({ ...saved, ...change }),
};

// Two projects, so the reading bar shows Math off and on side by side.
const mathModes = new Map([['/math-on', true]]);
const projectMathPort: ProjectMathPort = {
  load: async (scope) => ({ scope, math_mode: mathModes.get(scope) ?? false }),
  update: async (scope, mathMode) => {
    mathModes.set(scope, mathMode);
    return { scope, math_mode: mathMode };
  },
};

const meta = {
  title: 'Settings/AppearancePanel',
  parameters: { fluidCanvas: { width: '40rem', minHeight: '20rem' } },
  decorators: [
    (Story) => (
      <Queries>
        <Story />
      </Queries>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Default: Story = { render: () => <AppearancePanel appearanceApi={appearancePort} /> };

export const Editor: Story = {
  render: () => <EditorPanel appearanceApi={appearancePort} systemTextApi={systemText} />,
};

export const ReadingBar: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <ReadingTextMenu
        appearanceApi={appearancePort}
        mathApi={projectMathPort}
        projectPath="/math-off"
      />
      <ReadingTextMenu
        appearanceApi={appearancePort}
        mathApi={projectMathPort}
        projectPath="/math-on"
      />
    </div>
  ),
};

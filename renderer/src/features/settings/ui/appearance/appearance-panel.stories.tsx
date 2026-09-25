import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type { AppearancePort } from '@/features/settings/application/ports';
import type { AppearancePreferences } from '@/features/settings/domain/appearance';

import { AppearancePanel } from './appearance-panel';

function Queries({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const saved: AppearancePreferences = {
  readingTextSize: 'default',
  readingFont: 'serif',
  theme: 'system',
  uiScale: 'default',
};

const appearancePort: AppearancePort = {
  load: async () => saved,
  update: async (change) => ({ ...saved, ...change }),
};

function AppearanceHarness() {
  return <AppearancePanel appearanceApi={appearancePort} />;
}

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

export const Default: Story = { render: () => <AppearanceHarness /> };
